"""Readers' scans as detector scenes: every frame of a sent scan, with the card's four corners.

    python real_scenes.py build <scan mirror> <dataset dir> <out dir> [--refs <dir>] [--after 20261016]
        [--val-every 4] [--min-inliers 15]
    python real_scenes.py score <out dir> <replay results.json>...

`build` makes the scenes; `score` holds a detector to them — the quad each frame of a replay voted
for, against the corners here (`score`'s doc): how often it was the card, how often what holds the
card, and how far off the corners were.

A sent scan (`infrastructure/scan-worker/README.md`) is a run of camera frames and the printing
its reader says they show — but not where the card is. This finds it: the printing's Scryfall scan
is matched to each frame (SIFT, a ratio test, a RANSAC homography) and the scan's four corners
carried into the frame. On the first scans labelled this way (2026-11-10) a card at rest moved
0.1 % of its width between frames, a tenth of what either shipped detector's corners did. A frame
the match fails on (too few inliers, or a quad no card could make) is left out, never guessed. A
scan sent as *no card in the picture* is kept with no corners — what an empty lens looks like —
frame by frame where the frame shows what the scan's last one does (`like_last`): the last frame is
the one its reader vouched for.

`<scan mirror>` is `pnpm scanner:corpus pull`'s folder (`labels/`, `frames/<id>/NN.jpg`). The
reference scan is the dataset's (`looks.scan_path`), else `<refs>/<printing id>.jpg`.

**The readers' test set stays out**: scans received before `--after` (the 124 up to 2026-10-15)
are what the replay scores a detector on (`docs/reference/card-scanner.md` §10), so none of them is
ever a training scene. Of the rest, every `--val-every`th scan — by a hash of its id, so a scan's
frames never straddle the split — is `val`: held out of training and scored each evaluation.

`<out dir>` is self-contained, so it can be copied to wherever the trainer runs:

    scenes.jsonl             one row a frame: {scan, frame, width, height, quad, split, inliers}
                             quad: [[x, y] × 4] in frame pixels, card order (TL, TR, BR, BL of the
                             card as printed), or null for a frame with no card in it
    frames/<scan>/NN.jpg     the frames, byte for byte

**It holds readers' photographs: never in git, and rebuilt after a deletion request** — `build`
writes the folder anew from the mirror, so a scan removed there (`pnpm scanner:corpus remove`) is
gone from the next build, and from wherever that build is copied over the last.
"""
import argparse
import hashlib
import json
import shutil
from pathlib import Path

import cv2
import numpy as np

from looks import scan_layout, scan_path

# Scans received before this are the readers' test set (the 124 up to 2026-10-15).
TEST_SET_BEFORE = "20261016"
CARD_ASPECT = 63 / 88
# The grey difference, somewhere in the picture, past which a frame of a scan sent as *no card*
# is not taken for its last one (`like_last`).
EMPTY_LIKE_LAST = 60.0


def split_of(scan: str, val_every: int) -> str:
    """`val` for one scan in `val_every`, by its id's hash: stable across builds, and a scan's
    frames (twenty pictures of one card at rest) all fall on one side."""
    if val_every <= 0:
        return "train"
    return "val" if int(hashlib.sha1(scan.encode()).hexdigest(), 16) % val_every == 0 else "train"


def plausible(quad: np.ndarray, width: int, height: int) -> bool:
    """Whether four corners could be a card in a `width`×`height` frame: convex, wound like a card
    seen from its face, its sides in a card's proportion give or take perspective, not a speck and
    not mostly out of frame."""
    q = np.asarray(quad, np.float64)
    if q.shape != (4, 2) or not np.isfinite(q).all():
        return False
    edges = np.roll(q, -1, 0) - q
    cross = edges[:, 0] * np.roll(edges, -1, 0)[:, 1] - edges[:, 1] * np.roll(edges, -1, 0)[:, 0]
    if not (cross > 0).all():  # TL→TR→BR→BL is clockwise on screen (y down); a mirrored match is not a card
        return False
    top, right, bottom, left = (float(np.linalg.norm(e)) for e in edges)
    w, h = (top + bottom) / 2, (left + right) / 2
    if min(w, h) < 24:
        return False
    if not (0.75 < top / bottom < 1.33 and 0.75 < left / right < 1.33):
        return False
    if not (CARD_ASPECT * 0.8 < w / h < CARD_ASPECT * 1.25):
        return False
    c = q.mean(0)
    return 0 <= c[0] < width and 0 <= c[1] < height


