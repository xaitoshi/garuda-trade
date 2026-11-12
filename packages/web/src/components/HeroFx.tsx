import { useEffect, useRef } from "react";

/**
 * The opening of the hero knight's helmet: a clean U of dots along the lower edge of the dark dome fills with Phoenix
 * orange every few seconds. A spark at the bottom of the U, the colour climbs both arms, flares, burns with a slow
 * breath and an odd flicker, then drains back down. The U is a vector curve (half a superellipse fitted to the dome),
 * drawn as dots on the artwork's own 5px grid, so it stays smooth instead of following the art's ragged edge.
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

// the helmet opening in the 879px pixel space of /art/landing/hero-knight-dotted.png: half a superellipse around the
// dome (centre, radii, how square its bottom is), swept from A0 to A1 degrees, never below FLOOR
// fitted to the artwork: the parameters minimise the distance to the art's own edge dots around the opening
const U = { cx: 475, cy: 152, rx: 117, ry: 126, ex: 1.75, a0: -14, a1: 194, floor: 296 };
const STROKE = 3.6; // grid dots closer than this to the curve are lit: one to two dots thick
const BOTTOM = { x: U.cx, y: U.floor };

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
    let cells: Cell[] = [];
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
      cells = [];
      const pts: [number, number, number][] = [];
      for (let d = U.a0; d <= U.a1; d += 0.5) {
        const t = (d * Math.PI) / 180, sn = Math.sin(t);
        // along: 0 at the bottom of the U, 1 at the tips, so the colour climbs both arms together
        pts.push([U.cx + U.rx * Math.cos(t), Math.min(U.floor, U.cy + U.ry * Math.sign(sn) * Math.pow(Math.abs(sn), U.ex)), Math.abs(d - 90) / Math.max(90 - U.a0, U.a1 - 90)]);
      }
      for (let y = py0; y <= U.floor + PITCH; y += PITCH) for (let x = px0; x < c.width; x += PITCH) {
        if (x < U.cx - U.rx - 8 || x > U.cx + U.rx + 8) continue;
        let best = Infinity, along = 0;
        for (const [px, py, a] of pts) { const dd = Math.hypot(x - px, y - py); if (dd < best) { best = dd; along = a; } }
        if (best < STROKE) cells.push({ x, y, along, core: 1 - (best / STROKE) * 0.4, eye: 0 });
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
      // the rim dots turn orange, hotter at the flare, with a soft glow
      g.shadowColor = rgba(pal.bloom, Math.min(1, st.bloom));
      g.shadowBlur = (6 + 12 * st.bloom) * dpr * s;
      for (const c of cells) {
        const shown = st.reveal - c.along;                 // >0 once the fire has reached this dot
        if (shown <= 0) continue;
        const k = Math.min(1, shown / 0.18);
        const heat = Math.min(1, c.core * Math.min(1.25, st.b) * k);
        const col = heat < 0.85 ? mix(pal.outer, pal.mid, heat / 0.85) : mix(pal.mid, pal.core, ((heat - 0.85) / 0.4));
        g.fillStyle = rgba(col, Math.min(1, (0.5 + 0.5 * heat) * k * Math.min(1, st.b + 0.2)));
        g.beginPath(); g.arc(c.x, c.y, R * (0.95 + 0.2 * heat), 0, Math.PI * 2); g.fill();
      }
      // 4. the spark at the bottom of the U, before the colour climbs
      if (st.spark > 0.01) {
        g.fillStyle = rgba(pal.core, st.spark);
        g.beginPath(); g.arc(BOTTOM.x, BOTTOM.y, R * (1 + 1.4 * st.spark), 0, Math.PI * 2); g.fill();
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
