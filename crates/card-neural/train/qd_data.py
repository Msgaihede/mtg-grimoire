"""Training views for a Quickdraw-shaped embedder: the card's top 72 % at 128×128, as the scanner
cuts it from a camera frame (`frame::sample_card`), from clean Scryfall scans.

Reference view: the scan's own corners, cut and supersampled exactly as the scanner will.
Query view: the card put through a camera first — placed in a context (qd_scene.py: loose among
other cards, sleeved, in a binder pocket between neighbours, in a toploader), tilted in
perspective, lit (exposure, gamma, white balance, a vignette or a shadow), sometimes with a glare
band or a foil's sheen, blurred, noisy, shrunk to a webcam's resolution and JPEG-compressed —
then cut back out through the corners a detector would give: often the plastic's outline, 5–10 %
outside the card on some sides, and never exactly the card's. (The first run cut through corners
at most 2.5 % off the card and missed twice as often on readers' quads that outlined plastic.)

Pure NumPy + OpenCV, and cheap where it can be (lookup tables for light, warps straight onto the
canvas, effects at the card's camera size, clutter from a per-worker pool): measured 61 ms a view
before that, which made an epoch of 70k looks 13 minutes on 20 workers.
"""
import json
import os
import random
from pathlib import Path

import cv2
import numpy as np
import torch
from torch.utils.data import Dataset

import qd_scene as scene
from looks import scan_layout, scan_path

# One OpenCV thread per process: the DataLoader's workers are the parallelism. OpenCV's default
# pool is as wide as the machine, so 20 workers made 20 × 24 threads fight over 24 cores — 270
# views/s at 100 % CPU, ~74 ms a view against ~10 ms measured alone (2026-10-19).
cv2.setNumThreads(1)

CROP_BOX = (0.03, 0.02, 0.97, 0.72)  # Quickdraw's `box`: the part of the card the embedder reads
SIZE = 128
CONTEXT_WEIGHTS = (0.35, 0.25, 0.3, 0.1)  # qd_scene.CONTEXTS: loose, sleeve, binder, toploader
MEAN = np.array([0.485, 0.456, 0.406], np.float32)
STD = np.array([0.229, 0.224, 0.225], np.float32)


def load(path: Path, reduced: bool = False) -> np.ndarray:
    """A scan as RGB; `reduced` decodes at half size (244×340), several times faster."""
    img = cv2.imread(str(path), cv2.IMREAD_REDUCED_COLOR_2 if reduced else cv2.IMREAD_COLOR)
    if img is None:
        raise FileNotFoundError(path)
    return cv2.cvtColor(img, cv2.COLOR_BGR2RGB)


def crop_from_quad(img: np.ndarray, quad: np.ndarray, size: int = SIZE) -> np.ndarray:
    """The crop box of the card at `quad` (TL, TR, BR, BL in image pixels), `size`×`size`,
    2×2 supersampled like the scanner's sampler: warp at twice the size, then area-average."""
    u0, v0, u1, v1 = CROP_BOX
    unit = np.float32([[0, 0], [1, 0], [1, 1], [0, 1]])
    to_img = cv2.getPerspectiveTransform(unit, quad.astype(np.float32))
    big = size * 2
    out_to_unit = cv2.getPerspectiveTransform(
        np.float32([[0, 0], [big, 0], [big, big], [0, big]]),
        np.float32([[u0, v0], [u1, v0], [u1, v1], [u0, v1]]),
    )
    m = to_img @ out_to_unit  # output pixel -> image pixel, hence WARP_INVERSE_MAP
    warped = cv2.warpPerspective(img, m, (big, big), flags=cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP, borderMode=cv2.BORDER_REPLICATE)
    return cv2.resize(warped, (size, size), interpolation=cv2.INTER_AREA)


def reference_view(img: np.ndarray) -> np.ndarray:
    h, w = img.shape[:2]
    return crop_from_quad(img, np.float32([[0, 0], [w, 0], [w, h], [0, h]]))


def to_tensor(rgb: np.ndarray) -> torch.Tensor:
    x = (rgb.astype(np.float32) / 255.0 - MEAN) / STD
    return torch.from_numpy(x.transpose(2, 0, 1).copy())


_MEAN_T = torch.tensor(MEAN).view(1, 3, 1, 1)
_STD_T = torch.tensor(STD).view(1, 3, 1, 1)


def normalize(batch: torch.Tensor) -> torch.Tensor:
    """A collated batch of uint8 HWC views (as the datasets hand them over: a quarter of the
    bytes a float batch would push through the workers' shared memory) as the network's
    normalised float NCHW, on whatever device the batch is on."""
    x = batch.permute(0, 3, 1, 2).float().div_(255)
    return (x - _MEAN_T.to(x.device)) / _STD_T.to(x.device)


