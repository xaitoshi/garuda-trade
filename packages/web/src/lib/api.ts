import { API_URL } from "./config";
import type { EarlyOutcome, EarlyStatus, KnightInfo, Candle, MarketTrade, ChallengeState, ConfirmOutcome, Health, MarketView, PaymentInstructions, PaymentOrder, PayoutQuote, PayoutView, PlaceOrderResult, ReviveInfo, Rules, TierId } from "./types";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
  }
}

let token: string | undefined;
let onUnauthorized: (() => void) | undefined;
export const setApiToken = (t: string | undefined) => void (token = t);
export const setUnauthorizedHandler = (fn: (() => void) | undefined) => void (onUnauthorized = fn);

/** A read that takes longer than this is abandoned, so a stalled API shows as slow instead of loading forever. */
export const READ_TIMEOUT_MS = 10_000;

/** Worth retrying quietly: nothing came back (timeout, network) or the API failed on its side (5xx). 4xx are real answers. */
export const isTransient = (e: unknown): boolean => e instanceof ApiError && (e.status === 0 || e.status >= 500);

async function call<T>(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string>; auth?: boolean; okStatuses?: number[]; timeoutMs?: number } = {}): Promise<T> {
  const headers: Record<string, string> = { ...init.headers };
  if (init.body !== undefined) headers["content-type"] = "application/json";
  if (init.auth !== false && token) headers.authorization = `Bearer ${token}`;
  const method = init.method ?? "GET";
  // Reads time out; writes (orders, payments) are left to finish so a slow answer is never mistaken for a failed write.
  const timeoutMs = init.timeoutMs ?? (method === "GET" ? READ_TIMEOUT_MS : undefined);
  const ctl = timeoutMs ? new AbortController() : undefined;
  const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : undefined;
  let res: Response;
  let text: string;
  try {
    res = await fetch(`${API_URL}${path}`, { method, headers, body: init.body === undefined ? undefined : JSON.stringify(init.body), signal: ctl?.signal });
    text = await res.text();
  } catch {
    if (ctl?.signal.aborted) throw new ApiError(0, "timeout", `The Garuda API did not answer within ${Math.round(timeoutMs! / 1000)}s`);
    throw new ApiError(0, "network", "Cannot reach the Garuda API");
  } finally {
    if (timer) clearTimeout(timer);
  }
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = undefined;
  }
  if (res.ok || init.okStatuses?.includes(res.status)) return data as T;
  const d = (data ?? {}) as { error?: string; message?: string; detail?: unknown };
  if (res.status === 401 && token) onUnauthorized?.();
  throw new ApiError(res.status, d.error ?? `http_${res.status}`, d.message ?? d.error ?? `Request failed (${res.status})`, d.detail);
}

const post = <T>(path: string, body?: unknown, headers?: Record<string, string>, okStatuses?: number[]) => call<T>(path, { method: "POST", body: body ?? {}, headers, okStatuses });

