import { useEffect, useRef } from "react";

/** Grid produced by the ASCII knight renderer (public/art/landing/knight-grid.json). */
interface KnightGrid {
  W: number;
  H: number;
  C: number;
  R: number;
  tone: number[][];
  edges: number[][];
  ramp: string[];
  coverage: number[];
}

const CELL_W = 8;
const CELL_H = 14;
const RADIUS = 80; // scramble radius, grid units
const SETTLE_MS = 800; // scramble fades out over this long
const LOOP_MS = 5000; // shimmer loop length
const CODES = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const EDGE_GLYPHS = ["-", "\\", "|", "/"];
const FONT = "KnightMono";

let gridPromise: Promise<KnightGrid> | null = null;
function loadGrid(): Promise<KnightGrid> {
  gridPromise ??= fetch("/art/landing/knight-grid.json").then((r) => {
    if (!r.ok) throw new Error(`knight grid ${r.status}`);
    return r.json() as Promise<KnightGrid>;
  });
  return gridPromise;
}

/** Nearest coverage index; coverage is sorted ascending, so a binary search gives the same pick as a linear scan. */
function nearest(coverage: number[], v: number): number {
  let lo = 0;
  let hi = coverage.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (coverage[mid]! <= v) lo = mid;
    else hi = mid;
  }
  return Math.abs(v - coverage[lo]!) <= Math.abs(v - coverage[hi]!) ? lo : hi;
}

/**
 * Interactive ASCII knight: a looping grey shimmer, and A-Z/0-9 scramble near the pointer or a touch that settles in ~0.8s.
 * Draws on a transparent, DPR-aware canvas so the hero background shows through.
 */
export function AsciiKnight({ className }: { className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let disposed = false;
    let raf = 0;
    let visible = true;
    let grid: KnightGrid | null = null;
    let marks: Float64Array | null = null;
    let ox = 0;
    let oy = 0;
    // Mapping from grid units to device pixels (contain fit).
    let scale = 1;
    let offX = 0;
    let offY = 0;
    const start = performance.now();
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

    const resize = () => {
      if (!grid) return;
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(1, Math.round(rect.width * dpr));
      const h = Math.max(1, Math.round(rect.height * dpr));
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
      scale = Math.min(w / grid.W, h / grid.H);
      offX = (w - grid.W * scale) / 2;
      offY = (h - grid.H * scale) / 2;
    };

    const draw = (now: number) => {
      if (!grid || !marks) return;
      const g = grid;
      const t = 2 * Math.PI * (((now - start) / LOOP_MS) % 1);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(scale, 0, 0, scale, offX, offY);
      ctx.font = `13px ${FONT}, ui-monospace, monospace`;
      ctx.textBaseline = "top";
      const tick = Math.floor(now / 55);
      for (let r = 0; r < g.R; r++) {
        const toneRow = g.tone[r]!;
        const edgeRow = g.edges[r]!;
        for (let x = 0; x < g.C; x++) {
          const base = toneRow[x]!;
          if (base < 0.05) continue;
          const phase = x * 0.73 + r * 1.21;
          const wave = Math.sin(t - (r / g.R) * 2 * Math.PI + (x / g.C) * 0.7);
          const flick = Math.sin(2 * t + phase) * Math.sin(t + phase * 0.37);
          const v = Math.max(0, Math.min(1, base * (0.91 + 0.07 * wave + 0.025 * flick)));
          if (v < 0.05) continue;
          let glyph = g.ramp[nearest(g.coverage, v)] ?? ".";
          const edge = edgeRow[x]!;
          if (edge >= 0 && v > 0.12 && v < 0.75) glyph = EDGE_GLYPHS[edge] ?? glyph;
          let brightness = 145 + 99 * Math.pow(v, 0.6);
          const strength = Math.max(0, 1 - (now - marks[r * g.C + x]!) / SETTLE_MS);
          if (strength > 0) {
            const hash = Math.abs(Math.sin((r * g.C + x) * 12.9898 + tick * 78.233) * 43758.5453);
            if (hash % 1 < strength) glyph = CODES[Math.floor(hash * 13) % CODES.length] ?? glyph;
            brightness = Math.min(255, brightness + 35 * strength);
          }
          const b = Math.round(brightness);
          ctx.fillStyle = `rgb(${b},${b},${b})`;
          ctx.fillText(glyph, ox + x * CELL_W, oy + r * CELL_H + 1);
        }
      }
    };

    const frame = (now: number) => {
      raf = 0;
      if (disposed) return;
      draw(now);
      if (visible && !reduceMotion) raf = requestAnimationFrame(frame);
    };
    const kick = () => {
      if (!raf && !disposed && grid) raf = requestAnimationFrame(frame);
    };

    const hit = (e: PointerEvent) => {
      if (!grid || !marks) return;
      const g = grid;
      const rect = canvas.getBoundingClientRect();
      const dpr = canvas.width / Math.max(rect.width, 1);
      const x = ((e.clientX - rect.left) * dpr - offX) / scale;
      const y = ((e.clientY - rect.top) * dpr - offY) / scale;
      const now = performance.now();
      const r0 = Math.max(0, Math.floor((y - RADIUS - oy) / CELL_H));
      const r1 = Math.min(g.R, Math.ceil((y + RADIUS - oy) / CELL_H));
      const c0 = Math.max(0, Math.floor((x - RADIUS - ox) / CELL_W));
      const c1 = Math.min(g.C, Math.ceil((x + RADIUS - ox) / CELL_W));
      for (let r = r0; r < r1; r++)
        for (let c = c0; c < c1; c++)
          if (g.tone[r]![c]! > 0.05 && Math.hypot(ox + c * CELL_W + 4 - x, oy + r * CELL_H + 7 - y) < RADIUS) marks[r * g.C + c] = now;
      kick();
    };

    const ro = new ResizeObserver(() => {
      resize();
      kick();
    });
    const io = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? true;
      if (visible) kick();
    });

    canvas.addEventListener("pointermove", hit);
    canvas.addEventListener("pointerdown", hit);

    Promise.all([loadGrid(), document.fonts?.load(`13px ${FONT}`).catch(() => undefined)])
      .then(([g]) => {
        if (disposed) return;
        grid = g;
        marks = new Float64Array(g.R * g.C).fill(-1e4);
        ox = (g.W - g.C * CELL_W) / 2;
        oy = (g.H - g.R * CELL_H) / 2;
        ro.observe(canvas);
        io.observe(canvas);
        resize();
        kick();
      })
      .catch(() => {
        /* The grid failed to load; the hero simply shows no knight. */
      });

    return () => {
      disposed = true;
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
      canvas.removeEventListener("pointermove", hit);
      canvas.removeEventListener("pointerdown", hit);
    };
  }, []);

  return <canvas ref={canvasRef} className={className} role="img" aria-label="Interactive ASCII Garuda knight" />;
}
