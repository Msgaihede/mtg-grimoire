"""Training views for the printing-evidence networks: the card's **set symbol** and its
**collector band**, two small fixed regions of the straightened card that tell reprints of one
card apart where the whole-card embedder cannot (its looks share the art).

The networks compare; they do not read (`docs/superpowers/specs/2026-10-21-neural-printing-
evidence-design.md` §5): each turns a crop into a unit fingerprint, and a candidate printing
scores by its fingerprint's similarity to that printing's own reference crop, cut at the same
place. So a frame that moves the symbol or the band (borderless, showcase, old frames) moves it on
both sides, and nothing has to find it first.

Classes:
- **band** — one class per printing face (`index.jsonl`'s face id): the band holds the number,
  rarity, set code, language and artist, which differ between any two printings.
- **symbol** — one class per (symbol set, rarity, stamp) (`symbol_class`): the symbol's shape is
  the set's and its colour the rarity's. The symbol set is the collector number's prefix for The
  List (`plst` `"BBD-119"` → `bbd`), whose cards carry their original's symbol, the parent set
  for a promo set that prints the parent's symbol (`pfin` → `fin`), and the set otherwise. The
  stamp is the mark a promo adds inside the box, so a promo and its set twin differ only where
  their crops differ.

Views: a camera frame of the whole card as the embedder's training draws it
(`qd_data.camera_frame`: contexts, glare, blur, JPEG) cut through a detector's corners
(`qd_scene.detector_quad`: jittered, often the plastic's outline) with the region's box;
`CLEAN_P` of them clean reference crops instead. The cut is the scanner's
(`frame::sample_card`): a homography from the card's unit square, 2×2 supersampled. Two things
are drawn wider than the embedder's, to match what the readers' frames showed:
- **card height `CARD_H` = 130–480 px**, from full-size scans: the readers' 960×540 frames show
  the card ~440 px tall, past the embedder's 340;
- **a looser detector** (`slop`): `SLOP_P` of the views move each side of the detector's quad a
  further `SLOP_SIDE` of the card's width or height. Registered against their Scryfall scans,
  the readers' binder quads sat up to ~11 % outside the card a side (and up to ~3 % inside);
  the embedder's binder outlines reach ~5.5 %.

The boxes were fixed in the scanner lab on the readers' scans through `probe --crops` and on the
same printings' Scryfall scans, with slack for the quad error the detector makes and the training
draws; `neural.json`'s `evidence` section holds the same boxes and sizes, and the app cuts its
crops with them.
"""
import hashlib
import json
import os
import random
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np
from torch.utils.data import Dataset

import qd_scene as scene
from looks import scan_ids, scan_layout, scan_path
from qd_data import camera_frame, load

cv2.setNumThreads(1)  # the DataLoader's workers are the parallelism (qd_data.py)

CLEAN_P = 0.12
CARD_H = (130, 480)
SLOP_P = 0.6
SLOP_SIDE = (-0.03, 0.06)


def slop(quad: np.ndarray, rng: random.Random) -> np.ndarray:
    """A detector's corners made looser still, as the readers' binder quads were."""
    if rng.random() >= SLOP_P:
        return quad
    return scene.grow(quad, *(rng.uniform(*SLOP_SIDE) for _ in range(4)))


VIEW = {"card_h": list(CARD_H), "scans": "full-size", "slop_p": SLOP_P, "slop_side": list(SLOP_SIDE), "clean_p": CLEAN_P}


@dataclass(frozen=True)
class Region:
    """A part of the card's unit square (u0, v0, u1, v1) and the crop's size in pixels: what
    `neural.json`'s evidence `CropMeta` holds."""

    kind: str
    box: tuple[float, float, float, float]
    width: int
    height: int

    def meta(self, dim: int) -> dict:
        return {"width": self.width, "height": self.height, "box": list(self.box), "dim": dim}


REGIONS = {
    # The top at 0.40 so the promo-pack planeswalker stamp (card y 0.437–0.515, which the 40
    # readers' quads put as high as 0.405) is wholly inside; 128 px tall keeps ~the same pixels
    # per card unit as the band's.
    "symbol": Region("symbol", (0.72, 0.40, 0.985, 0.66), 96, 128),
    "band": Region("band", (0.0, 0.80, 0.82, 1.0), 256, 88),
}


def cut(img: np.ndarray, quad: np.ndarray, region: Region) -> np.ndarray:
    """`region` of the card at `quad` (TL, TR, BR, BL in image pixels) as uint8 RGB
    height×width, supersampled 2×2 like the scanner's sampler: warp at twice the size, then
    average each 2×2 block."""
    u0, v0, u1, v1 = region.box
    unit = np.float32([[0, 0], [1, 0], [1, 1], [0, 1]])
    to_img = cv2.getPerspectiveTransform(unit, quad.astype(np.float32))
    bw, bh = region.width * 2, region.height * 2
    out_to_unit = cv2.getPerspectiveTransform(
        np.float32([[0, 0], [bw, 0], [bw, bh], [0, bh]]),
        np.float32([[u0, v0], [u1, v0], [u1, v1], [u0, v1]]),
    )
    m = to_img @ out_to_unit  # output pixel -> image pixel, hence WARP_INVERSE_MAP
    big = cv2.warpPerspective(img, m, (bw, bh), flags=cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP, borderMode=cv2.BORDER_REPLICATE)
    return cv2.resize(big, (region.width, region.height), interpolation=cv2.INTER_AREA)


