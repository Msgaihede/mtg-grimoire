# Plan 3 carryover — collection & wishlist

Written at the end of Task 14, 2026-08-05. Everything here is either **measured in the
running app** against the live 116 590-card database, or an explicit deferral with its
reason. Plan 4 should read the MUST-DO list at the bottom before it plans anything.

---

## 1. The live smoke — what was measured

`npm run tauri dev` with `--remote-debugging-port=9222`, driven over CDP with the newly
checked-in `scripts/cdp.mjs`. The database was a genuine Plan-2 artefact: schema v4,
`auto_vacuum = NONE`, `raw` still TEXT, 2.02 GB, 0 collection rows, 0 wishlist rows. Every
row seeded or added during the smoke was deleted afterwards; `data/` is back to empty.

### Quick-add, from all three surfaces

| Surface | Landed as | Time |
|---|---|---|
| Art tile (search grid) | `m10 146` nonfoil NM ×2 | 1 107 ms (first, cold) |
| Table row | `sld 901` **foil** NM ×1 — the popup offered only the finishes that printing has | ~800 ms |
| Printings row (card detail pane) | `sld IFIYW-2` nonfoil **MP** ×1 | ~800 ms |

**The grain, exercised for real.** Re-adding the same printing/finish/condition folded
(2 + 2 = 4, still one row). Switching to foil made a new row; foil + LP made a third. Five
rows over three `card_id`s, every one at the printing/finish/condition asked for.

### Totals, hand-checked against the `prices` blob

Five rows, checked term by term:

```
m10 146 nonfoil ×4 × usd 1.73       =  6.92     × eur 1.38      =  5.52
m10 146 foil    ×2 × usd_foil 12.69 = 25.38     × eur_foil 6.61 = 13.22
m10 146 foil LP ×2 × usd_foil 12.69 = 25.38     × eur_foil 6.61 = 13.22
sld 901 foil    ×1 × usd_foil 13.87 = 13.87     × eur_foil 20.09= 20.09
sld IFIYW-2 nf  ×1 × usd 2.37       =  2.37     × eur 4.54      =  4.54
                              total = $73.92                    = €56.59
```

The header read **exactly** `$73.92` / `€56.59`. `cards.price_usd` for `m10 146` is `1.73`;
summing *that* over the eight copies would have given `$13.84`. **The per-finish lookup is
proven, and `price_usd` is proven not to be what is summed.**

**Etched.** An etched `sta 19` Opt added: priced **$4.13** (`usd_etched`) in USD, and the
EUR total gained a **`1 unpriced`** counter rather than a number — `eur_etched` does not
exist upstream, exactly as the hard rule says.

### The stepper — zero keeps the row

One press of `−` on the last copy of `sld IFIYW-2`:

- quantity `1 → 0`, **the row stayed**;
- the row gained `text-dim`;
- `−` became **disabled** (no back door below zero);
- a **Remove** button appeared, and only at zero;
- the header went `Cards 10 → 9`, `Unique 3 → 3`, `$73.92 → $71.55`, `€56.59 → €52.05`
  (−2.37 / −4.54 — the row now contributes nothing but is still an entry).

`collection_entries` confirmed `quantity = 0` with the row intact. Pressing **Remove**
deleted it and dropped `Unique` to 2 with the totals unchanged. Round trip: **907 ms**.

### Filters and sorting

| Action | Cards | Unique | USD | Reset badge |
|---|---|---|---|---|
| unfiltered | 10 | 3 | $75.68 | — |
| finish = Foil | 5 | 2 | $64.63 | 1 |
| + colour = Red | 5 | 2 | $64.63 | 2 |
| **Reset all** | 10 | 3 | $75.68 | — |

List and summary agreed at every step and cleared together.

**Natural collector-number order, live.** Six `9ed` rows seeded on purpose, sorted by set:

```
9ED 1 · 9ED 1★ · 9ED 2 · 9ED 2★ · 9ED 10 · 9ED 100
```

A lexical sort would have given `1, 10, 100, 1★, 2, 2★`. `1★` sits directly after `1`,
which is what the plan's table says it must.

### The wishlist

Two wishes added from the search grid: one **any printing** (`card_id NULL`) and one
**pinned** (`sta 42`, quantity 4).

- `Any printing · Nonfoil` → **Fulfilled** (five nonfoil copies held);
- `STA · 42 · Nonfoil` → **0 of 4 owned**, `$15.44` (`4 × $3.86`);
- header `Wishes 2 · Still to buy $15.44`.

**The fulfilled chip's three states:** any (2 wishes, $15.44) → Still missing (1, $15.44) →
Fulfilled (1, $0.00) → any (2, $15.44).

