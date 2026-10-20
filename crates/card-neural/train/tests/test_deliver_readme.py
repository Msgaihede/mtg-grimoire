"""`update_readme.py`: the four rows of `models/README.md` — the web build's pin on the files — and
`training.json`, rewritten for a delivered run.

    python -m unittest discover -s crates/card-neural/train/tests -p "test_deliver*.py"
"""
import json
import re
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import update_readme as ur  # noqa: E402

MODELS = Path(__file__).resolve().parents[2] / "models"
ASSETS = Path(__file__).resolve().parents[4] / "packages" / "ui" / "lib" / "core" / "web" / "assets.ts"


def _neural_table_pattern() -> re.Pattern:
    """`neuralTable`'s own pattern, read out of `assets.ts` — what the web build holds the README
    to — so a change there is a change here. Its syntax is one Python's `re` reads as JavaScript does."""
    source = ASSETS.read_text(encoding="utf-8")
    body = source[source.index("export function neuralTable"):]
    found = re.search(r"const row = /(.+)/gm;", body)
    if found is None:
        raise AssertionError(f"no `const row = /…/gm;` in neuralTable ({ASSETS}): the test reads the pattern from there")
    return re.compile(found[1], re.M)


NEURAL_TABLE = _neural_table_pattern()


def neural_table(readme: str) -> dict:
    return {m[1]: (int(m[2].replace(" ", "")), m[3], m[4]) for m in NEURAL_TABLE.finditer(readme)}


def done_for(run="2026-11", detector=True, **extra) -> dict:
    metrics = {"embedder": {"retrieval_top1": 0.9995, "epochs": 30, "views_per_s": 540.0, "usd": 1.71}}
    files = {name: f"runs/{run}/embedder/export/{name}" for name in ("embedder.onnx", "gallery.head.matrix", "gallery.json")}
    if detector:
        metrics["detector"] = {"found": 0.991, "corner_err": 0.0281, "corner_err_p90": 0.049,
                               "wrong_way": 0.004, "scenes_per_s": 300.0, "steps": 30000, "usd": 2.02}
        files["detector.onnx"] = f"runs/{run}/detector/export/detector.onnx"
    return {"run": run, "status": "ok", "git_sha": "0123456789abcdef0123456789abcdef01234567",
            "smoke": False, "detector": detector, "metrics": metrics, "files": files,
            "spend_usd": 3.94, "finished_at": "2026-11-01T05:12:00Z", **extra}


class Scratch(unittest.TestCase):
    """A copy of `models/`'s README and training.json beside four made-up files."""

    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.dir)
        for name in (ur.README, ur.TRAINING_JSON):
            shutil.copyfile(MODELS / name, self.dir / name)
        for i, name in enumerate(ur.FILES):
            (self.dir / name).write_bytes(bytes([i]) * (1000 + 37 * i))
        self.gallery = self.dir / "gallery.json"
        self.gallery.write_text(json.dumps({"source": "test", "entries": [{}] * 70950}), encoding="utf-8")

    def update(self, done):
        return ur.update(self.dir, done, self.gallery)

    def readme(self) -> str:
        return (self.dir / ur.README).read_text(encoding="utf-8")


class Numbers(unittest.TestCase):
    def test_groups_thousands_with_the_space_the_table_has(self):
        self.assertEqual(ur.group(2443078), "2 443 078")
        self.assertEqual(ur.group(602), "602")
        self.assertEqual(ur.group(70402), "70 402")
        # An ASCII space: `neuralTable`'s pattern reads `[\d ]`, and a thin space would end the row.
        self.assertNotIn(" ", ur.group(10602685))

    def test_prints_metrics_as_reported(self):
        self.assertEqual(ur.number(0.9997), "0.9997")
        self.assertEqual(ur.number(30000), "30 000")
        self.assertEqual(ur.number(16.0), "16")
        self.assertEqual(ur.number(None), "—")


class TheTableAsItIs(unittest.TestCase):
    def test_lays_out_the_shipped_table_exactly_as_it_is(self):
        lines = (MODELS / ur.README).read_text(encoding="utf-8").split("\n")
        start, end = ur.find_table(lines)
        self.assertEqual(end - start, 6, "a header, a rule and four rows")
        self.assertEqual(ur.render_table(*ur.parse_table(lines[start:end])), lines[start:end])

    def test_the_shipped_readme_pins_the_shipped_files(self):
        # The same check the web build makes: so the table this script rewrites is the one it reads.
        rows = neural_table((MODELS / ur.README).read_text(encoding="utf-8"))
        self.assertEqual(sorted(rows), sorted(ur.FILES))
        for name, (size, head, tail) in rows.items():
            got_size, sha = ur.digest(MODELS / name)
            self.assertEqual((size, head, tail), (got_size, sha[:8], sha[-8:]), name)


