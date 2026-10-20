"""The Neural scanner's training pipeline on Modal: app `card-neural-train`.

    modal deploy crates/card-neural/train/modal_app.py      # the workflow does this per run
    python crates/card-neural/train/launch.py --run 2026-11   # spawns `pipeline` and returns

`pipeline` (a small CPU container) refreshes Scryfall's images on the Volume, runs both
trainings at once on L4s, and writes `DONE.json`; `.github/workflows/neural-deliver.yml` turns a
finished run into a pull request. The layout of the Volume and the contract with the delivery are
`docs/superpowers/plans/2026-10-20-neural-training-pipeline.md`.

**Sized for a CPU-bound trainer.** On the owner's machine one data worker draws ~41 embedder views
or ~31 detector scenes a second, and the GPU alone could take 8 400 and 2 000 (bf16): the GPU waits
on the CPU at any affordable core count, so each training gets 16 physical cores (two data workers
each) beside its L4, and both run at once. ~$3.90 a run estimated; every resource is a launch
argument, and `budget.py` holds the run to the owner's $10 whatever they are.

**Preemption**: Modal's GPU containers are always preemptible; a preempted container restarts
with the same input. The trainers resume from their `checkpoint.pt`, the orchestrator rejoins the
calls it spawned (their ids are in `stages.json`), and the ledgers carry spend across restarts.
"""
from __future__ import annotations

import json
import os
import shutil
import signal
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import modal

# `budget.py` sits beside this file: on the deploying machine its folder is put on the path here,
# and in the container the image's PYTHONPATH names the folder it was copied to.
sys.path.insert(0, str(Path(__file__).parent))
import budget  # noqa: E402

APP_NAME = "card-neural-train"
VOLUME_NAME = "card-neural"
# Paths in the container, spelled as POSIX strings: `str(Path("/vol"))` is `\vol` on the Windows
# machine that deploys, and Modal refuses that for a mount or a remote path.
VOL_MOUNT = "/vol"
CODE_DIR = "/root/train"
VOL = Path(VOL_MOUNT)
DATA = VOL / "data" / "scryfall"
RUNS = VOL / "runs"
CODE = Path(CODE_DIR)
LOCAL_DATA = Path("/tmp/scryfall")
GPU = "L4"
# What each training container gets unless the launch says otherwise (see the module doc).
TRAIN_CPU = 16.0
TRAIN_MEMORY_GIB = 24
REFRESH_CPU = 4.0
REFRESH_MEMORY_GIB = 4
PIPELINE_CPU = 0.25
PIPELINE_MEMORY_GIB = 0.5
# Below these the run is a failure and is not delivered — well under what the shipped pair
# reached (retrieval top-1 0.9997; found 0.993, corner error 2.8 %), so only a broken run trips them.
FLOORS = {
    "embedder": {"retrieval_top1": 0.99},
    "detector": {"found": 0.98, "corner_err_max": 0.04, "wrong_way_max": 0.01},
}

HERE = Path(__file__).parent
image = (
    modal.Image.debian_slim(python_version="3.10")
    .pip_install_from_requirements(
        str(HERE / "requirements.txt"),
        extra_index_url="https://download.pytorch.org/whl/cu126",
    )
    .env({"PYTHONPATH": CODE_DIR, "PYTHONUNBUFFERED": "1"})
    # Last: a local folder is added at container start, after every build step.
    .add_local_dir(str(HERE), remote_path=CODE_DIR, ignore=["tests", "__pycache__", "*.pyc"])
)
volume = modal.Volume.from_name(VOLUME_NAME, create_if_missing=True, version=2)
app = modal.App(APP_NAME, image=image)


def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _read_json(path: Path, default=None):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def _write_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(value, indent=1), encoding="utf-8")
    os.replace(tmp, path)


