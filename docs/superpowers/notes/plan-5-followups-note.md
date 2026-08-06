# Plan 5 note — deckbuilder follow-ups

Written at the end of Task 9, 2026-08-06. §1 is **measured in the running app** over
`scripts/cdp.mjs` against the live 116 590-card database; §2–§4 are findings and explicit
deferrals with their reasons. One page, because the plan was four features on Plan 4's
surfaces rather than a new floor.

---

## 1. The live smoke — what was measured

`npm run tauri dev` with `--remote-debugging-port=9222`, a console recorder attached across a
reload, and one fixture seeded through `node:sqlite` into
`src-tauri/target/debug/data/mtg.db` while the app held it — **user tables only**: a
**100-card Commander deck** (Atraxa as commander, 99 in main across 71 rows: 4 basics at
7–10 copies, 65 singletons, two Counterspell printings to fold), 3 collection entries and 2
wishes (one pinned, one any-printing). The user had one deck of their own on this database and
it was not touched.

**Rows before → after**, counted with the same query at both ends:

| table | before | after | user's own |
|---|---|---|---|
| `decks` | 1 | 1 | deck 1 "test", `updated_at` 1785973041 unmoved |
| `deck_cards` | 7 | 7 | all 7 rows byte-identical |
| `deck_allocations` | 0 | 0 | — |
| `collection_entries` | 0 | 0 | — |
| `wishlist_entries` | 0 | 0 | — |
| `card_migrations` | 2 569 | 2 569 | the sync's own bookkeeping, never written by hand |

### The visual builder

| what | number |
|---|---|
| Card frame at 1280 | **231 × 323 px**, aspect **1.400** (`CARD_ASPECT`, `object-cover` over a 488 × 680 `grid` image) |
| Visible band per stacked card | **61 px** = **0.190** of card height — `TITLE_BAND = 0.19` exactly |
| Title plate | **39 px** = **12.0 %** — `PLATE = 12` exactly |
| Plate type | 12 px, name truncates by ellipsis, mana line and `n/m` shortfall both present |
| Cold first open (59 of 72 card images not on disk) | list in DOM **255 ms**, first image painted **521 ms** |
| Pre-warmed re-open | list **198 ms**, and all 5 in-viewport images already `complete` at that same **198 ms** |
| Cold screenful (scrolled to never-loaded rows) | **14** images, all complete at **1 199 ms** |
| Main-deck scroller at 1280 × 800 | **245 px** tall over **6 098 px** of content — **4** plates visible |
| Main-deck scroller at 1024 × 768 | **153 px** — **2.5** plates, of which the group header takes one |
| Horizontal scroll | none at either width (`scrollWidth` 1280 / 1024) |

**Method for cold vs pre-warmed, stated honestly:** the user's `data/images` was *not* deleted
(it holds 3 000 rows they paid for). The seeded deck's cards were never browsed, so 59 of its
72 printings were genuinely absent from `image_cache` at the first open, and the app's start-up
pre-warm had already run before the rows existed. The cold-screenful row is a second,
independent cold measurement: `loading="lazy"` leaves off-screen images unfetched, so scrolling
the column to unseen rows is a real cold screenful without touching anyone's cache.

### The printing swap

Both halves driven from the card pane, opened from a deck card (so `paneDeckContext` was set):

* **Round trip.** Sol Ring `ECC 57` → `SLD 2560`. The editor's slot attribute changed from
  `main:04002706…` to `main:24afe08b…` **live**, the pane's "This deck uses this printing" mark
  moved to the new row, and `deck_cards` kept 72 rows / 100 copies with `set_code` and
  `collector_number` denormalized to the new printing.
* **Fold.** Counterspell `SLD 7123` → `MAR 52`, both already in main at 1. One row at
  **quantity 2**, rows 72 → **71**, copies still **100**, and the pane's live region read
  **"Folded into one row of 2 in Main deck."**
