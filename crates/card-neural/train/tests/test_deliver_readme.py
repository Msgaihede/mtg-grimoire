"""`update_readme.py`: the eight rows of `models/README.md` — the web build's pin on the files — and
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

# The printing evidence's four rows: retrained every month beside the embedder and the detector
# (`modal_app.py`'s `train_symbol` and `train_band`), and left alone by a run made before they were.
EVIDENCE = ("symbol.onnx", "band.onnx", "symbols.bin", "bands.bin")
SYMBOL_CLASSES, SYMBOL_PRINTINGS, BAND_FACES = 2004, 106100, 108000


def neural_table(readme: str) -> dict:
    return {m[1]: (int(m[2].replace(" ", "")), m[3], m[4]) for m in NEURAL_TABLE.finditer(readme)}


def done_for(run="2026-11", detector=True, evidence=True, **extra) -> dict:
    metrics = {"embedder": {"retrieval_top1": 0.9995, "epochs": 30, "views_per_s": 540.0, "usd": 1.71}}
    files = {name: f"runs/{run}/embedder/export/{name}" for name in ("embedder.onnx", "gallery.head.matrix", "gallery.json")}
    if detector:
        metrics["detector"] = {"found": 0.991, "corner_err": 0.0281, "corner_err_p90": 0.049,
                               "wrong_way": 0.004, "scenes_per_s": 300.0, "steps": 30000, "usd": 2.02}
        files["detector.onnx"] = f"runs/{run}/detector/export/detector.onnx"
    if evidence:
        metrics["symbol"] = {"within_top1": 0.931, "epochs": 12, "classes": SYMBOL_CLASSES, "views_per_s": 480, "usd": 1.85}
        metrics["band"] = {"within_top1": 0.947, "epochs": 14, "classes": BAND_FACES, "views_per_s": 470, "usd": 2.01}
        for kind in ("symbol", "band"):
            for name in (f"{kind}.onnx", f"{kind}s.matrix", f"{kind}s.json"):
                files[name] = f"runs/{run}/{kind}/export/{name}"
    return {"run": run, "status": "ok", "git_sha": "0123456789abcdef0123456789abcdef01234567",
            "smoke": False, "detector": detector, "metrics": metrics, "files": files,
            "spend_usd": 7.80, "finished_at": "2026-11-01T05:12:00Z", **extra}


def symbols_json(classes=SYMBOL_CLASSES, printings=SYMBOL_PRINTINGS) -> dict:
    """An export's `symbols.json`: one entry a class, covering its printings."""
    per, extra = divmod(printings, classes)
    return {"source": "test", "entries": [{"covers": [f"{c}-{k}" for k in range(per + (c < extra))]} for c in range(classes)]}


def bands_json(faces=BAND_FACES) -> dict:
    return {"source": "test", "entries": [{"covers": [str(f)]} for f in range(faces)]}


