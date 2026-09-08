# The card scanner: the crate, the pipeline, and what it can prove

Identify a physical Magic card from a camera frame or a photograph, locally. This is the
record of what exists on the `card-scanner-first-pass` branch — the standalone crate, its
three tools, the app's Scanner view, and every measurement behind the numbers baked into
them. The designs it was built against are
[the 2026-09-01 spec](../superpowers/specs/2026-09-01-card-scanner-design.md) and, for §9,
[the 2026-09-08 in-app spec](../superpowers/specs/2026-09-08-scanner-in-app-design.md); this
document is what the code actually does and does not repeat either spec's reasoning where the
code agrees with it.

**Same contract as every other file here: a figure carries its date and its build.** Every
measurement below was taken on Windows. The crate's own per-frame timings — the ~100 ms
figures written into its module docs — are **release** figures, and the difference is not the
usual 8×: a debug build of the same server is 4× on the cheapest path and **40× on rectify**.
Accuracy figures over the sample corpus are build-independent and are marked as such.

**No accuracy figure here rests on more than eleven labelled photographs.** That is the single
most important caveat in this document and it is repeated in §8, because three separate times
a change has looked good on distance and turned out wrong on names.

## 1. What it is and where it lives

`crates/card-scanner/`. A standalone crate that takes an [`image::DynamicImage`] and returns
ranked candidates. **It knows nothing about cameras** — where a frame came from is the
caller's business, which is what lets one implementation serve the CLI, the live debug page,
and later the app's `getUserMedia` path with no second copy of the pipeline.

**Deliberately not a cargo workspace member.** `src-tauri/Cargo.toml` is a standalone package
today and converting it to a workspace root moves `target/`, which is the last thing worth
disturbing for a layout preference. `src-tauri` takes this crate as a plain `path` dependency
when integration lands; that works fine across two standalone packages. The cost of the choice
is one line in `.gitignore` (`crates/*/target/`), because `src-tauri/target/` does not cover
it.

**Pure Rust throughout, and verified rather than assumed.** `image` + `imageproc` for the
geometry, `ocrs` on `rten` for the text, hand-written descriptors. The full transitive
dependency closure of every candidate crate was walked for `cc`, `cmake`, `bindgen`,
`pkg-config` and `*-sys` and has none of them (spec §3.1, verified 2026-09-01) — so this
cross-compiles for `aarch64-linux-android` the way the main crate already does. No OpenCV, no
Tesseract.

### Three tools, each behind its own feature

| Binary | Feature | What it is for |
| --- | --- | --- |
| `scan` | `cli` | Run the pipeline over image files and write the numbered debug artifacts. The tool that turns "it seems to work" into a percentage. |
| `serve` | `cli` | The live camera page, with the whole pipeline visible per frame and every threshold on a slider. |
| `build-hashes` | `builder` | Build the reference bundle from `corpus.db` and Scryfall's images. Incremental. |

`cli` = `clap` + `tiny_http` + `corpus` + `ocr`; `builder` = `clap` + `ureq` + `rayon` +
`corpus`. **`corpus` and `ocr` are separate gates on purpose.** The library can match without
a corpus — it simply answers with Scryfall ids instead of names, which is enough to prove the
pipeline — and it can match without OCR, which is the tier that costs 12.2 MB of models.
`tiny_http` is stale (0.12.0, last published 2022-10-06) and taken anyway: it is pure Rust, it
gets HTTP/1.1 keep-alive and `Content-Length` right, and it is reachable **only** under
`--features cli`, so a stale dev-tool dependency can never reach a shipped binary.

### Where the working files sit

| Path | What | In git? |
| --- | --- | --- |
| `docs/scanner/scans/` | The sample corpus — the instrument every measurement is read off | **No.** Untracked and *not* ignored, checked 2026-09-08 |
| `docs/scanner/card-scanner.md` | The original brief | Yes |
| `.scanner-bundle/` | The reference bundle, the fetch cache, the OCR models | Ignored |
| `.scanner-debug/` | `scan --debug-dir` output, ~50 MB a sweep | Ignored |
| `crates/*/target/` | The standalone build dir | Ignored |

The corpus was 43 photographs when every sweep below was run. It holds **44 JPEGs and one
sidecar** on 2026-09-08 — one live capture has been added through the debug page's own button
(§6).

### One profile note that only applies to the crate as the build root

```toml
[profile.dev.package.image]      opt-level = 3
[profile.dev.package.imageproc]  opt-level = 3
```

Detection on a fully unoptimised build is unusably slow — a Canny pass over a 12 MP photo is
seconds rather than milliseconds — and these two make `cargo test` and `cargo run` bearable
while keeping debug symbols in this crate's own code. **They apply only when this crate is the
build root.** A profile override in a dependency is ignored, so the moment `src-tauri` takes
this crate as a `path` dependency, its dev builds get none of this.

## 2. The bundle

### The reference images, and the `thumb` finding

Sixteen cards stratified across four decades, 64 real GETs, 2026-09-01:

| Variant | Dimensions | Mean | × 50,963 arts | × 117,619 printings |
| --- | --- | --- | --- | --- |
| `thumb` | 146×204 **full card** | **8 KB** | 0.42 GB | **0.98 GB** |
| `grid` | 488×680 full card | 65 KB | 3.40 GB | 7.84 GB |
| `art` | 626×457 art only | 70 KB | **3.67 GB** | 8.47 GB |
| `display` | 672×936 full card | 106 KB | 5.52 GB | 12.74 GB |

**`thumb` is the find.** A perceptual hash downsamples to a 16×8 grid regardless, so 146×204
is already more resolution than the descriptor consumes — and it is a *whole card*, so there
is no art window to locate and therefore no per-frame-layout geometry to get wrong. The card
section is built from `thumb`; the art section is built from `art`, keyed on
`illustration_id` and deduplicated, because 117,619 printings share only 50,963 artworks and
fetching per printing would move 2.3× the bytes for exactly the same set of hashes.

**`cards.scryfall.io` answers HTTP 400 to a request with no `User-Agent`** (measured
2026-09-01: 400 and 153 bytes of `text/html` without, 200 and the image with). A 400 does not
read like a policy refusal, so a build that omitted the header would look like 168,582 corrupt
images rather than one missing header. `HEAD` returns no `content-length` at all, which is why
the sizes above had to be measured with a GET.

### What the file is

`MTGSCAN\x01`, a format version, a hash-kind byte, the width, `built_at`, the two section
counts, padded to a 32-byte header; then per section `n × { id: [u8;16], hash: [u8;32] }`.
The id is raw 16 bytes rather than the 36-character hyphenated text, which would more than
double the file for no gain. The padding makes the header a round 32 so a section's first
entry lands on an 8-byte boundary and `words` can be memory-mapped later without the parse
moving.

Sizes read off `.scanner-bundle/` on 2026-09-08, and they follow exactly from
`32 + n × 48`:

| File | Bytes | Entries |
| --- | --- | --- |
| `card-hashes-v1.bin` | 7,888,256 | 164,338 — 113,375 printings **and** 50,963 artworks |
| `card-hashes-v3.bin` … `v5.bin` | 5,442,032 | 113,375 printings, card section only |
| `cache.db` (the fetch sidecar) | 1,283,256,320 | the thumbs, ~1.28 GB |

**`FORMAT_VERSION` covers how the bits were computed, not only how they are laid out**, and
that is the constant most likely to be mis-maintained. A bundle whose layout this build
understands but whose descriptors came from a different algorithm is the worst thing that can
be loaded: every read succeeds, every search returns candidates, and every answer is wrong by
a few bits in a way that looks exactly like a difficult card. A version is therefore **never
reused, including for a change that was abandoned** — the build cache keys on it, so re-using
`2` would hand back the earlier version 2's hashes and rebuild the exact silent mismatch the
constant exists to prevent. The burnt numbers, kept at the definition:

- **1** — Lanczos3 straight from the full rectification.
- **2** — a 122×170 box pre-scale. Tried and dropped: 3.4× faster to hash and it cost real
  discrimination, mean distance over the labelled corpus 42.1 → 46.0.
- **3** — a 244×340 box pre-scale, which is what ships.

### The incremental cache, and the wrong bundle it built in three seconds

The key is **the image URI, not a timestamp**. Scryfall's image URLs carry a cache-buster
(`…/0/0/<id>.webp?1783910776`) equal to the printing's `image_updated_at`, so "are these bytes
still current" is a string comparison — the same rule `src-tauri/src/images.rs` already relies
on. No clock, no mtime, nothing a filesystem can round away. A newly released set costs a few
hundred fetches; a full build from empty costs 168,582 images and roughly 4.5 GB.

**The URI versions the image; it does not version the descriptor**, and conflating the two
produced a wrong bundle in three seconds. After the hashing changed, every row's URI still
matched, the builder reported "113375 already current, 0 re-hashed", and it wrote a bundle
stamped with the new format version and filled with descriptors computed by the old one.
Nothing downstream could have detected it. So the hash cache is keyed on
`<kind>@<FORMAT_VERSION>` while the **images** are cached independently of the descriptor —
which is what turns a descriptor experiment from another 4.5 GB download into a local re-hash.
Measured: the colour rebuild took no network at all, 113,375 entries at ~556/s.

