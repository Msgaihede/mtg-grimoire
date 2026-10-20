"""Turn a finished training run on the `card-neural` Volume into a pull request.

`.github/workflows/neural-deliver.yml` runs this in four jobs, so that the tokens never share a
process with code a build runs (`release.yml`'s rule: secrets live in jobs that build nothing):

    deliver.py find [--run NAME] --out DIR     Modal token: list the runs, pick one, download it
    deliver.py build --work DIR --out DIR      no secret: gallery.bin, README, training.json, tests
    deliver.py publish --work DIR              PR token: branch, commit, push, pull request
    deliver.py mark --run NAME [--pr URL]      Modal token: `DELIVERED.json` on the Volume

and by hand it is one command, the four in a row:

    deliver.py run [--run NAME] [--from-dir DIR] [--dry-run] [--out DIR]

`--from-dir` reads a folder laid out as the Volume is (`runs/<run>/DONE.json`, …) instead of the
Volume; `--dry-run` rewrites the README and `training.json` in a scratch copy (`--out`, or a new
temporary folder it names), prints the pull request's body and stops: no test, no push, nothing
written to the Volume.

**What a run is owed** (the plan's Volume layout, `docs/superpowers/plans/2026-10-20-neural-
training-pipeline.md`): a run with `DONE.json` `"status": "ok"` and no `DELIVERED.json` gets a pull
request into `main`, oldest first, one a workflow run. A failed one gets a line in the summary, a
red workflow run, and a `DELIVERED.json` with no pull request, so it is reported once. A smoke run
(`--smoke`) is built in a scratch copy — the delivery's plumbing proved as far as the push — and
marked; it never becomes a pull request. A run with no `DONE.json` is still training.

Run names are held to `launch.py`'s pattern before one reaches a path, a branch or a command.
"""
from __future__ import annotations

import argparse
import base64
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path, PurePosixPath

sys.path.insert(0, str(Path(__file__).resolve().parent))
import update_readme as ur  # noqa: E402

VOLUME = "card-neural"
# `\Z`, not `$`: a name with a newline after it is not a name.
RUN_NAME = re.compile(r"^\d{4}-\d{2}(-\d{2}-\d{4})?(-smoke)?\Z")
REPO = Path(__file__).resolve().parents[3]
MODELS = PurePosixPath("crates/card-neural/models")
BASE = "main"
# Where a run's files are when `DONE.json` names none, under `runs/<run>/`.
EXPORTS = {
    "embedder.onnx": "embedder/export/embedder.onnx",
    "gallery.head.matrix": "embedder/export/gallery.head.matrix",
    "gallery.json": "embedder/export/gallery.json",
    "detector.onnx": "detector/export/detector.onnx",
}
# What a delivery commits: the four files and the two this rewrites.
DELIVERED = (*ur.FILES, ur.README, ur.TRAINING_JSON)
BOT = ("github-actions[bot]", "41898282+github-actions[bot]@users.noreply.github.com")
SHOWN = 12  # runs the summary lists, newest first


class Refused(Exception):
    """A delivery that must not go on; the message is the summary's line."""


# --- where the runs are -------------------------------------------------------------------------


class DirStore:
    """A folder laid out as the Volume is: `--from-dir`, the dry run and the tests."""

    def __init__(self, root: Path):
        self.root = Path(root)

    def runs(self) -> list[str]:
        d = self.root / "runs"
        return sorted(p.name for p in d.iterdir() if p.is_dir()) if d.is_dir() else []

    def read(self, path: str) -> bytes | None:
        p = self.root / path
        return p.read_bytes() if p.is_file() else None

    def fetch(self, path: str, dest: Path) -> bool:
        p = self.root / path
        if not p.is_file():
            return False
        shutil.copyfile(p, dest)
        return True

    def write(self, path: str, data: bytes) -> None:
        p = self.root / path
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)


