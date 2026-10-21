"""`deliver.py`: which run a delivery takes, what it downloads, the pull request it writes, and that
a dry run leaves the repository's `models/` alone. Over a folder laid out as the Volume is — no
Modal, no cargo, no git.

    python -m unittest discover -s crates/card-neural/train/tests -p "test_deliver*.py"
"""
import hashlib
import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import deliver  # noqa: E402
import update_readme as ur  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_deliver_readme import EVIDENCE, bands_json, done_for, neural_table, symbols_json  # noqa: E402


def write_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value), encoding="utf-8")


def make_run(root: Path, run: str, status="ok", detector=True, smoke=False, delivered=None, done=True, looks=70950,
             evidence=True):
    base = root / "runs" / run
    write_json(base / "run.json", {"run": run, "git_sha": "0123456789abcdef", "started_at": "2026-11-01T03:41:00Z",
                                   "detector": detector, "smoke": smoke, "budget_usd": 10.0,
                                   "resources": {"gpu": "L4", "cpu": 16.0, "memory_gib": 24.0}})
    if done:
        d = done_for(run=run, detector=detector, smoke=smoke, evidence=evidence)
        d["status"] = status
        if status != "ok":
            d["reason"] = "embedder: TimeoutError: out of budget"
        write_json(base / "DONE.json", d)
    export = base / "embedder" / "export"
    export.mkdir(parents=True, exist_ok=True)
    (export / "embedder.onnx").write_bytes(b"embedder " + run.encode())
    (export / "gallery.head.matrix").write_bytes(b"NSGALLR1" + bytes(8))
    write_json(export / "gallery.json", {"source": run, "entries": [{}] * looks})
    if detector:
        (base / "detector" / "export").mkdir(parents=True, exist_ok=True)
        (base / "detector" / "export" / "detector.onnx").write_bytes(b"detector " + run.encode())
    if evidence:
        for kind, gallery in (("symbol", symbols_json(20, 50)), ("band", bands_json(30))):
            export = base / kind / "export"
            export.mkdir(parents=True, exist_ok=True)
            (export / f"{kind}.onnx").write_bytes(f"{kind} {run}".encode())
            (export / f"{kind}s.matrix").write_bytes(b"NSGALLR1" + kind.encode())
            write_json(export / f"{kind}s.json", gallery)
    if delivered is not None:
        write_json(base / "DELIVERED.json", delivered)


class Workspace(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp)
        self.volume = self.tmp / "volume"
        self.volume.mkdir()
        self.store = deliver.DirStore(self.volume)
        self.outputs = self.tmp / "github_output"
        self.summary = self.tmp / "github_step_summary"
        env = mock.patch.dict(os.environ, {"GITHUB_OUTPUT": str(self.outputs), "GITHUB_STEP_SUMMARY": str(self.summary)})
        env.start()
        self.addCleanup(env.stop)
        for key in ("GITHUB_SERVER_URL", "GITHUB_REPOSITORY", "GITHUB_RUN_ID", "GITHUB_ACTIONS"):
            os.environ.pop(key, None)
        quiet = mock.patch("builtins.print")
        quiet.start()
        self.addCleanup(quiet.stop)

    def output(self) -> dict:
        lines = self.outputs.read_text(encoding="utf-8").splitlines() if self.outputs.exists() else []
        return dict(line.split("=", 1) for line in lines)


