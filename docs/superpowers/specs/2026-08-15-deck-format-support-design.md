# Deck import and export: the formats people actually have

**Date:** 2026-08-15
**Status:** approved, ready for a plan

The importer reads one shape well — a count, a name, an optional `(SET) 123` — and five section
words. Everything a deck site writes *around* that is thrown away or misread. This closes it:
the parser reads the decorations, the categories in a file become piles in the deck, and the
exporter learns to write the four sites back. Nothing about the resolver changes.

## What is broken today, measured

`parseDecklist` over a 21-line slice of a real Archidekt export (this worktree, 2026-08-15):

| | |
| --- | --- |
| Card lines that parse cleanly | 6 of 10 |
| Card lines whose name swallows the tail (`^Keeper,#4aab08^`) | 4 of 10 |
| Category headings imported **as cards** | 5 |
| Cards filed into the command zone | **all of them** |
| `ParseIssue`s raised | **0** |

The command zone is the one that matters. `Commander` is the first heading and the only heading
`SECTIONS` knows, so `section` never moves off it — a 105-line Archidekt export imports as a
105-card command zone, silently, and every category the reader built is stripped as decoration.

## The corpus this is designed against

Three real exports of **one deck**, held verbatim as fixtures. Every number here is counted, not
remembered, and `parse.test.ts` re-counts them rather than trusting this page.

| Fixture | rows | headings | card lines | copies | `()` | `^tag^` | `//` names | `{noDeck}` first |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `ARCHIDEKT_SECTIONED` | 132 | 14 | 105 | 117 | 0 | 44 | 7 | 17 |
| `ARCHIDEKT_FLAT` | 88 | 0 | 88 | 100 | 0 | 43 | 5 | 0 |
| `EMPTY_HINT_LIST` | 88 | 0 | 88 | 100 | 33 | 0 | 0 | 0 |

Three cross-checks fall out of that table, and they are worth more than any assertion invented
for the purpose:

* **105 − 17 = 88** and **117 − 17 = 100.** The two flat lists are the sectioned one *minus its
  maybeboard*, so a change that mis-handles `{noDeck}` breaks the arithmetic between two
  fixtures rather than one number in one test.
* **The sectioned list is `REFERENCE_LIST`.** Its 105 names and 117 copies are the list this
  feature was designed against in `2026-08-12-deck-import-design.md`, with printings, categories
  and tags added. So the Archidekt fixture must parse to the same 105 names.
* **14 headings, 14 distinct first-bracket names, identical sets.** The heading and the bracket
  never disagree in a real export, which is what makes the bracket safe to prefer.

`EMPTY_HINT_LIST` writes **front faces only** — `Branchloft Pathway`, not
`Branchloft Pathway // Boulderloft Pathway` — and `ARCHIDEKT_FLAT` writes the whole name. Both
resolve: `resolve_lines` has `BY_FRONT_FACE` and `BY_SET_AND_FRONT`, and `hint_names_the_card`
accepts a front face through `fold_rank`. Nothing on the Rust read side has to change.

## Scope

**In:** the Archidekt text exports (sectioned and flat), the Moxfield ones, Arena, MTGO. A
whole-deck export beside today's category-scoped one.

**Out, and named so nobody wonders:** Cockatrice `.cod` and MTGO `.dek` are XML and would need a
second reader beside the line parser; deckstats' `//Category` comment headings collide with the
comment rule; MTGGoldfish and Deckbox write `[SET]` where Archidekt writes `[Category]`, which is
the same syntax with the opposite meaning. None are in this branch. **`*F*`/`*E*` stay stripped
on import and are never written on export** — `deck_cards` has no finish column, because a deck
names a printing and not a finish, and inventing one here would be a schema change in a branch
about text formats.

## 1. The parser reads five new things, and every rule stays per-line

`parse.ts`'s founding rule holds: no format detector, no verdict about the file before a line is
read. Four of the five below are pure per-line rules; the fifth needs one line of lookahead and
is fenced accordingly.

