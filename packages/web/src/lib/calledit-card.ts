/**
 * The shareable "Called it" card, drawn straight onto a canvas (1200x675, X's large card ratio, rendered at 2x).
 * Drawing it by hand keeps the PNG identical on every device and avoids cross-origin canvas taint: the only image
 * from outside is the author avatar, which the API inlines as a data URL, plus an optional post photo or upload, which
 * loads from the Garuda API with open CORS (or from a local data URL) so the canvas stays exportable.
 */
import { fmtAge, fmtPct, fmtPrice, type Asset, type Bar, type CallStats, type TweetInfo } from "./calledit";

const W = 1200;
const H = 675;
const C = { ink: "#000000", panel: "#111112", line: "rgba(255,255,255,.08)", bone: "#f4f4f5", mute: "#979899", dim: "#76787f", fire: "#f2f2f3", green: "#3ce362", red: "#ff4953" };
const DISPLAY = `"Geist Pixel Circle", ${"ui-monospace, monospace"}`;
const FONT = "Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif";

function loadImage(src: string): Promise<HTMLImageElement | undefined> {
  return new Promise((res) => {
    const img = new Image();
    if (/^https?:/.test(src)) img.crossOrigin = "anonymous";
    img.onload = () => res(img);
    img.onerror = () => res(undefined);
    img.src = src;
  });
}

function wrap(ctx: CanvasRenderingContext2D, text: string, maxW: number, maxLines: number): string[] {
  const words = text.replace(/\s+/g, " ").trim().split(" ");
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (ctx.measureText(next).width <= maxW) cur = next;
    else {
      if (cur) lines.push(cur);
      cur = w;
      if (lines.length === maxLines) break;
    }
  }
  if (lines.length < maxLines && cur) lines.push(cur);
  if (lines.length === maxLines && words.join(" ").length > lines.join(" ").length) {
    let last = lines[maxLines - 1]!;
    while (last.length && ctx.measureText(`${last}...`).width > maxW) last = last.slice(0, -1);
    lines[maxLines - 1] = `${last.trimEnd()}...`;
  }
  return lines;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

export interface CardInput {
  tweet: TweetInfo;
  handle?: string;
  asset: Asset;
  bars: Bar[];
  tfMs: number;
  stats: CallStats;
  url: string;
  now: number;
  /** Post photo or uploaded image shown under the post text. */
  image?: string;
}