class Register:
    """A reference scan matched to frames. SIFT because a card in a frame is a few hundred pixels,
    turned and lit: the descriptors survive both, and RANSAC drops the matches a glare band or a
    neighbouring card's frame lines made."""

    def __init__(self, reference: np.ndarray, min_inliers: int = 15):
        self.sift = cv2.SIFT_create(nfeatures=4000, contrastThreshold=0.02)
        self.matcher = cv2.BFMatcher(cv2.NORM_L2)
        self.min_inliers = min_inliers
        h, w = reference.shape[:2]
        self.corners = np.float32([[0, 0], [w, 0], [w, h], [0, h]]).reshape(-1, 1, 2)
        self.points, self.descriptors = self.sift.detectAndCompute(cv2.cvtColor(reference, cv2.COLOR_BGR2GRAY), None)

    def find(self, frame: np.ndarray) -> tuple[np.ndarray | None, int]:
        """The card's corners in `frame` (BGR) and the inliers that put them there, or (None, n)."""
        if self.descriptors is None or len(self.points) < 8:
            return None, 0
        points, descriptors = self.sift.detectAndCompute(cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY), None)
        if descriptors is None or len(points) < 8:
            return None, 0
        pairs = self.matcher.knnMatch(self.descriptors, descriptors, k=2)
        good = [p[0] for p in pairs if len(p) == 2 and p[0].distance < 0.75 * p[1].distance]
        if len(good) < self.min_inliers:
            return None, len(good)
        src = np.float32([self.points[m.queryIdx].pt for m in good]).reshape(-1, 1, 2)
        dst = np.float32([points[m.trainIdx].pt for m in good]).reshape(-1, 1, 2)
        H, mask = cv2.findHomography(src, dst, cv2.RANSAC, 3.0)
        inliers = int(mask.sum()) if mask is not None else 0
        if H is None or inliers < self.min_inliers:
            return None, inliers
        quad = cv2.perspectiveTransform(self.corners, H).reshape(4, 2)
        h, w = frame.shape[:2]
        return (quad, inliers) if plausible(quad, w, h) else (None, inliers)


def reference_path(data: Path, layout: str, refs: Path | None, printing: str) -> Path | None:
    path = scan_path(data, printing, layout)
    if path.exists():
        return path
    if refs is not None and (refs / f"{printing}.jpg").exists():
        return refs / f"{printing}.jpg"
    return None


def _glance(frame: np.ndarray) -> np.ndarray:
    return cv2.resize(cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY), (64, 36), interpolation=cv2.INTER_AREA).astype(np.float32)


def like_last(frame: np.ndarray, last: np.ndarray) -> bool:
    """Whether a frame of a scan sent as *no card* shows what its last frame shows. The reader
    vouched for the last frame alone (`infrastructure/scan-worker/README.md`: the card is the
    one in the last frame, or none), and a run reaches back two seconds — to a card still being
    lifted away, perhaps. So a frame is taken as empty only where no part of it differs from the
    last by what a card would: the largest mean grey difference over a sixteenth-by-ninth of the
    picture. On the six such scans sent by 2026-11-10 a still frame differs by 2 at most and a
    shadow crossing the mat by 43; a frame of the same desk with a card on it by 100 to 167."""
    diff = np.abs(_glance(frame) - _glance(last))
    return float(cv2.resize(diff, (16, 9), interpolation=cv2.INTER_AREA).max()) < EMPTY_LIKE_LAST


