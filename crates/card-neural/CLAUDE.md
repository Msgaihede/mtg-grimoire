# card-neural — the Neural scanner's recogniser

Two small CNNs and a gallery of looks, on `rten`: what the Scanner's **Neural** mode runs
(`card-scanner`'s `neural` feature calls it; `docs/superpowers/plans/2026-10-20-neural-scan-mode.md`
is the contract). The mode and its replay are
[`docs/reference/card-scanner.md`](../../docs/reference/card-scanner.md) §10 _Neural_. **The
development work is not in this repository** (the owner's choice, 2026-10-20): the spike, the
training code, the runs and the research write-up live in the scanner lab, `E:\mtg-scanner`
(its `README.md` maps it). Change the model files from there, by `models/README.md`'s recipe.

For global repo workflow, style, and testing conventions, refer to:

- [Workflow & Commits](../../docs/agent/WORKFLOW.md)
- [Code Style](../../docs/agent/CODE_STYLE.md)

---

## 1. The model files are in git, as one set

- `models/` holds `detector.onnx`, `embedder.onnx`, `gallery.bin` and `neural.json`, committed
  (the owner's decision, 2026-10-20; `.gitattributes` marks them binary). **They change
  together or not at all**: the gallery is the embedder's own, and the thresholds were tuned on
  this pair. `models/README.md` is their provenance and the recipe to remake them — update its
  table (bytes, sha256) with any change.
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
