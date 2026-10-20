"""Rewrite `crates/card-neural/models/README.md`'s table and `training.json` for a delivered run.

    python crates/card-neural/train/update_readme.py --models crates/card-neural/models \
        --done DONE.json --gallery-json gallery.json

**The table is the web build's pin on the four files**: `packages/ui/lib/core/web/assets.ts`'
`neuralTable` reads each row's bytes and `head8…tail8` sha256, and `apps/light/vite.config.ts`
fails a build whose file differs from its row. So every row's numbers are read from the files on
disk — all four, changed or not — never carried over from `DONE.json`. The table is laid out as
Prettier lays out Markdown (each column padded to its widest cell, `bytes` right-aligned), so a
later format pass moves nothing; the thousands separator is an ASCII space, as the table has
always had and `neuralTable`'s pattern reads.

`training.json`, beside the files, is what the current files scored when they were trained:
`deliver.py` compares a new run against it in the pull request, and this rewrites it with the
run it delivers. A network the run did not retrain (`--no-detector`) keeps its row and its record.

Standard library only: the delivery's build job runs it with no packages installed.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
from pathlib import Path

FILES = ("detector.onnx", "embedder.onnx", "gallery.bin", "neural.json")
TRAINING_JSON = "training.json"
README = "README.md"

# The one line this script owns in the README, below the table; replaced on every delivery.
PROVENANCE = re.compile(r"^\*\*Last trained\*\* .*$", re.M)
# A row's provenance, last in its description: the lab's `(scanner lab run `det-a`)` and
# `(run `qd-mnv4-e`, "run 2")`, and this script's own `(training run `2026-11`)`.
ROW_PROVENANCE = re.compile(r"\s*\((?:scanner lab |training )?run `[^`]+`[^()]*\)\s*$")


def group(n: int) -> str:
    """2443078 → `2 443 078`: the separator the table uses and `neuralTable` reads."""
    return f"{n:,}".replace(",", " ")


def digest(path: Path) -> tuple[int, str]:
    """A file's length and sha256, read in blocks (the embedder is ten megabytes)."""
    h = hashlib.sha256()
    size = 0
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
            size += len(chunk)
    return size, h.hexdigest()


def short(sha: str) -> str:
    return f"`{sha[:8]}…{sha[-8:]}`"


def number(value, digits: int | None = None) -> str:
    """A metric as the README and the pull request print it; `—` for one the run did not report."""
    if value is None:
        return "—"
    if isinstance(value, bool):
        return str(value).lower()
    if isinstance(value, int):
        return group(value)
    if isinstance(value, float):
        return f"{value:.{digits}f}" if digits is not None else f"{value:g}"
    return str(value)


# --- the table --------------------------------------------------------------------------------


def _cells(line: str) -> list[str]:
    return [cell.strip() for cell in line.strip()[1:-1].split("|")]


def find_table(lines: list[str]) -> tuple[int, int]:
    """The `[start, end)` lines of the table whose first header cell is `file`."""
    for i, line in enumerate(lines):
        if line.startswith("|") and _cells(line)[0] == "file":
            end = i
            while end < len(lines) and lines[end].startswith("|"):
                end += 1
            return i, end
    raise ValueError("models/README.md has no table whose first column is `file`")


def _alignment(cell: str) -> str | None:
    left, right = cell.startswith(":"), cell.endswith(":")
    return "center" if left and right else "right" if right else "left" if left else None


def parse_table(lines: list[str]) -> tuple[list[str], list[str | None], list[list[str]]]:
    header = _cells(lines[0])
    aligns = [_alignment(cell) for cell in _cells(lines[1])]
    rows = [_cells(line) for line in lines[2:]]
    for row in rows:
        if len(row) != len(header):
            raise ValueError(f"a row of {len(row)} cells under a header of {len(header)}: {row}")
    return header, aligns, rows


