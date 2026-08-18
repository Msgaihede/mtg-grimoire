# All printings, as a modal

**Date:** 2026-08-18
**Status:** implemented. Plan: `docs/superpowers/plans/2026-08-18-all-printings-modal.md`. Every
measurement taken while building it — including the live CDP pass and the page-size timing this
document defers — is in
[frontend-design.md](../../reference/frontend-design.md#all-printings-as-a-modal--driven-in-the-shipped-window),
which supersedes the figures quoted below where they disagree: the printings counts here are
`card.rs`'s from 2026-08-05, and Forest had grown from 862 to **865** by the time this shipped.

`View all printings` is on the card menu of every card surface in the app. It answers a
question — _which printing do I want?_ — and today it answers it by **taking the reader
somewhere else**. This spec replaces both of its destinations with one centred modal, and adds
the filters that make a list of 862 rows usable.

## 1. What is wrong with the two destinations

The menu row has shipped with two behaviours, chosen by whether the surface is inside the deck
editor (`cardMenu.tsx`'s `printingsItem`):

- **Outside the editor** it calls `store.requestAllPrintings`, which writes `pendingCardSearch`,
  `activeView: "search"`, `selectedCardId: null`, `paneDeckContext: null`, `openDeckId: null` and
  `returnToDeckId: null` **in one `set`**. A reader on the Collection who asks which printings a
  card has is moved to the Search page, their card pane closed, and their place in a filtered
  collection lost. Coming back is a fresh search.
- **Inside the editor** it calls `viewPrintingsInPane`, which opens the 384px card detail pane.
  The pane is the right _content_ and the wrong _width_: the desk row measures 602px at the app's
  own 1280×800 with the pane docked, so the pane is subtracted from the deck whether or not it is
  being read, and a printing is picked from a one-line row with no art until a 250ms hover dwell
  produces one.

`src/CLAUDE.md` already states the rule this violates: _a surface opened from a view is a centred
modal over a scrim, not a docked column — unless the reader works out of it while editing beside
it._ Printings are **consulted**, exactly like deck history, categories and settings, all three of
which are `DeckDialog`s.

Two smaller faults go with them. The row carries a `disabled` state — _"this pane is already
showing them"_ — that exists only because one of its destinations can be the thing you are already
looking at. And `CardMenuDeps` carries three fields (`viewPrintingsInPane`, `requestAllPrintings`,
`paneCardId`) to express one intent, which every one of the twelve card surfaces has to answer.

## 2. The surface

`src/features/card/AllPrintingsDialog.tsx`, on the existing **`src/features/decks/DeckDialog.tsx`**
shell: `LAYER.overlay`, a scrim, `aria-modal`, `trapTab`, and the `"inner"` Escape rung registered
on the **open flag** rather than on the panel's mount. Width `w-[72rem]`.

`DeckDialog` stays where it is rather than being promoted to `src/components/`. It is imported
across a feature boundary, which `features/card/cardMenu.tsx` already does twice
(`@/features/decks/folders`, `@/features/decks/useDeck`); moving it would touch seven hosts and
their stories to buy a directory name.

**Mounted once, in `App.tsx`, driven by the store.** Not per surface: the row is pressed from the
two search views, the two collection views, the wishlist, the four deck editor views, the docked
panel, the card pane and the printings list, and a dialog per host is twelve copies of one
decision. One mount also means the modal opens _over_ the deck editor without the editor knowing
it exists.

`DeckDialog` renders `children` only while `open`, so the closed modal costs no query, no filter
state and no scroll position, and every open starts clean.

## 3. The store: one field replaces the navigation

```ts
/** The card a reader asked to see every printing of, and the deck slot they asked from. */
printingsRequest: { oracleId: string; name: string; deck: PaneDeckContext | null } | null;
openAllPrintings: (request: {
  oracleId: string;
  name: string;
  deck: PaneDeckContext | null;
}) => void;
closeAllPrintings: () => void;
```

`openAllPrintings` writes **one field and nothing else** — no `activeView`, no `selectedCardId`, no
`openDeckId`. That is the whole of the fix in §1.

Deleted with it: `pendingCardSearch`, `requestAllPrintings`, `consumePendingCardSearch`, the seed
in `useCardSearch` that reads them, and the oracle-card chip the Search page drew for it. Nothing
can set the search's `oracleId` filter once the channel is gone, so the frontend path goes; the
`oracleId` field on the filter type and its Rust implementation stay, because they are part of the
search contract and are tested there.

`PaneDeckContext` is already the complete swap slot — `deckId`, `categoryId`, `categoryName`,
`cardId`, `variant`, `finish` — for the reason its own doc gives: a context naming fewer parts than
`DECK_CARD_GRAIN` rewrote the wrong row twice in this codebase's history. Deck-aware surfaces hand
over the object they already build for the card pane; every other surface passes `null`.

### `CardMenuDeps` gets smaller

Three fields become one:

```diff
- viewPrintingsInPane: ((cardId: string) => void) | null;
- requestAllPrintings: (t: { oracleId: string; name: string }) => void;
- paneCardId?: string;
+ openAllPrintings: (t: { oracleId: string; name: string; deck: PaneDeckContext | null }) => void;
```

`paneCardId` has exactly one consumer — the printings fence — and goes with it. The row keeps its
**other** refusal, the one that is a fact about the card rather than about the situation: a `null`
`oracleId` still greys it with _"this printing has left the card database"_.

Inside the modal's own tile menu the row is greyed with **"you are already looking at them"**,
fenced on the oracle id the modal is open for rather than on a card id — a different printing of
the same card is the same list.

## 4. Data: the one backend change

`card::list_printings` caps its page at `MAX_PRINTINGS = 400`; Forest has **862** paper printings.
The pane can live with that because it says so in its caption (`"400 of 862 printings"`) and offers
no filter. **A filter over a truncated list lies**: narrowing to a set that falls outside the newest
400 draws an empty wall that looks like an answer rather than like a truncation.

So `card_printings` gains an optional limit:

```rust
const MAX_PRINTINGS: usize = 400;       // unchanged — the default, and the pane's
const MAX_PRINTINGS_HARD: usize = 1000; // the ceiling an explicit limit is clamped to
pub async fn card_printings(.., limit: Option<i64>) -> Result<PrintingsResponse, String>
```

**1000 is chosen against a measurement this repo already holds.** `MAX_PRINTINGS`' own doc records
it: counting paper only, _exactly five_ oracle cards exceed 400, and they are the five basic lands
— Forest 862, Mountain 840, Swamp 832, Island 827, Plains 818. Seven cards in the whole library
have more than 100. So 1000 clears the largest list in the corpus with headroom and is not a number
picked for the feel of it.

Absent means 400, so the card pane's query and its cache key are byte-identical to today's. The
modal asks for `MAX_PRINTINGS_HARD`. The query is one `WHERE oracle_id = ?` on `idx_cards_oracle`;
the cost of the larger page is to be **measured on Windows and recorded**, not asserted here.

`total` still comes back uncapped, so the caption can always tell truncation from a filter.

The TS mirror gains the argument and the query key gains the limit:
`["card", "printings", oracleId, marketplace, limit]` — two different questions, two cache entries,
and the pane is not evicted by the modal.

## 5. Filters

A new pure module, `src/features/card/printingFilters.ts`, tested on its own the way `facets.ts`
and `printings.ts` are. Rust supplies facts; every judgement below is TypeScript's.

```ts
export interface PrintingFilter {
  text: string;
  sets: string[]; // set codes
  langs: string[]; // Scryfall two-letter codes
  treatments: Treatment[];
}
export type Treatment =
  "foil" | "etched" | "promo" | "fullart" | "borderless" | "showcase" | "extendedart";
```

- **Text** — case-insensitive, trimmed, over `setName`, `setCode`, `collectorNumber` and `artist`.
  The card's own `name` is identical on every row of this list, so a literal name filter would
  filter nothing; these are the four fields that differ. Stated in the placeholder so the control
  says what it does.
- **Sets** — multi-select built **from the fetched printings**, each option carrying its count.
  Deliberately not `SetCombobox`: that control fetches ~1050 sets with facet counts, ~1040 of which
  hold no printing of this card, and its `MAX_SETS = 64` ceiling mirrors a backend truncation that
  has nothing to do with this list.
- **Language** — same shape, built from the rows, `en` first and the rest by count. Every language
  is in the response (`Printing.lang`), and on a heavily reprinted card the non-English rows are
  most of what is crowding the wall.
- **Treatments** — toggle chips over fields `Printing` already carries: `finishes` (foil, etched),
  `promo`, `fullArt`, `borderColor` (borderless), `frameEffects` (showcase, extended art).

All four are AND-ed. Options carry counts and go `disabled` at zero rather than disappearing, which
is `facets.ts`'s rule and its reason: an option that vanishes reads as a control that broke.

**Filters never fail the wall.** A `frameEffects` or `finishes` string this build has never seen
narrows nothing rather than throwing — the same total-over-open-unions discipline
`DeckHistoryDialog`'s `auditBand` keeps.

## 6. The wall

`CardGrid` is generic over `T extends GridCard = { id, name, setCode, collectorNumber, rarity }`.
A `Printing` carries all of those but `name`, so the adapter is one line:

```ts
const rows = printings.map((p) => ({ ...p, name: card.name }));
```

That buys the virtualiser, ctrl+wheel zoom, the caption strip, the corner marks, the drag payload
and the per-tile context menu — the same wall the search draws, which is what "reuse parts of the
search page" means concretely.

### Group by becomes sort by

`CardGrid` takes a **flat** `rows` array and positions rows absolutely inside a virtualiser, so
group headings cannot be interleaved without owning the virtualisation. The pane's four
`PrintingGroupBy` modes therefore become a **sort** in the modal, implemented as the pane's own
ordering with the headings simply not drawn:

```ts
const rows = buildPrintingGroups(items, mode).flatMap((g) => g.printings);
```

No second ordering rule, so artist / release date / price / set cannot drift between the two
surfaces. The mode is still `usePrintingGroupBy`'s and still persists to `app_meta`, shared with the
pane — a reader who sorts by price here finds the pane sorted by price too, which is the same
preference asked twice.

The control is labelled **Sort by** in the modal and stays **Group by** in the pane, because that is
what each of them does.

### The rest of the wiring

- `zoomSection` — a new `"printings"` member of `ZOOM_SECTIONS`. `DEFAULT_SECTION_ZOOMS` is a
  `Record<ZoomSection, number>` spelled out as a literal precisely so a new section is a **compile
  error** until somebody says what size it starts at.
- `selectedId` — the printing the deck slot currently plays, or the card the modal was opened on
  when there is no deck. This is the "you are here" mark.
- `cardMenu` / `cardMenuKey` — `buildCardMenu(printingTarget(p, card), deps)`. `printingTarget`
  moves out of `CardDetailPane.tsx` to `printings.ts` so both surfaces build one target the same
  way.
- `finish` — the foil chip, drawn only for a printing sold in exactly one premium finish. A
  printing available in both is not a foil card, and marking it as one would be a claim.
- `onNeedNextPage` — a no-op. The response is one page.
- `listKey` — `oracleId` + a signature of the filter and the sort, so a narrowed wall starts at the
  top instead of at the clamped offset of the old one.
- `label` — `"Printings of <card name>"`.

### Chrome

`DeckDialog`'s header carries the card name; its subtitle carries the count line, in the data face:

- unfiltered and uncapped — `862 printings`
- unfiltered and capped — `1000 of 1204 printings`, a state no card in the corpus reaches today
  (§4); the caption is kept so a future reprint cannot make the wall lie
- filtered — `showing 37 of 862 printings`

Under the header, a filter row; under that, the wall as `min-h-0 flex-1`, since `CardGrid` owns its
own scroll container and virtualiser and needs a bounded parent.

A wall with no rows draws the reason it has none: _no printings match these filters_, with a control
that clears them. That is not the same sentence as a card with no printings at all.

## 7. What a press does

**From a deck row** — the modal mounts `useSwapFromPane(deckRow, variant)`, the same hook the card
pane presses, which reaches `deck_swap_printing`. A press swaps the slot and closes the modal.

Click-commits rather than select-then-confirm, for the reason the pane's `PrintingRow` gives: the
row _is_ the thing the reader is pointing at, and the pane already ships this gesture. The cost the
pane pays for it — _no way to look at a printing without committing to it_ — is not paid here,
because the whole wall is art and looking is what the wall is for. A mis-press is covered by the
deck's undo.

While a swap is in flight every tile is inert, and a refusal **keeps the modal open** with the
sentence beside the wall. The pane had nowhere good to put that sentence; a modal does.

**From anywhere else** — the press opens the card detail pane on that printing (`viewPrinting`) and
closes the modal. That is the existing "go and look at this one" action, and it is what the reader
who is not building a deck asked for.

## 8. What this does not do

- **No new backend filtering.** Every filter is client-side over one fetched page, which §4's
  1000-row ceiling makes honest: the largest paper printings list in the corpus is Forest's 862,
  and no card reaches the cap. The caption goes on telling the truth if one ever does.
- **No quick-add control on the tile.** The tile's context menu already carries Add to collection,
  wishlist and deck. A fourth control on a caption strip that scales with zoom is a separate
  question.
- **No grid/list toggle.** The dense row list still exists, in the card pane, one press away.
- **The Search page loses its one-card-by-oracle-id mode.** Nothing could reach it except the row
  this spec re-points.

## 9. Testing

- `printingFilters.test.ts` — pure: each filter, the AND, the option counts, the zero-count
  disable, and an unknown `frameEffects`/`finishes` string narrowing nothing.
- `AllPrintingsDialog.test.tsx` — opens from the store; the count line in its three states; a
  filter narrowing the wall and the empty state's sentence; a press swapping from a deck context
  and closing; a press without one opening the pane; a refusal keeping the modal open; the tile
  menu's printings row greyed.
- `AllPrintingsDialog.stories.tsx` — against the Storybook fake, per `.storybook/CLAUDE.md`.
- Edits: `cardMenu.test.tsx` (one dep, one destination, the surviving refusal),
  `CardDetailPane.test.tsx` (the pane no longer a printings destination), `useCardSearch.test.ts`
  and `SearchPage.test.tsx` (the seed and chip are gone), `ipc.test.ts` (the limit argument), the
  store's own coverage.
- Rust: `card.rs` — the default is still 400, an explicit limit is honoured, and one past
  `MAX_PRINTINGS_HARD` is clamped rather than obeyed.
- `npm run verify`, then `cargo fmt` and `cargo clippy`, which verify does not run.
- **A live CDP pass in the shipped window**, per `docs/reference/live-ui-verification.md`: open the
  modal from the Collection and confirm the collection is still behind it; open it from a deck row,
  swap, and confirm the deck redraws; Escape once closes the modal and not the editor.
