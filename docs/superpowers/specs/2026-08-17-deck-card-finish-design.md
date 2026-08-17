# A deck card names a finish

**Status**: approved 2026-08-17. **Reverses** the sentence "a deck names a printing and never a
finish", which is written into `deck.rs`, `schema.rs`, `sorting.rs`, `cardMenu.tsx`, `parse.ts`,
`src/features/decks/CLAUDE.md` and `docs/reference/decks-storage.md`. Every one of those has to
move in the same branch.

A deck can hold `1 × Sol Ring (foil)` beside `3 × Sol Ring` in the same pile, the deck's money
follows the finish, and two controls set it: the card pane's existing foil button, and a row on a
deck card's right-click menu.

## 1. Why this is not a wiring fix

The reported symptom — "switching printings always picks the regular printing" — is true and has
no bug behind it. Scryfall models foil as a **finish of a printing**, not as a printing: 53 224 of
107 337 paper printings carry a foil version of the same `id`, same set code, same collector
number. `deck_swap_printing` writes whichever printing row was clicked, and there is no other row
to click.

The card pane's foil button is `foilView`, a `useState(false)` that turns on this app's own sheen
for as long as the pane is open. Scryfall publishes **one photograph per printing and it is the
plain one**, so that control never was, and could not have been, a data write.

So the feature is a new fact on the deck card, and the deck card model is what has to grow.

## 2. Storage: schema v18

```sql
ALTER TABLE deck_cards ADD COLUMN finish TEXT
    CHECK (finish IS NULL OR finish IN ('foil','etched'));

DROP INDEX IF EXISTS idx_deck_cards_grain;
CREATE UNIQUE INDEX idx_deck_cards_grain
    ON deck_cards (deck_id, variant, category_id, card_id, coalesce(finish, ''));
```

```rust
pub const DECK_CARD_GRAIN: &str =
    "deck_id, variant, category_id, card_id, coalesce(finish, '')";
```

**No backfill, and no deck's behaviour moves.** Every existing row reads NULL, which is what it
already meant.

### 2.1 NULL means regular, and `'nonfoil'` is never stored

The CHECK is the enforcement, not a convention. Two spellings of "regular" would be two rows on
the grain that draw identically on screen and sum wrongly nowhere — the single worst shape a bug
in this table can have. `deck::normalise_finish` maps an incoming `Some("nonfoil")` to `None` at
the command boundary, in **one** place, and the CHECK is what makes any other path a hard error
rather than a quiet second row.

This is already the codebase's idiom rather than a new one: `finish.ts`'s `soleFinish` answers
`null` for a nonfoil-only printing on the stated grounds that "nonfoil is the finish a price is
assumed to be", and `wishlist_entries.preferred_finish` is nullable meaning "any".

`schema::FINISHES` is untouched — it stays the three-value vocabulary the collection, the wishlist
and `marketplace_prices` are CHECKed against. `a_finish_is_one_of_the_three_on_every_table_that_
checks_it` is scoped to tables that check the *three*, and this table checks two-and-NULL by
design; its list is amended by name so the difference is deliberate rather than an omission.

### 2.2 The `coalesce` is load-bearing

SQLite treats NULLs in a UNIQUE index as **distinct**, so a bare nullable column in a grain
enforces nothing at all — every regular row would be unique against every other regular row, and
`ON CONFLICT` would stop folding quantities. `COLLECTION_GRAIN` already wraps `serial_number` and
`grading` for exactly this; this is the third.

**Verified against SQLite 3.53.0 before it was written down** (a throwaway `node:sqlite` probe,
2026-08-17), because four of these five are the kind of thing that is discovered at a user's first
quick-add:

| # | claim | result |
| --- | --- | --- |
| 1 | `ALTER TABLE … ADD COLUMN … CHECK (…)` is accepted | OK |
| 2 | the CHECK rejects `'nonfoil'` | `CHECK constraint failed` |
| 3 | `(a, NULL)` coexists with `(a, 'foil')` — the grain widens | OK |
| 4 | `coalesce(finish,'')` defeats distinct-NULL | `UNIQUE constraint failed` |
| 5 | `ON CONFLICT (…, coalesce(finish,''))` targets the expression index and folds | `[{k,null,2},{k,foil,1}]` |