A permanent 404 is recorded so a re-run never retries it; a transient failure is deliberately
*not* recorded, so the next run picks it up. A bounded run of 1024 images completed in 11 s at
93/s with zero failures (2026-09-01), which puts a full build at roughly half an hour.

## 3. One frame, end to end

### Detect — two detectors, and an aspect prior doing most of the work

**63:88 = 0.7159 is the single most useful prior in the crate.** Quad detection produces dozens
of plausible rectangles in any real photograph — a table edge, a playmat border, a phone case,
the card's own art frame — and almost none of them are 0.716. It carries 0.45 of the score,
against 0.20 each for corner angle and skew and 0.15 for area.

Both **Canny** and **Otsu** are implemented and pooled, because which one wins is a property
of the *photograph* rather than of the algorithm: Canny handles a busy background that Otsu
smears into one blob, Otsu handles a low-contrast card edge on a plain background where Canny
finds no continuous boundary. Otsu is run in **both polarities**, because whether a card is
lighter or darker than what it sits on is not knowable in advance. Canny is run at **two
threshold pairs**, pooled rather than chosen: at 40/100 five corpus frames found no card at
all and three of those five were recovered at 15/45.

Six findings are baked in as gates, each of which looked like success first:

- **A contour touching the frame edge is not an object in the frame.** A 3000×4000 phone photo
  has an aspect of 0.75 against a card's 0.7159 — a 4.8% error, well inside any useful
  tolerance — so *the photograph's own border is a near-perfect card*. On the first run against
  real scans, 17 of 18 frames detected the image boundary and reported a 94% success rate while
  getting every one wrong. `touches_border` is the primary defence and `max_area_frac` the
  backstop.
- **`approximate_polygon_dp` must not be required to return exactly four points.** A card's
  corners are rounded, so its hull is a rounded rectangle and the tolerance sweep steps
  6 → 5 → 3 without landing on 4. Five of 18 frames produced **zero** candidates for this
  reason. `min_area_rect` is the fallback; it ignores perspective, so it is tried second and
  what it returns still has to pass every gate.
- **A card contains its art window; an art window never contains a card.** A modern card's art
  box is itself a clean high-contrast quadrilateral and passes every shape test — a legible
  Forest returned exactly one candidate, the art box, at aspect 0.748 and 1.5° of corner error.
  Containment is a **filter applied before ranking**, not a term within it.
- **Corner ordering is by angle about the centroid, not the sum/difference trick.** `min(x+y)`
  names the top-left only while the card is roughly axis-aligned; at 30–40° of rotation it
  silently names the wrong corner, and a hand-held scan is rotated more often than it is
  square.
- **Area saturates and carries the least weight.** Scoring it linearly is precisely what ranked
  a frame-sized quad above the actual card.
- **Skew is a preference, never a gate.** Perspective is what makes a quad's opposite sides
  unequal, and nothing in the scoring measured it, so a corner pulled onto a shadow ranked the
  same as the true rectangle. Measured over the corpus against `card-hashes-v3` it changes the
  result **not at all** — 39 detections, 19 at d≤51, median 55, identical in every figure — and
  is kept because the corpus is single stills, which cannot exercise the case it is for.

**Detection runs at 1024 px on the long edge, swept rather than guessed:** 640 found 35 cards,
**1024 found 39**, 1600 found 37. Below it, a card occupying a tenth of the frame is ~150 px
wide and the morphological close welds its edge to the background; above it, the card's own art
texture starts resolving into competing contours.

**Card-likeness picks the winner, geometry only nominates.** A card's art window turned 90° has
an aspect of 0.727 against a card's 0.716 — measured, a junk quad scored 0.729 while a genuine
card scored 0.718, so there is no tolerance that admits one and rejects the other. `cardness`
looks at the pixels instead, for the one thing every frame layout has: a **full-width
horizontal transition**, a row where most columns change at once. A title band and a type line
span the card; a painting's edges are everywhere and scattered, and no single row moves in
unison. The obvious test — a uniform border ring — is wrong here and wrong in the most damaging
way, because it rejects borderless and full-art printings, three of which are among the
hand-verified matches on this corpus.

**And it is a ranking signal with the gate off by default**, which is the correction that
mattered most:

| | detections | good (≤66 b) | bad |
| --- | --- | --- | --- |
| no card-likeness at all | 39 | 24 | 15 |
| **ranking only — what ships** | **39** | **26** | **13** |
| ranking + a 0.45 gate | 31 | 26 | 5 |

Ranking costs nothing and finds two more good matches; the gate buys precision by discarding
eight detections. On *video* it was far worse than a trade — a card held in a hand under a lamp
scores lower than the same card flat on a table, and the live view found a card maybe 1% of the
time with the gate on. Resolution was the obvious suspect and is not the cause: detection holds
at 70–72% from 720 px to 4096 px. `MIN_SCORE` is 0.0; `GOOD_SCORE` keeps the measured 0.45 for
callers that want to weigh it, and `--min-cardness` and a slider keep the gate available.

### Lock — a filter, not a gate

A card and a card-shaped thing are indistinguishable in a single frame. What a card does that a
spurious box does not is **stay put**: a hand moves a card slowly and continuously, while a quad
conjured out of a glare appears for a frame or two somewhere else and is gone. `QuadLock`
therefore rejects nothing on appearance and asks only that a quad still be there next frame —
three agreeing frames to lock, five missing frames to drop, corners blended at 0.6 once locked.

Two things came out of it. **Both `scan` and `serve` had to pick between Canny and Otsu by
card-likeness rather than geometric score**: the geometric winner alternated between methods
frame to frame and handed back a different quad each time, and nothing can lock onto a target
that changes every frame. And **the rectification comes from the held quad whenever the lock is
locked** — a card lying still produced a rectification that moved about, because the smoothed
green box sat correctly on the card while that frame's raw detection was a near-vertical sliver
down its left edge, and `Detection::rectified` is warped from the frame's own quad regardless.
The card being hashed was a strip of black border, going into the tracker with the full weight
of a real observation. `from_lock` is reported per frame, because a stream that says true
constantly is a detector failing behind a lock that is covering for it.

### Rectify — the 7% expand, the trim, and the alternate framings

One homography handles deskew, rotation and scale at once; the output is 488×680, which matches
Scryfall's `grid` variant exactly so a rectification and a reference render differ in content
rather than in geometry.

**The quad is expanded by 7% about its centre before warping, and it is worth more than any
other single number in the crate.** Canny's strongest gradient on a card is the *inner* edge of
the black border, so the quad tracks the frame rather than the card; a ~3 mm border on a 63 mm
card is 4–5% per side. Swept against ground truth over the corpus:

| inset | top-1 correct | mean distance | mean margin |
| --- | --- | --- | --- |
| 0.94 | 3/8 | 83.0 | 2.3 |
| 1.00 | 6/8 | 78.2 | 6.3 |
| **1.07** | **7/8** | 62.5 | **12.4** |
| 1.13 | 3/8 | **56.9** | 12.5 |

**Read the last row before changing it.** 1.13 has the lowest mean distance in the sweep and
less than half the accuracy: past the optimum the rectification fills with background, the
descriptor goes degenerate, and it moves closer to everything at once. Correctness and margin
are the metrics; mean distance is a decoy, and it has picked the wrong winner three times in
this crate.

Because 1.07 is the value that wins *on average*, a frame where the detector already found the
true outer edge overshoots by the full 7% and comes back with a ring of table around the card —
which is compared against reference crops that carry none. `trim` cuts it, under three rules
that each had to be measured because the obvious version is wrong:

- **It is a colour run, not an edge.** A card's black border sits immediately inside its outer
  boundary, so on a tight rectification the outermost gradient is the border-to-face transition
  and a gradient rule shaves the border off every card it sees. What separates the two cases is
  what lies *outside* the edge: the outermost strip's luma decides whether there is anything to
  trim at all (below 62, or above 205 for a white-bordered card, nothing is cut).
- **Opposite sides are cut by the smaller run.** The quad was expanded about its centre so its
  margin is symmetric; a run on one side only means the quad was offset, and cutting that side
  shifts the card rather than recentring it. Measured, one-sided trims turned `Knights of Dol
  Amroth` at 68 bits into `Land Tax` at 83.
- **A few pixels are left alone** (1.5% of the side). Most frames report a one-to-six pixel run
  — a shadow line, a soft edge — and cutting those and resampling moved every descriptor bit for
  no gain: median distance 42 → 49.

Measured over the corpus against `card-hashes-v3`, scored on names OCR read cleanly (n=11)
rather than on distance:

| inset | no trim | with trim |
| --- | --- | --- |
| 1.07 (default) | 11/11, d=42 | 11/11, d=42 — **inert on both metrics** |
| 1.15 | 10/11, d=43 | 10/11, d=37 |
| 1.20 | 8/11, d=55 | 8/11, d=52 |
| 1.25 | 4/11, d=69 | 8/11, d=59 |

Inert where there is no margin and a real recovery where there is, which is what the live path
needs: the corpus stills are already tight and it is video that runs wide. One frame in 39 trims
at the default; eleven do at 1.20.

**And the framing is not guessed once but searched.** Swept over the corpus the inset alone
moves the count of good matches from 1 to 22, and the right value depends on how sharp *that
frame's* edge was — which cannot be known before rectifying. So the detector warps the winning
quad at three framings (0.96 / 1.00 / 1.04 as multipliers on the inset) and the matcher keeps
whichever produces the best top-1, the same way it already chose between the two orientations.
Each is a fresh warp from the source rather than a crop of the primary, because a crop resamples
an already-resampled image and cannot go *outward* at all.