### 1.1 An empty printing hint

`1 Aerith, Last Ancient () 76` is 33 of `EMPTY_HINT_LIST`'s 88 lines and resolves to nothing
today, because `LINE`'s set group is `\w{1,10}` and `()` fails it — so the whole tail stays in
the name. It becomes `\w{0,10}`, and an empty match reads as `setCode: null` with the collector
number kept.

`Erase (Not the Urza's Legacy One)` is still safe: the hint is anchored to the end and a set code
may hold no spaces, so a parenthesised phrase can never satisfy it and the lazy name grows past
it. That property is unchanged by widening the count to zero.

**What it costs, stated up front:** `resolve_lines` sets `hint_missed` for a collector number
with no set beside it — a number is not unique across sets, so it can only ever narrow one — and
that arm is reached now where it was not before. So `EMPTY_HINT_LIST` previews **33 hint
misses**. That is true, and the alternative is 33 unresolved cards.

### 1.2 The tag suffix

`^Keeper,#4aab08^` survives `MARKERS` today because the `#` arm requires whitespace in front of
the `#` and this one follows a comma. A new marker, anchored to the end like its siblings:
`/\s+\^[^^]*\^$/`. 44 of `ARCHIDEKT_SECTIONED`'s 105 lines carry one; one of them is
`^Fence (flavor),#fa890d^`, so the pattern may not assume the tag is one word.

### 1.3 The category bracket, read instead of stripped

`[Land,Maybeboard{noDeck}{noPrice}]` is stripped and discarded today. It becomes the line's
category:

* Split the bracket on `,`. **The first entry is the pile** — verified against both fixtures: in
  the sectioned export the first entry is always the heading the line is printed under, in all
  105 lines.
* Strip `{flag}` suffixes off each entry. `{top}`, `{noDeck}`, `{noPrice}` are Archidekt's;
  anything in `{}` is a flag and never part of a name.
* **`{noDeck}` on the first entry marks the line excluded** — Archidekt's word for "counts toward
  nothing", which is this app's `is_active = 0`. 17 of 105 lines, 17 copies. A `{noDeck}` on a
  *later* entry means the card is also filed in some maybeboard and is still in the deck; 4 lines
  in `ARCHIDEKT_FLAT` are exactly that, and all 4 stay in the deck.
* **A first entry that is a known section word sets the section rather than a category name.**
  `[Commander{top}]` is `section: "commander"`, `[Maybeboard{noDeck}{noPrice},Creature]` is
  `section: "maybeboard"`. This is what keeps the command zone and the four seeded piles reached
  by the one existing mechanism instead of by a second one.

### 1.4 Section headings that are category names

An unknown heading — `Flash Enabler`, `Counters`, `Stax` — becomes a named category on every line
under it. Known words (`Deck`, `Commander`, `Sideboard`, `Companion`, `Maybeboard`, and the
existing spellings of each) keep meaning what they mean.

### 1.5 Telling a heading from a card — the one hard rule

`Anthem` and `Land` are indistinguishable from card lines to a per-line reader, and a custom
category name *can* be a real card (`Fog`, `Wrath`, `Duress`). The test:

> A line is a section heading when
> **(a)** it is a known section word, **or**
> **(b)** it carries no quantity, no printing hint and no bracket, **and** the next non-blank
> line carries an explicit quantity, **and** it is either preceded by a blank line **or** is the
> first line of the file with that next line carrying a `[bracket]`.

Why each clause is there:

* **The lookahead** is what leaves a bare-name list alone. `Sol Ring` followed by
  `Arcane Signet` fails it, so a list with no counts at all still reads as cards.
* **It also makes an empty section impossible**, which is what keeps "nothing is ever silently
  dropped" true: a line consumed as a heading always opened at least one card.
* **The blank-line requirement** is what stops `Sol Ring` / `4 Shock` — a hand-written list
  mixing bare names with counted ones — losing its first card.
