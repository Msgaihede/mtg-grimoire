# The Tags page, driven in the shipped window

Its own file rather than a section of [decks-live-findings.md](decks-live-findings.md), which is
763 lines about a different surface. Same contract: **every figure keeps the date and the build
it was taken on**, and what is still broken is written down beside what was fixed.

Twelve tasks shipped this page over three days against a Storybook fake with a handful of tags and
a 43-card corpus. This is the first time any of it ran.

## The run

`npm run tauri dev` from the `tagger-page` worktree, **debug build**, 2026-08-20, window
1920×1080, against a copy of the dev database (116,700 cards, corpus synced the same morning).
Rust figures marked *native* were taken with `node:sqlite` against the same file while the app
held it, so they carry no debug-build multiplier; everything else does, and a debug figure in this
repo has run ~8× slow before.

**The taxonomy this was measured on**, read out of the database after the ingest below:

| | |
| --- | --- |
| `art_tags` | 11,530 |
| `art_tag_parents` | 19,692 |
| `art_taggings` | 475,795 |
| `art_tag_illustrations` (the closure) | **952,729** |
| art roots | **3,215** |
| oracle roots | 927 |
| roots the rail draws on `Both` | **4,142** |
| closure weights | `median` 895,123 · `strong` 28,408 · `very_strong` 17,418 · `weak` 11,780 |
| widest art slug | `plane`, 38,144 illustrations |
| `dog` | 439 illustrations — the figure the docs quote, confirmed |

## The art tag ingest, timed — the measurement nobody had

`art_tags_refresh(force: true)` with the watermark row cleared first, so it really downloaded and
really rebuilt. Phase boundaries came off `art-tags:progress`:

| phase | |
| --- | --- |
| `checking` (listing + ETag) | 346 ms |
| `downloading` | **251 ms** for 12,559,459 bytes |
| `ingesting` | **58,268 ms** |
| **total command** | **58,900 ms** |

**Debug build.** The ingest is ~99% of it: parse 12.5 MB of gzipped JSONL, write 11,530 tags,
475,795 taggings and 952,729 closure rows. Re-running it produced byte-identical counts, so the
ingest is idempotent over a rebuild.

The startup `refresh_if_due` had already done this once before the window was driven — a cold
first launch does fetch it, unprompted, exactly as designed.

## Gate 1 — the unvirtualised rail against 3,215 real art roots

Task 9's reviewer allowed shipping `TagTree` unvirtualised **on condition this was measured**.
It was. **Verdict: keep it. No cap and no "Show all" row.**

| | |
| --- | --- |
| `tag_children("both", null)` | **180 ms**, 4,142 rows (art alone 133 ms / 3,215; oracle 47 ms / 927) |
| nav click → 4,142 rail rows painted, cold | **673 ms** |
| …warm (query cached), three runs | **639 / 627 / 575 ms** |
| rail scroll height | **115,988 px** against a 716 px viewport — 162 screens |
| scrolling it, 150 frames at 700 px/frame | p50 **6.9 ms**, p90 7.0, p99 8.2, **max 10.0** |
| frames over 33 ms | **0** |
| jump to the end | **7 ms** |

So the rail **scrolls at full frame rate** — the thing virtualisation would have bought is the
thing that was already fine, which is the reviewer's argument confirmed rather than merely
allowed.

**What it does cost is one long task.** `PerformanceObserver` recorded a single **622 ms**
`longtask` covering the whole click-to-paint, i.e. the window is unresponsive for about
six-tenths of a second on entering the page, once. A second 317 ms task follows ~790 ms later
(the wall and its facets). Warm and cold are within 100 ms of each other, so this is React
rendering 4,142 rows, not the query.

**Open, deliberately not fixed:** 622 ms of blocked input on one navigation, in a debug build
with React in development mode. It is a first-paint cost paid once per visit, against a rail that
then behaves perfectly; the named cheap fix (a cap plus a "Show all" row) would trade it for a
rail that no longer shows the reader their taxonomy. **If it is ever revisited, measure a release
build first** — nobody has, and this figure is the one most likely to be a development-mode
artefact.

