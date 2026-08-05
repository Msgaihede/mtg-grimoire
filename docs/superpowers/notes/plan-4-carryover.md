# Plan 4 carryover — decks & deckbuilder

Written at the end of Task 16, 2026-08-06. Everything in §1 is **measured in the running
app** over `scripts/cdp.mjs` against the live 116 590-card database; everything else is an
explicit deferral with its reason. Plan 5 should read §5 before it plans anything.

---

## 1. The live smoke — what was measured

`npm run tauri dev` with `--remote-debugging-port=9222`, a console recorder attached for the
whole session (`Log.entryAdded` **and** `Runtime.consoleAPICalled`), and every fixture seeded
through `node:sqlite` into `src-tauri/target/debug/data/mtg.db` while the app held it — **user
tables only**. The database was a genuine Plan-3 artefact converted to **schema v5** at the
first Task-11 launch: 547 MB, `auto_vacuum = INCREMENTAL`, `raw` a gzip BLOB, 0 decks, 0
collection rows, 0 wishes. Every seeded row was deleted afterwards; the user's tables are back
to `decks 0 / deck_cards 0 / deck_allocations 0 / collection_entries 0 / wishlist_entries 0`,
with `card_migrations` at the 2 569 rows the app itself wrote. The window was left at its
natural 1280×800.

### Deck lifecycle — the gallery stayed truthful throughout

| Step | What happened |
|---|---|
| Empty state | Says what a deck is, carries one primary action ("New deck") and the Scryfall/WotC footer |
| Create | Form opens with the caret in the name field; **24 formats** in seed order (`future` absent, `enabled_in_picker = 0`); submit opens the editor and hands the caret to it |
| Rename | Inline field, committed on Enter; `decks.name` and `updated_at` both moved |
| Cover from a card | Row menu → "Set as cover" → `cover_card_id` written; the tile paints `mtgimg://…/art/<id>/0` and credits **"Art by Christopher Rush"** |
| Duplicate | New deck `"… (copy)"`, cover carried, **cards copied** (2 rows), `is_built = 0`, `archived = 0`, no allocations |
| Archive / restore | Moves between "Your decks" and a separate collapsed **Archived** list, and back |
| Delete | Confirm names the deck in words — *Delete "Smoke Old School (copy)"? Its 3 cards go with it. Archiving keeps the deck instead.* — and the FK cascade took its `deck_cards` with it |

### The three add paths, and the grain

- **Panel click-to-add** — Sram, Senior Edificer into **Commander** with the "Add to" select
  on Commander; Sol Ring into **Main**.
- **Drag** (`Input.setInterceptDrags`, media type `application/vnd.pdnd`) — a search tile onto
  the Main column; a row from Main onto **Maybe**; a row onto the **remove tray**, which named
  the card while hovered (*"Remove Azorius Signet from deck"*) and removed it on release.
- **Keyboard** — focus the tile's Add button, Enter: the row appears and the caret stays on the
  button. **This is the third path, and it is not the detail pane.** The pane's printings rows
  offer *"Add … to collection"* and nothing else; adding to a deck from the pane is Plan 6's
  "add to open deck" (§4). The pane is how a *printing* is chosen, and it was used exactly that
  way to stock the collection for the allocation checks.

**The grain folds and the zones separate.** Two panel presses on the same Sol Ring printing
produced **one** `deck_cards` row at quantity 2 (two rows would have been the bug); Sram in the
`commander` zone stayed its own row; two keyboard Enters on Black Lotus folded to 2 the same
way. A drag from Main to Maybe moved the row rather than copying it.

### Validation, spot-checked against the live database

Every sentence read off the running validation panel, verbatim:

| Case | Sentence |
|---|---|
| 99-card Commander deck | `Commander decks are exactly 100 cards including the commander; you have 99.` — and it was the **only** issue on a real 100-card deck a card short |
| 2 × Sol Ring, Commander | `Commander decks are singleton: max 1 copy of Sol Ring; you have 2.` |
| Relentless Rats × 10 | **Silent** — the Singleton group listed Sol Ring and nothing else |
| Vintage, Sol Ring × 3 | `Sol Ring is restricted in Vintage: max 1 copy; you have 3.` — the spec §7 example sentence, cell for cell |
| Old School, Black Lotus × 2 | `Black Lotus is restricted in Old School: max 1 copy; you have 2.` — TRAP A across a second format |
| WU card under a mono-W commander | `Azorius Signet's color identity (WU) is outside your commander's (W).` |
| **TRAP B, live** | Serra Angel `lea` **and** `8ed` in one Old School deck → exactly one "Serra Angel is not legal in Old School."; **removing the `8ed` row left zero legality issues**, so the error was the printing's and not the card's |
| Orphaned row | Its own warning group, *"Cards that left the card database"*, with the reconciler's sentence quoted |
| Bracket | `Bracket ~1 · 0 game changers` under *"An estimate from what this app can see — a bracket is a conversation at the table, never a rule this deck can fail."* |

