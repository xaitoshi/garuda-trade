#!/usr/bin/env python3
"""Trim dark margins from the source knight artworks and cover-crop
fills so the dot-matrix dots reach every edge.

Sources (not committed): /workspace/garuda-user-knights/{squire,knight,paladin,ascended}.png

Outputs:
  art/knights/knight-{1-4}.png          1:1 NFT masters
  packages/web/public/art/nft/{1-4}.png
  packages/web/public/art/knights/{1-4}-{active,dormant,victory,wounded}.png
  packages/web/public/art/cards/{1-4}.png   portrait crops for tall challenge / landing cards
  packages/web/public/art/steps/{2,4}.png   landscape crops for landing How-it-works panels
  packages/web/public/art/icons/icon-{1-4}.png
  packages/web/public/art/landing/hero-knight-dotted.png  (Paladin square)
"""
from __future__ import annotations

import shutil
import sys
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SOURCES = {
    1: Path("/workspace/garuda-user-knights/squire.png"),
    2: Path("/workspace/garuda-user-knights/knight.png"),
    3: Path("/workspace/garuda-user-knights/paladin.png"),
    4: Path("/workspace/garuda-user-knights/ascended.png"),
}
# Tall challenge-card / landing-tier boxes are about 0.50 (5-col desktop)
# to 0.69 (1-col mobile). 3:5 sits in the middle so cover only trims a little
# on either side of that range.
CARD_ASPECT = 3 / 5
STEP_ASPECT = 3 / 2
SQUARE_MAX = 1536
CARD_MAX_H = 1800
STEP_MAX_W = 1400
DOT_LUM = 20  # luminance clearly above the near-black canvas


def lum_of(im: Image.Image) -> np.ndarray:
    a = np.asarray(im.convert("RGBA"), dtype=np.float32)
    rgb, alpha = a[:, :, :3], a[:, :, 3]
    lum = 0.2126 * rgb[:, :, 0] + 0.7152 * rgb[:, :, 1] + 0.0722 * rgb[:, :, 2]
    lum[alpha < 10] = 0
    return lum


def background_lum(lum: np.ndarray) -> float:
    dark = lum[lum < 20]
    return float(np.median(dark)) if dark.size else 8.9


def density_span(dens: np.ndarray, frac: float = 0.12, floor: float = 0.06) -> tuple[int, int]:
    thr = max(floor, frac * float(dens.max()))
    idx = np.where(dens >= thr)[0]
    if idx.size == 0:
        return 0, dens.size
    return int(idx[0]), int(idx[-1]) + 1


def trim_dots(im: Image.Image) -> Image.Image:
    """Crop to the dense dot-matrix field, no padding back in."""
    lum = lum_of(im)
    bg = background_lum(lum)
    dots = lum > (bg + 12)
    y0, y1 = density_span(dots.mean(axis=1))
    x0, x1 = density_span(dots.mean(axis=0))
    # Inset a single pixel when the crop still has room, so the new edge
    # is a row that already passed the density test.
    if y1 - y0 > 4:
        y0, y1 = y0 + 1, y1 - 1
    if x1 - x0 > 4:
        x0, x1 = x0 + 1, x1 - 1
    return im.crop((x0, y0, x1, y1))


def center_of_mass(im: Image.Image) -> tuple[float, float]:
    lum = lum_of(im)
    # Weight brighter dots so the figure, not the sparse field, leads.
    w = np.clip(lum - DOT_LUM, 0, None)
    if w.sum() <= 0:
        return im.size[0] / 2, im.size[1] / 2
    ys, xs = np.indices(w.shape)
    return float((xs * w).sum() / w.sum()), float((ys * w).sum() / w.sum())



def edge_fit_crop(im: Image.Image, aspect: float, max_w: int, step: int = 4) -> Image.Image:
    """Cover-sized window of `aspect` (width/height) chosen so every edge has dots."""
    lum = lum_of(im)
    h, w = lum.shape
    if w / h >= aspect:
        wh, ww = h, int(round(h * aspect))
    else:
        ww, wh = w, int(round(w / aspect))
    ww, wh = min(ww, w), min(wh, h)
    dots = lum >= DOT_LUM
    best: tuple[float, int, int] | None = None
    for y in range(0, h - wh + 1, step):
        for x in range(0, w - ww + 1, step):
            win = dots[y:y + wh, x:x + ww]
            score = min(float(win[:2].mean()), float(win[-2:].mean()), float(win[:, :2].mean()), float(win[:, -2:].mean()))
            if best is None or score > best[0]:
                best = (score, x, y)
    assert best is not None
    _, x, y = best
    out = im.crop((x, y, x + ww, y + wh))
    if out.size[0] > max_w:
        nh = max(1, int(round(out.size[1] * max_w / out.size[0])))
        out = out.resize((max_w, nh), Image.Resampling.LANCZOS)
    return out.convert("RGBA")


