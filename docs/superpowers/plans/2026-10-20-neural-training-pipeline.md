# Neural training pipeline — plan

**Goal**: retrain the Neural scanner's two networks once a month (and on demand) on a Modal GPU,
from GitHub Actions, with Scryfall's images kept up to date on a Modal Volume, and the new model
files delivered back to this repository as a pull request.

Owner's decisions (2026-10-20): the pipeline's code lives here, in `crates/card-neural/train/`
(the experiments stay in the scanner lab); results come back as a **PR**; **both** networks
retrain monthly; **a hard limit of $10 a run**.

## Sizing (measured 2026-10-20, `E:\mtg-scanner\scratch\qd-tools\bench_modal.py`)

Training is **CPU-bound**: one data worker on the 5900X draws ~41 embedder views/s or ~31
detector scenes/s, while the 4070 Ti alone trains 8 400 views/s or 2 000 scenes/s (bf16). An L4
is roughly half a 4070 Ti, so on Modal the GPU waits on the CPU at any affordable core count;
cores are what buy time, and they are cheap ($0.047/core·h against the L4's $0.80/h).

**Default: one L4, 16 physical cores, 24 GiB per network, the two networks in parallel.**
Estimated ~1.0 h and ~$1.80 (embedder), ~1.2 h and ~$2.10 (detector), ~$3.90 a run, ~$7.40 if
Modal's cores are half as fast as assumed. Every number is a workflow input.

## Layout on the Volume (`card-neural`, Volumes v2), mounted at `/vol`

```text
/vol/data/scryfall/
  default_cards.jsonl.gz   the bulk file
  index.jsonl              one row per paper printing face (scryfall_fetch.py)
  looks.json               looks.py
  normal/<2 hex>/<id>.jpg  each face's `normal` scan, sharded by the id's first two characters
  fetch.json               {fetched_at, faces, downloaded, refreshed, failed, bytes}
/vol/runs/<run>/
  run.json                 {run, git_sha, started_at, detector: bool, resources, budget_usd, smoke}
  spend.json               {stage: {seconds, usd}} — every stage's container time, across restarts
  embedder/                checkpoint.pt (resume), log.jsonl, last.pt, last.head.pt, best.*
  embedder/export/         embedder.onnx, gallery.head.matrix, gallery.json
  detector/                checkpoint.pt, log.jsonl, last.pt, best.pt
  detector/export/         detector.onnx
  DONE.json                written last: {run, status: "ok" | "failed", reason?, git_sha, finished_at,
                           spend_usd, metrics: {embedder: {retrieval_top1, epochs, views_per_s},
                           detector?: {found, corner_err, corner_err_p90, wrong_way, scenes_per_s}},
                           files: {<name>: <volume path>}}
  DELIVERED.json           written by the delivery workflow: {pr, delivered_at}
```

Run names: `YYYY-MM` for the monthly run, `YYYY-MM-DD-HHMM` for a manual one.

## The pieces

1. **`crates/card-neural/train/`** — the production subset of the lab's `train/`: `scryfall_fetch.py`
   (sharded, incremental: a face is downloaded again when its image URL's `?<timestamp>` changed),
   `looks.py`, `qd_scene.py`, `qd_data.py`, `qd_model.py`, `qd_train.py`, `qd_export.py`,
   `qd_detect_data.py`, `qd_detector.py`, `qd_detect_train.py`, `requirements.txt` (pinned: torch
   2.14.1 cu126, timm 1.0.30, opencv-python-headless 5.0, numpy 2.2.6). Changes from the lab: the
   sharded path (flat still read), **full resume** (`checkpoint.pt`: weights, head, optimizer, step,
   epoch, RNG; saved each epoch / each eval), worker count and prefetch from arguments,
   `qd_export.py --head-only` (no clean-scan pass when every look has a class weight). The recipe —
   epochs, batch sizes, learning rates, augmentations — is the one the shipped files were trained by.
2. **`crates/card-neural/train/modal_app.py`** — the Modal app `card-neural-train`: the image
   (Debian slim, Python 3.10, the pinned wheels, this folder), the Volume, and functions `refresh`
   (CPU), `train_embedder`, `train_detector` (L4) and `pipeline` (a small CPU orchestrator that
   refreshes, runs both trainings in parallel, enforces the budget and writes `DONE.json`).
   `launch.py` spawns `pipeline` on the deployed app and prints the run name.
3. **The budget guard** (`budget.py`): Modal's per-second rates; each GPU stage runs its trainer as
   a subprocess under a watchdog that adds its container-seconds to `spend.json` every minute and
   stops the trainer when the run's projected spend would pass the budget (default $10). Function
   timeouts are set so that even with the guard gone the stages cannot pass it.
4. **`.github/workflows/neural-train.yml`** — monthly cron and `workflow_dispatch` (inputs:
   `detector`, `cpu`, `memory_gib`, `budget_usd`, `smoke`): deploys the app from the triggering
   commit and spawns the pipeline. Secrets `MODAL_TOKEN_ID`, `MODAL_TOKEN_SECRET`.
5. **`.github/workflows/neural-deliver.yml`** — every 6 hours and on dispatch (`run`): finds runs with
   `DONE.json` `ok` and no `DELIVERED.json`, downloads the files, builds `gallery.bin`
   (`build-gallery`), rewrites `models/README.md`'s table, runs `cargo test -p card-neural`, pushes a
   branch and opens a PR (token `NEURAL_PR_TOKEN`, so CI runs on it; `GITHUB_TOKEN` otherwise), then
   writes `DELIVERED.json`. The PR body carries the metrics against the current files', the spend,
   and the caveat: `neural.json`'s thresholds were tuned for the previous pair — replay the
   readers' scans before merging.