Row 5 is the whole upsert path: two regular adds accumulated to 2 while a foil add stayed a
separate row at 1. A Rust test re-runs it against the crate's own bundled SQLite rather than
trusting the probe's version.

### 2.3 One test has to stop covering this grain

`every_plain_grain_constant_names_the_index_the_head_schema_carries` reads its list through
`PRAGMA index_info`, which answers a NULL name for an expression column. `DECK_CARD_GRAIN` leaves
that list and joins `COLLECTION_GRAIN` and `WISHLIST_GRAIN` in the group the test's own doc comment
already describes — held to its index by every `ON CONFLICT` target instead, where a mismatch is a
hard error at the first write. **That doc comment says "the two grains with `coalesce(…)` in
them"; it becomes three, and the sentence naming `DECK_CARD_GRAIN` among the conflict-target group
moves with it.**

## 3. Price follows the finish

```sql
CASE WHEN dc.finish IS NULL
     THEN <printing_price_by_finish_expr(market)>
     ELSE <price_expr(market, "dc.finish")>
END
```

`price_expr`'s `finish` argument is already **the caller's expression** — the collection passes
`e.finish`, the wishlist `coalesce(w.preferred_finish, 'nonfoil')` — so this composes with all four
marketplaces and every hole travels with them: Cardmarket's missing `eur_etched` stays NULL, and a
feed that has never listed a card stays NULL. **No fallback on the set arm**, which is the rule
`finish.ts` and `sorting.rs` both already state: a foil row quoted at the nonfoil rate is a price
nobody quoted.

The NULL arm is today's `nonfoil → foil → etched` chain, unchanged, and it is the arm every
existing row takes. That chain exists because there was no finish to price at; it now means
"this row has not said", which is the same question it always answered.

`printing_price_by_finish_expr`'s doc comment currently opens "`deck_cards`' grain names a printing
and stops there, so there is no finish to price at". That is the sentence this section reverses,
and it is rewritten to say which arm it is now.

## 4. The address grows a fifth part

Every deck-card command addresses by `(deckId, cardId, categoryId, variant)` — the grain, never
`deck_cards.id`, and `DeckCard.id`'s own doc comment says so. That address takes a fifth part.

| site | change |
| --- | --- |
| `deck_add_card` | `finish` argument; the `ON CONFLICT` target is the constant, so it follows for free |
| `deck_set_card_quantity` | `finish` argument in the WHERE |
| `deck_move_card` | `finish` argument; a move keeps the finish |
| `deck_swap_printing` | `finish` argument; a swap keeps the finish, and its existing fold now folds on the five-part grain |
| `deck_set_card_tag` | `finish` argument in the WHERE |
| `deck_undo::CardRow` | grows `finish` so a restored row comes back shiny. **`Cell` does not** — see §4.1 |
| `deck_import_commit` | `ImportItem.finish` |
| `deck_category_delete` (move arm) | its fold is on the grain |
| `deck_category_clear` | scoped by category, so unchanged — named here because it is the one that looks like it needs it |
| `deck_theory::move_live_into_theory` | `variant` is in the grain, so a re-label can already collide; one more grain column is one more way, and its emptiness precondition is what keeps it true |
| `deck_theory_copy_from_live` | copies the finish with the row |
| `allocate_deck` | **no change** — see §8 |

`DeckCard` gains `finish: Finish | null`. `useDeck`'s `Slot` (`{cardId, categoryId}`) — the TS-side
spelling of the same address, used by `patchSlot`'s optimistic patch — gains it too, and the drag
payloads in `dnd.ts`, `DeckEditor`'s `setQuantityAt`/`applyDrop` and every view's row key follow.

### 4.1 The undo cell stays finish-blind, deliberately

