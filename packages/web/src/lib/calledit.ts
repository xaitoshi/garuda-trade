/**
 * Data for /calledit: pin an X post on a candle chart and measure the move since.
 * Post time comes from the snowflake id (no X API). Candles come from public endpoints that answer CORS:
 * Hyperliquid perps for tickers, GeckoTerminal for contract addresses. Text and author come through the Garuda API
 * (GET /social/tweets/:id), which reads X's public embed endpoint.
 */
import { API_URL } from "./config";

export interface Bar {
  time: number; // ms, candle open
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface TweetInfo {
  id: string;
  postedAt: number;
  text?: string;
  name?: string;
  handle?: string;
  avatar?: string;
  verified?: boolean;
  /** Photos in the post (video and GIF posts give a thumbnail): pbs.twimg.com URLs, shown through the API proxy. */
  media?: { url: string; type: "photo" | "video" | "gif"; width?: number; height?: number; alt?: string }[];
  source: "syndication" | "fxtwitter" | "vxtwitter" | "id";
}

/** Post photos load through the Garuda API (same answer on every network, CORS open so the card can draw them). */
export const mediaSrc = (url: string): string => `${API_URL}/social/media?u=${encodeURIComponent(url)}`;

export const UPLOAD_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
export const UPLOAD_MAX_BYTES = 5 * 1024 * 1024;
export const uploadSrc = (id: string): string => `${API_URL}/social/uploads/${encodeURIComponent(id)}`;
export const isUploadId = (s: string | null | undefined): s is string => Boolean(s && /^[A-Za-z0-9_-]{16,32}$/.test(s));

/** Client side checks before upload. The API checks the real type again from the file's bytes. */
export function checkUpload(f: { type: string; size: number }): string | null {
  if (!(UPLOAD_TYPES as readonly string[]).includes(f.type)) return "Use a PNG, JPG, WEBP or GIF image.";
  if (f.size > UPLOAD_MAX_BYTES) return "That image is over 5 MB. Try a smaller one.";
  if (f.size === 0) return "That file is empty.";
  return null;
}

export async function uploadImage(dataUrl: string): Promise<{ id: string; url: string; mime: string; size: number }> {
  const r = await fetch(`${API_URL}/social/uploads`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ data: dataUrl }) });
  const j = (await r.json().catch(() => ({}))) as { id?: string; url?: string; mime?: string; size?: number; message?: string };
  if (!r.ok || !j.id) throw new Error(j.message ?? "Upload failed. Try again.");
  return j as { id: string; url: string; mime: string; size: number };
}

export interface Asset {
  /** What the card shows: BTC, SOL, BONK... */
  symbol: string;
  name?: string;
  kind: "perp" | "dex";
  /** Hyperliquid coin, or "network/pool" for GeckoTerminal. */
  key: string;
  network?: string;
  logo?: string;
  sourceLabel: string;
}

export interface Timeframe {
  id: string;
  ms: number;
  /** Hyperliquid interval. */
  hl: string;
  /** GeckoTerminal timeframe + aggregate. */
  gt: [string, number];
}

const M = 60_000;
const H = 60 * M;
const D = 24 * H;
export const TIMEFRAMES: Timeframe[] = [
  { id: "5m", ms: 5 * M, hl: "5m", gt: ["minute", 5] },
  { id: "15m", ms: 15 * M, hl: "15m", gt: ["minute", 15] },
  { id: "1h", ms: H, hl: "1h", gt: ["hour", 1] },
  { id: "4h", ms: 4 * H, hl: "4h", gt: ["hour", 4] },
  { id: "1d", ms: D, hl: "1d", gt: ["day", 1] },
];

const TWITTER_EPOCH = 1288834974657n;

/** Pull the numeric post id out of an x.com / twitter.com status link (or accept a bare id). */
export function parseTweetUrl(raw: string): { id: string; handle?: string } | null {
  const s = raw.trim();
  if (/^\d{8,20}$/.test(s)) return { id: s };
  const m = s.match(/(?:twitter\.com|x\.com)\/([A-Za-z0-9_]{1,15}|i\/web|i)\/status(?:es)?\/(\d{8,20})/i);
  if (!m) return null;
  const handle = m[1] === "i" || m[1] === "i/web" ? undefined : m[1];
  return { id: m[2]!, handle };
}

/** Exact post time in ms: the top bits of every post id are a timestamp. */
export const snowflakeMs = (id: string): number => Number((BigInt(id) >> 22n) + TWITTER_EPOCH);

/** Pick a candle size so the chart shows the call with some run-up and everything since, in under ~600 bars. */
export function pickTimeframe(ageMs: number): Timeframe {
  if (ageMs < 1.5 * D) return TIMEFRAMES[0]!;
  if (ageMs < 5 * D) return TIMEFRAMES[1]!;
  if (ageMs < 18 * D) return TIMEFRAMES[2]!;
  if (ageMs < 75 * D) return TIMEFRAMES[3]!;
  return TIMEFRAMES[4]!;
}