class VolumeStore:
    """The `card-neural` Volume (Volumes v2), through Modal's client and `MODAL_TOKEN_*`."""

    def __init__(self, name: str = VOLUME):
        import modal
        import modal.exception

        self.missing = (FileNotFoundError, modal.exception.NotFoundError)
        self.vol = modal.Volume.from_name(name, version=2)

    def runs(self) -> list[str]:
        try:
            entries = self.vol.listdir("/runs")
        except self.missing:  # no Volume yet, or no run on it
            return []
        return sorted(
            PurePosixPath(e.path).name for e in entries if getattr(e.type, "name", "") == "DIRECTORY"
        )

    def read(self, path: str) -> bytes | None:
        try:
            return b"".join(self.vol.read_file("/" + path))
        except self.missing:
            return None

    def fetch(self, path: str, dest: Path) -> bool:
        try:
            with dest.open("wb") as f:
                for chunk in self.vol.read_file("/" + path):
                    f.write(chunk)
            return True
        except self.missing:
            dest.unlink(missing_ok=True)
            return False

    def write(self, path: str, data: bytes) -> None:
        with self.vol.batch_upload(force=True) as batch:
            batch.put_file(io.BytesIO(data), "/" + path)


def store_for(from_dir: Path | None):
    return DirStore(from_dir) if from_dir else VolumeStore()


# --- what the workflow sees -----------------------------------------------------------------------


def summary(text: str) -> None:
    """A line for the run's page (`$GITHUB_STEP_SUMMARY`) and the log."""
    print(text, flush=True)
    path = os.environ.get("GITHUB_STEP_SUMMARY")
    if path:
        with open(path, "a", encoding="utf-8") as f:
            f.write(text + "\n")


def output(key: str, value: str) -> None:
    path = os.environ.get("GITHUB_OUTPUT")
    if path:
        with open(path, "a", encoding="utf-8") as f:
            f.write(f"{key}={value}\n")


def now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def load(raw: bytes | None, default=None):
    if raw is None:
        return default
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return default


def is_smoke(done: dict, info: dict | None) -> bool:
    return bool(done.get("smoke") or (info or {}).get("smoke") or done.get("run", "").endswith("-smoke"))


def cell(text, limit: int = 300) -> str:
    """A reason from `DONE.json` (an exception's words) made safe for one Markdown table cell."""
    text = " ".join(str(text).split()).replace("|", "\\|")
    return text if len(text) <= limit else text[: limit - 1] + "…"


def workflow_link() -> str | None:
    server, repo, run = (os.environ.get(k) for k in ("GITHUB_SERVER_URL", "GITHUB_REPOSITORY", "GITHUB_RUN_ID"))
    return f"{server}/{repo}/actions/runs/{run}" if server and repo and run else None


# --- find ---------------------------------------------------------------------------------------


def volume_path(run: str, name: str, files: dict | None) -> str:
    """Where `name` is on the Volume: `DONE.json`'s `files`, else the plan's layout — held to the
    run's own folder, so a `DONE.json` cannot point the download anywhere else."""
    path = (files or {}).get(name) or f"runs/{run}/{EXPORTS[name]}"
    path = path.lstrip("/")
    if path.startswith("vol/"):  # written as the container sees it
        path = path[len("vol/"):]
    if not path.startswith(f"runs/{run}/") or ".." in PurePosixPath(path).parts:
        raise Refused(f"`DONE.json` of run `{run}` puts `{name}` at `{path}`, outside `runs/{run}/`.")
    return path


def wanted(done: dict) -> list[str]:
    names = ["embedder.onnx", "gallery.head.matrix", "gallery.json"]
    return names + (["detector.onnx"] if "detector" in ur.retrained(done) else [])


def fetch_run(store, run: str, out: Path) -> dict:
    """The run's `DONE.json`, `run.json`, the Scryfall refresh's `fetch.json` and its files, into `out`."""
    out.mkdir(parents=True, exist_ok=True)
    raw = store.read(f"runs/{run}/DONE.json")
    done = load(raw)
    if not isinstance(done, dict):
        raise Refused(f"Run `{run}` has no readable `DONE.json`.")
    (out / "DONE.json").write_bytes(raw)
    for src, dest in ((f"runs/{run}/run.json", "run.json"), ("data/scryfall/fetch.json", "fetch.json")):
        data = store.read(src)
        if data is not None:
            (out / dest).write_bytes(data)
    for name in wanted(done):
        path = volume_path(run, name, done.get("files"))
        if not store.fetch(path, out / name):
            raise Refused(f"Run `{run}` says it finished, but `{path}` is not on the Volume.")
    return done