| over all 39 corpus detections | single framing | three framings |
| --- | --- | --- |
| good, d ≤ 51 | 19 | **23** |
| p25 | 40 | 32 |
| median | 55 | **41** |
| mean | 55.9 | 50.2 |

Accuracy holds at 11/11 while mean distance goes 48.7 → 42.1. The all-framings oracle is 40.5,
so three collect nearly all of it; five reach 41.7, which is not worth the fourth and fifth.
**The tightest framing is kept even though it wins only 3 of 39** — the outermost wins 26 — but
every set that drops it scores 10/11 rather than 11/11 while looking identical on distance.

**A card is 180°-symmetric**, so every framing is warped both ways up and both are hashed. A card
photographed upside-down rectifies perfectly and then matches nothing; an implementation that
skips this fails on roughly half of hand-held scans for no visible reason. Which orientation won
is reported, because a scan that consistently says `rotated` is a card being held upside-down
and that is invisible in the overlay.

### Hash — `dhash-chroma32`, 256 bits

Hand-written rather than taken from a crate, and that is a **format** decision: the bit layout
is published in `card-hashes-v1.bin`, and a dependency that changed its internal bit order in a
patch release would turn every bundle already in the wild into noise, silently — every lookup
would still work and every answer would be wrong.

The shipped descriptor is **224 bits of luminance gradient plus 32 bits of chroma**, and both
halves exist because of a reported failure.

**Grayscale cannot tell basic lands apart, and it is not a tuning problem.** Measured against
the shipped bundle: arbitrary printings sit **101 bits** apart and the confidence threshold is
67, while a HOB Plains and a HOB Forest are **44 bits** apart — a *confident* match for the
wrong card. Reported from the camera as a Mountain flipping to an Island. Nothing else about
two basics differs: same frame, same title bar, same type line, both landscape art with a
horizon, and a red rock and a blue sea at similar brightness are identical to a luminance
gradient.

| pair | bits apart |
| --- | --- |
| arbitrary printings (mean) | 101 |
| the confidence threshold | 67 |
| HOB Plains ↔ HOB Forest | **44** |
| HOB Swamp ↔ HOB Forest | 49 |
| SLD Swamp ↔ SLD Mountain | 65 |
| TRK Plains ↔ TRK Mountain | 68 |

**64 bits of chroma fixed basics and broke foils.** On eight live frames of a foil showcase card
under a lamp, grayscale found the card on 3 and 64-bit chroma on 1: the rainbow sheen corrupts
the colour signal, and those 64 bits were paid for by cutting luminance from a 16×8 grid to
12×8, so it lost structure *and* gained a misleading signal on exactly the cards that need
structure most. The tension is real rather than a tuning accident — a basic land is separated by
*global* colour and a foil's sheen is also global, so no encoding tells them apart. 32 bits is
the compromise, and colour stays on: basics without it fail confidently wrong at 44 bits, foils
with it fail as no answer at all, and the tracker declines to commit. A soft failure beats a
confident lie.

**Chroma is encoded the way luminance is: each cell against the median of all cells, never
against an absolute colour.** A warm lamp, a phone's white balance or a foil's sheen shifts
every cell together and flips no bits. Each cell is also two opponent channels divided by that
cell's own total intensity, so a cell in shadow and the same cell in light give the same pair.
That is what makes colour usable on a photograph at all: stop asking what colour something is
and ask which parts are redder than the rest of the same card.

**A box pre-scale to 244×340 comes first, and half is right where a quarter is not.** Lanczos3
straight from a 488×680 rectification to a 15×8 grid is the most expensive thing in the frame —
its kernel support scales with the ratio, so a 30-to-80× reduction reads the whole source
several times over. Measured on a 720 px frame: **32 ms of hashing against 3.5 ms of searching
113,375 cards**, and the multi-framing search pays it six times a frame rather than twice.

| pre-scale | hashing, a 720 px frame | over the labelled corpus |
| --- | --- | --- |
| none | 32 ms | the baseline |
| **244×340** | **22 ms** | a wash — better on 12 of 39 and worse on 12, accuracy 11/11 either way |
| 122×170 | 9.2 ms | mean distance 42.1 → **46.0** |

Box rather than triangle because it is an exact area mean and therefore cannot alias, which is
the one thing a naive pre-scale would get wrong.

### Match — brute force, and why that is a finding

**117,619 printings at 256 bits is four `u64` popcounts each — about 470 k popcounts.** A
brute-force scan *is* the search. There is no ANN structure, no BK-tree and no vector store,
because at this scale every one of them costs build time, memory and correctness risk to save
an amount of time too small to perceive. Measured on a 10,274-entry bundle over two
orientations: hashing 5.50 ms against searching 0.13 ms, which extrapolates to ~1.5 ms of
search over the full bundle — **hashing is roughly 40× the cost of looking it up**. That points
any future optimisation at the descriptor and not at the scan.

This is written down because the absence looks like an oversight to anyone who has built a
retrieval system at a scale where it is not.

**Filters are applied *during* the scan, never to its results.** Filtering afterwards would let
an excluded printing occupy a slot in the top-K and push a legitimate candidate out of it —
which is the difference between "only cards matching the filters are valid for matching" and
"the filters hide some of the answers".

The result is a top-K insertion list (K is single digits in every caller, so O(n·k) with a tiny
constant beats sorting 117 k results) plus the **margin**: bits between the best and
second-best answer. Distance and margin are near-independent confirmations and both are
required, which is what made the thresholds derivable rather than guessed:

| over 39 corpus scans | count | margin |
| --- | --- | --- |
| distance ≤ 26% | 24 | 8–38, median 21 |
| distance > 26% | 15 | 0–8, median 2 |

The original guess had been 0.12, which would have accepted 2 of 39.

**The two halves of the descriptor are separately searchable** (`Field::Luma` / `Chroma` /
`All`), which costs no storage and no rebuild — the bits are already there in a known order and
this is a mask over them. What it settled:

| search | correct | median distance |
| --- | --- | --- |
| all 256 bits | **11/11** | 38 |
| luma only | 10/11 | 32 |
| chroma only | **0/11** | 0.7 |

**Colour cannot be a second vote.** A chroma-only search has a median distance of 0.7 bits out
of 32: 113,375 cards in a 32-bit space is saturated, thousands tie at nearly zero, and its
top-1 is arbitrary. It is a tie-breaker among candidates structure has already narrowed.
`search_weighted` makes the blend a decision rather than an artefact of how many bits the
chroma grid happened to need — and swept, 0.125 (which reproduces the plain sum) and 0.25 both
score 11/11, luma alone 10/11, and 0.4 drops back to 10/11. On basic lands, the case colour
exists for, raising the weight is actively worse: at 0.25 a Plains matches as a Forest. So
nothing changed, which is the useful kind of answer.

The sweep exposed a real bug on the way: `match_views` chose between orientations and framings
on raw `distance` while the ranking used `normalized`, so a field search picked a different
framing than its own ranking would have. It compares the score the ranking actually used now.

**The art section is built but not matched against.** Its hashes are of Scryfall's isolated art
crop and a rectified photograph is a whole card; using it needs an art-window extractor, which
is a later tier. And by construction it could never identify a printing anyway — half of all
artworks appear on two or more printings, so an art hit lands in a bucket averaging 2.3.

## 4. The three evidence tiers

Each answers a different question, and the weights encode which question each is good at.

| Tier | What it reads | Card weight | Printing weight | Cost |
| --- | --- | --- | --- | --- |
| **Appearance** | a nearest neighbour in the bundle | 1.0 | 1.0 | ~22 ms hashing, ~3.5 ms searching |
| **Name**, clean read | the title band | **6.0** | **0** | ~340 ms, release, 2026-09-08 |
| **Name**, needed correcting | the same, at edit distance ≥ 1 | 3.0 | 0 | — |
| **Collector** | the set code and number, bottom left | **2.0** | **20.0** | ~650 ms, release, 2026-09-08 |

**Not every signal is equal evidence, and treating them as equal was a real bug.** Measured live
on a foil: the hash offered a different near-random neighbour every frame at 55–66 bits
(`Suplex`, `Animate Library`, `Twinshot Sniper`, `Biophagus`) while OCR read the title
correctly on all 400 of its runs — but OCR ran on one frame in five and counted the same as a
guess, so the guesses out-accumulated the reading and the tracker committed to **`Suplex`**.

### The name tier — the one that saves foils

The whole-card hash has one failure mode nothing else fixes: **a foil under a point light**. The
sheen washes the surface in a rainbow, the art becomes a haze, and every descriptor — grayscale,
64-bit chroma, 32-bit chroma — found the right card on at most two frames in eight. The same
card, evenly lit as a still, matches at 32 bits. In those exact frames the title is *perfectly
legible*: text is a shape, not a colour. Measured on the ten dumped live frames where the hash
said "Animate Library" every time, OCR read the title and resolved it correctly on all ten,
including through misreads — `Srrider`, `Sirider`, `S?rider`, `Kanger`.