`Op::Cards` is documented as "delete exactly `scope` and insert exactly `rows`", and a `Cell` with
a `card_id` and no finish scopes **both** rows of that printing. That is the correct scope and not
an oversight to fix: a finish change *moves quantity between two rows of one printing*, so a scope
naming one finish would delete half of what the write touched and restore half of what it read.
The wide cell deletes both and puts both back.

What has to grow is `CardRow`, which is what the restore re-inserts from — without the column a
restored foil row comes back regular, which is a silent wrong answer rather than a failure.

This was the one thing in this design that was drafted wrong and corrected by reading `Op::Cards`:
the first draft grew the cell.

## 5. The new command

`deck_set_card_finish(deckId, cardId, categoryId, variant, fromFinish, toFinish)`.

It is the only genuinely new write, and it **folds**: setting a row to a finish the pile already
holds adds the quantities and deletes the row that moved, which is `deck_swap_printing`'s existing
behaviour and its `SwapResult.folded` shape, copied rather than invented. One transaction, one
`allocate_deck`, one audit row.

Refusals, each a sentence of its own:

- the two finishes are the same — nothing to write, the way `SAME_PRINTING` reads
- the printing is not sold in the target finish — read off `cards.finishes`, so a sync that
  dropped the printing answers the same way `PRINTING_GONE` does
- no such row in that pile

The audit kind is **`swap`**, not a tenth kind. A finish change is the same act as a printing
change — the deck plays a different physical object of the same card — and `AUDIT_KINDS` is
CHECK-constrained, so a new word is a migration. The payload gains `fromFinish`/`toFinish`;
`auditText.ts` words it, because a sentence is domain logic and `deck_audit` has no `summary`
column.

## 6. The two controls

### 6.1 The card pane's button

Inside the deck editor, on a card the open deck holds, the button **writes**. Its label says what
the press does: `Set as foil` / `Set as regular` (or `Set as etched`, per §6.3). In Search there
is no deck row to write, so it keeps today's `View as foil` and today's behaviour exactly.

`foilView` seeds from the row's stored finish instead of always `false`, so the pane opens showing
the copy the deck plays.

The condition is the one `cardMenu.tsx` already established for `viewPrintingsInPane`: the surface
supplies a **fact** — which deck row, if any, this card is — and never a decision. A pane with no
deck row behind it is the Search case whatever view it is drawn in.

### 6.2 The deck card's right-click row

`deckCardMenu.tsx`, following `collectionItem`'s existing shape for the same reason (a choice with
one answer is not a choice):

- sold in **two** finishes — nonfoil + foil, the overwhelming majority — one action row that
  toggles: `Set as foil` / `Set as regular`
- sold in **three** — a `Finish ▸` submenu of the printing's own finishes, in Scryfall's order
  (`nonfoil → foil → etched`), the row's current finish greyed
- sold in **one** — the row is drawn and **greyed silently**

**Greyed silently is a decision, not an omission.** `zoneItem` in this same file is already the
menu's greyed-without-a-reason row, and its site says why; a reason string on a row that is greyed
on a large minority of cards is noise on the surface a reader uses most. The row stays *present* so
its position never moves, which is the rule the commander row and `View all printings` are both
kept by.

### 6.3 Etched

The choice offered is the **printing's own finish list**, so `Set as etched` appears on the 892
etched-only printings and on the handful sold in all three, and nowhere else. A hard two-way toggle
would be `foil: true` — the flattening `schema::FINISHES`' doc comment calls "the single most
common way an importer loses data".

## 7. What draws the mark

`card.finish ?? soleFinish(card.finishes)` — the stored fact first, the printing's own statement
as the fallback, which is exactly what is drawn today.

The reasoning that keeps both halves: `soleFinish` says what the *object* is (12 366 printings
exist only in foil), and a printing sold in both is deliberately unmarked because a sheen on 61 %
of a wall is decoration. A stored finish is a different claim — **this deck plays the shiny one** —
and it is the reader's own, so it marks.

