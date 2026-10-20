"""The run's budget: the shares, the rates, and the ledger that carries spend across restarts."""
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import budget  # noqa: E402


class Shares(unittest.TestCase):
    def test_a_run_never_shares_out_more_than_the_hard_limit(self):
        for detector in (True, False):
            s = budget.shares(budget.HARD_LIMIT_USD, detector)
            self.assertAlmostEqual(sum(s.values()), budget.HARD_LIMIT_USD, places=6)
        with self.assertRaises(ValueError):
            budget.shares(10.01, True)
        with self.assertRaises(ValueError):
            budget.shares(budget.REFRESH_USD + budget.PIPELINE_USD, True)

    def test_without_the_detector_the_embedder_gets_what_is_left(self):
        s = budget.shares(10.0, False)
        self.assertNotIn("detector", s)
        self.assertAlmostEqual(s["embedder"], 10.0 - budget.REFRESH_USD - budget.PIPELINE_USD)

    def test_the_default_container_affords_well_over_the_estimated_training(self):
        # 16 cores, 24 GiB, an L4: $1.75 an hour. Estimated ~1.0 h (embedder) and ~1.2 h
        # (detector); the shares must leave room for Modal's cores being half as fast.
        rate = budget.rate_per_s("L4", 16, 24)
        self.assertAlmostEqual(rate * 3600, 0.799 + 16 * 0.04716 + 24 * 0.007992, places=2)
        s = budget.shares(10.0, True)
        self.assertGreater(budget.max_seconds(s["embedder"], rate), 2 * 1.0 * 3600)
        self.assertGreater(budget.max_seconds(s["detector"], rate), 2 * 1.2 * 3600)


class LedgerTest(unittest.TestCase):
    def test_spend_carries_across_attempts_and_a_spent_stage_refuses_to_start(self):
        with tempfile.TemporaryDirectory() as d:
            rate = budget.rate_per_s("L4", 16, 24)
            ledger = budget.Ledger(Path(d), "embedder", rate, limit_usd=1.0)
            first = ledger.start()
            self.assertEqual(first["attempts"], 1)
            self.assertEqual(first["seconds"], budget.START_OVERHEAD_S)
            ledger.add(600)
            # A restarted container reads what the last one spent.
            again = budget.Ledger(Path(d), "embedder", rate, limit_usd=1.0).start()
            self.assertEqual(again["attempts"], 2)
            self.assertEqual(again["seconds"], 2 * budget.START_OVERHEAD_S + 600)
            self.assertFalse(ledger.over())
            ledger.add(3600)
            self.assertTrue(ledger.over())
            with self.assertRaises(budget.BudgetExceeded):
                ledger.start()

    def test_the_run_total_is_every_stage_file(self):
        with tempfile.TemporaryDirectory() as d:
            budget.Ledger(Path(d), "embedder", 0.001, 5).add(1000)  # $1.00
            budget.Ledger(Path(d), "detector", 0.002, 5).add(1000)  # $2.00
            (Path(d) / "spend" / "broken.json").write_text("{", encoding="utf-8")
            self.assertAlmostEqual(budget.total_usd(Path(d)), 3.0)


if __name__ == "__main__":
    unittest.main()
