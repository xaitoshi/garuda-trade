import {
  BaseMessageSignerWalletAdapter,
  WalletName,
  WalletReadyState,
  WalletNotConnectedError,
  type SupportedTransactionVersions,
} from "@solana/wallet-adapter-base";
import { Keypair, PublicKey, type Transaction, type TransactionVersion, type VersionedTransaction, type Connection, type SendOptions, type TransactionSignature } from "@solana/web3.js";
import nacl from "tweetnacl";
import bs58 from "bs58";

const STORAGE_KEY = "garuda.devwallet";
export const DEV_WALLET_NAME = "Garuda Dev Wallet" as WalletName<"Garuda Dev Wallet">;

/**
 * A throwaway in-browser wallet for local development and the smoke screenshots (VITE_DEV_WALLET=1). The key lives in
 * localStorage and never leaves the page. It is NOT a real wallet: do not ship it enabled to production, do not fund it.
 */
export class DevWalletAdapter extends BaseMessageSignerWalletAdapter {
  name = DEV_WALLET_NAME;
  url = "https://github.com/xaitoshi/garuda-grok-bot";
  icon = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0naHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmcnIHZpZXdCb3g9JzAgMCAzMiAzMic+PHJlY3Qgd2lkdGg9JzMyJyBoZWlnaHQ9JzMyJyByeD0nOCcgZmlsbD0nI2ZmNWYwMScvPjxwYXRoIGQ9J00xNiA2bDYgMTBoLTRsMiAxMC04LTEyaDV6JyBmaWxsPScjMTEwZjEwJy8+PC9zdmc+";
  supportedTransactionVersions: SupportedTransactionVersions = new Set<TransactionVersion>(["legacy", 0]);
  readonly readyState = WalletReadyState.Loadable;
  private kp: Keypair | null = null;
  private live = false;

  get publicKey(): PublicKey | null {
    return this.live && this.kp ? this.kp.publicKey : null;
  }
  get connecting(): boolean {
    return false;
  }

  private load(): Keypair {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return Keypair.fromSecretKey(bs58.decode(raw));
    } catch {
      /* fall through: make a new one */
    }
    const kp = Keypair.generate();
    try {
      localStorage.setItem(STORAGE_KEY, bs58.encode(kp.secretKey));
    } catch {
      /* private mode: the wallet lasts for this page only */
    }
    return kp;
  }

  async connect(): Promise<void> {
    this.kp ??= this.load();
    this.live = true;
    this.emit("connect", this.kp.publicKey);
  }

  async disconnect(): Promise<void> {
    this.live = false;
    this.emit("disconnect");
  }

  async signMessage(message: Uint8Array): Promise<Uint8Array> {
    if (!this.live || !this.kp) throw new WalletNotConnectedError();
    return nacl.sign.detached(message, this.kp.secretKey);
  }

  async signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T> {
    if (!this.live || !this.kp) throw new WalletNotConnectedError();
    if ("version" in tx) tx.sign([this.kp]);
    else tx.partialSign(this.kp);
    return tx;
  }

  override async signAllTransactions<T extends Transaction | VersionedTransaction>(txs: T[]): Promise<T[]> {
    return Promise.all(txs.map((t) => this.signTransaction(t)));
  }

  override async sendTransaction(tx: Transaction | VersionedTransaction, connection: Connection, options: SendOptions = {}): Promise<TransactionSignature> {
    const signed = await this.signTransaction(tx);
    return connection.sendRawTransaction(signed.serialize(), options);
  }
}
