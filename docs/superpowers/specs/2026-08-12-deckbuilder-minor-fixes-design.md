# Deck builder: auto-categorised adds, whole-card art, real stepper buttons

**Date:** 2026-08-12
**Status:** approved, ready to implement

Three independent fixes to the deck builder, each small, none touching the schema.

---

## 1 · A card the reader did not file goes where its type line says

### What is wrong today

`autoCategoryFor` (`src/features/decks/autoCategory.ts`) already exists — the type line and
nothing else, eight buckets plus `Uncategorised`, already swept against the four predefined
category names so it can never file a plain add into the Sideboard or the switched-off
Maybeboard. Only the Categories panel's "Auto-categorise from card types" button presses it.

Nothing on the *add* path does, and the two paths a reader actually uses miss it for a reason
that is worth writing down, because it is not the one `useDeck.ts` documents:

* `useDeck.addCard` files an add with no `categoryId` under `DEFAULT_CATEGORY_NAME`
  ("Main deck"). `useSidebarDrops.ts:142` carries a comment calling that "a placeholder for the
  rule that is coming".
* **But the panel's `+` and the toolbar quick add never take that path.** Both send an explicit
  `targetCategoryId`, which `DeckEditor` clamps to `categories[0]` on the first render that has
  a deck — and a deck's seeded categories are `PREDEFINED_CATEGORIES` in that order, so
  `categories[0]` is **Commander**. On a new deck every quick add lands in the Commander pile,
  and the field is labelled "Quick add a card to Commander".

### The rule

**An add that names no category is categorised by the card's type line; an add that names one
is untouched.** A drag names one by construction — that is what pointing at a column *is* — so
every drag keeps working exactly as it does now.

### Where it lives

On `useDeck.addCard`'s single definition, which is what `useSidebarDrops` promised. The
mutation takes an optional `typeLine`:

| `categoryId` | `typeLine` | what is sent |
|---|---|---|
| given | anything | that id — explicit, unchanged |
| absent | given | `autoCategoryFor({ typeLine })`, found-or-created by `deck_add_card` |
| absent | absent | `DEFAULT_CATEGORY_NAME`, kept as a fence |

The rule is applied in one place and the *fact* it reads travels from the call site, because
the call site is where a type line exists and the hook only ever had a bare `cardId`. That is
the round trip `useDeck.ts`'s current comment refuses, and it is refused still — nothing
fetches a card in order to file it.

A `typeLine` that is `null` or holds no bucket word answers `Uncategorised`, which is
`autoCategoryFor`'s own answer and needs no second fallback here.

### `DragPayload` gains a type line

`dnd.ts`'s `"card"` and `"search-card"` arms gain `typeLine: string | null`, validated in
`readDragData` beside the fields already there. This is for the **sidebar's Decks target**,
which is the one drop with no column to point at: it is a nav entry several views away from the
deck, so it is a destination rather than a form, and it should file by type line like the click
paths do.

