"""Where a card sits when it is scanned, drawn around it: loose on a desk among other cards, in a
sleeve, in a binder pocket between its neighbours, or in a toploader. Shared by the embedder's
camera views (qd_data.py) and the detector's scenes (qd_detect_data.py).

Why (the scanner lab's docs/neural-scanner.md §4.2): on readers' binder pages and sleeves a detector often
outlines the plastic, not the card. 54 of 124 frames had a quad more than 0.05 off a card's
height/width, and an embedder trained only on crops that hug the card missed twice as often on
them. So every context but `loose` returns the plastic's outline: an embedder view can be cut
through it the way a detector would cut it, and a detector can learn to find the card inside it.

Quads are in card order (TL, TR, BR, BL of the card as printed) in canvas pixels.
"""
import math
import random

import cv2
import numpy as np

CONTEXTS = ("loose", "sleeve", "binder", "toploader")


def card_quad(rng: random.Random, cx: float, cy: float, card_h: float, tilt: float, angle: float | None = None) -> np.ndarray:
    """A card's corners around (cx, cy): turned by `angle` degrees (default a few), each corner
    pulled toward or away from the centre by up to `tilt`, a cheap stand-in for perspective."""
    card_w = card_h * 63 / 88
    a = math.radians(rng.gauss(0, 6) if angle is None else angle)
    pts = []
    for ux, uy in ((-0.5, -0.5), (0.5, -0.5), (0.5, 0.5), (-0.5, 0.5)):
        k = 1 + rng.uniform(-tilt, tilt)
        x, y = ux * card_w * k, uy * card_h * k
        pts.append((cx + x * math.cos(a) - y * math.sin(a), cy + x * math.sin(a) + y * math.cos(a)))
    return np.float32(pts)


def grow(quad: np.ndarray, left: float, top: float, right: float, bottom: float) -> np.ndarray:
    """The quad pushed out on each side by a fraction of the card's width (left, right) or
    height (top, bottom), along the card's own edges; negative pulls in."""
    tl, tr, br, bl = quad
    top_e, bottom_e, left_e, right_e = tr - tl, br - bl, bl - tl, br - tr
    return np.float32([
        tl - left * top_e - top * left_e,
        tr + right * top_e - top * right_e,
        br + right * bottom_e + bottom * right_e,
        bl - left * bottom_e + bottom * left_e,
    ])


def card_height(quad: np.ndarray) -> float:
    return float((np.linalg.norm(quad[3] - quad[0]) + np.linalg.norm(quad[2] - quad[1])) / 2)


def paste(canvas: np.ndarray, card: np.ndarray, quad: np.ndarray) -> None:
    """Warp `card` onto `canvas` in place at `quad`, touching only the quad's bounding box;
    pixels outside the card are left alone."""
    H, W = canvas.shape[:2]
    x0, y0 = max(0, int(math.floor(quad[:, 0].min()))), max(0, int(math.floor(quad[:, 1].min())))
    x1, y1 = min(W, int(math.ceil(quad[:, 0].max())) + 1), min(H, int(math.ceil(quad[:, 1].max())) + 1)
    if x1 - x0 < 2 or y1 - y0 < 2:
        return
    target_h = card_height(quad)
    if target_h < card.shape[0] * 0.8:  # warpPerspective has no area filter: shrink first
        s = target_h * 1.15 / card.shape[0]
        card = cv2.resize(card, (max(8, int(card.shape[1] * s)), max(8, int(card.shape[0] * s))), interpolation=cv2.INTER_AREA)
    h, w = card.shape[:2]
    m = cv2.getPerspectiveTransform(np.float32([[0, 0], [w, 0], [w, h], [0, h]]), (quad - np.float32([x0, y0])).astype(np.float32))
    roi = np.ascontiguousarray(canvas[y0:y1, x0:x1])
    cv2.warpPerspective(card, m, (x1 - x0, y1 - y0), dst=roi, flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_TRANSPARENT)
    canvas[y0:y1, x0:x1] = roi


