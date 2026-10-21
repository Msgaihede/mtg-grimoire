"""What a training run may spend on Modal, and the ledger that holds it to that.

**The owner's hard limit is $10 a run** (2026-10-20). Modal cannot enforce it per run: GPU
containers are always preemptible, a preempted container restarts with a fresh timeout, and
budgets are per workspace and per month. So each stage keeps its own ledger on the Volume —
the container-seconds it has used across every attempt — and stops itself before its share of
the run's budget is gone (`modal_app.py`'s watchdog). The shares are fixed up front, so two
stages running at once never need to agree on a total.

The rates are Modal's list prices, read from https://modal.com/pricing on 2026-10-20 — base
prices, no region pinning (×1.15–1.75) and no non-preemptible multiplier (×3), neither of which
this pipeline asks for. **Change them here when Modal changes them**; a guard on stale rates
guards nothing.
"""
from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass
from pathlib import Path

# Per second, in US dollars (https://modal.com/pricing, 2026-10-20).
GPU_PER_S = {"L4": 0.000222, "T4": 0.000164, "A10": 0.000306, "L40S": 0.000542}
CPU_CORE_PER_S = 0.0000131  # a physical core (two vCPUs)
MEMORY_GIB_PER_S = 0.00000222

# The hard limit, and what is set aside before the four trainings share the rest.
HARD_LIMIT_USD = 10.0
REFRESH_USD = 0.25  # the Scryfall refresh: a few CPU minutes
PIPELINE_USD = 0.10  # the orchestrator: a quarter core for the length of the run
# The refresh's container (no GPU), here rather than in `modal_app.py` because its rate is part of
# the reserve below.
REFRESH_CPU = 4.0
REFRESH_MEMORY_GIB = 4
# Each training's estimated cost on the default container (an L4, 16 cores, 24 GiB: $1.75 an
# hour), its whole container life: the start, the dataset's copy (~5 min), the training and the
# export. The embedder ~1.0 h and the detector ~1.2 h of training (the plan's sizing); the set
# symbol network 12 epochs (~57 min) and the collector band's 14 (~60 min), at the ~450 views/s
# they drew on the owner's machine. `train/README.md` ("The budget") has the arithmetic. The
# trainings share what the refresh, the orchestrator and the watchdogs' reserve leave in
# proportion to these, so each gets its estimate and the same margin: ~11 % at the default $10.
ESTIMATE_USD = {"embedder": 2.01, "detector": 2.33, "symbol": 1.92, "band": 2.04}
# Charged once per container start, on top of the seconds the watchdog sees: scheduling and the
# image pull happen before any of this code runs.
START_OVERHEAD_S = 120
# The watchdog (`modal_app.Guard`): how often it adds a container's seconds to its ledger, and how
# long it lets a stopped command take to exit before it kills it.
GUARD_TICK_S = 30.0
KILL_TIMEOUT_S = 60
# The most a guarded stage can spend past its share. A ledger under its limit admits one more
# attempt and charges its start overhead; the watchdog sees the share gone only at its next tick;
# and the command it stops has the kill timeout to exit, seconds no ledger records. After that the
# ledger is over and refuses every later attempt, so this happens once a stage.
OVERRUN_S = START_OVERHEAD_S + GUARD_TICK_S + KILL_TIMEOUT_S


class BudgetExceeded(RuntimeError):
    """A stage has used its share of the run's budget."""


def rate_per_s(gpu: str | None, cpu: float, memory_gib: float) -> float:
    """What one second of a container costs."""
    gpu_rate = GPU_PER_S[gpu] if gpu else 0.0
    return gpu_rate + cpu * CPU_CORE_PER_S + memory_gib * MEMORY_GIB_PER_S


REFRESH_RATE = rate_per_s(None, REFRESH_CPU, REFRESH_MEMORY_GIB)


def overrun_usd(rate: float) -> float:
    """The most a stage guarded at `rate` can spend past its share (`OVERRUN_S`)."""
    return OVERRUN_S * rate


def shares(budget_usd: float, detector: bool, rate: float) -> dict[str, float]:
    """Each stage's share of a run's budget, the limit its ledger holds it to: the refresh's and the
    orchestrator's set amounts, and the rest to the trainings at `rate` in proportion to their
    estimates (the detector's only when it trains). The rest is what is left once every guarded
    stage's overrun is set aside too, so the shares and every overrun together never pass the
    budget. Refuses a budget over the hard limit."""
    if budget_usd > HARD_LIMIT_USD:
        raise ValueError(f"a run may spend at most ${HARD_LIMIT_USD:.2f}, not ${budget_usd:.2f}")
    trainings = {k: v for k, v in ESTIMATE_USD.items() if detector or k != "detector"}
    reserve = overrun_usd(REFRESH_RATE) + len(trainings) * overrun_usd(rate)
    rest = budget_usd - REFRESH_USD - PIPELINE_USD - reserve
    if rest <= 0:
        raise ValueError(f"${budget_usd:.2f} leaves nothing for training")
    total = sum(trainings.values())
    return {"refresh": REFRESH_USD, "pipeline": PIPELINE_USD, **{k: rest * v / total for k, v in trainings.items()}}


def max_seconds(stage_usd: float, rate: float) -> int:
    """How long a stage's share lasts at `rate`, its start overhead taken out."""
    return max(0, int(stage_usd / rate) - START_OVERHEAD_S)


@dataclass
class Ledger:
    """One stage's spend, kept in `<run>/spend/<stage>.json` — a file per stage, so stages that run
    at once never write the same file."""

    run_dir: Path
    stage: str
    rate: float
    limit_usd: float

    @property
    def path(self) -> Path:
        return self.run_dir / "spend" / f"{self.stage}.json"

    def read(self) -> dict:
        try:
            return json.loads(self.path.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError):
            return {"seconds": 0.0, "usd": 0.0, "attempts": 0}

    def _write(self, entry: dict) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(entry), encoding="utf-8")
        os.replace(tmp, self.path)

    def start(self) -> dict:
        """Count a new attempt and its start overhead; refuse one with nothing left to spend."""
        entry = self.read()
        if entry["usd"] >= self.limit_usd:
            raise BudgetExceeded(
                f"{self.stage} has spent ${entry['usd']:.2f} of its ${self.limit_usd:.2f}"
            )
        entry["attempts"] += 1
        return self.add(START_OVERHEAD_S, entry)

    def add(self, seconds: float, entry: dict | None = None) -> dict:
        entry = dict(entry or self.read())
        entry["seconds"] = round(entry["seconds"] + seconds, 1)
        entry["usd"] = round(entry["seconds"] * self.rate, 4)
        entry["rate_per_s"] = self.rate
        entry["limit_usd"] = round(self.limit_usd, 4)
        entry["updated_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        self._write(entry)
        return entry

    def over(self, entry: dict | None = None) -> bool:
        return (entry or self.read())["usd"] >= self.limit_usd


def total_usd(run_dir: Path) -> float:
    """Everything every stage of a run has recorded."""
    spent = 0.0
    for f in (run_dir / "spend").glob("*.json"):
        try:
            spent += json.loads(f.read_text(encoding="utf-8"))["usd"]
        except (json.JSONDecodeError, KeyError):
            continue
    return round(spent, 4)