## Gate 2 — the art weight floor, and why the written-down fix was a trap

Task 11 measured a floored art lookup at 25.6 → 91.3 ms **on an invented taxonomy**, wrote down
`(slug, weight)` as the fix, and deferred it pending a real one. Both halves of that turned out
to need correcting.

**The regression is real at real breadth.** Native, against the collapsed count `search.rs`
actually runs (`… GROUP BY coalesce(c.oracle_id, c.id) LIMIT 5001`):

| slug | floor off | floor on | |
| --- | --- | --- | --- |
| `dog` (439 illustrations) | 315 ms | **882–1,147 ms** | 2.8–3.6× |
| `plane` (38,144) | 722–782 ms | **1,177–1,319 ms** | ~1.7× |

`EXPLAIN QUERY PLAN` says exactly why: unfloored,
`SEARCH ati EXISTS USING COVERING INDEX idx_art_tag_illustrations_slug (slug=? AND illustration_id=?)`;
floored, `SEARCH ati EXISTS USING PRIMARY KEY (illustration_id=? AND slug=?)`. `weight` is not in
the slug index, so the floor loses it and every one of 116,700 cards takes a random seek into a
952,729-row `WITHOUT ROWID` primary key instead of a cached probe into one slug's bucket.

**`(slug, weight)` — the fix that was written down — is ten times worse than doing nothing.**
Built and forced with `INDEXED BY`: `dog` floored went from ~900 ms to **3,180–3,367 ms**, because
on a `WITHOUT ROWID` table that index expands to `(slug, weight, illustration_id)` and can only
seek the slug before scanning the whole bucket. Left to the planner it is simply never chosen.
`(slug, illustration_id, weight)` *is* the right index — forced, `dog` floored fell to **313 ms**
and `plane` floored to **558 ms** — but SQLite will not pick it without `ANALYZE`, preferring the
primary key even when the narrow index is dropped. **Do not land either index.**

