"""Group Scryfall printing faces into looks: the printings a camera cannot tell apart.

    python looks.py <dataset dir>          # reads index.jsonl, writes looks.json beside it

A look is Quickdraw's gallery entry (§1.5 of the scanner lab's docs/neural-scanner.md): the same name,
illustration, frame, border, full-art flag, frame effects and language. Lightning Bolt's ten
modern-frame reprints of one painting are one look; its showcase or borderless reprints of the
same painting are others, because the crop the embedder reads (the card's top 72 %: name bar,
art, type line) shows the frame. A face with no illustration id is a look of its own.

looks.json: {"looks": [{"key", "name", "oracle_id", "members": [face ids], "rep": face id}], ...}
`rep` is the printing a decision reports: the earliest non-promo release, which is most often the
one a reader holds (a main-set printing rather than its later promos).

Where a face's scan is (`scan_path`): `normal/<first two characters of its id>/<id>.jpg`, as
scryfall_fetch.py writes it — a Modal Volume holds at most 262 144 files a directory — or, in a
dataset fetched before the shards, `normal/<id>.jpg`.
"""
import json
import os
import sys
from collections import defaultdict
from pathlib import Path


def shard_path(root: Path, face_id: str) -> Path:
    return Path(root) / "normal" / face_id[:2] / f"{face_id}.jpg"


def flat_path(root: Path, face_id: str) -> Path:
    return Path(root) / "normal" / f"{face_id}.jpg"


def scan_layout(root: Path) -> str:
    """"sharded", "flat" or "mixed": which of the two layouts `normal/` holds, read once so that
    a dataset in one layout costs no file system call a lookup (a mixed one costs one)."""
    shards = flat = False
    try:
        with os.scandir(Path(root) / "normal") as it:
            for entry in it:
                if entry.is_dir():
                    shards = True
                elif entry.name.endswith(".jpg"):
                    flat = True
                if shards and flat:
                    return "mixed"
    except FileNotFoundError:
        pass
    return "flat" if flat else "sharded"


def scan_path(root: Path, face_id: str, layout: str = "mixed") -> Path:
    """The face's scan: the sharded path, else the flat one."""
    if layout == "flat":
        return flat_path(root, face_id)
    sharded = shard_path(root, face_id)
    if layout == "sharded" or sharded.exists():
        return sharded
    return flat_path(root, face_id)


def scan_ids(root: Path) -> set[str]:
    """The id of every face with a scan on disk, in either layout."""
    have = set()
    try:
        with os.scandir(Path(root) / "normal") as top:
            for entry in top:
                if entry.is_dir():
                    with os.scandir(entry.path) as shard:
                        have.update(e.name[:-4] for e in shard if e.name.endswith(".jpg"))
                elif entry.name.endswith(".jpg"):
                    have.add(entry.name[:-4])
    except FileNotFoundError:
        pass
    return have


def look_key(r: dict) -> tuple:
    art = r.get("illustration_id") or r["id"]
    return (r["name"], art, r.get("frame"), r.get("border_color"), bool(r.get("full_art")),
            tuple(r.get("frame_effects") or ()), r.get("lang"))


def main(root: Path) -> None:
    rows = [json.loads(line) for line in open(root / "index.jsonl", encoding="utf-8")]
    have = scan_ids(root)
    rows = [r for r in rows if r["id"] in have]
    groups: dict[tuple, list[dict]] = defaultdict(list)
    for r in rows:
        groups[look_key(r)].append(r)
    looks = []
    for key, members in groups.items():
        members.sort(key=lambda r: (bool(r.get("promo")), r.get("released_at") or "9999", r["set"], r["collector_number"]))
        looks.append({
            "key": list(key),
            "name": members[0]["name"],
            "card_name": members[0].get("card_name"),
            "oracle_id": members[0].get("oracle_id"),
            "members": [m["id"] for m in members],
            "rep": members[0]["id"],
        })
    looks.sort(key=lambda l: (l["name"], l["rep"]))
    sizes = [len(l["members"]) for l in looks]
    out = {"faces": len(rows), "looks": looks}
    (root / "looks.json").write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")
    print(f"{len(rows)} faces with an image -> {len(looks)} looks; "
          f"{sum(s == 1 for s in sizes)} single-printing, largest {max(sizes)} ({looks[sizes.index(max(sizes))]['name']})")


if __name__ == "__main__":
    main(Path(sys.argv[1]))
