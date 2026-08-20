# Import and export

The general transfer feature — `src/features/transfer/` — that Tasks 1–14 pulled out of the deck
editor so the same parser, writer and fold rule could serve the collection and the wishlist too.
`src/features/transfer/CLAUDE.md` carries the binding rules; this is the long-form record behind
them, with every figure kept beside the build and the date it was taken on. Numbers marked
**measured** below were taken live on 2026-08-20 against a debug `npm run tauri dev` build in this
worktree, driven over CDP (`docs/reference/live-ui-verification.md` is the harness); numbers marked
**counted** were read straight off the source referenced beside them and will move the day that
source does — re-count rather than trust this page.

## The seven formats

`EXPORT_FORMATS` (`src/features/transfer/formats.ts`) — **counted**, 7 entries, in the order the
export dialog's radio row draws them:

| Format | Printing | Finish | Category | Sections | Read back? |
| --- | --- | --- | --- | --- | --- |
| Plain text | — | `*F*`/`*E*` | — | — | Yes |
| MTGO | — | — | — | `SB: ` prefix, no heading | Yes |
| Arena | Set + number | `*F*`/`*E*` | — | Fixed vocabulary heading | Yes |
| Moxfield | Set + number | `*F*`/`*E*` | — | Fixed vocabulary heading | Yes |
| Archidekt | Set + number (lowercase) | `*F*`/`*E*` | `[Name]` bracket, `{noDeck}` | Reader's own category names | Yes |
| TCGplayer | `[SET] number` | — (chosen in cart) | — | Flat, no headings at all | **No** |
| CSV | Set + number columns | `Finish` column | `Category` column | One row per card, header row | **Yes, since Task 10** |