class Guard:
    """A stage's spend, held to its share for the whole life of its container — copying the
    dataset as much as training — by a thread that adds the container's seconds to the stage's
    ledger every `tick_s` and stops whatever is running once the share is spent. Volumes v2 commits
    in the background every few seconds, so the ledger reaches the Volume without a commit here."""

    def __init__(self, ledger: budget.Ledger, tick_s: float = 30.0):
        self.ledger = ledger
        self.tick_s = tick_s
        self.proc: subprocess.Popen | None = None
        self.over = threading.Event()
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._watch, daemon=True)

    def __enter__(self) -> "Guard":
        self.ledger.start()  # refuses a stage with nothing left; counts the start overhead
        self._thread.start()
        return self

    def __exit__(self, *exc) -> None:
        self._stop.set()
        self._thread.join()

    def _watch(self) -> None:
        last = time.monotonic()
        while not self._stop.wait(self.tick_s):
            now = time.monotonic()
            entry = self.ledger.add(now - last)
            last = now
            if self.ledger.over(entry):
                self.over.set()
                self._kill()
                return
        self.ledger.add(time.monotonic() - last)

    def _kill(self) -> None:
        proc = self.proc
        if proc is None or proc.poll() is not None:
            return
        proc.send_signal(signal.SIGTERM)
        try:
            proc.wait(timeout=60)
        except subprocess.TimeoutExpired:
            proc.kill()

    def check(self) -> None:
        if self.over.is_set():
            raise budget.BudgetExceeded(f"{self.ledger.stage} stopped at its ${self.ledger.limit_usd:.2f} share")

    def run(self, cmd: list[str], log_path: Path) -> list[dict]:
        """`cmd` with its output teed to `log_path` and Modal's log; every JSON line it printed.
        Raises `BudgetExceeded` when the guard stopped it, `CalledProcessError` when it failed."""
        self.check()
        log_path.parent.mkdir(parents=True, exist_ok=True)
        rows: list[dict] = []
        self.proc = subprocess.Popen(cmd, cwd=CODE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                     text=True, bufsize=1)
        with open(log_path, "a", encoding="utf-8") as log:
            for line in self.proc.stdout:
                sys.stdout.write(line)
                log.write(line)
                log.flush()
                if line.startswith("{"):
                    try:
                        rows.append(json.loads(line))
                    except json.JSONDecodeError:
                        pass
        code = self.proc.wait()
        self.proc = None
        self.check()
        if code != 0:
            raise subprocess.CalledProcessError(code, cmd)
        return rows


def _stage_local_copy() -> Path:
    """The dataset on the container's own disk: the trainers read every scan once an epoch, and
    a local disk answers that faster than a network volume. ~11 GB; sharded folders copied in
    parallel. Kept for the container's life, so a resumed trainer in the same container skips it."""
    marker = LOCAL_DATA / ".copied"
    if marker.exists():
        return LOCAL_DATA
    started = time.monotonic()
    LOCAL_DATA.mkdir(parents=True, exist_ok=True)
    for name in ("index.jsonl", "looks.json"):
        shutil.copy2(DATA / name, LOCAL_DATA / name)
    shards = sorted(p for p in (DATA / "normal").iterdir() if p.is_dir())

    def copy(shard: Path):
        shutil.copytree(shard, LOCAL_DATA / "normal" / shard.name, dirs_exist_ok=True)

    with ThreadPoolExecutor(32) as pool:
        list(pool.map(copy, shards))
    marker.write_text(_now(), encoding="utf-8")
    print(json.dumps({"copied": len(shards), "seconds": round(time.monotonic() - started)}), flush=True)
    return LOCAL_DATA


def _workers(cpu: float) -> int:
    """Two data workers a physical core (Modal's cores are two vCPUs each), less the trainer's own."""
    return max(1, int(cpu * 2) - 2)


@app.function(volumes={VOL_MOUNT: volume}, cpu=REFRESH_CPU, memory=REFRESH_MEMORY_GIB * 1024, timeout=3600)
def refresh(run: str, limit_usd: float) -> dict:
    """Bring Scryfall's bulk data and every paper face's `normal` scan up to date on the Volume,
    then regroup the looks. Incremental: only new and changed scans are downloaded."""
    volume.reload()
    run_dir = RUNS / run
    ledger = budget.Ledger(run_dir, "refresh", budget.rate_per_s(None, REFRESH_CPU, REFRESH_MEMORY_GIB), limit_usd)
    DATA.mkdir(parents=True, exist_ok=True)
    log = run_dir / "refresh.out"
    with Guard(ledger) as guard:
        guard.run([sys.executable, "-u", "scryfall_fetch.py", str(DATA), "--workers", "64"], log)
        guard.run([sys.executable, "-u", "looks.py", str(DATA)], log)
    volume.commit()
    return _read_json(DATA / "fetch.json", {})