def describe_run(run: str, done, delivered, info) -> tuple[str, str]:
    """A run's state and a word on it, for the summary's table."""
    if delivered is not None:
        if delivered.get("pr"):
            return "delivered", cell(delivered["pr"])
        if delivered.get("smoke"):
            return "smoke run, checked", cell(delivered.get("delivered_at", ""))
        return "failed, reported", cell((done or {}).get("reason") or delivered.get("reason") or "")
    if done is None:
        started = (info or {}).get("started_at")
        return "training", cell(f"started {started}") if started else "no `DONE.json` yet"
    if done.get("status") != "ok":
        return "**failed**", cell(done.get("reason") or "no reason given")
    return "finished", "to deliver"


def find(store, named: str = "", out: Path | None = None, mark_failed: bool = True) -> dict | None:
    """Report every run, mark newly failed ones, and download the run to deliver into `out`.
    Returns `{run, smoke}` for that run, or `None` when there is nothing to deliver."""
    if named and not RUN_NAME.match(named):
        raise Refused(f"`{named}` is not a run name (`YYYY-MM`, or `YYYY-MM-DD-HHMM`, perhaps `-smoke`).")
    runs = store.runs()
    ignored = [r for r in runs if not RUN_NAME.match(r)]
    runs = [r for r in runs if RUN_NAME.match(r)]
    if named:
        if named not in runs:
            raise Refused(f"There is no run `{named}` on the `{VOLUME}` Volume.")
        runs = [named]
    rows, ready, failed = [], [], []
    for run in runs:
        base = f"runs/{run}"
        done = load(store.read(f"{base}/DONE.json"))
        delivered = load(store.read(f"{base}/DELIVERED.json"))
        info = load(store.read(f"{base}/run.json")) if done is None else None
        state, word = describe_run(run, done, delivered, info)
        rows.append((run, state, word))
        if delivered is not None or done is None:
            continue
        if done.get("status") == "ok":
            ready.append(run)
        else:
            failed.append((run, done.get("reason") or "no reason given"))

    summary("### Neural training runs\n")
    if not rows:
        summary(f"No training run on the `{VOLUME}` Volume yet.")
    else:
        summary("| run | state | |\n| --- | --- | --- |")
        for run, state, word in sorted(rows, reverse=True)[:SHOWN]:
            summary(f"| `{run}` | {state} | {word} |")
    if ignored:
        summary(f"\nIgnored, not run names: {', '.join(f'`{r}`' for r in ignored[:5])}.")
    def report(run: str, reason: str) -> None:
        summary(f"\n**Run `{run}` failed and is not delivered**: {cell(reason, 2000)}")
        if mark_failed:
            record = {"pr": None, "delivered_at": now(), "failed": True, "reason": reason}
            store.write(f"runs/{run}/DELIVERED.json", json.dumps(record, indent=1).encode())
            summary(f"Marked `{run}` as reported (`DELIVERED.json`, no pull request): it is not reported again.")

    for run, reason in failed:
        report(run, reason)
    # The oldest run whose files are all there. One that says `ok` and lacks a file is a failed
    # run too: reported once, and the next one delivered instead of none, every six hours.
    picked = None
    for at, run in enumerate(ready):
        try:
            done = fetch_run(store, run, out) if out is not None else load(store.read(f"runs/{run}/DONE.json"))
        except Refused as refused:
            failed.append((run, str(refused)))
            report(run, str(refused))
            continue
        picked = (run, done)
        rest = ready[at + 1:]
        if rest:
            summary(f"\n{len(rest)} more finished run(s) wait for the next delivery: {', '.join(f'`{r}`' for r in rest)}.")
        break
    output("failed", "true" if failed else "false")

    if picked is None:
        output("run", "")
        output("smoke", "false")
        if named and not failed:
            summary(f"\nRun `{named}` is not one to deliver now ({rows[0][1]}).")
        return None
    run, done = picked
    smoke = is_smoke(done, load(store.read(f"runs/{run}/run.json")))
    summary(f"\nDelivering run `{run}`" + (" — a smoke run: built in a scratch copy, never a pull request." if smoke else "."))
    output("run", run)
    output("smoke", "true" if smoke else "false")
    return {"run": run, "smoke": smoke}


# --- build --------------------------------------------------------------------------------------


def cargo_build_gallery(repo: Path, matrix: Path, gallery: Path, out: Path) -> None:
    subprocess.run(
        ["cargo", "run", "--release", "--locked", "-p", "card-neural", "--features", "cli",
         "--bin", "build-gallery", "--", "--matrix", str(matrix), "--gallery", str(gallery), "--out", str(out)],
        cwd=repo, check=True,
    )