def reference_crop(img: np.ndarray, region: Region) -> np.ndarray:
    """The region cut from a Scryfall scan through the scan's own corners: what a gallery row is
    made of."""
    h, w = img.shape[:2]
    return cut(img, np.float32([[0, 0], [w, 0], [w, h], [0, h]]), region)


def camera_crop(img: np.ndarray, region: Region, rng: random.Random, others: list[np.ndarray] = ()) -> np.ndarray:
    """The region cut from one camera frame of the card `img` (RGB, a full-size Scryfall scan, so
    a card up to 480 px tall is not an upscaled one) through a looser detector's corners."""
    frame, quad = camera_frame(img, rng, others, CARD_H, slop)
    return cut(frame, quad, region)


def printed_set(row: dict) -> str:
    """The set whose symbol a printing shows: The List's cards keep their original's."""
    if row["set"] == "plst" and "-" in (row.get("collector_number") or ""):
        return row["collector_number"].split("-", 1)[0].lower()
    return row["set"]


def symbol_set(row: dict, sets=()) -> str:
    """The set whose symbol the symbol crop shows: a promo set that prints its parent's symbol
    (`set_type` promo, code "p" + the parent's, e.g. `pfin` → `fin`, the parent among `sets`)
    counts as the parent; The List as `printed_set`. The bulk's cards carry no `parent_set_code`
    (that is on Scryfall's set objects), hence the "p" + code rule."""
    s = printed_set(row)
    if row.get("set_type") == "promo" and s.startswith("p") and s[1:] in sets:
        return s[1:]
    return s


def stamp(row: dict) -> str:
    """The mark a printing adds inside the symbol box: "pw" — the promo-pack / stamped
    planeswalker stamp just above the symbol; "date" — a prerelease datestamp from before 2021,
    which sat across the art's lower right near the symbol (from 2021 it moved to the lower
    left, outside the box); "none" otherwise."""
    pt = row.get("promo_types") or []
    if "promopack" in pt or ("stamped" in pt and "datestamped" not in pt):
        return "pw"
    if "datestamped" in pt and (row.get("released_at") or "9999") < "2021-01-01":
        return "date"
    return "none"


def symbol_class(row: dict, sets=()) -> tuple[str, str, str]:
    """A printing face's symbol class: (symbol set, rarity, stamp); `sets` is every set code in
    the dataset, for the promo rule (`symbol_set`)."""
    return symbol_set(row, sets), row["rarity"], stamp(row)


def face_index(face_id: str) -> int:
    return int(face_id[37:]) if len(face_id) > 36 else 0


