# The card chin, and an exact price on every card — design

**Date:** 2026-08-26
**Status:** approved, ready to implement
**Builds on:** [the marketplace pricing spec](2026-08-12-card-marketplace-pricing-design.md),
[the price feeds spec](2026-08-12-marketplace-price-feeds-design.md),
[the deck card finish spec](2026-08-17-deck-card-finish-design.md)
**Reference:** [frontend-design.md](../../reference/frontend-design.md),
[decks-storage.md](../../reference/decks-storage.md),
[wishlist-folders.md](../../reference/wishlist-folders.md)

## The ask

Three things, in the reader's words:

1. **Every card carries a price**, wherever one exists. Not all wishlist cards have one today
   and no collection card has one at all.
2. **The price matches the exact printing and finish.** On the wishlist, an "any printing" wish
   takes the *cheapest* printing and that printing's price — today the printing never changes.
3. **Every card is drawn the way the deckbuilder draws one**: a bottom chin holding rarity, set,
   number, price. Generalized, so the styles cannot drift again.

And one thing that fell out of the third: **a foil and a nonfoil are different printings**. They
carry different prices and look different; they share only the set and the number. Where a reader
owns or wants cardboard, the app must draw them apart.

## What was measured

Against the dev database at `src-tauri/target/debug/data/mtg.db` on 2026-08-26 — 116,843 live
`cards` rows, 88 wishes, 275 collection entries, `marketplace_prices` empty (no feed has ever been
refreshed, so every figure below is TCGplayer's, which is the default and this database's setting).

