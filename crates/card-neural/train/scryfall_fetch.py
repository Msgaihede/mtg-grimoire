"""Every paper printing face's `normal` scan from Scryfall, fast, from the bulk data.

    python scryfall_fetch.py <out dir> [--workers 48] [--kind default_cards] [--limit N] [--reuse-bulk] [--prune]
    python scryfall_fetch.py <out dir> --index-only     # rewrite index.jsonl from the bulk file on disk

Writes into <out dir>:
  <kind>.jsonl.gz     the bulk file (one request to api.scryfall.com, the download from data.scryfall.io)
  bulk.json           the bulk file's entry from the API (its `updated_at`), to know when it is stale
  normal/<2>/<id>[-1].jpg  one 488×680 scan per printing face (`-1` for a second face), in a folder
                      named by the id's first two characters (a Modal Volume holds at most 262 144
                      files a directory)
  index.jsonl         one line per face: ids, name, set, number, language, illustration and the frame
                      fields a "look" groups by (looks.py), the scan's current URL, and what the
                      evidence networks' classes are made of (ev_data.py): `rarity` (the set
                      symbol's colour), `set_type`, `promo_types` and `released_at` (a promo's stamp)
  fetched.jsonl       one line per scan on disk: {id, url} — the URL it was fetched from
  fetch.json          the run: {fetched_at, faces, downloaded, refreshed, failed, bytes, ...}
  fetch.log           progress, retries, failures

Scryfall's terms (https://scryfall.com/docs/api): the API asks 50–100 ms between requests, but the
`*.scryfall.io` hosts the bulk file and the images come from carry no rate limit, and a large
number of images must come from the bulk data — which is what this does: one API request, then
the CDN in parallel.

Incremental, so it is re-run against the same folder every month: the bulk file is downloaded
again when the API's `updated_at` moved (`--reuse-bulk` keeps the one on disk), a face with no
scan is downloaded (`downloaded`), and a face whose image URL changed since its scan was fetched —
Scryfall's URLs end `?<timestamp>`, which moves when the image is replaced — is downloaded again
(`refreshed`); `--index-only` rewrites index.jsonl from the bulk file on disk and downloads
nothing. A scan with no record in fetched.jsonl (a dataset fetched before it, in the flat
`normal/<id>.jpg` layout) is taken as fetched from the URL the previous index.jsonl gave it, else
from the current one. Files are written to a temporary name and renamed, so an interrupted run
leaves no partial image, and fetched.jsonl is appended as each scan lands. Nothing is deleted
unless `--prune` asks: then the sharded scans this script fetched for faces no longer in the bulk
file go (never a flat-layout file, never with `--limit`).

Kept out: digital-only printings, art series, oversized cards, and the landscape layouts
(planes, schemes, vanguard, battles) whose top 72 % is not the name, art and type line.
"""
import argparse
import gzip
import json
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import httpx

from looks import flat_path, scan_ids, shard_path

HEADERS = {"User-Agent": "MTGGrimoire-card-neural/1.0 (github.com/Msgaihede/mtg-grimoire)", "Accept": "application/json"}
SKIP_LAYOUTS = {"art_series", "planar", "scheme", "vanguard", "battle", "token_art_series"}
JPEG = b"\xff\xd8\xff"
MANIFEST = "fetched.jsonl"


def bulk(out: Path, kind: str, log, reuse: bool = False) -> Path:
    """The bulk file: gzipped JSON Lines (`jsonl_download_uri`, what the API offers since 2026),
    or a JSON array (`download_uri`, what it offered before). Downloaded again when the API's
    `updated_at` differs from the one bulk.json recorded; `reuse` keeps any file on disk."""
    existing = next((p for p in (out / f"{kind}.jsonl.gz", out / f"{kind}.json") if p.exists()), None)
    if reuse and existing:
        log(f"bulk: reusing {existing}")
        return existing
    record = out / "bulk.json"
    with httpx.Client(headers=HEADERS, timeout=60, follow_redirects=True) as c:
        try:
            meta = c.get("https://api.scryfall.com/bulk-data").raise_for_status().json()
        except httpx.HTTPError as e:
            if existing is None:
                raise
            log(f"bulk: the API did not answer ({e!r}); reusing {existing}")
            return existing
        entry = next(e for e in meta["data"] if e["type"] == kind)
        url = entry.get("jsonl_download_uri") or entry["download_uri"]
        path = out / (f"{kind}.jsonl.gz" if url.endswith(".jsonl.gz") else f"{kind}.json")
        had = json.loads(record.read_text(encoding="utf-8")) if record.exists() else {}
        if path.exists() and had.get("updated_at") == entry.get("updated_at"):
            log(f"bulk: {path.name} is current (updated {entry.get('updated_at')})")
            return path
        size = entry.get("size") or entry.get("compressed_size")
        log(f"bulk: {kind}{f' {size / 1e6:.0f} MB' if size else ''}, updated {entry.get('updated_at')}, {url}")
        tmp = path.with_suffix(".part")
        with c.stream("GET", url) as r, open(tmp, "wb") as f:
            r.raise_for_status()
            for chunk in r.iter_bytes(1 << 20):
                f.write(chunk)
        tmp.replace(path)
    write_json(record, {k: entry.get(k) for k in ("type", "updated_at", "size", "compressed_size")} | {"url": url})
    return path