class Rewrite(Scratch):
    def test_every_row_is_read_from_the_file_on_disk(self):
        self.update(done_for())
        rows = neural_table(self.readme())
        self.assertEqual(sorted(rows), sorted(ur.FILES))
        for name, (size, head, tail) in rows.items():
            got_size, sha = ur.digest(self.dir / name)
            self.assertEqual((size, head, tail), (got_size, sha[:8], sha[-8:]), name)

    def test_keeps_the_table_aligned(self):
        self.update(done_for())
        lines = self.readme().split("\n")
        start, end = ur.find_table(lines)
        self.assertEqual(len({len(line) for line in lines[start:end]}), 1, "every line as wide as the header")
        self.assertRegex(lines[start + 1], r"^\| -+ \| -+: \| -+ \| -+ \|$", "bytes right-aligned")

    def test_brings_a_changed_files_description_up_to_date(self):
        self.update(done_for())
        text = self.readme()
        self.assertIn("ArcFace over 70 950 looks, 30 epochs", text)
        self.assertIn("trained 30 000 steps on synthetic scenes", text)
        self.assertNotIn("det-a", text.split("**Last trained**")[0])
        self.assertNotIn("qd-mnv4-e", text.split("**Last trained**")[0])
        self.assertEqual(text.count("(training run `2026-11`)"), 2, "the embedder's and the detector's rows")
        gallery = next(line for line in text.split("\n") if line.startswith("| `gallery.bin`"))
        self.assertNotIn("training run", gallery, "a gallery is described by what it is")
        neural = next(line for line in text.split("\n") if line.startswith("| `neural.json`"))
        self.assertNotIn("training run", neural, "neural.json is not retrained")

    def test_a_run_without_the_detector_leaves_its_row_alone(self):
        before = next(line for line in self.readme().split("\n") if line.startswith("| `detector.onnx`"))
        self.update(done_for(detector=False))
        text = self.readme()
        after = next(line for line in text.split("\n") if line.startswith("| `detector.onnx`"))
        self.assertEqual(after.split("|")[4].strip(), before.split("|")[4].strip())
        self.assertIn("detector not retrained (still run `det-a`'s)", text)
        training = json.loads((self.dir / ur.TRAINING_JSON).read_text(encoding="utf-8"))
        self.assertEqual(training["detector"]["run"], "det-a")
        self.assertEqual(training["embedder"]["run"], "2026-11")

    def test_writes_one_provenance_line_and_replaces_it_next_time(self):
        self.update(done_for())
        self.update(done_for(run="2026-12", finished_at="2026-12-01T04:00:00Z"))
        text = self.readme()
        self.assertEqual(text.count("**Last trained**"), 1)
        line = next(line for line in text.split("\n") if line.startswith("**Last trained**"))
        self.assertIn("run `2026-12`", line)
        self.assertIn("finished 2026-12-01 from commit `01234567`", line)
        self.assertIn("$3.94 on Modal", line)
        self.assertIn("embedder retrieval top-1 0.9995 after 30 epochs, 70 950 looks", line)
        self.assertIn("detector found 0.991, corner error 0.0281 (p90 0.049), wrong way 0.004 after 30 000 steps", line)
        self.assertEqual(text.count("(training run `2026-12`)"), 2)
        self.assertNotIn("2026-11", text)
        # Below the table, above the paragraph that held it first.
        lines = text.split("\n")
        _, end = ur.find_table(lines)
        self.assertEqual(lines[end:end + 2], ["", line])

    def test_rewrites_training_json_with_the_networks_it_retrained(self):
        new = self.update(done_for())
        on_disk = json.loads((self.dir / ur.TRAINING_JSON).read_text(encoding="utf-8"))
        self.assertEqual(new, on_disk)
        self.assertEqual(on_disk["embedder"]["looks"], 70950)
        self.assertEqual(on_disk["embedder"]["metrics"]["retrieval_top1"], 0.9995)
        self.assertEqual(on_disk["detector"]["metrics"]["corner_err_p90"], 0.049)
        self.assertEqual(on_disk["last_run"]["retrained"], ["embedder", "detector"])
        self.assertEqual(on_disk["last_run"]["spend_usd"], 3.94)
        self.assertIn("about", on_disk)

    def test_refuses_a_table_missing_a_file(self):
        text = self.readme().replace("| `neural.json`", "| `other.json`")
        (self.dir / ur.README).write_text(text, encoding="utf-8")
        with self.assertRaises(ValueError):
            self.update(done_for())


class Seed(unittest.TestCase):
    def test_training_json_holds_the_labs_numbers_for_the_shipped_pair(self):
        seed = json.loads((MODELS / ur.TRAINING_JSON).read_text(encoding="utf-8"))
        self.assertEqual(seed["embedder"]["metrics"]["retrieval_top1"], 0.9997)
        self.assertEqual(seed["embedder"]["metrics"]["epochs"], 30)
        self.assertEqual(seed["embedder"]["looks"], 70402)
        self.assertEqual(seed["detector"]["metrics"], {"found": 0.993, "corner_err": 0.0277, "corner_err_p90": 0.0483,
                                                       "wrong_way": 0.0033, "steps": 30000})


if __name__ == "__main__":
    unittest.main()
