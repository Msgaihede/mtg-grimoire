# Card scanner — design

**Date:** 2026-09-01
**Status:** approved; first pass under implementation
**Scope of the first pass:** the bundle builder, the detector, the CLI and the live camera
debug page. OCR, the app integration and the fourth tier are specified here but land later.

---

## 1. What this is

Identify a physical Magic card from a camera frame or a photograph, locally, on a desktop with
a webcam and on a flagship phone. Two modes:

* **Fast** — lowest latency, so a reader can scan a pile. Answers with a *card*, and picks a
  printing it may have to mark provisional.
* **Precise** — answers with an exact *printing*, narrowing through tiers and, when tiers run
  out, handing the reader the candidates that survived.

Everything runs on device. Nothing here is a service.

## 2. The measurements this design rests on

Taken 2026-09-01 against the dev corpus at `src-tauri/target/debug/data/corpus.db` (755 MB)
and live against `cards.scryfall.io`.

| Fact | Value |
| --- | --- |
| Printings in `cards` | **117,619** |
| Distinct `illustration_id` | **50,963** |
| Artworks shared by more than one printing | **25,376** — half of them |
| Rows with no `illustration_id` | 4,977 (tokens, emblems, art series) |
| Rows with `image_uris` | 113,375 |
| English | 114,974 / 117,619 (97.7%) |
| Pre-1998 printings (no collector number printed) | ~10,400 |

**The load-bearing one: art matching cannot identify a printing.** Half of all artworks appear
on two or more printings, so an art-crop match lands in a bucket averaging 2.3. This is the
whole reason the precise mode is tiered rather than a single lookup, and the reason OCR is not
optional for it — the collector-number line is the only place on the card that *states* the
answer.

### 2.1 Image variants, measured

Scryfall's JPG/PNG family is retired; the corpus carries four WebP variants. Sixteen cards
stratified across all four decades, 64 real GETs:

| Variant | Dimensions | Mean | × 50,963 arts | × 117,619 printings |
| --- | --- | --- | --- | --- |
| `thumb` | 146×204 **full card** | **8 KB** | 0.42 GB | **0.98 GB** |
| `grid` | 488×680 full card | 65 KB | 3.40 GB | 7.84 GB |
| `art` | 626×457 art only | 70 KB | **3.67 GB** | 8.47 GB |
| `display` | 672×936 full card | 106 KB | 5.52 GB | 12.74 GB |

`thumb` is the find. A perceptual hash downsamples to 32×32 regardless, so 146×204 is already
more resolution than the descriptor consumes — and it is a **whole card**, which means no art
window to locate and therefore no per-frame-layout geometry.

### 2.2 `cards.scryfall.io` refuses a request with no User-Agent

Measured directly: the same URL answers **HTTP 400, 153 bytes of `text/html`** with no
`User-Agent` header and **200 with the image** when one is set. `HEAD` returns no
`content-length` at all, so sizes must be measured with a GET. Any tool in this repo that
fetches from that host sets a User-Agent or it gets nothing — and the failure is a 400, not a
403, so it does not read like a policy refusal.

## 3. Decisions

| # | Decision | Why |
| --- | --- | --- |
| 1 | **Both descriptor tiers** — whole-card hashes for all 117,619 printings *and* art hashes for all 50,963 artworks | Two independent signals that cross-check, and a graceful path when one is degraded (glare on the art, a sleeve over the border) |
| 2 | **Build the full bundle now**, not a sample | The scanner is useless on a cold install without it |
| 3 | **The builder is a committed, re-runnable, incremental tool** | New sets land every few weeks; regeneration is routine, not a one-off |
| 4 | **Pure Rust: `image`, `imageproc`, `image_hasher`, `ocrs`/`rten`** | Verified below. No OpenCV, no Tesseract |
| 5 | **Hosted as a GitHub release asset** on a fixed tag | `update.rs` already fetches release assets and already verifies GitHub's `sha256` digest |
| 6 | **Fast mode auto-picks and marks provisional** | Never blocks the stream on a dialog; honest that the printing is a guess |
| 7 | **Fourth AI tier: interface only, unimplemented** | Nothing has to be restructured if measured accuracy turns out to need it |
| 8 | **Both Canny and Otsu, behind a flag** | Which wins is empirical and the sample corpus decides |
| 9 | **A card is _decided_ by undecayed votes toward a bar, and a decision freezes the tally** — `track::CommitRule::Votes`, since 2026-09-08 | A per-frame answer flickers and a decayed confidence never stops revising; a reader wants one answer, then the next card. A clean appearance frame is one vote, a read name six, a collector line two; the bar and the lead margin are sliders on the debug page, and the original confidence rule stays behind a toggle there for the A/B |