**The actual fix was the query shape, and it is landed.** An include is now
`c.illustration_id IN (SELECT … WHERE slug = ?)` rather than a correlated `EXISTS`. The closure is
read once for the slug and `cards` is driven through `idx_cards_illustration` (v20's) instead of
being scanned:

| slug | floor | `EXISTS` | `IN` |
| --- | --- | --- | --- |
| `dog` | any | 315 ms | **8 ms** |
| `dog` | strong | ~900 ms | **8 ms** |
| `plane` | any | 725 ms | **614 ms** |
| `plane` | strong | 1,284 ms | **752 ms** |

**The floor is now free**, so gate 2 is settled and no migration rung is owed. The *exclude* arm
stays `NOT EXISTS` on purpose: 4,977 printings have no `illustration_id`, and `NOT IN` would turn
their `NULL` into "no" and drop them from a result the reader only asked to have no dogs in.

**Through the app, before and after, both debug builds and both driven the same afternoon** —
the "one measurement owed" the controller notes asked for, and what the fix did to it. `total`
was identical on every row afterwards, which is the check that matters:

| request | `EXISTS` | `IN` | total |
| --- | --- | --- | --- |
| plain browse | 52 ms | 44 ms | 5,000+ |
| text `dog` | 12 ms | 16 ms | 425 |
| oracle tag `removal` | 145 ms | **35 ms** | 5,000+ |
| art tag `dog` | **1,679 ms** | **17 ms** | 747 |
| art tag `dog`, floored | **2,292 ms** | **23 ms** | 737 |
| art tag `plane` | 1,287 ms | **615 ms** | 5,000+ |
| art tag `plane`, floored | 1,361 ms | **801 ms** | 5,000+ |

And the control the gate is about: **"Hide background details" went from 1,193 ms to 68 ms**
press-to-caption, same 701 → 692 cards.

## The rail was printing tag names one pixel wide

**The worst thing in the pass, invisible to every test, and fixed.** A rail row is a disclosure,
the name, the namespace mark and the reach — and the name is the only one of the four that
shrinks. Measured at 1920×1080 with the real taxonomy in, rail scroller 239 px, row button
199 px:

| row | name box | name needs | reach box |
| --- | --- | --- | --- |
| `dog` (picked) | **14 px** | 24 px | 112 px |
| `dog person` | 42 | 72 | 106 |
| `dogmeat` | 42 | 57 | 106 |
| `dog brother #1` | 55 | 90 | 92 |

The reach phrase took **92–112 px of a 199 px row** — 46–56% — because `illustrations` is thirteen
characters repeated identically down every row. Over the **24 widest roots**, which is what the
page opens on before anybody types, **23 of 24 names were clipped and five drew in a 1 px box**:
`plane`, `humanoid`, `planar origin` and `location` rendered no name at all.

Two candidates, both tried live in the running window in one pass:

| | names clipped, of 24 |
| --- | --- |
| shipped: `w-64`, unit shown | **23** |
| `w-72`, unit shown | 17 |
| `w-80`, unit shown | 3 |
| `w-64`, figure only | 3 |
| **`w-72`, figure only** | **0** |

Landed as the pair: the rail is `w-72` (+32 px, of a 1660 px wall) and the visible reach is the
figure alone (`tagReachFigure`). **The unit is not lost** — the row's accessible name still reads
"plane, art tag, 38,144 illustrations", so nothing a screen reader hears changed, and the
namespace mark sits two boxes left whenever the box is on `Both`.

Re-driven after landing, same window: **0 of 24 clipped**, `plane` 35/35 px, `triggered ability`
101/101, and the first row's accessible name still `plane, art tag, 38,144 illustrations`.

## Settings promised a way back that did not exist

Hiding a tag raises a live line reading *"Hidden tags, and anything filed under them, come back
from Settings."* **Settings had no such list.** Its headings were Updates, Version history,
Prices, Errors, Local cache, Not here yet, Clear data. `tags_muted` and `tag_unmute` were wired
through Rust and through `ipc.ts`, the Storybook fake had handlers for both, and one of them even
carries the comment "for the Settings list that gives it back" — and no component in the app ever
called either. **Hiding a tag was a one-way door out of the UI.**

Fixed: `HiddenTagsPanel`, above the error log, with `useHiddenTags`. It lists the stored slug and
its taxonomy (a slug can be hidden in both, and they are different tags), gives one back by
`(namespace, tagId)`, and invalidates `tag-children` and `tag-search` so the rail has it again
without a reload.

Driven end to end afterwards: hiding `cloud` took the rail 4,142 → **4,141** roots; Settings then
listed one row, `cloud · Art · Show again`, named `Show again — cloud, art tag`; pressing it
emptied the list to its "You have not hidden any tags" state; and the rail came back to **4,142**
with `cloud` on it, **with no reload**.

## The search hit list was inheriting the tree's disclosures

`expanded` is keyed on a path, and a hit's path was byte-identical to the same tag's path as a
root of the tree. With `cloud` expanded in the tree, typing `cloud` drew its five children inline
**and then listed three of them again** as hits of their own a few rows down — `cloudy sky`,
`cloud figure` and `pink cloud`, twice each, with nothing saying why. In the tree a duplicate is
explained by the two headings above it; in a flat list of hits there is no heading to explain
anything. Fixed with a path prefix on the hit list; a reader can still open a hit, they just have
to ask. Re-driven: with `cloud` expanded in the tree, the hit list draws it as `Show tags under
cloud` with no inline children and every tag appearing exactly once.

## What the checklist found working

All of it, and each of these was driven rather than reasoned about:

- **Right-click a tile** → the five-row card menu, inside the viewport, no page overflow.
  **Escape closes it** (`cdp.mjs key`; the first read after was pre-flush and said otherwise —
  the documented trap, not a defect).
- **Shift+F10 on a focused tile** → the same five rows, anchored at the trigger's bottom-left,
  focus moved into the menu. This needed `cdp.mjs` to learn two keys; see below.
- **Add to → Deck** writes: the deck went 0 → 1 cards.
- **Click a tile** → the card detail pane (Formats, Printings).
- **Drag a tile to the sidebar** works — the Wishlist entry raised its ring and took the card.
  The **Decks** entry is inert, correctly: it needs an open deck (`useSidebarDrops`, "Open a deck
  to drop cards into it"), and leaving the editor clears `openDeckId`. **Verified identical on
  the Search page**, so it is app-wide and not this page's.
- **ctrl+wheel** → the wall zoomed on its own key (`tags: 2` with `search` still 1), tiles 170 →
  340 px, and the badge read **175%** at exactly 8 px in from the *Tag results* scroller's top and
  right — the section's corner, not the window's.
- **Grid ⇄ table**, and **sorting a header** (`Name=ascending`).
- **A colour filter narrows without dropping the chips**: 701 → 221 cards, `dog` still on. The
  facet counts were already tag-aware — "Green — 221 printings" against 24,534 unfiltered, which
  is Task 11's work, live.
- **An exclude chip**: the label flips to "not dog, art tag, excluded. Press to include." and the
  count goes to the complement.
- **"Hide background details"** changes the count: 701 → 692 cards, **1,193 ms** press-to-caption
  cold, 567 ms warm (debug build). See gate 2 for what that cost was made of.
- **A multi-parent tag appears under both parents**: `cloudy sky` under `cloud` and under `sky`.
- **Muting** took `cloud` off the rail (4,142 → 4,141 roots) and raised the status line.
- **The console stayed clean** for the whole pass and `error_log` was empty at the end.

## The two behaviour questions, answered by looking

**Muting a category taking its whole subtree with it does not read as broken.** The row's own menu
says `Hide this tag and the tags under it` *before* the press — it names the consequence — and the
rail then raises "Hidden tags, and anything filed under them, come back from Settings." Muting
`cloud` correctly left `cloudy sky` on the rail under its second parent `sky`, and `pink cloud`
— whose only parent was `cloud` — was still found by searching for it. The one thing wrong with
the recovery story was that Settings had nothing in it, which is fixed above.

**The shared `expanded` set was not wanted.** See its section.

## Two things this pass changed about the harness

- **`cdp.mjs key` learned `F10` and `ContextMenu`, and `--shift` now applies to `key`.** Without
  them the keyboard route into a context menu could not be driven at all — the handler reads
  `e.shiftKey` off the browser's own modifier state, so a synthetic `dispatchEvent` proves
  nothing, and "a menu only a mouse can open is a menu half the readers do not have" would have
  gone unchecked.
- **A tile clicked with the detail pane closed loses focus to `<body>`**, because the pane opening
  re-flows the wall (35 tiles → 25) and the virtualiser rebuilds the element that had it. Clicking
  a second tile with the pane already open keeps focus. Not chased: the wall and the pane are
  shared with the search view and this is not the Tags page's code. **Open.**

## Still open

1. **622 ms of blocked input** on entering the page, debug build (gate 1). Measure a release build
   before doing anything about it.
2. **Focus falls to `<body>`** when a tile click opens the detail pane, because the wall re-flows.
   Shared with the search view.
3. **The widest motifs are still the slowest thing on the page** even after the `IN` rewrite —
   615 ms through the app on `plane` (38,144 illustrations), against 17 ms on `dog` (439),
   because a wide slug materialises tens of thousands of illustration ids into a list. Nobody has
   looked at whether the facet side's bitset could serve the page query too.
4. **`3,219 art roots` is written in nine places and the live count was 3,215** (and 4,142 on
   `Both`), both on 2026-08-20. Not chased — the file regenerates daily, so any figure is a
   snapshot and each of those sites carries its date. Worth knowing before quoting one.