Surfaces: `CardStack`, `GridView` (both through `CardArt`/`FoilOverlay`), and the `TableView` and
`TextView` rows, which carry `FinishMark` beside the name the way the printings list does. The
top-right chip is `FoilOverlay`'s and no other mark's — `GridView`'s copy count has already
collided there once.

## 8. What deliberately does not change

- **The allocator.** `allocate_deck` matches on **oracle id**, prefers the exact printing, and
  already ignores finish, condition, language and everything else — a Bolt is a Bolt. Making a
  foil deck row reserve a foil collection copy is a different feature with its own answer to "what
  happens when you own three regular and play one foil", and nothing in this one needs it.
- **Copy limits.** `engine.ts` groups by card **name** and sums `quantity` across every row, so
  `1 foil + 3 regular` is four copies with no engine change. This is asserted rather than assumed.
- **`schema::FINISHES`** and the three tables CHECKed against all three of it.
- **`deck_category_clear`**, which is scoped by category and never by grain.

## 9. Import and export

`parse.ts` already recognises `*F*` and `*E*` and **throws them away**, on the stated grounds that
a deck names a printing rather than a finish. It carries them now: `ParsedLine.finish`, through
`plan.ts` (still pure, still making every deck decision) to `ImportItem.finish`.

`[Foil]` in a bracket stays decoration and never a pile — `FINISH_WORDS` is unchanged. A bracket is
a *category* channel and a finish that arrived there is the exporter being loose, not the reader
naming a pile; `*F*` is the channel the formats actually agree on.

Writers:

| format | finish |
| --- | --- |
| `plain` | `*F*` / `*E*` |
| `moxfield` | `*F*` / `*E*` |
| `archidekt` | `*F*` / `*E*` |
| `csv` | a `Finish` column |
| `arena` | omitted — the format has no marker |
| `mtgo` | omitted — the format has no marker |

`decklists.test.ts`'s fixed point (export → import → export byte-identical) holds for all six: the
two that omit it omit it on both passes. **A finish is lost on an `arena` or `mtgo` round trip**,
which is the same thing already true of a category there, and is stated rather than discovered.

## 10. Testing

- **Rust.** The v18 ladder step from a v17 fixture; the five mechanics of §2.2 against the crate's
  own SQLite; a foil row and a regular row of one printing in one pile as two rows with folding
  quantities; `deck_set_card_finish`'s fold and its three refusals; the price arm on all four
  marketplaces including Cardmarket's etched hole; `deck_undo` restoring a finish change.
- **TS.** `engine.ts` counting across finishes; `parse.ts` capturing `*F*`/`*E*` (and still not
  reading `[Foil]` as a pile); `format.ts` per writer; the six-format fixed point; the menu's three
  shapes; the pane's label by context.
- **Storybook.** `.storybook/fake/db.ts` gets the column. **Ripgrep reads that file as binary**, so
  a sweep for `finish` will not find its deck-card rows — it is opened and read.
- **Live.** `npm run tauri dev`, and the pass has to reach: a foil row beside a regular row in one
  pile; the deck total moving when a row is set to foil; the sheen appearing on the deck card and
  not only in the pane; and the pane's label reading `Set as foil` in the editor and `View as foil`
  in Search. A green suite has never been evidence about this window.

## 11. Risks

Three places where this goes wrong quietly, each getting a test rather than a promise:

1. **The undo row, not the undo cell** (§4.1). `CardRow` without a `finish` restores a foil row as
   regular — a silent wrong answer, in the one feature whose failure the reader cannot see until it
   is too late to fix by hand. The *cell* is correct as it stands and must be left wide.
2. **`move_live_into_theory`.** A bare `UPDATE … SET variant` against a grain that has grown a
   column. Its emptiness precondition is what makes the collision unreachable, and that
   precondition is load-bearing for a second reason now.
3. **The prose.** Six files assert "a deck names a printing and never a finish" as a *reason* for
   something else. A prose-only edit routes to neither CI job, so nothing goes red when one is left
   standing and contradicts the code beside it.
