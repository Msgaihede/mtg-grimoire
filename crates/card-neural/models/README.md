# The Neural scanner's model files

In git by the owner's choice (2026-10-20): each is far under GitHub's 100 MB a file, and they
are one versioned set — **the gallery is only right for the embedder that made it**, and the
thresholds only for this pair. Change one and the others are suspect.

| file            |      bytes | sha256              | what it is                                                                                                                                                                                                       |
| --------------- | ---------: | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `detector.onnx` |  2 443 078 | `4e9a46bd…c87a5a35` | corner detector: timm `mobilenetv3_small_075.lamb_in1k` (Apache-2.0) + FPN-lite neck + 10-channel head, trained 30 000 steps on synthetic scenes (scanner lab run `det-a`)                                       |
| `embedder.onnx` | 10 602 685 | `dd17c180…b189ad1d` | 128-d embedder: timm `mobilenetv4_conv_small.e2400_r224_in1k` (Apache-2.0) + ArcFace over 70 402 looks, 30 epochs on Scryfall scans drawn into sleeves, binder pockets and toploaders (run `qd-mnv4-e`, "run 2") |
| `gallery.bin`   | 13 979 185 | `40278b05…95a617d4` | `CNGALLR1`: the embedder's ArcFace class weights, one per look, as int8 rows with a scale each, and each look's printings (`src/gallery.rs` has the layout)                                                      |
| `neural.json`   |        602 | `14539669…1a64992e` | input sizes, decode constants, thresholds (Quickdraw's, score bars −0.025, margins × 0.375, chosen by cross-validation), `"ranking": "aimed"`                                                                    |

**The web build holds the files to this table** (`apps/light/vite.config.ts`, through
`packages/ui/lib/core/web/assets.ts`' `neuralTable`): a file whose length or digest ends differ
from its row fails the build — so a new file means a new row, in the same change. The full
digests are in `sha256sum models/*`. Measured on the 124 readers' scans with this
pair: 95.2 % card ✓ cross-validated, 0 wrong (the lab's replay); 96.0 % and 0 wrong through the
app's own session (`docs/reference/card-scanner.md` §10 _Neural_).

## Where they came from, and how to make them again

The training code, the runs and the datasets live in the scanner lab, outside this repository
(`E:\mtg-scanner`: `spike\train\` for the code, `data\runs\` for the runs, `docs\` for the
write-up):

1. **Data**: `scryfall_fetch.py` mirrors Scryfall's bulk `default_cards` and every paper face's
   `normal` scan; `looks.py` groups printings into looks.
2. **Embedder**: `qd_train.py` (30 epochs, ~55 min on an RTX 4070 Ti) → `qd_export.py`, which
   writes `embedder.onnx` and the gallery as `gallery.head.matrix` + `gallery.json`.
3. **Detector**: `qd_detect_train.py` (30 000 steps) → `qd_detector.py export`.
4. **This folder**: copy the two ONNX files here, and turn the gallery into `gallery.bin`:

   ```bash
   cargo run --release -p card-neural --features cli --bin build-gallery -- \
     --matrix gallery.head.matrix --gallery gallery.json --out crates/card-neural/models/gallery.bin
   ```

5. **Prove it** before committing: the lab's replay on the readers' scans, and
   `cargo test -p card-neural`, which loads these files.

**A new set** needs only a new gallery: its printings embedded by this embedder. A look the
embedder was not trained on has no class weight; its row is the mean embedding of its scans,
as `gallery.matrix` holds for every look (the class weights scored better where both exist).
