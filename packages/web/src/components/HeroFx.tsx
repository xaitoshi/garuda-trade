import { useEffect, useRef } from "react";
import { openingPixels, PITCH, TOP, BOTTOM } from "./heroOpening";

/**
 * The opening of the hero knight's helmet wakes every few seconds, each time in the next dim, unsettling colour.
 *
 * Nothing is drawn by hand: the effect takes the artwork's own light pixels around the opening (every dot that borders
 * the dark dome of the helmet) and paints exactly those pixels, on a layer that sits on the <img> with the same
 * object-fit and object-position. So the coloured dots are the white dots, pixel for pixel, never beside them.
 * The light rises from the bottom, holds, blinks twice like an eyelid, glares, then sinks away.
 */
const CYCLE = 6.5; // seconds between wakings
const FIRST = 1.2; // the first waking, after the page settles
// each waking uses the next colour: dim, deep and unsettling rather than bright. rgb of the dots, and of their glow
const MOODS: { dot: [number, number, number]; glow: string }[] = [
  { dot: [196, 28, 18], glow: "rgba(150,0,0," },     // blood red
  { dot: [214, 92, 18], glow: "rgba(170,50,0," },    // ember, the Phoenix orange gone dark
  { dot: [150, 24, 72], glow: "rgba(110,0,50," },    // bruised crimson
  { dot: [120, 36, 150], glow: "rgba(80,10,120," },  // cursed violet
];
const PEAK = 0.72; // the brightest the dots get: lit, but never glaring
// which dots are the opening is worked out in heroOpening.ts (and tested against the art there)
const ease = (t: number) => 1 - Math.pow(1 - Math.max(0, Math.min(1, t)), 3);

/** The eyes wake: the light rises from the bottom, holds, blinks twice (an eyelid closing, top to bottom), glares
 * for a moment, then sinks away. reveal 0..1 = how far up it has climbed, b = brightness, bloom, mood = colour index. */
function phase(t: number) {
  if (t < FIRST) return { reveal: 0, b: 0, bloom: 0, mood: 0 };
  const n = Math.floor((t - FIRST) / CYCLE), k = (t - FIRST) % CYCLE, mood = n % MOODS.length;
  const on = (reveal: number, b: number, bloom: number) => ({ reveal, b: b * PEAK, bloom, mood });
  if (k < 0.7) { const r = ease(k / 0.7); return on(r, 0.6 + 0.4 * r, 0.4 * r); }            // rises
  if (k < 1.5) return on(1, 0.85 + 0.15 * Math.sin((k - 0.7) * 6), 0.4);                   // holds, pulsing
  // two blinks: the lid comes down (reveal falls from the top), then opens again
  const blink = (k0: number) => { const x = (k - k0) / 0.22; return x < 0 || x > 1 ? 1 : Math.abs(1 - 2 * x); };
  if (k < 2.1) { const r = Math.min(blink(1.5), blink(1.82)); return on(0.15 + 0.85 * r, 1, 0.4 * r); }
  if (k < 2.5) { const f = 1 - (k - 2.1) / 0.4; return on(1, 1 + 0.25 * f, 0.4 + 0.5 * f); } // glares
  if (k < 3.6) return on(1, 0.9 + 0.1 * Math.sin((k - 2.5) * 3), 0.35);
  if (k < 4.4) { const r = 1 - ease((k - 3.6) / 0.8); return on(r, 0.5 + 0.5 * r, 0.25 * r); } // sinks away
  return { reveal: 0, b: 0, bloom: 0, mood };
}

export function HeroFx({ src, imgClass }: { src: string; imgClass: string }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const host = canvas?.parentElement;
    const img = host?.querySelector<HTMLImageElement>(`img.${imgClass}`);
    if (!canvas || !host || !img) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const g = canvas.getContext("2d")!;
    let layers: HTMLCanvasElement[] = [];
    let raf = 0, dead = false, visible = true, t0 = 0, last = 0;
    let s = 1, ox = 0, oy = 0, dpr = 1;

    // one layer per colour, the size of the artwork: the opening's own light pixels in that colour
    const analyse = (im: HTMLImageElement) => {
      const W = im.naturalWidth, H = im.naturalHeight;
      const c = document.createElement("canvas"); c.width = W; c.height = H;
      const cg = c.getContext("2d", { willReadFrequently: true })!;
      cg.drawImage(im, 0, 0);
      const d = cg.getImageData(0, 0, W, H).data;
      const alpha = openingPixels(d, W, H);
      // paint those pixels in one colour
      const mk = (col: [number, number, number]) => {
        const o = document.createElement("canvas"); o.width = W; o.height = H;
        const og = o.getContext("2d")!, out = og.createImageData(W, H);
        for (let k = 0; k < alpha.length; k++) {
          if (!alpha[k]) continue;
          const p = k * 4;
          out.data[p] = col[0]; out.data[p + 1] = col[1]; out.data[p + 2] = col[2]; out.data[p + 3] = alpha[k]!;
        }
        og.putImageData(out, 0, 0);
        return o;
      };
      layers = MOODS.map((m) => mk(m.dot));
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
      const glow = layers[st.mood];
      if (!glow || st.b <= 0.01 || st.reveal <= 0) return;
      g.setTransform(dpr * s, 0, 0, dpr * s, dpr * ox, dpr * oy);
      // only rows below the current level are lit
      const level = BOTTOM + PITCH - st.reveal * (BOTTOM - TOP + 2 * PITCH);
      g.save();
      g.beginPath(); g.rect(0, level, glow.width, BOTTOM + PITCH - level); g.clip();
      g.shadowColor = MOODS[st.mood]!.glow + Math.min(1, st.bloom) + ")";
      g.shadowBlur = (6 + 10 * st.bloom) * dpr * s;
      g.globalAlpha = Math.min(1, st.b);
      g.drawImage(glow, 0, 0);
      g.restore();
    };

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      if (dead || !visible || document.hidden || !layers.length) return;
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
      if (reduce) paint({ reveal: 1, b: PEAK, bloom: 0.3, mood: 0 }); // lit, still
      else raf = requestAnimationFrame(frame);
    };
    probe.src = src;
    return () => { dead = true; cancelAnimationFrame(raf); io.disconnect(); ro.disconnect(); };
  }, [src, imgClass]);

  return <canvas ref={ref} className="hero-fx" aria-hidden />;
}