A `maybe` row is invisible to all of it: moving the Azorius Signet into the scratchpad dropped
the issue count 4 → 3 and the Cards figure 14 → 13.

### Allocations — owned, built, and the honest zero

1. Deck wants Sol Ring × 4, collection holds 3 → the row read **`3/4` · "You own 3 of 4"**.
2. **Adding to the collection did not move the number** until the deck's next zone write. This
   is the documented asymmetry, seen exactly as documented: the allocator runs *inside a zone
   write*, so a collection that grows leaves the deck stale until one happens. One stepper
   press produced `deck_allocations(deck 1, entry 1, 3)` and the row read `3/4`.
3. Deck marked **Built**; a second deck wanting the same card read **`0/1` · "You own 0 of 1"**
   — the built claim is subtracted from what everyone else can see.
4. Stepping the collection row to **0** made the first deck read **`0/4`** immediately, with the
   allocation row still saying 3: the read clamps with `min(allocation, entry.quantity)`, so
   shrinking is honest without re-allocating.

**Watch out for this while smoke-testing:** `deck_missing_to_wishlist` calls `allocate_deck`
first, so pressing "Send missing to wishlist" rebuilds (and here, emptied) the deck's
allocations as a side effect. Nothing wrong — but a row that vanishes from `deck_allocations`
between two probes probably went that way.

### Missing → wishlist, the EUR twin, and the needs-review chip

"Send missing to wishlist" on the 15-card deck answered **"Added 3 wishes — one per card, for
every copy you are short."** and wrote three **any-printing** wishes (`card_id` NULL, quantity
= the shortfall: 10 / 4 / 1). The button then went `aria-disabled` for that shortfall.

The wishlist header rendered both figures — `Still to buy (USD) $0.89 · 2 unpriced` and
`Still to buy (EUR) €0.64 · 2 unpriced` — and the **Needs review** chip appeared only once
the list had a flagged row, cycling on → *Not flagged* → off and narrowing the list to the one
flagged wish and back.

### The reconciler in anger

**The orphan half (needs a real ingest).** A `deck_cards` row and a wish were seeded on a fake
id and a Refresh was forced. Scryfall had rotated its bulk file that day, so this was a *real*
ingest — **93 s**, corpus still **116 590** — and `sweep_orphans` flagged both rows with the
exact sentence. In the editor the orphan renders from its denormalized name with no dead image,
its `needs_review` line under it, and a **Warning** group in the validation panel. There is no
separate "reconciled" banner: `collection:reconciled` drives cache invalidation only, and the
row's own sentence is the visible language.

**The fold half — THE design gate, live.** A real Scryfall merge (`e550b066… → 1958d96e…`,
Divide by Zero `stx 41`) was staged by deleting its `card_migrations` bookkeeping row, with:
two `deck_cards` rows in one zone (old id × 2, new id × 3), two `collection_entries` on the
same grain (old id × 2, new id × 1), and **a `deck_allocations` row pinned to the source
entry**. One forced Refresh — the "already up to date" path, which runs the migration poll
anyway — and:

- the two deck rows became **one row on the destination at quantity 5**;
- the two collection entries became **one entry at quantity 3**;
- **the allocation survived, repointed from the deleted source entry to the survivor, quantity
  intact.** The `ON DELETE CASCADE` fired over nothing.

The open editor refetched itself on `collection:reconciled` and read *"Divide by Zero … You own
2 of 5"* without a reload — the `["decks"]` invalidation, watched happening.

**Not reachable in this window:** the sweep's *clearing* arm. It runs only after a real ingest,
and the day's rotation had already been consumed by the flagging half; clearing `sync_meta` by
hand is out of bounds for a smoke that wants its numbers to mean anything. The clear is pinned
by `reconcile::tests` (`(0, 1)`, "and it clears again") and its statement pair ran in this very
ingest.

### Environment sweeps