**Badges in search**, live and in both layouts: `×1 / 1 in your collection` on `sld 901`,
`×8 / 8 in your collection` on `m10 146` (4 nonfoil + 2 foil NM + 2 foil LP — finish-blind
copies, as `CardSummary.ownedQuantity` documents). `On your wishlist` on *every* Lightning
Bolt printing, which is the any-printing wish being keyed on the oracle card. The **Owned**
chip's three states over 72 printings: 72 → 2 (Owned) → 70 (Missing) → 72.

**"Any printing" was enabled**, not disabled — see finding 6 below.

### The forced Refresh, mid-browse

Three real syncs were run. Phases and timings (debug build):

| Sync | What it was | Phases | Total |
|---|---|---|---|
| 1 | Plan-2 database, first Plan-3 sync | checking 0.5 s · downloading 1.5 s · **ingesting 4.0→85.8 s** · sets 85.8 s · **compacting 90.8 s** | **99.2 s** |
| 2 | nothing new | checking only, "Already up to date" | **1.8 s** |
| 3 | forced re-ingest (etag cleared) | checking · downloading 0.4 s · **ingesting 2.9→83.5 s** · **reclaiming 83.5→89.6 s** · sets 89.6 s | **91.6 s** |

- **`compacting` appeared exactly once**, on the Plan-2 database, and never again. The
  conversion is once per database, as designed.
- **`mtg.db`: 2 018 877 440 → 547 807 232 bytes** (−72.9 %). `auto_vacuum` `0 → 2`,
  freelist 243 187 → 500 pages. Search still answered afterwards (`lightning` → 411 FTS
  hits), so the mandatory `create_fts` after the `VACUUM` did its job.
- **`raw` is now a BLOB**: `typeof(raw) = blob`, **622 460 391 → 235 058 435 bytes**
  (**37.8 %** of the original — the brief's "roughly a quarter" was optimistic; CLAUDE.md's
  "~236 MB" was right to the megabyte).
- **Sync 3 proves the post-swap `incremental_vacuum`**: a full re-ingest that replaced every
  row left the file at 547 655 680 bytes (−0.03 %) with **freelist 0**.
- **Searches stayed live throughout.** 20 timed searches spread across sync 1, every one
  returning the right count (`Island` → 2,109; `Bolt` → 146; `Counterspell` → 75) with no
  stall. The header's card count updated `116,568 → 116,590` mid-run.
- **Collection edits during the ingest: 10 `collection_add` calls, 4–7 ms each (median 6),
  0 `BUSY` refusals, no toast.** The brief expected "within a second". This is the chunked
  ingest's whole point, measured.

### Orphan reconciliation

An entry pointing at a card id Scryfall has never heard of, then a sync:

- flagged with a sentence — *"This printing is not in the card database. It may have been
  removed by the last card-data sync, or it may return with the next one."*;
- a banner: *"Needs review: 1 entry names a printing that changed or left the card
  database. [Show them]"*;
- **still listed** (`XXX · 999 · Nonfoil · NM`), **still counted** (Cards 29), value `—` and
  counted as unpriced. Never deleted.

Repointing the entry at a card that exists and syncing again cleared the flag
(`needs_review = null`), and the app's own log recorded both directions:
`collection review: 1 rows flagged, 0 cleared` then `0 rows flagged, 1 cleared`.

### Pre-warm

