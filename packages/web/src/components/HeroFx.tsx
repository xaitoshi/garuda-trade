import { useEffect, useRef } from "react";

/**
 * The opening of the hero knight's helmet: the T-shaped slit (across the visor, then down the face) lights from inside
 * every few seconds. A spark at the junction, the light runs out along both arms and down the stem, flares, burns with
 * a slow breath and an odd flicker, and dies back to the junction. Everything is drawn on the artwork's own 5px dot
 * grid: the slit is cleared to black, its dots glow from a hot core to a dark outer colour, and the light spills onto the
 * nearby dots of the mask. The picture itself never changes.
 * The canvas matches the <img> it sits on: same object-fit (cover) and object-position from CSS.
 */
const PITCH = 5;
const CYCLE = 8; // seconds between ignitions
const FIRST = 1.2; // the first ignition, after the page settles

type RGB = [number, number, number];
export interface EyePalette { core: RGB; mid: RGB; outer: RGB; bloom: RGB }
/** Colour ideas, all built around the Phoenix orange. `?eyes=<name>` on the page picks one, for comparing. */
export const EYE_PALETTES: Record<string, EyePalette> = {
  inferno: { core: [255, 236, 190], mid: [255, 122, 24], outer: [214, 22, 12], bloom: [255, 60, 10] },
  blood: { core: [255, 214, 160], mid: [246, 110, 40], outer: [150, 0, 22], bloom: [200, 10, 30] },
  ember: { core: [255, 250, 225], mid: [255, 168, 60], outer: [255, 72, 0], bloom: [255, 110, 20] },
  hex: { core: [255, 230, 210], mid: [255, 100, 40], outer: [196, 20, 120], bloom: [230, 30, 110] },
  void: { core: [255, 240, 220], mid: [255, 120, 40], outer: [120, 30, 220], bloom: [150, 40, 255] },
};
const DEFAULT_PALETTE = "inferno";

// the T-shaped opening, in the 879px pixel space of /art/landing/hero-knight-dotted.png: two arms out from the junction
// across the visor and a stem down the face. half = half-width of the slit at the junction, tapering to the tip.
const JUNCTION = { x: 488, y: 300 };
const ARMS = [
  { x: 414, y: 292, half: 5.5 },  // left arm, rising slightly toward the edge
  { x: 562, y: 292, half: 5.5 },  // right arm
  { x: 490, y: 452, half: 4.5 },  // stem down the face
];
const REACH = Math.max(...ARMS.map((a) => Math.hypot(a.x - JUNCTION.x, a.y - JUNCTION.y)));

const ease = (t: number) => 1 - Math.pow(1 - Math.max(0, Math.min(1, t)), 3);
const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const rgba = (c: RGB, a: number) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;

/** State of the eyes at time t (s): reveal 0..1 from the junction out, brightness, bloom strength, spark 0..1. */
function phase(t: number) {
  if (t < FIRST) return { reveal: 0, b: 0, bloom: 0, spark: 0 };
  const k = (t - FIRST) % CYCLE;
  if (k < 0.14) return { reveal: 0, b: 0, bloom: 0.3 * (k / 0.14), spark: k / 0.14 };                 // spark at the junction
  if (k < 0.55) { const r = ease((k - 0.14) / 0.41); return { reveal: r, b: 0.55 + 0.45 * r, bloom: 0.4 + 0.4 * r, spark: 1 - r }; } // fire runs outward
  if (k < 0.75) { const f = 1 - (k - 0.55) / 0.2; return { reveal: 1, b: 1 + 0.45 * f, bloom: 0.8 + 0.7 * f, spark: 0 }; }        // flare
  if (k < 3.7) {                                                                                       // burn, breathe, one flicker
    const breath = 0.88 + 0.12 * Math.sin((k - 0.75) * 2.4);
    const flicker = k > 2.55 && k < 2.68 ? 0.45 : k > 2.72 && k < 2.78 ? 0.7 : 1;
    return { reveal: 1, b: breath * flicker, bloom: 0.75 * breath * flicker, spark: 0 };
  }
  if (k < 4.5) { const r = 1 - ease((k - 3.7) / 0.8); return { reveal: r, b: 0.4 + 0.5 * r, bloom: 0.6 * r, spark: 0 }; }       // die back inward
  return { reveal: 0, b: 0, bloom: 0, spark: 0 };
}

