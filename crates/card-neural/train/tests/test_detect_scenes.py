"""qd_detect_data.py: the scenes a reader's camera really sees — a feed between bars, a scene with
nothing to find, a reader's own frame cut the way the scanner cuts it — and what each asks of the
network.

    python -m unittest discover -s crates/card-neural/train/tests -p "test_detect_scenes.py"

No GPU, no dataset and no reader's photograph: the cards and frames here are drawn.
"""
import json
import random
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import qd_detect_data as D  # noqa: E402

CARD = np.full((340, 244, 3), (200, 40, 40), np.uint8)
QUAD = np.float32([[520, 200], [760, 200], [760, 535], [520, 535]])


def frame(quad: np.ndarray | None = QUAD) -> np.ndarray:
    """A grey 1280×720 frame with a red card painted at `quad`."""
    img = np.full((720, 1280, 3), 90, np.uint8)
    if quad is not None:
        cv2.fillConvexPoly(img, np.round(quad).astype(np.int32), (200, 40, 40))
    return img


def redness(image: np.ndarray, quad: np.ndarray) -> float:
    """The share of the pixels well inside `quad` that are the painted card's red."""
    centre = quad.mean(0)
    mask = np.zeros(image.shape[:2], np.uint8)
    cv2.fillConvexPoly(mask, np.round(centre + (quad - centre) * 0.8).astype(np.int32), 1)
    inside = image[mask == 1].astype(int)
    return float(((inside[:, 0] > 140) & (inside[:, 1] < 100)).mean()) if len(inside) else 0.0