`image_cache` grid rows **2 298 → 2 299** within two seconds of the Collection view's first
paint — the one owned printing that had never been rendered as art (`sld IFIYW-2`, added
from the pane's printings list). Owned cards only; nothing else moved.

### Escape stack, viewport, motion, keyboard, console

- **Escape**: one layer per press. Popup → pane → view, with focus handed back to the
  printings-row Add button after the first press.
- **1024 px and 1280 px**, Collection and Wishlist: no horizontal page scroll, no element
  overflowing a `overflow: visible` box.
- **`prefers-reduced-motion: reduce`**: every transition in both new views is neutralised.
- **Keyboard-only**: 22 tab stops, all named; the focus ring is `solid 2px
  oklch(0.75 0.12 85)` — the gold accent.
- **Console: 0 errors, 0 warnings, 0 CSP violations, 0 React warnings** across the entire
  session. The only five entries are WebView2's lazy-image intervention notice, Vite's two
  HMR lines, React DevTools' banner, and the recorder's own attach line.

### The eight `soon.jpg` printings (carryover item 8) — **verified, and healing**

They are now **four**. `plst UMA-149` (Sparkspitter) recovered completely between
2026-08-04 and 2026-08-05: `image_status` `missing → highres_scan`, and its `image_uris`
now carry real `cards.scryfall.io` URIs *with* a `?1785827111` cache-buster. It is fetchable
today with no code change. The remaining four are `mic 55`–`58`, all still `missing` and
still `errors.scryfall.com/soon.jpg` in every slot. A query for
`image_uris NOT LIKE '%?%'` returns exactly those four.

**Conclusion: the improve-path is automatic and requires no feature.** Do not build one.

---

## 2. Findings from the smoke (none blocking)

1. **The needs-review banner outlives the sync that cleared it, by one navigation.** The
   flag was cleared in the database the moment the sweep ran, but the banner stayed until
   the view was left and re-entered. `collection:reconciled` is emitted and still has no
   listener (Task 8's note). One `queryClient.invalidateQueries` in a listener closes it.
2. **Six elements still transition under `prefers-reduced-motion`** — the five sidebar nav
   buttons and **Refresh data**, all carrying a bare `transition-colors duration-150` with
   no `motion-reduce:` guard. Plan 2 chrome, not Plan 3's views, and a 150 ms colour
   crossfade is the mildest motion there is; but the direction doc's rule is unconditional.
   One `motion-reduce:transition-none` per site, in `AppShell.tsx` and `Ribbon.tsx`.
3. **Escape on the card pane hands focus to `BODY`**, not to the row that opened it, when
   the pane was opened by clicking a virtualized table row. The popup rung hands focus back
   correctly. Likely the row being recycled by the virtualizer between open and close —
   the same slot-recycling class Task 10 ledgered.
4. **An any-printing wish resolves through the newest printing, not the cheapest.** Live:
   the any-printing Lightning Bolt wish rendered `Rarity: Uncommon` while the pinned `sta 42`
   wish rendered `Rare` — two different printings of the same card. Task 12 ledgered the
   pricing consequence ("Still to buy" runs low); this is the same fact showing up in the
   rarity gem.
5. **The stepper's quantity persists across adds in one popup session.** Adding 2, then
   switching finish and adding again, adds 2 again. Defensible (it is the same popup), but
   it is how the smoke ended up with `foil ×2` when it meant `foil ×1`.
6. **`cards.oracle_id` is never NULL in live data** — 0 of 116 590 rows, all 81 reversible
   printings included. Corrected across the codebase in Task 14; see §3.

---

## 3. What Task 14 changed

| Fold | What landed |
|---|---|
| Non-fatal startup staging DROP | `prepare_database` logs and continues; only `migrate` may stop a launch. `a_launch_survives_a_staging_drop_it_cannot_carry_out` pins it. |
| Wrong ETag rationale | The residue's life is bounded by the **throttle window**, not by Scryfall rotating the bulk file — the ETag is written only after a *successful* ingest. Doc + test doc corrected. |
| Two stale "44 s" claims | `images.rs`'s `try_lock` rationale and `search.rs`'s two-connection test doc: the ingest holds the write connection for one 2 000-row batch, not for a whole run. |
| `rebuild_fts_if_pending` transaction | The drop/create/populate and the marker clear are now one transaction, so a failed repair cannot leave search **emptier** than the desynced index it replaced. `convert_to_incremental`'s own `create_fts` deliberately stays outside one: its `VACUUM` has already renumbered the rowids, so there is no good earlier state. |
| Stale "9 of 10 waiters" | Replaced with the real evidence: **10 of 10** waiters timed out without `RECLAIM_YIELD`, 10 of 10 get in with it. The property was false as shipped, not merely fragile. |
| Grain-fence overclaim | `card_id` and `lang` were the two terms nothing varied. A German copy and a second card were added; the count went 11 → 13, and "every term" is now literally true. |
| Dangling-escape comment | It is **not** a prepare error (the pattern is bound) and SQLite's `LIKE` treats a trailing escape as no-match. The two `found("\\")` lines are recorded behaviour, not fences; the fences are `%` and `God_Pharaoh`. |
| `escape_like` → `filters.rs` | With `LIKE_ESCAPE`, `pub`, so the next `LIKE` does not invent a second one. |
| `valid_quantity` deduped | `pub(crate)`, and `wishlist::set_wish_quantity` now uses it with `"wishlist quantity"` — one wording of the refusal. |
| The oracle_id false belief | Corrected in six places: `card.rs` (doc + test doc), `schema.rs` (module header + the `wishlist_entries.oracle_id` comment), `ipc.ts`, `CardDetailPane.tsx` (the printings-query gate), `AddToCollection.tsx` (prop + the disabled "Any printing" chip) and its test. Every gate stays — the column *is* nullable — but each now says it fences a type, not a card. |
| `store_failures` consumer | `SyncStatus.imageStoreFailures` (`u64`, never `Option` — it is an atomic, so the full disk that makes the rest unreadable cannot take it away), mirrored in `ipc.ts`, appended to the ribbon's tooltip when non-zero. Verified live on the wire. |
| `useDismissOnEscape` doc | The "does not generalise to two inner peers" paragraph. |
| CDP flow | **Checked in** as `scripts/cdp.mjs` rather than described — four sessions had rebuilt it from scratch. CLAUDE.md gains a "Verifying UI in the real app" section pointing at it. |
| CLAUDE.md | Image-cache rules, a new **Hard rules — user data** section (grain, zero-keeps, finish-aware fulfillment, `needs_review` semantics, per-finish pricing, oracle_id), the three `Data & sync` amendments, and every measured figure the smoke corrected. |

---

## 4. Deferred out of Plan 3, with reasons

| Deferred | To | Why |
|---|---|---|
| `decks`, `deck_cards`, `deck_allocations`, `format_specs` | **Plan 4** | The deckbuilder is a plan of its own; allocations are meaningless before decks exist. |
| Import/export (CSV/Excel/deck-text) | **Plan 5** | Plan 3 shipped the seam: `conditions.ts`'s synonym table, `condition_original`, and a `collection_add` that upserts on the grain. |
| Settings screen, "Compact database", image-cache budget/eviction, "Clear cache" | **Plan 6** | The screen does not exist. The compaction it would trigger already has a home (`maintenance::convert_to_incremental`); the button becomes a second caller that also clears `sync_meta.auto_vacuum_error`. |
| `thumb` pre-warm | **Plan 6** | No view renders a `thumb`. |
| Deck-card pre-warm | **Plan 4** | No deck tables. It joins the pre-warm's `UNION` when they land. |
| Keyset pagination for deep offsets | **Still deferred** | Nothing in Plan 3 pages deep enough to feel it — a collection is thousands of rows, not 116 k. |
| Set-picker ranking, `Printing`'s four unrendered fields, `role=grid` + roving tabindex, overlay focus containment, Cinzel dead `.woff`, `--chart-*` tokens | **Plan 6** | Ledgered by Plan 2's review; untouched by Plan 3's files. |
| Non-English printing tracking beyond `lang` | **Out of scope** (spec §1 non-goals) | `lang` is stored per entry and part of the grain, so the model is ready; `all_cards` is 5× the download. |
| Same-day migration chains | **Plan 4 or 5** | `card_migrations.performed_at` is date-only, so chains performed on one day keep API order. A fixpoint loop around `apply` (~5 lines) closes it. Consequence today: a permanently flagged row with a slightly wrong promise. |
| Search's **Owned** chip: entry-exists vs. badge copies>0 | **Backend decision, Plan 5** | An all-zero entry passes `owned:true`, shows no badge, and is absent from `missing` too. Needs a semantics ruling, not a patch. |
| Wishlist needs-review **filter** | **Plan 4/5** | `WishlistQuery` has no `needsReview` where `CollectionQuery` does. The band renders; the chip needs backend. |
| Grading cannot be cleared (`Some("")` is a silent no-op) | **Entry editor** | Whoever builds the editor must know. |

---

## 5. MUST-DO for Plan 4

1. **`deck_allocations.collection_entry_id` is the one place an enforced foreign key
   belongs** — and the *only* one in the schema. Both sides are user data, neither is
   dropped by a sync. Everything referencing `cards.id` stays a soft reference with the
   printing denormalised beside it; a declared `REFERENCES cards(id)` aborts every sync.
2. **`game_changer: true` still has no fixture.** The Commander bracket estimate needs one
   before it can be tested at all.
3. **Deck cards join the image pre-warm's `UNION`** the moment `deck_cards` exists
   (`images::prewarm_collection`, which today unions collection + wishlist at `grid` only).
4. **Read the new "Hard rules — user data" section in CLAUDE.md first.** The grain, the
   zero-keeps ruling, finish-aware fulfillment and `needs_review`-as-a-sentence are all
   things a deck allocator will otherwise re-derive wrongly.
5. **Any write to `collection_entries` goes through `add_entry`/`update_entry`.** They are
   the only paths with grading canonicalization and the tradelist clamp; a direct `INSERT`
   reintroduces identity forks.
6. **Verify in the running app, with `scripts/cdp.mjs`.** Every UI task in Plans 2 and 3
   found something the suite could not.