export const api = {
  health: () => call<Health>("/health", { auth: false }),
  rules: () => call<Rules>("/rules", { auth: false }),
  market: (symbol: string, depth = 14) => call<MarketView>(`/markets/${symbol}?depth=${depth}`, { auth: false }),
  trades: (symbol: string, limit = 40) => call<{ trades: MarketTrade[]; source: string }>(`/markets/${symbol}/trades?limit=${limit}`, { auth: false }),
  candles: (symbol: string, tf: string, limit = 120) => call<{ candles: Candle[]; source: string }>(`/markets/${symbol}/candles?tf=${tf}&limit=${limit}`, { auth: false }),

  nonce: (wallet: string) => post<{ nonce: string; message: string }>("/auth/nonce", { wallet }),
  verify: (wallet: string, nonce: string, signature: string) => post<{ token: string; wallet: string; expiresAt: number }>("/auth/verify", { wallet, nonce, signature }),
  /** Privy sign-in: trade a Privy access token for a Garuda session on one of the user's Solana wallets. */
  privyLogin: (accessToken: string, wallet?: string) => post<{ token: string; wallet: string; expiresAt: number; embedded: boolean }>("/auth/privy", { accessToken, wallet }),
  logout: () => post<{ ok: true }>("/auth/logout"),

  challenges: () => call<{ challenges: ChallengeState[] }>("/challenges").then((r) => r.challenges),
  challenge: (id: string) => call<ChallengeState>(`/challenges/${id}`),
  createDemo: (knight?: string, wallet?: string) => post<ChallengeState>("/challenges", { tier: "demo", knight, wallet }),
  createFunded: (tier: TierId, knightAsset?: string, wallet?: string) => post<ChallengeState>("/challenges", { tier, stage: "funded", knightAsset, wallet }),
  /** Path to Funded: claim the funded account on a passed challenge (then identity check and risk review). */
  claimFunded: (id: string) => post<ChallengeState>(`/challenges/${id}/claim`),
  placeOrder: (id: string, o: { symbol: string; side: "buy" | "sell"; size: number; type: "market" | "limit"; limitPrice?: number; reduceOnly?: boolean; takeProfit?: number }) =>
    post<PlaceOrderResult>(`/challenges/${id}/orders`, o, undefined, [422]),
  reactivate: (id: string) => post<ChallengeState>(`/challenges/${id}/reactivate`),
  cancelOrder: (id: string, orderId: string) => call<unknown>(`/challenges/${id}/orders/${orderId}`, { method: "DELETE" }),
  revive: (id: string) => post<{ state: ChallengeState }>(`/challenges/${id}/revive`, {}, { "idempotency-key": `web-revive-${id}` }),
  knights: () => call<{ knights: KnightInfo[] }>("/knights").then((r) => r.knights, () => null),
  reviveInfo: (id: string) => call<ReviveInfo>(`/challenges/${id}/revive`),
  payoutQuote: (id: string) => call<PayoutQuote>(`/challenges/${id}/payout-quote`),
  /** Request the account's full profit as USDC to the signed-in wallet. Re-sending the same key never pays twice. */
  requestPayout: (id: string, idempotencyKey: string) => post<PayoutView>(`/challenges/${id}/payouts`, undefined, { "idempotency-key": idempotencyKey }),
  payouts: () => call<{ payouts: PayoutView[] }>("/payouts").then((r) => r.payouts),

  quoteChallenge: (tier: TierId, knightName?: string, knightAsset?: string) => post<PaymentInstructions>("/purchases/challenge", { tier, knightName, knightAsset }),
  quoteRevive: (challengeId: string) => post<PaymentInstructions>("/purchases/revive", { challengeId }),
  confirm: (orderId: string, signature: string) => post<ConfirmOutcome>(`/purchases/${orderId}/confirm`, { signature }, undefined, [202]),
  order: (orderId: string) => call<PaymentOrder>(`/purchases/${orderId}`),
  /** Garuda Beta Access (/early). */
  earlyStatus: () => call<EarlyStatus>("/early/status", { auth: false }),
  earlyClaim: (wallet: string, email: string, payer?: string) => call<EarlyOutcome>("/early/claim", { method: "POST", body: { wallet, email, payer }, auth: false }),
  earlyConfirm: (claimId: string, signature: string, payer?: string) =>
    call<EarlyOutcome | { status: "pending"; claimId: string }>(`/early/claim/${claimId}/confirm`, { method: "POST", body: { signature, payer }, auth: false, okStatuses: [202] }),
  /** Stub server only: registers a simulated USDC transfer for the quote and returns its signature. */
  stubPay: (orderId: string) => post<{ signature: string }>("/dev/stub-pay", { orderId }),
};

export const errorText = (e: unknown): string => (e instanceof ApiError ? e.message : e instanceof Error ? e.message : "Something went wrong");