* **The first-line carve-out** exists because an Archidekt deck with no commander opens on an
  unknown heading with nothing above it, and it is fenced on the *next* line carrying a bracket
  because Archidekt writes one on all 105 of its lines while a hand-written list writes none.

**The failure mode it keeps**, named rather than hidden: a hand-written list with a blank line,
then a bare card name, then a counted line, loses that name. No exporter in scope emits that
shape.

### 1.6 The types

```ts
export type SectionKind = "deck" | "commander" | "sideboard" | "companion" | "maybeboard";

export interface ParsedLine {
  // …unchanged fields…
  section: SectionKind;
  /** The pile the *file* named — a bracket's first entry, else an unknown heading's own
   *  name. `null` when the file named none, which is every list with no categories in it. */
  categoryName: string | null;
  /** The file said this card counts toward nothing — Archidekt's `{noDeck}`. */
  excluded: boolean;
}
```

`Section` is renamed `SectionKind` to say what it now is: the fixed word the rules read, beside a
name that is the user's. That is the deck category model's own distinction, applied to a parsed
line.

## 2. The categories in the file become piles in the deck

`plan.ts`'s `categoryFor` becomes one chain, and it is the app's existing precedence with one rung
inserted:

```
forcedCategoryName          the right-click aimed the import at a pile
  > line.categoryName       the file named one
  > SECTION_CATEGORY[kind]  the file named a section
  > autoCategoryFor(…)      nobody named one; file it by what the card does
```

`autoCategoryFor` is untouched and stays the app's one filing rule. The four seeded names are
still spelled exactly, so `Sideboard` lands on the seeded `side` row through
`category_for_name`'s find-before-create. Everything else — `Flash Enabler`, `Counters`, `Stax` —
is created as an `origin='auto'` pile, and a name the reader already has keeps its own `origin`,
which is what that column exists for.

`PlannedCard` and `ImportItem` gain the excluded flag; `tallyOf` ORs it with the existing
`name === "Maybeboard"` test so the preview says which piles will count toward nothing before the
import runs.

**The command zone still outranks everything**, applied in `toImportItems` after the pile is
chosen, exactly as it is today.

## 3. `{noDeck}` reaches the database — the one thing that crosses the boundary

`deck_import_commit` creates every pile active. Without a change, importing this deck puts 17
maybeboard cards into a 100-card commander deck and the validation panel reports a deck nobody
built.

`ImportItem` gains `inactive: bool` (`#[serde(default)]`, so every existing caller is unchanged),
and `commit_import` switches a pile off **only when this import created it** — the `existed`
lookup it already makes for `categories_created` is the same fact, so no second query is needed. A
`{noDeck}` name the reader already has keeps whatever they set: an import must not reach into
filing the reader did by hand.

This is the whole of the Rust change. `resolve_lines` is untouched; so is every read.

## 4. Export: import is permissive, export is canonical

The parser reads every variation a site emits. The writer emits **one** spelling per site — the
existing rule that a file this app wrote should have one answer.

`ExportCard` widens from four fields to include `categoryName`, `categoryKind` and
`categoryActive`. It stays a `Pick<DeckCard, …>`, so a whole `DeckCard` still satisfies it and
`format.ts` stays pure: sections come out in the **first-appearance order of the input array**, so
the caller's order is the file's order and no second argument is needed.

| Key | Label | Writes |
| --- | --- | --- |
| `plain` | Plain text | `1 Name` — unchanged |
| `mtgo` | MTGO | `1 Name`, with `SB: ` on side and companion cards |
| `arena` | Arena | `Commander` / `Companion` / `Deck` / `Sideboard` headings, `1 Name (SET) 123` |
| `moxfield` | Moxfield | `Commander` / `Companion` / `Deck` / `Sideboard` / `Maybeboard` headings, `1 Name (SET) 123` |
| `archidekt` | Archidekt | category-name headings, `1x Name (set) cn [Category]` |
| `csv` | CSV | a `Category` column added to today's four |