class Find(Workspace):
    def test_takes_the_oldest_finished_run_and_reports_every_run(self):
        make_run(self.volume, "2026-10", delivered={"pr": "https://github.com/o/r/pull/1", "delivered_at": "x"})
        make_run(self.volume, "2026-11-05-1200")
        make_run(self.volume, "2026-11")
        make_run(self.volume, "2026-12", done=False)
        (self.volume / "runs" / "scratch").mkdir()
        picked = deliver.find(self.store, out=self.tmp / "in")
        self.assertEqual(picked, {"run": "2026-11", "smoke": False})
        self.assertEqual(self.output(), {"failed": "false", "run": "2026-11", "smoke": "false"})
        text = self.summary.read_text(encoding="utf-8")
        self.assertIn("| `2026-12` | training | started 2026-11-01T03:41:00Z |", text)
        self.assertIn("| `2026-10` | delivered | https://github.com/o/r/pull/1 |", text)
        self.assertIn("1 more finished run(s) wait for the next delivery: `2026-11-05-1200`", text)
        self.assertIn("Ignored, not run names: `scratch`", text)

    def test_downloads_what_the_build_needs(self):
        make_run(self.volume, "2026-11")
        write_json(self.volume / "data" / "scryfall" / "fetch.json", {"fetched_at": "2026-11-01T03:50:00Z"})
        deliver.find(self.store, out=self.tmp / "in")
        got = sorted(p.name for p in (self.tmp / "in").iterdir())
        self.assertEqual(got, ["DONE.json", "band.onnx", "bands.json", "bands.matrix", "detector.onnx", "embedder.onnx",
                               "fetch.json", "gallery.head.matrix", "gallery.json", "run.json", "symbol.onnx",
                               "symbols.json", "symbols.matrix"])

    def test_a_run_without_the_detector_downloads_none(self):
        make_run(self.volume, "2026-11", detector=False)
        deliver.find(self.store, out=self.tmp / "in")
        self.assertFalse((self.tmp / "in" / "detector.onnx").exists())

    def test_a_run_from_before_the_evidence_downloads_none_of_it(self):
        make_run(self.volume, "2026-11", evidence=False)
        deliver.find(self.store, out=self.tmp / "in")
        got = {p.name for p in (self.tmp / "in").iterdir()}
        self.assertFalse(got & {"symbol.onnx", "symbols.matrix", "symbols.json", "band.onnx", "bands.matrix", "bands.json"})

    def test_reports_a_failed_run_once_and_marks_it(self):
        make_run(self.volume, "2026-11", status="failed")
        self.assertIsNone(deliver.find(self.store, out=self.tmp / "in"))
        self.assertEqual(self.output(), {"failed": "true", "run": "", "smoke": "false"})
        self.assertIn("**Run `2026-11` failed and is not delivered**: embedder: TimeoutError",
                      self.summary.read_text(encoding="utf-8"))
        marked = json.loads((self.volume / "runs" / "2026-11" / "DELIVERED.json").read_text(encoding="utf-8"))
        self.assertEqual((marked["pr"], marked["failed"]), (None, True))
        self.outputs.unlink()
        self.assertIsNone(deliver.find(self.store))
        self.assertEqual(self.output()["failed"], "false", "reported once")

    def test_a_finished_run_missing_a_file_is_reported_and_the_next_delivered(self):
        make_run(self.volume, "2026-11")
        make_run(self.volume, "2026-12")
        (self.volume / "runs" / "2026-11" / "embedder" / "export" / "gallery.json").unlink()
        self.assertEqual(deliver.find(self.store, out=self.tmp / "in")["run"], "2026-12")
        self.assertEqual(self.output()["failed"], "true")
        marked = json.loads((self.volume / "runs" / "2026-11" / "DELIVERED.json").read_text(encoding="utf-8"))
        self.assertIn("gallery.json` is not on the Volume", marked["reason"])

    def test_keeps_a_reason_to_one_table_cell(self):
        make_run(self.volume, "2026-11", status="failed")
        done = self.volume / "runs" / "2026-11" / "DONE.json"
        d = json.loads(done.read_text(encoding="utf-8"))
        d["reason"] = "Traceback:\n  a | b\n" + "x" * 1000
        done.write_text(json.dumps(d), encoding="utf-8")
        deliver.find(self.store, mark_failed=False)
        row = next(line for line in self.summary.read_text(encoding="utf-8").splitlines() if line.startswith("| `2026-11`"))
        self.assertIn("Traceback: a \\| b xxx", row)
        self.assertLess(len(row), 400)

    def test_a_dry_run_marks_nothing(self):
        make_run(self.volume, "2026-11", status="failed")
        deliver.find(self.store, mark_failed=False)
        self.assertFalse((self.volume / "runs" / "2026-11" / "DELIVERED.json").exists())

    def test_a_named_run_is_the_only_one_looked_at(self):
        make_run(self.volume, "2026-11")
        make_run(self.volume, "2026-11-05-1200")
        self.assertEqual(deliver.find(self.store, "2026-11-05-1200")["run"], "2026-11-05-1200")

    def test_a_named_run_already_delivered_is_left_alone(self):
        make_run(self.volume, "2026-11", delivered={"pr": "https://github.com/o/r/pull/9", "delivered_at": "x"})
        self.assertIsNone(deliver.find(self.store, "2026-11"))
        self.assertIn("Run `2026-11` is not one to deliver now (delivered)", self.summary.read_text(encoding="utf-8"))

    def test_refuses_a_name_that_is_not_a_run(self):
        for name in ("../x", "2026-11; rm -rf /", "main", "2026-1", "2026-11\n"):
            with self.assertRaises(deliver.Refused, msg=name):
                deliver.find(self.store, name)
        with self.assertRaises(deliver.Refused):
            deliver.find(self.store, "2027-01")  # well formed, not on the Volume

    def test_a_smoke_run_says_so(self):
        make_run(self.volume, "2026-11-05-1200-smoke", smoke=True)
        self.assertEqual(deliver.find(self.store)["smoke"], True)
        self.assertEqual(self.output()["smoke"], "true")

    def test_an_empty_volume_is_nothing_to_do(self):
        self.assertIsNone(deliver.find(self.store))
        self.assertIn("No training run", self.summary.read_text(encoding="utf-8"))