def cargo_test(repo: Path) -> None:
    # `--release` and `cli`, so the test reuses what `build-gallery` just compiled; the crate's
    # CLAUDE.md names this suite. Its tests load the files in `models/`.
    subprocess.run(["cargo", "test", "--release", "--locked", "-p", "card-neural", "--features", "cli"],
                   cwd=repo, check=True)


def title(run: str) -> str:
    return f"feat(scanner): retrain the Neural models ({run})"


def pr_body(done: dict, info: dict | None, before: dict, looks: int, fetch: dict | None = None,
            link: str | None = None, tested: bool = True) -> str:
    """The pull request's description, from `DONE.json`: what changes for a person scanning cards
    first (the release notes are written from it), then this run against the current files, the
    spend, what to do before merging, and where the files came from."""
    info = info or {}
    run = done["run"]
    nets = ur.retrained(done)
    metrics = done.get("metrics") or {}
    e, d = metrics.get("embedder") or {}, metrics.get("detector") or {}
    old_e, old_d = before.get("embedder") or {}, before.get("detector") or {}
    old_em, old_dm = old_e.get("metrics") or {}, old_d.get("metrics") or {}
    grown = looks - (old_e.get("looks") or looks)
    day = ((fetch or {}).get("fetched_at") or done.get("finished_at") or "")[:10] or "the day it ran"

    lead = (
        f"The Scanner's **Neural** mode knows the cards printed up to {day}: its recogniser was "
        f"retrained on Scryfall's card images and tells {ur.group(looks)} card pictures apart"
    )
    if grown > 0:
        lead += f", {ur.group(grown)} more than before, so cards printed since the last training are recognised rather than missed."
    elif grown < 0:
        lead += f", {ur.group(-grown)} fewer than before (printings Scryfall withdrew)."
    else:
        lead += ", as many as before."
    lead += " Its card finder was retrained too." if "detector" in nets else " Its card finder is unchanged."

    out = []
    if is_smoke(done, info):
        out += ["> **Smoke run**: what a real run's pull request would say. None was opened.", ""]
    out += [lead, "", "## This run against the current files", ""]
    out += [
        f"| | this run (`{run}`) | current files |",
        "| --- | ---: | ---: |",
        f"| embedder: retrieval top-1 (higher is better) | {ur.number(e.get('retrieval_top1'))} | {ur.number(old_em.get('retrieval_top1'))} |",
        f"| embedder: epochs | {ur.number(e.get('epochs'))} | {ur.number(old_em.get('epochs'))} |",
        f"| gallery: looks | {ur.group(looks)} | {ur.number(old_e.get('looks'))} |",
    ]
    if "detector" in nets:
        out += [
            f"| detector: cards found (higher is better) | {ur.number(d.get('found'))} | {ur.number(old_dm.get('found'))} |",
            f"| detector: mean corner error (lower is better) | {ur.number(d.get('corner_err'))} | {ur.number(old_dm.get('corner_err'))} |",
            f"| detector: corner error, 90th percentile | {ur.number(d.get('corner_err_p90'))} | {ur.number(old_dm.get('corner_err_p90'))} |",
            f"| detector: wrong way up (lower is better) | {ur.number(d.get('wrong_way'))} | {ur.number(old_dm.get('wrong_way'))} |",
            f"| detector: steps | {ur.number(d.get('steps'))} | {ur.number(old_dm.get('steps'))} |",
        ]
    out += ["", f"The current files: the embedder from run `{old_e.get('run', '?')}` ({old_e.get('where', '?')}), "
            f"the detector from run `{old_d.get('run', '?')}` ({old_d.get('where', '?')})."]
    if "detector" not in nets:
        out += ["This run did not retrain the detector (`--no-detector`), so `detector.onnx` stays as it is."]
    out += ["Retrieval top-1 is the embedder's check on held-out Scryfall scans; the detector's numbers are on "
            "synthetic scenes. Neither is a reader's camera — that is the replay below.", ""]

    out += ["## Spend", ""]
    spend = done.get("spend_usd")
    res = info.get("resources") or {}
    line = f"**${spend:.2f}** on Modal for the whole run" if isinstance(spend, (int, float)) else "The run's spend was not recorded"
    if isinstance(info.get("budget_usd"), (int, float)):
        line += f", against its budget of ${info['budget_usd']:.2f}"
    parts = [f"{net} ${(metrics.get(net) or {}).get('usd'):.2f}" for net in nets
             if isinstance((metrics.get(net) or {}).get("usd"), (int, float))]
    if parts:
        line += f" ({', '.join(parts)}; the rest is the Scryfall refresh and the orchestrator)"
    line += "."
    if res:
        line += (f" Each training ran on one {res.get('gpu', 'GPU')} with {ur.number(res.get('cpu'))} cores and "
                 f"{ur.number(res.get('memory_gib'))} GiB.")
    out += [line, ""]

    out += [
        "## Before merging",
        "",
        "- [ ] **Replay the readers' scans on this branch.** `neural.json`'s thresholds were tuned for the "
        "previous pair, by cross-validation on those scans; a new embedder moves every score, so the same "
        "thresholds can accept less, or accept wrongly. `pnpm scanner:corpus pull`, then `pnpm scanner:replay`, "
        "whose Neural pass runs these files — compare card ✓ and wrong with the current pair's "
        "(`docs/reference/card-scanner.md` §10 _Neural_).",
        "- [ ] Write this pair's replay figures into `crates/card-neural/models/README.md` and §10, or tune "
        "`neural.json` on this branch and say so here.",
        "- [ ] If the new pair does worse, close this pull request: the current files stay.",
        "",
        "## Where the files came from",
        "",
        f"- Run `{run}` on the Modal Volume `{VOLUME}` (`runs/{run}/`), trained from commit "
        f"`{done.get('git_sha') or info.get('git_sha') or 'unrecorded'}`, finished {done.get('finished_at') or 'at an unrecorded time'}.",
        "- `gallery.bin` built by `build-gallery` from the run's `gallery.head.matrix` and `gallery.json`; "
        "the README's rows and `training.json` rewritten by `crates/card-neural/train/update_readme.py`; "
        + ("`cargo test -p card-neural` passed on them." if tested else "not tested (a dry run or a smoke run)."),
    ]
    if link:
        out += [f"- Delivered by [`neural-deliver.yml`]({link})."]
    return "\n".join(out) + "\n"