def build(mirror: Path, data: Path, out: Path, refs: Path | None, after: str, val_every: int, min_inliers: int) -> dict:
    layout = scan_layout(data)
    if out.exists():
        # Anew, so a scan removed from the mirror does not linger — but only over a folder this
        # made: the arguments are three folders in a row, and one of them is the dataset.
        if any(out.iterdir()) and not (out / "scenes.jsonl").exists():
            raise SystemExit(f"{out} is not empty and holds no scenes.jsonl: not a folder `build` wrote, so not one it replaces")
        shutil.rmtree(out)
    (out / "frames").mkdir(parents=True)
    rows = []
    report = {"scans": 0, "frames": 0, "labelled": 0, "empty": 0, "unmatched": 0, "unvouched": 0, "no_reference": []}
    for label_path in sorted((mirror / "labels").glob("*.json")):
        label = json.loads(label_path.read_text(encoding="utf-8"))
        scan = label["id"]
        if scan < after:
            continue
        frames = sorted((mirror / "frames" / scan).glob("*.jpg"))
        if not frames:
            continue
        card = label.get("card")
        register = None
        if card is not None:
            ref = reference_path(data, layout, refs, card["id"])
            if ref is None:
                report["no_reference"].append(f"{scan} {card['set']} {card['number']}")
                continue
            register = Register(cv2.imread(str(ref)), min_inliers)
        report["scans"] += 1
        split = split_of(scan, val_every)
        last = cv2.imread(str(frames[-1])) if register is None else None
        for path in frames:
            frame = cv2.imread(str(path))
            if frame is None:
                continue
            report["frames"] += 1
            quad, inliers = (None, 0) if register is None else register.find(frame)
            if register is not None and quad is None:
                report["unmatched"] += 1
                continue
            if register is None and (last is None or frame.shape != last.shape or not like_last(frame, last)):
                report["unvouched"] += 1
                continue
            report["labelled" if quad is not None else "empty"] += 1
            (out / "frames" / scan).mkdir(exist_ok=True)
            shutil.copyfile(path, out / "frames" / scan / path.name)
            rows.append({
                "scan": scan, "frame": f"frames/{scan}/{path.name}", "width": frame.shape[1], "height": frame.shape[0],
                "quad": None if quad is None else [[round(float(x), 2), round(float(y), 2)] for x, y in quad],
                "split": split, "inliers": inliers,
            })
    with open(out / "scenes.jsonl", "w", encoding="utf-8", newline="\n") as f:
        for row in rows:
            f.write(json.dumps(row) + "\n")
    report["val_scans"] = len({r["scan"] for r in rows if r["split"] == "val"})
    report["train_scans"] = len({r["scan"] for r in rows if r["split"] == "train"})
    return report


def load(root: Path, split: str | None = None) -> list[dict]:
    """The rows of `<root>/scenes.jsonl` whose frame is on disk, `quad` as a float32 array."""
    root = Path(root)
    rows = []
    with open(root / "scenes.jsonl", encoding="utf-8") as f:
        for line in f:
            row = json.loads(line)
            if split is not None and row["split"] != split:
                continue
            if not (root / row["frame"]).exists():
                continue
            row["quad"] = None if row["quad"] is None else np.float32(row["quad"])
            rows.append(row)
    return rows


def _quad_area(q: np.ndarray) -> float:
    x, y = q[:, 0], q[:, 1]
    return 0.5 * abs(float(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1))))