class VolumePaths(unittest.TestCase):
    def test_reads_done_jsons_files_or_the_plans_layout(self):
        self.assertEqual(deliver.volume_path("2026-11", "gallery.json", None), "runs/2026-11/embedder/export/gallery.json")
        self.assertEqual(deliver.volume_path("2026-11", "detector.onnx", {"detector.onnx": "/vol/runs/2026-11/d/x.onnx"}),
                         "runs/2026-11/d/x.onnx")

    def test_holds_a_download_to_the_runs_own_folder(self):
        for path in ("runs/2026-10/embedder/export/embedder.onnx", "data/scryfall/index.jsonl",
                     "runs/2026-11/../2026-10/embedder.onnx"):
            with self.assertRaises(deliver.Refused, msg=path):
                deliver.volume_path("2026-11", "embedder.onnx", {"embedder.onnx": path})


class Body(unittest.TestCase):
    before = json.loads((Path(deliver.REPO) / deliver.MODELS / ur.TRAINING_JSON).read_text(encoding="utf-8"))
    info = {"budget_usd": 10.0, "resources": {"gpu": "L4", "cpu": 16.0, "memory_gib": 24.0}}

    def test_opens_with_what_changes_for_a_person_scanning_cards(self):
        body = deliver.pr_body(done_for(), self.info, self.before, 70950, {"fetched_at": "2026-11-01T03:50:00Z"})
        lead = body.split("\n\n")[0]
        self.assertTrue(lead.startswith("The Scanner's **Neural** mode knows the cards printed up to 2026-11-01"))
        self.assertIn("70 950 card pictures apart, 548 more than before", lead)
        self.assertIn("Its card finder was retrained too, and so were the set symbol and collector band networks", lead)
        self.assertNotIn("|", lead)

    def test_sets_the_run_beside_the_current_files(self):
        body = deliver.pr_body(done_for(), self.info, self.before, 70950)
        self.assertIn("| embedder: retrieval top-1 (higher is better) | 0.9995 | 0.9997 |", body)
        self.assertIn("| gallery: looks | 70 950 | 70 402 |", body)
        self.assertIn("| detector: cards found (higher is better) | 0.991 | 0.993 |", body)
        self.assertIn("| detector: corner error, 90th percentile | 0.049 | 0.0483 |", body)
        self.assertIn("| detector: wrong way up (lower is better) | 0.004 | 0.0033 |", body)
        self.assertIn("the embedder from run `qd-mnv4-e` (scanner lab)", body)
        self.assertIn("| symbol: within-card top-1 (higher is better) | 0.931 | 0.927 |", body)
        self.assertIn("| symbol: classes | 2 004 | 1 999 |", body)
        self.assertIn("| band: within-card top-1 (higher is better) | 0.947 | 0.946 |", body)
        self.assertIn("| band: epochs | 14 | 20 |", body)
        self.assertIn("the symbol network from run `ev-symbol-3` (scanner lab)", body)

    def test_a_run_from_before_the_evidence_says_its_files_stay(self):
        body = deliver.pr_body(done_for(evidence=False), self.info, self.before, 70950)
        self.assertNotIn("symbol: within-card", body)
        self.assertIn("`symbol.onnx`, `band.onnx` and their galleries stay as they are", body)

    def test_names_the_spend_and_the_caveat(self):
        body = deliver.pr_body(done_for(), self.info, self.before, 70950, link="https://github.com/o/r/actions/runs/1")
        self.assertIn("**$7.80** on Modal for the whole run, against its budget of $10.00 (embedder $1.71, detector $2.02, "
                      "symbol $1.85, band $2.01", body)
        self.assertIn("one L4 with 16 cores and 24 GiB", body)
        self.assertIn("`neural.json`'s thresholds were tuned for the previous pair", body)
        self.assertIn("`pnpm scanner:replay`", body)
        self.assertIn("[`neural-deliver.yml`](https://github.com/o/r/actions/runs/1)", body)
        self.assertIn("`cargo test -p card-neural` passed on them.", body)

    def test_a_run_without_the_detector_says_it_stays(self):
        body = deliver.pr_body(done_for(detector=False), self.info, self.before, 70402)
        self.assertIn("Its card finder is unchanged.", body)
        self.assertIn("as many as before", body)
        self.assertIn("`detector.onnx` stays as it is", body)
        self.assertNotIn("detector: cards found", body)

    def test_a_smoke_run_is_marked_as_one(self):
        body = deliver.pr_body(done_for(run="2026-11-05-1200-smoke", smoke=True), self.info, self.before, 70950, tested=False)
        self.assertTrue(body.startswith("> **Smoke run**"))
        self.assertIn("not tested (a dry run or a smoke run)", body)

    def test_the_title_is_a_conventional_commit(self):
        self.assertEqual(deliver.title("2026-11"), "feat(scanner): retrain the Neural models (2026-11)")