def _train(stage: str, run: str, cpu: float, memory_gib: float, limit_usd: float, cmd_for, export_for) -> dict:
    volume.reload()
    run_dir = RUNS / run
    out = run_dir / stage
    ledger = budget.Ledger(run_dir, stage, budget.rate_per_s(GPU, cpu, memory_gib), limit_usd)
    with Guard(ledger) as guard:
        data = _stage_local_copy()
        guard.check()
        rows = guard.run(cmd_for(data, out), out / "train.out")
        guard.run(export_for(data, out), out / "export.out")
    volume.commit()
    return {"rows": rows, "spend": ledger.read()}


@app.function(volumes={VOL_MOUNT: volume}, gpu=GPU, cpu=TRAIN_CPU, memory=TRAIN_MEMORY_GIB * 1024,
              timeout=4 * 3600, retries=modal.Retries(max_retries=2, initial_delay=30.0))
def train_embedder(run: str, cpu: float, memory_gib: float, limit_usd: float, smoke: bool) -> dict:
    """The embedder, from Apache-2.0 ImageNet weights, on the looks the refresh grouped — the
    recipe the shipped file was trained by (`qd_train.py`'s defaults) — and its export."""

    def cmd(data: Path, out: Path) -> list[str]:
        args = [sys.executable, "-u", "qd_train.py", str(data), str(out),
                "--workers", str(_workers(cpu)), "--prefetch", "2"]
        if smoke:
            args += ["--epochs", "1", "--eval-every", "1", "--eval-looks", "300"]
        return args

    def export(data: Path, out: Path) -> list[str]:
        return [sys.executable, "-u", "qd_export.py", str(data), str(out / "last.pt"), str(out / "export"), "--head-only"]

    result = _train("embedder", run, cpu, memory_gib, limit_usd, cmd, export)
    evals = [r for r in result["rows"] if "retrieval_top1" in r]
    epochs = [r for r in result["rows"] if "epoch" in r and "views_per_s" in r]
    return {
        "retrieval_top1": evals[-1]["retrieval_top1"] if evals else None,
        "epochs": epochs[-1]["epoch"] if epochs else None,
        "views_per_s": epochs[-1]["views_per_s"] if epochs else None,
        "usd": result["spend"]["usd"],
    }


@app.function(volumes={VOL_MOUNT: volume}, gpu=GPU, cpu=TRAIN_CPU, memory=TRAIN_MEMORY_GIB * 1024,
              timeout=4 * 3600, retries=modal.Retries(max_retries=2, initial_delay=30.0))
def train_detector(run: str, cpu: float, memory_gib: float, limit_usd: float, smoke: bool) -> dict:
    """The corner detector on synthetic scenes (`qd_detect_train.py`'s defaults), and its export."""

    def cmd(data: Path, out: Path) -> list[str]:
        args = [sys.executable, "-u", "qd_detect_train.py", str(data), str(out),
                "--workers", str(_workers(cpu)), "--prefetch", "2"]
        if smoke:
            args += ["--steps", "300", "--eval-every", "150", "--eval-batches", "4"]
        return args

    def export(data: Path, out: Path) -> list[str]:
        return [sys.executable, "-u", "qd_detector.py", "export", str(out / "last.pt"), str(out / "export")]

    result = _train("detector", run, cpu, memory_gib, limit_usd, cmd, export)
    evals = [r for r in result["rows"] if "found" in r]
    last = evals[-1] if evals else {}
    return {
        "found": last.get("found"),
        "corner_err": last.get("corner_err"),
        "corner_err_p90": last.get("corner_err_p90"),
        "wrong_way": last.get("wrong_way"),
        "scenes_per_s": last.get("scenes_per_s"),
        "steps": last.get("step"),
        "usd": result["spend"]["usd"],
    }


def _floors_failed(metrics: dict) -> list[str]:
    failed = []
    e = metrics.get("embedder") or {}
    if (e.get("retrieval_top1") or 0) < FLOORS["embedder"]["retrieval_top1"]:
        failed.append(f"embedder retrieval top-1 {e.get('retrieval_top1')} under {FLOORS['embedder']['retrieval_top1']}")
    d = metrics.get("detector")
    if d is not None:
        f = FLOORS["detector"]
        if (d.get("found") or 0) < f["found"]:
            failed.append(f"detector found {d.get('found')} under {f['found']}")
        if (d.get("corner_err") or 1) > f["corner_err_max"]:
            failed.append(f"detector corner error {d.get('corner_err')} over {f['corner_err_max']}")
        if (d.get("wrong_way") or 1) > f["wrong_way_max"]:
            failed.append(f"detector wrong way {d.get('wrong_way')} over {f['wrong_way_max']}")
    return failed


