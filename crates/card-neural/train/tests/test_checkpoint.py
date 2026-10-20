"""runs.py: the atomic checkpoint a preempted trainer resumes from, and the log it reconciles."""
import argparse
import json
import os
import random
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import numpy as np
import torch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import runs  # noqa: E402


def draws() -> tuple:
    cuda = torch.rand(3, device="cuda").tolist() if torch.cuda.is_available() else []
    return (torch.rand(3).tolist(), cuda, np.random.rand(3).tolist(), np.random.standard_normal(3).tolist(),
            [random.random() for _ in range(3)])


class Checkpoint(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.run = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_round_trip_restores_weights_optimizer_and_random_states(self):
        model = torch.nn.Linear(4, 2)
        opt = torch.optim.AdamW(model.parameters(), lr=1e-3)
        model(torch.randn(5, 4)).sum().backward()
        opt.step()
        np.random.standard_normal()  # leaves a cached Gaussian in NumPy's state (has_gauss)
        state = {"model": model.state_dict(), "optimizer": opt.state_dict(), "step": 7, "epoch": 2, "best": 0.5,
                 "rows": [{"epoch": 1, "loss": 1.0}, {"epoch": 2, "loss": 0.5}], "rng": runs.rng_state(),
                 "args": {"epochs": 30, "lr": 2e-3, "data": "x", "resume": None}}
        expected = draws()
        runs.atomic_save(state, self.run / runs.CHECKPOINT)
        draws()  # move every generator on

        got = runs.load_checkpoint(self.run)  # weights_only=True: plain types and tensors only
        self.assertEqual((got["step"], got["epoch"], got["best"], got["rows"], got["args"]),
                         (7, 2, 0.5, state["rows"], state["args"]))
        fresh = torch.nn.Linear(4, 2)
        fresh.load_state_dict(got["model"])
        for a, b in zip(model.parameters(), fresh.parameters()):
            self.assertTrue(torch.equal(a, b))
        opt2 = torch.optim.AdamW(fresh.parameters(), lr=1e-3)
        opt2.load_state_dict(got["optimizer"])
        self.assertTrue(torch.equal(opt2.state_dict()["state"][0]["exp_avg"], opt.state_dict()["state"][0]["exp_avg"]))
        runs.set_rng_state(got["rng"])
        self.assertEqual(draws(), expected)
        self.assertEqual(sorted(p.name for p in self.run.iterdir()), [runs.CHECKPOINT])

    def test_no_checkpoint_is_none(self):
        self.assertIsNone(runs.load_checkpoint(self.run))

    def test_a_save_that_fails_leaves_the_previous_checkpoint_whole(self):
        path = self.run / runs.CHECKPOINT
        runs.atomic_save({"step": 1}, path)
        with mock.patch.object(torch, "save", side_effect=KeyboardInterrupt):  # killed mid-write
            with self.assertRaises(KeyboardInterrupt):
                runs.atomic_save({"step": 2}, path)
        self.assertEqual(runs.load_checkpoint(self.run)["step"], 1)
        self.assertEqual([p.name for p in self.run.iterdir()], [runs.CHECKPOINT])

    def test_clear_partials_removes_only_temporary_files(self):
        (self.run / f"last.pt.{os.getpid()}.tmp").write_bytes(b"torn")
        (self.run / "last.pt").write_bytes(b"whole")
        runs.clear_partials(self.run)
        self.assertEqual([p.name for p in self.run.iterdir()], ["last.pt"])

    def test_check_recipe_refuses_other_arguments(self):
        ckpt = {"args": {"epochs": 30, "lr": 2e-3, "workers": 20}}
        runs.check_recipe(ckpt, argparse.Namespace(epochs=30, lr=2e-3, workers=6), ("epochs", "lr"), self.run)
        with self.assertRaises(SystemExit) as e:
            runs.check_recipe(ckpt, argparse.Namespace(epochs=2, lr=2e-3, workers=20), ("epochs", "lr"), self.run)
        self.assertIn("--epochs 30 there, 2 now", str(e.exception))


class Log(unittest.TestCase):
    def test_reconcile_appends_only_what_is_missing_and_is_idempotent(self):
        with tempfile.TemporaryDirectory() as tmp:
            log = Path(tmp) / "log.jsonl"
            rows = [{"epoch": 1, "loss": 2.0}, {"epoch": 2, "loss": 1.0}]
            log.write_text(json.dumps(rows[0]) + "\n" + '{"epoch": 2, "lo', encoding="utf-8")  # killed mid-line
            done = {"done": True, "epoch": 2}
            runs.reconcile_log(log, rows, "epoch", done)
            runs.reconcile_log(log, rows, "epoch", done)
            parsed = []
            for line in log.read_text(encoding="utf-8").splitlines():
                try:
                    parsed.append(json.loads(line))
                except json.JSONDecodeError:
                    pass
            self.assertEqual(parsed, rows + [done])


if __name__ == "__main__":
    unittest.main()