* **Allocator side effect, confirmed:** `deck_allocations` went 0 → 3 on the first swap. A zone
  write reallocates, exactly as documented.
* **Caret hand-back:** Escape after the fold put focus on
  `[data-deck-card="main:379f4020…"]` — the *surviving* printing's card in the editor, not the
  row the pane was opened from (which no longer exists).

### Drag routes

Ten driven, every one verified against the database or the zone counts. The plan's "4 sources ×
zones/sidebar" is eight of these; the other two are the in-editor sources, which are the only
ones that can reach a zone column at all.

| # | source | target | result |
|---|---|---|---|
| 1 | docked panel tile (`search-card`) | Main deck column | add — 99 → 100 |
| 2 | printings row (`card`) | Main deck column | add — 100 → 101 |
| 3 | search-view tile (`card`) | sidebar Wishlist | "Added to wishlist." + row written |
| 4 | collection **table** row (`card`) | sidebar Wishlist | "Added to wishlist." + row written |
| 5 | pinned wish (`card`) | sidebar Wishlist | folded 1 → **2** (server summed) |
| 6 | docked panel tile | sidebar Decks | "Added to Smoke — Atraxa." — 102 → 103 |
| 7 | deck card (`deck-card`) | Companion column | move — main 102 → 101, companion 0 → 1 |
| 8 | deck card | sidebar Wishlist | "Added to wishlist." |
| 9 | printings row | sidebar Decks | "Added to Smoke — Atraxa." — 101 → 102 |
| 10 | deck card | remove tray | removed (found accidentally — see §2.3) |

Two negatives, both refused at `dragstart` ("the browser never started a drag") with the
quantities unmoved: a press on a **collection row's stepper** (`data-no-drag`), and an
**any-printing wish** (no printing to carry). During every drag the eligible sidebar entries
carried the gold ring and the **inert Decks entry did not** (`ring-accent`: false), and the
report line cleared on its own after `REPORT_MS` — measured gone at > 4 s.

### The 250 ms preview

Seven dwells on seven printings rows, timed in-page from the last `mousemove` to the
`MutationObserver` seeing the frame inserted:

**242.6 · 258.1 · 259.8 · 262.7 · 302.7 · 302.9 · 307.0 ms** — median **262.7**, mean **276.5**.

Two of those re-measured from the `mouseover` that *arms* the timer rather than from the last
move: **287.4** and **330.4 ms**. The gap between the two framings is the approach — `hover`
walks the pointer in over three steps 16 ms apart, so the enter can precede the last move by up
to ~32 ms, which is why one sample reads below the 250 ms constant. **At `--rest 200` the
preview never appeared** (0 observer events).

Exclusivity, measured rather than argued: with the pane's quick-add popup open, a **600 ms**
dwell on a neighbouring printings row drew **nothing** — Task 6's `OPEN_POPUP` guard doing its
job in the running window.

### Escape ladders, keyboard, motion, console

* **preview → pane:** first Escape took the preview and left the pane mounted; second closed the
  pane and put the caret back on the deck card's slot.
* **pane popup → pane:** first Escape closed the quick-add popup and returned focus to its
  trigger; second closed the pane.
* **row menu → pane:** same shape, focus back on "More actions for …".
* **Keyboard-only over the visual mode:** focusing a card front sets the `<li>` to `z-index: 10`
  (the lift) and the control bar to `opacity: 1` (the reveal). Tab order inside one card is
  front → Decrease → quantity → Increase → More actions, all within the same `<li>`.
  **Activation counts, not activations:** one `press Enter` on Increase stepped **1 → 2**; one
  `press Space` on Decrease stepped **2 → 1**; one `press Enter` on the card front fired
  **exactly 1** click and opened the pane with deck context.
* **Reduced motion**, measured *in-session* through `media prefers-reduced-motion reduce`
  (`matchMedia(...).matches === true` in the same socket): the control bar, menu trigger and nav
  items report `transition-property: none`; the `<li>` and the card front carry no transition at
  all (`all` / **0 s**); **0** elements under `main` still had a non-zero transition duration;
  no animations anywhere.
