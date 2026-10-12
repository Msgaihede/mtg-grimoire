# Scanner replay: testing the scanner against readers' scans

2026-10-12. Design for a developer tool that replays the scans readers send to the scan inbox
through the card scanner and scores them, so a change to the scanner can be measured against
real footage.

## Purpose

`eval` measures the scanner on Scryfall renders degraded in software; its own documentation
says that is a regression fence and never a claim about a camera, and the photographs the
scanner was tuned on are lost (`docs/reference/card-scanner.md` §8). Since 2026-10-11 a
supporter can send a scan: five to twenty of the frames the scanner judged, about two seconds,
with the printing and finish the reader says they show (`infrastructure/scan-worker/README.md`).
Those are the only labelled real frames there are.

**Success** is: one command produces a reproducible accuracy table over every scan received,
a second run after a scanner change says which scans were fixed and which broke, and a page
shows per scan what was expected and what was matched instead.

**Out of scope**: running in CI, anything shipped in the app, changing the scanner itself, and
changing the inbox Worker.

## What is known about the inputs

- `runs/{id}.bin` is the JPEGs end to end; `labels/{id}.json` indexes it (`run[n].bytes`) and
  carries `card`, `finish`, `scanner` (`reported`, `mode`, `filters`, …), `app`, and per frame
  `ms`, `ok`, `lock`, `confidence`, `distance`, `decided`, `detail`.
- `Session::frame(jpeg, opts)` decides on frames, not on a clock: `Stopwatch` feeds timing
  figures only. A replay at full speed with `ResolveOn::Inline` is deterministic.
- A replay is not the original scan in three ways, all documented by the inbox: no evidence
  from before the first frame, no `detail` pictures, and developer sliders at their defaults.
- The inbox holds at most 500 runs and expects to be emptied.

## Decisions taken with the owner

1. The durable corpus is a second, private R2 bucket; the inbox is drained into it.
2. The evaluation runs locally only, for now.
3. The output includes a graphical overview of what matched, what did not, and what was
   matched instead.
4. The overview shows the slices the scanner actually cut for a scan — the title and
   collector bands, the rectified card and the black and white image — once a run, not for
   every frame of every pass.

## Components

### 1. Corpus sync: `scripts/scanner-corpus.ts` (`pnpm scanner:corpus`)

| Command | Does |
| --- | --- |
| `pull` | Copies every complete pair that adds up from the inbox bucket to the corpus bucket, re-lists the corpus and reports any copy that is missing or of other sizes, then mirrors the corpus bucket to the local folder and cuts each run into frames. Deletes nothing remotely |
| `pull --drain` | The same, then deletes from the inbox every complete pair whose copy in the re-listed corpus has the same two sizes, adopted now or by an earlier pull. The only destructive step |
| `status` | Counts: inbox pairs, inbox litter, corpus pairs, local pairs |

- **Buckets**: inbox `mtg-grimoire-scans` (exists), corpus `mtg-grimoire-scan-corpus` (the
  owner creates it). Same `runs/` and `labels/` layout in both, plus `baselines/` in the corpus.
- **A pair is complete** when both objects exist. **It adds up** when, at adopt time and before
  anything is put, the label parses, its frames' `bytes` sum to the run's length and each frame
  starts as a JPEG. A complete pair that does not add up is skipped, left in the inbox untouched
  and reported under "do not add up"; it has no corpus copy, so drain never takes it. A run with
  no label is litter: reported, never copied, never deleted by this tool.
- **Arguments** are read before any network call, and one the tool does not know is refused with
  a sentence, so `pull --dry-run` cannot pull for real.
- **Local mirror**: `.scanner-corpus/` in the *main* checkout, found through git's common
  directory so a worktree does not get a copy that dies with it; `SCANNER_CORPUS_DIR`
  overrides. Git-ignored. Layout: `labels/{id}.json`, `runs/{id}.bin`, `frames/{id}/NN.jpg`,
  `baselines/`, `out/`.