def tree_digest(folder: Path) -> dict:
    return {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(folder.iterdir()) if p.is_file()}


class Build(Workspace):
    def fake_gallery(self, repo, matrix, gallery, out):
        self.assertTrue(matrix.is_absolute() and gallery.is_absolute() and out.is_absolute())
        out.write_bytes(b"CNGALLR1 built from " + matrix.read_bytes())

    def no_tests(self, repo):
        self.fail("a scratch build runs no test")

    def test_a_delivery_commits_the_eight_files_the_readme_and_training_json(self):
        self.assertEqual(sorted(deliver.DELIVERED), sorted([
            "detector.onnx", "embedder.onnx", "gallery.bin", "neural.json", "symbol.onnx", "band.onnx",
            "symbols.bin", "bands.bin", "README.md", "training.json"]))

    def test_a_scratch_build_writes_the_delivery_and_leaves_models_alone(self):
        make_run(self.volume, "2026-11")
        deliver.find(self.store, out=self.tmp / "in")
        real = Path(deliver.REPO) / deliver.MODELS
        before = tree_digest(real)
        built = []
        def gallery(repo, matrix, gallery, out):
            built.append((matrix.name, gallery.name, out.name))
            self.fake_gallery(repo, matrix, gallery, out)
        delivery = deliver.build(self.tmp / "in", self.tmp / "out", scratch=True,
                                 make_gallery=gallery, run_tests=self.no_tests)
        self.assertEqual(tree_digest(real), before, "the repository's models/ untouched")
        # Each gallery from its own export: the evidence's from the mean rows, as the lab built them.
        self.assertEqual(sorted(built), [("bands.matrix", "bands.json", "bands.bin"),
                                         ("gallery.head.matrix", "gallery.json", "gallery.bin"),
                                         ("symbols.matrix", "symbols.json", "symbols.bin")])
        staged = self.tmp / "out" / "models"
        self.assertEqual(sorted(p.name for p in staged.iterdir()), sorted(deliver.DELIVERED))
        self.assertEqual((staged / "embedder.onnx").read_bytes(), b"embedder 2026-11")
        self.assertEqual((staged / "detector.onnx").read_bytes(), b"detector 2026-11")
        self.assertEqual((staged / "symbol.onnx").read_bytes(), b"symbol 2026-11")
        self.assertEqual((staged / "band.onnx").read_bytes(), b"band 2026-11")
        self.assertEqual((staged / "bands.bin").read_bytes(), b"CNGALLR1 built from NSGALLR1band")
        self.assertEqual((staged / "neural.json").read_bytes(), (real / "neural.json").read_bytes(), "hand-kept")
        rows = neural_table((staged / ur.README).read_text(encoding="utf-8"))
        for name in ur.FILES:
            size, head, tail = rows[name]
            sha = hashlib.sha256((staged / name).read_bytes()).hexdigest()
            self.assertEqual((size, head, tail), ((staged / name).stat().st_size, sha[:8], sha[-8:]), name)
        self.assertEqual(delivery, {"run": "2026-11", "smoke": False, "branch": "neural-models/2026-11",
                                    "title": "feat(scanner): retrain the Neural models (2026-11)",
                                    "retrained": ["embedder", "detector", "symbol", "band"], "tested": False})
        self.assertEqual(json.loads((self.tmp / "out" / "delivery.json").read_text(encoding="utf-8")), delivery)
        self.assertIn("## Before merging", (self.tmp / "out" / "pr-body.md").read_text(encoding="utf-8"))

    def test_a_run_from_before_the_evidence_keeps_the_evidence_files(self):
        make_run(self.volume, "2026-11", evidence=False)
        deliver.find(self.store, out=self.tmp / "in")
        real = Path(deliver.REPO) / deliver.MODELS
        delivery = deliver.build(self.tmp / "in", self.tmp / "out", scratch=True,
                                 make_gallery=self.fake_gallery, run_tests=self.no_tests)
        staged = self.tmp / "out" / "models"
        for name in EVIDENCE:
            self.assertEqual((staged / name).read_bytes(), (real / name).read_bytes(), name)
        self.assertEqual(delivery["retrained"], ["embedder", "detector"])

    def test_a_smoke_run_is_built_in_scratch_whatever_it_is_asked(self):
        make_run(self.volume, "2026-11-05-1200-smoke", smoke=True)
        deliver.find(self.store, out=self.tmp / "in")
        real = Path(deliver.REPO) / deliver.MODELS
        before = tree_digest(real)
        delivery = deliver.build(self.tmp / "in", self.tmp / "out", scratch=False,
                                 make_gallery=self.fake_gallery, run_tests=self.no_tests)
        self.assertEqual(tree_digest(real), before)
        self.assertEqual((delivery["smoke"], delivery["tested"]), (True, False))
        self.assertEqual(deliver.publish(self.tmp / "out"), "", "never a pull request")

    def test_publish_refuses_an_untested_delivery(self):
        make_run(self.volume, "2026-11")
        deliver.find(self.store, out=self.tmp / "in")
        deliver.build(self.tmp / "in", self.tmp / "out", scratch=True, make_gallery=self.fake_gallery,
                      run_tests=self.no_tests)
        with self.assertRaises(deliver.Refused):
            deliver.publish(self.tmp / "out")


class Mark(Workspace):
    def test_writes_delivered_json(self):
        make_run(self.volume, "2026-11")
        deliver.mark(self.store, "2026-11", "https://github.com/o/r/pull/7")
        record = json.loads((self.volume / "runs" / "2026-11" / "DELIVERED.json").read_text(encoding="utf-8"))
        self.assertEqual(record["pr"], "https://github.com/o/r/pull/7")
        self.assertRegex(record["delivered_at"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$")
        self.assertIsNone(deliver.find(self.store))

    def test_a_smoke_run_is_marked_without_a_pull_request(self):
        make_run(self.volume, "2026-11-05-1200-smoke", smoke=True)
        record = deliver.mark(self.store, "2026-11-05-1200-smoke", "", smoke=True)
        self.assertEqual((record["pr"], record["smoke"]), (None, True))


if __name__ == "__main__":
    unittest.main()
