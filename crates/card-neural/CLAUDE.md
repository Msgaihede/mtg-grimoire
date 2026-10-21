# card-neural — the Neural scanner's recogniser

Two small CNNs and a gallery of looks, on `rten`: what the Scanner's **Neural** mode runs
(`card-scanner`'s `neural` feature calls it; `docs/superpowers/plans/2026-10-20-neural-scan-mode.md`
is the contract). The mode and its replay are
[`docs/reference/card-scanner.md`](../../docs/reference/card-scanner.md) §10 _Neural_. **The
training that remakes the model files is here**, in `train/` (§5): the monthly pipeline on a
Modal GPU (`docs/superpowers/plans/2026-10-20-neural-training-pipeline.md`). **The development
work is not** (the owner's choice, 2026-10-20): the spike, the experiments, the replay on the
readers' scans, the runs and the research write-up live in the scanner lab, `E:\mtg-scanner`
(its `README.md` maps it).

For global repo workflow, style, and testing conventions, refer to:

- [Workflow & Commits](../../docs/agent/WORKFLOW.md)
- [Code Style](../../docs/agent/CODE_STYLE.md)

---

## 1. The model files are in git, as one set

- `models/` holds `detector.onnx`, `embedder.onnx`, `gallery.bin` and `neural.json`, committed
  (the owner's decision, 2026-10-20; `.gitattributes` marks them binary). **They change
  together or not at all**: the gallery is the embedder's own, and the thresholds were tuned on
  this pair. `models/README.md` is their provenance and the recipe to remake them — update its
  table (bytes, sha256) with any change; the web build refuses a file its row does not match.
- **The printing evidence is four more** (2026-10-21): `symbol.onnx` and `band.onnx`, the set
  symbol and collector band networks, and their galleries `symbols.bin` and `bands.bin`, which
  `neural.json`'s `evidence` section says how to read and weigh ([`Evidence`],
  `bundled_evidence()`). The same rule: each gallery is its network's own, and the thresholds
  were tuned on the pair beside this recogniser. On the 124 readers' scans the Neural pass names
  the right printing on 87 and the wrong one on none, with 32 left a choice (77 / 0 / 42 without
  them); the thresholds are in-sample, and the owner chose `decideMargin` 0.20 knowing the
  cross-validated estimate had 3 wrong printings. Their training is the lab's, not `train/`'s.
- **Only our own weights.** Never a file from quickdraw.cards (no licence) or any other model
  whose licence we have not read; the spike's comparison files live in the scanner lab, outside
  the repository.
- `cargo test -p card-neural` loads the files in git; a change that breaks them goes red there.

## 2. It runs in a browser Worker

- **No clock, no threads, no files** outside the `cli` feature: `std::time::Instant` panics on
  `wasm32-unknown-unknown`, and the web scanner runs on one thread. The caller times a read.
- Bytes in: [`Files`] holds `Cow`s, so a host that received owned buffers (a Worker's message)
  hands them over without a copy, and the gallery is read in place — a browser's memory is
  never given back.
- `bundled` is for the native hosts only; the web fetches the files from the app origin.

## 3. Mirror the arithmetic the numbers were measured with

`frame::resize_to_tensor` and `frame::sample_card` are quickdraw.cards' box filter and 2×2
supersampled bilinear homography, byte for byte, and the spike's replay measured this pair
through them. A "better" resampler is a distribution shift. Thresholds and the ranking come
from `neural.json`, not from code.

## 4. Checks

`cargo test -p card-neural --features cli` and `cargo clippy -p card-neural --all-targets
--features cli,bundled -- -D warnings`; it is a workspace member, so `pnpm verify` runs both
without the features. `probe` runs the files on pictures:
`cargo run --release -p card-neural --features cli --bin probe -- frame.jpg …`.

## 5. Training (`train/`, Python)

- **The production subset of the lab's `spike\train\`**, the code that trained the shipped
  files; `train/README.md` has each script's command line, the dataset and run layouts, and a
  local smoke run. **The recipe is the shipped one** — argparse defaults are the shipped runs'
  values; a change to epochs, rates, augmentations or scene contexts belongs in the lab first,
  measured on the readers' scans, because `neural.json`'s thresholds were tuned on this pair.
- Differences from the lab, and only these: scans sharded as `normal/<2>/<id>.jpg` (the flat
  layout still read), an incremental `scryfall_fetch.py`, a resumable `checkpoint.pt`
  (preemptible GPUs), `--workers`/`--prefetch`, a final `{"done": true}` line, and
  `qd_export.py --head-only`. Experiments (readers' crops, oracle, folds) stay in the lab.
- `python -m unittest discover crates/card-neural/train/tests` — no GPU, no network; not part of
  `pnpm verify`.