| Sweep | Result |
|---|---|
| 1024 × 768 | `scrollWidth === innerWidth === 1024`; **no horizontal scroll**; charts wrap into a stats block, zone columns keep their own scrollers, the panel stays |
| 1280 × 800 | Same, no overflow |
| `prefers-reduced-motion: reduce` | Measured **in-session**: **0 of 3 568** elements had a live transition property and `document.getAnimations()` was empty. The control (no override) has **445** — the measurement discriminates |
| Keyboard | 14 consecutive tab stops in the editor, **every one named**, every focus ring 2px solid `oklch(0.75 0.12 85)` = `--color-accent`. A keyboard-only add works end to end |
| Escape stack | Validation popover → card pane → nothing, **one layer per press**, caret handed back to the chip and then to the row's name button |
| Console, whole session, both event families | **95 entries: 0 errors, 0 warnings, 0 CSP violations.** All `info`/`debug` — Vite HMR, the React DevTools notice, WebView2's lazy-image intervention. Live, not replayed: the timestamps track the session and each `location.reload()` shows up as a fresh `[vite] connecting…` |

### Timings worth writing down

| Measurement | Number |
|---|---|
| `deck_get`, 100-card deck, 2-entry collection | **12–14 ms** (14.1 ms cold) |
| `deck_get`, 100-card deck, 501-entry collection | **9.5–13.4 ms** |
| `validateDeck`, 100 cards, commander spec | **median 0.3 ms** (min 0.1, max 0.7, 20 runs) |
| Zone write **including `allocate_deck`**, 100-card deck, 2-entry collection | **2.7–3.0 ms** (8.1 ms cold) |
| Zone write **including `allocate_deck`**, 100-card deck, 501-entry collection | **4.4–5.3 ms** (9.5 ms cold) |
| Zone write, 1-card deck | **1.3–2.0 ms** |
| Forced Refresh, real ingest | **93 s** (`last_check_at` → `last_ingest_at`) |
| Forced Refresh, unchanged bulk + a migration to apply | **under 6 s** wall, click to observed effect |

**What that means for Plan 6.** `validateDeck` in a `useMemo` on every edit costs a third of a
millisecond — do not debounce it, do not memoize harder. The allocator's whole marginal cost
over a 100-card deck is **~2 ms** going from 2 to 501 collection entries; rebuilding it on
every zone write is not the thing to optimize, and the rebalancing UI can afford to re-run it
freely.

---

## 2. Findings — fixed here

Both were **pre-existing**, outside every task's files, confirmed live before a line was
written, and both are two-line fixes with mutation-checked tests.

1. **A stepper swallowed the card pane's Escape.** `CollectionTable.tsx` (two cells) and
   `SearchPage.tsx` (one) carried `onKeyDown={(e) => e.stopPropagation()}` so a control inside
   a clickable row would not also open the card. React attaches one listener at the root, so a
   synthetic press stopped there never reaches `window` — where `useDismissOnEscape` listens.
   Live: with the caret in a collection row's quantity box, **Escape did nothing**; from the
   row itself it closed the pane. Now `stopRowActivationKeys` (exported beside the Escape
   protocol it protects) stops **Enter and Space only** — the two keys a row acts on. Pinned by
   two `App.test.tsx` tests, both proven to fail against a blanket stop.
2. **The pane recorded itself as its own opener under StrictMode.** `CardDetailPane`'s mount
   effect read `document.activeElement` after having already focused the pane — and StrictMode
   runs a mount effect twice in development, so the second run captured the pane. `close()`
   then focused an element that was unmounting and the caret landed on `<body>`. Live: *every*
   Escape out of the pane, from every view, under `tauri dev`. Now the effect ignores an
   `activeElement` the pane contains. Pinned by a StrictMode-wrapped hand-back test, proven to
   fail without the guard. Production was never affected — which is why two plans of tests
   never saw it, and why every Plan-2/3 "focus handed back" claim measured in a dev window was
   measuring a broken path.