interface Cell { x: number; y: number; along: number; core: number; eye: number }
interface Spill { x: number; y: number; w: number }

export function HeroFx({ src, imgClass }: { src: string; imgClass: string }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const host = canvas?.parentElement;
    const img = host?.querySelector<HTMLImageElement>(`img.${imgClass}`);
    if (!canvas || !host || !img) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let pal = EYE_PALETTES[DEFAULT_PALETTE]!;
    try { const q = new URLSearchParams(location.search).get("eyes"); if (q && EYE_PALETTES[q]) pal = EYE_PALETTES[q]!; } catch { /* default */ }
    const g = canvas.getContext("2d")!;
    let cells: Cell[] = [], socket: { x: number; y: number }[] = [], spill: Spill[] = [];
    let raf = 0, dead = false, visible = true, t0 = 0, last = 0;
    let s = 1, ox = 0, oy = 0, dpr = 1;

    const analyse = (im: HTMLImageElement) => {
      const c = document.createElement("canvas");
      c.width = im.naturalWidth; c.height = im.naturalHeight;
      const cg = c.getContext("2d", { willReadFrequently: true })!;
      cg.drawImage(im, 0, 0);
      const d = cg.getImageData(0, 0, c.width, c.height).data;
      const L = (x: number, y: number) => { const o = (y * c.width + x) * 4; return d[o]! * 0.3 + d[o + 1]! * 0.59 + d[o + 2]! * 0.11; };
      let best = -1, px0 = 0, py0 = 0;
      for (let py = 0; py < PITCH; py++) for (let px = 0; px < PITCH; px++) {
        let sum = 0;
        for (let y = py; y < c.height; y += PITCH * 4) for (let x = px; x < c.width; x += PITCH * 4) sum += L(x, y);
        if (sum > best) { best = sum; px0 = px; py0 = py; }
      }
      cells = []; socket = []; spill = [];
      for (let y = py0; y < 480; y += PITCH) for (let x = px0; x < 640; x += PITCH) {
        let inSlit = false, nearest = Infinity, sock = false;
        ARMS.forEach((a, ai) => {
          const vx = a.x - JUNCTION.x, vy = a.y - JUNCTION.y, len = Math.hypot(vx, vy);
          const u = ((x - JUNCTION.x) * vx + (y - JUNCTION.y) * vy) / len;          // distance along the arm
          const v = Math.abs((x - JUNCTION.x) * vy - (y - JUNCTION.y) * vx) / len;  // distance across it
          const t = u / len;
          nearest = Math.min(nearest, Math.hypot(x - (JUNCTION.x + vx * Math.max(0, Math.min(1, t))), y - (JUNCTION.y + vy * Math.max(0, Math.min(1, t)))));
          if (t < -0.04 || t > 1) return;
          const half = a.half * Math.pow(1 - Math.max(0, t), 0.45) + 0.8;          // tapers to a point at the tip
          if (v <= half + 3.2) sock = true;
          if (v <= half + 0.6 && !inSlit) {
            inSlit = true;
            cells.push({ x, y, along: (Math.max(0, u) / REACH), core: Math.max(0, 1 - v / Math.max(half, 1.5)) * (1 - 0.55 * Math.max(0, t)), eye: ai });
          }
        });
        if (sock) socket.push({ x, y });
        if (!inSlit && nearest < 70 && L(x, y) > 70) spill.push({ x, y, w: Math.pow(1 - nearest / 70, 1.6) });
      }
    };

    const layout = () => {
      const W = host.clientWidth, H = host.clientHeight;
      if (!img.naturalWidth || W < 4) return;
      dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
      const r = img.getBoundingClientRect(), hr = host.getBoundingClientRect();
      const pos = getComputedStyle(img).objectPosition.split(" ").map((p) => (p.endsWith("%") ? parseFloat(p) / 100 : 0.5));
      s = Math.max(r.width / img.naturalWidth, r.height / img.naturalHeight);
      ox = r.left - hr.left + (r.width - img.naturalWidth * s) * (pos[0] ?? 0.5);
      oy = r.top - hr.top + (r.height - img.naturalHeight * s) * (pos[1] ?? 0.5);
    };

    const paint = (st: ReturnType<typeof phase>) => {
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, canvas.width, canvas.height);
      const on = st.b > 0.01 || st.spark > 0.01;
      if (!on) return;
      g.setTransform(dpr * s, 0, 0, dpr * s, dpr * ox, dpr * oy);
      const R = PITCH * 0.36;
      // 1. the socket goes black, so the slit reads as an opening in the helmet, not a sticker on it
      g.fillStyle = `rgba(0,0,0,${Math.min(1, 0.4 + st.b)})`;
      for (const p of socket) g.fillRect(p.x - PITCH / 2, p.y - PITCH / 2, PITCH, PITCH);
      // 2. light spill on the mask around the opening
      for (const p of spill) {
        const a = p.w * 0.55 * Math.min(1.2, st.b);
        if (a < 0.03) continue;
        g.fillStyle = rgba(mix(pal.outer, pal.mid, p.w), a);
        g.beginPath(); g.arc(p.x, p.y, R, 0, Math.PI * 2); g.fill();
      }
      // 3. bloom, then the slit dots from the dark rim to the hot core
      g.shadowColor = rgba(pal.bloom, Math.min(1, st.bloom));
      g.shadowBlur = (10 + 22 * st.bloom) * dpr * s;
      for (const c of cells) {
        const shown = st.reveal - c.along;                 // >0 once the fire has reached this dot
        if (shown <= 0) continue;
        const k = Math.min(1, shown / 0.18);
        const heat = Math.min(1, c.core * Math.min(1.25, st.b) * k);
        const col = heat < 0.5 ? mix(pal.outer, pal.mid, heat * 2) : mix(pal.mid, pal.core, (heat - 0.5) * 2);
        g.fillStyle = rgba(col, Math.min(1, (0.5 + 0.5 * heat) * k * Math.min(1, st.b + 0.2)));
        g.beginPath(); g.arc(c.x, c.y, R * (0.85 + 0.45 * heat), 0, Math.PI * 2); g.fill();
      }
      // 4. the spark: one white-hot dot at the junction, before the light runs
      if (st.spark > 0.01) {
        g.fillStyle = rgba(pal.core, st.spark);
        g.beginPath(); g.arc(JUNCTION.x, JUNCTION.y, R * (1 + 1.4 * st.spark), 0, Math.PI * 2); g.fill();
      }
      g.shadowBlur = 0;
    };

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      if (dead || !visible || document.hidden || !cells.length) return;
      if (now - last < 1000 / 40) return;
      last = now;
      if (!t0) t0 = now;
      paint(phase((now - t0) / 1000));
    };

    const io = new IntersectionObserver((es) => { visible = es[es.length - 1]?.isIntersecting ?? true; });
    io.observe(host);
    const ro = new ResizeObserver(layout);
    ro.observe(host);
    const probe = new Image();
    probe.onload = () => {
      if (dead) return;
      analyse(probe); layout();
      if (reduce) paint({ reveal: 1, b: 0.85, bloom: 0.6, spark: 0 }); // lit, still
      else raf = requestAnimationFrame(frame);
    };
    probe.src = src;
    return () => { dead = true; cancelAnimationFrame(raf); io.disconnect(); ro.disconnect(); };
  }, [src, imgClass]);

  return <canvas ref={ref} className="hero-fx" aria-hidden />;
}
