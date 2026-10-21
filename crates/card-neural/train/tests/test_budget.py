"""The run's budget: the shares, the rates, and the ledger that carries spend across restarts."""
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import budget  # noqa: E402


class Shares(unittest.TestCase):
    def test_the_hard_limit_is_the_owners_ten_dollars(self):
        self.assertEqual(budget.HARD_LIMIT_USD, 10.0)

    def test_six_stages_share_the_whole_budget(self):
        s = budget.shares(10.0, True)
        self.assertEqual(set(s), {"refresh", "pipeline", "embedder", "detector", "symbol", "band"})
        self.assertAlmostEqual(sum(s.values()), 10.0, places=6)
        self.assertGreater(s["symbol"], 0)
        self.assertGreater(s["band"], 0)

    def test_a_run_never_shares_out_more_than_the_hard_limit(self):
        for detector in (True, False):
            s = budget.shares(budget.HARD_LIMIT_USD, detector)
            self.assertAlmostEqual(sum(s.values()), budget.HARD_LIMIT_USD, places=6)
        with self.assertRaises(ValueError):
            budget.shares(10.01, True)
        with self.assertRaises(ValueError):
            budget.shares(budget.REFRESH_USD + budget.PIPELINE_USD, True)

    def test_without_the_detector_the_other_three_trainings_share_what_is_left(self):
        s = budget.shares(10.0, False)
        self.assertEqual(set(s), {"refresh", "pipeline", "embedder", "symbol", "band"})
        self.assertAlmostEqual(s["embedder"] + s["symbol"] + s["band"], 10.0 - budget.REFRESH_USD - budget.PIPELINE_USD)

    def test_each_training_is_shared_its_estimate_and_a_margin(self):
        # 16 cores, 24 GiB, an L4: $1.75 an hour. The four trainings' estimates come to ~$8.30 of the
        # $9.65 left after the refresh and the orchestrator, so each gets its estimate plus ~16 %.
        rate = budget.rate_per_s("L4", 16, 24)
        self.assertAlmostEqual(rate * 3600, 0.799 + 16 * 0.04716 + 24 * 0.007992, places=2)
        s = budget.shares(10.0, True)
        estimated = sum(budget.ESTIMATE_USD.values()) + budget.REFRESH_USD + budget.PIPELINE_USD
        self.assertLessEqual(estimated, 9.0, "the owner's ~$9 a run")
        for stage, usd in budget.ESTIMATE_USD.items():
            self.assertGreater(s[stage], 1.1 * usd, stage)
            hours = usd / (rate * 3600)
            self.assertGreater(budget.max_seconds(s[stage], rate), hours * 3600, stage)
        # The embedder and the detector keep the ratio their measured estimates had.
        self.assertAlmostEqual(s["embedder"] / (s["embedder"] + s["detector"]), 0.46, delta=0.02)


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