**Only the title band is read**, at 4.5%–78% across and 2.5%–13% down. Text detection over a
whole card would find the type line, the rules text, the flavour text, the collector line and
the artist credit — dozens of words and a haystack around the one line that names the card. The
band is generous at the top because the title sits higher on a pre-8th-edition frame than on an
M15 one, and stops at 78% across because the right end of every modern title bar is the mana
cost, which is not text and reads as garbage. Both orientations are read and the **longer
alphabetic** result wins, because upside-down the band holds the collector line and the artist
credit, which OCR reads perfectly well — so "did it return text" cannot decide it.

**The lookup searches every name, not the hash tier's candidates**, and that is the point of the
tier: on a foil the hash's top five do not contain the card at all, so a step that could only
re-rank them would be useless exactly where it is needed. An exact hit on the normalized name
is one hash lookup; the fallback is a Levenshtein bounded twice over — a ±3 length window and an
abandon-early row check — with a budget of one edit per four characters, clamped to 1..6. A
two-character slip in "Strider Ranger of the North" is a good read; the same slip in "Shock" is
a different card.

**The name abstains on the printing, and that is a fix rather than an omission.** Every printing
of a card shares its name, so the printing a name resolves to is whichever one the index
happened to store — an arbitrary choice being cast as a vote at weight 6.0, strong enough to
fight the collector line, which actually knows.

### The collector tier — the only one that names a printing

`LTR 232` is an identity. The descriptor says what a card looks like and reads a reprint as
readily as the right printing; the title says what it is called and every reprint shares that.
Nothing else the scanner sees states the answer.

The band is ~175×47 on a 488×680 rectification — a quarter the area of the title band with text
half the height, so it is upscaled 4× rather than 2×. It stops at **28.5% of the width**: the
artist credit runs on past that, and an artist called Irvin Rodriguez read as `INVEN`, whose
prefix `INV` is Invasion, and the line resolved confidently to the wrong printing.

Three fixes, each found by reading the failures rather than the successes:

- **The separators are what OCR loses.** `C 0035` comes back as `C0035` and `HOB * EN` as
  `HOBEN`, so most reads had the digits perfectly legible and produced **zero** pairings,
  because no token began with one. Splitting at every letter/digit boundary and offering
  prefixes of alphabetic tokens took it from 6 resolves to 14.
- **Only a set code touching the number counts.** On `C0004 HOHEN INVEK` the real set read as
  `HOHEN` and resolved to nothing, so a wider search reached the next word — an artist's surname
  whose first three letters are a real set — and answered `INV 4` with full confidence. Wrong
  and certain is worse than absent.
- **A collector number is printed zero-padded**, and every correct read over the corpus came
  back four digits. A bare `6` inside a garbage line produced a confident `LTR 6` against a true
  `LTR 590`, so a token under three digits is noise.

Together those took precision from 80% to 92% while resolving more. **The parse is deliberately
a wide guess against a strict test**: every plausible (set, number) pairing is offered, longest
set code first, and only a pair that names a real printing survives — because a rule like "the
letters before EN are the set" fits one card and breaks on the next.

**Fallback crops, and the preprocessing that was refused.** A single fixed rectangle assumes
every card puts the line in the same place, and a borderless printing, a full-art land and a
showcase frame each shift it. Two ordered fallbacks — wider and taller, then higher up — took
the corpus from 12 resolves of 39 to **15, with precision holding at 14 of 15**. The *first*
crop settles which way up the card is and the fallbacks only ever try that orientation: every
crop both ways is six reads and the cost landed exactly the wrong way round, since a card that
reads resolves immediately while a card that cannot be read paid for all six. Worst case
785 ms → 555 ms, mean 411 → 322.

Reading three other scanners, two of the three identify cards by the collector line rather than
the name, for the reasons hit here independently. Each had one technique this crate lacked and
only one survived measurement: **their contrast-stretch-and-threshold preprocessing is
monotonically harmful here** — 12 resolves plain, 11 with a contrast stretch, 7 with a sigmoid,
5 binarised. They run Tesseract, which wants a clean two-tone image; `ocrs` is a neural
recogniser trained on natural document images, and every step toward a threshold destroys what
it uses. A technique that is standard in one OCR stack is actively harmful in another, which is
not something a README can tell you.

**The collector line only exists on printings from 2015 onward**, so older cards fall through to
the name and appearance tiers by construction. Roughly 10,400 corpus printings predate a printed
collector number entirely.

**And a misread digit produces a different real card, not nonsense** — `0047` read as `0017`
resolved confidently to a card that was not in frame. That is why the split exists: the tier is
weak evidence about *which card* (2.0, where appearance is 1.0 and can outweigh it over frames)
and decisive about *which printing of it* (20.0, because nothing else can tell two printings
apart at all). The art decides the card; the number narrows it down within that card.

## 5. The tracker

Matching is stateless: every frame is decided from scratch, and at ~12 detections a second a
near-tie flips constantly. The right card is **consistent** — it scores well on nearly every
frame because it is genuinely the card in front of the lens — while a wrong answer is
**incidental**, winning one frame because a glare or a slightly different quad nudged a few
bits. Consistency is invisible to a single frame and obvious across ten, and it was being
thrown away every frame.

### How evidence is gathered

**Every candidate in a frame's top-K contributes, not just rank 1.** When the top two are one
bit apart, calling that a win for the first is nearly a coin toss, and recording it as a whole
vote records the coin toss rather than the evidence.

**Weight is relative to the frame's best, not absolute.** The original premise — that wrong
answers are random frame to frame and wash out — is false with a card held still: the top-K is
nearly the same list every frame, so the runners-up accumulate exactly as consistently as the
winner. Measured live on a Took Reaper held in frame, it was top on every frame at 21.5% with a
solid lock, and after 53 frames it held **30% of the evidence against a 45% bar**. Its four
runners-up sat at 25–26% and together outweighed it. The candidates in a frame are competing
hypotheses about one card, so what a candidate deserves depends on how much better it is *than
the alternatives in that frame*: an exponential falloff in the gap to the frame's best, at
`relative_falloff` 0.015 — about four bits at 256, which thirds a candidate's weight and cuts a
ten-bit gap to a fortieth. On the same measured frame the winner's share goes from 30% to about
78%; measured live afterwards, 92–99% share committing on the third frame.

**Candidates are only ever ranked against others of their own kind.** A read name enters at
distance zero, so comparing a hash neighbour at 0.15 against it puts every appearance candidate
ten falloff widths behind and multiplies it by e⁻¹⁰. Measured: over thirty frames where a hash
consistently matched one card at 0.15 and a collector line named another, the hash accumulated
**0.0000** against the read's **101.33**. Not outvoted — annihilated, with nothing left to
correct a misread.

**Evidence groups by oracle id, not by printing.** Replaying four photographs of Esquire of the
King, the right card led every single frame and still never committed, because its evidence was
spread across its own reprints and no one printing reached the threshold. The reader was being
denied an answer by the card being *too well known*. Each observation carries a **key** to
accumulate on and a **member** it names.

**The printing accumulates too, with the same decay and hysteresis.** It used to be the single
best frame each member had ever had, in a map that never decayed and never reverted, so one
lucky frame captured the slot permanently: `Gandalf, Spark Starter` came up correctly as HOB
203, one frame favoured HOB 97 by a bit or two, and it stayed there however many frames
afterwards preferred the right one. Reprints of one card differ by far less than two different
cards do, so the printing needed decay and hysteresis *more* rather than less.

**The reported leader is sticky.** A challenger needs 30% more evidence than the incumbent
before the readout changes — hysteresis on the reported leader only, with the accumulator
underneath untouched, so a challenger that is really winning still takes over (measured at under
20 frames).

**Only an informative frame decays the accumulator.** A frame that saw nothing is not newer
evidence, and letting it decay makes committing depend on how many frames get dropped: at one
usable frame in three, evidence saturates at 1.21 against a 1.5 threshold and the tracker can
never commit however long the card is held there.

### Two verdicts over one accumulator

Everything above is how evidence is gathered. What turns it into an answer is a `CommitRule`,
chosen per session and switchable on a held card — `set_options` keeps the tally, so flipping
the segment or dragging a slider re-judges the evidence already gathered rather than starting
over.

| | **Votes** (the default since 2026-09-08) | **Confidence** (the original) |
| --- | --- | --- |
| Decay | none | 0.93 per informative frame — ~14 frames of memory |
| A frame's contribution | tier weight × relative falloff | quality × relative falloff × tier weight |
| Commits when | votes ≥ `decide_at` (8) **and** lead over the best rival ≥ `lead_margin` (1.3) | share of the two-way contest ≥ 0.70, seen ≥ 5 informative frames, led for ≥ 3 |
| Afterwards | **frozen** — later frames count only misses | re-evaluated every frame, and free to lapse |
| What it is | a decision | a belief |

**Confidence is the leader's share of its two-way contest with its best rival, not of all
accumulated evidence**, and the difference is the whole point. A share of the total was a
fraction of a denominator that grew every time a new candidate appeared once and was never seen
again — roughly four fresh ones per frame, summing to about a third of the total in steady
state — so a card correctly first on every frame for a minute still read as 40–60% certain. The
churn was being counted as competition. A candidate seen once is not a competing hypothesis, and
the alternatives *changing* is itself evidence the leader is right. `leader / (leader + rival)`:
0.5 a dead heat, 1.0 unopposed, unmoved by however much noise drifts past behind them.

