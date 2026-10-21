"""`modal_app._floors_failed`: the floors under which a run fails and is not delivered — the
embedder's, the detector's when it trained, and the set symbol and collector band networks'.

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
        "detector": {"found": 0.993, "corner_err": 0.028, "wrong_way": 0.004},
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
        metrics["detector"] = {"found": 0.97, "corner_err": 0.05, "wrong_way": 0.02}
        self.assertEqual(len(modal_app._floors_failed(metrics)), 4)


if __name__ == "__main__":
    unittest.main()