- **A local pair with no remote pair is removed** on `pull`, frames included: a deletion
  request is honoured by deleting from the corpus bucket. **A deletion request names an id**: both
  objects are deleted in both buckets (an undrained inbox would adopt it again), and the next
  `pull` removes the scan locally — frames, `out/slices/{id}/`, the last `results.json`,
  `summary.md` and `report.html` (they hold the pruned scan; the next replay rewrites them) and
  its rows in every `baselines/*.json`, which are uploaded over their copies in the corpus
  bucket. **Baselines are reconciled against the corpus on every pull**, not only when something
  is pruned: each local baseline loses any row whose scan the corpus does not hold, and an upload
  that fails is listed in `baselines/.pending.json` and retried on the next pull. Frame and slice
  folders of no scan here are swept on every pull. **Except when the corpus bucket lists
  as empty beside a non-empty mirror**: that is an unreadable bucket more likely than a bucket
  emptied on purpose, so the sync refuses with a sentence before it adopts or prunes anything.
  A full, deliberate purge is therefore refused until the mirror folder is removed by hand.
- **An id is `[A-Za-z0-9_][A-Za-z0-9_-]*`**, because it becomes a file name and a folder, and never starts with `-`, which would read as a flag in a command. A key whose id is
  anything else is reported as strange and never read, copied or removed.
- **Transport**: R2's S3 API, SigV4 signed with `node:crypto` in one small module (no new
  dependency). Credentials from `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`
  in the environment only; missing ones are a sentence and exit 1. Never written to a file.
- **Shape**: a pure planner (`plan(inbox, corpus, local) -> actions`) and a thin executor, so
  the plan is tested without a network.

#### Removing scans: `remove` (added 2026-10-13)

`pnpm scanner:corpus remove <id>... [--from-file <path>] [--yes]` is the cleanup for a bad scan,
a wrongly tagged one or a general tidy-up. Decided with the owner: **remove only**, no relabel and
no exclude list, so the corpus holds only labels a reader chose.

- **Ids** come from the arguments and a file (one a line; blank lines and `#` lines skipped;
  duplicates collapsed). Each must be a safe id; one that is not, or none at all, is a sentence
  before any network call.
- **Without `--yes` it is a dry run**: it lists both buckets and the mirror and says per id where
  it was found (inbox, corpus: run, label or both; the mirror) and how many rows it has in each
  local baseline, then that nothing was deleted. An id found nowhere is said so and makes the exit
  code 1, in a dry run and a real one, without stopping the others.
- **With `--yes`**, per id: the inbox's label, its run, the corpus's label, its run, then the local
  pair; then, after all ids, the last report and the baselines. The inbox goes before the corpus
  so an interrupted run cannot be adopted again; the label before the run as `--drain` does.
  Only the four exact keys are deleted, and only those listed, so a half pair is removable. A
  failed step ends that id (deleting the corpus copy after a failed inbox delete would let the
  next pull re-adopt it), is listed, and makes the exit code 1.
- **The empty-corpus refusal does not apply**: it guards pruning by absence and `remove` deletes
  by name. For the same reason the baselines lose only the removed ids' rows (`withoutRuns`),
  never "everything the corpus does not hold". The reconciliation is the pull's own
  (`reconcileBaselines`), called by both.
- **The report picks the ids**: a box on each scan, and a bar that shows how many are ticked and
  copies `pnpm scanner:corpus remove <id> …` (or shows it in a box when the clipboard refuses).
  The page deletes nothing and makes no request.

### 2. Replay: `crates/card-scanner/src/bin/replay.rs`, behind `builder`

```text
replay --corpus-dir <dir> --bundle card-hashes.bin --corpus corpus.db
       --models <dir> --out <dir> [--commit <sha>] [--only <text>]... [--jobs N]
```

- **Reads** every `labels/*.json` with a matching `runs/*.bin`, cutting the run by the label.
  A pair that does not add up is reported and skipped, never a panic.
- **Three passes a run**, a fresh `Session` each, `ResolveOn::Inline`, all frames fed in order:

  | Pass | Mode | Filters |
  | --- | --- | --- |
  | As scanned | the label's | the label's |
  | Fast | Fast | none |
  | Exact | Exact | none |