/** Visible window: some history before the post (so the "bottom" reads as a bottom), then up to now. */
export function windowFor(postedAt: number, now: number, tf: Timeframe): { start: number; end: number } {
  const age = Math.max(now - postedAt, tf.ms);
  const before = Math.max(age * 0.45, 40 * tf.ms);
  return { start: postedAt - before, end: now };
}

export async function fetchTweet(id: string): Promise<TweetInfo> {
  const base: TweetInfo = { id, postedAt: snowflakeMs(id), source: "id" };
  try {
    const r = await fetch(`${API_URL}/social/tweets/${id}`);
    if (!r.ok) return base;
    const j = (await r.json()) as TweetInfo;
    return { ...base, ...j, postedAt: base.postedAt };
  } catch {
    return base;
  }
}

/** First $CASHTAG in the post, used when the ticker box is empty. */
export function cashtagOf(text: string | undefined): string | undefined {
  const m = text?.match(/\$([A-Za-z][A-Za-z0-9]{1,9})\b/);
  return m?.[1]?.toUpperCase();
}

const isSolAddress = (s: string) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
const isEvmAddress = (s: string) => /^0x[0-9a-fA-F]{40}$/.test(s);

let hlMeta: Promise<Set<string>> | undefined;
function hyperliquidCoins(): Promise<Set<string>> {
  hlMeta ??= fetch("https://api.hyperliquid.xyz/info", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "meta" }) })
    .then((r) => r.json())
    .then((j: { universe: { name: string; isDelisted?: boolean }[] }) => new Set(j.universe.map((u) => u.name)))
    .catch((e) => {
      hlMeta = undefined;
      throw e;
    });
  return hlMeta;
}

const GT = "https://api.geckoterminal.com/api/v2";

async function geckoAsset(address: string): Promise<Asset> {
  const networks = isEvmAddress(address) ? ["eth", "base", "bsc", "arbitrum"] : ["solana"];
  for (const net of networks) {
    const r = await fetch(`${GT}/networks/${net}/tokens/${address}/pools?page=1&include=base_token`);
    if (r.status === 404) continue;
    if (r.status === 429) throw new Error("GeckoTerminal is rate limiting us. Try again in a minute.");
    if (!r.ok) continue;
    const j = (await r.json()) as {
      data: { id: string; attributes: { address: string; name: string; reserve_in_usd: string }; relationships: { base_token: { data: { id: string } } } }[];
      included?: { id: string; attributes: { symbol: string; name: string; image_url?: string } }[];
    };
    // Pools where this token is the base (so OHLCV is priced in USD per token), deepest first.
    const mine = j.data.filter((p) => p.relationships.base_token.data.id.toLowerCase() === `${net}_${address}`.toLowerCase());
    const pools = (mine.length ? mine : j.data).sort((a, b) => Number(b.attributes.reserve_in_usd) - Number(a.attributes.reserve_in_usd));
    const pool = pools[0];
    if (!pool) continue;
    const tok = j.included?.find((i) => i.id.toLowerCase() === `${net}_${address}`.toLowerCase());
    return {
      symbol: tok?.attributes.symbol?.toUpperCase() ?? pool.attributes.name.split(" / ")[0] ?? address.slice(0, 6),
      name: tok?.attributes.name,
      logo: tok?.attributes.image_url && tok.attributes.image_url !== "missing.png" ? tok.attributes.image_url : undefined,
      kind: "dex",
      key: pool.attributes.address,
      network: net,
      sourceLabel: `GeckoTerminal ${net === "solana" ? "Solana" : net.toUpperCase()} pool`,
    };
  }
  throw new Error("No DEX pool found for that contract address.");
}

/** BTC, $sol, SOLUSDT, HYPE-PERP or a contract address. */
export async function resolveAsset(raw: string): Promise<Asset> {
  const s = raw.trim().replace(/^\$/, "");
  if (!s) throw new Error("Add a ticker or contract address.");
  if (isSolAddress(s) && !/^[A-Z]{2,10}$/.test(s)) return geckoAsset(s);
  if (isEvmAddress(s)) return geckoAsset(s);
  const sym = s.toUpperCase().replace(/[-_/]?(PERP|USDT|USDC|USD)$/, "");
  const coins = await hyperliquidCoins().catch(() => new Set<string>());
  const coin = coins.has(sym) ? sym : coins.has(`k${sym}`) ? `k${sym}` : undefined;
  if (!coin) throw new Error(`${sym} is not listed on Hyperliquid. Paste its contract address instead.`);
  return { symbol: sym, kind: "perp", key: coin, sourceLabel: "Hyperliquid perps", logo: `https://app.hyperliquid.xyz/coins/${coin}.svg` };
}