### 3.1 The stack is genuinely pure Rust

Verified 2026-09-01 by walking the full transitive dependency closure of each crate via the
crates.io API, looking for `cc`, `cmake`, `bindgen`, `pkg-config`, `openssl` or any `*-sys`:

| Crate | Version | Updated | Native deps found |
| --- | --- | --- | --- |
| `ocrs` | 0.13.0 | 2026-08-29 | none but `libc` (via `num_cpus`) |
| `rten` | 0.26.0 | 2026-08-29 | none but `libc` (via `num_cpus`) |
| `imageproc` | 0.27.0 | 2026-06-02 | none but `libc` (via `getrandom`) |
| `image_hasher` | 3.1.1 | 2026-02-21 | **none** |

`libc` is FFI declarations, not a C build. So this cross-compiles to `aarch64-linux-android`
the way the crate already does — a far easier compile than the `libsqlite3-sys` bundled build
this repo already performs against the NDK.

**`img_hash` is dead** — last published 2021-05-04. `image_hasher` is the maintained fork and
is what this uses.

## 4. Architecture

`crates/card-scanner/` is a standalone crate depending on nothing in `src-tauri`. It is *not*
made a cargo workspace member: `src-tauri/Cargo.toml` is a standalone package today, and
converting it moves `target/`, which is the last thing worth disturbing for a layout
preference. `src-tauri` picks the crate up as a `path` dependency when integration lands, in
the **not-wasm** block of `src/lib.rs`. The web target gets no scanner in this pass.

```
crates/card-scanner/
  src/
    lib.rs        detect.rs   # tier 0: quad -> rectified 488x680
    hash.rs       index.rs    # descriptors; bundle load + Hamming search
    ocr.rs        filters.rs  # text bands; candidate predicate
    pipeline.rs   debug.rs    # tier orchestration; artifact writer
    bin/scan.rs               # CLI                     (feature: cli)
    bin/serve.rs              # live camera debug page  (feature: cli)
    bin/build-hashes.rs       # bundle builder          (feature: builder)
  tests/corpus.rs             # accuracy floors over ./scans
```

The core library takes an image and returns ranked candidates. It knows nothing about cameras:
a frame is a frame. That is what lets the same code serve the CLI, the debug page, and later
the app's `getUserMedia` path that `src/features/settings/QrScanner.tsx` already proves works
on both desktop and Android.

## 5. Tier 0 — detection and rectification

Every downstream tier assumes a rectified card, so this stage is the one everything depends on.

| # | Stage | How |
| --- | --- | --- |
| 0 | Downscale to ~640 px long edge | detection does not need full resolution |
| 1 | Grayscale + Gaussian blur | `imageproc::filter` |
| 2 | Edge/region extraction | **`edges::canny` or Otsu threshold + morphology — both implemented, selected by flag** |
| 3 | Contours | `imageproc::contours::find_contours` |
| 4 | Polygon approximation | Douglas–Peucker; keep convex 4-gons above an area floor |
| 5 | Score the quad | corner angles near 90°, and **aspect near 63:88 = 0.7159** — the known card ratio is the strongest filter available |
| 6 | Order corners TL/TR/BR/BL | sum/difference trick |
| 7 | Homography + warp | `Projection::from_control_points` → `geometric_transformations::warp` → canonical 488×680 |
| 8 | **Resolve the 180° flip** | see below |
| 9 | Lighting normalization | local contrast; white balance off the card border |

Deskew, rotation and scale are not separate steps: a single homography handles all three at
once, which is why there is no "rotate" stage in this table.

### 5.1 The 180° ambiguity

A card is 63:88 and therefore **180°-symmetric**. A quad tells you the rectangle but not which
end is up, so a card photographed upside-down rectifies perfectly and then matches nothing.
The fix is to hash both orientations and keep the better score — one extra popcount scan,
which by §7 is free. This is a trap rather than a refinement: an implementation that skips it
fails on roughly half of hand-held scans for no visible reason.

