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

**Archidekt's `^Tag,#colour^` is read on import and written by nobody, and the asymmetry is
deliberate rather than an omission.** The parser has read the caret group since 2026-08-24 —
`ParsedLine.tagName`/`tagColor`, `ImportPlan.tags`, the picker on the import step,
`ImportItem.tag_name`/`tag_color` — so a deck brought over from Archidekt arrives with its labels.
The **exporter** still writes none, which means an export → import round trip through this app
loses them. What stops that being a bug worth chasing today is the field table above: a tag is a
seventh channel with exactly one format able to carry it, so it would need a `TRANSFER_FIELDS`
entry, a `SURFACE_FIELDS` answer per surface, an `ACTIVE_ONLY`-style decision for the six formats
that cannot say it, and a `DISCRIMINATOR` thought (two rows differing only in their label must not
fold). None of that is hard; none of it has a reader asking for it yet. `decklists.test.ts`'s
fixed-point claim is unaffected — it compares export → import → export, and a channel neither
writer emits cannot break a fixed point.

## The Arena filter — what "in MTG Arena" is measured as

Issue #192. The Arena format offers one checkbox no other format does — **Only cards MTG Arena
has** — and `src/features/transfer/export/arena.ts` is the whole of what it means. It is a *row*
filter rather than a field: it changes which cards there are lines for, never what a line says
about one, which is why it is not in `fields.ts` and not in the dialog's `Fields` row. Off on
every surface when the dialog first opens (`useAppStore`'s `exportPrefs.<surface>.arenaOnly`),
because this format has written every card handed to it since it shipped.

**The obvious fact is the wrong one.** Scryfall's `games` array literally lists `arena`, but it
is a property of a **printing**: the Alpha printing of Lightning Bolt says `["paper"]` while the
card is in Arena's Timeless pool, so a `games`-based filter would empty a paper collection. The
test is legality instead — the oracle-level fact hiding inside a printing-level blob.

All figures below were measured on **2026-08-22** against the live corpus in
`D:/Code/mtg-grimoire/src-tauri/target/debug/data/mtg.db` (116,712 printings, 0 of them with a
NULL `legalities`), read through `node:sqlite`, read-only, no app lock. SQLite's own C is what
does the work, so no cargo profile enters into any of them.

The reference set is **16,219 oracle cards with at least one printing whose `games` contains
`arena`**. Candidate rules, against it:

| Rule | Matches | Kept with no Arena printing | Dropped though Arena has them |
| --- | --- | --- | --- |
| `timeless` alone | 15,757 | 0 | 462 |
| The nine `format_specs` arena rows | 16,010 | **37** | 246 |
| **Those nine minus `gladiator`** | 15,973 | **0** | 246 |

**`gladiator` is the exclusion the whole shape turns on, and it is the entry most likely to be
helpfully restored.** Gladiator genuinely is an Arena format and `format_specs` seeds its `games`
cell as `arena` — but Scryfall's `gladiator` legality is not computed from Arena's pool. It marks
paper-only cards `legal`: Grand Coliseum (`c16`, `games: ["paper"]`), Exotic Orchard, Together
Forever, Sodden Verdure. It alone accounts for **all 37** of the middle row's false keeps. The
exclusion is about Scryfall's data rather than about the format, which is why it cannot be read
off the seed and lives in `arena.ts` with `arena.test.ts` pinning it.

**`timeless` alone is the other tempting shortcut**, and it costs the 216 `A-` rebalanced Alchemy
cards — Timeless deliberately excludes rebalanced cards while Arena is the only place they exist
— plus 36 tokens and 210 Arena-exclusives. So `ARENA_LEGALITY_KEYS` is **eight** names:
`alchemy`, `brawl`, `competitivebrawl`, `future`, `historic`, `standard`, `standardbrawl`,
`timeless`, and a card is in Arena when **any** of them is `legal` or `restricted`.
`restricted` counts (a copy limit is not "Arena lacks the card"); `banned` does not, which is the
issue's "not legal" arm — and a card banned in one Arena format and legal in another survives,
which is exactly Lightning Bolt (`historic: banned`, `timeless: legal`).

**The 246 it still drops** are tokens and Arena-exclusives that Scryfall records as playable in
no format at all — Alchemy Horizons: Baldur's Gate's own cards, and every printing of a set that
has not been released yet. Both are cards an Arena decklist should not name either.

**Two facts make the printing-level blob safe to read as an oracle-level one**, and both were
measured rather than assumed: **0** oracle cards have printings that disagree about any of the
eight keys, and **0** cards match the eight-key rule without having an Arena printing.

**Names, never bit positions.** `src-tauri/src/legalities.rs` packs these same keys into
`cards.legal_mask` at frozen, append-only offsets that are *stored data*; a copy of that order in
TypeScript would be a second place for it to drift, and a wrong bit reads as a plausible legality
rather than as a crash. Scryfall's key names are public vocabulary and cannot drift. That is also
why `CollectionRow` and `WishRow` gained the **blob** rather than the mask when this shipped —
`DeckCard` already carried one — at a measured cost of **483 bytes** on average and **528** at
most per row, against `promo_types`' 23 on the same corpus. `src/features/transfer/export/` is
the only reader on any of the three.

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
the wishlist ever offers — a collection row is filed nowhere at all, so there is no pile to name and
no checkbox for one. **A wish has been filed somewhere since schema v23 and still does not offer
it**, which is a decision rather than an oversight: a wishlist folder is not a deck category, no
format has a channel that means "the reader's own drawer", and the rule is the one stated with
[the four import destinations](#the-four-import-destinations) below — folders are not carried in
either direction.

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

### The narrow fold — **fixed 2026-08-23**, and kept here because the shape is instructive

**Every collection export field now round-trips through import.** `Altered`, `Signed`, `Proxy`,
`Misprint`, `Serial number` and `Grading` are six of the **eleven** columns in `COLLECTION_GRAIN`
(`card_id, finish, condition, lang, altered, signed, proxy, misprint,
coalesce(serial_number, ''), coalesce(grading, ''), coalesce(folder_id, 0)` — the eleventh joined
at schema v24, see [collection-folders.md](collection-folders.md)) — they are part of what
*identifies* a collection row, not decoration on one, and `planCollectionImport` reads all six out
of a CSV's `extra`, `CollectionImportItem` carries all six on the wire, and `commit_import` writes
them rather than defaulting them.

**The fold key is every grain term the importer can vary, and the two it omits it omits for a
reason.** `lang` is a function of `cardId` — `add_entry` copies it, `set_code` and
`collector_number` off `cards` at write time and never takes them from the file — so two items
sharing a `cardId` can never disagree about it. `folder_id` is always the root, because an imported
file says nothing about this reader's filing. Neither can separate two items that the other nine
terms fold together, which is what makes leaving them out exact rather than a second narrow key.

**What it was, until the collection's folders shipped.** The honest description was worse than
"six flags are dropped": the re-imported row was a *different row* from the one exported, not the
same row missing some flags. Three facts composed into it:

1. `destinations/collection.ts` folded the planner's items on `cardId, finish, condition` alone —
   narrower than the grain — so two exported rows differing only in, say, `Altered` folded into
   **one** importer item, its quantity the sum of both.
2. `commit_import` hard-coded all six to their defaults (`false`/`NULL`) on every import, whatever
   the file said, so that one item always targeted the all-defaults grain.
3. `ON CONFLICT(COLLECTION_GRAIN)` could therefore never match the original altered/signed/
   proxied/misprinted/serialized/graded row — its grain was not the all-defaults one — so the
   import wrote or updated a **second, all-defaults entry beside it** rather than restoring the
   row that was exported.

Worked through: a collection holding 2 altered and 3 unaltered copies of the same NM nonfoil
printing (two grain-distinct rows, 5 copies total) exported as two CSV rows and reimported as one
folded item of quantity 5, always landing on the unaltered grain. In `set` mode that
**overwrote** the unaltered row's quantity from 3 to 5, leaving the altered row's 2 untouched — 7
copies where there were 5. In `add` mode the unaltered row's quantity accumulated instead,
3 + 5 = 8, for 10 copies total. Both were **measured**, not estimated: importing a CSV with every
collection column filled in and exporting it straight back out showed `no,no,no,no` for
Altered/Signed/Proxy/Misprint on a row the import file never mentioned those columns for at all,
which is the same mechanism seen from the single-row side.

**This page called it "latent, not live" for as long as no shipped surface wrote any of the six** —
a sweep of `src/**` for `altered:`/`signed:`/`proxy:`/`misprint:`/`serialNumber:`/`grading:`
outside tests, stories, `lib/ipc.ts` and `features/transfer` itself found zero writers, so every
row a reader could create had all six at their defaults, `ON CONFLICT` always landed on the one row
that could exist, and the round trip was faithful. The note said the trap would arrive with the
first surface that let a reader set one of the six.

**What actually made it live was the eleventh grain term, not a new editor.** Once `folder_id`
joined `COLLECTION_GRAIN` at schema v24, an import into a deck's group — the "add cards to
collection" toggle the folder work is building towards — targets a grain the reader's own filed row
does not hold, and the same second-row-beside-it failure follows without anybody ever ticking
"Altered". So it was fixed in the branch that shipped the folders (2026-08-23): the fold key is the
full grain and the commit carries the six columns.

**The lesson is the one worth keeping.** A defect that is unreachable today is a defect with a
*trigger*, and the trigger is rarely the surface you predicted — this one was a schema change three
releases away that had nothing to do with flags. "Latent" is a note about the present tense, and it
expires without warning.

## The four import destinations

`import/destination.ts`'s `ImportDestination` is what the dialog's second step draws; four exist,
one per surface plus the deck's "start a new one":

| Destination | Modes | Grain the write folds on | Notes |
| --- | --- | --- | --- |
| `deck` (existing) | `merge` / `replace` | `deck_id, variant, category_id, card_id, coalesce(finish,'')` (`schema::DECK_CARD_GRAIN`) | `replace` clears one **variant** first, named before it does; the mode radio says how many cards that would cost. Since 2026-08-23 it also draws the optional ["Add cards to collection" box](#the-deck-arms-add-cards-to-collection-box), which makes the press two writes |
| `newDeck` | `merge` only | same grain, on the deck just created | No mode radios at all — there is nothing to replace one line after `deck_create`, and `merge` is the mode that cannot clear anything if that ever stops being true. Draws the same "Add cards to collection" box, from the **same** exported `OwnCopies` rather than a second one written here |
| `collection` | `add` / `set` | Every term of the storage grain (`schema::COLLECTION_GRAIN` — `card_id, finish, condition, lang, altered, signed, proxy, misprint, coalesce(serial_number,''), coalesce(grading,''), coalesce(folder_id, 0)`) the importer can vary, so nine of the eleven. `lang` follows `cardId` and `folder_id` is always the root. It was `cardId, finish, condition` alone until 2026-08-23 — see the fold section above for what that cost | No `replace`: the deck's version would empty a multi-thousand-row collection from a 40-line paste with the file that caused it looking ordinary |
| `wishlist` | `add` / `set` | `oracleId, cardId, finish` (`destinations/wishlist.ts`) — the storage grain is `coalesce(oracle_id,''), coalesce(card_id,''), coalesce(preferred_finish,''), coalesce(folder_id,0)` (`schema::WISHLIST_GRAIN`) | `wishlist_set_quantity(id, 0)` **deletes** the wish — a wish for nothing is not a wish (`CHECK (quantity > 0)`) — but an import can never reach it: `parse.ts` refuses a quantity below 1 before a plan is even built (`:460`, `:671`), so `set` through this dialog never carries a 0 |

**Every one of the four commits in one transaction for the whole file** — `deck_import_commit`,
`collection_import_commit`, `wishlist_import_commit` — the same rule `docs/reference/decks-storage.md`
already states for the deck's own commit, carried to the two new ones. `importIntoNewDeck` is the
one exception worth naming: it is `deck_create` then `deck_import_commit`, two commands and
therefore two transactions, with a hand-rolled rollback (`useImport.ts`) that deletes the freshly
created deck if the commit is refused — a refused import must not leave half a deck in the gallery,
and the commit's own refusal is what the reader hears, never the clean-up delete's.

**Folders are deliberately not carried, in either direction** (schema v23, 2026-08-22). The seven
formats carry *cards*, and a folder is not one: no format has a channel for it, none of the four
foreign formats this app reads would know what to do with one, and inventing a column would make
this app's CSV unreadable by everything it was designed to interoperate with. So an export names no
folder and an import writes none — `wishlist_import_commit` sends `folder_id: None` on every line,
which is **one of the three writers that add at the root and cannot name a folder**, beside
`deck_missing_to_wishlist` and `deck_theory_missing_to_wishlist`.

The consequence is real and is written down rather than left to be discovered: with `folder_id` in
the grain, a line for a card the reader has already filed in `Ordered` lands as a *second* row at
the root instead of folding into the one they filed. `WishRow.elsewhere` is what tells them — the
imported row draws an "also on your list" mark. Whole reasoning:
[wishlist-folders.md](wishlist-folders.md).

### The deck arms' "Add cards to collection" box

**Added 2026-08-23, spec §7.4.** Both deck destinations — `deck` and `newDeck` — draw one checkbox
under the preview: *"Add cards to collection"*, with the hint *"Tick this if you already own these
cards — n copies are added to what you have."* It is the reader saying they have physically built
this deck, and it turns one press into **two writes**.

**The second write is `planCollectionImport` called a second time over the same `resolved` rows,
never the deck's items adapted across**, and that is the load-bearing decision. The two grains are
not the same list of facts: a deck item is `(cardId, category, finish)`, while a collection item is
the eleven-column grain carrying the condition, the four flags, a serial number, a grading blob and
the whole acquisition story a CSV can put on a row. That planner is already pure and already reads
all of it out of those rows, so calling it twice is cheaper *and* more correct than widening
`ImportItem` to carry a condition — which would put a collection fact in the deck's write and give
the two grains one shape they cannot both be right about. Its fold key has been the full grain
since 2026-08-23, so this cannot write a second all-defaults row beside an altered one.

Four rules the pair holds, each with a reason that is not obvious:

- **The deck's write goes first and its refusal stops the press.** The list is the thing the reader
  asked for; the copies are the extra. A collection refusal comes back as `ownRefusal` on a
  *resolved* mutation rather than being thrown, so the outcome line can say *"n cards imported. The
  copies could not be added to your collection — …"*. A thrown refusal would report the whole press
  as failed over a deck that really was written.
- **The state lives in the preview, never on `DeckImportInto`.** That interface is identity-only
  and `deckDestination` is memoised on what it closes over, so a presentational field there
  remounts the step under the reader.
- **Absent and an empty array are the same statement**, which is what keeps every caller written
  before the box existed unchanged by construction.
- **The invalidation is the union of the deck's roots and the collection's**, and only when the box
  was ticked. The collection's list and summary, the wishlist's owned progress and the search
  wall's owned badges each answer a question those copies just changed.

**The copies land in the deck's own group, and a plain collection import still lands at the
root.** `collection_import_commit` is `(items, mode, folderId)` since 2026-08-23 — `folderId`
defaults to `null`, which is the root and is what the collection's own import step sends, because
a file says nothing about a reader's filing. The deck arms are the one caller that names a folder:
`useImport` reads the deck's `kind: "deck"` group out of `collection_folder_list` **at press
time** — a query would be `undefined` while it loaded, and `importIntoNewDeck`'s deck did not
exist a statement earlier — and sends it, so the decklist and the group agree the moment the
dialog closes and no other deck can claim the copies. `collection::IMPORT_FOLDERS` is the fence:
the reader's own folders and a deck group, never `Recently removed` and never an id nothing
answers to. A deck with no group **refuses** (`NO_DECK_GROUP`, the crate's own sentence) rather
than falling back to the root, and the refusal rides back in `ownRefusal` like every other on this
half. `OWN_COPIES_HINT` says the consequence a checkbox label cannot imply: *"They are filed into
this deck's own folder, so no other deck can use them."*

**It shipped filing at the root for one PR**, with `commit_import` hard-coding `folder_id: None`,
and the symptom is worth keeping: the deck went on reading *missing* on every line the reader had
just ticked, and every other deck could still take the copies. The counters cannot see it — a root
import and a group import both answer `added: 1` — so the test that holds it asserts the
**folder column**.

The counting is worth pinning too, because the two halves count different things. The headline
under the checkbox is in **copies** — six basic lands on one line are six copies — which is what a
reader counts and what the collection stores. The outcome line afterwards is in **rows**
(`added + updated`), which is what the command answers: a playset landing on a row the reader
already had is one updated row and not four added ones.

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

### The "Add cards to collection" box — not driven yet

**This section is waiting rather than empty.** The box landed on 2026-08-23 and the pass belongs
after the code, so there are deliberately no figures for it — a number written before the window
was driven would be a guess with a date on it. What it owes an answer to: an import into an
existing deck with the box ticked, read back out of SQLite to confirm the copies are at
`folder_id IS NULL` and *not* in the deck's group (which is the hint's whole claim); the same on
the new-deck arm, where the deck is created a command earlier; and the outcome line when the
collection half is refused while the deck half committed, which is the one state the two writes can
end in that neither command can report on its own.

## Where the code is

`src/features/transfer/` (`TransferCard.ts`, `fields.ts`, `csv.ts`, `formats.ts`, `export/` —
including `export/arena.ts`, the Arena filter's rule — and `import/`) is the whole of the
TypeScript side; `src-tauri/src/import.rs` (renamed from
`deck_import.rs`), `export.rs`, `collection.rs`'s `collection_import_commit` and `wishlist.rs`'s
`wishlist_import_commit` are the Rust side. `src/components/Dialog.tsx` is the shared modal shell
both `ExportDialog` and `ImportDialog` are built on. `src/features/decks/CLAUDE.md` still owns
deck-specific rules this feature reads or reaches into — categories, validation, formats.

The "Add cards to collection" box is three files of that tree: `destinations/DeckPreview.tsx`
(`OwnCopies`, `OWN_COPIES_HINT`, and the outcome line), `destinations/NewDeckPreview.tsx` (which
imports that same component rather than drawing a second), and `useImport.ts` (`OwnedCopies`,
`ownCopies`). `OWNED_WRITE_KEYS` — the four query roots such a write moves — moved to
`src/lib/query.ts` on 2026-08-23, because the deck builder's own `own` add makes the same change
from the other side of the app and the two had drifted to two different invalidations. Where those
copies end up is
[collection-folders.md](collection-folders.md)'s subject, not this page's.
