# Deckbuilder Follow-ups — Design (user requirements 2026-08-06)

**Status: DRAFT — awaiting user approval.** Four additive requirements, received at Plan 4's close:

1. Drag and drop on cards — from the card list into the different deck areas, and other
   places where card drag and drop might make sense.
2. Quickly change a card to a different printing by clicking on the printing in the view.
3. A preview of the different printings on mouse hover, over 0.25 s.
4. The deck builder should be a lot more visual — show the cards, not just descriptive text.

(A fifth — deck price on gallery tiles — was raised and withdrawn 2026-08-06: the editor's
existing stats-block price (Plan 4 Task 15) is the answer; no tile price.)

## What already exists (Plan 4, Task 14)

Dragging a tile from the deck editor's **docked search panel** into any zone column works
today, as does dragging rows between zones and out to the remove tray. The gap is every
*other* card surface: the global Search view's grid, the collection table, the wishlist
table, and the detail pane's printings list are not drag sources, and nothing outside the
editor is a drop target.

## 1. Universal card drag

**Sources** (one payload contract — `dnd.ts`'s `DragPayload`, extended per-source):
- Global Search view grid tiles
- Collection table rows
- Wishlist table rows
- Detail-pane printings rows (drags *that specific printing*)
- (existing) docked-panel tiles, deck rows

**Targets.** A drag only makes sense when the target is on screen. One view mounts at a
time, so the Search view and the deck editor never coexist — the honest inventory is:
- (existing) zone columns + remove tray, inside the editor
- **The sidebar's nav entries become drop targets** — the two that mean something:
  - **Decks** while a deck is open: drop adds 1× to the open deck's `main` zone (the
    docked panel's add semantics, same mutation, same refused-write family). While no
    deck is open, the target is inert and says so on hover-during-drag.
  - **Wishlist**: drop adds a wish for that printing (`add_wish`, quantity 1, pinned
    printing) from anywhere.
- Judgment call: the collection is deliberately **not** a drop target — `collection_add`
  carries identity (finish/condition/language) that a drop cannot answer; the AddToCollection
  form exists precisely to ask. A drop that silently invents NM/nonfoil would write wrong
  facts. (The wishlist drop is safe: an unpinned-finish wish is the wishlist's own default.)

Sidebar drop affordance: during any card drag, eligible nav entries show the standing
drop style (the gold 2px ring, no new vocabulary); the drop indicator line stays
zone-column-only. Guard rails from Task 14 carry over unchanged (`canDrag` marks,
nested-control exclusion, Escape-cancel isolation).

## 2. Click a printing to swap

Scoped to **decks** (the collection's printing identity carries finish/condition and is
Plan 5's import/export territory; a collection swap invents facts the same way a
collection drop would).

- When the card detail pane was opened **from a deck row**, its printings list gains a
  per-row action: **"Use this printing"** (visible affordance, not hover-only). Click swaps
  the deck row to that printing: same zone, same quantity, folding into an existing row of
  the target printing in that zone (quantities sum — the grain is `(deck_id, card_id, zone)`).
- Backend: one new command `deck_swap_printing(deck_id, from_card_id, to_card_id, zone)` —
  transactional, `touch_deck`-guarded (GONE → the editor's existing re-read family), refuses
  a no-op swap (`from == to`), answers the folded quantity. Rust owns the transaction; the
  UI treats it as a fourth `useDeck` write inside the same refetch/banner story.
- Opened from anywhere else (search, collection, wishlist), the printings list keeps its
  current behavior — no swap affordance without a deck context.

## 3. Printing hover preview (250 ms)

- Hovering a printings-list row for **250 ms** shows an in-page floating preview of that
  printing — the `display` variant via `mtgimg://`, `<img>` as always — positioned beside
  the row, flipping above/below by available space (Task 12's `shouldFlipUp` idiom). No
  portal, no animation: it appears and disappears instantly (the 250 ms is a dwell timer,
  not a transition, so the motion budget is untouched and reduced-motion changes nothing).
- Leaving the row or starting a drag cancels the timer/preview; Escape closes it first if
  open (an `"inner"` layer beneath the pane's `"outer"`).
- Keyboard parity: focusing a row shows the same preview after the same 250 ms; blur hides
  it. Screen readers lose nothing — the preview is `aria-hidden` art; the row's text is
  already the accessible story.
- Judgment call: scoped to the printings list (the surface the user named). Deck rows and
  search tiles already show art in the pane on click; a hover preview there is Plan 6's
  "hover previews" item if wanted.

## 4. The visual deck builder

The zone columns become **card-image columns**: each entry renders as the card itself,
not a text row.

- **The stacked look.** Within a group (Type or Mana value — the existing group-by
  stays), cards render as full-card images vertically overlapped so that each card
  beneath the top one shows its **title band** (the classic deckbuilder stack). The top
  card of each stack is fully visible; hovering or focusing any card lifts it to full
  visibility (an in-page z-order change, no motion, no scale). Quantity ≥2 renders one
  image with a mono `×N` badge — not N copies (density, and the cache serves one key).
- **Image variant: `grid`** — the pre-warm UNION already warms deck cards at `grid`
  (Plan 4 Task 4), so a built deck's editor opens warm from disk (~3 ms/image). A 100-card
  deck at ~60 KB avg is ~6 MB once, cached forever. Placeholder/retry story is `CardGrid`'s,
  which the gallery already ports.
- **Per-card controls survive**: the stepper, the row menu (move/cover/printing), and the
  click-to-open-pane all live on the card image — the action row appears on hover/focus
  exactly as the search grid's tiles do (`REVEAL_ON_HOVER`), with the Task-14 `data-no-drag`
  marks so controls never start a drag. Keyboard: cards are focusable in list order; the
  hover-lift follows focus; every existing shortcut keeps working.
- **The compact text list stays as a toggle** (per-deck-session, default **visual**): at
  1024 px with the pane and panel up, a 200 px column shows stacked cards fine (the title
  band is what matters), but power users comparing prices/collector numbers want the
  dense rows. The toggle is the editor's own — it does not touch the Search view's
  grid/table preference.
- Group headers, orphan rows (no image — the flagged sentence needs its text), the maybe
  scratchpad, drag targets/indicator, and the stats block all carry over unchanged.

## Sequencing

Plan 4 is closing (final review + fix wave in flight). These four land as the next plan —
suggested order: the visual deck builder first (it is the surface the other three touch),
then the backend swap command + pane features (printing swap, hover preview), then the
drag extension — each task with the established review loop, CDP verification, and the
binding frontend-design direction.
