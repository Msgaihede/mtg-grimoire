"""Scenes for the card detector, with the targets the crate's decoder reads (`detect::decode`).

A scene is what the detector's input sees, at its input size (320×192 landscape or 192×320
portrait): one main card in a context from qd_scene.py (loose among other cards, sleeved, a
binder page of nine, a toploader), sometimes held by fingers, lit and blurred like a webcam. It is
drawn at twice the input size and area-averaged down, as `frame::resize_to_tensor` box-filters a
camera frame. Two kinds, as the scanner runs the network twice (`Detector::detect`):

- **frame**: the whole camera frame, the card anywhere from a fifth to nine tenths of the short
  side, other cards around it;
- **refine**: the second pass's box, 1.45× the first pass's card and shaped to the input, so the
  card fills about 1/1.45 of the limiting side and sits near the middle.

**The label is always the card, never the plastic**: a sleeve's rim, a pocket's welds and a
toploader's margin are drawn around it, so the network learns the card's own edges inside them.
That is what the readers' frames needed (the scanner lab's docs/neural-scanner.md §4.2).

**And never what holds it** (2026-11-10, issue #1526). Readers scan into a deck scanner's well, a
deck box, onto a dark mat, through a phone whose upright picture sits between black bars — and a
detector that had seen none of it took the box, the empty mat and the picture itself for a card,
each being a rectangle of about a card's shape. So a share of the scenes are those: a card at the
bottom of a box (`_well`), a camera feed between bars (`_bars`), a sensor's grain (`_grain`), a
speckled mat (`_mat`), and scenes with **nothing to find** where the main card would lie — an
empty box, a blank sheet, a bare desk — every cell there a negative.

**Readers' own frames are mixed in** (`RealScenes`, real_scenes.py): the frames of sent scans with
the card's corners found by matching its Scryfall scan to them, cut the way the scanner's two
passes cut a frame. Synthetic scenes say what a card is in every light; a reader's frame says what
a camera and a desk are. `Mixed` draws one or the other.

Targets on the stride-8 grid (`[10, h/8, w/8]` maps):
  heat     a Gaussian at each card's centre cell, exactly 1 at the peak (CenterNet focal loss)
  corners  at the peak and its 8 neighbours: the four corners' offsets from that cell's centre,
           in units of CORNER_NORM input pixels, in *raw* order — the card's own order for a card
           between −45° and 135° of upright, half a turn round otherwise (`upside_down`)
  flip     at the same cells: 1 when raw is half a turn round (the decoder turns the raw corners
           half a turn back when the flip probability is over 0.5)
  weight   per cell, 0 round a card too covered or too far out of frame to be a fair positive or
           a fair negative
"""
import math
import os
import random
from pathlib import Path

import cv2
import numpy as np
import torch
from torch.utils.data import Dataset, Sampler

import qd_scene as scene
import real_scenes
from qd_data import Looks, _background, _light_lut, _shade, load

STRIDE = 8
CORNER_NORM = 64.0
RENDER = 2  # scenes are drawn at twice the input size
LONG, SHORT = 320, 192
DETECT_CONTEXTS = scene.CONTEXTS  # loose, sleeve, binder, toploader
DETECT_WEIGHTS = (0.4, 0.2, 0.3, 0.1)
SKIN = [(224, 172, 140), (198, 134, 99), (160, 105, 72), (110, 72, 50), (236, 196, 170)]
# What a reader's camera sees that a card on a desk is not (the module doc): the share of scenes
# with the card in a box, with nothing to find, between a feed's bars, on a speckled mat, and
# with a sensor's grain. The rest are the scenes the first detector was trained on.
WELL_P = 0.16
EMPTY_P = 0.06
BARS_P = 0.14
MAT_P = 0.1
GRAIN_P = 0.3
# A box's plastic or card stock: white and cream most often, as the readers' are.
WELL_COLOURS = [(238, 238, 236), (232, 226, 205), (246, 246, 246), (205, 205, 208), (150, 150, 155),
                (28, 28, 32), (176, 140, 98), (40, 60, 120), (130, 30, 34)]