def read_cards(path: Path) -> list[dict]:
    if path.name.endswith(".jsonl.gz"):
        with gzip.open(path, "rt", encoding="utf-8") as f:
            return [json.loads(line) for line in f if line.strip()]
    return json.loads(path.read_text(encoding="utf-8"))


def faces(card: dict):
    """(face index, face dict, image uris) for every printed face with its own picture."""
    if card.get("image_uris"):
        yield 0, card, card["image_uris"]
    else:
        for i, face in enumerate(card.get("card_faces") or []):
            if face.get("image_uris"):
                yield i, face, face["image_uris"]


def select(cards: list[dict]):
    for card in cards:
        if card.get("digital") or "paper" not in card.get("games", []) or card.get("oversized"):
            continue
        if card.get("layout") in SKIP_LAYOUTS or card.get("image_status") in (None, "missing", "placeholder"):
            continue
        for i, face, uris in faces(card):
            if not uris.get("normal"):
                continue
            fid = card["id"] if i == 0 else f"{card['id']}-{i}"
            yield {
                "id": fid,
                "card_id": card["id"],
                "face": i,
                "oracle_id": card.get("oracle_id") or (card.get("card_faces") or [{}])[0].get("oracle_id"),
                "name": face.get("name") or card.get("name"),
                "card_name": card.get("name"),
                "set": card.get("set"),
                "collector_number": card.get("collector_number"),
                "rarity": card.get("rarity"),
                "lang": card.get("lang"),
                "layout": card.get("layout"),
                "illustration_id": face.get("illustration_id") or card.get("illustration_id"),
                "frame": card.get("frame"),
                "border_color": card.get("border_color"),
                "full_art": card.get("full_art", False),
                "frame_effects": sorted(card.get("frame_effects") or []),
                "promo": card.get("promo", False),
                "released_at": card.get("released_at"),
                "set_type": card.get("set_type"),
                "promo_types": sorted(card.get("promo_types") or []),
                "url": uris["normal"],
            }


def write_json(path: Path, value) -> None:
    tmp = path.with_name(path.name + ".part")
    tmp.write_text(json.dumps(value, indent=1), encoding="utf-8")
    os.replace(tmp, path)


def read_urls(path: Path) -> dict[str, str]:
    """{id: url} from a JSON Lines file of {id, url} rows (fetched.jsonl, index.jsonl); a later
    row wins, and a torn last line (an interrupted append) is skipped."""
    urls: dict[str, str] = {}
    if not path.exists():
        return urls
    with open(path, encoding="utf-8") as f:
        for line in f:
            try:
                row = json.loads(line)
                urls[row["id"]] = row["url"]
            except (json.JSONDecodeError, KeyError, TypeError):
                continue
    return urls


def write_manifest(path: Path, fetched: dict[str, str]) -> None:
    tmp = path.with_name(path.name + ".part")
    with open(tmp, "w", encoding="utf-8") as f:
        for fid in sorted(fetched):
            f.write(json.dumps({"id": fid, "url": fetched[fid]}) + "\n")
    os.replace(tmp, path)