* **Console: 0 errors, 0 warnings, 0 exceptions**, both families, across the whole session —
  16 entries total, all Vite HMR, the React DevTools nudge, and WebView2's lazy-image notice.
  Re-checked after a reload with the recorder still attached (4 entries, same shape), per the
  retained-history rule.

---

## 2. What the smoke found

### 2.1 The inert Decks entry's sentence is a description, never a tooltip

The controller asked whether `title="Open a deck to drop cards into it"` is ever *seeable*. It
is not, and the reason is stronger than "Chromium suppresses tooltips mid-drag": **the element
is never in `:hover` while it carries the attribute.** With a card parked on the entry for
1.6 s, `title` was present and `document.querySelectorAll(":hover")` still ended at
`BUTTON.block > SPAN.block > IMG.size-full` — the search tile the drag started from. Chromium
freezes `:hover` at the drag origin. Outside a drag the entry *is* hovered, and the attribute is
gone. The two states never overlap, and `[role=tooltip]` was 0 throughout.

It is not dead markup, though. Mid-drag the accessibility node reads
`button "Decks", description "Open a deck to drop cards into it"` — measured through
`Accessibility.getPartialAXTree` in the same run. `title` is the accname spec's description
fallback, so assistive technology gets the sentence even though no eye does.

**Left as-is, deliberately.** The two fixes both cost more than they pay: attaching the title
outside drags puts "Open a deck to drop cards into it" on an entry a reader is merely hovering
to click (which the code's own comment already rejects), and moving the sentence into the
entry's existing `role="status"` line would announce it at the start of **every** drag while no
deck is open — which is every drag begun from Search, Collection or Wishlist. That is a product
call, not a smoke fix. The comment at `AppShell.tsx` now records the measurement instead of
implying a tooltip.

### 2.2 Mid-drag Escape cannot close the card pane — measured, and only half the assumption held

With a drag in flight from a printings row, a real `Input.dispatchKeyEvent` Escape
(rawKeyDown + keyUp) delivered **0** keydown events to the page — an in-page capture-phase
counter stayed at zero. So the card pane's Escape layer never runs, and **the pane stays open**:
a drag from a printings row can never strand the reader with a closed pane and a card in the
air. That is the property the review wanted and it holds.

The other half — "the drag cancels" — **is not measurable through this harness and was not
observed**. `Input.setInterceptDrags` replaces Chromium's own drag loop, which is the thing that
would consume Escape and cancel; under interception the drag survived and the following drop
landed. Under a real OS drag the platform loop cancels, and the page still sees nothing. Stated
here rather than asserted: what was measured is the page's silence, not the platform's cancel.

### 2.3 A wrapped zone column's rectangle can lie outside its own scroller

The zones row (`DeckEditor.tsx`, `flex-wrap` + `overflow-y-auto`) wraps at 1280 × 800 with the
docked panel open: in visual mode Main deck and Commander share line 1 and Companion goes to
line 2; in **compact** mode Main deck takes 621 px alone and *both* other zones wrap. The
wrapped line is reachable — the row scrolls (scrollHeight 488 vs clientHeight 284) — but
`getBoundingClientRect` on a column scrolled out of that clip reports viewport coordinates that
land on whatever is painted there. During a `deck-card` drag that is the **remove tray**
(`absolute inset-x-0 bottom-0 -top-3 z-30`, over the price line). A scripted drop aimed at the
Companion column removed the card from the deck instead — the exact mistake the tray's own
comment says has nothing to undo it.

**Not a product bug**: a reader cannot aim at a column they cannot see, and what they *can* see
there is the tray, correctly labelled. It is a harness hazard, and it is now written into
CLAUDE.md's `drag` bullet. Worth knowing that the visual mode shows *more* zones than compact at
this width, because `STACK_MAX_WIDTH` caps a column at 256 px where compact lets Main deck take
621 px.

### 2.4 The short window is still the stats block's fault, and now it has a number

At **1024 × 768** the stats block (four summary blocks plus the wrapping "Card types" bars)
takes the first ~500 px, `main` gains a scrollbar, the zone columns stack one per line and each
gets a **153 px** scroller over **6 098 px** of content. A 100-card deck is legible one card at
a time. The plate itself reads fine at that width — 12 px name, mana line, `0/1` — so the
quality floor holds for the *card*, not for the *list*. Task 2's review already accepted this
and pointed at Plan 6; this is the measurement it was missing.

---

## 3. Deferred items carried out of Plan 5

Collected from the SDD ledger. None of these blocked a task; each was judged smaller than the
cost of reopening a reviewed change.

**Rust (`deck.rs`).** The `zone_rows` helper could be adopted at `deck.rs:1966`. The fold's
unchecked add is consistent with Plan 4's carryover ruling — it fails safe through REAL
promotion. The rustdoc at `deck.rs:607` undersells the same-oracle guard's exemptions: a NULL
`oracle_id` also skips it, and a NULL on the *to* side would permit an unverified cross-card
write — unreachable at 0 of 116 590 rows, so a fence around the type rather than a path.

**IPC and tests.** `ipc.test.ts:257`'s sibling counts are off (five → four; three take a
`cardId`). `DeckEditor.test.tsx:48` never resets `mounted` in `beforeEach`. `useDeck.test.ts`
pins `addCard`'s `onError` only indirectly, from `AppShell.test.tsx:478` — a one-line sibling of
the `swapPrinting` refusal test would put the pin on the owning module. `AppShell`'s tests now
couple to the app client's `staleTime: 30_000` (commented in the test).

