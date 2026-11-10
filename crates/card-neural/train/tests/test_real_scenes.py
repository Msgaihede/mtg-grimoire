"""real_scenes.py: readers' scans as detector scenes — the card found by matching its Scryfall scan
to a frame, what is kept out, and how the scans are split.

    python -m unittest discover -s crates/card-neural/train/tests -p "test_real_scenes.py"

No reader's photograph is in git: the frames here are drawn.
"""
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import real_scenes  # noqa: E402

PRINTING = "ab000000-0000-4000-8000-000000000001"


def reference(seed: int = 3) -> np.ndarray:
    """A card-sized picture with enough corners to match on: blocks and discs of every colour."""
    rng = np.random.default_rng(seed)
    img = np.full((680, 488, 3), 40, np.uint8)
    for _ in range(140):
        x, y = int(rng.integers(10, 470)), int(rng.integers(10, 660))
        colour = tuple(int(c) for c in rng.integers(0, 255, 3))
        if rng.random() < 0.5:
            cv2.rectangle(img, (x, y), (x + int(rng.integers(8, 60)), y + int(rng.integers(8, 60))), colour, -1)
        else:
            cv2.circle(img, (x, y), int(rng.integers(5, 30)), colour, -1)
    return img


def frame_with(ref: np.ndarray, quad: np.ndarray, size=(1280, 720)) -> np.ndarray:
    """A desk with the reference lying at `quad`."""
    h, w = ref.shape[:2]
    m = cv2.getPerspectiveTransform(np.float32([[0, 0], [w, 0], [w, h], [0, h]]), quad.astype(np.float32))
    desk = np.full((size[1], size[0], 3), (70, 90, 60), np.uint8)
    return cv2.warpPerspective(ref, m, size, dst=desk, borderMode=cv2.BORDER_TRANSPARENT)


QUAD = np.float32([[520, 200], [760, 215], [745, 545], [505, 530]])


class Plausible(unittest.TestCase):
    def test_a_card_lying_in_the_frame_is_one(self):
        self.assertTrue(real_scenes.plausible(QUAD, 1280, 720))

    def test_a_mirrored_match_is_no_card(self):
        self.assertFalse(real_scenes.plausible(QUAD[[1, 0, 3, 2]], 1280, 720))

    def test_a_square_a_speck_and_a_quad_out_of_frame_are_no_card(self):
        square = np.float32([[100, 100], [400, 100], [400, 400], [100, 400]])
        self.assertFalse(real_scenes.plausible(square, 1280, 720))
        self.assertFalse(real_scenes.plausible(QUAD * 0.05, 1280, 720))
        self.assertFalse(real_scenes.plausible(QUAD + np.float32([900, 0]), 1280, 720))

    def test_a_folded_quad_is_no_card(self):
        self.assertFalse(real_scenes.plausible(QUAD[[0, 2, 1, 3]], 1280, 720))


class Split(unittest.TestCase):
    def test_a_scan_falls_on_the_same_side_every_time_and_some_on_each(self):
        scans = [f"20261110T0327{n:02d}Z-{n:016x}" for n in range(60)]
        sides = [real_scenes.split_of(s, 4) for s in scans]
        self.assertEqual(sides, [real_scenes.split_of(s, 4) for s in scans])
        self.assertIn("val", sides)
        self.assertGreater(sides.count("train"), sides.count("val"))

    def test_no_scan_is_held_out_when_none_is_asked_for(self):
        self.assertEqual(real_scenes.split_of("20261110T032718Z-4d403a39af7cfb67", 0), "train")


class Registering(unittest.TestCase):
    def test_the_scan_s_corners_are_found_where_the_card_lies(self):
        ref = reference()
        quad, inliers = real_scenes.Register(ref).find(frame_with(ref, QUAD))
        self.assertIsNotNone(quad)
        self.assertGreaterEqual(inliers, 15)
        self.assertLess(float(np.abs(quad - QUAD).max()), 3.0, "within a few pixels of each corner, in card order")

    def test_a_frame_without_the_card_has_no_corners(self):
        quad, _ = real_scenes.Register(reference()).find(frame_with(reference(seed=9), QUAD))
        self.assertIsNone(quad)