| Question | Answer |
| --- | --- |
| Wishes with no price | **1 of 88** |
| Which one | **Wakka, Devoted Guardian** (FIC #477): `finishes: ["foil"]`, `usd: null`, `usd_foil: 31.18` |
| Wishes naming a finish | **0 of 88** — every one is `preferred_finish IS NULL` |
| Any-printing wishes | **0 of 88** — every one is pinned |
| Printings priced only in foil or etched | **12,849 of 116,843** (11.0 %) |
| Collection entries with no price | **0 of 275** |
| Collection printings held in more than one finish | **0 of 272** |
| Printings sold in more than one finish | **57,576 of 116,843** (49.3 %) |
| Corpus as finish-rows | **174,661** (+49.5 %) |

Two conclusions the plan rests on:

- **The wishlist gap is one SQL expression, not missing data.** The price for Wakka exists;
  `wishlist.rs` asks for the wrong finish.
- **The collection gap is purely the wall.** `CollectionRow.unitPrice` already arrives per entry,
  priced at that entry's exact finish. Nothing draws it.

## Decisions taken

- **The chin is `CardStack`'s, verbatim.** It is the one in the reader's screenshot and the only
  one that reads as part of the card rather than as a caption under it.
- **A shared component plus a shared sum**, not a shared card. See "Why not one `CardFrame`".
- **Finish splits the owned surfaces only.** Collection splits; wishlist and decks already do.
  Search, Tags and the printings modal stay one tile per printing — a browse answers "what
  cardboard exists", and 49.3 % of the corpus would appear twice for a 49.5 % larger scan.
- **The tile's action control leaves the chin** for a hover-revealed strip over the art, which is
  where the deckbuilder already puts its stepper.
- **The wishlist chin quotes the unit price**; "still to buy" stays a corner mark, **moved down
  off the printed card name**.
- **Ships as one PR**, via `auto-pr`.

## Why not one `CardFrame`

The tempting shape is one component wrapping art *and* chin for all three surfaces. It does not
survive contact with the three geometries:

- `CardStack` positions cards by **negative bottom margins** against a list of fixed height, so
  the card's total height is an input to `stackHeight(n)` and to the flip-through interaction.
- `CardGrid` **virtualises** on a `tileHeight` computed before any tile mounts.
- The deck's `GridView` is a **plain scroller** with a wrapping flex row.

A component taking all three as props is a shared component in name only. What genuinely *is*
one object across all of them is already `components/CardArt` — the frame, the picture, its retry
and the no-art fallback. **What was never shared is the foot**, and the foot is exactly what
drifted:

| Surface | Foot height at 1× | Type | Bar |
| --- | --- | --- | --- |
| `CardStack` (deck stacks) | 28px | 10px | `bg-surface`, `border-x`, `rounded-b-[7px]`, rides 4px up |
| `CardGrid.Tile` (five walls) | 25px | 12px | none — a bare caption with a 4px gap above it |
| `GridView` (deck grid) | 20px | 9px | none |

Each surface holds its own copy of "how tall is the foot", which is how three numbers became three
different numbers. So: **one component, and one function that answers the height.**

## The chin

### The component — `src/components/CardChin.tsx`

`CardStack`'s foot lifted out with named slots, and nothing else changed about it: `bg-surface`,
`font-mono text-dim`, `relative -mx-px box-border flex items-center rounded-b-[7px] border-x`,
`marginTop: -CHIN_RISE`, and every internal length a `calc(… * var(--mark-scale, 1))`.

```
● C21 · 179   ✦   $12.32   2/4
│  │           │    │        └ extra    — deck only: the shortage
│  │           │    └────────── money   — what one copy costs here
│  │           └─────────────── finish  — FinishMark, where the card has one
│  └─────────────────────────── printing — defaults to `SET · number`
└──────────────────────────── RarityGem — always, from the card
```

| Prop | Meaning |
| --- | --- |
| `rarity` | The gem. Always drawn. |
| `printing` | Overrides the default `SET · number` — the wishlist's "Any printing", the search's "12 printings". `min-w-0 flex-1 truncate`. |
| `finish` / `treatments` | `FinishMark`'s two inputs; the mark is drawn only where one of them says something. |
| `money` | The money slot, `shrink-0 tabular-nums text-text`. A `ReactNode` rather than a number, so a caller may hang a tooltip on it. |
| `extra` | After the money. Only the deck passes it — the `ownedQuantity/quantity` shortage. |
| `tone` | `"default" \| "destructive"`. The bar's `border-x` colour, which **must** match the face's own edge: a rule-breaking deck card is outlined in destructive and a `border-border` chin would put 28px of the wrong colour back through the card's left and right edges. |

`tone` exists because the chin's border paints *over* the face's along its whole height — it is
`relative` and later in the document — so the two are one line drawn by two elements and they have
to agree. That is `CardStack`'s existing note, and it is the one thing about this component that a
caller can get silently wrong.

### The sum — `chinHeight(zoom)` in `src/lib/cardZoom.ts`

Beside `cardScaleVars` and `scaled`, because that module is already where "how big is a thing on a
card at this zoom" is answered.

```ts
export const CHIN_HEIGHT = 28;   // STACK_DATA_HEIGHT, promoted
export const CHIN_RISE   = 4;    // STACK_DATA_RISE, promoted — does NOT scale
export function chinHeight(zoom: number): number   // scaled(CHIN_HEIGHT, zoom)
```

`CHIN_RISE` does not scale and that is not an oversight: it is derived from a Tailwind
`rounded-[7px]` corner, which is 7px at every zoom, so the overlap that hides the seam between the
face and the chin is 4px at every zoom too.

**There is no `chinText` function**, and that is the point of the component owning its own type.
The chin's size is `CardStack`'s class — `text-[calc(0.625rem*var(--mark-scale,1))]` — written
once inside `CardChin`. The three surfaces currently pass 10px, 12px and an inline `fontSize` of 9
respectively; after this there is one size, in one place, and `GridView` loses its `CAPTION_TEXT`
constant entirely.

`CardStack` re-exports `STACK_DATA_HEIGHT` / `STACK_DATA_RISE` / `stackDataHeight` from these so
`CardStack.test.tsx`'s geometry assertions keep their existing names and keep passing. The card's
total height is unchanged: `stackCardHeight` already subtracts the rise.

### What each surface does with it

| Surface | Height change | Money slot |
| --- | --- | --- |
| Deck stacks (`CardStack`) | none — 28px is the source | `unitPrice` at the row's finish *(unchanged)* |
| Deck grid (`GridView`) | 20 → 28px, 9 → 10px type | `unitPrice` at the row's finish *(unchanged)* |
| Collection (`CardGrid`) | 25 → 28px | `unitPrice` at that entry's finish |
| Wishlist (`CardGrid`) | 25 → 28px | `unitPrice` at the wish's finish |
| Search, Tags (`CardGrid`) | 25 → 28px | `priceRange(priceLow, priceHigh, currency)` |
| Printings modal (`CardGrid`) | 25 → 28px | `cheapestPrice(row.finishPrices)`, then `formatPrice` |
| Deck's docked Search tab (`DeckSearchPanel`) | 25 → 28px | `priceRange` — its rows are search rows |
| Deck's docked Collection tab (`CollectionSearchTab`) | 25 → 28px | `unitPrice` at that finish, newly carried by `foldCopies` |

`priceRange` and `cheapestPrice` both already exist (`src/lib/priceRange.ts`,
`src/features/card/printings.ts`) and are already the figures those surfaces' *tables* show. Using
them here means a wall and its table cannot disagree.

`CardGrid`'s `CAPTION_HEIGHT` becomes `chinHeight(zoom)` with **no `CAPTION_GAP`** — the chin is
attached to the card, not spaced under it. Net height change per tile is +3px at 1×, and
`tileHeight` is already computed from it, so the virtualiser follows with no second edit.

### The action control moves over the art

The search's `AddToCollectionButton` and the wishlist's `EditWishButton` sit at the right end of
the caption today. There is no room for them beside a price at 170px, and the deckbuilder already
solved this: `DeckCardControls` is an absolutely positioned strip over the bottom of the picture,
revealed on hover and focus, taking no layout height.

`CardGrid.Tile` gains that strip — `absolute inset-x-0 bottom-0` inside the art's `relative` box,
`REVEAL_ON_HOVER`. The `action` prop keeps its name and its callers keep passing the same element;
what changes is where the tile puts it. **The control stays in the tab order at all times** —
"visible on hover" is not a state a keyboard has — which is the rule both existing call sites
already spell out.

The popup anchoring moves with it. Both controls are passed `static` today so their 256px panel
hangs off the *caption* (a 170px tile's popup must open from the tile's left edge, because left
overflow cannot be scrolled back into view). The strip over the art becomes the `relative` box
instead, and it is the same width, so the anchoring behaviour is unchanged.

## Finish becomes identity on the owned surfaces

**There are two merges, not one, and both split.** The collection page folds rows into tiles in
`CollectionPage`'s `tiles` memo; the deck editor's docked Collection tab folds the same rows in
`collectionTiles.ts`'s `foldCopies`. They were written apart and they fold by the same key, so a
change to one alone would make two drawings of one collection disagree about what a tile *is*.

### The collection wall splits

`CollectionPage`'s `tiles` memo keys on `` `${cardId}:${finish}` `` instead of `cardId`.

Entries still merge across **condition, folder, language and every other grain term** — those are
one object at one price, and the table below is where a reader gets them apart. Only the finish
splits, because only the finish changes the price and the picture.

Three things follow for free:

- `OwnedBadge` counts that finish's copies, which is what the reader owns of that object.
- `CollectionTile.finishes` becomes exactly one finish, so a menu add **records it without
  asking** instead of falling to the unknown-list rule. That is a bug fix: a reader owning two
  foils and no nonfoil currently gets a silent nonfoil entry.
- `CardGrid`'s `selectedId` ring and its arrow walk need the tile key rather than the card id.

`GridCard` gains an optional `key` field — the tile's identity where it differs from the card's.
It defaults to `id`, so the six unsplit walls are untouched and no call site changes. `id` stays
what fetches the art and what a press opens; `key` is what rings, what `data-grid-index` walks, and
what `selectionScope` remembers.

### `foldCopies` splits the same way

`collectionTiles.ts` groups on `row.cardId` and then asks whether the entries agree about their
finish — `finishes.size === 1 ? [...finishes][0] : null` — because a tile holding a foil and a
nonfoil could not honestly be marked as either. **Splitting the key removes the question.** Group
on `` `${cardId}:${finish}` ``, and `CopyTile.finish` is never `null` for a reason the reader can
see: every tile is one finish.

`CopyTile` gains `unitPrice: number | null`, taken from the group's first row — every row in the
group now names the same printing *and* the same finish, so they all carry the same figure, and
picking the first is not a choice between two answers.

`copies` and `here` count that finish's copies. `pickCopy` is unchanged and now ranks within one
finish, which is strictly more correct: a foil tile's "add" can no longer reach for a nonfoil copy.

The **card walk is deliberately not split.** `listWalkStops` de-duplicates by `cardId`, so a
printing held in two finishes publishes one stop. That is correct: the walk drives the printings
modal's chevrons, which step through *printings*, and a modal that visited the same printing twice
in a row would be stepping through something the reader cannot see a difference in.

### Clicking a foil opens the pane in foil view

`CardDetailPane` already does this. `foilView` is seeded from `deckFinish?.finish != null`, so a
deck row naming a foil already opens showing the sheen. There is no new UI and no new image —
Scryfall publishes one photograph per printing and what the toggle turns on is `FoilOverlay`, this
app's own sheen and chip.

What is missing is the route for the fact. The store's pane openers are one action each, and every
one *clears* the fields it does not set — that is the design, and it makes "opened from a deck row"
structural rather than a rule six call sites remember. So:

- `paneFinish: DeckFinish` — the finish the pane opens showing, `null` for every opener that has
  none.
- `openCardAsFinish(cardId, finish)` — the collection wall's opener. Sets `paneFinish`, clears
  `paneDeckContext` and `paneFromDeckSearch`.
- `setSelectedCardId` and `openCardFromDeckSearch` clear `paneFinish` in their existing `set`, so
  the invariant holds without a new rule.
- `viewPrinting` leaves it alone. Browsing printings inside the pane keeps the reader's foil view,
  and `foilViewFinish` already answers `null` for a printing with no shiny finish — so a stale seed
  cannot draw a foil chip on a nonfoil-only printing.

`CardDetailPane` seeds `foilView` from `deckFinish?.finish != null || paneFinish != null`.

**One doc paragraph is now false and must be rewritten rather than left.** `foilViewFinish`'s note
says the view "says nothing whatever about which finish they own: that question is answered by a
collection entry's own `finish` and by nothing on this screen." Opened from a collection tile, it
now says exactly that.

## The two Rust changes, both in `src-tauri/src/wishlist.rs`

### 1. A wish with no preferred finish is priced at the chain, not at nonfoil

`WISH_FINISH` is `coalesce(w.preferred_finish, 'nonfoil')`, which asks a foil-only printing for a
nonfoil price and gets `NULL`. All 88 wishes in the database have no preference, and 12,849
printings in the corpus are priced only in foil or etched.

The deck solved this at schema v18 and the wishlist never adopted it.
`sorting::deck_card_price_expr` is the two-arm rule:

- **finish named** → `price_expr` at that finish and **no fallback of any kind**. The reader has
  said which object is in the sleeve; an em dash means "this marketplace does not quote this
  printing in this finish", never "look somewhere else".
- **finish `NULL`** → `printing_price_by_finish_expr`'s `nonfoil → foil → etched` chain.

The wishlist gets the same shape over `w.preferred_finish`. Cardmarket's missing `eur_etched`
survives into both arms for free, because that hole lives in `price_expr` rather than in either
wrapper.

Written as a shared builder rather than a third copy — `deck_card_price_expr` is
`deck_cards`-aliased today, so it and the wishlist's both come from one function taking the
caller's finish column. `PRICE_HOLE` and the sort templates are unaffected: `WISHLIST_PRICE_SORTS`
already orders by the `unit_price` **output alias**, so the sort follows the cell by construction.

### 2. An any-printing wish takes the cheapest printing

The join picks the printing a wish is drawn as:

```sql
LEFT JOIN cards c ON c.id = coalesce(w.card_id,
    (SELECT id FROM cards WHERE oracle_id = w.oracle_id
      ORDER BY released_at DESC, id ASC LIMIT 1))
```

`released_at DESC` becomes cheapest-at-the-selected-marketplace, at the wish's finish where it
names one and over the chain where it does not — the same expression §1 builds, so the printing
that is chosen and the price that is shown can never come from two different rules.

**An unpriced oracle card keeps `released_at DESC, id ASC`.** A wish for a card no marketplace
quotes must still have art and still have a set code; ordering `NULLS LAST` with the existing
clause as the tiebreak gives both, and makes the change a no-op for the unpriced.

This changes the **picture**, which is the point: the tile becomes the cheapest printing. The
caption still reads "Any printing" — `printingOf` is unchanged, and `WishlistGrid`'s existing note
is why: the wish is for the *card*, and a caption reading `DSK · 123` under that art would say the
reader had asked for that piece of cardboard.

`art_card_id` follows the same join, so the tile, the rarity gem and the chin's set and number all
move together. `elsewhere` does not — it counts wishes by `oracle_id` and never touches the join.

**Cost, and how it is bounded.** The subquery becomes correlated on a price expression instead of
on an indexed `released_at`. It runs once per *unpinned* wish per page — a page is at most
`MAX_LIMIT` rows, and this database has 0 unpinned wishes of 88. The feed arms
(`marketplace_prices`, keyed `(marketplace, card_id, finish)`) are a primary-key probe per
printing. It is measured on the shipped window before the PR is armed, and the figure goes in
`docs/reference/data-and-sync.md` beside the other search-performance numbers.

## The wishlist's corner, moved down

The top-left chip holds "Needs review" and the remaining cost, inset 4px so that it clears the
art's rounded corner and lands on the printed nameplate. That inset is deliberate on the *search*
wall, where the mark is a printings count; on the wishlist it covers the card's own name, which is
what the reader asked to fix.

The wishlist's corner drops to below the printed title bar — `top-9` at 1×, the clearance
`CardStack` gives its controls column, scaled by `--mark-scale` so it holds at every stop. The
chip's own box, padding and type are unchanged.

**The cost stays a corner mark and the chin takes the unit price**, because the chin means one
thing on every wall in the app: what one copy of this exact printing and finish costs. "Still to
buy" is a different question — it is `unitPrice × missing`, it is what the header's "Still to buy"
sums, and it is what the table's Cost column shows. Two figures, two places, neither ambiguous.

## Files

**New**

- `src/components/CardChin.tsx` + `.test.tsx` + `.stories.tsx`

**Frontend**

- `src/lib/cardZoom.ts` — `CHIN_HEIGHT`, `CHIN_RISE`, `chinHeight`, `chinText`
- `src/features/search/CardGrid.tsx` — the chin, `GridCard.key`, the action strip, `CAPTION_HEIGHT`
- `src/features/decks/CardStack.tsx` — render `CardChin`; re-export the promoted constants
- `src/features/decks/views/GridView.tsx` — render `CardChin`; drop its own caption constants
- `src/features/collection/CollectionPage.tsx` — split tiles by finish, chin money, `openCardAsFinish`
- `src/features/decks/collectionTiles.ts` — split `foldCopies` by finish, carry `unitPrice`
- `src/features/wishlist/WishlistGrid.tsx` — chin money, the corner moved down
- `src/features/search/SearchPage.tsx`, `src/features/tags/TagResults.tsx`,
  `src/features/card/AllPrintingsDialog.tsx`, `src/features/decks/DeckSearchPanel.tsx`,
  `src/features/decks/CollectionSearchTab.tsx` — pass the money slot
- `src/lib/store.ts` — `paneFinish`, `openCardAsFinish`
- `src/features/card/CardDetailPane.tsx` — seed `foilView`; rewrite `foilViewFinish`'s note

**Rust**

- `src-tauri/src/sorting.rs` — the two-arm price builder, generalized off `deck_cards`
- `src-tauri/src/wishlist.rs` — both changes, and `WISH_FINISH`'s doc

**Docs**

- `docs/reference/frontend-design.md` — the chin as the one card foot
- `docs/reference/wishlist-folders.md` — the two pricing changes
- `docs/reference/collection-folders.md` — finish splits the wall
- `docs/reference/data-and-sync.md` — the measured cost of the cheapest-printing join

## Testing

**Vitest.** `CardChin` renders each slot and omits the ones with nothing to say; `tone` puts the
destructive colour on both edges. Per wall, the money slot draws the right figure and an em dash
for an unpriced card. The collection split: a foil entry and a nonfoil entry for one printing
produce **two tiles with two prices**, and two folders' worth of one finish produce **one**. The
same pair of assertions against `foldCopies`, whose existing tests already run over five-field rows
— plus that `CopyTile.finish` is never `null` for a group that has entries, and that `pickCopy`
cannot return a nonfoil copy for a foil tile. `GridCard.key` rings only the tile that was pressed.
`openCardAsFinish` opens the pane in foil view and `setSelectedCardId` clears the seed.

**Cargo.** In `wishlist.rs`: a pinned foil-only wish with no preference is priced at its foil rate
(the Wakka case, as a fixture); a wish naming `foil` on a printing with both finishes gets the foil
price and **never** the nonfoil one; an etched wish is `None` on Cardmarket and priced on Mana
Pool; an any-printing wish resolves to the cheapest printing and to the newest when the oracle card
is unpriced everywhere. Every existing `wishlist.rs` price test keeps its current expectations
except the ones this spec deliberately reverses, and those are edited with the reason in the test's
own doc.

**Mutation.** Each implementer breaks their own assertion and confirms it goes red, and says so if
one survives. The rule this earns its place from: a fix can be fully tested and unreachable.

**Live.** `npm run tauri dev` and a CDP pass — the geometry is the half no suite can see. The
chin's seam at 0.5×, 1× and 2× on all three surfaces; a split collection tile pair; Wakka priced on
the wishlist; the corner clear of the printed name; the action strip revealing on hover and
reachable by Tab.

## Out of scope

- Splitting search, Tags or the printings modal by finish.
- Any change to the tables. They are already per-entry and already priced.
- `cardtrader`, which has no feed and quotes TCGplayer by a listing decision made elsewhere.
- Refreshing a price feed. `marketplace_prices` being empty is a setting the reader has not
  turned on, not a bug this spec fixes.