def _call(stages: dict, key: str, spawn, run_dir: Path):
    """The stage's call: the one already spawned (a restarted orchestrator rejoins it), else a new one."""
    if stages.get(key):
        return modal.FunctionCall.from_id(stages[key])
    call = spawn()
    stages[key] = call.object_id
    _write_json(run_dir / "stages.json", stages)
    volume.commit()
    return call


@app.function(volumes={VOL_MOUNT: volume}, cpu=PIPELINE_CPU, memory=int(PIPELINE_MEMORY_GIB * 1024), timeout=24 * 3600)
def pipeline(run: str, detector: bool = True, cpu: float = TRAIN_CPU, memory_gib: float = TRAIN_MEMORY_GIB,
             budget_usd: float = budget.HARD_LIMIT_USD, smoke: bool = False, git_sha: str = "") -> dict:
    """One run, start to finish: refresh, both trainings at once, `DONE.json`."""
    volume.reload()
    run_dir = RUNS / run
    if (run_dir / "DONE.json").exists():
        return _read_json(run_dir / "DONE.json")
    share = budget.shares(budget_usd, detector)
    rate = budget.rate_per_s(GPU, cpu, memory_gib)
    info = _read_json(run_dir / "run.json") or {
        "run": run, "git_sha": git_sha, "started_at": _now(), "detector": detector, "smoke": smoke,
        "resources": {"gpu": GPU, "cpu": cpu, "memory_gib": memory_gib},
        "budget_usd": budget_usd, "shares_usd": share,
    }
    _write_json(run_dir / "run.json", info)
    ledger = budget.Ledger(run_dir, "pipeline", budget.rate_per_s(None, PIPELINE_CPU, PIPELINE_MEMORY_GIB), share["pipeline"])
    ledger.start()
    stages = _read_json(run_dir / "stages.json", {})
    volume.commit()
    started = time.monotonic()
    done = {"run": run, "git_sha": info["git_sha"], "smoke": info["smoke"], "detector": detector}
    try:
        _call(stages, "refresh", lambda: refresh.spawn(run, share["refresh"]), run_dir).get()
        # A training's timeout is its share of the budget at its rate, with ten minutes over: even
        # with its ledger gone, one attempt cannot spend much past its share.
        def options(fn, key):
            seconds = budget.max_seconds(share[key], rate) + 600
            return fn.with_options(cpu=cpu, memory=int(memory_gib * 1024), timeout=min(24 * 3600, seconds))

        calls = {"embedder": _call(stages, "embedder", lambda: options(train_embedder, "embedder").spawn(
            run, cpu, memory_gib, share["embedder"], smoke), run_dir)}
        if detector:
            calls["detector"] = _call(stages, "detector", lambda: options(train_detector, "detector").spawn(
                run, cpu, memory_gib, share["detector"], smoke), run_dir)
        metrics, errors = {}, []
        for key, call in calls.items():
            try:
                metrics[key] = call.get()
            except Exception as e:  # a stage's failure is the run's, in words
                errors.append(f"{key}: {type(e).__name__}: {e}")
        # A smoke run proves the plumbing in one epoch and is never delivered: no floors.
        failed = errors or ([] if smoke else _floors_failed(metrics))
        files = {"embedder.onnx": f"runs/{run}/embedder/export/embedder.onnx",
                 "gallery.head.matrix": f"runs/{run}/embedder/export/gallery.head.matrix",
                 "gallery.json": f"runs/{run}/embedder/export/gallery.json"}
        if detector:
            files["detector.onnx"] = f"runs/{run}/detector/export/detector.onnx"
        done.update({"status": "failed" if failed else "ok", "metrics": metrics, "files": files})
        if failed:
            done["reason"] = "; ".join(failed)
    except Exception as e:
        done.update({"status": "failed", "reason": f"{type(e).__name__}: {e}"})
    finally:
        ledger.add(time.monotonic() - started)
    # Our own ledger first, then the stages' spend as they committed it.
    volume.commit()
    volume.reload()
    done["spend_usd"] = budget.total_usd(run_dir)
    done["finished_at"] = _now()
    _write_json(run_dir / "DONE.json", done)
    volume.commit()
    print(json.dumps(done), flush=True)
    return done