- **Outcome of a pass**, judged on the last decision the session held at the run's end
  (the label names the card in the last frame):

  | Outcome | When |
  | --- | --- |
  | `printing` | the decided printing is the label's |
  | `card` | another printing of the same oracle card |
  | `wrong` | another card; the result names it |
  | `ambiguous` | Exact answered choices; recorded with whether the truth was among them, judged on the first choice as `eval` does |
  | `undecided` | no decision by the last frame |
  | `error` | the session panicked, a frame did not decode or a resolve failed; the pass keeps what it answered but is not counted as `undecided` |

  Also recorded, per pass: the frame the first decision landed on (`first_decision_frame`),
  the frame of the decision the score is read from (`decision_frame`) and how many decisions
  were made (`decisions`); `locked_frames`; and `resolve_ran`. Per frame: `ok`, lock phase,
  confidence, best distance, the printing decided by then and an `error` when the scanner
  failed on that frame.
  **`resolve_ran` is what separates "too short" from "missed".** An Exact resolve waits for
  `EXACT_STEADY_FRAMES` (3) steady locked frames and then for a `detail` frame or
  `EXACT_DETAIL_WAIT` (4) frames more (`session.rs`); a replay has no detail pictures, so a run
  with fewer than seven steady frames after the lock never resolves in Exact. Such a pass has
  `resolve_ran: false` and is not a scanner miss. Fast always counts as having run.
- **The pictures the scanner cut are kept, once a run** — from the As scanned pass alone,
  and only where the scanner actually made one. That pass runs with `FrameOptions::stages`
  and `previews` on, and writes to `out/slices/{id}/`:

  | Kind | From | How many a run |
  | --- | --- | --- |
  | `title` | `ocr.band`, the title band as the recogniser read it | one for each title read the scanner made |
  | `collector` | `collector.band`, the collector band at the size it was read | one for each collector read |
  | `rectified` | `Verdict::rectified`, the card after the homography | the deciding frame's, or the last frame's with a card when nothing was decided |
  | `binary` | `stages.binary`, the black and white edge image | the same one frame |

  Each is named for the frame it came from (`NN-title.jpg`). The words beside them are kept
  in `results.json`: the title's raw and normalised read and what it matched, the
  collector's raw read, the pairings tried (set and number, each with what it matched), the
  finish mark, and for an Exact resolve each tier's survivors and detail. A slice that does not
  decode is dropped rather than written. The Fast and Exact passes keep no
  pictures. The two options cost time and are documented as changing no decision; a test
  replays one run with them on and off and asserts the same outcomes, so the pictures cannot
  become a second scanner.
- **Then vs now**: the label's `scanner.reported` scored the same way, beside the As scanned
  pass, and a count of frames where the replay's `decided` differs from the label's (compared
  ignoring case; `null` when the As scanned pass errored or fed another frame count). This
  measures how faithful a replay is, separately from any change to the scanner.
- **Breakdowns**: finish, `app.platform`, original mode, and whether any frame was `detail`.
- **Shared with `eval`**: loading labels from `corpus.db` and attaching them to a
  `Reference` move from `eval.rs` into a small `bin/support` module both binaries include.
  Nothing else in `eval` changes. `replay` takes `--corpus` only and requires it: `--bulk` is
  `eval`'s, for CI, which has no `corpus.db`, and nothing runs `replay` there.
- **Writes** `results.json` to `--out`: scanner commit, bundle entry count, corpus size, and
  per run, per pass, the outcome and per-frame figures. The schema carries a version (`v`).
  **The binary supplies these facts and draws no table**: the aggregate table, the
  comparison with a baseline and the list of runs that flipped are computed once, in the
  wrapper (below), which both `summary.md` and the report read — so the two cannot count
  differently.
- **Exit code**: 0 for a completed run whatever the accuracy; 1 when nothing could be
  replayed. It reports and does not gate.

### 3. Wrapper and report: `scripts/scanner-replay.ts` (`pnpm scanner:replay`)

- Resolves the corpus directory, the bundle, the models and `corpus.db` from their usual
  places (`.scanner-bundle/` and `data/` in the main checkout), or from `--bundle`, `--models`
  and `--corpus`; `--jobs` bounds the replay's threads; `--no-build` trusts the binary as it is
  and stamps the commit `+nobuild`. Otherwise it builds and runs `replay` in release, then writes `summary.md` and the report from `results.json` and prints both
  paths. The table, and with a baseline the deltas and every run that flipped, are computed
  here.
