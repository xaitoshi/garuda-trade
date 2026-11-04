export const usd = (n: number, d = 0): string =>
  `${n < 0 ? "-" : ""}$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d })}`;

export const usdSigned = (n: number, d = 0): string => `${n < 0 ? "-" : "+"}$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d })}`;

export const num = (n: number, d = 2): string => n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });

/** Price with precision that fits its magnitude (BTC 2dp, SOL 2dp, small caps more). */
export const px = (n: number): string => (n >= 1000 ? num(n, 2) : n >= 1 ? num(n, 2) : n >= 0.01 ? num(n, 4) : num(n, 6));

export const pct = (n: number, d = 1): string => `${(n * 100).toFixed(d)}%`;
export const pctSigned = (n: number, d = 1): string => `${n < 0 ? "-" : "+"}${Math.abs(n * 100).toFixed(d)}%`;

export const shortAddr = (a: string): string => (a.length > 10 ? `${a.slice(0, 4)}..${a.slice(-4)}` : a);

export function hms(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

export function clock(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

export function dayLabel(ts: number): string {
  return new Date(ts).toLocaleDateString("en-US", { month: "short", day: "2-digit", year: "numeric", timeZone: "UTC" });
}

export const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

/** Milliseconds until the next 00:00 UTC (the daily-loss reset). */
export function msToUtcReset(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - now;
}
