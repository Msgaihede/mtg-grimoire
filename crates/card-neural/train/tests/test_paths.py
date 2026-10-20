"""Where a face's scan is: `normal/<2>/<id>.jpg`, falling back to the flat `normal/<id>.jpg`."""
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from looks import flat_path, scan_ids, scan_layout, scan_path, shard_path  # noqa: E402

FRONT = "0000419b-0bba-4488-8f7a-6194544ce91e"
BACK = "ab12cd34-0bba-4488-8f7a-6194544ce91e-1"


def touch(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"\xff\xd8\xff")


class Paths(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        (self.root / "normal").mkdir()

    def tearDown(self):
        self.tmp.cleanup()

    def test_a_shard_is_named_by_the_ids_first_two_characters(self):
        self.assertEqual(shard_path(self.root, FRONT), self.root / "normal" / "00" / f"{FRONT}.jpg")
        self.assertEqual(shard_path(self.root, BACK), self.root / "normal" / "ab" / f"{BACK}.jpg")
        self.assertEqual(flat_path(self.root, BACK), self.root / "normal" / f"{BACK}.jpg")

    def test_a_sharded_dataset_reads_the_sharded_path(self):
        touch(shard_path(self.root, FRONT))
        self.assertEqual(scan_layout(self.root), "sharded")
        self.assertEqual(scan_path(self.root, FRONT, "sharded"), shard_path(self.root, FRONT))
        self.assertEqual(scan_path(self.root, FRONT), shard_path(self.root, FRONT))

    def test_a_flat_dataset_reads_the_flat_path(self):
        touch(flat_path(self.root, FRONT))
        self.assertEqual(scan_layout(self.root), "flat")
        self.assertEqual(scan_path(self.root, FRONT, "flat"), flat_path(self.root, FRONT))
        self.assertEqual(scan_path(self.root, FRONT), flat_path(self.root, FRONT))

    def test_a_mixed_dataset_prefers_the_shard_and_falls_back_to_flat(self):
        touch(flat_path(self.root, FRONT))  # fetched before the shards
        touch(flat_path(self.root, BACK))
        touch(shard_path(self.root, BACK))  # refreshed since: the shard is the newer scan
        self.assertEqual(scan_layout(self.root), "mixed")
        self.assertEqual(scan_path(self.root, FRONT, "mixed"), flat_path(self.root, FRONT))
        self.assertEqual(scan_path(self.root, BACK, "mixed"), shard_path(self.root, BACK))

    def test_an_empty_or_missing_folder_is_sharded(self):
        self.assertEqual(scan_layout(self.root), "sharded")
        self.assertEqual(scan_layout(self.root / "nowhere"), "sharded")

    def test_scan_ids_sees_both_layouts_and_nothing_else(self):
        touch(flat_path(self.root, FRONT))
        touch(shard_path(self.root, BACK))
        (self.root / "normal" / "ab" / f"{BACK}.123.456.part").write_bytes(b"partial")
        (self.root / "normal" / "notes.txt").write_text("not a scan")
        self.assertEqual(scan_ids(self.root), {FRONT, BACK})


class LooksReadsTheLayout(unittest.TestCase):
    """qd_data.Looks (and so every dataset) resolves through scan_path; skipped without torch."""

    def test_looks_path(self):
        try:
            from qd_data import Looks
        except ImportError as e:  # torch / OpenCV not installed
            self.skipTest(str(e))
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "looks.json").write_text('{"looks": []}', encoding="utf-8")
            touch(shard_path(root, BACK))
            looks = Looks(root)
            self.assertEqual(looks.layout, "sharded")
            self.assertEqual(looks.path(BACK), shard_path(root, BACK))
            touch(flat_path(root, FRONT))
            looks = Looks(root)
            self.assertEqual(looks.layout, "mixed")
            self.assertEqual(looks.path(FRONT), flat_path(root, FRONT))
            self.assertEqual(looks.path(BACK), shard_path(root, BACK))


if __name__ == "__main__":
    unittest.main()
