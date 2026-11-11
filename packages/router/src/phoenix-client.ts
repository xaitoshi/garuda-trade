import { createPhoenixClient, Side } from "@ellipsis-labs/rise";
import {
  AccountRole,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createTransactionMessage,
  getSignatureFromTransaction,
  pipe,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Instruction,
  type KeyPairSigner,
} from "@solana/kit";
import type { PhoenixTradingClient, PlaceMirrorOrder } from "./types.js";

export interface RisePhoenixClientOptions {
  apiUrl?: string;
  /** Solana RPC used to SEND transactions (mainnet). A paid RPC is strongly recommended over the public endpoint. */
  rpcUrl?: string;
  wsUrl?: string;
  /** Firm wallet that owns the Phoenix trader account. Public key only: the owner key never touches this service. */
  firmAuthority: string;
  /** Phoenix trader PDA index of the firm account (default 0). */
  pdaIndex?: number;
  /** Delegate (position authority) secret key, 64 bytes (solana-keygen JSON format). Trade-only: it cannot withdraw. */
  delegateSecret: Uint8Array;
  /** Flight builder (fee collector) authority. Optional: without it orders go straight to Phoenix with no builder fee. */
  builder?: { authority: string; pdaIndex?: number; subaccountIndex?: number };
}

/**
 * Live Phoenix client: server-built ISOLATED market orders (`POST /v1/ix/place-isolated-market-order` through the Rise
 * SDK) signed by the delegate as `positionAuthority` and fee payer, sent with @solana/kit. Each order is all-or-nothing
 * (minBaseLotsToFill = numBaseLots) with a worst-price limit in ticks.
 */
export class RisePhoenixClient implements PhoenixTradingClient {
  readonly name = "phoenix-mainnet";
  readonly firmAuthority: string;
  readonly delegate: string;
  private readonly px: ReturnType<typeof createPhoenixClient>;
  private readonly signer: KeyPairSigner;
  private readonly rpc: ReturnType<typeof createSolanaRpc>;
  private readonly send: ReturnType<typeof sendAndConfirmTransactionFactory>;
  private readonly pdaIndex: number;

  private constructor(o: RisePhoenixClientOptions, signer: KeyPairSigner) {
    const rpcUrl = o.rpcUrl ?? "https://api.mainnet-beta.solana.com";
    this.firmAuthority = o.firmAuthority;
    this.signer = signer;
    this.delegate = signer.address;
    this.pdaIndex = o.pdaIndex ?? 0;
    this.px = createPhoenixClient({
      apiUrl: o.apiUrl ?? "https://perp-api.phoenix.trade",
      rpcUrl,
      ws: false,
      ...(o.builder ? { flight: { builderAuthority: o.builder.authority as never, builderPdaIndex: o.builder.pdaIndex ?? 0, builderSubaccountIndex: o.builder.subaccountIndex ?? 0 } } : {}),
    });
    this.rpc = createSolanaRpc(rpcUrl);
    const rpcSubscriptions = createSolanaRpcSubscriptions(o.wsUrl ?? rpcUrl.replace(/^http/, "ws"));
    this.send = sendAndConfirmTransactionFactory({ rpc: this.rpc as never, rpcSubscriptions: rpcSubscriptions as never });
  }

  static async create(o: RisePhoenixClientOptions): Promise<RisePhoenixClient> {
    if (o.delegateSecret.length !== 64) throw new Error("PHOENIX_DELEGATE_KEYPAIR must be a 64-byte secret key (solana-keygen JSON array)");
    const signer = await createKeyPairSignerFromBytes(o.delegateSecret);
    if (signer.address === o.firmAuthority) throw new Error("The delegate must be a separate trade-only key, not the firm owner wallet");
    return new RisePhoenixClient(o, signer);
  }

  async placeMarketOrder(o: PlaceMirrorOrder): Promise<{ signature: string }> {
    await this.px.exchange.ready();
    // Lot and tick conversion from live market metadata (sizes round DOWN to the lot size).
    const packet = await this.px.ixs.orderPackets.buildMarketOrderPacket({
      symbol: o.symbol,
      side: o.side === "buy" ? Side.Bid : Side.Ask,
      baseUnits: o.size.toFixed(8),
      priceLimitUsd: o.limitPrice.toFixed(8),
    });
    const lots = Number(packet.numBaseLots);
    if (!(lots > 0)) throw new Error(`size ${o.size} ${o.symbol} is below one base lot`);
    const ixs = await this.px.api.orders().placeIsolatedMarketOrder({
      authority: this.firmAuthority,
      positionAuthority: this.delegate,
      feePayer: this.delegate,
      symbol: o.symbol,
      side: o.side,
      numBaseLots: lots,
      minBaseLotsToFill: lots,
      maxPriceInTicks: packet.priceInTicks === null ? undefined : Number(packet.priceInTicks),
      pdaIndex: this.pdaIndex,
      isReduceOnly: o.reduceOnly,
      ...(o.collateralUsd > 0 ? { transferAmount: Math.ceil(o.collateralUsd * 1e6) } : {}),
    });
    // The delegate must be the ONLY signer. If Phoenix wants the owner to sign (e.g. a collateral move a position
    // authority may not make), refuse rather than send a transaction that cannot be signed.
    for (const ix of ixs) {
      for (const a of ix.accounts ?? []) {
        const isSigner = a.role === AccountRole.READONLY_SIGNER || a.role === AccountRole.WRITABLE_SIGNER;
        if (isSigner && a.address !== this.delegate) throw new Error(`order needs signer ${a.address} (not the delegate); refusing`);
      }
    }
    const { value: blockhash } = await this.rpc.getLatestBlockhash().send();
    const msg = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(this.signer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
      (m) => appendTransactionMessageInstructions(ixs as unknown as Instruction[], m),
    );
    const tx = await signTransactionMessageWithSigners(msg);
    await this.send(tx as never, { commitment: "confirmed" });
    return { signature: getSignatureFromTransaction(tx) };
  }

  async positions(): Promise<Record<string, number>> {
    const res = await this.px.api.traders().getTraderStateSnapshot(this.firmAuthority, { traderPdaIndex: this.pdaIndex });
    await this.px.exchange.ready();
    const out: Record<string, number> = {};
    for (const sub of res.snapshot.subaccounts ?? []) {
      for (const p of sub.positions ?? []) {
        let units = p.basePositionUnits !== undefined ? Number(p.basePositionUnits) : NaN;
        if (!Number.isFinite(units)) {
          const decimals = this.px.exchange.market(p.symbol as never)?.baseLotsDecimals ?? 0;
          units = Number(p.basePositionLots) / 10 ** decimals;
        }
        const sym = p.symbol.toUpperCase().replace(/-?PERP$/, "");
        out[sym] = (out[sym] ?? 0) + units;
      }
    }
    return out;
  }
}

/** Parse PHOENIX_DELEGATE_KEYPAIR (JSON array of 64 numbers). Never logs the value. */
export function parseKeypairSecret(raw: string): Uint8Array {
  let arr: unknown;
  try {
    arr = JSON.parse(raw);
  } catch {
    throw new Error("PHOENIX_DELEGATE_KEYPAIR is not valid JSON (expected the solana-keygen array of 64 numbers)");
  }
  if (!Array.isArray(arr) || arr.length !== 64 || !arr.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
    throw new Error("PHOENIX_DELEGATE_KEYPAIR must be a JSON array of 64 bytes");
  }
  return Uint8Array.from(arr as number[]);
}
