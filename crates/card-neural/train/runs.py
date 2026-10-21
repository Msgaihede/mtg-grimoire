"""What the trainers (qd_train.py, qd_detect_train.py, ev_train.py) share about a run directory:
the checkpoint they resume from, the random states it carries, the log they append to, and how
many data workers they start.

The pipeline's GPU containers are preemptible, and a preempted one is started again with the same
arguments. So a trainer writes `checkpoint.pt` into its run directory at every save point — the
weights, the ArcFace head, the optimiser, the step and epoch, the best metric, every row it has
logged, the torch/CUDA/NumPy/Python random states and its arguments — and on start resumes from
one it finds there: the learning-rate schedule goes on from the saved step and log.jsonl gains
only rows it lacks. A run whose every epoch or step is done prints its final line and exits 0.

Every file is written to a temporary name and renamed over the old one (`atomic_save`), so a kill
mid-write leaves the previous file whole. A view's own randomness comes from `os.urandom`, as the
lab's recipe has it, so a resumed run continues the same recipe, not the same draws bit for bit.
"""
import json
import os
import random
from pathlib import Path

import numpy as np
import torch

CHECKPOINT = "checkpoint.pt"


def default_workers() -> int:
    """Every core this process may run on but two (the trainer itself and the batches' copy to the
    GPU): the data workers are what a step waits on. A Modal container may report its host's
    cores, so the pipeline passes `--workers` itself."""
    try:
        cpus = len(os.sched_getaffinity(0))
    except AttributeError:  # Windows, macOS
        cpus = os.cpu_count() or 4
    return max(1, cpus - 2)


def atomic_save(obj, path: Path) -> None:
    """torch.save to a temporary file beside `path`, flushed to disk, then renamed over it."""
    path = Path(path)
    tmp = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    try:
        with open(tmp, "wb") as f:
            torch.save(obj, f)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    finally:
        if tmp.exists():
            tmp.unlink()


def clear_partials(run: Path) -> None:
    """The temporary files of a save a kill interrupted."""
    for p in Path(run).glob("*.pt.*.tmp"):
        p.unlink(missing_ok=True)


def rng_state() -> dict:
    """torch's, every CUDA device's, NumPy's and Python's global random states, as plain types and
    tensors (`torch.load(weights_only=True)` reads them back)."""
    name, keys, pos, has_gauss, cached = np.random.get_state()
    return {
        "torch": torch.get_rng_state(),
        "cuda": torch.cuda.get_rng_state_all() if torch.cuda.is_available() else [],
        "numpy": {"name": name, "keys": keys.tolist(), "pos": int(pos), "has_gauss": int(has_gauss), "cached": float(cached)},
        "python": random.getstate(),
    }


def set_rng_state(state: dict) -> None:
    torch.set_rng_state(state["torch"])
    if state["cuda"] and torch.cuda.is_available():
        torch.cuda.set_rng_state_all(state["cuda"][: torch.cuda.device_count()])
    n = state["numpy"]
    np.random.set_state((n["name"], np.array(n["keys"], dtype=np.uint32), n["pos"], n["has_gauss"], n["cached"]))
    version, internal, gauss = state["python"]
    random.setstate((version, tuple(internal), gauss))


def load_checkpoint(run: Path) -> dict | None:
    path = Path(run) / CHECKPOINT
    if not path.exists():
        return None
    return torch.load(path, map_location="cpu", weights_only=True)


def check_recipe(ckpt: dict, args, keys: tuple[str, ...], run: Path) -> None:
    """Refuse to resume a checkpoint made with another recipe: the run directory is a run."""
    saved = ckpt["args"]
    diff = [f"--{k.replace('_', '-')} {saved.get(k)!r} there, {getattr(args, k)!r} now"
            for k in keys if saved.get(k) != getattr(args, k)]
    if diff:
        raise SystemExit(f"{Path(run) / CHECKPOINT} was made with other arguments ({'; '.join(diff)}): "
                         "start a new run directory, or delete it to start this one over")


def file_sha256(path: Path) -> str:
    import hashlib

    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def reconcile_log(path: Path, rows: list[dict], key: str, done: dict | None = None) -> None:
    """Append to log.jsonl the checkpoint's rows it lacks (a kill between the checkpoint and the
    log's write), and `done` when it has no final line yet; never a row twice."""
    have, finished, torn = set(), False, False
    if Path(path).exists():
        text = Path(path).read_text(encoding="utf-8")
        torn = bool(text) and not text.endswith("\n")  # a kill mid-line: end it before appending
        for line in text.splitlines():
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not isinstance(row, dict):
                continue
            if row.get("done"):
                finished = True
            elif key in row:
                have.add(row[key])
    missing = [r for r in rows if r[key] not in have]
    if torn or missing or (done is not None and not finished):
        with open(path, "a", encoding="utf-8") as log:
            if torn:
                log.write("\n")
            for r in missing:
                log.write(json.dumps(r) + "\n")
            if done is not None and not finished:
                log.write(json.dumps(done) + "\n")