**`commit_seen` counts frames, not weight, and that is not cosmetic.** It was an absolute
evidence threshold at first, which silently made commitment *impossible* for weaker-but-correct
matches: weight came from match quality and evidence saturates at `w / (1 - decay)`, so anything
matching worse than 23.3% could never reach the bar. **Oliphaunt matches correctly at 24.6%**
and was barred outright — it led every frame with a 100% share and the tracker refused to say
so. Match quality is already gated by `max_normalized` (0.30, the measured trough between the
two distance clusters); this gate is for consistency, and consistency is a count.

**Two things were left out of a vote on purpose.** *Decay*, because a bar and decay cannot share
an accumulator — evidence saturates and the bar becomes a ceiling, which is the Oliphaunt
failure again. And *quality*, the candidate's own distance across the usable range, because it
made a vote worth 0.47 at 41 bits and 0.13 at 66, so the bar read in no unit anyone could
picture and a far-but-consistent card climbed to it several times slower than a close one. A
vote is worth the same anywhere inside the gate, and the gate is what rejects noise.

### What ends a freeze

Four things: **ten frames without the decided card**, a **reset**, a **bar raised above the
tally**, or switching to the confidence rule. Lowering the bar under a frozen tally changes
nothing — it was decided, and it still is.

**A miss under a freeze is not the same as a miss while gathering**, and that shape came from a
measured self-reset found on 2026-09-08. Once decided, the server drops the extra framings it no
longer needs; a Plains that cleared the 30% gate at **74 bits** with them matched at **84 bits**
without, so every frame after the decision counted as a miss, at ten the decision reset itself
with the card still locked in frame, then re-voted, re-decided and did it again — an ~18-frame
cycle with the card never leaving the lens. A frozen tally takes no evidence, so the gate has
nothing to judge: under a freeze a miss is a frame the decided card was **not in** — empty, or
showing the **same other card** each time — and a frame with candidates but nothing inside the
gate is not one. Requiring the *same* other card matters: a churn of different neighbours is
every foil after its read stands down, and that is not a card being swapped in.

### The measured failures each rule element came from

| Element | The failure that produced it |
| --- | --- |
| Relative falloff | Took Reaper, top on every frame at 21.5%, held **30%** of the evidence against a 45% bar |
| Group by oracle id | Esquire of the King led every frame and never committed — its reprints split its own vote |
| `commit_seen` counts frames | Oliphaunt, correct at **24.6%**, barred by an absolute evidence threshold it could never reach |
| Printing decays and is sticky | `Gandalf, Spark Starter` latched to HOB 97 after one lucky frame, correct answer HOB 203 |
| Per-kind ranking, and tier weights | a foil committing to **`Suplex`** while OCR read the title right on all 400 runs |
| Freeze counts presence, not the gate | the Plains 74 → 84-bit self-reset oscillation, 2026-09-08 |

## 6. The debug page and the server

### Building and running it

```
node crates/card-scanner/scripts/fetch-ocr-models.mjs      # 12.2 MB, into .scanner-bundle/models

cargo run --release --bin serve --features cli -- \
  --bundle    .scanner-bundle/card-hashes-v5.bin \
  --corpus    src-tauri/target/debug/data/corpus.db \
  --ocr-models .scanner-bundle/models
```

**Use `--release`.** The debug build is 4× on the cheapest path and 40× on rectify (§7). Every
argument except the port is optional and every failure to load one is reported and then ignored:
the page is useful without a bundle, and a debug tool that refuses to start because an optional
file is mid-build is a debug tool that cannot be used while the thing it debugs is being built.
Without a corpus, matches are ids.

**The preview and the detector are decoupled and the page never waits for a detection.** The
mask stage alone is 88.8 ms at `work_long_edge` 1024 (release, 2026-09-08; the module doc's
92.8 ms is the same stage on 2026-09-01), and unlike resize and rectify it does *not* get
cheaper on a camera frame — its cost is set by the working resolution, not by the source. So
the `<video>` runs at camera rate, an overlay canvas redraws every animation frame from the most
recent quad, and **exactly one request is in flight at a time with later frames dropped rather
than queued**. Queuing would make the box drift further behind the longer you looked at it.

### The page

Every panel folds away by clicking its heading, with the state kept in
`localStorage` — reading this page means holding a card steady with one hand, so a layout that
has to be rebuilt on every reload is one that will not be. (Every `localStorage` touch is
guarded; it throws outright in a private window, and a failure there just means the panels start
open.)

| Panel | What it carries |
| --- | --- |
| **Match** | the committed leader and its confidence or votes, the evidence bar, lead, distance, margin, orientation, cardness, the per-side trim, the collector line raw and resolved, the lock phase, the standings, and the flickering per-frame guess demoted to one line at the bottom |
| **Detection** | aspect, frame area, corner error, which detector and which geometry won, the descriptor |
| **Frame budget** | the per-stage millisecond breakdown as a stacked bar |
| **Rectified** | what the homography produced, in a fixed 120×168 slot |
| **OCR** | both band crops *as the recogniser saw them*, the raw text off each, the normalized form when it differs, and **every (set, number) pairing the collector parse produced and what each resolved to** |
| **Controls** | the rule segment, the two vote sliders, the detector segment, and the detection thresholds — working edge, both Canny rungs, aspect tolerance, the size sent per frame, and the card-likeness gate |
| **Pipeline** | the mask, contour and quad stage images — off by default, since they roughly double the round trip |

**The pairing list is the panel's best idea.** A verdict alone cannot tell a bad crop from a
misread character: "no printing" is the same message whether the band missed the line entirely
or read `HOBEN` where the card says `HOB`, and those are completely different problems with
completely different fixes. Driven against a still: `ltr 232 → Strider, Ranger of the North`,
with `ltr 0232`, `lt 232` and `lt 0232` beneath it resolving to nothing.

**The OCR crops are carried through from the read rather than re-derived.** The collector read
walks several crops in two orientations and stops at the first that parses, so a viewer
re-cropping "the" band afterwards would often be shown a different image than the text came
from — which is worse than showing nothing, because it looks like an answer. The panel also
holds the last read rather than clearing, since OCR runs on one frame in four and only while the
answer is unsettled.

**The controls that change the verdict:** a `decide by: votes | confidence` segment, a
`decide at` slider (1–40) and a `lead margin` slider (1.0–3.0), all carried on the frame query
and applied through `Tracker::set_options`. So the two rules can be A/B'd on one held card
without a rebuild.

**The overlay draws two boxes.** The smoothed lock is solid green when locked and dashed amber
while acquiring; the raw per-frame detection is drawn behind it, thin and faint. The gap between
them is the jitter, made visible — and for one commit the smoothed quad was computed, written to
the response, and then overwritten by the raw one three lines later, so the smoothing had been
running, and tested, and invisible.

### `scripts/check-live-page.mjs`, and why it exists

**Run it after every edit to `live.html`.** The page is `include_str!`d into the binary, so
nothing at compile time reads it as JavaScript and `cargo build` cannot catch anything in it.

A mistake there does not present as a mistake. The whole inline script fails to parse, `start()`
never runs, `getUserMedia` is never called, and **the only symptom is "the camera doesn't
start"** — which reads as a permissions problem, a busy device or a driver issue and sends you
looking anywhere but at the code. It has cost a debugging round twice:

- A duplicate `const` in one scope, from a careless edit.
- `renderOcr(j)` added to the render loop while the function itself failed to land, from a wrong
  anchor. That is valid syntax, so it parses, and it throws at run time inside a callback with
  the identical symptom.

The script now parses the inline block, checks that every `$('id')` and `set('id', …)` reaches an
element that exists in the markup, and **flags a call to any bare name the script never
declares** — with strings and comments stripped first, so a CSS colour does not read as a call
to `rgba()`. Deliberately crude: declarations are collected by pattern rather than by parsing,
anything reached through a `.` is somebody else's business, and the bias is firmly towards
missing a problem rather than inventing one, because a checker that cries wolf stops being run.
Each rule was verified by breaking something and watching it fail.

### Watching a session you cannot see

The camera is held by one page at a time, so a second browser cannot be opened to watch what the
first one is seeing. Three tools exist for that, all permanent:

- **`--log-frames`** (on by default) prints one line per frame: the lock phase, cardness, aspect,
  the verdict — votes over the bar under the vote rule, the confidence percentage under the other
  — and the top four candidates with their distances. A collector or title read that resolved
  gets its own indented line with the raw text beside the name.
- **`--dump-dir`** writes each frame's rectified card and its full JSON on a rolling 40-frame
  window. Numbers describe a failure; the image *is* the failure — and it is the one thing that
  explains why a card matching at 45 bits as a photograph matches at 70 from a webcam.
- **`scan --rectified`** skips detection and matches an image as-is, so the matcher can be tested
  on its own against a dumped frame.

Those three settled "Strider matches as Animate Library or Game Trail" in order: resolution is
not the cause (at 960 px the corpus stills match at mean d=38.5 against 42.8 at 4096); detection
is not non-deterministic (Canny, Otsu and both return byte-identical results on identical input
— the varying numbers were live camera frames interleaved with test stills in a shared log); and
**the image was the answer**, a correct, legible rectification of a foil drowned in a rainbow
sheen.

### Adding a frame to the dataset