class Classes:
    """The faces with a scan, and one network's classes over them.

    `members[c]` are the face ids class `c` stands for; `label` maps a face id to its class;
    `info[c]` is what the gallery row needs (`ev_export.py`). `groups` are the eval's
    competitions: per card (oracle id, and face for bands), the classes its printings fall into,
    for cards with at least two — the scanner's question, which printing of this card is it."""

    def __init__(self, root: Path, kind: str, limit: int | None = None, seed: int = 0):
        root = Path(root)
        have = scan_ids(root)
        with open(root / "index.jsonl", encoding="utf-8") as f:
            rows = [r for r in map(json.loads, f) if r["id"] in have]
        if kind == "symbol" and rows and not all("rarity" in r and "promo_types" in r for r in rows):
            raise SystemExit(f"{root / 'index.jsonl'} has rows without `rarity` or `promo_types`, which the symbol "
                             "classes are made of: rewrite it with `scryfall_fetch.py <dataset dir> --index-only`")
        self.root, self.kind, self.layout = root, kind, scan_layout(root)
        self.rows = {r["id"]: r for r in rows}
        sets = {r["set"] for r in rows}
        key = (lambda r: r["id"]) if kind == "band" else (lambda r: symbol_class(r, sets))
        by: dict = defaultdict(list)
        for r in rows:
            by[key(r)].append(r["id"])
        keys = sorted(by, key=str)
        if limit and kind == "band":
            # Whole cards, so a smoke run's subset still holds cards with several printings to
            # tell apart (a random 2 000 of 107 000 faces holds almost none).
            cards: dict = defaultdict(list)
            for k in keys:
                cards[self.rows[k].get("oracle_id") or self.rows[k]["name"]].append(k)
            order = sorted(cards)
            random.Random(seed).shuffle(order)
            keys = []
            for card in order:
                if len(keys) >= limit:
                    break
                keys += cards[card]
            keys.sort(key=str)
        elif limit:
            keys = sorted(random.Random(seed).sample(keys, min(limit, len(keys))), key=str)
        self.keys = keys
        self.members = [by[k] for k in keys]
        self.label = {f: c for c, fs in enumerate(self.members) for f in fs}
        card_of = lambda r: (r.get("oracle_id") or r["name"], face_index(r["id"]) if kind == "band" else 0)  # noqa: E731
        comp: dict = defaultdict(lambda: defaultdict(list))
        for f, c in self.label.items():
            comp[card_of(self.rows[f])][c].append(f)
        # A competition: the classes one card's printings fall into, and that card's faces in each.
        self.groups = [{"classes": sorted(cs), "faces": dict(cs)} for _, cs in sorted(comp.items(), key=str) if len(cs) >= 2]

    def __len__(self):
        return len(self.keys)

    def path(self, face_id: str) -> Path:
        return scan_path(self.root, face_id, self.layout)

    def fingerprint(self) -> str:
        """The classes, in their order: the ArcFace head's rows are these, so a checkpoint resumes
        and an export runs only on the same ones."""
        return hashlib.sha256(json.dumps([self.kind, [list(k) if isinstance(k, tuple) else k for k in self.keys]]).encode()).hexdigest()

    def info(self, c: int) -> dict:
        """A gallery row's fields (`build_gallery.rs`'s entries): a band row covers its printing,
        a symbol row every printing that shows it."""
        fs = self.members[c]
        if self.kind == "band":
            r = self.rows[fs[0]]
            return {"card": 0, "name": f"{r['name']} {r['set']} {r['collector_number']}", "id": r["card_id"],
                    "face": "back" if face_index(r["id"]) else "front", "covers": [r["card_id"]]}
        s, rarity, mark = self.keys[c]
        covers = list(dict.fromkeys(self.rows[f]["card_id"] for f in fs))
        return {"card": 0, "name": f"{s} {rarity}" + ("" if mark == "none" else f" {mark}"), "id": covers[0], "face": "front", "covers": covers}


class _Scans:
    """Where a face's scan is, in a form a DataLoader pickles cheaply into each worker: the
    dataset's folder and its layout, not the index (`Classes.rows` made a Windows worker's start
    take minutes)."""

    def __init__(self, classes: Classes):
        self.root, self.layout = classes.root, classes.layout

    def _path(self, face: str) -> Path:
        return scan_path(self.root, face, self.layout)


class TrainViews(_Scans, Dataset):
    """`repeats` items per class per epoch: a camera crop (or, `CLEAN_P` of the time, a lightly
    touched reference crop) of a random member face, labelled with the class. Clutter comes from
    a pool of half-size scans each worker loads once and turns over slowly (qd_data.TrainViews)."""

    POOL = 48

    def __init__(self, classes: Classes, region: Region, repeats: int = 1, clean_p: float = CLEAN_P):
        super().__init__(classes)
        self.members = classes.members
        self.region, self.repeats, self.clean_p = region, repeats, clean_p
        self._pool, self._pid = [], None

    def __len__(self):
        return len(self.members) * self.repeats

    def _others(self, rng: random.Random) -> list[np.ndarray]:
        if self._pid != os.getpid():
            self._pid, self._pool = os.getpid(), []
        while len(self._pool) < self.POOL:
            self._pool.append(self._clutter(rng))
        if rng.random() < 0.05:
            self._pool[rng.randrange(self.POOL)] = self._clutter(rng)
        return [self._pool[rng.randrange(self.POOL)] for _ in range(4)]

    def _clutter(self, rng: random.Random) -> np.ndarray:
        fs = self.members[rng.randrange(len(self.members))]
        return load(self._path(fs[rng.randrange(len(fs))]), reduced=True)

    def __getitem__(self, i):
        # A fresh seed per view: the workers persist across epochs (qd_data.TrainViews).
        rng = random.Random(int.from_bytes(os.urandom(8), "little"))
        c = i % len(self.members)
        face = rng.choice(self.members[c])
        if rng.random() < self.clean_p:
            view = reference_crop(load(self._path(face)), self.region)
            if rng.random() < 0.5:
                view = cv2.GaussianBlur(view, (0, 0), rng.uniform(0.3, 1.0))
        else:
            view = camera_crop(load(self._path(face)), self.region, rng, self._others(rng))
        return view, c  # uint8 HWC; qd_data.normalize on the GPU


class ReferenceCrops(_Scans, Dataset):
    """Clean reference crops: every member face of `picks` (default every class; at most `cap`
    of each) with its class."""

    def __init__(self, classes: Classes, region: Region, picks: list[int] | None = None, cap: int | None = None):
        super().__init__(classes)
        picks = range(len(classes)) if picks is None else picks
        self.items = [(f, c) for c in picks for f in classes.members[c][:cap]]
        self.region = region

    def __len__(self):
        return len(self.items)

    def __getitem__(self, k):
        face, c = self.items[k]
        return reference_crop(load(self._path(face)), self.region), c
