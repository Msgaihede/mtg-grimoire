"""`modal_app._floors_failed`: the floors under which a run fails and is not delivered — the
embedder's, the detector's when it trained (on drawn scenes and on readers' frames), and the set
symbol and collector band networks' — and when a run trains a detector at all.

    python -m unittest discover -s crates/card-neural/train/tests -p "test_floors.py"

`modal_app.py` builds its image and app at import, so `modal` is a stub here: the test needs
neither Modal's client nor an account.
"""
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
with mock.patch.dict(sys.modules, {"modal": mock.MagicMock()}):
    import modal_app  # noqa: E402


def passing() -> dict:
    """A run's metrics at the shipped files' figures, every one above its floor."""
    return {
        "embedder": {"retrieval_top1": 0.9997},
        "detector": {"found": 0.993, "corner_err": 0.028, "wrong_way": 0.004,
                     "real_found": 1.0, "real_corner_err": 0.025, "real_container": 0.0, "real_empty_hit": 0.0},
        "symbol": {"within_top1": 0.927},
        "band": {"within_top1": 0.946},
    }


class Floors(unittest.TestCase):
    def test_a_run_at_the_shipped_figures_passes(self):
        self.assertEqual(modal_app._floors_failed(passing()), [])

    def test_a_run_without_the_detector_passes_on_the_other_three(self):
        metrics = passing()
        del metrics["detector"]
        self.assertEqual(modal_app._floors_failed(metrics), [])

    def test_a_missing_evidence_network_fails_the_run(self):
        for kind in modal_app.EVIDENCE:
            metrics = passing()
            del metrics[kind]
            failed = modal_app._floors_failed(metrics)
            self.assertEqual(len(failed), 1, kind)
            self.assertIn(f"{kind} within-card top-1 None under", failed[0])

    def test_an_evidence_network_that_reported_nothing_fails_the_run(self):
        for kind in modal_app.EVIDENCE:
            metrics = passing()
            metrics[kind] = {"within_top1": None}
            self.assertEqual(len(modal_app._floors_failed(metrics)), 1, kind)

    def test_an_evidence_network_under_its_floor_fails_the_run(self):
        for kind in modal_app.EVIDENCE:
            floor = modal_app.FLOORS[kind]["within_top1"]
            metrics = passing()
            metrics[kind] = {"within_top1": floor - 0.001}
            failed = modal_app._floors_failed(metrics)
            self.assertEqual(failed, [f"{kind} within-card top-1 {floor - 0.001} under {floor}"])
            metrics[kind] = {"within_top1": floor}
            self.assertEqual(modal_app._floors_failed(metrics), [], f"{kind} at its floor passes")

    def test_both_evidence_networks_low_name_both(self):
        metrics = passing()
        metrics["symbol"] = {"within_top1": 0.5}
        metrics["band"] = {"within_top1": 0.5}
        failed = modal_app._floors_failed(metrics)
        self.assertEqual([line.split()[0] for line in failed], ["symbol", "band"])

    def test_the_embedder_and_the_detector_floors_still_hold(self):
        metrics = passing()
        metrics["embedder"] = {"retrieval_top1": 0.98}
        metrics["detector"] = {**passing()["detector"], "found": 0.97, "corner_err": 0.05, "wrong_way": 0.02}
        self.assertEqual(len(modal_app._floors_failed(metrics)), 4)

    def test_a_detector_that_loses_the_card_on_a_reader_s_desk_fails_the_run(self):
        # The 2026-11 detector: its drawn scenes' figures passed, and these are what a reader's frames said.
        metrics = passing()
        metrics["detector"].update({"real_found": 0.829, "real_corner_err": 0.085, "real_container": 0.214,
                                    "real_empty_hit": 0.475})
        failed = modal_app._floors_failed(metrics)
        self.assertEqual(len(failed), 4)
        self.assertIn("of the readers' cards, under", failed[0])
        self.assertIn("corner error on readers' frames", failed[1])
        self.assertIn("took what holds the card for the card", failed[2])
        self.assertIn("readers' empty frames", failed[3])

    def test_a_few_boxes_taken_for_cards_fail_the_run_under_a_passing_corner_error(self):
        # A box shares its card's middle, so it is found, and one frame in eight of them is a mean
        # corner error still under its floor: issue #1526's jitter was fewer.
        metrics = passing()
        metrics["detector"].update({"real_found": 1.0, "real_corner_err": 0.045, "real_container": 0.12})
        failed = modal_app._floors_failed(metrics)
        self.assertEqual(len(failed), 1)
        self.assertIn("took what holds the card for the card on 0.12", failed[0])

    def test_a_detector_scored_on_no_reader_s_frame_fails_the_run(self):
        metrics = passing()
        metrics["detector"] = {"found": 0.993, "corner_err": 0.028, "wrong_way": 0.004}
        self.assertEqual(len(modal_app._floors_failed(metrics)), 3, "found, corner error and the box, all unreported")

    def test_held_out_scans_with_no_empty_frame_have_nothing_to_fail_on(self):
        metrics = passing()
        metrics["detector"]["real_empty_hit"] = None
        self.assertEqual(modal_app._floors_failed(metrics), [])


class DetectorKept(unittest.TestCase):
    """A run trains a detector only when the Volume holds readers' scenes."""

    def test_a_volume_without_readers_scenes_keeps_the_detector_and_says_why(self):
        import tempfile

        with tempfile.TemporaryDirectory() as d, mock.patch.object(modal_app, "REAL", Path(d) / "real-scenes"):
            why = modal_app._detector_kept()
            self.assertIn("no readers' scenes", why)
            self.assertIsNone(modal_app._real_scenes())

    def test_a_volume_with_them_trains_one_on_a_local_copy(self):
        import tempfile

        with tempfile.TemporaryDirectory() as d:
            real, local = Path(d) / "real-scenes", Path(d) / "local"
            (real / "frames" / "s1").mkdir(parents=True)
            (real / "scenes.jsonl").write_text("{}", encoding="utf-8")
            (real / "frames" / "s1" / "00.jpg").write_bytes(b"jpeg")
            with mock.patch.object(modal_app, "REAL", real), mock.patch.object(modal_app, "LOCAL_REAL", local):
                self.assertIsNone(modal_app._detector_kept())
                self.assertEqual(modal_app._real_scenes(), local)
                self.assertTrue((local / "frames" / "s1" / "00.jpg").exists())


if __name__ == "__main__":
    unittest.main()