- `--baseline <name>` compares against `baselines/<name>.json`; `--save-baseline <name>`
  copies this run's `results.json` there; a baseline is written once, so saving over a name
  replaces it locally and a pull does not re-upload the change (use a new name). A name is `[A-Za-z0-9_.-]+` and does not start with a
  dot; anything else is a sentence and exit 1. `pnpm scanner:corpus pull` carries `baselines/`
  to and from the corpus bucket.
- **`report.html`**, written into the corpus directory's `out/`, self-contained apart from
  images:
  - A scan whose `known` is false (the reader's printing is not among the card labels read from
    `corpus.db`, the local card data) is marked "not in this card data" on its row; the summary
    does not count `known`. The summary counts, per pass, runs that never resolved because they
    were too short, and runs
    "decided then lost" — undecided passes that made a decision and no longer held it at the
    last frame, whose `decision_frame` is therefore not the scored one. Exact's percentages keep
    the too-short runs in their denominator, to be read beside "never resolved".
  - Summary tiles per pass: printing ✓, card ✓, wrong, undecided, with deltas when a baseline
    was given.
  - One row a run: the frame filmstrip (each frame edged by lock phase, the deciding frame
    marked, `detail` frames flagged), the expected card, and per pass the card matched
    instead with an outcome chip, distance and confidence.
  - Each row also carries the run's slices, one strip: the rectified card, the black and
    white image, then every title and collector band the scanner read, in frame order, each
    captioned with what was read from it and what that matched; a collector band's caption
    carries the collector pairings tried and the finish mark. A run where no band was
    read says so in words. For Exact the tier-by-tier account of the resolve sits beside
    them.
  - Filters: all, wrong card, wrong printing, undecided, errors, changed since baseline; a search by
    card name or run id.
  - Frames load from `../frames/{id}/NN.jpg` and slices from `slices/`; card images from Scryfall by id. The page is
    for this machine and is not publishable, by design.
  - Rendering is a pure function of `results.json`, in TypeScript, tested with Vitest.

### 4. Baseline and privacy

- A baseline is a `results.json`, stored beside the corpus locally and in the corpus bucket,
  and named for the scanner commit and the bundle it ran against. A comparison across two
  bundles says so in the summary.
- **Only the aggregate table enters git**, in `docs/reference/card-scanner.md`. Per-run ids
  and frames never do: an id is the handle a deletion request has, and history cannot honour
  one.
- No new field is stored about a sender. The privacy policy's promise is unchanged; the
  corpus bucket is named in `infrastructure/scan-worker/README.md` as where read scans go.

## Error handling

- Sync: a failed copy or verification leaves the inbox pair alone and is listed at the end;
  `--drain` deletes only a pair whose copy, read back in this run, has the inbox's sizes.
- Replay: a frame that is not a JPEG, or a session panic caught by the crate's guard, marks
  that pass `error` with the sentence ("frame N: …"), and the pass is excluded from
  percentages and counted beside them.
- An empty corpus is a sentence and exit 1, not an empty table.

## Testing

- **Rust** (`cargo test --features builder`): label parsing including nulls, cutting a run,
  refusing a label that does not add up, and outcome scoring, over a run invented with
  `synth` and a small in-memory reference.
- **Vitest** (`scripts`): the sync planner over fake listings (complete pair, litter, size
  mismatch, drain only after verify, local prune), SigV4 against AWS's published test vector,
  and the report renderer over a fixture `results.json`.
- No test uses the network or a real scan.

## What only the owner does

1. `npx wrangler r2 bucket create mtg-grimoire-scan-corpus --location weur`.
2. Create an R2 API token with object read and write on the two buckets, and set the three
   environment variables.
3. Run the first `pnpm scanner:corpus pull` (and `--drain` when satisfied), then
   `pnpm scanner:replay --save-baseline <name>`.

The baseline figures exist after step 3 and depend on scans having been sent. Everything
before it is built and proven on invented runs.

## Documentation owed

- `docs/reference/card-scanner.md`: a section on the replay beside *The synthetic
  evaluation*, and the tools table.
- `infrastructure/scan-worker/README.md`, *Reading the inbox*: the sync command and the
  corpus bucket replace the hand-run recipe as the usual path.
- `docs/agent/RUNNING_AND_VERIFYING.md`: the two commands.