def score(root: Path, results: dict, split: str | None = None) -> dict:
    """A replay's quads against the registered corners, frame by frame (`replay`'s results.json,
    whose Neural pass records the card each frame voted for, in the pump's 960 px frame).

    A frame's quad is `found` when its middle is within a quarter of the card's height of the
    card's and it is not much larger than the card; `container` when it is over 1.3× the card's
    area — what holds the card, taken for it; `elsewhere` otherwise; `none` when the frame voted
    for no card. `corner_err` is over the found ones: the mean corner distance as a share of the
    card's height, either way up. `empty_quad` is the share of frames sent as *no card* that
    voted for one all the same — those scans are replayed only through a stand-in label, since
    the replay skips them by name."""
    truth: dict[tuple[str, int], dict] = {}
    for row in load(root, split):
        truth[(row["scan"], int(Path(row["frame"]).stem))] = row
    counts = {"frames": 0, "found": 0, "none": 0, "container": 0, "elsewhere": 0, "empty": 0, "empty_quad": 0}
    errors = []
    for run in results["runs"]:
        frames = next(p for p in run["passes"] if p["name"] == "Neural")["frames"]
        for n, frame in enumerate(frames):
            row = truth.get((run["id"], n))
            if row is None:
                continue
            if row["quad"] is None:
                counts["empty"] += 1
                counts["empty_quad"] += frame["quad"] is not None
                continue
            counts["frames"] += 1
            if frame["quad"] is None:
                counts["none"] += 1
                continue
            long_side = max(row["width"], row["height"])
            got = np.float32(frame["quad"]) * (long_side / 960 if long_side > 960 else 1.0)
            want = row["quad"]
            height = float(np.linalg.norm(want[3] - want[0]) + np.linalg.norm(want[2] - want[1])) / 2
            off = float(np.linalg.norm(got.mean(0) - want.mean(0)))
            if _quad_area(got) > 1.3 * _quad_area(want):
                counts["container"] += 1
            elif off > 0.25 * height:
                counts["elsewhere"] += 1
            else:
                counts["found"] += 1
                err = min(float(np.linalg.norm(got[order] - want, axis=1).mean()) for order in ([0, 1, 2, 3], [2, 3, 0, 1]))
                errors.append(err / height)
    n = max(1, counts["frames"])
    return {
        **counts,
        "found_share": counts["found"] / n, "none_share": counts["none"] / n, "container_share": counts["container"] / n,
        "corner_err": float(np.mean(errors)) if errors else None,
        "corner_err_p90": float(np.percentile(errors, 90)) if errors else None,
        "empty_quad_share": counts["empty_quad"] / counts["empty"] if counts["empty"] else None,
    }


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="what", required=True)
    b = sub.add_parser("build", help="readers' scans as scenes, from the scan mirror")
    b.add_argument("mirror", help="the scan mirror: `pnpm scanner:corpus pull`'s folder")
    b.add_argument("data", help="the Scryfall dataset (scryfall_fetch.py's folder)")
    b.add_argument("out")
    b.add_argument("--refs", help="reference scans the dataset lacks, as <printing id>.jpg")
    b.add_argument("--after", default=TEST_SET_BEFORE, help="leave out scans received before this id prefix: the test set")
    b.add_argument("--val-every", type=int, default=4, help="hold out one scan in this many; 0 for none")
    b.add_argument("--min-inliers", type=int, default=15)
    s = sub.add_parser("score", help="a replay's quads against the scenes' corners")
    s.add_argument("scenes", help="a folder `build` wrote")
    s.add_argument("results", nargs="+", help="`replay`'s results.json, one a detector")
    args = ap.parse_args()
    if args.what == "score":
        for path in args.results:
            results = json.loads(Path(path).read_text(encoding="utf-8"))
            for split in ("train", "val"):
                print(json.dumps({"results": path, "split": split, **score(Path(args.scenes), results, split)}))
        return
    if args.after < TEST_SET_BEFORE:
        raise SystemExit(f"--after {args.after} would train on the readers' test set (scans before {TEST_SET_BEFORE})")
    report = build(Path(args.mirror), Path(args.data), Path(args.out), Path(args.refs) if args.refs else None,
                   args.after, args.val_every, args.min_inliers)
    print(json.dumps(report, indent=1))


if __name__ == "__main__":
    main()