def plan(rows: list[dict], fetched: dict[str, str], on_disk: set[str], previous: dict[str, str] | None = None):
    """What a run downloads: `todo`, (row, "new") for a face with no scan on disk and (row,
    "changed") for one whose scan was fetched from another URL; and `adopt`, {id: url} for scans
    on disk that fetched.jsonl does not know, taken as fetched from the URL the previous
    index.jsonl gave them (`previous`), else from the current one."""
    todo, adopt = [], {}
    for r in rows:
        fid, url = r["id"], r["url"]
        if fid not in on_disk:
            todo.append((r, "new"))
            continue
        known = fetched.get(fid)
        if known is None:
            known = (previous or {}).get(fid, url)
            adopt[fid] = known
        if known != url:
            todo.append((r, "changed"))
    return todo, adopt


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    ap.add_argument("--workers", type=int, default=48, help="parallel CDN downloads")
    ap.add_argument("--kind", default="default_cards")
    ap.add_argument("--limit", type=int, help="only the first N faces (a smoke run)")
    ap.add_argument("--reuse-bulk", action="store_true", help="keep a bulk file on disk without asking the API")
    ap.add_argument("--prune", action="store_true", help="delete the sharded scans of faces no longer in the bulk file")
    ap.add_argument("--index-only", action="store_true",
                    help="rewrite index.jsonl from the bulk file already on disk and fetch nothing")
    args = ap.parse_args()
    if args.prune and args.limit:
        ap.error("--prune with --limit would delete every face past the limit")
    if args.prune and args.index_only:
        ap.error("--index-only fetches nothing and deletes nothing")
    out = Path(args.out)
    (out / "normal").mkdir(parents=True, exist_ok=True)
    logf = open(out / "fetch.log", "a", encoding="utf-8")
    lock = threading.Lock()

    def log(msg):
        line = f"{time.strftime('%H:%M:%S')} {msg}"
        with lock:
            print(line, flush=True)
            logf.write(line + "\n")
            logf.flush()

    started = time.time()
    cards = read_cards(bulk(out, args.kind, log, args.reuse_bulk or args.index_only))
    rows = list(select(cards))
    if args.limit:
        rows = rows[: args.limit]
    previous = read_urls(out / "index.jsonl")
    on_disk = scan_ids(out)
    fetched = {fid: url for fid, url in read_urls(out / MANIFEST).items() if fid in on_disk}
    todo, adopt = plan(rows, fetched, on_disk, previous)
    fetched.update(adopt)
    tmp = out / "index.jsonl.part"
    with open(tmp, "w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    os.replace(tmp, out / "index.jsonl")
    write_manifest(out / MANIFEST, fetched)
    if args.index_only:
        log(f"{len(cards)} cards -> {len(rows)} faces; index.jsonl rewritten, nothing fetched")
        return
    new = sum(why == "new" for _, why in todo)
    log(f"{len(cards)} cards -> {len(rows)} faces; {len(rows) - new} on disk ({len(adopt)} adopted), "
        f"{new} new and {len(todo) - new} changed to fetch with {args.workers} workers")

    local = threading.local()
    done = {"new": 0, "changed": 0, "failed": 0, "bytes": 0}
    fetch_started = time.time()

    def fetch(r):
        if not hasattr(local, "client"):
            local.client = httpx.Client(headers={"User-Agent": HEADERS["User-Agent"]}, timeout=30, follow_redirects=True)
        path = shard_path(out, r["id"])
        path.parent.mkdir(exist_ok=True)
        last = None
        for attempt in range(5):
            try:
                resp = local.client.get(r["url"])
                if resp.status_code == 200 and resp.content.startswith(JPEG):
                    tmp = path.with_suffix(f".{os.getpid()}.{threading.get_ident()}.part")
                    tmp.write_bytes(resp.content)
                    tmp.replace(path)
                    return len(resp.content)
                if resp.status_code in (429, 500, 502, 503, 504):
                    time.sleep(1 + 2 * attempt)
                    continue
                log(f"fail {r['id']} {resp.status_code} {r['url']}")
                return None
            except httpx.HTTPError as e:
                time.sleep(1 + 2 * attempt)
                last = e
        log(f"fail {r['id']} after retries: {last!r}")
        return None

    with ThreadPoolExecutor(args.workers) as pool, open(out / MANIFEST, "a", encoding="utf-8") as manifest:
        futures = {pool.submit(fetch, r): (r, why) for r, why in todo}
        for n, fut in enumerate(as_completed(futures), 1):
            r, why = futures[fut]
            size = fut.result()
            if size is None:
                done["failed"] += 1
            else:
                done[why] += 1
                done["bytes"] += size
                fetched[r["id"]] = r["url"]
                manifest.write(json.dumps({"id": r["id"], "url": r["url"]}) + "\n")
                manifest.flush()
            if n % 2000 == 0 or n == len(todo):
                dt = time.time() - fetch_started
                log(f"{n}/{len(todo)} ({done['failed']} failed), {n / dt:.0f}/s, {done['bytes'] / 1e9:.2f} GB, eta {(len(todo) - n) / max(n / dt, 1e-9) / 60:.1f} min")
    pruned = 0
    if args.prune:
        keep = {r["id"] for r in rows}
        for fid in [f for f in fetched if f not in keep]:
            path = shard_path(out, fid)
            if path.exists():
                path.unlink()
                pruned += 1
            if not flat_path(out, fid).exists():
                del fetched[fid]
        log(f"pruned {pruned} scans of faces no longer in the bulk file")
    write_manifest(out / MANIFEST, fetched)
    record = json.loads((out / "bulk.json").read_text(encoding="utf-8")) if (out / "bulk.json").exists() else {}
    write_json(out / "fetch.json", {
        "fetched_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "faces": len(rows), "downloaded": done["new"], "refreshed": done["changed"], "failed": done["failed"],
        "bytes": done["bytes"], "adopted": len(adopt), "pruned": pruned, "kind": args.kind,
        "bulk_updated_at": record.get("updated_at"), "limit": args.limit, "seconds": round(time.time() - started, 1),
    })
    log(f"FETCH-DONE downloaded {done['new']}, refreshed {done['changed']}, failed {done['failed']}, "
        f"{done['bytes'] / 1e9:.2f} GB in {(time.time() - started) / 60:.1f} min")


if __name__ == "__main__":
    main()
