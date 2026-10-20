# The Neural scanner's training code

The production subset of the scanner lab's `E:\mtg-scanner\spike\train\`: what made the shipped
`models/` (runs `qd-mnv4-e` and `det-a`, 2026-10-20), set up to run again every month on a Modal
GPU (`modal_app.py`; the plan is `docs/superpowers/plans/2026-10-20-neural-training-pipeline.md`).
The experiments — the oracle and Quickdraw comparisons, the readers'-crops fine-tuning, the
cross-validation folds — stay in the lab, and so does the research write-up
(`E:\mtg-scanner\docs\neural-scanner.md` §4.2–4.3, which explains the recipe).

**The recipe is the shipped one**: every default below but `--workers` and `--prefetch` is the
shipped runs' value (their `run.json`), and the epochs, batches, learning rates, margins, warm-ups, augmentations, scene
contexts, image sizes and the bf16 autocast are the lab's code unchanged. Change one and the
`neural.json` thresholds, tuned on the shipped pair, are suspect.

## The scripts

| file                 | what it does                                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `scryfall_fetch.py`  | Scryfall's bulk `default_cards` and every paper printing face's `normal` scan, incrementally (below)                     |
| `looks.py`           | groups the faces into looks (`looks.json`); also where a face's scan is (`scan_path`, sharded or flat)                   |
| `qd_scene.py`        | where a card sits when scanned — loose, sleeved, in a binder pocket, in a toploader — drawn around it                    |
| `qd_data.py`         | the embedder's training views: a card through a simulated camera, cut through the corners a detector would give; `Looks` |
| `qd_model.py`        | the embedder (timm `mobilenetv4_conv_small.e2400_r224_in1k` + `Linear(1280→128)`) and the ArcFace head                   |
| `qd_train.py`        | trains the embedder: ArcFace over every look, 30 epochs                                                                  |
| `qd_export.py`       | `embedder.onnx` and the gallery (`gallery.head.matrix` + `gallery.json`; with the clean-scan pass also `gallery.matrix`) |
| `qd_detect_data.py`  | the detector's synthetic scenes and their CenterNet targets                                                              |
| `qd_detector.py`     | the detector (timm `mobilenetv3_small_075.lamb_in1k` + FPN-lite neck + 10-channel head) and its export                   |
| `qd_detect_train.py` | trains the detector, 30 000 steps                                                                                        |
| `runs.py`            | what both trainers share: the resumable `checkpoint.pt`, random states, the log, the worker count                        |
| `requirements.txt`   | the pinned packages (the lab venv's; torch and torchvision are the CUDA 12.6 builds)                                     |

## Command lines

Every script prints progress; the trainers print one JSON line per epoch or evaluation and end
with one line `{"done": true, ...}` (below), which is what the Modal side reads.

```text
python scryfall_fetch.py <dataset dir> [--workers 48] [--kind default_cards] [--limit N] [--reuse-bulk] [--prune]
python looks.py <dataset dir>
python qd_train.py <dataset dir> <run dir> [--epochs 30] [--batch 256] [--workers N] [--prefetch 2]
    [--lr 2e-3] [--head-lr 1e-2] [--margin 0.3] [--warmup 500] [--eval-every 3] [--eval-looks 3000] [--seed 0]
python qd_export.py <dataset dir> <run dir>/last.pt <out dir> [--head-only] [--detector <detector.onnx>] [--workers 16]
python qd_detect_train.py <dataset dir> <run dir> [--steps 30000] [--batch 64] [--workers N] [--prefetch 2]
    [--lr 2e-3] [--warmup 1000] [--eval-every 2500] [--eval-batches 24] [--corner-weight 1.0] [--flip-weight 0.5]
python qd_detector.py export <run dir>/last.pt <out dir> [--meta <neural.meta.json>]
```

- `--workers` (the trainers): data-loading processes, by default every core the process may run
  on but two. Training is CPU-bound — one worker draws ~41 embedder views or ~31 detector scenes
  a second on a 5900X — so this is what buys speed; a Modal container may report its host's
  cores, so the pipeline passes it. `--prefetch`: batches each worker keeps ready in shared
  memory (the lab used 4; 2 keeps 30 workers' batches small).
- `scryfall_fetch.py --workers` is parallel CDN downloads. `--limit N` keeps the first N faces (a
  smoke test); `--reuse-bulk` skips asking the API whether the bulk file is stale; `--prune`
  deletes the sharded scans it fetched of faces no longer in the bulk file (refused with
  `--limit`). Without `--prune` nothing is ever deleted.
- `qd_export.py --head-only` writes `embedder.onnx`, `gallery.head.matrix` and `gallery.json` and
  skips the pass that embeds every face's clean scan (`gallery.matrix`, `gallery.mix.matrix`):
  the class weights are the gallery the app ships, and every look has one when the run trained on
  this `looks.json` — the export refuses another (run.json's `looks_sha256`). `--detector` adds
  the lab replay's `neural.meta.json`; the app reads the hand-kept `models/neural.json` instead.
- The ONNX contract the crate reads (`src/embed.rs`, `src/detect.rs`): the embedder
  `crops [n,3,128,128] → embedding [n,128]`, the detector `image [1,3,h,w] → maps [1,10,h/8,w/8]`,
  opset 17. Both exports check onnxruntime against torch.

## The dataset

```text
<dataset dir>/
  default_cards.jsonl.gz   the bulk file
  bulk.json                its API entry ({updated_at, url, ...}): downloaded again when it moves
  index.jsonl              one row per paper printing face, with its scan's current URL
  fetched.jsonl            one row per scan on disk: {id, url} — the URL it was fetched from
  looks.json               looks.py
  normal/<2>/<id>.jpg      each face's `normal` scan, in a folder named by the id's first two
                           characters (a Modal Volume holds at most 262 144 files a directory)
  fetch.json               the last fetch: {fetched_at, faces, downloaded, refreshed, failed, bytes,
                           adopted, pruned, kind, bulk_updated_at, limit, seconds}
  fetch.log
```

**Incremental**: a re-run downloads a face with no scan (`downloaded`) and a face whose image URL
changed since its scan was fetched (`refreshed`: Scryfall's URLs end `?<timestamp>`, which moves
when the image is replaced), and nothing else. A first run of ~107 000 faces is ~11 GB in ~4
minutes at 48 connections; the `*.scryfall.io` hosts have no rate limit, and the one call to
`api.scryfall.com` is the bulk file's entry.

**The lab's flat dataset still works**: a scan is read from `normal/<2>/<id>.jpg`, else
`normal/<id>.jpg` (`looks.scan_path`; the layout is read once, so a dataset in one layout costs
no file-system call a lookup). Fetching into a flat dataset moves nothing: a scan with no row in
`fetched.jsonl` is taken as fetched from the URL the previous `index.jsonl` gave it (`adopted`),
and a new or refreshed scan goes into its shard, where it is read before the flat file.

## A run directory

```text
<run dir>/                 the embedder's                      the detector's
  run.json                 {looks, faces, looks_sha256, args}  {args}
  log.jsonl                one row an epoch, then the done row one row an evaluation, then the done row
  checkpoint.pt            the resume point (below)            the resume point
  last.pt, last.head.pt    weights and ArcFace class weights   last.pt
  best.pt, best.head.pt    by retrieval top-1                  best.pt, by found share then corner error
```

**Resume**: `checkpoint.pt` holds the weights, the ArcFace head, the optimiser, the step and
epoch, the best metric, every logged row, the torch/CUDA/NumPy/Python random states and the
arguments. It is written at the end of every epoch (embedder) or evaluation (detector), last of
that save's files, through a temporary file and a rename. A trainer started with a run directory
that holds one goes on from it — no `prototype_init`, the learning-rate schedule from the saved
step, `log.jsonl` appended with only the rows it lacks — so a preempted container restarted with
the same arguments loses at most an epoch or an evaluation interval. A finished run prints its
done row and exits 0 at once. A checkpoint made with another recipe (any argument but the
paths, `--workers` and `--prefetch`), or for the embedder on another `looks.json`, is refused:
start a new run directory. A view's randomness is `os.urandom`'s, as in the lab, so a resumed run
continues the recipe, not the same draws.

**The done row** (stdout and `log.jsonl`): the embedder's is the last epoch's row plus `done`,
`epochs`, `best_retrieval_top1`, `seconds` and the mean `views_per_s`; the detector's is the last
evaluation's row (`found`, `corner_err`, `corner_err_p90`, `wrong_way`, `fp`, ...) plus `done`,
`steps`, `best_found`, `best_corner_err` and the mean `scenes_per_s`. The pipeline exports
`last.pt`, as the shipped files were.

## Running it locally

With a CUDA GPU and Python 3.10:

```bash
python -m venv .venv && .venv/bin/pip install -r requirements.txt --extra-index-url https://download.pytorch.org/whl/cu126
D=/path/to/scryfall-default-cards        # or the lab's E:\MTG-datasets\scryfall-default-cards
python scryfall_fetch.py $D && python looks.py $D
# A smoke training, a few minutes: two epochs and a short evaluation, and 600 detector steps.
python qd_train.py $D runs/emb --epochs 2 --eval-looks 300 --workers 12
python qd_export.py $D runs/emb/last.pt runs/emb/export --head-only
python qd_detect_train.py $D runs/det --steps 600 --eval-every 200 --eval-batches 8 --workers 12
python qd_detector.py export runs/det/last.pt runs/det/export
```

Kill a trainer and start it again with the same line to watch it resume. The full recipe is the
defaults: ~55 minutes for the embedder (20 workers) and ~75 for the detector (16 workers) on an
RTX 4070 Ti and a 12-core CPU. Then `models/README.md` turns the files into `models/` (`build-gallery`).

Each data worker holds ~300 MB, and pinned, prefetched batches sit in shared memory: on a
machine short of memory, lower `--workers` before `--prefetch`.

**Tests** (standard library `unittest`, no GPU, no network; torch and the requirements installed):

```bash
python -m unittest discover crates/card-neural/train/tests
```

## Running it from GitHub

Two workflows run all of the above with nobody at a desk: `.github/workflows/neural-train.yml`
trains, and `.github/workflows/neural-deliver.yml` turns a finished run into a pull request.

**Training** — at 03:41 UTC on the 1st of every month (run `YYYY-MM`), or _Actions →
neural-train → Run workflow_ (run `YYYY-MM-DD-HHMM`, UTC, with `-smoke` after a smoke run's):

| input        | default | what it does                                                                             |
| ------------ | ------- | ---------------------------------------------------------------------------------------- |
| `detector`   | on      | off retrains the embedder alone, and the current `detector.onnx` stays                   |
| `cpu`        | 16      | physical cores for each training container, 1 to 64                                      |
| `memory_gib` | 24      | GiB for each training container, 4 to 256                                                |
| `budget_usd` | 10      | the run's limit in dollars; more than 10 is refused before anything is deployed          |
| `smoke`      | off     | one epoch and 300 detector steps, for cents: proves the plumbing, and is never delivered |

It deploys `modal_app.py` from the commit it runs on (`modal deploy`, the client pinned in
`requirements-ci.txt`), spawns `pipeline` through `launch.py` and returns at once; the run takes an
hour or two on Modal, ~$4 at the defaults, and `budget.py` holds it to its budget.

**Delivery** — every six hours, or _Run workflow_ with `run` set to one run's name. `deliver.py`
finds a run whose `DONE.json` says `ok` and that has no `DELIVERED.json`, the oldest first, and in
four jobs — so that no token shares a job with a build — downloads its files, builds `gallery.bin`,
rewrites `models/README.md`'s four rows and `models/training.json` (`update_readme.py`), runs
`cargo test -p card-neural`, and opens `feat(scanner): retrain the Neural models (<run>)` from
the branch `neural-models/<run>`: this run's metrics beside the current files', the spend, and a
checklist. **Before merging, replay the readers' scans on that branch** (`pnpm scanner:corpus
pull`, then `pnpm scanner:replay`): `neural.json`'s thresholds were tuned on the previous pair. A
failed run gets no pull request; the delivery's summary says why, and that workflow run is red,
once. A smoke run is built in a scratch copy, and its summary shows the pull request a real run
would open.

**By hand**, with `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET` in the environment and `gh` signed in,
`python deliver.py run [--run <name>]` does the four jobs in one go from a clean checkout of
`main`. `python deliver.py run --dry-run --from-dir <folder laid out as the Volume>` reads a copy
instead of the Volume, rewrites the README and `training.json` in a scratch folder it names, and
prints the pull request's body: nothing tested, pushed or written.

### The owner's one-time setup

1. **A Modal account**, with a payment method: the runs are billed to its workspace.
2. **A token for GitHub**, at modal.com/settings/tokens: a token ID (`ak-…`) and a secret
   (`as-…`), shown once. On a Team plan a service user (`/settings/tokens/service-users`, given
   _Contributor_ on the `main` environment) is better than a person's token.
3. **Three repository secrets** (_Settings → Secrets and variables → Actions_):
   - `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET`, the token's two halves. Without them both
     workflows say so in their summary and end green; one without the other is red.
   - `NEURAL_PR_TOKEN`, a fine-grained personal access token for this repository alone, with
     _Contents_ and _Pull requests_ read and write. GitHub starts no workflow for a pull request
     opened with a workflow's own `GITHUB_TOKEN`, so without this one CI does not run on the
     delivery's pull request until someone pushes to its branch (the summary says so) — and the
     fallback needs _Settings → Actions → General → Allow GitHub Actions to create and approve
     pull requests_. The token expires when you chose; a delivery after that fails at the push.
4. **A budget on the Modal workspace** (_Usage & Billing_, `/settings/usage`), the backstop behind
   the $10 a run: Modal stops work that would pass it. $25 a month leaves room for a run by hand
   beside the monthly one.
5. **A first, cheap run**: _neural-train_ with `smoke` on, then, once it is done (the first one
   also builds the image and downloads every Scryfall scan to the Volume), _neural-deliver_ with
   `run` set to its name.
