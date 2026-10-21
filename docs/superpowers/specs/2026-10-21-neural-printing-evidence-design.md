# Neural scanner: set symbol and collector band evidence for the printing

Issue [#1324](https://github.com/Msgaihede/mtg-grimoire/issues/1324). Brainstormed with the owner
2026-10-21.

## 1. Why

The Neural scan mode (`card-scanner`'s `neural` feature over `crates/card-neural`, see
`docs/reference/card-scanner.md` §10 _Neural_) is very good at **which card** and poor at **which
printing**. On the 124 readers' scans it decides the card right 96.0 % of the time with 0 wrong,
but 42 of its decisions are `ambiguous`: the tray asks the reader to pick a printing, sometimes
out of 20+. Two causes:

- **The embedder cannot see what tells printings apart.** It reads the card through the box
  `[0.03, 0.02, 0.97, 0.72]` at 128×128 (`models/neural.json`): the collector band is cut off, and
  the set symbol is a few pixels. A look (`looks.py`) groups printings that photograph alike — up
  to 32 of them — and a look's printings are exactly the choices the tray offers.
- **The right printing is sometimes not offered at all.** The choices are only the decided
  look's covers (`neural_mode.rs`, `neural_decision`). Another look of the same card that scored a
  little lower — a different frame, border or promo treatment of the same art — is dropped, and
  `Scored::twins` is computed but never used. The owner has seen readers fix the printing by hand
  after the scan for this reason.

The card itself carries the answer in two places, as in the issue's screenshots: the **set
symbol** at the right end of the type line, and the **collector band** at the bottom left (number,
rarity, set code, language, a foil star or dot, the artist). The band also carries **The List's
planeswalker mark** at its far left — the only thing that separates a PLST printing from its
original, which share art, frame and set code on the card (and today share a look in the
gallery).

**OCR is not the answer here** (the owner's call, from experience): the band is often too blurry
for the `ocrs` collector reader Fast and Exact use. Trained networks that learn what a blurry band
looks like should do better.

## 2. What it does

Two new small networks — one for the **set symbol** crop, one for the **collector band** crop —
used after Neural has decided the card, to choose among that card's printings.

1. **The card is decided exactly as today.** The whole-card match, its thresholds and its
   agreement across frames are untouched. The new networks never change which card is decided,
   so they cannot add a wrong card.
2. **The candidate printings are widened by a lower bar** (the owner's call: a lower threshold,
   not every printing of the card). The candidates are the covers of **every look of the decided
   card whose whole-card score clears a second, lower bar** — below today's twin gap — limited to
   what the filters admit. Printings the picture plainly rules out stay out; printings that lost by
   a little come back. The bar is a new threshold in `neural.json`.
3. **The candidates are compared on the two crops.** After the corners are found, the scanner cuts
   a straightened symbol crop and band crop of the decided card from the ordinary frame Neural
   already reads (§5, _The crops come from the ordinary frame_), and each network
   scores how well each crop matches **each candidate printing's own reference crop**.
4. **A printing is decided only when the evidence is sure.** When the symbol and band evidence
   (with the whole-card score) clearly favour one candidate, the decision names it and is not
   ambiguous. Otherwise the decision stays `ambiguous` and the choices are the candidates the
   evidence could not rule out, best first — fewer than today when the evidence helps, and
   possibly including a printing today's choices missed.

**No new UI.** The tray already offers a pick for an ambiguous decision; it just gets fewer,
better choices, best first.

## 3. Goals, non-goals, anti-goals

**Goal (the owner's success bar): any improvement in ambiguity, with no new wrong results.** On the
readers' scans:

- fewer than today's 42 ambiguous Neural decisions, and more exact printing matches (more
  _resolved right_ decisions — §5 _Measurement_ says why not `printing ✓`);
- shorter choice lists where a decision stays ambiguous — cutting 28 printings to 2 or 3 is a
  win in itself;
- the reader's printing among the choices at least as often as today (118 of 124).

**The floor: no more wrong cards and no more wrong printings than today** (0 wrong). A wrong
printing is worse than a pick in the tray; when unsure, leave the choice to the reader.

**Non-goals:**

- Reading the set code or number as text, or naming a set with no candidates to choose among.
- Reading the finish (foil star vs dot) from the band. The band crop shows it, and it is a natural
  next step, but it is not this piece of work; under _Detect_ a two-finish printing still lands
  Unknown.
- Changing Fast or Exact, or the whole-card embedder, detector or gallery.
- An ordering rule that guesses a printing without evidence (the owner refused one when Neural
  shipped, PR #1224). Best-first here means best by the crops' evidence.

**Anti-goals** — this is a failure even if it technically works:

- a single wrong card or wrong printing on the readers' scans that today's Neural gets right or
  leaves ambiguous;
- the right printing dropped from the choices where today it was offered;
- the card decision arriving later than today, in frames (Claude's call; the owner chose the
  ordinary frame partly so it would not).

## 4. Constraints

- **Ship everywhere Neural runs** (the owner's call): desktop and Android compile the files in
  (`card_neural::bundled()`); the web fetches them from `/scanner-neural/<set>/` on the first
  Neural frame. The larger download is accepted. Estimated: the files grow from ~27 MB to ~40 MB.
- **Each file at most 25 MiB** (`HOST_FILE_LIMIT`, `packages/ui/lib/core/web/assets.ts`), with its
  row in `crates/card-neural/models/README.md`'s table (bytes, sha256 ends), which the web build
  checks.
- **The model files are one set** (`crates/card-neural/CLAUDE.md` §1): the new networks, their
  reference galleries and `neural.json`'s thresholds change together with the existing four, and
  are remade together by the monthly retraining.
- **The browser Worker rules** (`crates/card-neural/CLAUDE.md` §2): no clock, no threads, no
  files; bytes in through `Files`.
- **Only our own weights**, trained on Scryfall images; nothing from quickdraw.cards.
- **The monthly retraining stays under $10 a run** (`budget.py`'s ledger). The two new trainings
  are on small crops and should be cheap, but they need their own shares in the split.
- **The development and measuring happen in the scanner lab** (`E:\mtg-scanner`), as the existing
  networks' did; only the production recipe lands in `crates/card-neural/train/`.
- **The 124 readers' scans up to 2026-10-15 are the test set** — never trained on. Thresholds tuned
  on them by cross-validation, as today's were; newer scans (`pnpm scanner:corpus pull`, the
  owner's R2 credentials) are the honest test.

## 5. How — decided

### The crops come from the ordinary frame

**The owner's call (2026-10-21): ordinary frames first.** The crops are cut from the frame Neural
already reads — ~960 px on its long edge in the readers' scans (`DEFAULT_SEND_PX`), where the band
is only a few pixels tall and the symbol about a dozen. Neural does **not** ask for a detail frame,
so the decision arrives on the same frame as today and the whole path is measurable on the
readers' scans, which store no detail frames (`replay.rs`: "no detail pictures").

Expect most of the gain from the set symbol and the wider candidate list; the band network earns
what it can at this resolution, and its threshold must keep it quiet where it cannot. The networks
are trained across resolutions so they hold on sharper crops too.

**The sharp-frame step is a follow-up, not this work:** cutting the crops from a detail frame
(as Fast and Exact read their bands, card-scanner.md §4 _Where the bands come from_) once the scan
inbox also stores one detail picture per run, so that path can be measured against the same floor.

### The crops

- **Cut after the corners are found, from the frame, straightened** — `frame::sample_card` with a
  sub-box of the card's unit square, which it already supports (the embedder's own crop is one).
- **Fixed regions of the card**, the same on the camera crop and the reference crop. Because a
  camera crop is only ever compared with the candidate printing's own reference crop cut at the
  same place, a frame that moves the symbol or the band (borderless, showcase, old frames) is the
  same on both sides — nothing has to find the symbol first.
- **The band crop starts at the card's left edge** so it includes The List's planeswalker mark, and
  **runs wide enough to include the artist** — which the OCR crop deliberately stops short of
  (`ocr::COLLECTOR_BAND` ends at 28.5 % width), but which is useful evidence here: printings of one
  card often differ by artist line.
- **Both crops get slack around the region**, and the networks are trained on crops cut through
  jittered quads. Neural's detector quad is close but not exact — training draws it 5–10 % outside
  the card on some sides when the card is in a sleeve or toploader (`qd_scene.py`) — and that error
  matters far more on a small region than on the whole card.

### The networks compare; they do not read

**This is Claude's call, put to the owner in the brainstorm and not objected to.** Each network is
an embedder: it turns a crop into a fingerprint, and a candidate printing's score is the
similarity between the camera crop's fingerprint and the fingerprint of that printing's reference
crop. The reference fingerprints are computed from the Scryfall images the pipeline already
downloads and shipped as a gallery, one row per printing (and face).

Why compare rather than read or classify:

- It only has to tell apart a handful of candidates, a far easier job than naming a set.
- **A new set needs no new training**: its reference crops are embedded into the gallery. A
  classifier over set codes would know nothing about a set it was not trained on.
- A blurry band carries more than its characters — the length of the artist's name, the rarity
  letter, the layout, the PLST mark — and comparison uses all of it.

### The decision

- Lives in `card-scanner`'s `neural_mode.rs`, where the decision's printing and choices are built
  today (`neural_decision`). It needs the pixels and the decided card's quad, which `neural_read`
  holds and `neural_verdict` today does not receive.
- `card-neural` gains the networks, galleries and a way to score a crop against a set of
  candidate printings; it has no index of a card's looks today (`gallery.card(e)` is scanned), so
  it gains one.
- Thresholds — the lower candidate bar and the bars for "sure enough to decide one printing" and
  "close enough to stay a choice" — live in `neural.json`, not in code.
- Choices are ordered best first by the evidence; a choice's `distance` reflects its own score
  rather than the look's.
- **The printing is final when the card is decided** (Claude's call, following from the owner's
  ordinary-frames choice and "no new UI"). The evidence is summed over the frames that voted for
  the decided card, up to and including the deciding frame — the networks run on the voted-for
  card only, two small inferences a frame. Nothing refines the printing after the decision: the
  page ignores a second decision within `DECISION_GAP_FRAMES`, and the replay scores the decision
  held on the last frame, so refinement could score in the replay and do nothing in the app.
- **The web loads the evidence files without holding up the card** (Claude's call): a Neural
  frame does not wait for them. Until they are ready a decision is made as today (the look's
  covers as choices), so the extra download never delays a card decision.

### Measurement

- **The replay is the gate** (`pnpm scanner:replay`, `crates/card-scanner/src/bin/replay.rs`). It
  gains a count of choices per ambiguous decision (`PassOut`, `results.ts`, `summary.ts`), since
  "28 cut to 3" is part of the success bar and the replay records only `ambiguous` and
  `true_in_choices` today.
- **What the floor and the bar count** (Claude's call). `replay::score` today compares only a
  decision's first printing with the label, so a different printing of the right card is "card
  ✓", never "wrong", and an ambiguous decision whose first choice happens to be right is "printing
  ✓". Best-first ordering alone would lift that number. The replay therefore also reports, per
  pass: **resolved right** (not ambiguous, printing = label), **resolved wrong printing** (not
  ambiguous, right card, printing ≠ label), the ambiguous count, choices per ambiguous decision,
  and `true_in_choices`. The floor is: wrong cards and resolved-wrong-printings no higher than
  today's Neural pass (measured first — today's may not be 0). The success bar is read on
  resolved-right and the ambiguous count, not on `printing ✓`.
- **Labels are the reader's claim, and the floor is only as good as they are** (Claude's call). A
  reader picking among 20 look-alikes, or between a PLST printing and its original, can mislabel.
  Before thresholds are tuned, every run where the networks' best printing disagrees with the
  label is listed with its crops for the owner to judge; a label the owner overturns is corrected
  for this work's measurement (and the correction recorded), never silently.
- **The owner gates the merge on newer scans** (Claude's call). Tuning on the 124 is in-sample
  cross-validation over ~42 ambiguous cases. Before merge, the owner pulls the scans after
  2026-10-15 (`pnpm scanner:corpus pull`, the owner's R2 credentials) and the replay must hold the
  floor on them too; the success bar is read on both sets.
- The result is compared with today's Neural pass on the same scans, and published in
  `card-scanner.md` §10 _Neural_ beside today's table.

## 6. Left to the builder

- The networks' architecture, input sizes and fingerprint length — small enough for the web and
  the size estimate, measured in the lab.
- The exact crop regions and their slack, measured on the readers' scans and Scryfall references
  across frame types (old, modern, borderless, showcase, full-art, sagas, adventures, split and
  flip cards; landscape layouts are already excluded from the gallery).
- Training: how camera views of a crop are synthesised (the embedder's `camera_view` and scene
  contexts are the starting point), which loss, and how many epochs fit the budget. Whether the
  references need Scryfall's `large` image rather than `normal`: they must be at least as sharp
  as the camera crops they are compared with.
- How the symbol and band scores combine with the whole-card score (a weighted sum, a rule, a
  small learned combiner), so long as its thresholds are in `neural.json` and tuned by
  cross-validation under the zero-wrong floor.
- Whether the symbol gallery is per printing or deduplicated (a symbol is shared by a set and
  rarity — but not across PLST and its originals, whose symbols match the original's set).
- Cards with no collector number (before 2015) or no type-line symbol: the networks will give
  weak evidence there, and the decision must fall back to the choices without harm.
- File layout: two new networks and two galleries as separate files, or galleries combined, within
  the 25 MiB limit; every place that lists the neural files (`card_neural::Files`, `bundled()`,
  `NEURAL_FILES`, the web Worker glue, `scanNeural.ts`, the replay's `pinned`, `deliver.py`,
  `update_readme.py`) learns them.
- The monthly pipeline's new stages (`modal_app.py`, `budget.shares`, `FLOORS`, `DONE.json`'s
  `files`) and their floors.
- Documentation: `card-scanner.md` §10 _Neural_, `crates/card-neural/CLAUDE.md`,
  `models/README.md`, and the plan.
