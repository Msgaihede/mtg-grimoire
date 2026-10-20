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
from qd_data import Looks, _background, _light_lut, _shade, load

STRIDE = 8
CORNER_NORM = 64.0
RENDER = 2  # scenes are drawn at twice the input size
LONG, SHORT = 320, 192
DETECT_CONTEXTS = scene.CONTEXTS  # loose, sleeve, binder, toploader
DETECT_WEIGHTS = (0.4, 0.2, 0.3, 0.1)
SKIN = [(224, 172, 140), (198, 134, 99), (160, 105, 72), (110, 72, 50), (236, 196, 170)]


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
    W, H = iw * RENDER, ih * RENDER
    canvas = _desk(rng, H, W, pool)
    occl_k = 0.25
    occl = np.zeros((int(H * occl_k), int(W * occl_k)), np.int16)
    limit = min(H, W / (63 / 88))  # the card height that fills the limiting side
    if refine:
        card_h = limit * rng.uniform(0.6, 0.74)
        cx, cy = W / 2 + rng.uniform(-0.05, 0.05) * W, H / 2 + rng.uniform(-0.05, 0.05) * H
    else:
        card_h = limit * rng.uniform(0.2, 0.9)
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
    # Other cards elsewhere in a whole frame: a spread on the table, a second card in view.
    if not refine and pool:
        for _ in range(rng.choice((0, 0, 1, 1, 2, 3))):
            oh = card_h * rng.uniform(0.6, 1.3)
            q = scene.card_quad(rng, W * rng.uniform(0, 1), H * rng.uniform(0, 1), oh, 0.08,
                                rng.gauss(0, 10) + (180 if rng.random() < 0.15 else 0))
            scene.paste(canvas, pool[rng.randrange(len(pool))], q)
            drawn.append(q)
    context = rng.choices(DETECT_CONTEXTS, weights=DETECT_WEIGHTS)[0]
    if context == "binder":
        drawn = []  # the page covers the table
    _, cards = scene.place(context, canvas, work, quad, rng, pool)
    drawn += cards
    if context != "binder" and rng.random() < 0.35:
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
    ok, enc = cv2.imencode(".jpg", cv2.cvtColor(out, cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, rng.randint(30, 92)])
    out = cv2.cvtColor(cv2.imdecode(enc, cv2.IMREAD_COLOR), cv2.COLOR_BGR2RGB)
    image = cv2.resize(out, (iw, ih), interpolation=cv2.INTER_AREA)

    labelled = []
    for q, (seen, inside) in zip(drawn, _visibility(drawn, occl, occl_k)):
        c = q.mean(0)
        if not (0 <= c[0] < W and 0 <= c[1] < H):
            continue
        label = 1 if seen >= 0.6 and inside >= 0.55 else (0 if seen >= 0.2 else None)
        if label is not None:
            labelled.append((q / RENDER, label))
    return image, labelled


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