The Match panel carries an optional name field and an **add frame to dataset** button, writing to
`--dataset-dir` (default `docs/scanner/scans`) so a capture joins the corpus for detection
statistics the moment it lands. **Captured at the camera's full resolution, not the size being
sent for detection** — an image saved at the `send px` size would bake this session's slider into
the corpus permanently, and the corpus is the one thing that has to outlive the settings it was
captured under.

**The sidecar matters as much as the image.** A frame with no record of what was on screen is a
photograph of a card; a frame with the name the reader typed is a *labelled* one, and that is the
difference between a corpus that can be scored automatically and one that cannot. The scanner's
own verdict at the moment of capture — what it reported, its confidence, its votes, its distance
— goes beside it, because the whole reason to capture a frame is that the answer was wrong, and
what it said at the time stops being recoverable the moment anything changes. The name is
optional; an unlabelled capture is still a useful image, just not a scoreable one.

Card names are full of exactly what a query string encodes — commas, apostrophes, `//` on every
split card — and a label that comes back mangled is worse than no label, because it would be
scored against and it would be wrong. The decoding is tested against real names, including a
truncated `%` escape, which is kept verbatim rather than swallowing the rest of the value.

### Reaching it from a phone

**`getUserMedia` needs a secure context. `http://localhost` qualifies; `http://192.168.x.x` does
not**, so browsing to this server from a phone over the LAN fails silently — the camera simply
never starts. `adb reverse tcp:7777 tcp:7777` makes the desktop server *be* localhost on the
handset. No certificate, no tunnel, and this repo already drives the phone over `adb`.

### Driving it with no camera at all

Three routes, all HTTP, which is how the swap measurements in §7 were taken:

- `POST /frame` with a JPEG body — every tracker knob rides the query string
  (`?rule=votes&decide=8&margin=1.3&edge=1024&lo=40&hi=100&stages=1`). Posting one photograph in
  a loop is a synthetic video feed of a card held perfectly still; posting a second photograph is
  a swap.
- `POST /reset` clears the tracker and the quad lock, so a new card can start immediately instead
  of waiting for the previous one's evidence to decay.
- `POST /capture?expected=…&reported=…` writes a labelled frame into the dataset.

**Every frame is handled inside `catch_unwind`, and that is not defensive padding.** The options
come from a query string driven by live sliders, and `imageproc::edges::canny` *asserts*
`high >= low` and panics outright otherwise — dragging one slider past the other killed all three
worker threads and exited the server. The pair is ordered before use and the low threshold
floored at 1 (a low of 0 makes every pixel an edge, so an upstream `u32` underflow at
`edges.rs:135` becomes certain rather than unlucky), and the `catch_unwind` covers what that does
not: a dev tool that dies while you are adjusting it is worse than one that reports the failure
and carries on.

## 7. Measured, 2026-09-08

All figures Windows, the `serve` binary, on the frames named. The release/debug gap is the point
of the table: **the ~100 ms figures elsewhere in this crate are release figures.**

### The whole request

| Frame | Release | Debug |
| --- | --- | --- |
| One locked frame, no reader running | **~350 ms** wall | ~580 ms on the cheapest path (frozen decision, no extra framings, no OCR) |
| A frame that runs both readers | **~1.3 s** wall — OCR title ~340 ms, collector ~650 ms | — |
| Detect-only, 960 px in, no quad found | **145–180 ms** | — |
| JPEG decode of a 960 px frame | 3–4 ms | **230 ms** |
| JPEG decode of a 5 MB full-resolution photo | — | **4.1–4.5 s** |

The ~350 ms figure is **identical within noise for the commit before the vote rule (e7731d40)
and after**, timed on identical frames against both binaries — so the vote rule cost nothing
measurable.

### The live page's own frame budget

| Stage | Release | Debug |
| --- | --- | --- |
| decode | 1.9 ms | — |
| resize | 2.1 ms | — |
| mask | 88.8 ms | — |
| contour | 5.3 ms | — |
| rectify | 47.8 ms | **2,022 ms** |
| transport | 62.6 ms | — |
| **round trip** | **208 ms** | **4,377 ms** |

Rectify is where the 40× lands, which is why a debug build of this server is not merely slow but
unusable for anything that has to be judged at frame rate.

### The vote rule, live on a webcam (release)

| | |
| --- | --- |
| Storm of Saruman | decided at **8 votes** |
| a second run of the same card | **9.8 votes**, a lead of **×631** over 92 frames |
| misses over those 92 frames | **0** |
| round trip | ~180 ms, **5.6 frames/s** |

### The swap, driven headless with corpus photographs

Posted in a loop to `/frame`, which is a harder feed than real video because consecutive frames
are not nearly identical.

| | |
| --- | --- |
| `IMG20260823054948.jpg` — a Plains, matched at **74 bits** with the alternate framings | decided at 8 votes on the **eighth locked frame** |
| `IMG20260823054959.jpg` — Mirkwood Nurturer, posted after it | the Plains decision held for **nine frames**, ended on the **tenth** |
| the new card | took a corrected name read for **3 votes**, decided **seven frames later** |

And the oscillation the presence rule fixed, on the same pair: after the decision the server
drops the extra framings, the Plains then matched at **84 bits** — past the 30% gate — every
frame counted as a miss, and at ten the decision reset and the card re-voted. An **~18-frame
cycle with the card never leaving the lens**.

## 8. Bugs still open, and what the numbers cannot carry

1. **Every accuracy figure in this crate rests on eleven labelled photographs.** The corpus is 43
   images taken once, only 14 of which yield a name the OCR tier can read cleanly. One card is
   nine percentage points, and three separate times a change has looked good on distance and
   wrong on names. Re-tuning against the frames that already work cannot fix that; the
   add-to-dataset button exists so capturing the frames that do not can. One frame has been
   captured that way so far.
2. **The corpus is not in git.** `docs/scanner/scans/` is untracked and not ignored on this
   branch as of 2026-09-08 — the instrument every measurement above is read off is not versioned
   with the code that is measured against it.
3. **The confidence rule's committed card can still be reset by ten past-the-gate frames**, because
   only the vote rule's freeze counts presence rather than the gate. The measured Plains
   oscillation was fixed under `CommitRule::Votes`; the confidence rule reaches the same
   `reset_after_misses` counter through the gathering path, where a frame with candidates but
   nothing inside `max_normalized` is a miss.
4. **`IMG20260823055008.jpg` never detects a quad** — one corpus frame that produces no candidate
   at either Canny rung, on either detector (2026-09-08).
5. **OCR reads on one frame in four**, and only while the tracker is uncommitted. That is the
   right trade at ~340 ms a title read against a ~350 ms frame, but it means the tier that saves
   foils contributes at a quarter of the rate the tier it is rescuing does — which is the
   arithmetic that produced the `Suplex` commit before the weights were split.
6. **The collector fallback crops are a guess about frame layouts, not a model of them.** Two
   fixed rectangles recovered 12 → 15 resolves of 39; nothing measures which printings the third
   crop would need, and a card whose line falls outside all three reads as "no printing" with no
   way to tell that from a misread.
7. **The art section is built into the bundle and never searched.** `v1` carries 50,963 artworks
   and costs 2.4 MB of the file; the shipped `v3`–`v5` bundles drop it. Using it needs an
   art-window extractor, and even then it cannot identify a printing — half of all artworks
   appear on two or more, averaging 2.3.
8. **The fourth AI tier is an interface and nothing else**, by design.
9. **Nobody has run any of this on Linux, on a Mac, or in a release Android build.** The phone
   path has been reasoned about (the dependency closure is native-free, and `adb reverse` is the
   documented route) and not driven.
10. **Two doc comments still quote a title read at ~250 ms against a ~80 ms frame** —
    `session::OCR_EVERY` and `ocr.rs:58` — where §4 and §7 measured **~340 ms** against a
    **~350 ms** frame on 2026-09-08. The ratio the comments argue from survives, so the cadence
    they justify is unaffected, but the figures are the same class as the two struck above:
    numbers nothing reads, which is exactly why they rot.

Struck 2026-09-08: `track.rs`'s two stale `Observation::from_collector` doc comments — the ones
that claimed the collector tier was "weighted above a clean title read" at 8.0, and quoted the
pre-fallback "12 of 39 … 11 of those are right". Both now say what the code says, **2.0** for
the card and **20.0** for the printing against a clean read's **6.0**, and 15 of 39 with 14
right. Neither figure was used by anything, which is exactly why they had rotted.

## 9. App integration

Landed 2026-09-08, against
[the in-app spec](../superpowers/specs/2026-09-08-scanner-in-app-design.md). The crate became a
dependency of `src-tauri`, its per-frame handler moved into the crate so the debug server and
the app share one, and the app gained a **Scanner** view that does what the debug page does, in
the app's chrome. **The debug page and its server are unchanged and stay** — they are how the
scanner is diagnosed when the camera is held by one page at a time, and the app is a second
caller of the same session rather than a replacement. Nothing is written to the collection.

### The dependency, and why it is not in the wasm block

```toml
card-scanner = { path = "../crates/card-scanner", features = ["corpus", "ocr"] }
```

A plain path dependency across two standalone packages, which is what §1 anticipated: no
workspace is created, and the three tools keep building into `crates/card-scanner/target/`.
`corpus` is the join back to `corpus.db` for labels and unifies with `src-tauri`'s own
`rusqlite = "0.40"`; `ocr` is the two readers.