def build(work: Path, out: Path, repo: Path = REPO, scratch: bool = False, test: bool = True,
          make_gallery=cargo_build_gallery, run_tests=cargo_test) -> dict:
    """The run in `work` (as `find` left it) made into the files a pull request commits, in
    `out/models/`, with `out/pr-body.md` and `out/delivery.json`. In the repository's `models/`,
    then tested; or, for a dry run or a smoke run, in `out/models/` alone, untested."""
    done = json.loads((work / "DONE.json").read_text(encoding="utf-8"))
    run = done.get("run", "")
    if not RUN_NAME.match(run) or done.get("status") != "ok":
        raise Refused(f"`{work / 'DONE.json'}` is not a finished run's (run {run!r}, status {done.get('status')!r}).")
    info = load((work / "run.json").read_bytes()) if (work / "run.json").exists() else {}
    fetch = load((work / "fetch.json").read_bytes()) if (work / "fetch.json").exists() else None
    smoke = is_smoke(done, info)
    scratch = scratch or smoke
    real = repo / MODELS
    staged = out / "models"
    staged.mkdir(parents=True, exist_ok=True)
    if scratch:
        for name in DELIVERED:
            shutil.copyfile(real / name, staged / name)
    models = staged if scratch else real
    before = json.loads((models / ur.TRAINING_JSON).read_text(encoding="utf-8"))

    for name in ("embedder.onnx", "detector.onnx"):
        if name in wanted(done):
            shutil.copyfile(work / name, models / name)
    make_gallery(repo, (work / "gallery.head.matrix").resolve(), (work / "gallery.json").resolve(),
                 (models / "gallery.bin").resolve())
    ur.update(models, done, work / "gallery.json")
    looks = ur.looks_of(work / "gallery.json")
    if test and not scratch:
        run_tests(repo)
    if not scratch:
        for name in DELIVERED:
            shutil.copyfile(real / name, staged / name)

    tested = bool(test and not scratch)
    body = pr_body(done, info, before, looks, fetch, workflow_link(), tested)
    (out / "pr-body.md").write_text(body, encoding="utf-8", newline="\n")
    delivery = {"run": run, "smoke": smoke, "branch": f"neural-models/{run}", "title": title(run),
                "retrained": ur.retrained(done), "tested": tested}
    (out / "delivery.json").write_text(json.dumps(delivery, indent=1) + "\n", encoding="utf-8")
    summary(f"\n### {'Smoke run `' + run + '`: the pull request it would open' if smoke else delivery['title']}\n")
    summary(body)
    return delivery