def _background(rng: random.Random, h: int, w: int, others: list[np.ndarray]) -> np.ndarray:
    kind = rng.random()
    if kind < 0.35 or not others:
        top = np.array([rng.randint(0, 255) for _ in range(3)], np.float32)
        bottom = np.clip(top + rng.uniform(-50, 50), 0, 255)
        small = np.linspace(top, bottom, 8, dtype=np.float32)[:, None, :].repeat(2, 1)
        bg = cv2.resize(small, (w, h), interpolation=cv2.INTER_LINEAR).astype(np.uint8)
        noise = np.empty((h, w, 3), np.int16)
        cv2.randn(noise, 0, rng.uniform(2, 12))
        return cv2.add(bg, noise, dtype=cv2.CV_8U)
    # Another card blown up (a playmat with art), or a desk of other cards.
    bg = cv2.resize(others[rng.randrange(len(others))], (w, h), interpolation=cv2.INTER_LINEAR)
    return cv2.GaussianBlur(bg, (0, 0), rng.uniform(0.5, 4)) if kind < 0.6 else bg


def _light_lut(rng: random.Random) -> np.ndarray:
    """Exposure, offset, gamma and white balance as one 256-entry table per channel."""
    x = np.arange(256, dtype=np.float32)
    x = x * rng.uniform(0.55, 1.35) + rng.uniform(-25, 25)
    x = 255 * np.clip(x / 255, 0, 1) ** rng.uniform(0.75, 1.35)
    lut = np.stack([np.clip(x * rng.uniform(0.82, 1.18), 0, 255) for _ in range(3)], -1)
    return lut.astype(np.uint8)[:, None, :]  # (256, 1, 3) for cv2.LUT on a 3-channel image


def _shade(rng: random.Random, h: int, w: int) -> np.ndarray:
    """A vignette or a cast shadow, as a per-pixel gain built small and scaled up."""
    yy, xx = np.mgrid[0:16, 0:16].astype(np.float32) / 15
    if rng.random() < 0.5:
        r = np.sqrt((xx - rng.random()) ** 2 + (yy - rng.random()) ** 2)
        gain = 1 - rng.uniform(0.2, 0.5) * np.clip(r, 0, 1)
    else:
        side = (xx - 0.5) * rng.uniform(-1, 1) + (yy - 0.5) * rng.uniform(-1, 1)
        gain = 1 - rng.uniform(0.2, 0.55) * (side > rng.uniform(-0.2, 0.3))
        gain = cv2.GaussianBlur(gain.astype(np.float32), (0, 0), 1.0)
    return cv2.resize(gain.astype(np.float32), (w, h), interpolation=cv2.INTER_LINEAR)


