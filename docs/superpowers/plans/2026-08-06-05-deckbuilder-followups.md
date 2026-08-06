# Deckbuilder Follow-ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** The four user-approved follow-ups from `docs/superpowers/specs/2026-08-06-deckbuilder-followups-design.md`: the visual (card-image) deck builder, universal card drag with sidebar drop targets, click-to-swap printings, and the 250 ms printing hover preview.

**Architecture:** All four build on Plan 4's surfaces. The visual mode replaces `ZoneColumn`'s text rows with stacked full-card images (grid variant, title-band overlap) behind a per-session toggle; the drag work extends `dnd.ts`'s payload union to every card surface and adds two sidebar drop targets; the printing swap is one new transactional Rust command joining the editor's refused-write re-read family; the hover preview is a dwell-timer layer inside the card detail pane. Rust owns the swap transaction; TS owns everything else.

**Tech Stack:** Existing only — Tauri 2.11/rusqlite, React 19, @atlaskit/pragmatic-drag-and-drop 2.0.2 (+auto-scroll 3.0.0), TanStack Query 5, zustand, Vitest. **No new dependencies.**

## Global Constraints

(Every task inherits CLAUDE.md's hard rules. The load-bearing ones for this plan, verbatim where exact:)

- **Deck writes go through `useDeck`'s mutations and the refused-write re-read family** — `DeckEditor.tsx`'s `newest([...])` currently counts **five** writes; the swap makes six. No component calls `ipc.deck*` directly.
- **`DECK_CARD_GRAIN` is `(deck_id, card_id, zone)`** — every `ON CONFLICT` names it verbatim; the swap folds on it.
- **Zero removes deck rows** (`deck_cards` has no zero-keeps rule); quantities are summed by `add_card`, replaced by `set_card_quantity`.
- **Images:** `cardImageUrl(id, 0, variant)` + `<img>`, never `fetch()`. Visual stacks use **`grid`** (the pre-warm UNION already covers deck cards at `grid`); the hover preview uses **`display`**. The retry story is `CardGrid`'s (`showing/waiting/failed`, `imageRetryDelayMs`, `IMAGE_RETRY_LIMIT`, `?retry=N`).
- **Escape protocol:** new dismissible layers are `"inner"` `useDismissOnEscape` (capture + `preventDefault`); the card pane stays `"outer"`. The editor already has **three** inner peers held apart by focus/click mechanics (see `DeckEditor.tsx`'s `Layer` doc) — anything you add must state its exclusivity mechanism in that doc.
- **Drag guards (Task 14's, binding):** `cardDraggable` is the single `draggable()` call site; `NOT_A_DRAG = "[data-no-drag], input, select, textarea"`; every nested interactive control inside a new drag source carries `data-no-drag` or is a deliberate handle. Escape-cancel must not leak into the app's Escape stack.
- **Pending guards (Task 11's, binding):** any disabled-on-press control inside a dismissible layer gets a blur-away pending guard + a `fireEvent.focusOut(node, { relatedTarget: null })` test proven to fail without it.
- **Tokens/motion:** `text-dim` never `text-muted`; mono (`font-mono tabular-nums`) for counts (the ×N badge); gold = interactive emphasis; 150 ms + `motion-reduce:transition-none` on any transition; the hover-lift and the 250 ms dwell are **not** transitions (no animation).
- **Colors are "WU" concatenated strings — never `JSON.parse`.** `typeLine`/`power`/`toughness` may be null (orphans).
- **No portals, no CSP loosening.** In-page absolute positioning only; flip-by-measurement per `shouldFlipUp`'s idiom.
- **CDP verification per CLAUDE.md** — note the tool's current contract: `size w h [expr]`/`media type feature [expr]` evaluate in-session; end with explicit `size 1280 800`; `press Enter|Space [selector]` (activation-count verified, not just activation); `drag <src> <tgt> [--press|--from|--cancel|--probe]` with dead-run cleanup. Seed via `node:sqlite` into **user tables only**; delete every seeded row; the user may have their own decks — never touch rows you did not seed.
- Copy: sentence case, verbs on buttons, errors say what happened + what to do. American spelling in user-facing strings.
- `npm run verify` (and `cargo test` for Rust tasks) before every commit; commit small with `feat:`/`fix:`/`test:` + the trailer.

## File Map

| File | Role |
|---|---|
| `src/lib/useImageRetry.ts` (new) | The one image retry/reset story, extracted from `CardGrid` (third consumer arriving) |
| `src/features/decks/VisualCard.tsx` (new) | One stacked card image: art, ×N badge, lift, action overlay, orphan fallback |
| `src/features/decks/ZoneColumn.tsx` | Gains `view` prop; renders `VisualCard` stacks or the existing rows |
| `src/features/decks/DeckEditor.tsx` | View toggle (default visual); swap joins the re-read family (six) |
| `src-tauri/src/deck.rs` | `swap_printing` command + tests |
| `src/lib/ipc.ts` | `deckSwapPrinting` mirror |
| `src/features/decks/useDeck.ts` | `swapPrinting` mutation |
| `src/lib/store.ts` (or wherever `useAppStore` lives — read first) | `paneDeckContext` slice |
| `src/features/card/CardDetailPane.tsx` | "Use this printing" action; mounts the preview |
| `src/features/card/PrintingPreview.tsx` (new) | 250 ms dwell preview layer |
| `src/features/decks/dnd.ts` | Payload union gains the generic card payload |
| `src/features/search/CardGrid.tsx`, `SearchPage.tsx`, `src/features/collection/CollectionTable.tsx`, `src/features/wishlist/WishlistPage.tsx` | Become drag sources |
| `src/AppShell.tsx` (sidebar) | Decks/Wishlist nav entries become drop targets |

---

### Task 1: Extract `useImageRetry` — one retry story, three consumers

**Files:**
- Create: `src/lib/useImageRetry.ts` + `src/lib/useImageRetry.test.ts`
- Modify: `src/features/search/CardGrid.tsx` (its inline `showing/waiting/failed` state), `src/features/decks/DecksPage.tsx` (`Cover`, which ports the same pattern incl. reset-on-id-change)

**Interfaces:**
- Produces: `useImageRetry(src: string | null): { src: string | null; failed: boolean; retrying: boolean; onError: () => void }` — `src` out carries `?retry=N` after failures; changing `src` in resets everything (the reset-on-id-change `Cover` learned); `retrying` true between scheduled retries (`imageRetryDelayMs(n)`, doubling dither, `IMAGE_RETRY_LIMIT` then `failed`). Export `imageRetryDelayMs`/`IMAGE_RETRY_LIMIT` from here; re-export from `CardGrid` so existing imports survive.

- [x] **Step 1: Failing tests.** Read `CardGrid.tsx`'s current implementation first — the hook is an extraction, not an invention; its tests port `CardGrid`'s existing image tests to the hook plus: reset on src change (old failure forgotten), null src (no state machine), retry URL shape (`base?retry=1` — and `base` already containing `?` is impossible for `mtgimg:`/`http://mtgimg.localhost` URLs, assert the simple form).
- [x] **Step 2: Implement; refit `CardGrid` and `Cover` to the hook.** Their rendered output must not change — the existing `CardGrid.test.tsx`/`DecksPage.test.tsx` image tests are the regression net and must pass **unedited** (if one needs editing, the extraction changed behavior — stop and fix).
- [x] **Step 3: `npm run verify`; commit** `refactor: one image retry story, shared by grid tiles and covers`

### Task 2: The visual deck builder

**Files:**
- Create: `src/features/decks/VisualCard.tsx` + `VisualCard.test.tsx`
- Modify: `src/features/decks/ZoneColumn.tsx` (render path branches on `view`), `src/features/decks/DeckEditor.tsx` (toggle, default visual), `DeckEditor.test.tsx`, `ZoneColumn.test.tsx`

**Interfaces:**
- Consumes: `useImageRetry` (Task 1), `cardImageUrl(id, 0, "grid")`, `cardDraggable`/marks from `dnd.ts`, `QuantityStepper`, `RowMenu` and the group machinery already in `ZoneColumn.tsx`.
- Produces: `VisualCard({ card, onOpen, onQuantity, menu, lifted, onLift })` rendering one `<li>` (the same `<li>` contract the drag layer needs — `cardDraggable` stays on the `<li>`); `ZoneColumn` gains `view: "visual" | "compact"`; `DeckEditor` owns `const [view, setView] = useState<"visual" | "compact">("visual")` (per-session, deliberately not persisted).

- [x] **Step 1: Failing tests.** `VisualCard`: renders the `grid` image with the card name as `alt`; quantity 3 renders ONE image + a `font-mono tabular-nums` "×3" badge (assert exactly one `img` for the card); orphan (`needsReview` non-null, no image URL applies) renders the text fallback with the reconciler's sentence — the flagged sentence needs its text, no `<img>`; the stepper/menu overlay appears on focus (the `REVEAL_ON_HOVER` pattern — assert the container carries the class string) and every control carries `data-no-drag`; failed image → `useImageRetry`'s "No image" state, name stays readable (the name is ALWAYS visible text, not only alt — a stack of broken images must still read as a deck list). `ZoneColumn` view="visual": stacked layout — each `<li>` after the first in a group carries the negative-margin stack class; hover/focus lifts (`onLift` → z-order class, no transform, no transition); group headers and counts unchanged; view="compact" renders the existing rows byte-identically (existing tests pass unedited). `DeckEditor`: toggle button (accessible name "Show as list" / "Show as cards" — it names what it DOES), default visual; toggle is in the header beside group-by; Escape/stack behavior unaffected.
- [x] **Step 2: Implement.** Stack geometry: the `grid` variant's aspect is the printed card's (read `Variant::Grid::dimensions()` in `images.rs` for the exact numbers and put them in a comment); overlap so the title band shows — `margin-top: calc(-1 * (100% * (1 - TITLE_BAND)))` won't work in pure CSS against width-derived heights, so size explicitly: the card width is the column width minus padding, height = width × aspect, overlap = height − titleBand where `TITLE_BAND ≈ 0.135` of card height (tune against the real window in Step 3; record the final number and why). Lift = `position: relative; z-index` bump on hover/focus of the `<li>` — no motion. The ×N badge sits top-right on the image, `bg-bg/85` corner chip like the gallery's. Keyboard: the `<li>`s are already focusable in list order via the name button — in visual mode the whole card is the button (one control, the card front; stepper/menu overlay on focus as in compact).
- [x] **Step 3: CDP.** Seed a 40-card deck (your own — never the user's rows); verify: stacks paint (count `img` elements per group vs seeded rows), title bands legible at 1024 and 1280 (shots), lift on hover shows the full card, stepper still steps by exactly 1 (`press Enter` on it — activation count), drag a visual card between zones (the `drag` subcommand; the `<li>` is still the source), a bottom-row menu still flips, reduced motion clean, console clean both families, no horizontal scroll. Delete seeded rows.
- [x] **Step 4: `npm run verify`; commit** `feat: the visual deck builder — stacked card images with a compact-list toggle`

### Task 3: `swap_printing` — the Rust command

**Files:**
- Modify: `src-tauri/src/deck.rs` (+ tests in its test module), `src-tauri/src/lib.rs` (register the command — read how the other deck commands register first)

**Interfaces:**
- Produces: `deck_swap_printing(deck_id: String, from_card_id: String, to_card_id: String, zone: String) -> Result<SwapResult, String>` where `SwapResult { folded: bool, quantity: i64 }`. Answers: `GONE` (deck deleted — same sentence the other writes use), `"That card is not in this deck's <zone>."` (from-row missing), `"That is already this printing."` (from == to), `collection::BUSY` on lock timeout. All inside ONE transaction via the same `with_write`/`lock_for` discipline the other writes use (read `set_card_quantity` first and mirror its shape).

- [x] **Step 1: Failing tests** (in `deck.rs`'s test module, against the in-memory fixture the module already uses):
```rust
#[test] fn a_swap_moves_the_quantity_to_the_new_printing_row() { /* seed row (deck, lea-bolt, main, 3); swap to m10-bolt; assert old row gone, new row qty 3, denormalized set_code/collector_number/lang/name taken from the m10 cards row, folded == false */ }
#[test] fn a_swap_onto_an_existing_row_folds_quantities_on_the_grain() { /* seed (lea-bolt, main, 3) and (m10-bolt, main, 2); swap lea→m10; one row, qty 5, folded == true */ }
#[test] fn a_swap_refuses_the_same_printing_and_writes_nothing() { /* from == to; error mentions "already"; updated_at unmoved */ }
#[test] fn a_swap_of_a_missing_row_says_which_zone_it_looked_in() { /* no row; error names the zone */ }
#[test] fn a_swap_on_a_deleted_deck_answers_gone() { /* delete deck first; GONE */ }
#[test] fn a_swap_is_one_transaction() { /* the RAISE(ABORT) trigger idiom used by update_deck's test: make the second write fail, assert the first did not land */ }
```
- [x] **Step 2: Implement.** Transaction: `touch_deck` (GONE gate) → read from-row (`SELECT quantity FROM deck_cards WHERE deck_id=?1 AND card_id=?2 AND zone=?3`) → read the to-printing's denormalized facts from `cards` (`SELECT set_code, collector_number, lang, name FROM cards WHERE id = ?`; a missing `cards` row refuses — you clicked it from a live printings list, so absence means a sync raced you: say so) → `INSERT INTO deck_cards (...) VALUES (...) ON CONFLICT (deck_id, card_id, zone) DO UPDATE SET quantity = deck_cards.quantity + excluded.quantity` (the grain verbatim) → `DELETE` the from-row → `allocate_deck` (the swap changes what the deck wants — every other zone write reallocates; read the six call sites' pattern). Zone validated against `ZONES` like every other zone argument.
- [x] **Step 3: `cargo test`; commit** `feat: swap a deck card to another printing in one transaction`

### Task 4: The swap reaches the frontend — mirror, mutation, family

**Files:**
- Modify: `src/lib/ipc.ts` (mirror + `SwapResult` type + payload pin in the no-dotdot test file it uses — read how `deckMoveCard` mirrors first), `src/features/decks/useDeck.ts` (`swapPrinting` mutation, `["decks"]` invalidation, NO optimism — the fold answer is the server's), `src/features/decks/DeckEditor.tsx` (`newest([...writes, deck.addCard, deck.missingToWishlist, deck.swapPrinting])`; the comment's count 5 → 6), `DeckEditor.test.tsx` (the refused-swap re-read test — the same shape as the refused-wishlist-write test beside it)

**Interfaces:**
- Produces: `ipc.deckSwapPrinting(deckId, fromCardId, toCardId, zone): Promise<SwapResult>`; `useDeck(id).swapPrinting` (mutation). Task 5 consumes `swapPrinting`.

- [x] **Step 1: Failing tests** (mirror pin; mutation invalidates `["decks"]`; refused swap re-reads the deck — mutation-checked by dropping it from `newest`'s list).
- [x] **Step 2: Implement; `npm run verify`; commit** `feat: the printing swap joins the editor's six-write family`

### Task 5: "Use this printing" in the card pane

**Files:**
- Modify: the `useAppStore` module (read `src/` for where the store lives): `paneDeckContext: { deckId: string; zone: DeckZone; cardId: string } | null` + `setPaneDeckContext`; `src/features/decks/ZoneColumn.tsx` (row/card click sets context alongside `setSelectedCardId`); every OTHER `setSelectedCardId` call site sets context `null` (grep them all — search tiles, collection rows, wishlist rows, panel tiles; list the sites in your report); `src/features/card/CardDetailPane.tsx` (printings rows gain the action when context is non-null; clear context on pane close), + tests in each.

**Interfaces:**
- Consumes: `useDeck(context.deckId).swapPrinting` — but the pane is OUTSIDE the editor. Mount the mutation via a `useSwapFromPane(context)` helper in `useDeck.ts` that instantiates the mutation for the context's deckId (nullable context → disabled). The GONE story: a refused swap from the pane shows its sentence IN THE PANE beside the pressed row (the panel-banner precedent) — the editor behind re-reads via the family (Task 4 wired it).
- Produces: the visible "Use this printing" affordance — a button on each printings row, hidden on the row that IS the context's printing (that row instead reads "This deck uses this printing" as static dim text).

- [x] **Step 1: Failing tests.** Context set by deck-row click, null from search-tile click (assert both); pane shows the action only with context; click calls `swapPrinting(deckId, contextCardId, printingId, zone)`; success updates context.cardId + `setSelectedCardId(printingId)` (the pane now shows the new printing, marked as the deck's); refusal renders the sentence beside the row and does NOT move context; the button is disabled-on-press territory inside the pane (an Escape-dismissible layer) → pending guard + `focusOut(relatedTarget: null)` test proven to fail without it.
- [x] **Step 2: Implement. Step 3: CDP** — seed a deck, open a card from its row, swap to another printing, watch the editor row change set code live, the pane re-mark, and a swap onto an existing row fold quantities; a swap attempt after deleting the deck (second window of `node:sqlite`) shows the refusal and the editor behind goes gone. Delete seeded rows.
- [x] **Step 4: `npm run verify`; commit** `feat: swap a deck card's printing from the card pane`

### Task 6: The 250 ms printing hover preview

**Files:**
- Create: `src/features/card/PrintingPreview.tsx` + test
- Modify: `src/features/card/CardDetailPane.tsx` (mount per printings list)

**Interfaces:**
- Consumes: `cardImageUrl(printingId, 0, "display")`, `useImageRetry`, `useDismissOnEscape` (`"inner"` — beneath the pane's `"outer"`; state the exclusivity mechanism in the pane's layer doc: the preview closes on the same hover-leave/focus-blur that opened it, so it can never coexist with another inner layer's open state), `shouldFlipUp`'s measurement idiom (import it if exported, else extract it to `src/lib/` — do not copy it a third time).
- Produces: `PrintingPreview({ printingId, anchor }: { printingId: string | null; anchor: HTMLElement | null })` — renders nothing while `printingId` is null.

- [x] **Step 1: Failing tests** (vi.useFakeTimers): hover a row → nothing at 249 ms → preview at 250 ms; leave at 200 ms → never appears; leave while shown → gone immediately; focus parity (same 250 ms); dragstart on the row cancels the timer; Escape with preview shown closes ONLY the preview (`defaultPrevented` true, pane still mounted), next Escape reaches the pane; `<img>` is `aria-hidden` wrapped, `alt=""`, no transition classes; the timer is one shared instance (moving between rows restarts it — no two previews).
- [x] **Step 2: Implement.** One `setTimeout(250)` per enter, cleared on leave/blur/drag/unmount; in-page absolute beside the row, flip above/below by measurement; `display` variant dimensions from `images.rs` in a comment; width capped to the pane's free space.
- [x] **Step 3: CDP** — dwell on three printings rows (real mouse via `Input.dispatchMouseEvent` moves; the preview appears ~250 ms after rest, reads the right art per row — shot one), Escape order preview→pane, reduced motion clean, console clean. **Step 4: verify; commit** `feat: printing hover preview on a quarter-second dwell`

### Task 7: Every card surface drags — sources

**Files:**
- Modify: `src/features/decks/dnd.ts` (payload union + `cardDraggable` reuse), `src/features/search/CardGrid.tsx` (tiles draggable via an optional `dragPayload?: (card) => DragPayload` prop — SearchPage passes it; the decks panel already passes its own), `src/features/search/SearchPage.tsx`, `src/features/collection/CollectionTable.tsx` (rows), `src/features/wishlist/WishlistPage.tsx` (pinned-wish rows only — an any-printing wish names no printing to drag), `src/features/card/CardDetailPane.tsx` (printings rows drag that printing), + each file's tests.

**Interfaces:**
- Produces: the union gains `{ kind: "card"; cardId: string; name: string }` (align the literal's shape with the existing members' naming after reading `dnd.ts` — same `MARK` fence, same `readDragData`). `dropWrite` in the editor treats `"card"` exactly as it treats a panel tile (add 1 to the target zone). Task 8 consumes the payload at the sidebar.

- [x] **Step 1: Failing tests** (the `test-drag.ts` machinery): each surface's row/tile registers a drag whose `source.data` carries the card's id + the `MARK`; each surface's nested controls (steppers, remove buttons, action slots, the printings "Use this printing" button from Task 5) refuse via `data-no-drag`/`canDrag` — one negative per surface, `started === false`; the editor's zone columns accept a `"card"` payload as an add (pin `dropWrite`).
- [x] **Step 2: Implement** — `cardDraggable` stays the single `draggable()` call site (it takes the payload; the guard rides along). **Step 3: CDP** — drag a search tile onto nothing (cancel clean), a collection row's drag starts from the name cell and refuses from the stepper (`drag --probe`), a printings row drags. **Step 4: verify; commit** `feat: every card surface is a drag source`

### Task 8: The sidebar catches cards — Decks and Wishlist targets

**Files:**
- Modify: `src/AppShell.tsx` (or wherever the sidebar nav renders — read `src/` first; the two entries become pdnd drop targets), a new `useSidebarDrops.ts` beside it (the two mutations: add-to-open-deck via a `useDecks`-level mutation calling `ipc.deckAddCard(openDeckId, cardId, "main", 1)` with `["decks"]` invalidation + GONE handling; add-wish via the existing wishlist add mutation — read `useWishlist`/`WishlistPage` for it, quantity 1, pinned printing, invalidating `["wishlist"]` + `["cards","search"]`), + tests.

**Interfaces:**
- Consumes: `readDragData` (the `"card"` payload — and deck-row/panel payloads carry a cardId too: accept them all; a deck-row drop on Wishlist wishes for that card), `useAppStore.openDeckId`.
- Produces: during any card drag, the two entries show the standing gold ring; **Decks with no open deck is inert** — `canDrop` false, `title="Open a deck to drop cards into it"`; drop feedback is a `role="status"` line in the sidebar entry's own space reading "Added to <deck name>." / "Added to wishlist." that clears on the next drag or 4 s (whichever first — a timer is fine here, it is not a transition); a GONE refusal reads its sentence in the same slot.

- [x] **Step 1: Failing tests**: eligible-during-drag styling appears on dragstart and leaves on cancel (the `test-drag.ts` cancel path); drop on Wishlist calls the wish mutation with the dragged printing; drop on Decks with `openDeckId` calls `deckAddCard(id, cardId, "main", 1)`; without `openDeckId` neither highlights nor accepts (`canDrop` pinned); the status line renders each sentence and clears; a second identical wish drop folds (the mutation's server sums — assert the call, not the sum).
- [x] **Step 2: Implement. Step 3: CDP** — drag a search tile to Wishlist (wish appears, hearts flip in search); open a deck, drag from search... (the Search view and editor never coexist — drag from the DOCKED panel to the sidebar Decks entry: adds to main; the panel's own zone drop still wins when over a column); inert-Decks case; console clean. **Step 4: verify; commit** `feat: the sidebar catches card drags — open deck and wishlist`

### Task 9: Live smoke + docs close-out

**Files:**
- Modify: `CLAUDE.md` (the decks section gains: the six-write family; visual mode + `TITLE_BAND`; the swap's fold-on-grain; sidebar drop targets; the `"card"` payload), `docs/superpowers/notes/plan-4-carryover.md` → create `docs/superpowers/notes/plan-5-followups-note.md` instead (this plan is small; one page: measured numbers, deferred items), whatever the smoke indicts (small fixes inline; structural → the note).

- [x] **Step 1: Scripted smoke** (numbers recorded): visual mode with a real 100-card Commander deck — paint time on first open (pre-warmed vs cold), stack legibility shot at 1024; swap round trip incl. fold; all eight drag routes (4 sources × zones/sidebar); preview dwell timing measured (rest → paint); Escape ladders (preview→pane; menu/filter/check exclusivity untouched); keyboard-only pass over the visual mode; reduced motion; console 0/0/0 both families; the user's own decks untouched (count rows before/after).
- [x] **Step 2: Fix what it finds. Step 3: docs. Step 4: `npm run verify` + `cargo test`; close checkboxes; commit** `chore: complete deckbuilder follow-ups — smoke and docs`

---

## Self-review (performed at authoring)

- **Spec coverage:** §1 universal drag → Tasks 7–8; §2 printing swap → Tasks 3–5; §3 hover preview → Task 6; §4 visual builder → Tasks 1–2; the withdrawn §5 has no task by design. Sequencing follows the spec (visual first).
- **Type consistency:** `SwapResult` (T3=T4), `paneDeckContext` (T5), `{ kind: "card" }` payload (T7=T8), `useImageRetry` signature (T1=T2=T6).
- **Known unknowns stated as read-first directives** (store module path, sidebar file, existing payload literal names) rather than invented — the SDD brief flow resolves them at dispatch.
