/**
 * Which dots of /art/landing/hero-knight-dotted.png make up the opening of the helmet (the bowl of streaks and the U at
 * its bottom), worked out from the pixels. Used by HeroFx to light exactly those dots, and by the test script.
 *
 * 1. The artwork is a 5px dot grid; find its phase.
 * 2. The dark dome of the helmet: flood fill over unlit cells from a point inside it, not below the mask line.
 * 3. The opening's area: the dome grown by GROW cells, so dots enclosed between streaks are inside it too.
 * 4. The background beside the helmet (the "wall"): dense lit cells connected, through other dense cells, to the
 *    background outside the opening. Dense clusters inside the bowl are not connected to it, so they stay.
 * 5. A lit cell is part of the opening when it is inside the area, between TOP and BOTTOM, and not wall.
 */
export const PITCH = 5;
export const SEED = { x: 488, y: 200 };   // a point inside the dark dome
export const TOP = 150;                   // above this the dome's sides are the outer helmet, not the opening
export const BOTTOM = 291;                // the mask starts below this
export const GROW = 3;                    // cells
export const DENSE = 0.55;                // share of lit cells around a dot above which it counts as dense
export const OUT = { left: 362, right: 625 }; // columns safely outside the bowl, where the wall flood starts

export interface Grid { px0: number; py0: number; cols: number; rows: number; lit: Uint8Array }
export interface Opening extends Grid { keep: Uint8Array; area: Uint8Array; dark: Uint8Array; wall: Uint8Array }

export function readGrid(d: Uint8ClampedArray, W: number, H: number): Grid {
  const L = (x: number, y: number) => { const o = (y * W + x) * 4; return d[o]! * 0.3 + d[o + 1]! * 0.59 + d[o + 2]! * 0.11; };
  let best = -1, px0 = 0, py0 = 0;
  for (let py = 0; py < PITCH; py++) for (let px = 0; px < PITCH; px++) {
    let sum = 0;
    for (let y = py; y < H; y += PITCH * 4) for (let x = px; x < W; x += PITCH * 4) sum += L(x, y);
    if (sum > best) { best = sum; px0 = px; py0 = py; }
  }
  const cols = Math.ceil((W - px0) / PITCH), rows = Math.ceil((H - py0) / PITCH);
  const lit = new Uint8Array(cols * rows);
  // a cell is lit when the brightest pixel of its 3x3 centre is light: robust to a dot sitting a pixel off the grid
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    const cx = px0 + i * PITCH, cy = py0 + j * PITCH;
    let m = 0;
    for (let b = -1; b <= 1; b++) for (let a = -1; a <= 1; a++) {
      const x = cx + a, y = cy + b;
      if (x >= 0 && y >= 0 && x < W && y < H) m = Math.max(m, L(x, y));
    }
    lit[j * cols + i] = m > 70 ? 1 : 0;
  }
  return { px0, py0, cols, rows, lit };
}

export function findOpening(d: Uint8ClampedArray, W: number, H: number): Opening {
  const gr = readGrid(d, W, H);
  const { px0, py0, cols, rows, lit } = gr;
  const at = (i: number, j: number) => (i >= 0 && j >= 0 && i < cols && j < rows ? lit[j * cols + i]! : 0);
  const dark = new Uint8Array(cols * rows), seen = new Uint8Array(cols * rows);
  const stack: [number, number][] = [[Math.round((SEED.x - px0) / PITCH), Math.round((SEED.y - py0) / PITCH)]];
  while (stack.length) {
    const [i, j] = stack.pop()!;
    if (i < 0 || j < 0 || i >= cols || j >= rows) continue;
    const k = j * cols + i;
    if (seen[k]) continue;
    seen[k] = 1;
    if (lit[k] || py0 + j * PITCH > BOTTOM) continue;
    dark[k] = 1;
    stack.push([i + 1, j], [i - 1, j], [i, j + 1], [i, j - 1]);
  }
  const area = new Uint8Array(cols * rows);
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    let v = 0;
    for (let b = -GROW; b <= GROW && !v; b++) for (let a = -GROW; a <= GROW; a++) {
      if (a * a + b * b > GROW * GROW) continue;
      const ii = i + a, jj = j + b;
      if (ii >= 0 && jj >= 0 && ii < cols && jj < rows && dark[jj * cols + ii]) { v = 1; break; }
    }
    area[j * cols + i] = v;
  }
  const dense = new Uint8Array(cols * rows);
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    const k = j * cols + i;
    if (!lit[k]) continue;
    let n = 0, on = 0;
    for (let b = -2; b <= 2; b++) for (let a = -2; a <= 2; a++) { if (!a && !b) continue; n++; on += at(i + a, j + b); }
    dense[k] = on / n > DENSE ? 1 : 0;
  }
  const wall = new Uint8Array(cols * rows), ws: [number, number][] = [];
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    const x = px0 + i * PITCH;
    if (dense[j * cols + i] && (x < OUT.left || x > OUT.right)) ws.push([i, j]);
  }
  while (ws.length) {
    const [i, j] = ws.pop()!;
    if (i < 0 || j < 0 || i >= cols || j >= rows) continue;
    const k = j * cols + i;
    if (wall[k] || !dense[k]) continue;
    wall[k] = 1;
    for (let b = -1; b <= 1; b++) for (let a = -1; a <= 1; a++) if (a || b) ws.push([i + a, j + b]);
  }
  const keep = new Uint8Array(cols * rows);
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    const k = j * cols + i, y = py0 + j * PITCH;
    if (lit[k] && area[k] && !wall[k] && y >= TOP && y <= BOTTOM) keep[k] = 1;
  }
  return { ...gr, keep, area, dark, wall };
}