All four `"card"` sources have a type line in hand at registration (`CardSummary.typeLine`,
`CollectionRow`, `WishRow`, the pane's printings), so this costs no query anywhere.

`"deck-card"` does **not** gain the field: a deck-card drag is a move or a removal, and both
name a category already.

### The "Add to" select

Gains **`Auto (by card type)`** as its first option and its default.

`DeckEditor`'s `targetCategoryId` already uses `0` as a sentinel that no `deck_categories.id`
can collide with ("nothing picked yet", replaced by the clamp on the first render with a deck).
That sentinel becomes the value meaning **Auto**, and the clamp narrows to what it was always
for: replacing an id that has been renamed away, switched off or deleted. Nothing then replaces
`0` with `categories[0]`, which is what removes the Commander default by construction.

An explicit pick **stays** picked, so filing ten cards into the Sideboard from the keyboard is
one choice and then ten presses.

### Two labels stop lying

* The quick-add field is named "Quick add a card" under Auto, and "Quick add a card to
  Sideboard" when a category is picked.
* Each tile's `+` names the pile it computed — "Add Sol Ring to Artifact" — so the reader knows
  where a press lands before making it. Under an explicit pick it keeps naming that category.

### What does not change

`deck_add_card`'s signature, the audit row an add writes, the allocator's triggers, and every
drop target in the editor.

---

## 2 · A deck card is the whole card

### What is wrong today

`CardStack` and `views/GridView` each rebuild a card out of three bands — a title bar, a
window holding the **`art` crop** (626×457, the illustration with no printed frame), and a data
line. The reader cannot see what is actually in the deck: no frame, no type line, no rules
text, no P/T.

### The change

Both surfaces draw the **whole card** (`grid`, 488×680) and the app's own chrome becomes
overlays on it. The image *is* the card.

* **Top strip:** the quantity chip, the tag dot and the game-changer badge, **right-aligned**.
  Right, not left: the printed name is left-aligned and a collapsed stack is read down its
  reveal strip, so the chip may not cover the one thing that identifies the card. It covers the
  printed mana cost instead, which is the lesser loss — the table view, the card pane and the
  curve all still carry the cost.
* **Bottom strip:** rarity gem, set · collector number, unit price, and the shortage figure —
  what the data line held. Covered by the next card in a collapsed stack, exactly as today.
* `FoilOverlay` and `RuleBreakMark` are unchanged; both already sit over the picture.
* `identityTint` **goes**. It tinted the app's title bar to say the card's colour identity; the
  printed frame is that colour.

### The geometry

The column is a fixed `14rem` (`StackView`'s `COLUMN_WIDTH`), not a measurement — so a card's
height stays a **constant** and `stackHeight` stays a function of the count alone. Nothing has
to observe its own box.

```
column 224 − section p-1.5 (6 + 6) = 212 inner
card border (1 + 1)                = 210 of image
210 × 680/488                      = 292.6
+ borders                          → STACK_CARD_HEIGHT = 295   (was 312)
advance stays 34 (the reveal strip) → STACK_COLLAPSED_MARGIN = −261  (was −278)
```

`STACK_ADVANCE`, `stackHeight` and the lifted margin keep their present shape and their present
relationships; only the two numbers move, and `CardStack.test.tsx` asserts the relationships
rather than the constants wherever it can.

The image is drawn `object-cover`. 210:293 against a card's true 210:292.6 crops **0.4px**,
which is invisible and is worth taking to guarantee no letterbox bar ever appears between the
overlay strips and the frame.

Grid tiles keep their 150px width and become **150 × 211**. No name line is added, and that is
the app's existing answer rather than a new one: the search wall already draws full `grid` cards
at 150–170px and a reader identifies them by frame and art. The button's accessible name still
carries the whole sentence, and `GroupHeader` still names the pile.

### `TheoryDiffDialog` stays on `art`

Its picture is a 32×44 decoration in a text list that spells the card's name out immediately
beside it, so identification is already solved there; a whole card in that box would be 23px
wide. It keeps `cardImageUrl(…, "art")` and therefore keeps fetching on demand — a dialog the
reader opens deliberately, like the cover picker's tiles.

### Deck **covers** are untouched

The gallery's deck tiles, its folder strips and `DeckSettingsDialog`'s picker and preview stay
on `art`, and must: `images::encode_cover` re-encodes a user's own file to exactly 626×457 so a
custom cover and a card cover are interchangeable in one tile at one aspect ratio.
`images::COVER_VARIANT` is that promise. `DecksPage`'s `prefetchImages(…, "art")` is warming
covers and stays as it is.

### Two consequences worth having

* **The standing artist-credit gap closes for both surfaces.** Scryfall's image policy requires
  the illustrator to be named wherever the art crop is shown; a `grid` image carries its printed
  credit. `CardStack` and `views/GridView` are two of the four surfaces CLAUDE.md records as
  drawing an uncredited crop. The remaining two are the theory diff and the cover picker.
* **`images::DECK_PREWARM` becomes `Variant::Grid`**, which is `COLLECTION_PREWARM`. The two
  arms of `prewarm_keys` coalesce, so a card that is both owned and in a deck is **one** cache
  key again rather than two — the split that constant was created to describe. `DeckEditor`'s
  `prefetchImages(ids, "art")` becomes `"grid"`, and `images.rs`'s doc comment on that constant
  is rewritten: it has said "the variant every deck surface draws" since it was added, and it
  will now be true of the two that draw a card and false of the four that draw a cover or a
  32px decoration.

---

## 3 · `−` and `+` are buttons, not spinner steps

`QuantityStepper` already draws a bordered `−` button, a free-typed `<input type="number">` and
a bordered `+`. Nothing in it or in `index.css` suppresses the input's **native** spin buttons,
so WebView2 renders its own ▲▼ inside the field as well — and at the deck's `xs` size the field
is 32 × 20px, where two native steps crowd the digits out of a box that has to hold "10".

The fix is on the component, so it lands everywhere the stepper is drawn: `appearance: none`
plus the `::-webkit-inner-spin-button` / `::-webkit-outer-spin-button` pseudo-elements. The
app's own two buttons become the only steps, and the field stays free-typed — which is the half
of this that already worked and must keep working (`12` is one action; pressing `+` eleven times
is eleven).

**Placement is unchanged.** The stepper stays in `DeckCardControls`, revealed on hover and on
`focus-within` (`REVEALED_ON_CARD`), re-anchored above the new bottom overlay strip. `opacity`
rather than `hidden` stays load-bearing for the same reason it always was: `display: none`
would take the controls out of the tab order, so a bar revealed by `group-focus-within` could
never be focused into.

---

## Testing

* **Unit.** `autoCategoryFor` is already covered. New: `useDeck.addCard` sends the computed name
  when no `categoryId` and the id when there is one; `readDragData` round-trips `typeLine` and
  still refuses a payload without a valid `cardId`; `DeckEditor`'s Auto default survives a
  category being deleted under it.
* **Existing tests that must move with the code.** `CardStack.test.tsx` (the geometry numbers),
  `DeckEditor.test.tsx` (the `prefetchImages(…, "art")` expectation, the quick-add label, the
  `deckAddCard` argument list), `DeckSearchPanel.test.tsx` (the select's options), and the
  `readDragData` equality assertions in `SearchPage`, `CollectionPage`, `WishlistPage`,
  `CardDetailPane`, `CardGrid` and `AppShell` tests.
* **Stories.** `CardStack.stories.tsx` asserts `stackHeight` arithmetic inline and needs the new
  numbers. Re-count the story and docs totals in CLAUDE.md if any story file is added.
* **`npm run verify`** before each commit, which is build + lint + Vitest + `cargo test`.
* **The shipped window is not covered by any of that.** Whether a `grid` image decodes in the
  real WebView2 has never been seen on this machine — `cards.scryfall.io` is behind a path-MTU
  black hole (CLAUDE.md records the diagnosis). So the image half of item 2 ships with its
  geometry proven by tests and its *pixels* unproven, and that limit is stated rather than
  glossed.

## Out of scope

The three bugs CLAUDE.md's live pass recorded — the editor title row collapsing the deck name,
the gallery never drawing a custom cover, the table view starving the card name — are untouched
here.
