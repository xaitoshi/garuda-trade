import { useEffect, useRef } from "react";
import { openingPixels, PITCH, TOP, BOTTOM } from "./heroOpening";

/**
 * The opening of the hero knight's helmet lights up in Phoenix orange every few seconds.
 *
 * Nothing is drawn by hand: the effect takes the artwork's own light pixels around the opening (every dot that borders
 * the dark dome of the helmet) and paints exactly those pixels orange, on a layer that sits on the <img> with the same
 * object-fit and object-position. So the orange dots are the white dots, pixel for pixel, never beside them.
 * The light rises from the bottom of the opening to the top, flares, burns with a slow breath and an odd flicker, then
 * drains back down.
 */
const CYCLE = 8; // seconds between ignitions
const FIRST = 1.2; // the first ignition, after the page settles
const ORANGE: [number, number, number] = [255, 122, 24];
const HOT: [number, number, number] = [255, 214, 150];
const BLOOM = "rgba(255,70,10,";

// which dots are the opening is worked out in heroOpening.ts (and tested against the art there)
const ease = (t: number) => 1 - Math.pow(1 - Math.max(0, Math.min(1, t)), 3);

/** reveal 0..1 (how far up the light has climbed), brightness, bloom */
function phase(t: number) {
  if (t < FIRST) return { reveal: 0, b: 0, bloom: 0 };
  const k = (t - FIRST) % CYCLE;
  if (k < 0.6) { const r = ease(k / 0.6); return { reveal: r, b: 0.7 + 0.3 * r, bloom: 0.5 * r }; }   // light climbs
  if (k < 0.8) { const f = 1 - (k - 0.6) / 0.2; return { reveal: 1, b: 1 + 0.35 * f, bloom: 0.5 + 0.5 * f }; } // flare
  if (k < 3.7) {                                                                                     // burn
    const breath = 0.88 + 0.12 * Math.sin((k - 0.8) * 2.4);
    const flicker = k > 2.55 && k < 2.68 ? 0.5 : k > 2.72 && k < 2.78 ? 0.75 : 1;
    return { reveal: 1, b: breath * flicker, bloom: 0.45 * breath * flicker };
  }
  if (k < 4.6) { const r = 1 - ease((k - 3.7) / 0.9); return { reveal: r, b: 0.5 + 0.5 * r, bloom: 0.3 * r }; } // drains down
  return { reveal: 0, b: 0, bloom: 0 };
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
    let glow: HTMLCanvasElement | null = null, hot: HTMLCanvasElement | null = null;
    let raf = 0, dead = false, visible = true, t0 = 0, last = 0;
    let s = 1, ox = 0, oy = 0, dpr = 1;

    // build two layers the size of the artwork: the opening's own light pixels in orange, and the same in hot white-orange
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
      glow = mk(ORANGE); hot = mk(HOT);
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
      if (!glow || !hot || st.b <= 0.01 || st.reveal <= 0) return;
      g.setTransform(dpr * s, 0, 0, dpr * s, dpr * ox, dpr * oy);
      // the light climbs: only rows below the current level are shown
      const level = BOTTOM + PITCH - st.reveal * (BOTTOM - TOP + 2 * PITCH);
      g.save();
      g.beginPath(); g.rect(0, level, glow.width, BOTTOM + PITCH - level); g.clip();
      g.shadowColor = BLOOM + Math.min(1, st.bloom) + ")";
      g.shadowBlur = (8 + 14 * st.bloom) * dpr * s;
      g.globalAlpha = Math.min(1, st.b);
      g.drawImage(glow, 0, 0);
      g.shadowBlur = 0;
      if (st.b > 1) { g.globalAlpha = Math.min(1, (st.b - 1) * 2.5); g.drawImage(hot, 0, 0); } // the flare runs hot
      // a bright band at the climbing edge
      if (st.reveal < 1) {
        g.globalAlpha = 0.9;
        g.beginPath(); g.rect(0, level, glow.width, 2 * PITCH); g.clip();
        g.drawImage(hot, 0, 0);
      }
      g.restore();
    };

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      if (dead || !visible || document.hidden || !glow) return;
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
      if (reduce) paint({ reveal: 1, b: 0.9, bloom: 0.3 }); // lit, still
      else raf = requestAnimationFrame(frame);
    };
    probe.src = src;
    return () => { dead = true; cancelAnimationFrame(raf); io.disconnect(); ro.disconnect(); };
  }, [src, imgClass]);

  return <canvas ref={ref} className="hero-fx" aria-hidden />;
}