**TCGplayer is the one write-only format now.** `decklists.test.ts`'s `READABLE` array excludes it
by name — `parse.ts`'s bracket group is anchored to the end of the line, so `2 Lightning Bolt
[2X2] 117` reads back as one card named `Lightning Bolt [2X2] 117` rather than four fields; that is
measured in `format.test.ts` (`does not round-trip TCGplayer`) rather than left as a claim. CSV
carried the same write-only label through Tasks 1–9 — nothing in `parse.ts` read a comma-separated
line — and stopped being true in Task 10; see "CSV, both directions" below.

**Three decisions worth carrying past the table.** `mtgo` writes `SB: ` on a sideboard or companion
card as a one-line override rather than a heading — the same shape its own reader expects. `arena`
and `mtgo` write only the piles a reader has switched *on* (`ACTIVE_ONLY` in `format.ts`); no other
format drops a row, and `tcgplayer` is the one flat format that keeps a switched-off pile, because
the cart is usually exactly what the reader still has to buy. `archidekt` is the only writer whose
headings are the reader's own words rather than a fixed vocabulary, and the only one that can say
`{noDeck}` — the flag that is what makes an Archidekt export and a re-import agree about a
maybeboard.

## The field registry and the intersection rule

`src/features/transfer/fields.ts` declares two independent things and the export dialog draws only
their overlap:

- **A *format* says what channels it has** — `FORMAT_FIELDS[format].optional`. Arena's line has no
  printing-hint-free position for a `Condition` column at all; CSV alone offers all 25.
- **A *surface* says what facts it holds** — `SURFACE_FIELDS[surface]`. A deck has no purchase
  history; a wishlist has no piles.

`availableFields(format, surface)` is the intersection, filtered back into `TRANSFER_FIELD_IDS`'
own order (which is also CSV's column order, unconditionally). `defaultFields` is the same
intersection narrowed to what a format turns on by default. Neither function is symmetric with the
other surface: switching format re-derives the checked set from that format's own defaults rather
than carrying the old selection forward, because a set chosen for CSV means nothing to Arena.

**25 fields total, counted from `TRANSFER_FIELD_IDS`.** `quantity` and `name` are `ALWAYS` — never
drawn as a checkbox, because a line with no count and no name is not a card — leaving 23 that can
ever be optional anywhere.

| Surface | Fields it carries (excluding `quantity`/`name`) | Count |
| --- | --- | --- |
| `deck` | setCode, collectorNumber, category, finish, lang, setName, rarity, typeLine, unitPrice | **9** |
| `collection` | setCode, collectorNumber, finish, condition, lang, tradelistQuantity, purchasePrice, purchaseCurrency, acquiredAt, acquisitionSource, serialNumber, grading, altered, signed, proxy, misprint, tags, notes, setName, rarity, typeLine, unitPrice | **22** |
| `wishlist` | setCode, collectorNumber, finish, lang, notes, rarity, typeLine, unitPrice | **8** |

(**Counted** from `SURFACE_FIELDS` directly, not carried over from the plan's own estimate: the
collection carries every fact a physical card can have except a pile, which is why its CSV is
the tallest thing the export dialog draws.) `category` is the one field neither the collection nor
the wishlist ever offers — a collection row and a wishlist wish are not filed anywhere, so there is
no pile to name and no checkbox for one.

**The `csvHeader` column is the CSV vocabulary, both ways.** The writer reads it to name a column;
the reader (`parse.ts`'s `HEADER_TO_FIELD`) builds the reverse map from the same table, case- and
space-insensitively, so a header never drifts out of sync with a column:

| Field id | CSV header | Field id | CSV header |
| --- | --- | --- | --- |
| `quantity` | Quantity | `grading` | Grading |
| `name` | Name | `altered` | Altered |
| `setCode` | Set | `signed` | Signed |
| `collectorNumber` | Collector number | `proxy` | Proxy |
| `category` | Category | `misprint` | Misprint |
| `finish` | Finish | `tags` | Tags |
| `condition` | Condition | `notes` | Notes |
| `lang` | Language | `setName` | Set name |
| `tradelistQuantity` | Tradelist quantity | `rarity` | Rarity |
| `purchasePrice` | Purchase price | `typeLine` | Type line |
| `purchaseCurrency` | Purchase currency | `unitPrice` | Price |
| `acquiredAt` | Acquired | | |
| `acquisitionSource` | Acquired from | | |
| `serialNumber` | Serial number | | |

## The fold rule, and why the discriminator exists

`export/fold.ts`'s `foldForFields(cards, fields, discriminator?)` merges rows the chosen field set
cannot tell apart, summing `quantity` and `tradelistQuantity`. It is a correctness rule wearing a
formatting hat: the collection keeps 2 NM and 1 LP Lightning Bolt as two rows on purpose, but a
plain-text export has no condition channel, so writing them as two identical lines would hand a
reader a decklist naming one card twice.

**The chosen fields are not the only thing a writer can tell two rows apart by, and that is what
the discriminator argument is for.** A field is something the reader switches on or off; a
*structural* fact — which section a line lands under, whether a bracket carries `{noDeck}` — is
something the writer branches on unconditionally, whether or not the field that names it
(`category`) is even in the chosen set. Folding on `fields` alone can merge a Sideboard row into a
Main-deck row, because the merged row inherits the *first* card's section. `format.ts`'s own
`DISCRIMINATOR` map is what closes that:

- `arena`, `mtgo`, `moxfield` key on `sectionOf(card)` — the section a card writes under.
- `archidekt` keys on `[categoryName, categoryActive]` together, because it is the one writer that
  can say `{noDeck}` from the active flag, and folding a switched-off copy into a switched-on one
  would silently drop the flag along with the fact it recorded.
- `plain`, `tcgplayer`, `csv` have no entry — they are flat and branch on nothing structural, so two
  rows that agree on every chosen field really are indistinguishable in that file.

## CSV, both directions

`src/features/transfer/csv.ts` is RFC 4180 in both directions; `export/format.ts`'s writer quotes a
field only when it carries a comma, a quote or a newline, and the reader is a character-by-character
scanner (a quoted field can hold a comma or a newline, so there is no line-oriented shortcut that is
correct).

**Reading a CSV is the one *file-level* judgement `parse.ts` makes; every other rule in it is
per-line.** A format detector would have to choose a reader before it had read anything and would
be wrong about exactly the lists somebody had hand-edited — which is why every other shape is read
line by line. CSV gets one exception because a header row is a fact about the *file*, checked once:

1. **Content**: the first row needs two or more cells `HEADER_TO_FIELD` recognises, one of which is
   `Name` (`csvHeaderOf`). One known column is not enough — a plain list whose first card happens to
   be named `Name` would otherwise be read as a header over a nameless file.
2. **Shape agreement**: the row after the header has to carry the *same field count* as the header
   (`csvShapeAgrees`). Content alone is not sufficient — `"Quantity, Name\n1 Sol Ring"` matches the
   content test on its own (`parseCsv` splits the one comma into two cells that both name a known
   column), and it is not a CSV; its next row is one field against the header's two, so the shapes
   disagree and the whole file falls through to the ordinary per-line reader, unaffected.
3. A header this app **nearly** recognises — two or more known columns, none of them `Name` — is a
   CSV exported from somewhere else this app cannot read; it gets one sentence rather than one
   parse issue per row.

Once the header is trusted, every later row is read **by column** rather than by the per-line
grammar the rest of the file uses. `extra` on `ParsedLine` carries every recognised column verbatim
— including the ones no other format has a channel for at all — and the deck planner never reads it;
the collection's `planCollectionImport` is what reads `condition`, `purchasePrice`,
`purchaseCurrency`, `acquiredAt`, `acquisitionSource` and `notes` out of it.

**Not every collection export field round-trips through import, and this is a real asymmetry rather
than an oversight to fix here.** `CollectionImportItem` — the wire shape both `src/lib/ipc.ts` and
`src-tauri/src/collection.rs` agree on — carries `cardId`, `quantity`, `finish`, `condition`,
`conditionOriginal`, `purchasePrice`, `purchaseCurrency`, `acquiredAt`, `acquisitionSource` and
`notes`, and nothing else. `altered`, `signed`, `proxy`, `misprint`, `serialNumber` and `grading` are
all exportable — `SURFACE_FIELDS.collection` carries all six — but `planCollectionImport` never
reads them out of a CSV's `extra`, and there is no slot for them on the wire even if it did. A CSV
carrying `Altered,yes` round-trips the column heading and drops the value on import; every
`collection_entries` row a bulk import creates gets Rust's own defaults for those six columns
(`false`/`NULL`) whatever the file said. **Measured live** in this pass — see "The live pass"
below — importing a CSV with every collection column filled in and then exporting it straight back
out showed `no,no,no,no` for Altered/Signed/Proxy/Misprint on a row the import file never mentioned
those columns for at all, which is the same fact from the other side.

## The four import destinations

`import/destination.ts`'s `ImportDestination` is what the dialog's second step draws; four exist,
one per surface plus the deck's "start a new one":

| Destination | Modes | Grain the write folds on | Notes |
| --- | --- | --- | --- |
| `deck` (existing) | `merge` / `replace` | `deck_id, variant, category_id, card_id, coalesce(finish,'')` (`schema::DECK_CARD_GRAIN`) | `replace` clears one **variant** first, named before it does; the mode radio says how many cards that would cost |
| `newDeck` | `merge` only | same grain, on the deck just created | No mode radios at all — there is nothing to replace one line after `deck_create`, and `merge` is the mode that cannot clear anything if that ever stops being true |
| `collection` | `add` / `set` | `cardId, finish, condition` (the importer's own fold key, `destinations/collection.ts`) — narrower than the storage grain, `card_id, finish, condition, lang, altered, signed, proxy, misprint, coalesce(serial_number,''), coalesce(grading,'')` (`schema::COLLECTION_GRAIN`) | No `replace`: the deck's version would empty a multi-thousand-row collection from a 40-line paste with the file that caused it looking ordinary |
| `wishlist` | `add` / `set` | `oracleId, cardId, finish` (`destinations/wishlist.ts`) — the storage grain is `coalesce(oracle_id,''), coalesce(card_id,''), coalesce(preferred_finish,'')` (`schema::WISHLIST_GRAIN`) | `set` of `0` **deletes** the wish; a wish for nothing is not a wish (`CHECK (quantity > 0)`) |

**Every one of the four commits in one transaction for the whole file** — `deck_import_commit`,
`collection_import_commit`, `wishlist_import_commit` — the same rule `docs/reference/decks-storage.md`
already states for the deck's own commit, carried to the two new ones. `importIntoNewDeck` is the
one exception worth naming: it is `deck_create` then `deck_import_commit`, two commands and
therefore two transactions, with a hand-rolled rollback (`useImport.ts`) that deletes the freshly
created deck if the commit is refused — a refused import must not leave half a deck in the gallery,
and the commit's own refusal is what the reader hears, never the clean-up delete's.

**The wishlist's own rule, stated once here because nothing else needs it twice**: a printing is
pinned only when the file named one, or when the matched card has no `oracle_id` at all to wish for
instead (`WishlistPlanItem`'s doc). A plain `1 Sol Ring` becomes a wish for the card — `cardId: null`
— and `1 Sol Ring (LTC) 285` becomes a wish for that printing. **Measured live** below: three
un-pinned plain-text lines committed as three rows with `card_id IS NULL` and a populated
`oracle_id`, both in the database and in the wishlist table's own "Any printing" caption.

## The sweep

`export/scope.ts`'s `useExportScope` turns a filtered page into a whole list before the dialog opens
on it: the collection and the wishlist are paged at 100 rows for their own views, so what is in
memory at any moment is a scroll position rather than a decision, and exporting that would silently
truncate a large collection to whatever the reader happened to have scrolled past.

`SWEEP_PAGE = 500` (**counted**, `scope.ts`) — six round trips for a 3,000-row collection instead of
thirty at the view's own page size. The stop condition is a **short page**, never the running total:
a write landing mid-sweep moves the total, and trusting it would either strand the sweep short or
loop it forever. `scope.test.ts` pins the arithmetic directly: 1,200 rows in exactly 3 calls
(500/500/200), a page that answers 1 row against a claimed `total: 9999` still stops after that one
call, and an empty first page (`total: 0`) asks exactly once.

**The measured round trip for a real collection, taken 2026-08-20**: this repo's own reader's
collection — read directly off `D:/Code/mtg-grimoire/src-tauri/target/debug/data/mtg.db` with
`node:sqlite`, read-only, no app lock needed — currently holds **0 rows**, so an "Export everything"
sweep against it makes exactly **1** round trip (a first page shorter than 500). That is the honest
number for the build this page names rather than a guess dressed up as one; the general rule the
tests above already prove is `ceil(total / 500)` round trips for any other size.

## The live pass — 2026-08-20, `npm run tauri dev` (debug), this worktree

Driven over CDP against a fresh sync (116,700 cards, this worktree's own `target/debug/data/mtg.db`,
separate from the main checkout's). Every collection/wishlist/deck row this pass created was removed
afterwards and confirmed at 0 by a direct `node:sqlite` read before the app was shut down; nothing
here reached the reader's own data, which had 0 rows in either list before the pass started too.

### The export dialog, clamped, every field on, CSV, at the app's own floor

`src-tauri/tauri.conf.json` enforces `minWidth: 1024, minHeight: 700` — a reader can never make the
window shorter than 700px, so that is the real worst case rather than an arbitrary "short" number.
At **1024×700**, on the collection surface, CSV, all 22 optional checkboxes turned on, and 17 real
rows imported for the pass (enough that the `<pre>`'s own `scrollHeight` was 785px against a body
budget of 593px — genuinely taller than the space available):

- Panel: `top 24, bottom 676` — clamped inside the 700px window with margin either side.
- **Copy**: `top 619, bottom 655` — inside the viewport, reachable.
- **Save as…**: `top 619, bottom 655` — inside the viewport, reachable.
- The `<pre>` scrolled inside its own `overflow-auto` box; the outer body's `scrollHeight` stayed
  equal to its `clientHeight` (593 = 593), meaning the excess never had to push the footer down at
  all — the preview absorbs its own overflow before the buttons are ever at risk.

A screenshot was taken and read during the pass confirming this visually (every checkbox ticked, the
scrollbar on the preview box, both buttons sitting on screen under it) and was not kept as a repo
artefact. **One thing worth naming rather than hiding**: pushing the CDP-emulated viewport *below*
the app's own enforced floor (tried at 1024×380, well under the 700px minimum) reproduced the
un-clamped failure — the dialog's own `overflow: visible` lets a sufficiently tall flex column push
its footer buttons outside the panel's box when the OUTER window itself is shorter than the content
needs. That state is not reachable by a real reader, because Windows will not let them shrink the
window past 700px tall; it is recorded here as the reason the floor matters rather than as an open
bug.

### CSV round trip, condition included

The native `dialog:allow-save` / `dialog:allow-open` pickers are windows CDP cannot drive — the same
limit `src/features/transfer/CLAUDE.md`'s Import and Export sections already state for their own
tests — so this pass verified the **text** round trip the file system carries byte for byte, rather
than the picker gesture:

1. Pasted a hand-written CSV (`Quantity,Name,Set,Collector number,Finish,Condition`) naming a
   nonfoil Lightning Bolt at **LP** and a foil Sol Ring at **NM** into the collection's Import
   dialog, previewed (no unknown-condition warnings), committed.
2. The collection table read back `Nonfoil · LP (Lightly played)` and `Foil · NM (Near mint)`.
3. Exported the same two rows to CSV and read the preview: `2,Lightning Bolt,2x2,117,,LP` and
   `1,Sol Ring,c21,263,foil,NM` — the condition survived exactly, on both rows, at both finishes.

### A plain-text list into the wishlist

Pasted `1 Lightning Bolt`, `1 Sol Ring`, `1 Counterspell` — no set, no collector number on any line
— into the wishlist's Import dialog and committed. Confirmed two ways: `wishlist_entries` (read
directly, `node:sqlite`) showed `card_id: null`, `set_code: null`, `collector_number: null` and a
real `oracle_id` on all three rows; the wishlist table's own Printing column read "Any printing" for
all three. Both agree with `WishlistPlanItem`'s stated rule above.

### New-deck import navigation

From the gallery's "Import deck" button (no destination radios — one destination draws none), pasted
a 4-card list, named the deck, pressed Import. The ribbon's own `h1` still reads "Decks" — it names
the section, not "gallery vs. editor", and does not move — but the page itself carried `Export deck`
(a control that exists only inside the deck editor, never the gallery), the typed deck name, and the
4 cards correctly filed under Ramp and Removal: the reader was left inside the newly created deck,
not on the gallery looking at its new tile. This path has no regression test anywhere in the suite,
so this pass is its only verification.

## Where the code is

`src/features/transfer/` (`TransferCard.ts`, `fields.ts`, `csv.ts`, `formats.ts`, `export/`,
`import/`) is the whole of the TypeScript side; `src-tauri/src/import.rs` (renamed from
`deck_import.rs`), `export.rs`, `collection.rs`'s `collection_import_commit` and `wishlist.rs`'s
`wishlist_import_commit` are the Rust side. `src/components/Dialog.tsx` is the shared modal shell
both `ExportDialog` and `ImportDialog` are built on. `src/features/decks/CLAUDE.md` still owns
deck-specific rules this feature reads or reaches into — categories, validation, formats.