**The card pane.** A card opened from the **validation panel** gets no swap context, so the
"Use this printing" affordance is absent there even though the issue usually knows the zone.

**The preview.** A background refetch that replaces the printings list drops a resting preview
until the pointer moves. It does not re-measure on a window resize while open, and it re-arms
when a popup closes under a still pointer. `[aria-haspopup]` also matches `="false"`, which
fails safe (a suppressed dwell). The
`anchor.isConnected` branch is near-unreachable and untested.

**The drag layer.** `CardGrid.tsx:148-149` says `dragPayload` and `tileRef` "compose" — they do
not; both would register a second `draggable()` and pdnd warns. The exclusion rationale at
`CardGrid.tsx:139-141` is inverted (the tile is the card, the row is the entry), and it leaves a
real product asymmetry: **the Collection drags in table mode but not in card mode**, one prop
away from closing. The comment at `CardGrid.tsx:319-322` describes the payload as read at
`dragstart` when correctness actually comes from the `useCallback` deps closing over the card.
`CollectionTable.tsx:78-92` and `WishlistPage.tsx:104-118` are two near-identical `DraggableRow`
copies with one real divergence — the collection registers orphans unconditionally, so a
`name: ""` payload can reach `deck_add_card` with an id nothing resolves and fail at the backend
instead of never starting. Both spread `...rest` after `ref`, and React 19's `ComponentProps`
includes `ref`, so a caller's would silently win.

**The sidebar.** Two Decks drops in flight at once: the second `.mutate` detaches the first's
observer and the first sentence is dropped (superseded on screen anyway). A **deck row let go on
the Decks entry adds a copy** — it reads as a move and writes as a duplicate; the plan's
"accept them all" made it so, and whether that is right is a product call. The report line
shifts the entries below it by ~32 px for four seconds; reserving the space would be two dead
gaps forever, and the shift was accepted.

---

## 4. What Plan 6 should read first

§2.4 (the stats block is what makes 1024 × 768 a one-card-at-a-time view), §2.1 (the inert
entry has no visible voice, and giving it one is a decision about announcement noise), and the
Collection card-mode asymmetry in §3. The allocator's known gap is unchanged and still Plan 6's:
**growing the collection does not re-run the allocator**, so a deck reads new copies only after
its next allocator run.