class Synthetic(unittest.TestCase):
    def test_a_scene_with_nothing_to_find_has_no_card_and_no_ignored_cell(self):
        with mock.patch.object(D, "EMPTY_P", 1.0), mock.patch.object(D, "WELL_P", 0.5):
            for seed in range(12):
                image, cards = D.render(random.Random(seed), D.LONG, D.SHORT, CARD, [], refine=seed % 2 == 0)
                self.assertEqual(cards, [], seed)
                heat, _, _, cw, hw = D.targets(cards, D.LONG, D.SHORT)
                self.assertEqual((float(heat.max()), float(cw.max()), float(hw.min())), (0.0, 0.0, 1.0))

    def test_a_card_in_a_box_is_labelled_and_the_box_is_not(self):
        # The second pass's scene: the card fills 0.6 to 0.74 of the limiting side, and the box
        # round it — its floor wider than the card, its walls wider still — reaches further.
        limit = min(D.LONG, D.SHORT / (63 / 88))
        with mock.patch.object(D, "WELL_P", 1.0), mock.patch.object(D, "EMPTY_P", 0.0), mock.patch.object(D, "BARS_P", 0.0):
            for seed in range(12):
                _, cards = D.render(random.Random(seed), D.SHORT, D.LONG, CARD, [], refine=True)
                self.assertEqual([label for _, label in cards], [1], f"seed {seed}: the card, and only it")
                quad = cards[0][0]
                height = (np.linalg.norm(quad[3] - quad[0]) + np.linalg.norm(quad[2] - quad[1])) / 2
                width = (np.linalg.norm(quad[1] - quad[0]) + np.linalg.norm(quad[2] - quad[3])) / 2
                self.assertLess(height, 0.74 * limit * 1.13, f"seed {seed}: a quad the card's size, not the box's")
                self.assertAlmostEqual(width / height, 63 / 88, delta=0.12, msg=f"seed {seed}: a card's shape")

    def test_a_barred_feed_keeps_its_cards_inside_the_picture(self):
        # The picture: the middle half of a wide frame, in render pixels.
        x0, x1 = D.LONG * D.RENDER // 4, D.LONG * D.RENDER * 3 // 4
        picture = (x0, 0, x1, D.SHORT * D.RENDER)
        with mock.patch.object(D, "BARS_P", 1.0), mock.patch.object(D, "EMPTY_P", 0.0), \
                mock.patch.object(D, "_bars", return_value=picture):
            for seed in range(12):
                image, cards = D.render(random.Random(seed), D.LONG, D.SHORT, CARD, [], refine=False)
                self.assertLess(int(image[:, : x0 // D.RENDER - 2].max()), 40, "the bar is black")
                self.assertLess(int(image[:, x1 // D.RENDER + 2 :].max()), 40, "and so is the other")
                for quad, _ in cards:
                    c = quad.mean(0) * D.RENDER
                    self.assertTrue(x0 <= c[0] < x1, f"seed {seed}: a card's middle in the bar")

    def test_a_wide_frame_is_barred_left_and_right_and_an_upright_one_above_and_below(self):
        for seed in range(8):
            x0, y0, x1, y1 = D._bars(random.Random(seed), 640, 384)
            self.assertEqual((y0, y1), (0, 384))
            self.assertTrue(0 < x0 < x1 < 640)
            x0, y0, x1, y1 = D._bars(random.Random(seed), 384, 640)
            self.assertEqual((x0, x1), (0, 384))
            self.assertTrue(0 < y0 < y1 < 640)


class RealView(unittest.TestCase):
    def test_the_corners_follow_the_card_through_every_cut(self):
        labelled = 0
        for seed in range(40):
            rng = random.Random(seed)
            landscape = seed % 2 == 0
            iw, ih = (D.LONG, D.SHORT) if landscape else (D.SHORT, D.LONG)
            image, cards = D.real_view(rng, frame(), QUAD.copy(), iw, ih, refine_p=0.5)
            self.assertEqual(image.shape, (ih, iw, 3))
            for quad, label in cards:
                if label == 1:
                    labelled += 1
                    self.assertGreater(redness(image, np.clip(quad, 0, [iw - 1, ih - 1])), 0.85, f"seed {seed}")
        self.assertGreater(labelled, 30, "the card is labelled in most of the views, or nothing was checked")

    def test_an_upright_phone_s_frame_keeps_its_corners_on_the_card_too(self):
        # Every scan sent so far is a wide frame; an Android phone held upright sends this one.
        upright = np.full((1280, 720, 3), 90, np.uint8)
        quad = np.float32([[240, 470], [480, 470], [480, 805], [240, 805]])
        cv2.fillConvexPoly(upright, np.round(quad).astype(np.int32), (200, 40, 40))
        labelled = 0
        for seed in range(60):
            landscape = seed % 2 == 0
            iw, ih = (D.LONG, D.SHORT) if landscape else (D.SHORT, D.LONG)
            image, cards = D.real_view(random.Random(seed), upright, quad.copy(), iw, ih, refine_p=0.3)
            self.assertEqual(image.shape, (ih, iw, 3))
            for q, label in cards:
                if label == 1:
                    labelled += 1
                    self.assertGreater(redness(image, np.clip(q, 0, [iw - 1, ih - 1])), 0.85, f"seed {seed}")
        self.assertGreater(labelled, 40, "and the card is in most of the views")

    def test_a_frame_with_no_card_has_none_in_any_cut(self):
        for seed in range(20):
            _, cards = D.real_view(random.Random(seed), frame(None), None, D.LONG, D.SHORT)
            self.assertEqual(cards, [])

    def test_another_card_can_lie_where_the_reader_s_did(self):
        blue = np.full((340, 244, 3), (30, 30, 220), np.uint8)
        image, cards = D.real_view(random.Random(2), frame(), QUAD.copy(), D.LONG, D.SHORT, [blue], refine_p=0.0, swap_p=1.0)
        self.assertEqual(len(cards), 1)
        self.assertLess(redness(image, cards[0][0]), 0.1, "the reader's card is covered")

    def test_four_quarter_turns_put_a_frame_and_its_corners_back(self):
        img, quad = D._turn(frame(), QUAD.copy(), 4)
        np.testing.assert_array_equal(img, frame())
        np.testing.assert_allclose(quad, QUAD)
        turned, q = D._turn(frame(), QUAD.copy(), 1)
        self.assertEqual(turned.shape[:2], (1280, 720))
        self.assertGreater(redness(turned, q), 0.95, "the corners turn with the picture")

    def test_a_cut_past_the_frame_s_edge_repeats_the_edge(self):
        out = D._cut(frame(None), (-200.0, -100.0, 640.0, 384.0), 320, 192)
        self.assertEqual(out.shape, (192, 320, 3))
        self.assertEqual((int(out.min()), int(out.max())), (90, 90))

    def test_the_second_pass_s_box_is_the_scanner_s(self):
        # `detect::tests::the_refine_box_keeps_the_input_aspect`, in the same numbers.
        x, y, w, h = D._input_box(100, 100, 200, 140, 1.45, 192, 320)
        self.assertAlmostEqual(w / h, 192 / 320, places=4)
        self.assertAlmostEqual(x + w / 2, 150, places=3)


class RealDataset(unittest.TestCase):
    def scenes(self, root: Path) -> Path:
        (root / "frames" / "s1").mkdir(parents=True)
        cv2.imwrite(str(root / "frames" / "s1" / "00.jpg"), cv2.cvtColor(frame(), cv2.COLOR_RGB2BGR))
        cv2.imwrite(str(root / "frames" / "s1" / "01.jpg"), frame(None))
        rows = [
            {"scan": "s1", "frame": "frames/s1/00.jpg", "width": 1280, "height": 720, "quad": QUAD.tolist(), "split": "val", "inliers": 99},
            {"scan": "s1", "frame": "frames/s1/01.jpg", "width": 1280, "height": 720, "quad": None, "split": "val", "inliers": 0},
            {"scan": "s1", "frame": "frames/s1/gone.jpg", "width": 1280, "height": 720, "quad": None, "split": "val", "inliers": 0},
        ]
        (root / "scenes.jsonl").write_text("".join(json.dumps(r) + "\n" for r in rows), encoding="utf-8")
        return root

    def test_only_the_card_s_surroundings_are_judged_in_a_frame_with_a_card(self):
        with tempfile.TemporaryDirectory() as tmp:
            real = D.RealScenes(self.scenes(Path(tmp)), split="val", fixed=True)
            self.assertEqual(len(real), 2, "a row whose frame is gone is not a scene")
            image, heat, corners, flip, cw, hw = (t.numpy() for t in real[(0, True)])
            self.assertEqual(float(heat.max()), 1.0)
            y, x = np.unravel_index(heat.argmax(), heat.shape)
            self.assertEqual(float(hw[y, x]), 1.0, "the card's own cell is judged")
            self.assertEqual(float(hw.min()), 0.0, "what lies beside it is not: it may be a card nobody labelled")

    def test_a_frame_sent_as_no_card_is_background_everywhere(self):
        with tempfile.TemporaryDirectory() as tmp:
            real = D.RealScenes(self.scenes(Path(tmp)), split="val", fixed=True)
            image, heat, corners, flip, cw, hw = (t.numpy() for t in real[(1, True)])
            self.assertEqual((float(heat.max()), float(hw.min())), (0.0, 1.0))

    def test_a_folder_with_no_scene_of_the_split_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(SystemExit):
                D.RealScenes(self.scenes(Path(tmp)), split="train")


if __name__ == "__main__":
    unittest.main()