# --- publish ------------------------------------------------------------------------------------


def _git(repo: Path, *args: str, env=None, check: bool = True) -> subprocess.CompletedProcess:
    # No hook runs: the tree was written by a job that built code, and this one holds a token.
    return subprocess.run(["git", "-c", f"core.hooksPath={os.devnull}", *args], cwd=repo, env=env,
                          check=check, capture_output=True, text=True)


def _gh(repo: Path, token: str | None, *args: str) -> subprocess.CompletedProcess:
    env = dict(os.environ)
    if token:
        env["GH_TOKEN"] = token
    if os.environ.get("GITHUB_REPOSITORY"):
        env["GH_REPO"] = os.environ["GITHUB_REPOSITORY"]
    return subprocess.run(["gh", *args], cwd=repo, env=env, capture_output=True, text=True)


def open_pr(repo: Path, branch: str, base: str, title_: str, body: Path, token: str | None) -> str:
    """The open pull request from `branch`, or a new one."""
    found = _gh(repo, token, "pr", "list", "--head", branch, "--base", base, "--state", "open",
                "--json", "url", "--jq", ".[0].url // empty")
    if found.returncode == 0 and found.stdout.strip():
        return found.stdout.strip()
    made = _gh(repo, token, "pr", "create", "--base", base, "--head", branch, "--title", title_,
               "--body-file", str(body))
    if made.returncode != 0:
        hint = ""
        if "not permitted to create" in made.stderr:
            hint = (" The repository does not let the workflow's own token open pull requests: set "
                    "`NEURAL_PR_TOKEN`, or allow it under Settings → Actions → General.")
        raise Refused(f"`gh pr create` failed: {made.stderr.strip()}{hint}")
    return made.stdout.strip().splitlines()[-1]


def publish(work: Path, repo: Path = REPO, base: str = BASE) -> str:
    """Commit `work/models/` on `neural-models/<run>`, push it and open the pull request; its URL."""
    delivery = json.loads((work / "delivery.json").read_text(encoding="utf-8"))
    run = delivery["run"]
    if not RUN_NAME.match(run):
        raise Refused(f"{run!r} is not a run name.")
    if delivery.get("smoke"):
        summary(f"Run `{run}` is a smoke run: no pull request.")
        output("pr", "")
        return ""
    if not delivery.get("tested"):
        raise Refused(f"Run `{run}` was built without `cargo test -p card-neural`; nothing is pushed untested.")
    branch = delivery["branch"]
    token = os.environ.get("PR_TOKEN") or None
    env = dict(os.environ)
    if os.environ.get("GITHUB_ACTIONS"):
        env.update(GIT_AUTHOR_NAME=BOT[0], GIT_AUTHOR_EMAIL=BOT[1], GIT_COMMITTER_NAME=BOT[0], GIT_COMMITTER_EMAIL=BOT[1])
    for name in DELIVERED:
        shutil.copyfile(work / "models" / name, repo / MODELS / name)
    _git(repo, "switch", "-c", branch)
    _git(repo, "add", "--", *(str(MODELS / name) for name in DELIVERED))
    if _git(repo, "diff", "--cached", "--quiet", check=False).returncode == 0:
        raise Refused(f"Run `{run}`'s files are the ones already in git: nothing to deliver.")
    lead = (work / "pr-body.md").read_text(encoding="utf-8").split("\n\n")[0]
    _git(repo, "commit", "-m", delivery["title"], "-m", lead,
         "-m", f"Delivered by neural-deliver.yml from training run {run}.", env=env)

    if token:
        basic = base64.b64encode(f"x-access-token:{token}".encode()).decode()
        if os.environ.get("GITHUB_ACTIONS"):
            print(f"::add-mask::{basic}", flush=True)
        env.update(GIT_CONFIG_COUNT="1", GIT_CONFIG_KEY_0="http.https://github.com/.extraheader",
                   GIT_CONFIG_VALUE_0=f"AUTHORIZATION: basic {basic}")
    pushed = _git(repo, "push", "origin", f"HEAD:refs/heads/{branch}", env=env, check=False)
    if pushed.returncode != 0:
        # A branch left by an earlier attempt: its pull request stands, and a person's commits
        # on it (a tuned `neural.json`) are never pushed over.
        found = _gh(repo, token, "pr", "list", "--head", branch, "--state", "open", "--json", "url", "--jq", ".[0].url // empty")
        if found.returncode == 0 and found.stdout.strip():
            url = found.stdout.strip()
            summary(f"Branch `{branch}` is already pushed, with its pull request open: {url}")
            output("pr", url)
            return url
        raise Refused(f"Could not push `{branch}`: {pushed.stderr.strip()} Delete the branch if it is a "
                      "leftover, and dispatch the delivery again.")
    url = open_pr(repo, branch, base, delivery["title"], work / "pr-body.md", token)
    summary(f"Opened {url} from `{branch}`.")
    if os.environ.get("HAS_PAT") == "false":
        summary("\n> **Opened with the workflow's own token, so CI has not run on it.** A pull request a "
                "workflow opens with `GITHUB_TOKEN` starts no workflow: push to the branch, or close and "
                "reopen the pull request, to start `ci.yml`. Set `NEURAL_PR_TOKEN` (`crates/card-neural/train/README.md`) "
                "and the next one starts it itself.")
    output("pr", url)
    return url