**It sits in the non-wasm target block only.** The web build has no detector to compile —
`web::route`'s command table is a `match` over JSON arguments with no camera-frame arm — so the
crate never reaches the wasm clippy job, and the page says so where a reader would press Scan.

**The `[profile.dev.package.*]` overrides are repeated in `src-tauri/Cargo.toml`.** §1 already
says a profile override in a *dependency* is ignored; cargo reads `[profile.*]` from the build
root and nowhere else, so the moment `src-tauri` took this crate the crate's own overrides
stopped applying to it. The measured reason is §7's release/debug table read from the other
side: rectify 2,022 ms against 48 ms, a 960 px JPEG decode 230 ms against 3–4, so a
`tauri dev` scanner without them is a slideshow rather than a slow frame. **Which packages are
on the list is the manifest's own answer and is not copied here** — `image` and `imageproc` are
the two the crate always needed, and everything beyond them was put there by the live pass
rather than by a guess, each with its measurement in the comment above the block. Read
`src-tauri/Cargo.toml`; a list restated in prose is one that goes stale the next time a profile
is measured.

**`npm run verify` runs the crate's suite** as a step beside the `src-tauri` one, at
`--features cli` so the server's own tests are in it. Nothing ran it before.

### `session::Session` — one frame in, one verdict out

`crates/card-scanner/src/session.rs` holds what `serve.rs::handle_frame` and its surroundings
held: the detector sweep, the quad lock, the rectification from the lock's quad, the descriptor
and the search, both readers and their cadence, the tracker, and the panic guard. What stays
with each caller is transport — a query string or an IPC header in, JSON out, plus the server's
log line and its rolling dump directory. The server's two `Arc<Mutex<…>>` — a `Tracker` and a
`QuadLock` — and the **file-static `AtomicU64`** that carried the OCR cadence collapsed into one
`Arc<Mutex<Session>>`; the static is the one worth naming, because a per-*process* counter would
have been shared by two sessions the moment there were two. The server's own `catch_unwind` went
with them, so there is one guard.

```rust
Session::new(reference: Option<Reference>, reader: Option<session::Reader>, top: usize)
```

**Three arguments under every feature set, and that is deliberate.** `Reader` is
`ocr::TitleReader` with the `ocr` feature and an **uninhabited enum** without it, so `None` is
the only `Option<Reader>` that can be built and every branch that would use one is `#[cfg]`ed
out. When the parameter itself was `#[cfg(feature = "ocr")]`, a plain `cargo test` with no
features compiled the tests against a two-argument constructor and went red — and so did
rust-analyzer, which reads the crate with default features. A signature that changes shape with
a feature is a signature two readers of the same file disagree about.

**The reader cadence counter counts _eligible_ frames, not all of them.** A committed card
returns early without advancing it, so a freeze — which lasts as long as the card is held there
— consumes no cadence slots, and when a swap ends the decision the reader fires on the **first**
frame it is eligible for rather than up to three frames later. It is a free function rather than
a `&mut self` method because inside `frame_inner` the reference is already borrowed out of
`self`, where a disjoint field borrow compiles and a method call does not.

**The verdict's keys are the debug page's, and a test is the fence.** `Verdict` is
`serde(rename_all = "snake_case")` because `live.html` reads its keys by name and is not
changing. `session::tests::every_key_the_debug_page_reads_is_in_the_verdict` scrapes the page
for the keys it reads through **six anchored needles** — `j.`, `j?.`, `latest.`, `latest?.`,
`lastOcr.`, `lastOcr?.` — each **anchored to a name boundary**, because a `j.` sitting at the
tail of some longer name is somebody else's property and reading a key off it would invent one
the verdict then has to carry for ever. `round_trip_ms` (the page measures that itself) and
`saved` (the reply to `/capture`, which is not a frame at all) are excluded. **The optional-chaining spellings are not optional and
leaving them out made the test vacuous**: `ocr` is read *only* as `j?.ocr` and `lastOcr?.ocr`,
so a `j.`-only scrape yielded 20 keys without it and deleting `Verdict::ocr` would have stayed
green while blanking the page's OCR panel. `ocr` is therefore asserted for **by name** as the
canary for the whole scrape.

### `src-tauri/src/scanner.rs` — four commands

`ScannerState` is `app.manage`d beside `AppState` in `.setup()`, not a field on it: the scanner
is optional, desktop/Android only, and the only thing it shares with the rest of the app is the
data directory and one read of `corpus.db`.

**Assets are files in `data/scanner/`, and nothing downloads them.** The bundle has no release
asset yet and the models are not ours.

| Path under `data/scanner/` | Missing means |
| --- | --- |
| `card-hashes.bin` | a session with **no reference** — it detects and rectifies and names nothing, exactly as the debug server does with no `--bundle` |
| `models/text-detection.rten` | no reader — the name and collector tiers stand down |
| `models/text-recognition.rten` | the same; the pair loads together or not at all |

A missing file is a **state, never an error**, and `scanner_status` reports the exact path it
looked at for each, so the page says "put `card-hashes.bin` at *this path*" rather than "no
bundle".

**Loading is lazy on the first command and never happens again.** `staleTime: Infinity` on the
status query and no `Reload` button, because asking again in the same session cannot report a
file that has since appeared — the load ran once and the answer is what it loaded. **A bundle
or a model pair placed after the app started needs an app restart**, and that is the honest
instruction: a `Reload assets` press would redraw the same two sentences — `bundleSentence` and
`modelsSentence`, the models' pair sharing one — and read as a repair that had happened.

**The label load opens `corpus.db` directly**, `SQLITE_OPEN_READ_ONLY`, for the length of the
load and dropped after — never `AppState.db_read`, the rule the mirror thread and `Rebuild now`
already follow, because a 117 k-row read on the shared read connection queues every search
behind it. It is *not* `db::open_read`'s attached pair: `Reference::load_labels` reads an
unqualified `FROM cards`, so the corpus has to be `main` and there is nothing on the user side
to attach.

| Command | In | Out |
| --- | --- | --- |
| `scanner_status` | — | `ScannerStatus` — three `Asset { path, present, loaded, error }`, the label count, the scans directory |
| `scanner_frame` | a frame and its `FrameOptions` | `Verdict` |
| `scanner_reset` | — | `()` |
| `scanner_capture` | a full-resolution frame and its `Sidecar` | `Captured { saved }` |

Each is `async`, answered on `spawn_blocking`, and returns `Result<T, String>` with a sentence
for an error. No schema rung: nothing is stored in either database. No capability entry: an
app's own command is always callable. No `error_log` source: the page shows the sentence.

**Two body shapes for one command, and Tauri's own doc is the reason.**
`tauri::ipc::Request`'s documentation says raw bytes are accepted "on all platforms except
Android", and Android's WebView hands a scheme handler no POST body either — so on the phone a
frame can only travel as text.

| Leg | `scanner_frame` | `scanner_capture` |
| --- | --- | --- |
| Desktop | the JPEG as `InvokeBody::Raw`, `FrameOptions` as JSON in an `x-scanner-options` header | the JPEG raw, the sidecar as JSON in an `x-scanner-capture` header |
| Android | `{ jpeg: "<base64>", options }` as ordinary named arguments | `{ jpeg: "<base64>", sidecar }` |

Both land in one payload function per command, which is the whole of the difference.

**The two headers fail differently, and the asymmetry is the point.** A malformed or absent
`x-scanner-options` falls back to `FrameOptions::default()` — a defaulted slider costs one frame
out of thirty and the next one corrects it. An `x-scanner-capture` that is **present and
unreadable** is refused with a sentence, because a defaulted sidecar writes a JPEG to disk with
five empty fields and reports success: an *unlabelled* capture the reader believes they
labelled, which is the one thing the dataset cannot recover from later. An **absent** capture
header is still `Sidecar::default()`, because capturing without typing a name is a thing a
reader chooses.

**The page escapes every non-ASCII character in both header JSONs as `\uXXXX`.** `ipc.ts`'s
`asciiJson` is where it happens. `JSON.stringify` leaves non-ASCII as itself; a browser sends a
header value's 0x80–0xFF as Latin-1 and throws outright above that; and Rust's
`HeaderValue::to_str` refuses any byte outside visible ASCII. So `Æther Vial` in an
`x-scanner-capture` either kills the call in the page or arrives as mojibake the far end rejects
— a scanner refusing exactly the cards whose names are worth reading. `\uXXXX` is the one
spelling that survives all three hops and is still the same JSON: `JSON.parse` on the far side
yields the original character.

**Both ends are tested and they are tested apart, which is the thing to know before adding a
third header.** On the page, `ipc.test.ts`'s *"escapes a non-ASCII card name into the capture
header, losslessly"* pins the exact string `scannerCapture` produced, sweeps it with
`/^[\x20-\x7e]*$/` — the range `HeaderValue::to_str` accepts — and round-trips it through
`JSON.parse`. In Rust, `scanner::tests::an_escaped_card_name_comes_back_with_its_accent` asserts
its input `is_ascii()` and reads `Æther Vial` back out of `capture_payload`, and
`a_capture_header_that_is_not_visible_ascii_is_a_sentence` proves the refusal on raw bytes.