def _desk(rng: random.Random, H: int, W: int, pool: list[np.ndarray]) -> np.ndarray:
    """What the cards lie on. Never a whole card blown up (qd_data's embedder backgrounds do
    that): an unlabelled card filling the frame would teach the detector to miss big cards."""
    kind = rng.random()
    if kind < 0.3:
        return _background(rng, H, W, [])  # a gradient with noise
    if kind < 0.55 and pool:
        # A playmat: a card's art alone, blown up past the frame and softened.
        card = pool[rng.randrange(len(pool))]
        h, w = card.shape[:2]
        art = card[int(h * 0.12) : int(h * 0.55), int(w * 0.08) : int(w * 0.92)]
        mat = cv2.resize(art, (W, H), interpolation=cv2.INTER_LINEAR)
        mat = cv2.GaussianBlur(mat, (0, 0), rng.uniform(0.5, 3.0))
        return (mat * rng.uniform(0.4, 1.0)).astype(np.uint8)
    base = np.array([rng.uniform(40, 200) for _ in range(3)], np.float32)
    if kind < 0.75:
        # Wood or a laminate: streaks along one direction.
        base = base * np.float32([1.0, 0.75, 0.5]) if rng.random() < 0.7 else base
        small = np.random.default_rng(rng.getrandbits(32)).normal(0, 1, (max(2, H // 24), max(2, W // 2))).astype(np.float32)
        grain = cv2.resize(small, (W, H), interpolation=cv2.INTER_CUBIC)
        if rng.random() < 0.5:
            grain = cv2.resize(cv2.rotate(cv2.resize(small, (H, W), interpolation=cv2.INTER_CUBIC), cv2.ROTATE_90_CLOCKWISE), (W, H))
        img = base[None, None, :] * (1 + 0.18 * grain[..., None])
        return np.clip(img, 0, 255).astype(np.uint8)
    if kind < 0.9:
        # Cloth: a fine weave of noise on one colour.
        noise = np.random.default_rng(rng.getrandbits(32)).normal(0, rng.uniform(4, 16), (H, W, 1)).astype(np.float32)
        img = cv2.GaussianBlur(base[None, None, :] + noise, (0, 0), rng.uniform(0.4, 1.2))
        return np.clip(img, 0, 255).astype(np.uint8)
    # A busy desk: small rectangles of every colour.
    img = _background(rng, H, W, [])
    for _ in range(rng.randint(10, 40)):
        x, y = rng.randrange(W), rng.randrange(H)
        w, h = rng.randint(4, W // 6), rng.randint(4, H // 6)
        cv2.rectangle(img, (x, y), (x + w, y + h), tuple(rng.randint(0, 255) for _ in range(3)), -1)
    return cv2.GaussianBlur(img, (0, 0), rng.uniform(0.5, 2.0))


def _mat(rng: random.Random, H: int, W: int) -> np.ndarray:
    """A dark playmat or desk pad: near black, its weave catching the light as fine speckles."""
    base = np.array([rng.uniform(8, 60)] * 3, np.float32) * np.float32([rng.uniform(0.9, 1.1) for _ in range(3)])
    noise = np.random.default_rng(rng.getrandbits(32)).normal(0, rng.uniform(2, 9), (H, W, 1)).astype(np.float32)
    img = base[None, None, :] + noise
    specks = np.random.default_rng(rng.getrandbits(32)).random((H, W)) < rng.uniform(0.001, 0.012)
    img[specks] += rng.uniform(40, 150)
    return np.clip(cv2.GaussianBlur(img, (0, 0), rng.uniform(0.4, 1.0)), 0, 255).astype(np.uint8)


def _well(canvas: np.ndarray, quad: np.ndarray, rng: random.Random) -> None:
    """A box seen from above, drawn round where a card at `quad` lies on its floor: a deck
    scanner's well, a deck box, a tray. The floor is a little larger than a card and the walls
    open toward the camera, so the box is a rectangle of about a card's shape round the card —
    which is why it is drawn and never labelled."""
    ch = scene.card_height(quad)
    floor = scene.grow(quad, *(rng.uniform(0.02, 0.22) for _ in range(4)))
    depth = rng.uniform(0.12, 0.9)
    rim = scene.grow(floor, *(depth * rng.uniform(0.6, 1.4) for _ in range(4)))
    # The camera is seldom straight above the middle: the opening slides off the floor.
    rim = rim + np.float32([rng.uniform(-0.22, 0.22), rng.uniform(-0.22, 0.22)]) * ch * depth
    colour = np.array(rng.choice(WELL_COLOURS), np.float32) * rng.uniform(0.75, 1.08)

    def shade(k: float) -> tuple[int, ...]:
        return tuple(int(c) for c in np.clip(colour * k, 0, 255))

    if rng.random() < 0.6:  # the wall's own thickness, or a lip, round the opening
        lip = scene.grow(rim, *(rng.uniform(0.02, 0.12) for _ in range(4)))
        cv2.fillConvexPoly(canvas, np.round(lip).astype(np.int32), shade(rng.uniform(0.8, 1.1)), cv2.LINE_AA)
    ribbed = rng.random() < 0.5
    for k in range(4):
        a, b, c, d = rim[k], rim[(k + 1) % 4], floor[(k + 1) % 4], floor[k]
        cv2.fillConvexPoly(canvas, np.round(np.float32([a, b, c, d])).astype(np.int32), shade(rng.uniform(0.5, 1.08)), cv2.LINE_AA)
        if ribbed:  # corrugated plastic: ribs running down each wall
            n = rng.randint(8, 28)
            over = canvas.copy()
            for t in np.linspace(0.03, 0.97, n):
                p, q = a + (b - a) * t, d + (c - d) * t
                cv2.line(over, tuple(np.round(p).astype(int)), tuple(np.round(q).astype(int)), shade(rng.uniform(0.7, 1.15)), 1, cv2.LINE_AA)
            canvas[:] = cv2.addWeighted(canvas, 0.6, over, 0.4, 0)
    cv2.fillConvexPoly(canvas, np.round(floor).astype(np.int32), shade(rng.uniform(0.62, 1.05)), cv2.LINE_AA)
    scene._edges(canvas, rim, rng, ch / 300, rng.uniform(0.2, 0.7))
    if rng.random() < 0.5:
        scene._edges(canvas, floor, rng, ch / 300, rng.uniform(0.1, 0.5))


def _blank(canvas: np.ndarray, quad: np.ndarray, rng: random.Random) -> None:
    """A card-shaped thing that is no card: a sheet of paper, a divider, a box's lid."""
    colour = np.array([rng.uniform(20, 250)] * 3, np.float32) * np.float32([rng.uniform(0.85, 1.1) for _ in range(3)])
    cv2.fillConvexPoly(canvas, np.round(quad).astype(np.int32), tuple(int(c) for c in np.clip(colour, 0, 255)), cv2.LINE_AA)


def _bars(rng: random.Random, W: int, H: int) -> tuple[int, int, int, int]:
    """The picture inside a feed's frame, as (x0, y0, x1, y1): a phone used as a webcam sends its
    upright picture between black bars in a wide frame, and a wide camera in an upright frame is
    barred above and below. What is left is a rectangle of about a card's shape."""
    if W >= H:
        w = int(W * rng.uniform(0.3, 0.75))
        x0 = int((W - w) * rng.uniform(0.3, 0.7))
        return x0, 0, x0 + w, H
    h = int(H * rng.uniform(0.3, 0.75))
    y0 = int((H - h) * rng.uniform(0.3, 0.7))
    return 0, y0, W, y0 + h


def _grain(out: np.ndarray, rng: random.Random) -> np.ndarray:
    """A small sensor in poor light: grain a pixel or two across, in brightness and, weaker, in
    colour. The scenes' plain noise is white and half gone once the scene is shrunk to the input."""
    h, w = out.shape[:2]
    k = rng.uniform(1.0, 3.2) * RENDER / 2
    gen = np.random.default_rng(rng.getrandbits(32))
    sigma = rng.uniform(5, 22)
    small = (max(2, int(w / k)), max(2, int(h / k)))
    luma = cv2.resize(gen.normal(0, sigma, small[::-1]).astype(np.float32), (w, h), interpolation=cv2.INTER_LINEAR)
    chroma = cv2.resize(gen.normal(0, sigma * rng.uniform(0.2, 0.6), (max(2, small[1] // 2), max(2, small[0] // 2), 3)).astype(np.float32),
                        (w, h), interpolation=cv2.INTER_LINEAR)
    return np.clip(out.astype(np.float32) + luma[..., None] + chroma, 0, 255).astype(np.uint8)


def _fingers(canvas: np.ndarray, occl: np.ndarray, quad: np.ndarray, rng: random.Random, k: float) -> None:
    """One to three fingers from the frame's edge onto the card's edge, drawn into the image and
    into the occlusion map (`k` = occlusion map pixels per canvas pixel)."""
    H, W = canvas.shape[:2]
    skin = np.array(rng.choice(SKIN), np.float32) * rng.uniform(0.75, 1.15)
    ch = scene.card_height(quad)
    side = rng.randrange(4)
    for n in range(rng.choice((1, 1, 2, 3))):
        t = rng.uniform(0.15, 0.85)
        a, b = quad[side], quad[(side + 1) % 4]
        tip = a + (b - a) * t + (quad.mean(0) - (a + (b - a) * t)) * rng.uniform(-0.05, 0.2)
        out = tip - quad.mean(0)
        out = out / (np.linalg.norm(out) + 1e-6)
        base = tip + out * max(H, W)
        thick = int(ch * rng.uniform(0.09, 0.16))
        colour = tuple(int(c) for c in np.clip(skin * rng.uniform(0.9, 1.1), 0, 255))
        p, q = tuple(np.round(tip).astype(int)), tuple(np.round(base).astype(int))
        cv2.line(canvas, p, q, colour, thick, cv2.LINE_AA)
        cv2.line(occl, tuple(int(v * k) for v in p), tuple(int(v * k) for v in q), -1, max(1, int(thick * k)))


def _area(q: np.ndarray) -> float:
    """A quad's area (the shoelace formula)."""
    x, y = q[:, 0], q[:, 1]
    return 0.5 * abs(float(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1))))


def _visibility(drawn: list[np.ndarray], occl: np.ndarray, k: float) -> list[tuple[float, float]]:
    """(visible share, in-frame share) per drawn card; `occl` already holds the fingers as -1."""
    h, w = occl.shape
    paint = occl.copy()
    for i, q in enumerate(drawn):
        cv2.fillConvexPoly(paint, np.round(q * k).astype(np.int32), i + 1)
    out = []
    for i, q in enumerate(drawn):
        area = _area(q) * k * k
        alone = np.zeros((h, w), np.uint8)
        cv2.fillConvexPoly(alone, np.round(q * k).astype(np.int32), 1)
        inside = int(alone.sum())
        seen = int(((paint == i + 1) & (alone == 1)).sum())
        out.append((seen / max(1, inside), inside / max(1.0, area)))
    return out


def upside_down(quad: np.ndarray) -> bool:
    """Whether the network should answer this card half a turn round. The decoder can only turn
    by half a turn, so which of a card's two half-turn orders is "raw" must be a function of
    its angle with one break on each side; the breaks sit at −45° and 135° (clockwise from
    upright), where cards rarely lie, so that upright, upside-down and both sideways cards (a
    binder held across the camera, as one reader's was) are each unambiguous. Raw is the
    card's own order from −45° to 135°, and half a turn round otherwise."""
    down = (quad[3] - quad[0]) + (quad[2] - quad[1])
    angle = math.degrees(math.atan2(-down[0], down[1]))  # 0 upright, 90 turned clockwise
    return not (-45 < angle <= 135)


def raw_order(quad: np.ndarray) -> np.ndarray:
    """The corners as the network answers them: card order, or half a turn round."""
    return quad[[2, 3, 0, 1]] if upside_down(quad) else quad


def render(rng: random.Random, iw: int, ih: int, main: np.ndarray, pool: list[np.ndarray], refine: bool):
    """One scene: the uint8 RGB input image and its cards as (quad in input pixels, label),
    label 1 a positive, 0 a card to ignore."""
    full_w, full_h = iw * RENDER, ih * RENDER
    # The picture the scene is drawn in: the whole frame, or what a feed's bars leave of it.
    barred = not refine and rng.random() < BARS_P
    px0, py0, px1, py1 = _bars(rng, full_w, full_h) if barred else (0, 0, full_w, full_h)
    W, H = px1 - px0, py1 - py0
    canvas = _mat(rng, H, W) if rng.random() < MAT_P else _desk(rng, H, W, pool)
    occl_k = 0.25
    occl = np.zeros((int(H * occl_k), int(W * occl_k)), np.int16)
    limit = min(H, W / (63 / 88))  # the card height that fills the limiting side
    if refine:
        card_h = limit * rng.uniform(0.6, 0.74)
        cx, cy = W / 2 + rng.uniform(-0.05, 0.05) * W, H / 2 + rng.uniform(-0.05, 0.05) * H
    else:
        card_h = limit * rng.uniform(0.3 if barred else 0.2, 0.9)
        cx, cy = W * rng.uniform(0.15, 0.85), H * rng.uniform(0.15, 0.85)
    angle = rng.gauss(0, 7) if rng.random() < 0.9 else rng.uniform(-35, 35)
    turn = rng.random()
    if turn < 0.12:
        angle += 180  # upside down
    elif turn < 0.22:
        angle += rng.choice((90, -90))  # sideways: a binder or a hand across the camera
    quad = scene.card_quad(rng, cx, cy, card_h, rng.uniform(0.0, 0.12), angle)
    s = card_h * 1.15 / main.shape[0]
    work = cv2.resize(main, (max(8, int(main.shape[1] * s)), max(8, int(main.shape[0] * s))), interpolation=cv2.INTER_AREA) if s < 0.9 else main
    if rng.random() < 0.3:
        work = scene.glare_band(work, rng)
    drawn: list[np.ndarray] = []
    covers: list[np.ndarray] = []  # drawn over the cards and no card itself: what it hides is hidden
    # Nothing to find where the main card would lie: every cell of the scene a negative there.
    empty = rng.random() < EMPTY_P
    context = "well" if rng.random() < WELL_P else rng.choices(DETECT_CONTEXTS, weights=DETECT_WEIGHTS)[0]
    if context == "well":
        _well(canvas, quad, rng)  # first: whatever else is in the scene lies on it, not under it
    # Other cards elsewhere in a whole frame: a spread on the table, a second card in view.
    if not refine and pool and not (empty and rng.random() < 0.5):
        for _ in range(rng.choice((0, 0, 1, 1, 2, 3))):
            oh = card_h * rng.uniform(0.6, 1.3)
            q = scene.card_quad(rng, W * rng.uniform(0, 1), H * rng.uniform(0, 1), oh, 0.08,
                                rng.gauss(0, 10) + (180 if rng.random() < 0.15 else 0))
            scene.paste(canvas, pool[rng.randrange(len(pool))], q)
            drawn.append(q)
    if context == "well":
        if not empty:
            # The cards already scanned, under the one on top: a pile squares up against the walls.
            for _ in range(rng.choice((0, 0, 1, 2, 3)) if pool else 0):
                q = scene.card_quad(rng, cx + rng.gauss(0, 0.03) * card_h, cy + rng.gauss(0, 0.03) * card_h,
                                    card_h * rng.uniform(0.98, 1.02), 0.02, angle + rng.gauss(0, 3))
                scene.paste(canvas, pool[rng.randrange(len(pool))], q)
                drawn.append(q)
            scene.paste(canvas, work, quad)
            drawn.append(quad)
    elif empty:
        if rng.random() < 0.5:
            _blank(canvas, quad, rng)
            covers.append(quad)
    else:
        if context == "binder":
            drawn = []  # the page covers the table
        _, cards = scene.place(context, canvas, work, quad, rng, pool)
        drawn += cards
    if not empty and context != "binder" and rng.random() < 0.35:
        _fingers(canvas, occl, quad, rng, occl_k)
    if context != "loose" and rng.random() < 0.3:
        canvas = scene.glare_band(canvas, rng, (0.1, 0.45))
    out = cv2.LUT(canvas, _light_lut(rng))
    if rng.random() < 0.4:
        out = (out * _shade(rng, H, W)[..., None]).astype(np.uint8)
    if rng.random() < 0.6:
        if rng.random() < 0.3:
            k = rng.randrange(3, 11)
            kern = np.zeros((k, k), np.float32)
            kern[k // 2, :] = 1 / k
            rot = cv2.getRotationMatrix2D((k / 2 - 0.5, k / 2 - 0.5), rng.uniform(0, 180), 1)
            out = cv2.filter2D(out, -1, cv2.warpAffine(kern, rot, (k, k)))
        else:
            out = cv2.GaussianBlur(out, (0, 0), rng.uniform(0.3, 2.2))
    if rng.random() < 0.7:
        noise = np.empty(out.shape, np.int16)
        cv2.randn(noise, 0, rng.uniform(1, 8))
        out = cv2.add(out, noise, dtype=cv2.CV_8U)
    if rng.random() < GRAIN_P:
        out = _grain(out, rng)
    if barred:
        # The bars are the driver's, not the lens's: black, and added after the camera's light.
        frame = np.zeros((full_h, full_w, 3), np.uint8)
        frame[py0:py1, px0:px1] = out
        out = frame
    ok, enc = cv2.imencode(".jpg", cv2.cvtColor(out, cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, rng.randint(30, 92)])
    out = cv2.cvtColor(cv2.imdecode(enc, cv2.IMREAD_COLOR), cv2.COLOR_BGR2RGB)
    image = cv2.resize(out, (iw, ih), interpolation=cv2.INTER_AREA)

    labelled = []
    offset = np.float32([px0, py0])
    for q, (seen, inside) in zip(drawn, _visibility(drawn + covers, occl, occl_k)):
        c = q.mean(0)
        if not (0 <= c[0] < W and 0 <= c[1] < H):
            continue
        label = 1 if seen >= 0.6 and inside >= 0.55 else (0 if seen >= 0.2 else None)
        if label is not None:
            labelled.append(((q + offset) / RENDER, label))
    return image, labelled


def _turn(frame: np.ndarray, quad: np.ndarray | None, quarter_turns: int) -> tuple[np.ndarray, np.ndarray | None]:
    """The frame turned clockwise by quarter turns, and the quad with it (still in card order)."""
    for _ in range(quarter_turns % 4):
        h = frame.shape[0]
        frame = cv2.rotate(frame, cv2.ROTATE_90_CLOCKWISE)
        if quad is not None:
            quad = np.float32([[h - 1 - y, x] for x, y in quad])
    return frame, quad


def _cut(frame: np.ndarray, rect: tuple[float, float, float, float], iw: int, ih: int) -> np.ndarray:
    """`rect` (x, y, w, h in frame pixels) of the frame as an `iw`×`ih` input, area-averaged; where
    the rect reaches past the frame its edge repeats, as `frame::resize_to_tensor` clamps."""
    H, W = frame.shape[:2]
    x0, y0 = int(math.floor(rect[0])), int(math.floor(rect[1]))
    x1, y1 = int(math.ceil(rect[0] + rect[2])), int(math.ceil(rect[1] + rect[3]))
    left, top, right, bottom = max(0, -x0), max(0, -y0), max(0, x1 - W), max(0, y1 - H)
    if left or top or right or bottom:
        frame = cv2.copyMakeBorder(frame, top, bottom, left, right, cv2.BORDER_REPLICATE)
    crop = frame[y0 + top : y1 + top, x0 + left : x1 + left]
    return cv2.resize(crop, (iw, ih), interpolation=cv2.INTER_AREA if crop.shape[1] >= iw else cv2.INTER_LINEAR)


def _input_box(x0: float, y0: float, x1: float, y1: float, grow: float, iw: int, ih: int) -> tuple[float, float, float, float]:
    """`detect::box_around`: the bounds grown by `grow` and widened to the input's shape."""
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    w, h = (x1 - x0) * grow, (y1 - y0) * grow
    if w / h > iw / ih:
        h = w * ih / iw
    else:
        w = h * iw / ih
    return cx - w / 2, cy - h / 2, w, h


def real_view(rng: random.Random, frame: np.ndarray, quad: np.ndarray | None, iw: int, ih: int,
              others: list[np.ndarray] = (), refine_p: float = 0.35, swap_p: float = 0.35):
    """One input cut from a reader's frame (RGB) the way the scanner's two passes cut it, and its
    card as `render` returns them: [(quad in input pixels, label)], empty for a frame with no card.

    - **Another card in its place** (`swap_p`): a Scryfall scan warped onto the quad, so the
      desk, the box and the light are the reader's and the card is any card.
    - **The input's orientation**: a frame whose long side runs the other way from the input's
      (a wide frame for an upright input, an upright phone's for a wide one) is turned a quarter
      turn — a card across the camera — or cut to a window of the input's way round the card.
    - **Which pass**: the whole frame, sometimes nearer; or (`refine_p`) the second pass's box
      round the card — 1.45× its bounds give or take, and now and then far wider, the box the
      second pass cuts when the first took what holds the card for the card.
    """
    frame = frame.copy()
    if quad is not None and len(others) and rng.random() < swap_p:
        scene.paste(frame, others[rng.randrange(len(others))], quad)
    H, W = frame.shape[:2]
    if (iw < ih) != (W < H):
        # The frame's long side runs the other way from the input's: cut a window off it, as
        # long as the frame is short, round the card — or turn the whole frame a quarter turn.
        axis, long, short = (0, W, H) if W > H else (1, H, W)
        fits = quad is not None and float(np.ptp(quad[:, axis])) < short * 0.5
        if fits and rng.random() < 0.5:
            size = short * rng.uniform(0.56, 0.8)
            lo, hi = float(quad[:, axis].max()) - size, float(quad[:, axis].min())
            at = int(np.clip(rng.uniform(lo, hi), 0, long - size))
            frame = np.ascontiguousarray(frame[:, at : at + int(size)] if axis == 0 else frame[at : at + int(size)])
            quad = quad - np.float32([at, 0] if axis == 0 else [0, at])
        else:
            frame, quad = _turn(frame, quad, rng.choice((1, 3)))
    elif rng.random() < 0.1:
        frame, quad = _turn(frame, quad, 2)
    H, W = frame.shape[:2]
    if rng.random() < refine_p:
        if quad is not None:
            grow = rng.uniform(1.7, 3.2) if rng.random() < 0.25 else 1.45 * math.exp(rng.gauss(0, 0.1))
            x0, y0, x1, y1 = quad[:, 0].min(), quad[:, 1].min(), quad[:, 0].max(), quad[:, 1].max()
            jx, jy = rng.uniform(-0.06, 0.06) * (x1 - x0), rng.uniform(-0.06, 0.06) * (y1 - y0)
            rect = _input_box(x0 + jx, y0 + jy, x1 + jx, y1 + jy, grow, iw, ih)
        else:  # a second look at something that was no card: any part of the frame
            w = W * rng.uniform(0.3, 0.8)
            h = w * ih / iw
            rect = (rng.uniform(0, W - w), rng.uniform(-0.1 * h, max(0.0, H - 0.9 * h)), w, h)
    else:
        zoom = 1.0 if rng.random() < 0.6 else rng.uniform(0.62, 1.0)
        w, h = W * zoom, H * zoom
        if quad is not None:  # keep the card's middle in the picture
            c = quad.mean(0)
            x = rng.uniform(max(0.0, c[0] - 0.85 * w), min(W - w, c[0] - 0.15 * w)) if zoom < 1 else 0.0
            y = rng.uniform(max(0.0, c[1] - 0.85 * h), min(H - h, c[1] - 0.15 * h)) if zoom < 1 else 0.0
        else:
            x, y = rng.uniform(0, W - w), rng.uniform(0, H - h)
        rect = (x, y, w, h)
    image = _cut(frame, rect, iw, ih)
    # A reader's frame has its own light, blur and compression already: only a little more.
    if rng.random() < 0.5:
        lut = _light_lut(rng).astype(np.float32)
        same = np.arange(256, dtype=np.float32)[:, None, None]
        image = cv2.LUT(image, np.clip(same + (lut - same) * rng.uniform(0.2, 0.7), 0, 255).astype(np.uint8))
    if rng.random() < 0.25:
        image = _grain(image, rng)
    if rng.random() < 0.4:
        ok, enc = cv2.imencode(".jpg", cv2.cvtColor(image, cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, rng.randint(40, 92)])
        image = cv2.cvtColor(cv2.imdecode(enc, cv2.IMREAD_COLOR), cv2.COLOR_BGR2RGB)
    if quad is None:
        return image, []
    q = (quad - np.float32(rect[:2])) * np.float32([iw / rect[2], ih / rect[3]])
    view = np.float32([[0, 0], [iw, 0], [iw, ih], [0, ih]])
    inside = cv2.intersectConvexConvex(q.astype(np.float32), view)[0] / max(1e-6, _area(q))
    c = q.mean(0)
    if not (0 <= c[0] < iw and 0 <= c[1] < ih) or inside < 0.2:
        return image, []
    return image, [(q, 1 if inside >= 0.55 else 0)]


def targets(cards, iw: int, ih: int):
    """The maps a scene's cards ask of the network: heat [gh,gw], corners [8,gh,gw], flip
    [gh,gw], cell weight for corners and flip [gh,gw], loss weight for heat [gh,gw]."""
    gh, gw = ih // STRIDE, iw // STRIDE
    heat = np.zeros((gh, gw), np.float32)
    corners = np.zeros((8, gh, gw), np.float32)
    flip = np.zeros((gh, gw), np.float32)
    cw = np.zeros((gh, gw), np.float32)
    hw = np.ones((gh, gw), np.float32)
    yy, xx = np.mgrid[0:gh, 0:gw].astype(np.float32)
    for quad, label in cards:
        c = quad.mean(0) / STRIDE
        px, py = int(c[0]), int(c[1])
        if not (0 <= px < gw and 0 <= py < gh):
            continue
        side = min(np.linalg.norm(quad[1] - quad[0]), np.linalg.norm(quad[3] - quad[0])) / STRIDE
        sigma = max(0.8, side / 7)
        g = np.exp(-((xx - px) ** 2 + (yy - py) ** 2) / (2 * sigma**2))
        if label == 0:
            hw[g > 0.05] = 0.0  # neither a card to find nor background to stay quiet on
            continue
        heat = np.maximum(heat, g)
        heat[py, px] = 1.0
        raw = raw_order(quad)
        up = 1.0 if upside_down(quad) else 0.0
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                x, y = px + dx, py + dy
                if not (0 <= x < gw and 0 <= y < gh):
                    continue
                w = float(g[y, x])
                if w <= cw[y, x]:
                    continue
                cw[y, x] = w
                centre = np.float32([(x + 0.5) * STRIDE, (y + 0.5) * STRIDE])
                corners[:, y, x] = ((raw - centre) / CORNER_NORM).reshape(-1)
                flip[y, x] = up
    return heat, corners, flip, cw, hw


class Scenes(Dataset):
    """Item (i, landscape): a scene and its targets. Random each time (a fresh seed per item),
    unless `fixed`, when item i is always the same scene — the validation set."""

    POOL = 64

    def __init__(self, looks: Looks, refine_p: float = 0.3, fixed: bool = False):
        self.looks, self.refine_p, self.fixed = looks, refine_p, fixed
        self._pool, self._pid = [], None

    def __len__(self):
        return 10**9

    def _card(self, rng: random.Random) -> np.ndarray:
        look = self.looks.looks[rng.randrange(len(self.looks.looks))]
        return load(self.looks.path(rng.choice(look["members"])), reduced=True)

    def _others(self, rng: random.Random) -> list[np.ndarray]:
        if self.fixed:
            return [self._card(rng) for _ in range(6)]
        if self._pid != os.getpid():
            self._pid, self._pool = os.getpid(), []
        while len(self._pool) < self.POOL:
            self._pool.append(self._card(rng))
        if rng.random() < 0.1:
            self._pool[rng.randrange(self.POOL)] = self._card(rng)
        return [self._pool[rng.randrange(self.POOL)] for _ in range(6)]

    def __getitem__(self, item):
        i, landscape = item
        rng = random.Random(1_000_003 * i + 17 if self.fixed else int.from_bytes(os.urandom(8), "little"))
        iw, ih = (LONG, SHORT) if landscape else (SHORT, LONG)
        others = self._others(rng)
        # Which card it is does not matter to a detector, and a fresh decode is a third of a
        # scene's time: the main card comes from the worker's pool most of the time.
        main = others.pop() if not self.fixed and rng.random() < 0.8 else self._card(rng)
        image, cards = render(rng, iw, ih, main, others, rng.random() < self.refine_p)
        heat, corners, flip, cw, hw = targets(cards, iw, ih)
        return (torch.from_numpy(image), torch.from_numpy(heat), torch.from_numpy(corners),
                torch.from_numpy(flip), torch.from_numpy(cw), torch.from_numpy(hw))


class RealScenes(Dataset):
    """Item (i, landscape): a view of a reader's frame (`real_view`) and its targets, from a folder
    real_scenes.py built. Random each time, unless `fixed`, when item i is always the same view of
    the same frame — the readers' validation set, taken a frame at a time with no card swapped in.

    **Only the card and its surroundings are judged in a frame with a card**: a reader's frame
    can hold other cards — a pile's edge, a neighbour, a spread — that nothing labelled, and
    calling them background would teach the network to miss them. So the centre map's loss is
    switched off outside the labelled card (`hw` 0). A frame its reader sent as *no card* is
    background everywhere."""

    def __init__(self, root: Path, scenes: "Scenes | None" = None, split: str | None = "train", fixed: bool = False):
        self.root, self.scenes, self.fixed = Path(root), scenes, fixed
        self.rows = real_scenes.load(self.root, split)
        if not self.rows:
            raise SystemExit(f"{self.root}: no {split or ''} scenes in scenes.jsonl")

    def __len__(self):
        return len(self.rows)

    def __getitem__(self, item):
        i, landscape = item
        rng = random.Random(1_000_003 * i + 29 if self.fixed else int.from_bytes(os.urandom(8), "little"))
        row = self.rows[i % len(self.rows)] if self.fixed else self.rows[rng.randrange(len(self.rows))]
        iw, ih = (LONG, SHORT) if landscape else (SHORT, LONG)
        frame = load(self.root / row["frame"])
        others = [] if self.fixed or self.scenes is None else self.scenes._others(rng)
        image, cards = real_view(rng, frame, row["quad"], iw, ih, others, swap_p=0.0 if self.fixed else 0.35)
        heat, corners, flip, cw, hw = targets(cards, iw, ih)
        if row["quad"] is not None:
            near = np.zeros_like(hw, np.uint8)
            for quad, _ in cards:
                centre = quad.mean(0)
                cv2.fillConvexPoly(near, np.round((centre + (quad - centre) * 1.15) / STRIDE).astype(np.int32), 1)
            hw = hw * near
        return (torch.from_numpy(image), torch.from_numpy(heat), torch.from_numpy(corners),
                torch.from_numpy(flip), torch.from_numpy(cw), torch.from_numpy(hw))


class Mixed(Dataset):
    """Synthetic scenes with readers' frames among them: one item in `1 / share` is a reader's."""

    def __init__(self, scenes: Scenes, real: RealScenes, share: float):
        self.scenes, self.real, self.share = scenes, real, share

    def __len__(self):
        return len(self.scenes)

    def __getitem__(self, item):
        pick = int.from_bytes(os.urandom(4), "little") / 2**32 < self.share
        return (self.real if pick else self.scenes)[item]


class Batches(Sampler):
    """Batches of one orientation each (a batch is one tensor), landscape more often: webcams
    and the readers' desktop frames are landscape."""

    def __init__(self, batches: int, batch: int, landscape_p: float = 0.6, seed: int | None = None):
        self.batches, self.batch, self.landscape_p, self.seed = batches, batch, landscape_p, seed

    def __len__(self):
        return self.batches

    def __iter__(self):
        rng = random.Random(self.seed if self.seed is not None else int.from_bytes(os.urandom(8), "little"))
        for b in range(self.batches):
            landscape = rng.random() < self.landscape_p
            yield [(b * self.batch + k, landscape) for k in range(self.batch)]


def decode(maps: np.ndarray, det_logit: float = -1.0) -> list[tuple[float, np.ndarray, float]]:
    """`detect::decode` in NumPy for the validation: (score, quad in card order, flip) per 3×3
    peak at or over `det_logit`, best first, in input pixels."""
    heat = maps[0]
    gh, gw = heat.shape
    pad = np.pad(heat, 1, constant_values=-np.inf)
    peaks = np.ones_like(heat, bool)
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            if dx or dy:
                peaks &= heat >= pad[1 + dy : 1 + dy + gh, 1 + dx : 1 + dx + gw]
    out = []
    for y, x in zip(*np.nonzero(peaks & (heat >= det_logit))):
        centre = np.float32([(x + 0.5) * STRIDE, (y + 0.5) * STRIDE])
        raw = maps[1:9, y, x].reshape(4, 2) * CORNER_NORM + centre
        f = 1 / (1 + math.exp(-maps[9, y, x]))
        quad = raw[[2, 3, 0, 1]] if f > 0.5 else raw
        out.append((1 / (1 + math.exp(-heat[y, x])), quad, f))
    out.sort(key=lambda d: -d[0])
    return out