class Building(unittest.TestCase):
    def mirror(self, root: Path, scans: dict) -> Path:
        """A scan mirror: `scans` is id → card id or None (sent as *no card*), three frames each."""
        ref = reference()
        for scan, card in scans.items():
            (root / "labels").mkdir(parents=True, exist_ok=True)
            (root / "frames" / scan).mkdir(parents=True)
            label = {"id": scan, "card": None if card is None else {"id": card, "set": "tst", "number": "1", "name": "Test"}}
            (root / "labels" / f"{scan}.json").write_text(json.dumps(label), encoding="utf-8")
            for n in range(3):
                frame = frame_with(ref, QUAD + n) if card else np.full((720, 1280, 3), (70, 90, 60), np.uint8)
                cv2.imwrite(str(root / "frames" / scan / f"{n:02d}.jpg"), frame)
        return root

    def build(self, tmp: Path, scans: dict, **over) -> tuple[dict, list[dict]]:
        mirror = self.mirror(tmp / "mirror", scans)
        refs = tmp / "refs"
        refs.mkdir(exist_ok=True)
        cv2.imwrite(str(refs / f"{PRINTING}.jpg"), reference())
        args = {"after": real_scenes.TEST_SET_BEFORE, "val_every": 4, "min_inliers": 15, **over}
        report = real_scenes.build(mirror, tmp / "data", tmp / "out", refs, **args)
        return report, real_scenes.load(tmp / "out")

    def test_a_scan_becomes_a_row_a_frame_with_its_corners(self):
        with tempfile.TemporaryDirectory() as tmp:
            report, rows = self.build(Path(tmp), {"20261110T000000Z-0000000000000001": PRINTING})
            self.assertEqual((report["scans"], report["labelled"], report["unmatched"]), (1, 3, 0))
            self.assertEqual(len(rows), 3)
            self.assertLess(float(np.abs(rows[0]["quad"] - QUAD).max()), 3.0)
            self.assertTrue((Path(tmp) / "out" / rows[0]["frame"]).exists(), "the folder holds its own frames")
            self.assertEqual({r["split"] for r in rows}, {rows[0]["split"]}, "a scan's frames stay together")
            # The privacy policy (apps/light/public/privacy.html, *Sending a scan*) says what the copy
            # kept for training holds: the pictures, the scan's reference and where the card lies.
            # Nothing of the label — which card, which finish, what the scanner had answered.
            self.assertEqual(set(rows[0]), {"scan", "frame", "width", "height", "quad", "split", "inliers"})

    def test_a_scan_sent_as_no_card_is_kept_with_no_corners(self):
        with tempfile.TemporaryDirectory() as tmp:
            report, rows = self.build(Path(tmp), {"20261110T000000Z-0000000000000002": None})
            self.assertEqual(report["empty"], 3)
            self.assertTrue(all(r["quad"] is None for r in rows))

    def test_a_frame_of_a_no_card_scan_that_still_shows_a_card_is_not_taken_as_empty(self):
        # The reader vouched for the last frame; the run's first can be the card being lifted away.
        with tempfile.TemporaryDirectory() as tmp:
            tmp, scan = Path(tmp), "20261110T000000Z-0000000000000005"
            self.mirror(tmp / "mirror", {scan: None})
            cv2.imwrite(str(tmp / "mirror" / "frames" / scan / "00.jpg"), self.desk(card=True))
            report = real_scenes.build(tmp / "mirror", tmp / "data", tmp / "out", None, real_scenes.TEST_SET_BEFORE, 4, 15)
            rows = real_scenes.load(tmp / "out")
            self.assertEqual((report["empty"], report["unvouched"]), (2, 1))
            self.assertEqual([Path(r["frame"]).name for r in rows], ["01.jpg", "02.jpg"])

    @staticmethod
    def desk(card: bool = False) -> np.ndarray:
        """The mirror's empty desk, with or without a card as light against it as a real one is."""
        img = np.full((720, 1280, 3), (70, 90, 60), np.uint8)
        if card:
            cv2.fillConvexPoly(img, np.round(QUAD).astype(np.int32), (235, 235, 230))
        return img

    def test_a_shadow_across_an_empty_desk_is_still_an_empty_desk(self):
        shaded = self.desk()
        shaded[:, :500] = (shaded[:, :500] * 0.6).astype(np.uint8)
        self.assertTrue(real_scenes.like_last(shaded, self.desk()))
        self.assertFalse(real_scenes.like_last(self.desk(card=True), self.desk()))

    def test_a_folder_it_did_not_write_is_not_replaced(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            self.mirror(tmp / "mirror", {"20261110T000000Z-0000000000000001": PRINTING})
            (tmp / "dataset").mkdir()
            (tmp / "dataset" / "index.jsonl").write_text("{}", encoding="utf-8")
            with self.assertRaises(SystemExit) as refused:
                real_scenes.build(tmp / "mirror", tmp / "data", tmp / "dataset", None, real_scenes.TEST_SET_BEFORE, 4, 15)
            self.assertIn("not a folder `build` wrote", str(refused.exception))
            self.assertTrue((tmp / "dataset" / "index.jsonl").exists(), "and nothing in it was touched")

    def test_the_readers_test_set_is_never_a_scene(self):
        with tempfile.TemporaryDirectory() as tmp:
            report, rows = self.build(Path(tmp), {
                "20261015T033805Z-d4c9da120ecda764": PRINTING,  # one of the 124
                "20261110T000000Z-0000000000000001": PRINTING,
            })
            self.assertEqual({r["scan"] for r in rows}, {"20261110T000000Z-0000000000000001"})

    def test_a_card_with_no_reference_scan_is_reported_and_left_out(self):
        with tempfile.TemporaryDirectory() as tmp:
            report, rows = self.build(Path(tmp), {"20261110T000000Z-0000000000000003": "cd000000-0000-4000-8000-000000000009"})
            self.assertEqual(rows, [])
            self.assertEqual(len(report["no_reference"]), 1)

    def test_a_scan_removed_from_the_mirror_is_gone_from_the_next_build(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            one, two = "20261110T000000Z-0000000000000001", "20261110T000000Z-0000000000000004"
            self.build(tmp, {one: PRINTING, two: PRINTING})
            (tmp / "mirror" / "labels" / f"{two}.json").unlink()
            report = real_scenes.build(tmp / "mirror", tmp / "data", tmp / "out", tmp / "refs", real_scenes.TEST_SET_BEFORE, 4, 15)
            self.assertEqual(report["scans"], 1)
            self.assertFalse((tmp / "out" / "frames" / two).exists(), "a deletion request reaches the scenes")

    def test_the_command_refuses_to_reach_into_the_test_set(self):
        with mock.patch.object(sys, "argv", ["real_scenes.py", "build", "m", "d", "o", "--after", "20261001"]):
            with self.assertRaises(SystemExit) as refused:
                real_scenes.main()
        self.assertIn("test set", str(refused.exception))


class Scoring(unittest.TestCase):
    """A replay's quads (in the pump's 960 px frame) against corners kept in the frame's own 1280."""

    def scenes(self, root: Path) -> Path:
        (root / "frames" / "s1").mkdir(parents=True)
        rows = []
        for n in range(5):
            (root / "frames" / "s1" / f"{n:02d}.jpg").write_bytes(b"jpeg")
            rows.append({"scan": "s1", "frame": f"frames/s1/{n:02d}.jpg", "width": 1280, "height": 720,
                         "quad": None if n == 4 else QUAD.tolist(), "split": "val", "inliers": 50})
        (root / "scenes.jsonl").write_text("".join(json.dumps(r) + "\n" for r in rows), encoding="utf-8")
        return root

    def results(self, quads: list) -> dict:
        frames = [{"quad": None if q is None else (np.float32(q) * 0.75).tolist()} for q in quads]
        return {"runs": [{"id": "s1", "passes": [{"name": "As scanned", "frames": []}, {"name": "Neural", "frames": frames}]},
                         {"id": "a scan with no scenes", "passes": [{"name": "Neural", "frames": frames}]}]}

    def test_the_card_the_box_round_it_and_nothing_are_told_apart(self):
        centre = QUAD.mean(0)
        box = centre + (QUAD - centre) * 1.6
        with tempfile.TemporaryDirectory() as tmp:
            got = real_scenes.score(self.scenes(Path(tmp)), self.results([QUAD, QUAD[[2, 3, 0, 1]], box, None, box]))
        self.assertEqual((got["frames"], got["found"], got["container"], got["none"]), (4, 2, 1, 1))
        self.assertAlmostEqual(got["corner_err"], 0.0, places=4, msg="a card read upside down has its corners all the same")
        self.assertEqual((got["empty"], got["empty_quad_share"]), (1, 1.0), "a quad on a frame sent as empty")

    def test_corners_off_by_a_tenth_of_the_card_s_height_score_a_tenth(self):
        height = float(np.linalg.norm(QUAD[3] - QUAD[0]) + np.linalg.norm(QUAD[2] - QUAD[1])) / 2
        shifted = QUAD + np.float32([0.1 * height, 0])
        with tempfile.TemporaryDirectory() as tmp:
            got = real_scenes.score(self.scenes(Path(tmp)), self.results([shifted, shifted, shifted, shifted, None]))
        self.assertAlmostEqual(got["corner_err"], 0.1, places=3)
        self.assertEqual((got["found"], got["empty_quad_share"]), (4, 0.0))

    def test_a_quad_far_from_the_card_is_elsewhere(self):
        with tempfile.TemporaryDirectory() as tmp:
            got = real_scenes.score(self.scenes(Path(tmp)), self.results([QUAD - np.float32([400, 0])] * 4 + [None]))
        self.assertEqual((got["found"], got["elsewhere"]), (0, 4))


if __name__ == "__main__":
    unittest.main()