def _haze(canvas: np.ndarray, poly: np.ndarray | None, alpha: float, colour=(255, 255, 255)) -> None:
    """Plastic's milky film: blend toward `colour` inside `poly` (everywhere when None)."""
    if poly is None:
        canvas[:] = cv2.addWeighted(canvas, 1 - alpha, np.full_like(canvas, colour), alpha, 0)
        return
    mask = np.zeros(canvas.shape[:2], np.uint8)
    cv2.fillConvexPoly(mask, np.round(poly).astype(np.int32), 1)
    blend = cv2.addWeighted(canvas, 1 - alpha, np.full_like(canvas, colour), alpha, 0)
    np.copyto(canvas, blend, where=mask[..., None].astype(bool))


def _edges(canvas: np.ndarray, poly: np.ndarray, rng: random.Random, scale: float, alpha: float) -> None:
    """Plastic's edges catching the light: thin bright lines along `poly`."""
    over = canvas.copy()
    thick = max(1, int(round(rng.uniform(0.6, 2.0) * scale)))
    shade = int(rng.uniform(170, 255))
    cv2.polylines(over, [np.round(poly).astype(np.int32)], True, (shade, shade, shade), thick, cv2.LINE_AA)
    canvas[:] = cv2.addWeighted(canvas, 1 - alpha, over, alpha, 0)


def glare_band(canvas: np.ndarray, rng: random.Random, strength: tuple[float, float] = (0.25, 0.75)) -> np.ndarray:
    """A soft diagonal band of reflected light across the whole image."""
    h, w = canvas.shape[:2]
    over = np.zeros((h, w), np.float32)
    x0 = rng.uniform(-0.3, 1.0) * w
    cv2.fillConvexPoly(over, np.int32([[x0, 0], [x0 + w * 0.18, 0], [x0 + w * 0.45, h], [x0 + w * 0.27, h]]), 1.0)
    a = cv2.GaussianBlur(over, (0, 0), max(1.0, w / 25))[..., None] * rng.uniform(*strength)
    return (canvas * (1 - a) + 255 * a).astype(np.uint8)


SLEEVE_COLOURS = [(15, 15, 18), (20, 30, 90), (120, 20, 25), (20, 80, 35), (70, 25, 90), (225, 225, 225), (90, 90, 95)]
PAGE_COLOURS = [(12, 12, 14), (20, 20, 24), (28, 30, 45), (60, 60, 64), (210, 210, 205)]


