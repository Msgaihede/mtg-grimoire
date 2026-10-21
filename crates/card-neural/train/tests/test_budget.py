"""The run's budget: the shares, the rates, and the ledger that carries spend across restarts."""
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import budget  # noqa: E402


# The default training container: an L4, 16 physical cores, 24 GiB.
RATE = budget.rate_per_s("L4", 16, 24)


def worst_case_usd(s: dict, rate: float) -> float:
    """What a run can spend at most: every guarded stage its share and the most a watchdog can let
    past it, and the orchestrator its set amount."""
    trainings = [k for k in s if k not in ("refresh", "pipeline")]
    return (s["pipeline"]
            + s["refresh"] + budget.overrun_usd(budget.REFRESH_RATE)
            + sum(s[k] + budget.overrun_usd(rate) for k in trainings))


class Shares(unittest.TestCase):
    def test_the_hard_limit_is_the_owners_fifteen_dollars(self):
        self.assertEqual(budget.HARD_LIMIT_USD, 15.0)

    def test_six_stages_share_the_budget_less_the_watchdogs_reserve(self):
        s = budget.shares(budget.HARD_LIMIT_USD, True, RATE)
        self.assertEqual(set(s), {"refresh", "pipeline", "embedder", "detector", "symbol", "band"})
        reserve = budget.overrun_usd(budget.REFRESH_RATE) + 4 * budget.overrun_usd(RATE)
        self.assertAlmostEqual(sum(s.values()) + reserve, budget.HARD_LIMIT_USD, places=6)
        self.assertGreater(s["symbol"], 0)
        self.assertGreater(s["band"], 0)

    def test_the_overrun_is_a_retry_admitted_under_its_share_then_a_tick_and_a_kill(self):
        self.assertEqual(budget.OVERRUN_S, budget.START_OVERHEAD_S + budget.GUARD_TICK_S + budget.KILL_TIMEOUT_S)
        self.assertAlmostEqual(budget.overrun_usd(RATE), budget.OVERRUN_S * RATE)

    def test_a_run_never_spends_more_than_the_hard_limit_even_when_every_watchdog_overruns(self):
        # The default container, the smallest a launch allows and the largest.
        for rate in (RATE, budget.rate_per_s("L4", 1, 4), budget.rate_per_s("L4", 64, 256)):
            for detector in (True, False):
                s = budget.shares(budget.HARD_LIMIT_USD, detector, rate)
                self.assertLessEqual(worst_case_usd(s, rate), budget.HARD_LIMIT_USD + 1e-9, (rate, detector))
                self.assertAlmostEqual(worst_case_usd(s, rate), budget.HARD_LIMIT_USD, places=6)
        with self.assertRaises(ValueError):
            budget.shares(15.01, True, RATE)
        with self.assertRaises(ValueError):
            budget.shares(budget.REFRESH_USD + budget.PIPELINE_USD, True, RATE)

    def test_without_the_detector_the_other_three_trainings_share_what_is_left(self):
        s = budget.shares(budget.HARD_LIMIT_USD, False, RATE)
        self.assertEqual(set(s), {"refresh", "pipeline", "embedder", "symbol", "band"})
        reserve = budget.overrun_usd(budget.REFRESH_RATE) + 3 * budget.overrun_usd(RATE)
        self.assertAlmostEqual(s["embedder"] + s["symbol"] + s["band"],
                               budget.HARD_LIMIT_USD - budget.REFRESH_USD - budget.PIPELINE_USD - reserve)

    def test_each_training_is_shared_its_estimate_and_a_margin(self):
        # 16 cores, 24 GiB, an L4: $1.75 an hour. The four trainings' estimates come to ~$8.30 of the
        # ~$14.23 left after the refresh, the orchestrator and the watchdogs' reserve, so each gets
        # its estimate plus ~71 %.
        self.assertAlmostEqual(RATE * 3600, 0.799 + 16 * 0.04716 + 24 * 0.007992, places=2)
        s = budget.shares(budget.HARD_LIMIT_USD, True, RATE)
        estimated = sum(budget.ESTIMATE_USD.values()) + budget.REFRESH_USD + budget.PIPELINE_USD
        self.assertLessEqual(estimated, 9.0, "the owner's ~$9 a run")
        for stage, usd in budget.ESTIMATE_USD.items():
            self.assertGreater(s[stage], 1.7 * usd, stage)
            hours = usd / (RATE * 3600)
            self.assertGreater(budget.max_seconds(s[stage], RATE), hours * 3600, stage)
        # The embedder and the detector keep the ratio their measured estimates had.
        self.assertAlmostEqual(s["embedder"] / (s["embedder"] + s["detector"]), 0.46, delta=0.02)


class LedgerTest(unittest.TestCase):
    def test_spend_carries_across_attempts_and_a_spent_stage_refuses_to_start(self):
        with tempfile.TemporaryDirectory() as d:
            rate = RATE
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
