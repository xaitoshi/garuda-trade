import { useEffect, useRef } from "react";

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

// the opening, in the 879px pixel space of /art/landing/hero-knight-dotted.png: a point inside the dark dome, and the
// band of rows where the dome's border is the opening (above TOP it is the dome's crown, below BOTTOM it is the mask)
const SEED = { x: 488, y: 200 };
const TOP = 120, BOTTOM = 300;
const PITCH = 5; // the artwork's dot spacing
const NEAR = 1; // a light dot belongs to the opening when it is within this many cells of the dark dome

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
      const L = (x: number, y: number) => { const o = (y * W + x) * 4; return d[o]! * 0.3 + d[o + 1]! * 0.59 + d[o + 2]! * 0.11; };
      // the dot grid's phase: where sampling hits the most light
      let best = -1, px0 = 0, py0 = 0;
      for (let py = 0; py < PITCH; py++) for (let px = 0; px < PITCH; px++) {
        let sum = 0;
        for (let y = py; y < H; y += PITCH * 4) for (let x = px; x < W; x += PITCH * 4) sum += L(x, y);
        if (sum > best) { best = sum; px0 = px; py0 = py; }
      }
      const cols = Math.ceil((W - px0) / PITCH), rows = Math.ceil((H - py0) / PITCH);
      const lit = (i: number, j: number) => i >= 0 && j >= 0 && i < cols && j < rows && L(Math.min(W - 1, px0 + i * PITCH), Math.min(H - 1, py0 + j * PITCH)) > 70;
      // the dark dome: flood fill over unlit cells from SEED, not below BOTTOM
      const dark = new Uint8Array(cols * rows), seen = new Uint8Array(cols * rows);
      const stack: [number, number][] = [[Math.round((SEED.x - px0) / PITCH), Math.round((SEED.y - py0) / PITCH)]];
      while (stack.length) {
        const [i, j] = stack.pop()!;
        if (i < 0 || j < 0 || i >= cols || j >= rows) continue;
        const k = j * cols + i;
        if (seen[k]) continue;
        seen[k] = 1;
        if (lit(i, j) || py0 + j * PITCH > BOTTOM) continue;
        dark[k] = 1;
        stack.push([i + 1, j], [i - 1, j], [i, j + 1], [i, j - 1]);
      }
      // cells of the opening: light cells within NEAR of the dome, between TOP and BOTTOM
      const keep = new Uint8Array(cols * rows);
      for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
        const y = py0 + j * PITCH;
        if (y < TOP || y > BOTTOM || !lit(i, j)) continue;
        let near = false;
        for (let b = -NEAR; b <= NEAR && !near; b++) for (let a = -NEAR; a <= NEAR; a++) {
          const ii = i + a, jj = j + b;
          if (ii >= 0 && jj >= 0 && ii < cols && jj < rows && dark[jj * cols + ii]) { near = true; break; }
        }
        if (near) keep[j * cols + i] = 1;
      }
      // paint the artwork's own pixels of those cells
      const mk = (col: [number, number, number]) => {
        const o = document.createElement("canvas"); o.width = W; o.height = H;
        const og = o.getContext("2d")!, out = og.createImageData(W, H);
        for (let y = Math.max(0, TOP - PITCH); y < Math.min(H, BOTTOM + PITCH); y++) for (let x = 0; x < W; x++) {
          const i = Math.round((x - px0) / PITCH), j = Math.round((y - py0) / PITCH);
          if (i < 0 || j < 0 || i >= cols || j >= rows || !keep[j * cols + i]) continue;
          const l = L(x, y);
          if (l < 40) continue;
          const p = (y * W + x) * 4;
          out.data[p] = col[0]; out.data[p + 1] = col[1]; out.data[p + 2] = col[2];
          out.data[p + 3] = Math.min(255, Math.round(((l - 40) / 140) * 255));
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