def cover_crop(im: Image.Image, aspect: float, max_side: int) -> Image.Image:
    """Largest window of `aspect` (width/height) centered on the figure."""
    w, h = im.size
    if w / h > aspect:
        nw, nh = int(round(h * aspect)), h
    else:
        nw, nh = w, int(round(w / aspect))
    nw = max(1, min(nw, w))
    nh = max(1, min(nh, h))
    cx, cy = center_of_mass(im)
    left = int(round(cx - nw / 2))
    top = int(round(cy - nh / 2))
    left = max(0, min(left, w - nw))
    top = max(0, min(top, h - nh))
    out = im.crop((left, top, left + nw, top + nh))
    longest = max(out.size)
    if longest > max_side:
        scale = max_side / longest
        out = out.resize((max(1, int(round(out.size[0] * scale))), max(1, int(round(out.size[1] * scale)))), Image.Resampling.LANCZOS)
    return out.convert("RGBA")


def edge_report(im: Image.Image, border: int = 2) -> dict:
    lum = lum_of(im)
    h, w = lum.shape
    b = min(border, h, w)
    regions = {
        "top": lum[:b, :],
        "bottom": lum[-b:, :],
        "left": lum[:, :b],
        "right": lum[:, -b:],
    }
    out = {}
    for name, r in regions.items():
        dots = r >= DOT_LUM
        out[name] = {
            "dot_pct": float(100 * dots.mean()),
            "max": float(r.max()),
            "ok": bool(dots.mean() >= 0.02 and r.max() >= DOT_LUM),
        }
    return out


def save(im: Image.Image, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    im.save(path, format="PNG", optimize=True)


def main() -> int:
    missing = [p for p in SOURCES.values() if not p.is_file()]
    if missing:
        print("missing sources:", *missing, file=sys.stderr)
        return 1

    failures = []
    for level, src in SOURCES.items():
        raw = Image.open(src).convert("RGBA")
        trimmed = trim_dots(raw)
        square = cover_crop(trimmed, 1.0, SQUARE_MAX)
        card = cover_crop(trimmed, CARD_ASPECT, CARD_MAX_H)
        print(f"L{level} {src.name}: raw={raw.size} trimmed={trimmed.size} square={square.size} card={card.size}")
        for label, im in (("square", square), ("card", card)):
            rep = edge_report(im)
            ok = all(v["ok"] for v in rep.values())
            print("  ", label, "edges", {k: f"{v['dot_pct']:.1f}%" for k, v in rep.items()}, "OK" if ok else "FAIL")
            if not ok:
                failures.append((level, label, rep))

        master = ROOT / "art/knights" / f"knight-{level}.png"
        save(square, master)
        save(square, ROOT / "packages/web/public/art/nft" / f"{level}.png")
        for state in ("active", "dormant", "victory", "wounded"):
            save(square, ROOT / "packages/web/public/art/knights" / f"{level}-{state}.png")
        save(card, ROOT / "packages/web/public/art/cards" / f"{level}.png")
        if level in (2, 4):
            step = edge_fit_crop(trimmed, STEP_ASPECT, STEP_MAX_W)
            save(step, ROOT / "packages/web/public/art/steps" / f"{level}.png")
            srep = edge_report(step)
            sok = all(v["ok"] for v in srep.values())
            print("   step", step.size, {k: f"{v['dot_pct']:.1f}%" for k, v in srep.items()}, "OK" if sok else "FAIL")
            if not sok:
                failures.append((level, "step", srep))
        icon = square.resize((200, 200), Image.Resampling.LANCZOS)
        save(icon, ROOT / "packages/web/public/art/icons" / f"icon-{level}.png")
        if level == 3:
            save(square, ROOT / "packages/web/public/art/landing/hero-knight-dotted.png")

    if failures:
        print("EDGE CHECK FAILED", failures, file=sys.stderr)
        return 2
    print("all edges have dots")
    return 0


if __name__ == "__main__":
    sys.exit(main())
