import { useEffect, useRef } from "react";
import { openingPixels, PITCH, TOP, BOTTOM } from "./heroOpening";

/**
 * The opening of the hero knight's helmet wakes every few seconds in a muted Phoenix orange.
 *
 * Nothing is drawn by hand: the effect takes the artwork's own light pixels around the opening (every dot that borders
 * the dark dome of the helmet) and paints exactly those pixels, on a layer that sits on the <img> with the same
 * object-fit and object-position. So the coloured dots are the white dots, pixel for pixel, never beside them.
 * Mostly dark; then the eyes snap on, the knight sinks into shadow, a blink, a harder stare, and a stuttering death.
 */
const CYCLE = 7.5; // seconds between wakings: mostly darkness
const FIRST = 1.2; // the first waking, after the page settles
// one colour: the Phoenix orange, toned down so it smoulders instead of glaring
const MOODS: { dot: [number, number, number]; glow: string }[] = [
  { dot: [214, 112, 40], glow: "rgba(170,70,10," },
];
const PEAK = 0.72; // the brightest the dots get: lit, but never glaring
// which dots are the opening is worked out in heroOpening.ts (and tested against the art there)
const ease = (t: number) => 1 - Math.pow(1 - Math.max(0, Math.min(1, t)), 3);

/** Menace, not decoration: long darkness, then the eyes snap on at once and the rest of the knight sinks into shadow.
 * They smoulder with a slow breath, blink once (the lid falls from the top), stare harder, then die with a stutter.
 * reveal = how much of the opening is lit from the bottom (the lid), b = brightness, bloom, dim = shadow over the knight. */
function phase(t: number) {
  const off = { reveal: 0, b: 0, bloom: 0, mood: 0, dim: 0 };
  if (t < FIRST) return off;
  const k = (t - FIRST) % CYCLE;
  const on = (reveal: number, b: number, bloom: number, dim: number) => ({ reveal, b: b * PEAK, bloom, mood: 0, dim });
  if (k < 0.05) return on(1, 1.4 * (k / 0.05), 1.2 * (k / 0.05), 0.45 * (k / 0.05));            // snaps on
  if (k < 0.35) { const f = 1 - (k - 0.05) / 0.3; return on(1, 1 + 0.4 * f, 0.6 + 0.6 * f, 0.45); } // the flash settles
  const breath = 0.8 + 0.2 * Math.sin((k - 0.35) * 1.8);
  if (k < 2.0) return on(1, breath, 0.55 * breath, 0.45);                                       // smoulders
  if (k < 2.45) { const x = (k - 2.0) / 0.45, lid = Math.abs(1 - 2 * x); return on(0.1 + 0.9 * lid, breath, 0.5 * lid, 0.45); } // one slow blink
  if (k < 2.9) { const f = (k - 2.45) / 0.45; return on(1, breath + 0.3 * Math.sin(f * Math.PI), 0.55 + 0.4 * Math.sin(f * Math.PI), 0.5); } // stares harder
  if (k < 3.6) return on(1, breath, 0.5 * breath, 0.45);
  // dies with a stutter: off, on, off, faint, gone
  const st = [[3.6, 0], [3.68, 0.9], [3.74, 0], [3.86, 0.5], [3.92, 0]] as const;
  for (let i = st.length - 1; i >= 0; i--) if (k >= st[i]![0]) return st[i]![1] ? on(1, st[i]![1], 0.3 * st[i]![1], 0.45 * st[i]![1]) : { ...off, dim: i < st.length - 1 ? 0.25 : 0 };
  return off;
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
      if (st.dim > 0) { g.fillStyle = `rgba(0,0,0,${st.dim})`; g.fillRect(0, 0, canvas.width, canvas.height); }
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
      if (reduce) paint({ reveal: 1, b: PEAK, bloom: 0.3, mood: 0, dim: 0.3 }); // lit, still
      else raf = requestAnimationFrame(frame);
    };
    probe.src = src;
    return () => { dead = true; cancelAnimationFrame(raf); io.disconnect(); ro.disconnect(); };
  }, [src, imgClass]);

  return <canvas ref={ref} className="hero-fx" aria-hidden />;
}
