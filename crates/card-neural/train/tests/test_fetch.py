"""scryfall_fetch.py's incremental refresh: what a re-run downloads, and the record it keeps."""
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from scryfall_fetch import plan, read_urls, select, write_manifest  # noqa: E402

OLD = "https://cards.scryfall.io/normal/front/a/a/aa.jpg?1700000000"
NEW = "https://cards.scryfall.io/normal/front/a/a/aa.jpg?1790000000"


def row(fid: str, url: str) -> dict:
    return {"id": fid, "url": url, "name": fid}


class Plan(unittest.TestCase):
    def test_a_face_with_no_scan_is_new(self):
        todo, adopt = plan([row("a", NEW)], fetched={}, on_disk=set())
        self.assertEqual([(r["id"], why) for r, why in todo], [("a", "new")])
        self.assertEqual(adopt, {})

    def test_a_scan_from_the_same_url_is_left_alone(self):
        todo, adopt = plan([row("a", NEW)], fetched={"a": NEW}, on_disk={"a"})
        self.assertEqual(todo, [])
        self.assertEqual(adopt, {})

    def test_a_scan_whose_url_changed_is_fetched_again(self):
        todo, adopt = plan([row("a", NEW)], fetched={"a": OLD}, on_disk={"a"})
        self.assertEqual([(r["id"], why) for r, why in todo], [("a", "changed")])
        self.assertEqual(adopt, {})

    def test_a_record_without_a_scan_is_new_again(self):
        # The manifest says fetched, but the file is gone: download it.
        todo, _ = plan([row("a", NEW)], fetched={"a": NEW}, on_disk=set())
        self.assertEqual([why for _, why in todo], ["new"])

    def test_an_unrecorded_scan_takes_the_previous_index_url(self):
        # A dataset fetched before fetched.jsonl: the old index.jsonl names the URL it came from.
        todo, adopt = plan([row("a", NEW), row("b", NEW)], fetched={}, on_disk={"a", "b"}, previous={"a": OLD, "b": NEW})
        self.assertEqual([(r["id"], why) for r, why in todo], [("a", "changed")])
        self.assertEqual(adopt, {"a": OLD, "b": NEW})

    def test_an_unrecorded_scan_with_no_history_is_taken_as_current(self):
        todo, adopt = plan([row("a", NEW)], fetched={}, on_disk={"a"})
        self.assertEqual(todo, [])
        self.assertEqual(adopt, {"a": NEW})

    def test_the_manifest_outranks_the_previous_index(self):
        todo, _ = plan([row("a", NEW)], fetched={"a": NEW}, on_disk={"a"}, previous={"a": OLD})
        self.assertEqual(todo, [])


class IndexRows(unittest.TestCase):
    """What the evidence networks' classes are made of (ev_data.py): the rarity (the symbol's
    colour), and the set type, promo types and release date (the promo stamp)."""

    CARD = {
        "id": "c0ffee00-0000-4000-8000-000000000001", "oracle_id": "0ac1e000-0000-4000-8000-000000000002",
        "name": "Lightning Bolt", "set": "pm11", "set_type": "promo", "collector_number": "149p",
        "rarity": "common", "lang": "en", "layout": "normal", "games": ["paper"], "image_status": "highres_scan",
        "promo": True, "promo_types": ["stamped", "promopack"], "released_at": "2010-07-16",
        "image_uris": {"normal": "https://cards.scryfall.io/normal/front/c/0/c0ffee00.jpg?1"},
    }

    def test_a_row_carries_the_rarity_and_the_promo_fields(self):
        (r,) = select([self.CARD])
        self.assertEqual(r["rarity"], "common")
        self.assertEqual(r["set_type"], "promo")
        self.assertEqual(r["promo_types"], ["promopack", "stamped"])
        self.assertEqual(r["released_at"], "2010-07-16")

    def test_a_card_without_promo_types_has_an_empty_list(self):
        card = {k: v for k, v in self.CARD.items() if k != "promo_types"}
        (r,) = select([card])
        self.assertEqual(r["promo_types"], [])


class Manifest(unittest.TestCase):
    def test_round_trip_last_row_wins_and_a_torn_line_is_skipped(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "fetched.jsonl"
            write_manifest(path, {"b": OLD, "a": NEW})
            self.assertEqual(read_urls(path), {"a": NEW, "b": OLD})
            with open(path, "a", encoding="utf-8") as f:
                f.write('{"id": "b", "url": "%s"}\n' % NEW)
                f.write('{"id": "c", "ur')  # killed mid-append
            self.assertEqual(read_urls(path), {"a": NEW, "b": NEW})
            self.assertEqual(read_urls(Path(tmp) / "missing.jsonl"), {})


if __name__ == "__main__":
    unittest.main()
