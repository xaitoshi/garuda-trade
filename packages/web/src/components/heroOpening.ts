/**
 * Which dots of /art/landing/hero-knight-dotted.png make up the opening of the helmet (the bowl of streaks and the U at
 * its bottom), worked out from the pixels. Used by HeroFx to light exactly those dots, and by the test script.
 *
 * 1. The artwork is a 5px dot grid; find its phase.
 * 2. The dark dome of the helmet: flood fill over unlit cells from a point inside it, not below the mask line.
 * 3. The opening's area: the dome grown by GROW cells, so dots enclosed between streaks are inside it too.
 * 4. The background beside the helmet (the "wall"): dense lit cells connected, through other dense cells, to the
 *    background outside the opening. Dense clusters inside the bowl are not connected to it, so they stay.
 * 5. The opening: every cell reachable from the dome without crossing the wall, between TOP and BOTTOM, inside SPAN.
 *    Its lit cells are the dots that light up.
 */
export const PITCH = 5;
export const SEED = { x: 488, y: 200 };   // a point inside the dark dome
export const TOP = 150;                   // above this the dome's sides are the outer helmet, not the opening
export const BOTTOM = 291;                // the mask starts below this
export const GROW = 3;                    // cells
export const DENSE = 0.55;                // share of lit cells around a dot above which it counts as dense
export const OUT = { left: 362, right: 650 }; // columns safely outside the bowl, where the wall flood starts
export const SPAN = { left: 382, right: 607 }; // the helmet's width: the opening never reaches past these columns

export interface Grid { px0: number; py0: number; cols: number; rows: number; lit: Uint8Array }
export interface Opening extends Grid { keep: Uint8Array; area: Uint8Array; dark: Uint8Array; wall: Uint8Array }

export function readGrid(d: Uint8ClampedArray, W: number, H: number): Grid {
  const L = (x: number, y: number) => { const o = (y * W + x) * 4; return d[o]! * 0.3 + d[o + 1]! * 0.59 + d[o + 2]! * 0.11; };
  // the grid phase: the offset whose 3x3 neighbourhoods hold the most light lands on the dot centres (a single
  // pixel sample can land on a dot's edge and shift every cell by a pixel)
  const box = (x: number, y: number) => { let t = 0; for (let b = -1; b <= 1; b++) for (let a = -1; a <= 1; a++) { const xx = x + a, yy = y + b; if (xx >= 0 && yy >= 0 && xx < W && yy < H) t += L(xx, yy); } return t; };
  let best = -1, px0 = 0, py0 = 0;
  for (let py = 0; py < PITCH; py++) for (let px = 0; px < PITCH; px++) {
    let sum = 0;
    for (let y = py; y < H; y += PITCH * 3) for (let x = px; x < W; x += PITCH * 3) sum += box(x, y);
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
  // the whole opening: everything reachable from the dome without crossing the wall, inside the band of rows and the
  // helmet's width. This takes in the sparse dots between the streaks and the wall on both sides, not only the rim.
  const inside = new Uint8Array(cols * rows), fs: [number, number][] = [];
  for (let k = 0; k < dark.length; k++) if (dark[k] && py0 + Math.floor(k / cols) * PITCH >= TOP) fs.push([k % cols, Math.floor(k / cols)]);
  while (fs.length) {
    const [i, j] = fs.pop()!;
    if (i < 0 || j < 0 || i >= cols || j >= rows) continue;
    const k = j * cols + i, x = px0 + i * PITCH, y = py0 + j * PITCH;
    if (inside[k] || wall[k] || y < TOP || y > BOTTOM || x < SPAN.left || x > SPAN.right) continue;
    inside[k] = 1;
    fs.push([i + 1, j], [i - 1, j], [i, j + 1], [i, j - 1]);
  }
  const keep = new Uint8Array(cols * rows);
  for (let k = 0; k < keep.length; k++) if (lit[k] && inside[k]) keep[k] = 1;
  return { ...gr, keep, area, dark, wall };
}

/**
 * The pixels to recolour: for every dot of the opening, the whole blob of light pixels that forms that dot (flooded
 * from its brightest pixel), so a dot is covered completely even when it sits a pixel off the grid.
 * Returns an alpha per pixel (0 = untouched): opaque over the dot, soft only on its outermost edge pixels.
 */
export function openingPixels(d: Uint8ClampedArray, W: number, H: number, o: Opening = findOpening(d, W, H)): Uint8Array {
  const L = (x: number, y: number) => { const q = (y * W + x) * 4; return d[q]! * 0.3 + d[q + 1]! * 0.59 + d[q + 2]! * 0.11; };
  const GROUND = 22; // the dark ground between dots
  // the true centre of every lit dot: its brightest pixel near the grid point (dots can sit a pixel off the grid)
  const cx = new Int16Array(o.cols * o.rows), cy = new Int16Array(o.cols * o.rows);
  for (let j = 0; j < o.rows; j++) for (let i = 0; i < o.cols; i++) {
    const k = j * o.cols + i;
    if (!o.lit[k]) continue;
    const gx = o.px0 + i * PITCH, gy = o.py0 + j * PITCH;
    let best = -1;
    for (let b = -2; b <= 2; b++) for (let a = -2; a <= 2; a++) {
      const x = gx + a, y = gy + b;
      if (x >= 0 && y >= 0 && x < W && y < H && L(x, y) > best) { best = L(x, y); cx[k] = x; cy[k] = y; }
    }
  }
  // every light pixel belongs to the nearest dot centre; it is recoloured when that dot is part of the opening.
  // So a dot is covered to its last pixel, and a neighbouring dot outside the opening is never touched.
  const alpha = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const l = L(x, y);
    if (l < GROUND) continue;
    const i0 = Math.round((x - o.px0) / PITCH), j0 = Math.round((y - o.py0) / PITCH);
    let bestD = 1e9, keptD = 1e9;
    for (let b = -1; b <= 1; b++) for (let a = -1; a <= 1; a++) {
      const i = i0 + a, j = j0 + b;
      if (i < 0 || j < 0 || i >= o.cols || j >= o.rows) continue;
      const k = j * o.cols + i;
      if (!o.lit[k]) continue;
      const dd = (x - cx[k]!) ** 2 + (y - cy[k]!) ** 2;
      if (dd < bestD) bestD = dd;
      if (o.keep[k] && dd < keptD) keptD = dd;
    }
    // two grid cells can claim the same physical dot when it sits between grid points: if one of them is part of the
    // opening, the dot is (a tie goes to the opening)
    if (keptD > 9 || keptD > bestD + 1) continue;
    alpha[y * W + x] = Math.max(1, Math.min(255, Math.round(((l - GROUND) / 36) * 255)));
  }
  return alpha;
}
