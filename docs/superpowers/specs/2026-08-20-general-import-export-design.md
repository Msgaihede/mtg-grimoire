# Import and export anywhere

**Status**: approved 2026-08-20. **Moves** every file under `src/features/decks/import/` and
`src/features/decks/export/`, renames `src-tauri/src/deck_import.rs` and two of its commands, and
promotes `src/features/decks/DeckDialog.tsx` out of the deck surface. The Import section of
`src/features/decks/CLAUDE.md` moves with the code.

A reader can import a list of cards into their deck, a new deck, their collection or their
wishlist, and export any list of cards they are looking at — from the deck editor, the collection
and the wishlist — in any of seven formats, choosing which fields the file carries.

## 1. Why this is a move rather than a build

Almost every piece already exists and is already destination-blind. What is deck-specific is a
thin layer at the top, and it is the only layer that needs a sibling per destination.

| Piece | Today | What it actually knows about decks |
| --- | --- | --- |
| `export.rs` (64 lines) | `export_write_file(path, contents)` | Nothing. Writes any string anywhere. |
| `deck_import_resolve` | `{name, setCode, collectorNumber}[]` → printing ids | Nothing. Only its name says deck. |
| `deck_import_read_file` | path → string | Nothing. Reads any file. |
| `parse.ts` (515 lines) | text → `ParsedLine[]` + `ParseIssue[]` | Nothing. Its one import is a `DeckFinish` type. |
| `DeckDialog.tsx` | The modal shell | Nothing. Imports `lib/` only, and `features/card/AllPrintingsDialog` already borrows it across the feature boundary. |
| `format.ts` (7 writers) | `ExportCard[]` → text | Three category fields, and grouping by them. |
| `ExportDialog.tsx` (343 lines) | Takes `cards` as a **prop** | Only the title wording. |
| `add_entry` / `add_wish` | `(conn, &Input) -> EntryChange` | Pure connection functions; a bulk command is a loop in one transaction. |
| `plan.ts` (511 lines) | `ParsedList` → `ImportItem[]` | **Everything.** Categories, commanders, sections, auto-filing by Oracle tag. |
| `deck_import_commit` | items → deck writes | **Everything.** |

So the framework is: give the destination-blind pieces a home that isn't the deck's, and give the
two deck-specific ones three siblings.

## 2. Module layout

```
src/features/transfer/
  TransferCard.ts             the one card shape both halves speak
  fields.ts                   the field registry and the intersection rule
  csv.ts                      RFC 4180, read and write, shared by both halves
  export/
    format.ts                 the seven writers, field-aware
    ExportDialog.tsx          generic; cards + surface descriptor
    scope.ts                  a filter becomes a whole list (the paged sweep)
  import/
    parse.ts                  moved unchanged, plus a CSV arm
    ImportDialog.tsx          generic shell: source -> preview -> commit
    useImport.ts              resolve, read-file and the four commits
    destinations/
      deck.ts, DeckPreview.tsx
      newDeck.ts, NewDeckPreview.tsx
      collection.ts, CollectionPreview.tsx
      wishlist.ts, WishlistPreview.tsx
    shared/
      Tally.tsx, ProblemList.tsx, ModeRadios.tsx, SourceStep.tsx
  CLAUDE.md                   the rules that leave src/features/decks/CLAUDE.md
src/components/Dialog.tsx     <- DeckDialog, renamed; ~10 call sites re-pointed
```

`src/features/decks/import/` and `src/features/decks/export/` cease to exist. `plan.ts` moves in
as `destinations/deck.ts` unchanged in substance; `decklists.test.ts` moves with it.

**"Transfer" is not the tradelist.** `tradelistQuantity` is a collection field meaning "copies I
will trade away"; this module is about files. The word is used here in its file-io sense and
nowhere else in the app, which is why the collision is worth one sentence rather than a worse
name.

## 3. `TransferCard`: the one shape

```ts
export interface TransferCard {
  /** Identity. Always present. */
  name: string;
  quantity: number;
  setCode: string | null;
  collectorNumber: string | null;
  finish: DeckFinish;
  lang: string | null;
  /** Everything below is nullable because no surface supplies all of it. */
  categoryName: string | null;
  categoryKind: CategoryKind | null;
  categoryActive: boolean | null;
  condition: string | null;
  tradelistQuantity: number | null;
  purchasePrice: number | null;
  purchaseCurrency: string | null;
  acquiredAt: string | null;
  acquisitionSource: string | null;
  serialNumber: string | null;
  grading: string | null;
  altered: boolean | null;
  signed: boolean | null;
  proxy: boolean | null;
  misprint: boolean | null;
  tags: string | null;
  notes: string | null;
  setName: string | null;
  rarity: string | null;
  typeLine: string | null;
  unitPrice: number | null;
}
```