def render_table(header: list[str], aligns: list[str | None], rows: list[list[str]]) -> list[str]:
    """Prettier's layout: every column as wide as its widest cell (three at least)."""
    widths = [max(3, *(len(row[i]) for row in [header, *rows])) for i in range(len(header))]

    def cell(text: str, i: int) -> str:
        pad = widths[i] - len(text)
        if aligns[i] == "right":
            return " " * pad + text
        if aligns[i] == "center":
            return " " * (pad // 2) + text + " " * (pad - pad // 2)
        return text + " " * pad

    def rule(i: int) -> str:
        w, a = widths[i], aligns[i]
        if a == "right":
            return "-" * (w - 1) + ":"
        if a == "left":
            return ":" + "-" * (w - 1)
        if a == "center":
            return ":" + "-" * (w - 2) + ":"
        return "-" * w

    line = lambda cells: "| " + " | ".join(cells) + " |"  # noqa: E731
    return [
        line(cell(text, i) for i, text in enumerate(header)),
        line(rule(i) for i in range(len(header))),
        *(line(cell(text, i) for i, text in enumerate(row)) for row in rows),
    ]


def describe(name: str, old: str, run: str, *, looks=None, epochs=None, steps=None) -> str:
    """A changed file's description: its counts brought up to date, its provenance the run's."""
    text = ROW_PROVENANCE.sub("", old)
    if name == "embedder.onnx":
        if looks is not None:
            text = re.sub(r"over [\d ]+ looks", f"over {group(looks)} looks", text)
        if epochs is not None:
            text = re.sub(r"\b\d+ epochs\b", f"{epochs} epochs", text)
    if name == "detector.onnx" and steps is not None:
        text = re.sub(r"trained [\d ]+ steps", f"trained {group(steps)} steps", text)
    return f"{text} (training run `{run}`)"


# --- the run ----------------------------------------------------------------------------------


def looks_of(gallery_json: Path) -> int:
    """How many looks the export's gallery holds: one `gallery.json` entry a row."""
    return len(json.loads(gallery_json.read_text(encoding="utf-8"))["entries"])


def retrained(done: dict) -> list[str]:
    """The networks a run trained and delivers: the embedder always, the detector unless the
    run was launched with `--no-detector` (then `DONE.json` has no detector file)."""
    files = done.get("files")
    exported = files is None or "detector.onnx" in files
    measured = (done.get("metrics") or {}).get("detector") is not None
    return ["embedder", "detector"] if done.get("detector", True) and exported and measured else ["embedder"]


def provenance(done: dict, training: dict, looks: int) -> str:
    """The README's one line on the run that made the files."""
    run = done["run"]
    metrics = done.get("metrics") or {}
    e = metrics.get("embedder") or {}
    parts = [
        f"embedder retrieval top-1 {number(e.get('retrieval_top1'))} after "
        f"{number(e.get('epochs'))} epochs, {group(looks)} looks"
    ]
    if "detector" in retrained(done):
        d = metrics["detector"]
        parts.append(
            f"detector found {number(d.get('found'))}, corner error {number(d.get('corner_err'))} "
            f"(p90 {number(d.get('corner_err_p90'))}), wrong way {number(d.get('wrong_way'))} "
            f"after {number(d.get('steps'))} steps"
        )
    else:
        kept = (training.get("detector") or {}).get("run", "an earlier run")
        parts.append(f"detector not retrained (still run `{kept}`'s)")
    spend = done.get("spend_usd")
    cost = f"${spend:.2f} on Modal" if isinstance(spend, (int, float)) else "spend not recorded"
    finished = (done.get("finished_at") or "")[:10] or "on an unrecorded date"
    sha = (done.get("git_sha") or "")[:8] or "unrecorded"
    return (
        f"**Last trained** by `.github/workflows/neural-train.yml`: run `{run}`, finished "
        f"{finished} from commit `{sha}` — {'; '.join(parts)}; {cost}. The readers'-scan figures "
        "below are an earlier pair's until this one is replayed (`pnpm scanner:replay`)."
    )


def update_readme(text: str, models: Path, done: dict, training: dict, looks: int) -> str:
    """The README with its four rows read from `models/` and the run's provenance line."""
    lines = text.split("\n")
    start, end = find_table(lines)
    header, aligns, rows = parse_table(lines[start:end])
    col = {name: header.index(name) for name in ("file", "bytes", "sha256", "what it is")}
    nets = retrained(done)
    # The networks' rows name their run; `gallery.bin`'s says what it is, which a run does not change.
    changed = {"embedder.onnx"} | ({"detector.onnx"} if "detector" in nets else set())
    metrics = done.get("metrics") or {}
    by_name = {row[col["file"]].strip("`"): row for row in rows}
    missing = [name for name in FILES if name not in by_name]
    if missing:
        raise ValueError(f"models/README.md's table has no row for {', '.join(missing)}")
    for name in FILES:
        row = by_name[name]
        size, sha = digest(models / name)
        row[col["bytes"]] = group(size)
        row[col["sha256"]] = short(sha)
        if name in changed:
            row[col["what it is"]] = describe(
                name,
                row[col["what it is"]],
                done["run"],
                looks=looks,
                epochs=(metrics.get("embedder") or {}).get("epochs"),
                steps=(metrics.get("detector") or {}).get("steps"),
            )
    table = render_table(header, aligns, rows)
    line = provenance(done, training, looks)
    rest = lines[end:]
    body = "\n".join(rest)
    if PROVENANCE.search(body):
        body = PROVENANCE.sub(lambda _: line, body, count=1)
        rest = body.split("\n")
    else:
        rest = ["", line, *rest]
    return "\n".join([*lines[:start], *table, *rest])


def update_training(training: dict, done: dict, looks: int) -> dict:
    """`training.json` with the networks the run retrained, and the run itself."""
    out = dict(training)
    metrics = done.get("metrics") or {}
    common = {
        "run": done["run"],
        "where": "modal",
        "finished_at": done.get("finished_at"),
        "git_sha": done.get("git_sha"),
    }
    out["embedder"] = {**common, "looks": looks, "metrics": metrics.get("embedder") or {}}
    if "detector" in retrained(done):
        out["detector"] = {**common, "metrics": metrics["detector"]}
    out["last_run"] = {**common, "retrained": retrained(done), "spend_usd": done.get("spend_usd")}
    return out


def update(models: Path, done: dict, gallery_json: Path) -> dict:
    """Rewrite `models/README.md` and `models/training.json` in place; the new record back."""
    training_path = models / TRAINING_JSON
    training = json.loads(training_path.read_text(encoding="utf-8"))
    looks = looks_of(gallery_json)
    readme = models / README
    text = readme.read_text(encoding="utf-8")
    readme.write_text(update_readme(text, models, done, training, looks), encoding="utf-8", newline="\n")
    new = update_training(training, done, looks)
    training_path.write_text(json.dumps(new, indent=2, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n")
    return new


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--models", type=Path, required=True, help="the folder: README.md, training.json and the four files")
    ap.add_argument("--done", type=Path, required=True, help="the run's DONE.json")
    ap.add_argument("--gallery-json", type=Path, required=True, help="the run's export gallery.json")
    args = ap.parse_args()
    done = json.loads(args.done.read_text(encoding="utf-8"))
    update(args.models, done, args.gallery_json)
    print(f"rewrote {args.models / README} and {args.models / TRAINING_JSON} for run {done['run']}")


if __name__ == "__main__":
    main()