def place(context: str, canvas: np.ndarray, card: np.ndarray, quad: np.ndarray, rng: random.Random,
          others: list[np.ndarray] = ()) -> tuple[np.ndarray | None, list[np.ndarray]]:
    """Draw `card` at `quad` in `context`. Returns the plastic's outline (None when loose) and
    every card drawn, in paint order, the main card included (a later card covers an earlier)."""
    scale = card_height(quad) / 300
    drawn: list[np.ndarray] = []
    others = list(others)
    if context == "binder":
        page = np.array(rng.choice(PAGE_COLOURS), np.float32) * rng.uniform(0.8, 1.2)
        canvas[:] = np.clip(page, 0, 255).astype(np.uint8)
        noise = np.empty(canvas.shape, np.int16)
        cv2.randn(noise, 0, rng.uniform(1, 6))
        canvas[:] = cv2.add(canvas, noise, dtype=cv2.CV_8U)
        # Nine pockets on a grid along the card's own axes; the gap between cards is the
        # pocket's margin twice plus the weld.
        px, py = 1 + rng.uniform(0.04, 0.11), 1 + rng.uniform(0.03, 0.08)
        across, down = quad[1] - quad[0], quad[3] - quad[0]
        pockets = []
        for j in (-1, 0, 1):
            for i in (-1, 0, 1):
                q = quad + i * px * across + j * py * down
                if (i, j) != (0, 0):
                    q = q + np.float32([rng.gauss(0, 0.012), rng.gauss(0, 0.008)]) * card_height(quad)
                    if others and rng.random() < 0.9:
                        paste(canvas, others[rng.randrange(len(others))], q)
                        drawn.append(q)
                pockets.append(grow(q, (px - 1) / 2, (py - 1) / 2, (px - 1) / 2, (py - 1) / 2))
        paste(canvas, card, quad)
        drawn.append(quad)
        for p in pockets:
            _edges(canvas, p, rng, scale, rng.uniform(0.1, 0.45))
        _haze(canvas, None, rng.uniform(0.02, 0.12))
        # The card sits loose in its pocket, off centre: the plastic a detector sees reaches a
        # different distance past each edge.
        mx, my = (px - 1) / 2, (py - 1) / 2
        outer = grow(quad, rng.uniform(0.3, 1.0) * mx, rng.uniform(0.3, 1.0) * my, rng.uniform(0.3, 1.0) * mx, rng.uniform(0.3, 1.0) * my)
        return outer, drawn
    if context == "loose" or context not in CONTEXTS:
        # Cards under it: a stack, a spread, a hand.
        ch = card_height(quad)
        centre = quad.mean(0)
        for _ in range(rng.choice((0, 0, 1, 1, 2))):
            if not others:
                break
            dx, dy = rng.choice((-1, 1)) * rng.uniform(0.35, 0.9) * ch * 0.72, rng.uniform(-0.6, 0.6) * ch
            q = card_quad(rng, centre[0] + dx, centre[1] + dy, ch * rng.uniform(0.9, 1.1), 0.05)
            paste(canvas, others[rng.randrange(len(others))], q)
            drawn.append(q)
        paste(canvas, card, quad)
        drawn.append(quad)
        return None, drawn
    if context == "sleeve":
        outer = grow(quad, rng.uniform(0.015, 0.045), rng.uniform(0.01, 0.06), rng.uniform(0.015, 0.045), rng.uniform(0.012, 0.04))
        if rng.random() < 0.45:  # an opaque-backed sleeve: a coloured rim round the card
            rim = canvas.copy()
            cv2.fillConvexPoly(rim, np.round(outer).astype(np.int32), rng.choice(SLEEVE_COLOURS), cv2.LINE_AA)
            canvas[:] = cv2.addWeighted(canvas, 0.1, rim, 0.9, 0)
        paste(canvas, card, quad)
        drawn.append(quad)
        _haze(canvas, outer, rng.uniform(0.02, 0.14))
        _edges(canvas, outer, rng, scale, rng.uniform(0.15, 0.6))
        return outer, drawn
    # Toploader: rigid and clear, a wide margin and a deeper one at the open top.
    outer = grow(quad, rng.uniform(0.04, 0.09), rng.uniform(0.06, 0.14), rng.uniform(0.04, 0.09), rng.uniform(0.03, 0.07))
    paste(canvas, card, quad)
    drawn.append(quad)
    _haze(canvas, outer, rng.uniform(0.04, 0.18))
    _edges(canvas, outer, rng, scale, rng.uniform(0.3, 0.8))
    if rng.random() < 0.5:
        _edges(canvas, grow(outer, -0.01, -0.01, -0.01, -0.01), rng, scale, rng.uniform(0.1, 0.4))
    return outer, drawn


def detector_quad(quad: np.ndarray, outer: np.ndarray | None, rng: random.Random) -> np.ndarray:
    """Where a detector might put the corners of the card at `quad`: on the plastic's outline
    more often than not when there is plastic, sometimes a little off either way when there is
    not, and always a few pixels astray."""
    if outer is not None and rng.random() < 0.6:
        base = outer
    elif rng.random() < 0.3:
        base = grow(quad, *(rng.uniform(-0.02, 0.06) for _ in range(4)))
    else:
        base = quad
    miss = card_height(quad) * rng.uniform(0.0, 0.02)
    return base + np.float32([[rng.gauss(0, miss), rng.gauss(0, miss)] for _ in range(4)])