async function hyperliquidCandles(coin: string, tf: Timeframe, start: number, end: number): Promise<Bar[]> {
  const r = await fetch("https://api.hyperliquid.xyz/info", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "candleSnapshot", req: { coin, interval: tf.hl, startTime: Math.floor(start), endTime: Math.floor(end) } }),
  });
  if (!r.ok) throw new Error(`Hyperliquid candles failed (${r.status})`);
  const j = (await r.json()) as { t: number; o: string; h: string; l: string; c: string; v: string }[];
  return j.map((k) => ({ time: k.t, open: +k.o, high: +k.h, low: +k.l, close: +k.c, volume: +k.v }));
}

async function geckoCandles(network: string, pool: string, tf: Timeframe, start: number, end: number): Promise<Bar[]> {
  const out = new Map<number, Bar>();
  let before = Math.floor(end / 1000);
  // GeckoTerminal pages backwards, 1000 bars at a time. Two pages cover every window pickTimeframe produces.
  for (let page = 0; page < 2 && before * 1000 > start; page++) {
    const url = `${GT}/networks/${network}/pools/${pool}/ohlcv/${tf.gt[0]}?aggregate=${tf.gt[1]}&before_timestamp=${before}&limit=1000&currency=usd`;
    const r = await fetch(url);
    if (r.status === 429) throw new Error("GeckoTerminal is rate limiting us. Try again in a minute.");
    if (!r.ok) throw new Error(`GeckoTerminal candles failed (${r.status})`);
    const j = (await r.json()) as { data: { attributes: { ohlcv_list: [number, number, number, number, number, number][] } } };
    const list = j.data.attributes.ohlcv_list;
    if (!list.length) break;
    for (const [t, o, h, l, c, v] of list) out.set(t * 1000, { time: t * 1000, open: o, high: h, low: l, close: c, volume: v });
    before = Math.min(...list.map((k) => k[0])) - 1;
  }
  return [...out.values()].filter((b) => b.time >= start - tf.ms).sort((a, b) => a.time - b.time);
}

export async function fetchBars(asset: Asset, tf: Timeframe, start: number, end: number): Promise<Bar[]> {
  return asset.kind === "perp" ? hyperliquidCandles(asset.key, tf, start, end) : geckoCandles(asset.network!, asset.key, tf, start, end);
}

/** Price when the post went out: the 1m close just before it on Hyperliquid, else the containing bar's open. */
export async function priceAt(asset: Asset, bars: Bar[], at: number, tf: Timeframe): Promise<number | undefined> {
  if (asset.kind === "perp" && Date.now() - at < 3 * D) {
    try {
      const m = await hyperliquidCandles(asset.key, { ...TIMEFRAMES[0]!, hl: "1m", ms: M }, at - 2 * M, at + M);
      const k = m.filter((b) => b.time <= at).pop();
      if (k) return k.close;
    } catch {
      /* fall through to the chart bars */
    }
  }
  const bar = bars.find((b) => b.time <= at && at < b.time + tf.ms);
  if (bar) return bar.open;
  const after = bars.find((b) => b.time > at);
  return after?.open;
}

export type Side = "long" | "short";

export interface CallStats {
  side: Side;
  entry: number;
  now: number;
  /** Raw price change since the post. */
  changePct: number;
  /** The call's result: the price change for a long (bottom) call, its inverse for a short (top) call. */
  callPct: number;
  /** Best and worst points for the call since the post. */
  bestPct: number;
  worstPct: number;
}

export function statsFor(bars: Bar[], at: number, entry: number, tfMs: number, side: Side = "long"): CallStats | undefined {
  const after = bars.filter((b) => b.time + tfMs > at);
  const last = bars[bars.length - 1];
  if (!last || !after.length || !(entry > 0)) return undefined;
  const hi = (Math.max(...after.map((b) => b.high)) / entry - 1) * 100;
  const lo = (Math.min(...after.map((b) => b.low)) / entry - 1) * 100;
  const changePct = (last.close / entry - 1) * 100;
  const long = side === "long";
  return { side, entry, now: last.close, changePct, callPct: long ? changePct : -changePct, bestPct: long ? hi : -lo, worstPct: long ? lo : -hi };
}

export function fmtPrice(p: number): string {
  if (!Number.isFinite(p)) return "-";
  if (p >= 1000) return `$${p.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  if (p >= 1) return `$${p.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`;
  if (p >= 0.01) return `$${p.toFixed(4)}`;
  // Tiny memecoin prices: keep 4 significant digits.
  return `$${p.toPrecision(4)}`;
}

export const fmtPct = (x: number) => `${x >= 0 ? "+" : ""}${Math.abs(x) >= 100 ? x.toFixed(0) : x.toFixed(2)}%`;

export function fmtAge(ms: number): string {
  const d = ms / D;
  if (d >= 365) return `${(d / 365).toFixed(1)}y`;
  if (d >= 2) return `${Math.floor(d)}d`;
  const h = ms / H;
  if (h >= 1) return `${Math.floor(h)}h`;
  return `${Math.max(1, Math.floor(ms / M))}m`;
}
