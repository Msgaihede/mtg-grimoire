# The Neural scanner's model files

In git by the owner's choice (2026-10-20): each is far under GitHub's 100 MB a file, and they
are one versioned set — **the gallery is only right for the embedder that made it**, and the
thresholds only for this pair. Change one and the others are suspect. The same holds for the
printing evidence (2026-10-21): `symbols.bin` is `symbol.onnx`'s own, `bands.bin` is
`band.onnx`'s, and `neural.json`'s `evidence` section was tuned on those two beside this
recogniser.

| file            |      bytes | sha256              | what it is                                                                                                                                                                                                                                                                   |
| --------------- | ---------: | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `detector.onnx` |  2 443 078 | `4e9a46bd…c87a5a35` | corner detector: timm `mobilenetv3_small_075.lamb_in1k` (Apache-2.0) + FPN-lite neck + 10-channel head, trained 30 000 steps on synthetic scenes (scanner lab run `det-a`)                                                                                                   |
| `embedder.onnx` | 10 602 685 | `dd17c180…b189ad1d` | 128-d embedder: timm `mobilenetv4_conv_small.e2400_r224_in1k` (Apache-2.0) + ArcFace over 70 402 looks, 30 epochs on Scryfall scans drawn into sleeves, binder pockets and toploaders (run `qd-mnv4-e`, "run 2")                                                             |
| `gallery.bin`   | 13 979 185 | `40278b05…95a617d4` | `CNGALLR1`: the embedder's ArcFace class weights, one per look, as int8 rows with a scale each, and each look's printings (`src/gallery.rs` has the layout)                                                                                                                  |
| `neural.json`   |        950 | `2f3f9653…88c1746d` | input sizes, decode constants, thresholds (Quickdraw's, score bars −0.025, margins × 0.375, chosen by cross-validation), `"ranking": "aimed"`, and the `evidence` section: both crops and the thresholds that weigh them (below)                                             |
| `symbol.onnx`   |  2 614 423 | `82b30b18…21d75e52` | 64-d set-symbol network: timm `mobilenetv3_small_075.lamb_in1k` (Apache-2.0) + ArcFace over 1 999 classes (symbol set, rarity, and the promo stamp: none, planeswalker or date), 16 epochs on Scryfall scans' crop `[0.72, 0.40, 0.985, 0.66]` at 96×128 (run `ev-symbol-3`) |
| `band.onnx`     |  2 811 031 | `19512fa5…ff29bd8e` | 64-d collector-band network: the same backbone + ArcFace over 107 109 printing faces, 20 epochs on the crop `[0.0, 0.80, 0.82, 1.0]` at 256×88 — number, rarity, set code, language (run `ev-band-2`)                                                                        |
| `symbols.bin`   |  1 899 482 | `6733b129…15bb9f2d` | `CNGALLR1` for `symbol.onnx`: one row a symbol class, the mean of its members' Scryfall-scan crops as `symbol.onnx` embeds them, covering every printing that shows it (105 654)                                                                                             |
| `bands.bin`     | 14 307 151 | `90ca6fda…09144283` | `CNGALLR1` for `band.onnx`: one row a printing face (107 109), the mean of its Scryfall-scan crops as `band.onnx` embeds them, covering that printing alone                                                                                                                  |

**The web build holds the files to this table** (`apps/light/vite.config.ts`, through
`packages/ui/lib/core/web/assets.ts`' `neuralTable`): a file whose length or digest ends differ
from its row fails the build — so a new file means a new row, in the same change. The full
digests are in `sha256sum models/*`. Measured on the 124 readers' scans with this
pair: 95.2 % card ✓ cross-validated, 0 wrong (the lab's replay); 96.0 % and 0 wrong through the
app's own session (`docs/reference/card-scanner.md` §10 _Neural_).

**The printing evidence, on the same 124 scans** (the replay's Neural pass, with these eight
files): 87 decisions name the right printing, 0 the wrong one and 32 are left a choice of
printings (without the evidence: 77 / 0 / 42); no wrong card, and the true printing is decided
or among the choices on 118, as without. The thresholds are in-sample: the lab's grouped
cross-validation picked a `decideMargin` of 0.18 and its held-out estimate had **3 wrong
printings** — a band that prefers another printing on two scans, and one scan whose printing was
no candidate. The owner chose 0.20 knowing that (2026-10-21), for room over the largest lead a
wrong printing had (0.167); `symbolWeight` 1.5, `bandWeight` 1, `candidateGap` 0.04 and
`keepGap` 0.20 sit with it.

## Where they came from, and how to make them again

These were trained in the scanner lab, outside this repository (`E:\mtg-scanner`: `data\runs\`
for the runs, `docs\` for the write-up). The code that trained them is now
[`../train/`](../train/README.md), and the monthly pipeline runs it on a Modal GPU
(`docs/superpowers/plans/2026-10-20-neural-training-pipeline.md`); the lab keeps the experiments.
By hand, from `train/`:

1. **Data**: `scryfall_fetch.py` mirrors Scryfall's bulk `default_cards` and every paper face's
   `normal` scan, incrementally; `looks.py` groups printings into looks.
2. **Embedder**: `qd_train.py` (30 epochs, ~55 min on an RTX 4070 Ti) →
   `qd_export.py --head-only`, which writes `embedder.onnx` and the gallery as
   `gallery.head.matrix` + `gallery.json`.
3. **Detector**: `qd_detect_train.py` (30 000 steps) → `qd_detector.py export`.
4. **This folder**: copy the two ONNX files here, and turn the gallery into `gallery.bin`:

   ```bash
   cargo run --release -p card-neural --features cli --bin build-gallery -- \
     --matrix gallery.head.matrix --gallery gallery.json --out crates/card-neural/models/gallery.bin
   ```

5. **Prove it** before committing: the lab's replay on the readers' scans, and
   `cargo test -p card-neural`, which loads these files.

### The printing evidence

`symbol.onnx`, `band.onnx` and their galleries were trained in the lab (runs `ev-symbol-3`, 16
epochs, and `ev-band-2`, 20); their training is now `train/`'s `ev_*.py` too, and **the monthly
pipeline remakes them with the other four** (the owner's choice, 2026-10-21), at 12 and 14 epochs
to fit the run's budget (`../train/README.md`, "The budget"). By hand, from `train/`:

1. **Train** each with `ev_train.py <data> <run> --kind symbol|band` (ArcFace, margin 0.3, on the
   same Scryfall mirror; symbol 12 epochs at 64 repeats, ~57 min on an RTX 4070 Ti; band 14
   epochs, ~60 min).
2. **Export** with `ev_export.py <data> <run>/best.pt <out> --kind symbol|band`, which writes
   `<kind>.onnx`, `<kind>s.matrix` (one row a class, the mean of its members' crops) and
   `<kind>s.json`, and the crop's `neural.json` entry as `<kind>.meta.json`.
3. **Galleries**: `build-gallery --matrix <kind>s.matrix --gallery <kind>s.json --out <kind>s.bin`
   — the mean rows, not `<kind>s.head.matrix`.
4. **Thresholds** stay the lab's: the replay with `--neural-evidence` and permissive thresholds,
   then the grouped cross-validation over its decisions; the result goes in `neural.json`'s
   `evidence`, by hand. A delivery never touches `neural.json`, and a retrained crop network can
   shift its score scale — so its pull request is replayed on the readers' scans before it merges.

A printing newer than the two galleries has no row in them, so the evidence cannot rule it out
(`src/narrow.rs`): a card with such a printing among its candidates stays a choice of printings
until the next monthly run remakes the galleries.

**A new set** needs only a new gallery: its printings embedded by this embedder. A look the
embedder was not trained on has no class weight; its row is the mean embedding of its scans,
as `gallery.matrix` holds for every look (the class weights scored better where both exist).