class Scratch(unittest.TestCase):
    """A copy of `models/`'s README and training.json beside eight made-up files."""

    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.dir)
        for name in (ur.README, ur.TRAINING_JSON):
            shutil.copyfile(MODELS / name, self.dir / name)
        for i, name in enumerate(ur.FILES):
            (self.dir / name).write_bytes(bytes([i]) * (1000 + 37 * i))
        self.gallery = self.dir / "gallery.json"
        self.gallery.write_text(json.dumps({"source": "test", "entries": [{}] * 70950}), encoding="utf-8")
        self.symbols = self.dir / "symbols.json"
        self.symbols.write_text(json.dumps(symbols_json()), encoding="utf-8")
        self.bands = self.dir / "bands.json"
        self.bands.write_text(json.dumps(bands_json()), encoding="utf-8")

    def update(self, done):
        evidence = (done.get("metrics") or {}).get("symbol") is not None
        return ur.update(self.dir, done, self.gallery, self.symbols if evidence else None,
                         self.bands if evidence else None)

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
    def test_the_script_owns_all_eight_files(self):
        self.assertEqual(sorted(ur.FILES), sorted(("detector.onnx", "embedder.onnx", "gallery.bin", "neural.json") + EVIDENCE))

    def test_lays_out_the_shipped_table_exactly_as_it_is(self):
        lines = (MODELS / ur.README).read_text(encoding="utf-8").split("\n")
        start, end = ur.find_table(lines)
        self.assertEqual(end - start, 2 + len(ur.FILES), "a header, a rule and eight rows")
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
        shipped = neural_table(self.readme())
        self.update(done_for())
        rows = neural_table(self.readme())
        self.assertEqual(sorted(rows), sorted(ur.FILES))
        for name in ur.FILES:
            size, head, tail = rows[name]
            got_size, sha = ur.digest(self.dir / name)
            self.assertEqual((size, head, tail), (got_size, sha[:8], sha[-8:]), name)
            self.assertNotEqual(rows[name], shipped[name], name)

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
        self.assertEqual(text.count("(training run `2026-11`)"), 4, "the four networks' rows")
        for name in ("gallery.bin", "symbols.bin", "bands.bin"):
            gallery = self.row(text, name)
            self.assertNotIn("training run", gallery, "a gallery is described by what it is")
        neural = self.row(text, "neural.json")
        self.assertNotIn("training run", neural, "neural.json is not retrained")

    def row(self, text: str, name: str) -> str:
        return next(line for line in text.split("\n") if line.startswith(f"| `{name}`"))

    def test_brings_the_evidence_rows_counts_up_to_date(self):
        self.update(done_for())
        text = self.readme()
        before = (MODELS / ur.README).read_text(encoding="utf-8")
        symbol = self.row(text, "symbol.onnx")
        self.assertIn("ArcFace over 2 004 classes", symbol)
        self.assertIn(", 12 epochs on", symbol)
        self.assertNotIn("ev-symbol-3", symbol)
        band = self.row(text, "band.onnx")
        self.assertIn("ArcFace over 108 000 printing faces, 14 epochs", band)
        self.assertNotIn("ev-band-2", band)
        self.assertIn("covering every printing that shows it (106 100)", self.row(text, "symbols.bin"))
        self.assertIn("one row a printing face (108 000)", self.row(text, "bands.bin"))
        # The crops' boxes and sizes are the recipe's, not the run's: unchanged.
        self.assertIn("`[0.72, 0.40, 0.985, 0.66]` at 96×128", symbol)
        self.assertIn("`[0.0, 0.80, 0.82, 1.0]` at 256×88", band)
        self.assertIn("`[0.0, 0.80, 0.82, 1.0]` at 256×88", self.row(before, "band.onnx"))

    def test_a_run_from_before_the_evidence_leaves_its_rows_described_as_they_were(self):
        before = self.readme()
        self.update(done_for(evidence=False))
        text = self.readme()
        for name in EVIDENCE:
            self.assertEqual(self.row(text, name).split("|")[4], self.row(before, name).split("|")[4], name)
        self.assertIn("symbol and band networks not retrained (still runs `ev-symbol-3` and `ev-band-2`)", text)
        training = json.loads((self.dir / ur.TRAINING_JSON).read_text(encoding="utf-8"))
        self.assertEqual((training["symbol"]["run"], training["band"]["run"]), ("ev-symbol-3", "ev-band-2"))

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
        self.assertIn("$7.80 on Modal", line)
        self.assertIn("embedder retrieval top-1 0.9995 after 30 epochs, 70 950 looks", line)
        self.assertIn("detector found 0.991, corner error 0.0281 (p90 0.049), wrong way 0.004 after 30 000 steps", line)
        self.assertIn("symbol within-card top-1 0.931 after 12 epochs, 2 004 classes", line)
        self.assertIn("band within-card top-1 0.947 after 14 epochs, 108 000 classes", line)
        self.assertEqual(text.count("(training run `2026-12`)"), 4)
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
        self.assertEqual(on_disk["symbol"]["metrics"]["within_top1"], 0.931)
        self.assertEqual(on_disk["symbol"]["classes"], 2004)
        self.assertEqual(on_disk["band"]["metrics"]["epochs"], 14)
        self.assertEqual(on_disk["band"]["classes"], 108000)
        self.assertEqual(on_disk["last_run"]["retrained"], ["embedder", "detector", "symbol", "band"])
        self.assertEqual(on_disk["last_run"]["spend_usd"], 7.80)
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

    def test_training_json_holds_the_labs_numbers_for_the_shipped_evidence(self):
        seed = json.loads((MODELS / ur.TRAINING_JSON).read_text(encoding="utf-8"))
        self.assertEqual((seed["symbol"]["run"], seed["symbol"]["classes"]), ("ev-symbol-3", 1999))
        self.assertEqual(seed["symbol"]["metrics"], {"within_top1": 0.927, "epochs": 16})
        self.assertEqual((seed["band"]["run"], seed["band"]["classes"]), ("ev-band-2", 107109))
        self.assertEqual(seed["band"]["metrics"], {"within_top1": 0.946, "epochs": 20})


if __name__ == "__main__":
    unittest.main()