Three adapters — `fromDeckCard`, `fromCollectionRow`, `fromWishRow` — and nothing downstream of
them knows which surface it came from. `null` means **this surface does not have this fact**, not
"empty": that is what the registry reads to decide a field is unavailable rather than blank.

`ExportCard` (today's `Pick<DeckCard, …>`) is deleted. A whole `DeckCard` no longer satisfies the
export shape by structural luck; it goes through `fromDeckCard` like everything else.

## 4. The field registry, and the intersection rule

One record, `TRANSFER_FIELDS`, keyed by field id:

```ts
interface TransferField {
  label: string;        // the checkbox's word
  csvHeader: string;    // the column name, and what the CSV reader matches on
  read(card: TransferCard): string;   // "" when the card has nothing
}
```

Field ids are **atomic**: `setCode` and `collectorNumber` are two fields, not one `printing`.
That is what lets Moxfield's `1 Bolt (2X2)` — a real, accepted line — fall out of the composer
without a special case, and it is what makes a CSV column list a straight map of the chosen set.

Then two independent declarations, and the dialog draws their **intersection**:

- **A format** declares `always` (what it cannot omit: `quantity` and `name`, in every format) and
  `optional` (what the reader may toggle), with `defaultOn` reproducing today's output byte for
  byte.
- **A surface** declares `available` — the fields it can actually supply.

| Format | `optional` |
| --- | --- |
| plain | `finish` |
| mtgo | — (the `SB:` prefix is structure, not a field) |
| arena | `setCode`, `collectorNumber` |
| moxfield | `setCode`, `collectorNumber`, `finish` |
| archidekt | `setCode`, `collectorNumber`, `finish`, `category` |
| tcgplayer | `setCode`, `collectorNumber` |
| csv | every field the surface has |

CSV's `always` is `quantity` and `name` like everything else, so a CSV always has those two
columns and a file this app wrote is always readable back by the rule in §7.

| Surface | `available` beyond identity |
| --- | --- |
| deck | `category`, `setName`, `rarity`, `typeLine`, `unitPrice` |
| collection | `condition`, `tradelistQuantity`, `purchasePrice`, `purchaseCurrency`, `acquiredAt`, `acquisitionSource`, `serialNumber`, `grading`, `altered`, `signed`, `proxy`, `misprint`, `tags`, `notes`, `setName`, `rarity`, `typeLine`, `unitPrice` |
| wishlist | `notes`, `unitPrice`, `rarity`, `typeLine` |

`WishRow` carries no `setName`, which is why the wishlist's list is the shortest — a wishlist row
names a set code and nothing about the set. `preferredFinish` is `null` for "any", and maps onto
`TransferCard.finish`'s own `null`, which already means the regular copy.

One `availableFields(format, surface)` function, one test file. The Archidekt radio on a wishlist
export therefore shows no category checkbox — the wishlist has no categories — and the same radio
on a deck does. Arena shows no finish box, because the format has nowhere to put one. Nobody
maintains a per-surface list of what to hide.

**An untouched dialog writes exactly what it writes today.** `defaultOn` is pinned by a test that
renders each format at its defaults over the existing fixtures and compares against the strings
`format.test.ts` already asserts.

## 5. Export

### 5.1 The writers compose

A line writer stops being a fixed template and composes from the chosen set, in a fixed channel
order: `quantity`, name, `(SET)`, collector number, `[Category{noDeck}]`, `*F*`. CSV's columns
**are** the chosen fields, in registry order. Nothing about the existing shapes changes at the
defaults; what changes is that each segment now asks the set whether it is on.

`EXPORT_FORMAT_EXTENSION` is unchanged.

### 5.2 Sections need a surface that has them

`arena`, `moxfield` and `archidekt` write headings. A collection and a wishlist have no
categories, so `sectionOf` answers `null` for them and those three formats write **one flat
list**. `omittedCount` — the "not written in this format" line — is 0 on any surface with no
switched-off piles, which is both of them, and the line therefore does not draw.

The same line grows a second sentence for fields: switching off a field the surface *does* have is
reported before Copy is pressed, on the existing `text-dim` line beside the format. Nothing has
failed, so it stays an ordinary paragraph rather than a `role="alert"`, for the reason already
written at that site.

### 5.3 Formats with no condition channel merge entries

A collection holds 2 NM + 1 LP Lightning Bolt as **two rows** — that is `COLLECTION_GRAIN`, and
the grain is deliberate. A plain-text export must write `3 Lightning Bolt`, not three lines
naming the same card, because the format has no channel that could tell them apart and a reader
pasting that into Moxfield would get a deck with a duplicate.

So: **before writing, entries are folded on the identity the chosen field set can express.** Two
rows that differ only in a field nobody selected become one row with the quantities summed. Turn
Condition on in a CSV and they separate again, because now the file can say why they are two.
This is one function, `foldForFields(cards, fields, discriminator?)`, and it is the single most
testable rule in the export half.

**The key must include every fact the writer branches on, not merely the fields the reader
picked** — the correction that came out of building it (2026-08-20). `sectionOf` reads
`categoryKind` and `categoryActive`, and neither is a selectable field: `category` maps to
`categoryName` alone. So a fold keyed on the chosen fields put the same printing's **Sideboard**
and **Main deck** rows into one row, which then inherited the first card's category — and the
sideboard copy was written under `Deck`. That is not a formatting difference; it moves cards
between zones of the exported deck, and no test could see it because the suite had no fixture
with two same-name deck rows differing only outside a format's default set.

The rule, stated properly: **fold may only merge rows the file itself cannot tell apart.** A
format that writes sections *can* tell a Sideboard row from a Deck row, so the section is part of
the key even when the reader has switched the category field off. In practice that is a
discriminator per format — the section for `arena`, `moxfield` and `mtgo`; `[categoryName,
categoryActive]` for `archidekt`, which groups by the one and writes `{noDeck}` from the other;
nothing for `plain`, `tcgplayer` and `csv`, which are flat and branch on nothing structural.

**Folding *within* a section stays, and is the point.** A foil and a regular copy of one printing
exported to Arena fold to one summed line, because Arena has nowhere to record a finish and two
identical lines are a malformed decklist. The same pair exported to Moxfield stays two lines,
because Moxfield has the `*F*` marker to tell them apart with. That is this section's rule read
in the other direction, and it is the one place where this feature deliberately writes something
different from what the app wrote before it.

### 5.4 What "the list" means

Opening from the collection or the wishlist sweeps `collection_list` / `wishlist_list` at 500 per
page until exhausted — roughly six invokes for a 3,000-card collection, no new Rust read command.
A progress line draws while it runs.

The dialog names the scope it is about to write — *"1,204 cards matching your filters"* — and
offers **Everything** as the alternative, which re-sweeps with the filters cleared. What is on
screen is a scroll position rather than a decision, so the loaded page is never what gets
exported.

Opening from the deck editor is unchanged: `exportSubject` already resolves whole-deck versus
one-category, and both arrive as `cards`.

## 6. Import

### 6.1 The pipeline

```
source step        paste, or pick a file (import_read_file)
  parseDecklist    text -> ParsedLine[] + ParseIssue[]        (shared, pure)
  import_resolve   names -> printing ids, ONE call            (shared, Rust)
  destination.plan(parsed, resolved, options) -> items        (per destination)
preview step       destination's own body over shared furniture
  destination.commit(items, mode)                             (per destination)
```

The first, second and last steps are shared. Only `plan` and the preview body are the
destination's. That is the same seam the code already has — `parse.ts` is pure and
destination-blind, `plan.ts` is entirely deck decisions — promoted to an interface.

```ts
interface ImportDestination<Item, Options> {
  key: "deck" | "newDeck" | "collection" | "wishlist";
  label: string;
  modes: readonly string[];
  plan(list: ParsedList, resolved: ImportResolveRow[], options: Options): ImportPlan<Item>;
  Preview: (props: PreviewProps<Item, Options>) => JSX.Element;
  commit(items: Item[], mode: string, options: Options): Promise<ImportOutcome>;
}
```

`ImportPlan` keeps its existing shape — planned items, unmatched lines, hint misses, tallies —
because all four destinations owe the reader the same three answers: what will land, what will
not, and why.

### 6.2 The four destinations

| Destination | Grain written | Modes | What its preview adds |
| --- | --- | --- | --- |
| deck | `deck, variant, category, card, finish` | merge / replace | commander picker, category tally, variant |
| new deck | as above, into a deck created first | merge only | name, format, game |
| collection | `COLLECTION_GRAIN` | **add / set** | condition + finish defaults |
| wishlist | `WISHLIST_GRAIN` | **add / set** | preferred-finish default |

**No replace for the collection or the wishlist.** The deck's `replace` clears one variant of one
deck; the same word over a collection would empty a 3,000-card record from a 40-line paste, and
the file that caused it would look completely ordinary. `add` accumulates quantities, which is
what `add_entry` already does; `set` writes the file's quantity onto the row. Neither touches a
row the file does not mention. A reader who wants a true restore deletes first, deliberately.

**A file that names the same grain twice is folded before the commit, in both modes.** Two lines
for the same printing-and-condition are one intention expressed twice; under `add` they would
double-count, and under `set` the second would silently win. The planner sums them into one item
and the preview counts them once, which is the same rule `foldForFields` applies on the way out.

**`set` to 0 on the wishlist deletes the wish**, because `wishlist_set_quantity(id, 0)` already
means that; on the collection it leaves a zero-quantity row, because `set_quantity` already means
that there. Both are the existing asymmetry rather than a new rule, and the preview says which
one the reader is about to get.

### 6.3 The wishlist pins a printing only when the file named one

A line that gave a set code or a collector number becomes a wish for **that printing**. A line
that gave only a name becomes a wish for **any printing** — `card_id` null, which is what
`WISHLIST_GRAIN` already models and what `ipc.ts` already calls "what a wishlist usually means".
Reading the file's own specificity is the only honest answer available, and it costs no control.

### 6.4 Defaults the text formats cannot carry

A plain list has no condition and often no finish. The collection's preview therefore carries two
controls: **"Condition when the file doesn't say"** (defaulting to `NM`, matching Rust's
`DEFAULT_CONDITION`) and **"Finish when the file doesn't say"** (Regular). A CSV that carries
those columns overrides them per row; the controls state what the rest of the file will land as,
before the reader commits. The wishlist's preview carries the finish control alone.

An EU condition grade in a CSV (`GD`, `EX`) is normalised through the existing
`normalizeCondition` in `src/lib/conditions.ts`, and the string as it arrived is kept in
`condition_original` — the column exists for exactly this.

### 6.5 A commit is one transaction

`collection_import_commit` and `wishlist_import_commit` loop over the existing pure `add_entry` /
`add_wish` (or `set_quantity`) inside **one** `with_write`, and answer counts. A refusal rolls the
whole file back: a half-imported collection is worse than a refused one, and the reader still has
the text on screen. This is `deck_import_commit`'s rule, kept.

`importIntoNewDeck`'s hand-rolled rollback — create, commit, delete on refusal — moves across
unchanged, including the rule that the *commit's* refusal is what the caller hears.

## 7. CSV, both ways

`csv.ts` is one file with a writer and a reader, RFC 4180: a field is quoted when it carries a
comma, a quote or a newline and never otherwise; an inner quote doubles; a quoted field may
contain newlines. The writer is today's `csvField` promoted; the reader is new.

**Import reads the header row and maps columns by `csvHeader`**, case- and whitespace-insensitive.
Unknown columns are ignored silently — a spreadsheet somebody added a column to is still a
readable file. A file with no recognisable name column is refused with that sentence rather than
parsed into 400 nameless issues.

This is what makes a collection CSV a restore rather than a dump, and configurable columns force
it: with the column set under the reader's control there is no fixed order left to assume.

`parseDecklist` gains a CSV arm chosen by **the header row alone** — a first line that maps to two
or more known headers, one of which is a name. This is not the format detector `parse.ts` exists
without: every other line still reads by the per-line rules, and a file whose first line is not a
header is read exactly as it is today.

TCGplayer stays write-only, and `decklists.test.ts` keeps excluding it by name. CSV leaves that
exclusion list.

## 8. Rust

- `deck_import.rs` → `import.rs`. `deck_import_resolve` → `import_resolve`, `deck_import_read_file`
  → `import_read_file`. `deck_import_commit` **keeps its name**: it is genuinely deck-specific.
- `collection_import_commit(items, mode)` in `collection.rs`, `wishlist_import_commit(items, mode)`
  in `wishlist.rs`. Both are a loop inside one `with_write` over functions that already exist, and
  both answer `{ added, updated, removed }`. `removed` is the wishlist's alone — a `set` of 0
  deletes a wish and leaves a zero-quantity collection row — and it is 0 on every collection
  import rather than absent, so one shape covers both.
- `export_write_file` unchanged.
- `src/lib/ipc.ts` is a hand-written mirror with no compiler between it and the crate, so every
  rename is a two-sided edit. `ipc.test.ts` and the Rust command list in `lib.rs` are what catch a
  half-done one.

No schema change. No migration.

## 9. Entry points

- **Collection page** and **wishlist page**: an Import/Export pair in the page header, beside the
  filter bar. Neither page has a toolbar control today; both get one.
- **Deck editor**: `Export deck` and the category right-click keep their wording and their
  placement, re-pointed at the shared dialog. `Import` keeps its place.
- **The card context menu** is untouched. It acts on one card; this is about lists.

## 10. What is remembered

The chosen format and field set are remembered **per surface** in `useAppStore` — the collection
remembers "CSV with Condition and Purchase price", the deck remembers "Moxfield". No schema
change, no Rust. Someone exporting their collection weekly re-picks nothing; a deck export is not
dragged into whatever the collection wanted.

Import defaults (condition, finish) are remembered the same way and for the same reason.

## 11. What deliberately does not change

- The seven format names, their extensions, and their default output.
- `parse.ts`'s per-line rules. A CSV header is the only file-level judgement it will make.
- The deck's merge/replace modes and its commander picker.
- `export_write_file`, and the reason no `fs:` permission exists anywhere in this app.
- The single-card add paths (`useDeck.addCard`, `collection_add`, `wishlist_add`). An import never
  routes through them — that is the arithmetic `plan.ts` already documents.
- The card context menu, and search-results export (out of scope for this cut).

## 12. Testing

- **`fields.test.ts`** — the intersection rule, every (format × surface) pair, and `defaultOn`
  reproducing today's strings.
- **`format.test.ts`** — grows a field-set axis; the existing assertions become the `defaultOn` row.
- **`foldForFields`** — two entries differing only in an unselected field merge; the same two
  separate when it is selected.
- **`csv.test.ts`** — quotes, embedded commas, embedded newlines, doubled quotes, a header with
  unknown columns, a header with no name column.
- **`decklists.test.ts`** — the round trip, now including CSV, across field sets.
- **One planner test file per destination**, `plan.test.ts` becoming `deck.test.ts`.
- **Rust** — both new commits: one transaction, counts, refusal rolls back, a zero quantity does
  the destination's documented thing.
- **Stories** for both dialogs on all four destinations, plus the fake's seeds.
- **A live CDP pass.** jsdom has no layout engine; this adds a checkbox row to a dialog that has
  already shipped one overflow bug, so the export dialog is driven at a short viewport with a
  100-card list and every field switched on.

## 13. Risks

- **The hand-written IPC mirror.** Two command renames with no compiler between the sides. Both
  are covered by `ipc.test.ts`, and the whole rename lands in one commit.
- **Blast radius.** `DeckDialog` has about ten call sites and the two feature folders move whole.
  The move is mechanical and lands as its own commit, before any behaviour change, so a bisect can
  separate "the move broke it" from "the field picker broke it".
- **The intersection rule is the load-bearing abstraction.** If a format needs a field the rule
  cannot express, the answer is a per-format composer arm rather than a second declaration
  mechanism.
- **`foldForFields` is a correctness rule wearing a formatting hat.** Getting it wrong writes a
  file with the wrong number of cards in it. It is pure, and it is tested first.

## 14. Order of work

1. Move and rename, no behaviour change: `DeckDialog` → `components/Dialog.tsx`; both feature
   folders → `features/transfer/`; `deck_import.rs` → `import.rs` with the two command renames.
   Green suite, one commit.
2. `TransferCard` + the three adapters; `ExportCard` deleted.
3. `fields.ts`, the intersection rule, `foldForFields`; the writers composed; the export dialog's
   checkbox row. Deck export unchanged at defaults.
4. `csv.ts` both ways; `parse.ts`'s CSV arm.
5. `scope.ts`, the paged sweep, and the collection/wishlist export entry points.
6. The `ImportDestination` interface; deck and new-deck ported onto it with no behaviour change.
7. `collection_import_commit` and `wishlist_import_commit` in Rust, with their planners and
   preview bodies.
8. Persistence, stories, docs, the live pass.