This also **closes plan-3 carryover Finding 3** ("Escape on the card pane hands focus to BODY
from a virtualized row"). It was not virtualizer recycling: it was StrictMode, in every view,
virtualized or not.

## 2b. Findings — ledgered, not fixed

1. **An any-printing wish prices from the *newest* printing, not the cheapest.**
   `wishlist.rs`'s join resolves an unpinned wish through
   `ORDER BY released_at DESC, id ASC LIMIT 1`, and the newest printing is very often a Secret
   Lair with no `usd` at all. Live: 2 of the 3 wishes the deck's missing→wishlist created read
   **"—"** while the cheapest printing of one of them (Sol Ring) is **$1.20** — the header's
   "Still to buy" ran low and counted them as unpriced. Plan 3 ledgered the same fact as a
   *rarity* symptom (its Finding 4); Plan 4 makes it a *pricing* symptom, because
   `deck_missing_to_wishlist` is the first thing in the app that creates unpinned wishes in
   bulk. `WishRow.unit_price_usd`'s own doc says "the cheapest way to satisfy this wish", which
   is what the field should mean and not what it computes. **Structural** — picking the
   cheapest *priced* printing per oracle card is a different (and more expensive) join, and it
   should be decided with the exporters in Plan 5, which will quote the same number.
2. **The docked search panel's result grid gets ~86 px at 1280 × 800** once the stats block is
   on screen, which is a third of one tile row. It scrolls and every control is reachable, and
   the 1024 pass is clean — but the panel's vertical budget is the one place the four charts
   cost something visible. Plan 6's polish call, alongside the collapsible-stats question.

---

## 3. Deferred out of Plan 4, with reasons

| Deferred | To | Why |
|---|---|---|
| Import/export, including deck text formats (Arena/MTGO/plain, `.dek` XML) | **Plan 5** | Spec §7's own split. This plan ships the seam: `deck_add_card` folds on the grain exactly as `collection_add` does, so an importer is a loop over an existing command; the export writers read `DeckDetail`. |
| Custom cover art (`cover_kind = 'custom'`, `cover_image_path`, `data/covers/`) + the licenses screen | **Plan 6** | Plan scope says so. The columns exist and stay NULL; the gallery's card-art path is complete without them. The licenses screen owes **three Apache-2.0 entries and one dependency surprise** — see §5. |
| "Add to open deck" from the *global* Search view | **Plan 6** | The editor's docked panel covers deck-building search; a global hover action needs an "open deck" affordance outside the Decks view. `DeckSearchPanel`'s add path is the reusable half. **The live smoke confirms the gap is real**: the card detail pane offers "Add … to collection" and has no deck path at all, from any view. |
| Hover previews with full card image / DFC flip animation | **Plan 6** | The detail pane already answers "what does this card look like" from every deck surface. |
| Allocation rebalancing UI (choosing *which* copies a deck reserves; over-subscription between built decks) | **Plan 6** | The greedy allocator is deterministic and honest about shortage. **It now has its numbers** (§1): ~2 ms marginal cost at 100 cards / 501 entries, so a rebalancer may re-run it as freely as it likes. |
| Re-allocating on *collection* writes (the "grow stale until a zone write" asymmetry) | **Plan 6** | Shrinking is honest immediately through the clamp; growing waits for the deck's next zone write. Closing it means a collection write that walks every built deck — a cross-feature decision, not a patch. |
| Any-printing wish pricing (§2b.1) | **Plan 5** | Same number the exporters will quote. |
| Panel grid height at 800 px (§2b.2) | **Plan 6** | Polish, with the collapsible-stats question. |
| `thumb` pre-warm; set-picker ranking; `role=grid` + roving tabindex; overlay focus containment; Cinzel dead `.woff`; `--chart-*` tokens | **Plan 6** | Plan-2/3 ledger, untouched by this plan's files. |
| Keyset pagination for deep offsets | **Still deferred** | A deck is hundreds of rows at most; nothing here pages at all. |
| The search **Owned**-chip semantics ruling (entry-exists vs copies > 0) | **Plan 5** | Plan-3's ledger routes it there; nothing in this plan changes the question. **Still open.** |

## 3b. Accepted floors — shipped deliberately, documented in the code

Listed here for visibility, not for action:

- **The missing→wishlist button's per-shortfall guard.** Pressing it again after the shortfall
  *changes* re-folds copies that are already wished. Closing it needs a wishlist read that
  `MissingWrite` deliberately excludes. Documented at the call site; the spent state releases
  correctly when the count moves.
- **Brawl accepts two partners.** The research doc is silent and Arena Brawl has no partner
  cards in practice; the engine is permissive by principle. One boolean in `RULES.brawl` after
  a doc refresh.
- **Two marginal MLD bracket hits** — Overlaid Terrain and Tomb of Urami, via the "all lands"
  clause (2 reachable of ~40 candidates). The advisory names the card, and dropping the clause
  loses no true positive.
- **The format select's loading state doubles as its error state**: if `format_specs` rejects,
  the picker sits on a permanently disabled "Casual".
- **Deck covers are not pre-warmed.** `prewarm_keys` is `grid`-only by its own doc, and a cover
  is an `art` crop — so the first paint of a gallery costs a cold fetch (~127 ms measured in
  Plan 2). Accepted; the empty frame is the placeholder.
- **PDH's TRAP C exemption** silences the pool answer for every commander-zone card under
  `paupercommander`, because the key cannot distinguish. Best available; documented.

---

## 4. Deferred *minors* — do not triage them here

The execution ledger `.superpowers/sdd/2026-08-05-04-decks-deckbuilder/progress.md` carries a
`minor (deferred)` line per task: `commanders.ts`'s spell-count sentence at 3 walkers, the
union-identity comment's rule attribution, `shouldFlipUp`'s 8 px panel inset, `DeckEditor`'s
over-claiming ref comment, Task 12's 1024 wrap residue, the `schema.rs:599` Limited-only
phrasing, and a dozen more. **The final whole-branch review owns that triage** — this document
points at the ledger rather than re-litigating it.

---

## 5. MUST-DO for Plan 5

1. **A physical card is EITHER a sideboard row OR a companion row, never both.** The engine
   counts the companion zone in copy limits *and* against `sideboardMax`, so an importer that
   writes a companion into both zones double-counts it into a false error. The Arena/MTGO deck
   formats list the companion in the sideboard, so the importer must **move** it, not copy it
   (research doc line 48; noted in `engine.ts` at `COPY_ZONES`).
2. **Deck import writes through `deck_add_card`, with its zone vocabulary**: `main`, `side`,
   `commander`, `companion`, `maybe`, and **zero removes** — there is no "quantity 0" deck row
   to write. It folds on `(deck_id, card_id, zone)` exactly as `collection_add` folds on the
   collection grain, so an importer is a loop, not a new write path. It also **refuses an
   orphaned row by design**: resolve the printing first.
3. **Arena set codes: `arena_code ?? code`.** The mapping already lives in `sets`; do not
   rebuild it, and do not assume the paper code.
4. **The export writers read the same `DeckDetail` the editor does** — one shape, one set of
   denormalized printing fields, `unitPriceUsd` already the blob's nonfoil `usd`. Do not add a
   second read.
5. **The imported deck's preview legality line is this plan's engine**, unchanged:
   `validateDeck(cards, spec)` over `formatSpecs()`. It costs 0.3 ms on 100 cards, so run it on
   every preview keystroke if you like.
6. **The Owned-chip semantics ruling is still open** (entry-exists vs copies > 0). Plan 3
   parked it, Plan 4 did not touch it, and the importer is the first thing that will create
   all-zero entries in bulk.
7. **Read CLAUDE.md's "Hard rules — decks" section first.** The three FKs and why exactly
   three, the zones enum, `format_specs`-is-data, deck price = the blob's nonfoil `usd`, and
   the pre-warm/sweep memberships are all things an importer would otherwise re-derive wrongly.
8. **Seed smoke fixtures into user tables only.** `cards` and `sync_meta` belong to the sync,
   and a hand-written row in either makes every later measurement a fiction. To exercise a
   merge, delete the `card_migrations` bookkeeping row and force a Refresh; to exercise an
   orphan flag, you need the day's real ingest.

## 6. For Plan 6's NOTICE / licenses screen

- `@atlaskit/pragmatic-drag-and-drop` **2.0.2** — Apache-2.0.
- `@atlaskit/pragmatic-drag-and-drop-auto-scroll` **3.0.0** — Apache-2.0.
- **`@babel/runtime` was silently promoted from a dev dependency to a production dependency**
  by pdnd (visible in the lockfile). It needs its own line, and someone should decide whether
  it needs to be there at all.
- The hitbox package was **deliberately not adopted** (no order column to need it) and the
  react-drop-indicator package was refused on CSP grounds — the indicator is ~30 lines of our
  own. Neither belongs in the NOTICE.
- **Bundle impact is unmeasured.** The core is 237 KB + 84 KB of on-disk ESM and only subpath
  imports are used, so the shipped cost is probably a fraction of that — but nobody has looked.

---

## 7. Retraction — two plans of CDP claims, re-scored

`scripts/cdp.mjs` had two silent defects, both found and fixed inside this plan (Task 11).

- **`media` never worked.** WebView2 accepts a features-only `setEmulatedMedia` and ignores it,
  and the override dies with the socket — so every `media prefers-reduced-motion reduce`
  followed by a separate `eval` measured a page with no override on it at all. **Every
  "reduced motion verified over CDP" claim in Plans 2 and 3 is retracted**: they measured
  nothing. The command now sends `"screen"` with the feature and evaluates an expression
  in-session, and the pass in §1 is the first real one (0 of 3 568 elements moving, against a
  445-element control).
- **`size` was suspected of the same defect and is not.** `setDeviceMetricsOverride`
  empirically **survives** detach on this WebView2, so the Plan-2/3 responsive claims made at
  1024 px were **real** and stand. What it cannot do is reset: `clearDeviceMetricsOverride` is
  accepted and does nothing, so a run must end with an explicit natural size.

Also worth keeping: **auto-scroll during a drag was forced live for the first time in Task 15**
(an overfilled column, 0 → 408 px). Tasks 13 and 14 could not make the columns overflow at
either width and said so.