export async function renderCard(inp: CardInput): Promise<HTMLCanvasElement> {
  await Promise.all([`400 80px "Geist Pixel Circle"`, `600 18px Inter`, `400 18px Inter`].map((f) => document.fonts?.load(f).catch(() => undefined)));
  const scale = 2;
  const cv = document.createElement("canvas");
  cv.width = W * scale;
  cv.height = H * scale;
  const ctx = cv.getContext("2d")!;
  ctx.scale(scale, scale);
  const { tweet, asset, bars, stats } = inp;
  const handle = tweet.handle ?? inp.handle;
  const up = stats.callPct >= 0;
  const accent = up ? C.green : C.red;

  // Background: ink with a soft fire glow and a dot grid, like the site.
  ctx.fillStyle = C.ink;
  ctx.fillRect(0, 0, W, H);
  const g = ctx.createRadialGradient(W * 0.82, -40, 20, W * 0.82, -40, 640);
  g.addColorStop(0, up ? "rgba(60,227,98,.16)" : "rgba(255,73,83,.16)");
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "rgba(255,255,255,.06)";
  for (let x = 10; x < W; x += 20) for (let y = 10; y < H; y += 20) ctx.fillRect(x, y, 1.4, 1.4);

  // Header: Garuda mark + CALLED IT stamp.
  const logo = await loadImage("/logo-white.svg");
  if (logo) ctx.drawImage(logo, 40, 34, 20, 34);
  ctx.fillStyle = C.bone;
  ctx.font = `600 18px ${FONT}`;
  ctx.textBaseline = "middle";
  ctx.fillText("GARUDA", 70, 52);
  ctx.font = `700 15px ${FONT}`;
  const stamp = up ? "CALLED IT" : "RECEIPTS";
  const sw = ctx.measureText(stamp).width + 28;
  roundRect(ctx, W - 40 - sw, 36, sw, 32, 8);
  ctx.fillStyle = "rgba(255,255,255,.08)";
  ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,.35)";
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = C.fire;
  ctx.fillText(stamp, W - 40 - sw + 14, 53);

  // Left column: the post.
  const L = 40;
  const colW = 400;
  let y = 108;
  const avatar = tweet.avatar ? await loadImage(tweet.avatar) : undefined;
  ctx.save();
  ctx.beginPath();
  ctx.arc(L + 26, y + 26, 26, 0, Math.PI * 2);
  ctx.closePath();
  ctx.fillStyle = C.panel;
  ctx.fill();
  ctx.clip();
  if (avatar) ctx.drawImage(avatar, L, y, 52, 52);
  else {
    ctx.fillStyle = C.mute;
    ctx.font = `600 22px ${FONT}`;
    ctx.textAlign = "center";
    ctx.fillText((handle ?? "?").slice(0, 1).toUpperCase(), L + 26, y + 27);
    ctx.textAlign = "left";
  }
  ctx.restore();
  ctx.fillStyle = C.bone;
  ctx.font = `600 19px ${FONT}`;
  const name = tweet.name ?? (handle ? `@${handle}` : "Anon");
  ctx.fillText(wrap(ctx, name, colW - 70, 1)[0] ?? name, L + 66, y + 16);
  ctx.fillStyle = C.mute;
  ctx.font = `400 15px ${FONT}`;
  ctx.fillText(handle ? `@${handle}` : "on X", L + 66, y + 39);

  y += 76;
  ctx.fillStyle = C.bone;
  ctx.font = `400 19px ${FONT}`;
  ctx.textBaseline = "top";
  const body = tweet.text ?? `Posted ${new Date(tweet.postedAt).toUTCString().replace(" GMT", " UTC")}`;
  const photo = inp.image ? await loadImage(inp.image) : undefined;
  for (const line of wrap(ctx, body, colW, photo ? 3 : 6)) {
    ctx.fillText(line, L, y);
    y += 27;
  }
  ctx.fillStyle = C.dim;
  ctx.font = `400 14px ${FONT}`;
  y += 8;
  ctx.fillText(`${new Date(tweet.postedAt).toISOString().slice(0, 16).replace("T", " ")} UTC  ·  ${fmtAge(inp.now - tweet.postedAt)} ago`, L, y);

  // The post photo (or upload), cover fit in a rounded frame above the big number.
  if (photo && photo.naturalWidth > 0) {
    const top = y + 30;
    const h = Math.max(0, 470 - top);
    if (h >= 80) {
      ctx.save();
      roundRect(ctx, L, top, colW, h, 12);
      ctx.fillStyle = C.panel;
      ctx.fill();
      ctx.clip();
      const sc = Math.max(colW / photo.naturalWidth, h / photo.naturalHeight);
      const dw = photo.naturalWidth * sc;
      const dh = photo.naturalHeight * sc;
      ctx.drawImage(photo, L + (colW - dw) / 2, top + (h - dh) / 2, dw, dh);
      ctx.restore();
      roundRect(ctx, L, top, colW, h, 12);
      ctx.strokeStyle = C.line;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }

  // Big number.
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = accent;
  ctx.font = `400 80px ${DISPLAY}`;
  ctx.fillText(fmtPct(stats.callPct), L - 3, 548);
  ctx.fillStyle = C.mute;
  ctx.font = `500 18px ${FONT}`;
  ctx.fillText(stats.side === "short" ? `on the $${asset.symbol} short since this call` : `$${asset.symbol} since this call`, L, 578);
  ctx.font = `400 15px ${FONT}`;
  ctx.fillStyle = C.dim;
  ctx.fillText(`${fmtPrice(stats.entry)}  >  ${fmtPrice(stats.now)}    Best ${fmtPct(stats.bestPct)}`, L, 606);

  // Right column: the chart.
  const cx = 480;
  const cy = 98;
  const cw = W - cx - 40;
  const ch = 470;
  roundRect(ctx, cx, cy, cw, ch, 16);
  ctx.fillStyle = C.panel;
  ctx.fill();
  ctx.strokeStyle = C.line;
  ctx.stroke();
  drawCandles(ctx, inp, { x: cx + 18, y: cy + 54, w: cw - 36 - 64, h: ch - 54 - 24 }, avatar);
  ctx.fillStyle = C.bone;
  ctx.font = `600 17px ${FONT}`;
  ctx.textBaseline = "middle";
  ctx.fillText(`${asset.symbol}/USD`, cx + 20, cy + 28);
  const tag = asset.sourceLabel;
  ctx.fillStyle = C.dim;
  ctx.font = `400 13px ${FONT}`;
  ctx.textAlign = "right";
  ctx.fillText(tag, cx + cw - 20, cy + 28);
  ctx.textAlign = "left";

  // Footer CTA.
  ctx.textBaseline = "middle";
  ctx.fillStyle = C.bone;
  ctx.font = `600 16px ${FONT}`;
  const cta = "Called it? Prove it with a funded Garuda challenge.";
  ctx.fillText(cta, cx, 618);
  ctx.fillStyle = C.fire;
  ctx.font = `500 15px ${FONT}`;
  ctx.textAlign = "right";
  ctx.fillText(inp.url.replace(/^https?:\/\//, "").replace(/\?.*$/, ""), W - 40, 618);
  ctx.textAlign = "left";
  return cv;
}

function drawCandles(ctx: CanvasRenderingContext2D, inp: CardInput, r: { x: number; y: number; w: number; h: number }, avatar?: HTMLImageElement) {
  const { bars, stats, tweet, tfMs } = inp;
  // Cap at ~140 bars so candles stay readable: keep the call in view with history before it.
  let view = bars;
  if (bars.length > 140) {
    const step = Math.ceil(bars.length / 140);
    view = [];
    for (let i = 0; i < bars.length; i += step) {
      const chunk = bars.slice(i, i + step);
      view.push({ time: chunk[0]!.time, open: chunk[0]!.open, close: chunk[chunk.length - 1]!.close, high: Math.max(...chunk.map((b) => b.high)), low: Math.min(...chunk.map((b) => b.low)), volume: 0 });
    }
  }
  const span = view.length ? view[view.length - 1]!.time - view[0]!.time || 1 : 1;
  const barMs = view.length > 1 ? span / (view.length - 1) : tfMs;
  const hi = Math.max(...view.map((b) => b.high), stats.entry);
  const lo = Math.min(...view.map((b) => b.low), stats.entry);
  const pad = (hi - lo) * 0.08 || hi * 0.01;
  const top = hi + pad;
  const bot = lo - pad;
  const py = (p: number) => r.y + ((top - p) / (top - bot)) * r.h;
  const slot = r.w / view.length;
  const px = (t: number) => r.x + ((t - view[0]!.time) / (span + barMs)) * r.w + slot / 2;
  const bw = Math.max(1, Math.min(9, slot * 0.62));

  // Grid + price axis.
  ctx.strokeStyle = "rgba(255,255,255,.05)";
  ctx.lineWidth = 1;
  ctx.fillStyle = C.dim;
  ctx.font = `400 11px ${FONT}`;
  ctx.textBaseline = "middle";
  for (let i = 0; i <= 4; i++) {
    const p = bot + ((top - bot) * i) / 4;
    const yy = Math.round(py(p)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(r.x, yy);
    ctx.lineTo(r.x + r.w, yy);
    ctx.stroke();
    ctx.fillText(fmtPrice(p), r.x + r.w + 8, yy);
  }

  // Shade everything since the call.
  const tx = px(tweet.postedAt - barMs / 2);
  const up = stats.callPct >= 0;
  ctx.fillStyle = up ? "rgba(60,227,98,.05)" : "rgba(255,73,83,.05)";
  ctx.fillRect(tx, r.y, r.x + r.w - tx, r.h);

  for (const b of view) {
    const x = px(b.time);
    const green = b.close >= b.open;
    ctx.strokeStyle = ctx.fillStyle = green ? C.green : C.red;
    ctx.beginPath();
    ctx.moveTo(Math.round(x) + 0.5, py(b.high));
    ctx.lineTo(Math.round(x) + 0.5, py(b.low));
    ctx.stroke();
    const y1 = py(Math.max(b.open, b.close));
    const y2 = py(Math.min(b.open, b.close));
    ctx.fillRect(x - bw / 2, y1, bw, Math.max(1, y2 - y1));
  }

  // Entry line and the call marker.
  ctx.setLineDash([5, 5]);
  ctx.strokeStyle = "rgba(242,242,243,.55)";
  ctx.beginPath();
  ctx.moveTo(r.x, py(stats.entry));
  ctx.lineTo(r.x + r.w, py(stats.entry));
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(tx, r.y);
  ctx.lineTo(tx, r.y + r.h);
  ctx.stroke();
  ctx.setLineDash([]);

  // Pin: avatar bubble on the entry price.
  const ex = tx;
  const ey = py(stats.entry);
  ctx.beginPath();
  ctx.arc(ex, ey, 17, 0, Math.PI * 2);
  ctx.fillStyle = C.fire;
  ctx.fill();
  ctx.save();
  ctx.beginPath();
  ctx.arc(ex, ey, 14, 0, Math.PI * 2);
  ctx.clip();
  if (avatar) ctx.drawImage(avatar, ex - 14, ey - 14, 28, 28);
  else {
    ctx.fillStyle = C.ink;
    ctx.fill();
  }
  ctx.restore();

  // Now dot.
  const last = view[view.length - 1]!;
  ctx.beginPath();
  ctx.arc(px(last.time), py(stats.now), 4.5, 0, Math.PI * 2);
  ctx.fillStyle = up ? C.green : C.red;
  ctx.fill();
  ctx.font = `600 12px ${FONT}`;
  const lbl = fmtPrice(stats.now);
  const lw = ctx.measureText(lbl).width + 12;
  roundRect(ctx, r.x + r.w + 4, py(stats.now) - 10, lw, 20, 5);
  ctx.fill();
  ctx.fillStyle = C.ink;
  ctx.fillText(lbl, r.x + r.w + 10, py(stats.now));
}