## 6. The bundle

### 6.1 Builder

`cargo run --features builder --bin build-hashes`:

1. Read `corpus.db` for every printing: `id`, `illustration_id`, `image_uris`,
   `image_updated_at`.
2. **Incremental by the rule the image cache already uses — the URI is the version.** A
   sidecar `hashes.sqlite` holds `(card_id, image_uri, hash)`; a re-run fetches only rows whose
   `image_uri` differs or is absent. A newly released set is a few hundred fetches, not
   168,582.
3. Fetch `thumb` per printing and `art` per distinct `illustration_id`, 16 concurrent,
   **with a User-Agent** (§2.2).
4. Emit `card-hashes-v1.bin`; publish with `gh release upload <tag> … --clobber`.

### 6.2 Format

An 8-byte magic, a version, `built_at`, the two counts and the hash width, then per section
`n × { id: [u8;16], hash: [u8;N] }`.

| Hash width | Bundle size |
| --- | --- |
| 256-bit | **8.1 MB** |
| 128-bit | **5.4 MB** |

The builder emits either. Which is sufficient is a question the sample corpus answers, not one
to guess.

## 7. Search needs no index structure

117,619 rows × 256 bits is four `u64` popcounts each — **~470 k popcounts, ~0.2 ms** on a
desktop core, a few ms on a phone. Brute-force Hamming is the whole search. No ANN, no
BK-tree, no vector store. Filters shrink the scan further rather than costing anything.

Recording this because the obvious complex thing is genuinely unnecessary here, and a later
reader will otherwise assume it was overlooked.

## 8. Tier flow

**Fast:** detect → rectify (both orientations) → whole-card hash → top-K over the filtered set.
A wide margin between top-1 and top-2 accepts outright; a narrow one accepts top-1 and marks it
**provisional** for a later sweep. Budget: ~5–15 ms detect, ~1 ms match, targeting 20–30 fps.

**Precise:** the above, then

1. art hash over the art window → re-rank and narrow,
2. OCR the **title band** → confirm the card against the corpus' FTS5 index,
3. OCR the **collector band** → set code + collector number → the exact printing,
4. anything still tied is handed to the reader as a list,
5. tier 4 is an unimplemented trait impl.

**The ordering pays off twice.** The hash tier names the probable printing, which names its
**frame layout**, which names *where the title and collector bands are*. Cropping a known
rectangle is a far easier problem than finding text on an unknown card, so the cheap tier makes
the expensive one both faster and more accurate.

## 9. Filters

A row mask computed over the index once when the filter set changes, then intersected **before**
ranking — never applied to results afterwards. That is what "only cards matching the filters
should be valid for matching" requires, and it makes filters cheaper rather than more
expensive. Grain: set codes, languages, released-date range, paper-only.

## 10. Debug output

Non-negotiable, and the reason the CLI exists. Every stage writes a numbered artifact:

```
00-input  01-gray  02-edges  03-contours  04-quad  05-rectified
06-rectified-180  07-art-window  08-title-band  09-collector-band  10-ocr-overlay
```

`04-quad` is drawn over the original frame so a bad detection is visible at a glance. Each scan
also writes `result.json` with the ranked candidates and every tier's score, and a run writes
an `index.html` contact sheet so a hundred scans can be eyeballed at once. The live camera page
renders the same artifacts per frame.

## 11. Testing

`scans/labels.json` maps each sample file to its expected Scryfall id. `tests/corpus.rs` runs
both modes across the corpus and asserts **committed literal** accuracy floors — never a value
derived from the run, because an assertion that reads its own constant passes against the exact
defect it was written for.

## 12. One trap in the camera page

`getUserMedia` requires a secure context. `http://localhost` qualifies; **`http://192.168.x.x`
does not**, so pointing a phone at the dev machine over LAN fails silently. The clean fix is
`adb reverse tcp:7777 tcp:7777`, which makes the desktop server *be* localhost on the phone —
no certificate, no tunnel, and this repo already drives the phone over `adb`.

## 13. Deliberately not in this pass

* The fourth AI tier — interface only.
* App integration: commands, a scanner page, the provisional mark on a collection row.
* The web/wasm target.
* Any camera capture in Rust. `nokhwa` is not a dependency; frames come from the webview's
  `getUserMedia` or from files.
