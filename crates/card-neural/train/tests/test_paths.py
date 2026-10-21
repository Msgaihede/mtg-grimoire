"""Where a face's scan is: `normal/<2>/<id>.jpg`, falling back to the flat `normal/<id>.jpg`."""
import json
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


class EvidenceClasses(unittest.TestCase):
    """ev_data's classes: the symbol network's (symbol set, rarity, stamp) and where a face's scan
    is; skipped without torch and OpenCV, which ev_data imports."""

    def setUp(self):
        try:
            import cv2  # noqa: F401
            import torch  # noqa: F401
        except ImportError as e:  # torch / OpenCV not installed
            self.skipTest(str(e))
        import ev_data  # its own import error is a failure, not a skip

        self.ev = ev_data

    def test_the_list_shows_its_originals_symbol(self):
        self.assertEqual(self.ev.symbol_class({"set": "plst", "collector_number": "BBD-119", "rarity": "common"}),
                         ("bbd", "common", "none"))

    def test_a_set_shows_its_own_symbol(self):
        self.assertEqual(self.ev.symbol_class({"set": "2x2", "collector_number": "32", "rarity": "rare"}),
                         ("2x2", "rare", "none"))
        # A List card without the prefix keeps The List's own.
        self.assertEqual(self.ev.symbol_class({"set": "plst", "collector_number": "119", "rarity": "rare"}),
                         ("plst", "rare", "none"))

    def test_a_promo_p_set_shows_its_parents_symbol_and_its_stamp(self):
        row = {"set": "pfin", "set_type": "promo", "collector_number": "85p", "rarity": "rare",
               "promo_types": ["promopack", "stamped"], "released_at": "2025-06-13"}
        self.assertEqual(self.ev.symbol_class(row, {"fin", "pfin"}), ("fin", "rare", "pw"))
        # No parent in the dataset: the promo set is its own.
        self.assertEqual(self.ev.symbol_class(row, {"pfin"}), ("pfin", "rare", "pw"))
        # "p" + a code is only a parent for a promo set.
        self.assertEqual(self.ev.symbol_class({"set": "plci", "set_type": "expansion", "rarity": "rare"}, {"lci"}),
                         ("plci", "rare", "none"))

    def test_a_prerelease_datestamp_counts_only_before_2021(self):
        old = {"set": "pktk", "set_type": "promo", "rarity": "mythic", "promo_types": ["datestamped", "prerelease"],
               "released_at": "2014-09-27"}
        new = dict(old, set="psos", released_at="2026-04-18")
        self.assertEqual(self.ev.symbol_class(old, {"ktk"}), ("ktk", "mythic", "date"))
        self.assertEqual(self.ev.symbol_class(new, {"sos"}), ("sos", "mythic", "none"))

    def test_classes_read_a_sharded_dataset(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            rows = [{"id": FRONT, "card_id": FRONT, "oracle_id": "o", "name": "A", "set": "2x2",
                     "collector_number": "1", "rarity": "rare", "promo_types": []},
                    {"id": BACK, "card_id": BACK[:36], "oracle_id": "o", "name": "A", "set": "plst",
                     "collector_number": "2X2-1", "rarity": "rare", "promo_types": []}]
            index = root / "index.jsonl"
            index.write_text("".join(json.dumps(r) + "\n" for r in rows), encoding="utf-8")
            touch(shard_path(root, FRONT))
            touch(shard_path(root, BACK))
            symbol = self.ev.Classes(root, "symbol")
            self.assertEqual(symbol.keys, [("2x2", "rare", "none")])
            self.assertEqual(sorted(symbol.members[0]), sorted([FRONT, BACK]))
            self.assertEqual(symbol.path(BACK), shard_path(root, BACK))
            band = self.ev.Classes(root, "band")
            self.assertEqual(len(band), 2)
            self.assertNotEqual(band.fingerprint(), symbol.fingerprint())
            # An index written before the fields the symbol classes need is refused, not read as "none".
            del rows[1]["promo_types"]
            index.write_text("".join(json.dumps(r) + "\n" for r in rows), encoding="utf-8")
            with self.assertRaises(SystemExit):
                self.ev.Classes(root, "symbol")


if __name__ == "__main__":
    unittest.main()