Five decisions inside that table:

* **`mtgo` stops being byte-identical to `plain`.** It has been since it was written, because
  there was no whole-deck export and so no sideboard to prefix. There is now.
* **A fixed-vocabulary format files a reader's own pile by its `categoryKind`.** `Flash Enabler`
  is `kind: "main"`, so it goes under Moxfield's and Arena's `Deck`. Only `archidekt` and `csv`
  carry the name, which is the honest division: two formats have somewhere to put it and three
  do not.
* **`archidekt` writes `{noDeck}` on an inactive pile** — `1x Card (set) cn [Maybeboard{noDeck}]`
  — because it is the one format that can say it, and without it an export and a re-import lose
  the 17 cards this whole design exists to keep. It is the round-trip that makes the flag worth
  writing, not fidelity to Archidekt for its own sake.
* **`arena` and `mtgo` write only active piles**, because neither format has a maybeboard and
  writing one into an Arena deck produces an illegal import at the other end. The test is
  `categoryActive`, never the kind — `is_active = 0` is the whole of what `maybe` means, and a
  reader's own switched-off pile behaves the same way. The dialog says how many cards a format
  left out, so this is never silent.
* **`archidekt` writes the set code lowercase**, which is what Archidekt itself emits and what
  its own importer round-trips; every other format uppercases. Our parser uppercases on read, so
  the round-trip test is unaffected either way.

The round-trip test extends to every format **the parser can read**: what each one writes,
`parseDecklist` reads back to the same cards *and the same piles*. **`csv` is write-only and
stays so** — nothing in `parse.ts` reads a comma-separated decklist, and adding a CSV reader is
a second grammar rather than a rule inside the one there is. The test asserts that exclusion by
name so it cannot be mistaken for an oversight.

## 5. A whole-deck export

`Export deck` joins `Import cards` / `Categories` / `Tags` / `History` / `Deck settings` on the
editor's header row, opening the same `ExportDialog` over `deck.cards` for the variant on screen.

* **Named for its scope**, not `Export cards`, so it does not collide with the category menu's
  row — the same reasoning that made the toolbar's button `Import cards` rather than `Import`.
* **`ExportDialog` still fetches nothing**; the cards are an argument, which is the property that
  made a deck-level export a caller rather than a rewrite.
* **It costs width on a row that already wraps.** The actions block measures 825px against the
  729px a 1280×800 window spares, so the wrap is pre-existing and one more button makes it
  slightly worse. To be measured in the shipped window, not guessed.

## 6. Testing

Unit, in the layer that owns each rule:

* `parse.test.ts` — the three fixtures, every count in the corpus table re-counted rather than
  asserted from this page, plus the three cross-checks: sectioned − `{noDeck}` = flat, and the
  sectioned list's 105 names equal `REFERENCE_LIST`'s.
* `parse.test.ts` — the heading rule's four clauses, each with the list it protects: a bare-name
  list, `Sol Ring` / `4 Shock`, an Archidekt export opening on an unknown heading, and a heading
  that opens nothing (which must be unreachable).
* `plan.test.ts` — the precedence chain at each rung, `{noDeck}` on the first entry versus a
  later one, `[Commander{top}]` reaching `fromFile`.
* `format.test.ts` — round-trip per format, and the empty list staying `""` in all six.
* `deck_import.rs` — a created pile switched off, an existing pile left alone, and
  `categories_created` still counting what it counted.

Live, in the shipped window, because a green suite has never been enough here: all three
fixtures imported end to end, the piles they land in, and the deck's size afterwards — 100 with
17 in switched-off piles, not 117.

## 7. What this does not do

* No finish on a deck card, so no `*F*` in either direction.
* No XML readers.
* No format detector, and no site-specific parser. One reader, per-line rules, as before.
* No change to `resolve_lines`, `MATCH_ORDER`, or any other read.