def camera_view(img: np.ndarray, rng: random.Random, others: list[np.ndarray] = ()) -> np.ndarray:
    """One degraded query view of the card `img` (RGB, a Scryfall scan at any size)."""
    # Card height in camera pixels: a 540–1080 p frame, near to far; at most the half-size scan's
    # own 340, so a query is never an upscaled scan.
    card_h = rng.uniform(130, 340)
    pad = rng.uniform(0.4, 0.9)
    H, W = int(card_h * (1 + pad)), int(card_h * 63 / 88 * (1 + pad * 1.6))
    canvas = _background(rng, H, W, list(others))
    cx, cy = W / 2 + rng.uniform(-0.1, 0.1) * W, H / 2 + rng.uniform(-0.06, 0.06) * H
    # The card itself, at its camera size, with a sleeve's glare or a foil's sheen.
    s = card_h * 1.15 / img.shape[0]
    work = cv2.resize(img, (max(8, int(img.shape[1] * s)), max(8, int(img.shape[0] * s))), interpolation=cv2.INTER_AREA) if s < 0.9 else img.copy()
    h, w = work.shape[:2]
    if rng.random() < 0.35:
        work = scene.glare_band(work, rng)
    if rng.random() < 0.15:
        hue = ((np.linspace(0, 180, w)[None, :] + np.linspace(0, 90, h)[:, None] + rng.uniform(0, 180)) % 180).astype(np.uint8)
        hsv = np.dstack([hue, np.full_like(hue, 160), np.full_like(hue, 255)])
        work = cv2.addWeighted(work, 1 - (a := rng.uniform(0.08, 0.25)), cv2.cvtColor(hsv, cv2.COLOR_HSV2RGB), a, 0)
    quad = scene.card_quad(rng, cx, cy, card_h, rng.uniform(0.0, 0.10))
    # Loose on a desk among other cards, sleeved, in a binder pocket, or in a toploader.
    context = rng.choices(scene.CONTEXTS, weights=CONTEXT_WEIGHTS)[0]
    outer, _ = scene.place(context, canvas, work, quad, rng, others)
    if context != "loose" and rng.random() < 0.3:  # the plastic's own shine, over everything
        canvas = scene.glare_band(canvas, rng, (0.1, 0.45))
    # Light, then the lens and the sensor.
    out = cv2.LUT(canvas, _light_lut(rng))
    if rng.random() < 0.4:
        out = (out * _shade(rng, H, W)[..., None]).astype(np.uint8)
    if rng.random() < 0.6:
        if rng.random() < 0.3:
            k = rng.randrange(3, 9)
            kern = np.zeros((k, k), np.float32)
            kern[k // 2, :] = 1 / k
            rot = cv2.getRotationMatrix2D((k / 2 - 0.5, k / 2 - 0.5), rng.uniform(0, 180), 1)
            out = cv2.filter2D(out, -1, cv2.warpAffine(kern, rot, (k, k)))
        else:
            out = cv2.GaussianBlur(out, (0, 0), rng.uniform(0.3, 1.6))
    if rng.random() < 0.5:
        f = rng.uniform(0.45, 0.9)
        small = cv2.resize(out, (max(8, int(W * f)), max(8, int(H * f))), interpolation=cv2.INTER_AREA)
        out = cv2.resize(small, (W, H), interpolation=cv2.INTER_LINEAR)
    noise = np.empty(out.shape, np.int16)
    cv2.randn(noise, 0, rng.uniform(0, 7))
    out = cv2.add(out, noise, dtype=cv2.CV_8U)
    # JPEG in its own channel order, so its chroma subsampling falls on the real chroma.
    ok, enc = cv2.imencode(".jpg", cv2.cvtColor(out, cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, rng.randint(35, 92)])
    out = cv2.cvtColor(cv2.imdecode(enc, cv2.IMREAD_COLOR), cv2.COLOR_BGR2RGB)
    # Cut through the corners a detector would give: often the plastic's, never exactly the card's.
    return crop_from_quad(out, scene.detector_quad(quad, outer, rng))


class Looks:
    """looks.json plus where each face's scan is: `normal/<2>/<id>.jpg`, or `normal/<id>.jpg` in
    a dataset fetched before the shards (looks.scan_path)."""

    def __init__(self, root: Path):
        self.root = Path(root)
        data = json.loads((self.root / "looks.json").read_text(encoding="utf-8"))
        self.looks = data["looks"]
        self.layout = scan_layout(self.root)

    def path(self, face_id: str) -> Path:
        return scan_path(self.root, face_id, self.layout)


class TrainViews(Dataset):
    """One item per look per epoch: a query view (or, now and then, a lightly touched reference)
    of a random member printing, labelled with the look's index. Clutter comes from a pool of
    half-size scans each worker loads once and refreshes a little every view."""

    POOL = 48

    def __init__(self, looks: Looks, clean_p: float = 0.12):
        self.looks, self.clean_p = looks, clean_p
        self._pool, self._pid = [], None

    def __len__(self):
        return len(self.looks.looks)

    def _others(self, rng: random.Random) -> list[np.ndarray]:
        if self._pid != os.getpid():
            self._pid, self._pool = os.getpid(), []
        while len(self._pool) < self.POOL:
            self._pool.append(self._clutter(rng))
        if rng.random() < 0.05:  # turn the pool over slowly
            self._pool[rng.randrange(self.POOL)] = self._clutter(rng)
        return [self._pool[rng.randrange(self.POOL)] for _ in range(4)]  # a binder's neighbours

    def _clutter(self, rng: random.Random) -> np.ndarray:
        o = self.looks.looks[rng.randrange(len(self.looks.looks))]
        return load(self.looks.path(o["rep"]), reduced=True)

    def __getitem__(self, i):
        # A fresh seed per view: the workers persist across epochs, so a seed built from the
        # index alone would show every look the same view every epoch.
        rng = random.Random(int.from_bytes(os.urandom(8), "little"))
        look = self.looks.looks[i]
        face = rng.choice(look["members"])
        if rng.random() < self.clean_p:
            view = reference_view(load(self.looks.path(face)))
            if rng.random() < 0.5:
                view = cv2.GaussianBlur(view, (0, 0), rng.uniform(0.3, 1.0))
        else:
            view = camera_view(load(self.looks.path(face), reduced=True), rng, self._others(rng))
        return view, i  # uint8 HWC; `normalize` on the GPU


class ReferenceViews(Dataset):
    """Clean reference views for the gallery: every face's (tensor, look index), or with
    `reps_only` one per look (its `rep`)."""

    def __init__(self, looks: Looks, reps_only: bool = False):
        if reps_only:
            self.items = [(l["rep"], i) for i, l in enumerate(looks.looks)]
        else:
            self.items = [(f, i) for i, l in enumerate(looks.looks) for f in l["members"]]
        self.looks = looks

    def __len__(self):
        return len(self.items)

    def __getitem__(self, k):
        face, i = self.items[k]
        return reference_view(load(self.looks.path(face))), i  # uint8 HWC; `normalize` on the GPU