**What no test does is carry one string across.** Each side writes its own `Æther Vial`
literal, by hand, in a different file, and nothing compares the two — the ordinary shape of a
cross-boundary contract in this repo, and the reason `ipc.test.ts` reads `.rs` files as text at
all. And the *options* header is weaker still: its case compares against plain
`JSON.stringify(DEFAULT_SCANNER_OPTIONS)`, which is **indistinguishable from `asciiJson` while
those defaults are all-ASCII** — every value there is a number, a boolean, `"both"` or `"votes"`
— so `x-scanner-options` is escaped by the same function and pinned by nothing that could tell
if it stopped being. That is why the rule is written out in
[`src/CLAUDE.md`](../../src/CLAUDE.md) and
[`src-tauri/CLAUDE.md`](../../src-tauri/CLAUDE.md) as well as here: the tests prove the capture
header at each end, and the prose is what carries the rule to the next header somebody adds.

The Android leg needs none of it: a JSON body is UTF-8.

`scanner_capture` writes `live-<epoch>.jpg` and its `.json` sidecar into `data/scanner/scans/`,
the same names and fields the debug server writes into `docs/scanner/scans/`, so a frame
captured in the app can be copied into the repository's dataset unchanged.

### The IPC seam

`Core.call` widened to `call(command, args?: CallArgs, options?: CallOptions)`, where
`CallArgs` is `Record<string, unknown> | Uint8Array` and `CallOptions` carries `headers`. The
Tauri core passes both through to `invoke`; **the browser core rejects a `Uint8Array` with
`RAW_CALL_UNAVAILABLE` before touching the Worker**, and that string is the same sentence the
web build's Scanner view draws — the page imports the core's refusal rather than writing a
second copy of it.

`ipc.ts`'s scanner types keep the **Rust field names, snake case**, because the header JSON is
deserialised straight into `FrameOptions` and the verdict is what the debug page already reads.
That made a third mirror table in `ipc.test.ts`, `snakeMirrors`, alongside the two that
camel-case the Rust side: a scanner row on `plainMirrors` would fail on every multi-word field
for a spelling that is correct. Most of that list is one command's answer, because a `Verdict`
is a tree of structs and parity on the outer one sees none of it — a renamed `best_distance`
inside a standing leaves `Verdict` agreeing field for field while every row of the candidate
table reads `NaN`. So each level is named.

Two things the ordinary parser could not express, both the scanner's. A `#[serde(skip)]` field
is dropped, and the attribute sits on the line *before* the field, so the walk reads its
neighbour rather than its own line — `LockState::quad` is the live one, while
`skip_serializing_if` is deliberately **not** matched, because `Verdict::error` *is* in the JSON
whenever it has a value. And `r#match` is read as `match`: the one raw identifier in either
tree, since `match` is a Rust keyword and is not a TypeScript one.

**Both parsers split on `/\r?\n/` rather than on `"\n"`**, and it is not tidiness. A file's line
endings are not a fact about the code in it, but `body.indexOf("}")` compares a whole line — so
a source with CRLF endings ends every struct in `"}\r"`, the closing brace is never found, and
the row fails with `has no closing brace` for a mirror that is perfectly correct. The
`card-scanner` sources are not uniformly LF, and an editor or a generated write flips one file
with nothing in either build noticing. A fence reporting a drift that does not exist is worse
than the drift: it trains a reader to disbelieve the table.

### The view

`src/features/scanner/`. `ScannerPage` dispatches **above its hooks** on `isWebTarget()`, so on
the web target no camera is asked for, no command is called and no `useQuery` is conditional —
`BackupPanel`'s shape, for `BackupPanel`'s reason.

| File | Owns |
| --- | --- |
| `ScannerPage.tsx` | The view: the web sentence, or the camera and the panel column |
| `useCamera.ts` | The stream: `getUserMedia` with the debug page's constraints, one `stopAll` every exit path goes through, a tolerated `play()` rejection, and the wait for `loadedmetadata` before reporting a size. Its error state is **keyed on `verdictText.ts`'s `cameraSentence`**, which is where the wording lives |
| `useScanLoop.ts` | The pump: one request in flight, later frames dropped, the rate over twenty round trips, `grab` for the capture |
| `Overlay.tsx` | The canvas over the video — the smoothed quad, the raw one behind it |
| `ScannerPanels.tsx` | Pure. The whole column from `{ status, verdict, options, … }` |
| `panels/Panel.tsx` | The section chrome, the fold, and the shared `Row` / `FIGURES` / `BUTTON` |
| `panels/MatchPanel.tsx` | The verdict, the bar, the standings, reset and capture |
| `panels/ControlsPanel.tsx` | The rule and method segments, the stages toggle, the sliders |
| `panels/PipelinePanel.tsx` | The three stage images, only when stages are on |
| `panels/BudgetPanel.tsx` | The per-stage milliseconds as a stacked bar |
| `panels/RectifiedPanel.tsx` | The rectification and the detection numbers |
| `panels/ReadoutsPanel.tsx` | Both OCR bands, and every collector pairing with what it resolved to |
| `scannerOptions.ts` | `FrameOptions::default()` verbatim, the slider specs, `send px` |
| `verdictText.ts` | The pure sentence functions the panels, the tests and the stories share |
| `types.ts` | Re-exports of the `ipc.ts` mirror types, so a panel imports from its own feature |
| `fixtures.ts` | The canned verdicts the tests and the stories are both driven from |

**`send px` is not a `FrameOptions` field**, which is why it is a prop of its own beside the
sliders: it is the long edge the page downscales to before sending, and the detector never sees
the size it was not sent.

**The fold state is in the app store, not in the view** — `scannerFolds` and `setScannerFold`,
keyed by `ScannerPanelId` — so a reader who folded the pipeline away and jumped to Settings
finds it still folded coming back, the same reason `openDeckId` is parked there. In memory
only: no `app_meta` row and no persist middleware, exactly as `keyMapOpen`. **Match has no
fold** — it is what the screen is for — and every developer panel starts closed, because each of
them answers "why did it come to that" and a reader who is only scanning should pay for none of
them.

**`Panel` sets `aria-controls` only while the body is in the tree.** The body is unmounted
rather than hidden, so a folded heading pointing at `scanner-controls-body` would name an
element that is not in the document — a dangling IDREF, which a screen reader resolves to
*nothing* rather than to an error. `aria-expanded="false"` on the button already says there is
something to open. The region keeps its `aria-labelledby` either way, because that target is the
always-mounted heading, so `getByRole("region", { name })` finds a folded panel too.

**The overlay scales its strokes with the canvas**, as `live.html` does. The canvas is sized to
the video's own pixels and the quad arrives in the *sent* frame's coordinates, so both a scale
factor and a stroke derived from the canvas width are needed — a fixed `lineWidth` is a hairline
on a 1080p stream and a slab on a 480 px one.

**The two arms of the layout size the video box by opposite mechanisms, and the narrow one has
to.** Wide, the row is the height and the video takes what the `w-80 shrink-0` panel column
leaves. Narrow, the row is a *scrolling column*: a zero-basis `flex-1` under a scrolling parent
yields all its free space to a `shrink-0` sibling, so one opened developer panel whose intrinsic
height reached the container's would collapse the camera to ~0px. So on a phone the box is
`w-full shrink-0` at the **camera's own `aspectRatio`**, falling back to 4:3 while the stream has
no shape to report — an unset ratio there is the collapse again.

**`useNarrowWindow` is read, not branched on.** A phone stacks the camera above the verdict
where a desk stands them side by side, and what that asks is whether the app is in its phone
shape — an answer the shell has already decided. `viewports.ts` demands a reason at the site of
any branch on width; the reason here is that there is no new branch.

### Navigation, and the web

`ViewId` gained `"scanner"`; `NAV` gained it **between `wishlist` and `settings`** so Settings
stays the last row; `switchView`'s chords are a run bound **by index** into `NAV`, so Scanner is
`Ctrl+6` and Settings moved to `Ctrl+7`.
[keyboard-shortcuts.md](keyboard-shortcuts.md) carries that row and what the move cost a reader
whose hands knew the old chord.

On the web target the whole view is one sentence — *The scanner needs the desktop or Android
app — this build has no detector.* The four commands are `#[cfg(not(target_family = "wasm"))]`
and unrouted, so they are absent from `web::route`'s census by construction; the browser core's
refusal of a `Uint8Array` is the fence behind that, not the path a reader sees.

### Storybook

`scannerHandlers(db)` sits beside `pluginHandlers()` with **four handlers**, one per command, and
**no store** — nothing here mirrors a table, and a workbench has no camera, so `scanner_frame`
answers the decided fixture whatever bytes it is handed and the panel stories are driven from
fixtures directly. The fault **`scannerMissing`** makes `scanner_status` answer every asset
absent with its path.

`Scanner/Panels` has **ten** stories and `Scanner/Page` **two** — `CameraRefused`, which stubs
`navigator.mediaDevices` from a `useState` initializer (an effect runs after the first paint, and
`useCamera`'s own effect has to see the stub before it fires) so the refusal is the *specific*
`NotAllowedError` rather than whichever one an environment throws first, and `AssetsMissing`.
**There is no `WebBuild` story**: `isWebTarget()` is `__CORE__ === "web"`, a define the
workbench's Vite config folds to `"tauri"` exactly as `vite.config.ts` does for
`stories.test.tsx`, so that view is compiled clean out of every bundle a story can run against,
and reaching it needs `vi.mock`, which is `stories.test.tsx`'s tool and not the workbench's.
`ScannerPage.test.tsx` is where that state is proven.