# --- mark ---------------------------------------------------------------------------------------


def mark(store, run: str, pr: str = "", smoke: bool = False) -> dict:
    if not RUN_NAME.match(run):
        raise Refused(f"{run!r} is not a run name.")
    record = {"pr": pr or None, "delivered_at": now()}
    if smoke:
        record["smoke"] = True
    store.write(f"runs/{run}/DELIVERED.json", json.dumps(record, indent=1).encode())
    summary(f"Marked run `{run}` delivered: " + (pr or "a smoke run, checked") + ".")
    return record


# --- the command line ---------------------------------------------------------------------------


def run_all(args) -> None:
    """By hand: find, build, publish and mark in one process (or a dry run of the first two)."""
    store = store_for(args.from_dir)
    work = Path(tempfile.mkdtemp(prefix="neural-run-"))
    out = args.out or Path(tempfile.mkdtemp(prefix="neural-delivery-"))
    picked = find(store, args.run or "", work, mark_failed=not args.dry_run)
    if picked is None:
        return
    delivery = build(work, out, scratch=args.dry_run, test=not args.dry_run)
    if args.dry_run:
        print(f"\nDry run: the rewritten README.md and training.json are in {out / 'models'}; "
              "nothing was tested, pushed or written to the Volume.")
        return
    pr = publish(out)
    mark(store, picked["run"], pr, delivery["smoke"])


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = ap.add_subparsers(dest="command", required=True)

    p = sub.add_parser("find", help="report the runs; download the one to deliver")
    p.add_argument("--run", default="", help="just this run (empty: the oldest finished one)")
    p.add_argument("--out", type=Path, help="where to download it")
    p.add_argument("--from-dir", type=Path, help="a folder laid out as the Volume, instead of it")

    p = sub.add_parser("build", help="gallery.bin, README.md, training.json and the PR body")
    p.add_argument("--work", type=Path, required=True, help="what `find --out` downloaded")
    p.add_argument("--out", type=Path, required=True)
    p.add_argument("--scratch", action="store_true", help="leave the repository's models/ alone; no test")

    p = sub.add_parser("publish", help="branch, commit, push and open the pull request")
    p.add_argument("--work", type=Path, required=True, help="what `build --out` wrote")
    p.add_argument("--base", default=BASE)

    p = sub.add_parser("mark", help="write DELIVERED.json for a run")
    p.add_argument("--run", required=True)
    p.add_argument("--pr", default="")
    p.add_argument("--smoke", default="false", help="true for a smoke run")
    p.add_argument("--from-dir", type=Path)

    p = sub.add_parser("run", help="all four, by hand")
    p.add_argument("--run", default="")
    p.add_argument("--from-dir", type=Path)
    p.add_argument("--out", type=Path, help="where the delivery is written (a new temporary folder if not)")
    p.add_argument("--dry-run", action="store_true", help="a scratch copy and the PR body; nothing tested, pushed or marked")

    args = ap.parse_args(argv)
    try:
        if args.command == "find":
            find(store_for(args.from_dir), args.run, args.out)
        elif args.command == "build":
            build(args.work, args.out, scratch=args.scratch)
        elif args.command == "publish":
            publish(args.work, base=args.base)
        elif args.command == "mark":
            mark(store_for(args.from_dir), args.run, args.pr, args.smoke == "true")
        else:
            run_all(args)
    except Refused as refused:
        summary(f"\n**Not delivered**: {refused}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
