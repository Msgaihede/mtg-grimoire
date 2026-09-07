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

**Every sentence in that paragraph is about the _writer_, and since issue #390 the writer is no
longer handed the whole deck.** `Include inactive categories` narrows the list in the export
dialog, above `formatExport`, and it opens **off** — so "no other format drops a row" and
"`tcgplayer` keeps a switched-off pile" are still true of `format.ts` and are no longer true of
the file a reader gets by pressing Copy. Which piles reach the writer is
[the inactive-category filter](#the-inactive-category-filter--the-dialogs-second-row-filter)'s
subject, one section down from the Arena one it is modelled on.

## The deck label, both directions

`^Keeper,#4aab08^` — a `deck_labels` row on a deck card. Read on import since 2026-08-24
(`ParsedLine.labelName`/`labelColor` → `ImportPlan.labels` → the picker on the import step →
`ImportItem.label_name`/`label_color`), and **written on export since the same day**, so a deck
survives a full round trip through the one text format with a slot for it.

**Two fields, not one, and the split is forced by the media.** `label` is the name; `labelColor`
is the colour. Archidekt writes the pair as one group, so its line has room for both and it offers
only `label` — a colour checkbox there would be a control that changed nothing, and `writeLine`
reads `card.labelColor` off the card whenever `label` is on. A CSV cell holds one value, so it
spends a column each and offers both boxes. That is the only place in `fields.ts` where a format
deliberately declares fewer fields than it writes.

| | Carries a label? | Colour |
| --- | --- | --- |
| Archidekt | `^Name,#rrggbb^`, last on the line | inside the group; no box of its own |
| CSV | `Label` column | `Label colour` column, its own box, **off** by default |
| plain · MTGO · Arena · Moxfield · TCGplayer | no | — |

**On by default for Archidekt and off for CSV.** Archidekt's other four optional fields are on
too — its defaults are everything the format can say, and the caret group is something Archidekt
itself emits. CSV's defaults are a deliberate core (printing, category, finish, condition) with
everything else opt-in, so both boxes join the opt-in side there. `exportPrefs` is session state
and not persisted (`store.ts`), so a default really does reach every reader on their next launch;
what makes that acceptable here and not for the Arena filter is that this **adds a suffix** where
that one **drops rows**, and the tickbox is on screen saying so. **`Include inactive categories`
is where that rule was knowingly broken**: its default drops rows, because those rows are the
reported bug — see
[the inactive-category filter](#the-inactive-category-filter--the-dialogs-second-row-filter),
where what stands in for the rule is a count line.

**The trailing `#tag` shape is deliberately not used.** `parse.ts`'s `MARKERS` strips `\s+#\S+$`
and reads nothing out of it, so writing a label that way into a plain or Moxfield line would be a
channel this app emits and cannot read back — and `\S+` cannot hold `Cut candidate` anyway.
Archidekt and CSV are the whole list.

**No `DISCRIMINATOR` entry, and that is checked rather than assumed.** A label is not structural:
with `label` on it is an ordinary keyed field, so two differently-labelled rows are two lines; with
it off the file cannot tell them apart and folding them is the fold doing its job.
`format.test.ts`'s "keeps two labels apart while Label is on, and folds them when it is off" is
that pair.

**The near-collision with the collection's `Tags` is gone, and the header that made it still
reads.** The deck's column was `Tag` until 2026-09-03 and the collection's free-text one is
`Tags` — one row of `deck_labels` against `collection_entries.tags`, two different facts one
letter apart. The deck's is `Label` now and the collection's did not move, so a reader looking at
a header row can no longer take one for the other. The structural fence is unchanged and still
the real one: `SURFACE_FIELDS` gives one to the deck and the other to the collection, so no
surface offers both and no file can hold both, and `fields.test.ts` asserts that emptiness
directly over every format × surface pair.
**A CSV an older build wrote still reads its labels back**, through `parse.ts`'s
`LEGACY_CSV_HEADERS` — `Tag` → `label` and `Tag colour` → `labelColor`, a read path and nothing
else, since no writer emits those words any more. It is laid **under** the registry-derived map
rather than over it, because `Map`'s constructor keeps the last entry for a repeated key and a
real header must always win one. It cannot shadow the collection's `Tags`: `normalizeHeader`
lowercases and collapses whitespace and does nothing else, so `tag` and `tags` are two keys and
always were. Without the alias the columns would map to nothing and the cards would come back
with their labels quietly stripped — a round trip that drops a fact and says nothing, which is
exactly what the fixed point below exists to make impossible.

The round trip is measured rather than claimed. `decklists.test.ts` wires `labelName`/`labelColor`
into `exportCardsFor`, so `ARCHIDEKT_SECTIONED`'s **44 labelled lines of 105** go out through the
writer and back through the parser: "keeps every label, and its colour, through Archidekt"
compares the label on every line before and after, and the CSV twin does the same over both
columns. The `it.each(READABLE)` fixed point would have stayed green if the caret group had never
been written at all — a channel neither writer emits cannot break a fixed point — which is why
those two exist beside it.

## The Arena filter — what "in MTG Arena" is measured as

Issue #192. The Arena format offers one checkbox no other format does — **Only cards MTG Arena
has** — and `src/features/transfer/export/arena.ts` is the whole of what it means. It is a *row*
filter rather than a field: it changes which cards there are lines for, never what a line says
about one, which is why it is not in `fields.ts` and not in the dialog's `Fields` row. Off on
every surface when the dialog first opens (`useAppStore`'s `exportPrefs.<surface>.arenaOnly`),
because this format has written every card handed to it since it shipped.

**It was the only row filter until 2026-09-07**, and the shape it settled — under the format
radios, in `exportPrefs`, fenced on the format, applied before the writer — is what the second one
was built to. That one is
[the inactive-category filter](#the-inactive-category-filter--the-dialogs-second-row-filter),
below; the rest of this section is about what *this* checkbox measures, which is a question no
other format can be asked.

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

## The inactive-category filter — the dialog's second row filter

Issue #390, shipped 2026-09-07: a reader exported a deck and found their maybeboard in the file.
**`Include inactive categories`** is the answer — a checkbox under the format radios, beside the
Arena one it is modelled on, and a *row* filter for the same reason that one is: it changes which
cards there are lines for, never what a line says about one. So it is **not in `fields.ts`**, it
rides in `useAppStore`'s `exportPrefs.<surface>.includeInactive`, and it **survives a format
switch** where `fields` is re-derived — a field set chosen for CSV means nothing to Arena, while
"write my switched-off piles" is the same answer whatever the reader passed through on the way
back.

**Named for what ticking it _does_**, where `Only cards MTG Arena has` is named for what ticking
that one leaves out. The reader's question is "is my maybeboard in this file"; a box called
`Leave out…` answers it inverted, and each box is named for whichever direction its own reader is
thinking in rather than for a convention the two are made to share.

### The two fences

| Fence | Where | What it stops |
| --- | --- | --- |
| `SURFACE_HAS_PILES[surface]` | `fields.ts` — `deck: true`, `collection: false`, `wishlist: false` | A collection or wishlist row carries `categoryActive: null`, so there is no pile to be in and the box would be a control over nothing |
| `!dropsInactive(format)` | `export/format.ts` — `ACTIVE_ONLY` is `arena` and `mtgo` | Those two have no maybeboard, so writing one produces an illegal import at the other end; a box there could never move a byte, which is the furniture `src/CLAUDE.md` forbids |

`offersInactive` in `ExportDialog.tsx` is the pair read together, and **it gates the filter as
well as the checkbox** (`excludesInactive = offersInactive && !includeInactive`). Both halves of
that matter. A preference the reader cannot see must never be quietly narrowing the file — and
under Arena and MTGO the honest sentence is the *format's* own, "not written in this format",
which stops being true the moment a reader's preference is what is doing the work.

**`SURFACE_HAS_PILES` is a declaration of its own rather than
`SURFACE_FIELDS[surface].includes("category")`**, and the two questions only happen to have the
same answer today: `category` is a *column a reader switches on*, this is about whether
`TransferCard.categoryActive` is ever anything but `null` on rows from that surface. A surface
could hold piles and offer no category column, and the field list would then answer the wrong
question with no symptom. It is total over `TransferSurface` for `DISCRIMINATOR`'s reason — a
fourth surface has to answer rather than defaulting to `undefined` and drawing the box over a
list with no piles in it.

### Off by default, and what that cost

**This is the one place the argument the Arena filter makes for its own default is deliberately
spent.** That argument — a filter that starts on quietly changes what an existing reader's next
export contains — is true here too, and is overruled because the *reported bug* is that those
exports contained the maybeboard. Shipping the box on by default would have shipped the fix with
the bug still in it.

Read off `ACTIVE_ONLY` in `format.ts` and `offersInactive`/`excludesInactive` in
`ExportDialog.tsx`, so re-read it there rather than trusting this table:

| Format | Wrote a switched-off pile before #390 | Box off (the default) | Box on |
| --- | --- | --- | --- |
| Plain text | yes | no | yes |
| MTGO | no — `ACTIVE_ONLY` | no; **box not drawn** | — |
| Arena | no — `ACTIVE_ONLY` | no; **box not drawn** | — |
| Moxfield | yes | no | yes |
| Archidekt | yes, with `{noDeck}` | no | yes, with `{noDeck}` |
| TCGplayer | yes | no | yes |
| CSV | yes | no | yes |

So **five formats changed what an existing reader's next deck export contains**, and Archidekt is
the one where ticking the box is also a round trip: the flag goes out with the pile and comes back
as `is_active = 0`. **What pays for the change is the count line** — whatever the box is holding
back is on screen, in copies, before Copy is pressed, so the change is never a silent one.

`exportPrefs` is session state and is not persisted, so the default reaches every reader on every
launch rather than only once.

### Two omission lines, and why the sentences differ

| Line | Drawn when | Sentence |
| --- | --- | --- |
| The reader's | `heldBackInactive > 0` — the box is off, on a surface with piles, in a format that has not already decided | `1 card in an inactive category is not written.` / `6 cards in inactive categories are not written.` |
| The format's | `omitted > 0` — `arena` or `mtgo` | `1 card in a switched-off pile is not written in this format.` / `6 cards in switched-off piles are not written in this format.` |

**`inactive categories` because that is the box the reader just pressed**; `switched-off piles`
because under those two formats there is no box, the pile is the only thing to name, and `in this
format` is the true ending there and false here. **The two can never be on screen together** —
they are fenced on complementary halves of `dropsInactive`, so each is non-zero exactly where the
other cannot be. Both count **copies** rather than rows, for `omittedCount`'s own reason: six
basic lands on one cut row are six cards missing from the file. Both are ordinary `text-dim`
lines rather than `role="alert"`, because nothing has failed.

The Arena line (`N cards are not in MTG Arena and are not written.`) is a third and can share the
panel with the format's, which is why they were never summed into one number: a maybeboard the
reader can switch back on and a card Arena has never printed are two different things to do
something about.

**Which list each count is taken over is load-bearing.** `omitted` counts over the list the writer
is *handed* — after whichever row filters were in force — so a card that is both outside Arena and
in a switched-off pile is reported once rather than twice. `heldBackInactive` and `notInArena` each
count over the unfiltered `cards`, which is the only list still holding what they removed.

### One piece of arithmetic behind two gates

`omittedCount` is now `dropsInactive(format) ? inactiveCopies(cards) : 0`, and its behaviour is
unchanged — the lift is the whole point. The dialog computes what the *reader* is holding back
from that same `inactiveCopies`, behind the complementary half of the same fence, so what the
format leaves out and what the reader asked to leave out cannot drift apart. Written twice, the
failure would be a line under the format radios describing a different file from the one Copy puts
on the clipboard: silent, plausible, and wrong in the direction nobody checks.
`format.test.ts` pins `EXPORT_FORMATS.filter(dropsInactive)` **by name** rather than by a count,
for `READABLE`'s reason — a format joining or leaving `ACTIVE_ONLY` should arrive as a red build
naming the format rather than as arithmetic somebody updates without reading.

### Neither golden bytes nor the Rust port moved

The filter is applied **in the dialog, before `formatExport`**, which keeps that function
`(cards, format, fields) => string` — the boundary the whole feature is built on, and what lets
`decklists.test.ts` drive the writer at all. Three consequences, all of them the fence working
rather than a gap:

- **No golden regeneration.** `__golden__/*.txt` is the writer's output over a fixed corpus and
  the writer's output did not change.
- **No Rust change.** `src-tauri/src/transfer/write.rs` already has `active_only` and
  `omitted_count`; there is nothing to port, because there is no reader in Rust for a preference
  the mirror never applies. `SURFACE_HAS_PILES` therefore sits **outside `fields.json`** too — that
  golden pins `SURFACE_FIELDS`, `availableFields` and `defaultFields`, which are what the writer
  renders from.
- **The plain-text mirror does not get the filter**, exactly as it never got the Arena one. A
  backup that narrows itself is not a backup; [text-mirror.md](text-mirror.md) carries the
  divergence. **`README.txt` is silent about this one and says the Arena filter out loud**, for the
  reason [the mirror section below](#the-three-ways-a-mirrored-file-differs-from-the-dialogs)
  gives — a mirrored file holding a pile the reader's export left out is not a thing they need
  warning about.

### A pile exported alone, with the box off, is an empty file

A category heading's `Export cards…` over a pile the reader has switched off writes `""`: the
disclosure reads `Show decklist (0 lines)` and the count line says how many copies are being held
back. **Deliberate rather than a hole**, and the difference from the Arena case is the whole
argument — there the same emptiness is the format's decision and nothing on screen can undo it,
here the box is on screen to untick. It is the same reason the deck scope passes *every* row of
the variant to the dialog: a caller that filtered first would take the box's answer away before
the question was asked.

**No live figures here yet.** Nothing about this checkbox has been driven in the shipped window at
the time of writing, and a number written before the window was driven would be a guess with a
date on it. What a pass owes an answer to: the box on a deck whose only inactive pile is empty
(both count lines absent, no state in between), the file a tick actually produces through
Archidekt's `{noDeck}` round trip, and whether the two count lines can be made to appear together
by any sequence of presses — the fences say no, and only the window can say it about the shipped
build.

## The field registry and the intersection rule

`src/features/transfer/fields.ts` declares two independent things and the export dialog draws only
their overlap:

- **A *format* says what channels it has** — `FORMAT_FIELDS[format].optional`. Arena's line has no
  printing-hint-free position for a `Condition` column at all; **CSV alone offers the whole of
  `TRANSFER_FIELD_IDS`**, which is literally how it is written (`optional: TRANSFER_FIELD_IDS`).
- **A *surface* says what facts it holds** — `SURFACE_FIELDS[surface]`. A deck has no purchase
  history; a wishlist has no piles.

`availableFields(format, surface)` is the intersection, filtered back into `TRANSFER_FIELD_IDS`'
own order (which is also CSV's column order, unconditionally). `defaultFields` is the same
intersection narrowed to what a format turns on by default. Neither function is symmetric with the
other surface: switching format re-derives the checked set from that format's own defaults rather
than carrying the old selection forward, because a set chosen for CSV means nothing to Arena.

**`quantity` and `name` are `ALWAYS`** — never drawn as a checkbox, because a line with no count
and no name is not a card. **Every other id in `TRANSFER_FIELD_IDS` can be optional somewhere.**

**There is no total written here any more, and the reason is on the record.** This page said
"25 fields total" from the day it shipped and went on saying it after the deck label's two fields
landed on 2026-08-24 — the array holds **27** ids as of 2026-08-25, counted by running the
module. A
count is a fact about a *tree*, `TRANSFER_FIELD_IDS.length` is the only honest way to ask, and
`fields.test.ts` already asserts one header per id, so the number is a build's answer rather than
a sentence's.

| Surface | Fields it carries, excluding `quantity`/`name` |
| --- | --- |
| `deck` | setCode, collectorNumber, category, finish, **label**, **labelColor**, lang, setName, rarity, typeLine, unitPrice |
| `collection` | setCode, collectorNumber, finish, condition, lang, tradelistQuantity, purchasePrice, purchaseCurrency, acquiredAt, acquisitionSource, serialNumber, grading, altered, signed, proxy, misprint, tags, notes, setName, rarity, typeLine, unitPrice |
| `wishlist` | setCode, collectorNumber, finish, lang, notes, rarity, typeLine, unitPrice |

(Transcribed from `SURFACE_FIELDS` on 2026-08-25 by running it, and the deck row is the one that
had rotted — it was missing the label's two fields and carried a stale count beside them. Re-read it
in the same commit that changes that constant. The collection carries every fact a physical card
can have except a pile, which is why its CSV is the tallest thing the export dialog draws.)
`category` is the one field neither the collection nor
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
| `label` | Label | `notes` | Notes |
| `labelColor` | Label colour | `setName` | Set name |
| `condition` | Condition | `rarity` | Rarity |
| `lang` | Language | `typeLine` | Type line |
| `tradelistQuantity` | Tradelist quantity | `unitPrice` | Price |
| `purchasePrice` | Purchase price | | |
| `purchaseCurrency` | Purchase currency | | |
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
| `deck` (existing) | `merge` / `replace` | `deck_id, variant, category_id, card_id, coalesce(finish,'')` (`schema::DECK_CARD_GRAIN`) | `replace` clears one **variant** first, named before it does; the mode radio says how many cards that would cost, and on a `live` list a note under the radios says where the cardboard goes — since 2026-09-01 (issue #336) the commit calls `deck::release_live_copies` before that clear, so every copy the deck's group held lands in `Recently removed` instead of being stranded under a deck that no longer lists it. Since 2026-08-23 it also draws the optional ["Add cards to collection" box](#the-deck-arms-add-cards-to-collection-box), which makes the press two writes |
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
- **The invalidation is the union of the deck's roots and the collection's**, and it is fired
  when the box was ticked **or** when the press was a `replace` on a `live` list. The collection's
  list and summary, the wishlist's owned progress and the search wall's owned badges each answer a
  question those copies just changed — and since 2026-09-01 a live `replace` changes it without
  the box being ticked at all, because the release files the deck's copies into `Recently removed`
  (issue #336). It is the same `OWNED_WRITE_KEYS` union rather than a second set, because it is
  the same claim about which roots a `collection_entries` write moves, and it is read off the
  mutation's own variables because every press is the same mutation. **No count fence on that
  arm**: whether the list held anything is not something the hook knows without another read, and
  a refetch answering what is already on screen is cheaper than a collection left wrong for the
  30 s `src/lib/query.ts` caches.

**The copies land in the deck's own group, and a plain collection import still lands at the
root.** `collection_import_commit` is `(items, mode, folderId)` since 2026-08-23 — `folderId`
defaults to `null`, which is the root and is what the collection's own import step sends, because
a file says nothing about a reader's filing. The deck arms are the one caller that names a folder:
`useImport` reads the deck's `kind: "deck"` group out of `collection_folder_list` **at press
time** — a query would be `undefined` while it loaded, and `importIntoNewDeck`'s deck did not
exist a statement earlier — and sends it, so the decklist and the group agree the moment the
dialog closes and no other deck can claim the copies. `collection::DECK_WRITE_FOLDERS` is the
fence: the reader's own folders and a deck group, never `Recently removed` and never an id nothing
answers to. **It was called `IMPORT_FOLDERS` until 2026-09-03**, when the quick add
(`deck_quick_add.rs`, [issue #350](https://github.com/Msgaihede/mtg-grimoire/issues/350)) became
the second write to pass it — a constant named after one of its two callers is a name that reads
as a rule about imports rather than about deck-driven writes. A deck with no group **refuses** (`NO_DECK_GROUP`, the crate's own sentence) rather
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

### An ungraded copy is an empty Condition cell, and that is what closes the round trip

Schema v35 gave `collection_entries.condition` a sixth value, `NONE` — *not set*, the grade that
says nobody assessed the copy, and the column's `DEFAULT` since 2026-09-07
([issue #361](https://github.com/Msgaihede/mtg-grimoire/issues/361)). It is a **storage** decision
— a sentinel exists because `condition` is `idx_collection_grain`'s third term and SQLite counts
two NULLs as distinct in a unique index — and **it stops at the database**. A row → `TransferCard`
mapping turns it into `null`, `fields.ts` already writes `c.condition ?? ""`, and the cell comes
out **empty**.

Writing the four letters instead would export the mechanism rather than the fact. A re-import
would still close, because `normalizeCondition` knows the word — but every other tool a reader
opens that CSV in would show a column of `NONE` where the truthful answer is a blank. The blank is
also *exactly* what the importer already reads as "the file did not say", which is now `NONE`
again: the round trip closes because the two ends were already speaking about silence, not because
anything was added to make them.

**This is the one mapping the golden fence does not cover, and that is worth stating plainly**
because the shape of `__golden__/` suggests otherwise. Its `corpus.json` holds *already-built*
`TransferCard`s, so the fence begins **downstream** of the row → Card step; neither
`src/features/transfer/TransferCard.ts`'s `conditionOf` nor `src-tauri/src/mirror/read.rs`'s
`condition_of` is executed by any golden test, and the corpus contains no `NONE`. The two
implementations of this substitution are held by one unit test each and by nothing else. Two
agents writing the halves in parallel both recorded the fence as covering it; it does not.

### A recorded purchase price can be corrected, never removed

`EntryPatch` is `coalesce(?n, column)` in all eighteen of its holes, so an absent field means
"leave it" and **there is no value that means "make it null"**. That is right for a patch built
from an eight-field form, and it leaves one thing a reader cannot do: unsay a price. The Edit copy
dialog does not pretend otherwise — the box is seeded with the recorded figure, and a line under
it says emptying the box leaves that figure recorded. The alternative considered was a box that
opens blank, which makes "empty means leave it" true by construction and buys it by hiding the
number the reader opened the dialog to check.

The neighbouring trap is the same no-op reached from the other side: a box holding something
unparseable **greys Save and names the trouble**, rather than dropping the field from the patch
and writing nothing while looking like it wrote something.

### Both surfaces driven in the shipped window

2026-09-07, debug `tauri dev` at 1920×1080 over a copy of the main checkout's real database.

**The add popup.** Opens on `Not set`; the price box is empty with the marketplace figure as its
placeholder, and **the placeholder follows the finish chips** — `$0.32` on nonfoil, `$0.43` the
moment Foil is pressed, with the typed value untouched. Typing `4.25` and adding wrote
`condition: NONE, finish: foil, purchase_price: 4.25, purchase_currency: USD,
condition_original: null` — the default, the money and its currency, all from one press.

**The collection table.** An ungraded row's `Finish · condition` cell is the finish **alone** —
`Foil`, with no `<abbr>` and no `sr-only` parenthetical hanging off it. Edited to Lightly played
it becomes `Foil · LP` with both back. Two states of one cell, and the empty one is the one
jsdom could not have caught drawing `Foil · NONE`.

**The Edit copy dialog.** `ipc.collectionUpdate`'s first caller wrote `LP` and `9.99` over the
row above. At the app's own floor — a 1024×700 window, so a **666px** page viewport — the panel
is **313px** with **177px** of headroom and both buttons inside it. It only overflows below a
**~380px** viewport, which `minHeight: 700` puts out of reach, so the clamp needs nothing.

**The condition filter.** The tray draws six chips on one row at 1920 (83px each, group 530px)
and at 1024 (group 352px, right edge 972, no page scroll); at 900 and 700 it becomes the grid,
with `Not set` on its own full-width row and the five grades in two rows behind it — no clipped
text and no horizontal overflow at any width. `Not set` carries **no `aria-label`**, because its
visible text is its name, while `NM` still announces `NM, near mint`. Filtering by it answered
**0 rows** against a collection whose only loose copy was `LP`, and switching the chip to `LP`
brought that row straight back — the sentinel really does reach the backend and really does
discriminate. The summary chip reads **`Condition: Not set`**, not `Condition: NONE`.

**One thing measured and deliberately not fixed.** Escape, Cancel and a successful Save all
leave the caret on `<body>`, so the next Tab restarts from the top of the app. That is **not
this dialog's** doing: the same pass drove `AllPrintingsDialog` from the same context menu and
got the same answer, so it is how every dialog opened from a context-menu row already behaves —
the menu's opener is a table row that has unmounted by the time the dialog closes. Worth a fix
of its own, in `Dialog`/`useContextMenu` rather than here.

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

## The second writer, in Rust — 2026-08-25

**`src-tauri/src/transfer/` is a Rust port of this writer, and it is the one place in the app
where a piece of domain logic deliberately exists twice.** It was written for the plain-text
mirror, which is maintained by a background thread and cannot ask the page to render a file.
Moving the writer to Rust outright — having this dialog fetch its text over IPC — was considered
and rejected: it turns the live field preview into a round trip per checkbox, strands the
writer-to-parser round-trip test vitest owns, and forces the Storybook fake to grow a third
writer. What the two implementations cover:

| TypeScript | Rust |
| --- | --- |
| `fields.ts` — the registry, `FORMAT_FIELDS`, `SURFACE_FIELDS` | `transfer/fields.rs` |
| `export/format.ts`, `export/fold.ts`, `csv.ts` | `transfer/write.rs`, `fold.rs`, `csv.rs` |
| `TransferCard.ts` and its three row adapters | `transfer::Card`, built by `mirror/read.rs` |
| `import/parse.ts` | **nothing — the parser stays TypeScript-only** |
| `export/arena.ts` — the Arena row filter | **nothing — the mirror leaves it off** |
| `fields.ts`'s `SURFACE_HAS_PILES`, `format.ts`'s `isActivePile`/`inactiveCopies` — the inactive row filter | **nothing — the mirror leaves it on** |

The last two rows are one rule: a row filter is the *dialog's*, so neither side of the fence has
anything to keep in step. `dropsInactive` is the exception that proves it — `write.rs`'s
`active_only` is the same fact, and it is ported because the *writer* branches on it.

**`src/features/transfer/__golden__/` is what makes that legal.** One committed corpus and one
committed golden set per scenario × format × field set; `npm run golden` regenerates them from
*this* writer, which is the behaviour of record, and both suites assert byte equality against the
same files. A change to either writer without the other is a red build. `src/features/transfer/CLAUDE.md`
carries the working rules; [text-mirror.md](text-mirror.md) carries the whole record, including
the three real rules in `format.ts` that **no golden file held** — a golden pins only what the
fixture varies, and the corpus never varied `SECTION_ORDER`'s input, Archidekt's discriminator, or
Arena's filter-versus-fold order.

**The port reproduced every golden on the first run of the finished writer**, and it held against
the real corpus: driven live 2026-08-25 (debug build), all seven of a real deck's mirrored files
were byte-identical to what this dialog produces with every field ticked — `Azula.csv` included,
at 11,527 bytes against 11,471 characters, so the 56 bytes of multi-byte UTF-8 in the type lines
matched too.

### The three ways a mirrored file differs from the dialog's

The first is a property of the *format*, not a setting the mirror could have switched on. The
other two are the same sentence about two different checkboxes: **every row filter the export
dialog offers is a filter the mirror leaves off**, because a backup that narrows itself is not a
backup. **The mirror's own `README.txt` names the first two and deliberately not the third**, which
is an asymmetry rather than an oversight: the first two cost the reader something — a pile missing
from two of the files, and an `*.arena.txt` Arena would reject — while the third only ever hands
them a pile their export left out. A backup that holds more than you asked for needs no warning.

- **MTGO and Arena have no maybeboard.** Both write only the piles the reader has switched on, so
  a switched-off pile is absent from `*.mtgo.txt` and `*.arena.txt` and present in the other five
  — and in the CSV, which is where every card always is. In the export dialog this is the
  `omittedCount` line; a file on disk has nowhere to put one.
- **The Arena row filter stays off in the mirror.** `*.arena.txt` lists every card, which makes it
  a complete record and **not** a file Arena would accept for a paper collection. The mirror is a
  backup first; a reader who wants an importable Arena list uses this dialog, where the filter is
  a checkbox — and it is off by default there too, for the reason
  [the Arena filter section](#the-arena-filter--what-in-mtg-arena-is-measured-as) gives.
- **`Include inactive categories` stays on in the mirror**, which is the same decision worded the
  other way up, because that box is named for what ticking it *does*. Since 2026-09-07 the dialog's
  default is **off** — a deck exported to plain, Moxfield, Archidekt, TCGplayer or CSV leaves a
  switched-off pile out unless the reader says otherwise — and the mirror ignores the preference
  entirely, so those five mirrored files still carry every pile. The divergence is the point: the
  dialog writes a file about to be handed to a deck site, where a maybeboard is usually noise, and
  the mirror writes the copy that has to still hold the reader's `Cuts` pile in a year.

## Where the code is

`src/features/transfer/` (`TransferCard.ts`, `fields.ts`, `csv.ts`, `formats.ts`, `export/` —
including `export/arena.ts`, the Arena filter's rule — and `import/`) is the whole of the
TypeScript side, with `__golden__/` and `scripts/golden.mjs` the fence between it and
`src-tauri/src/transfer/`, the Rust writer the plain-text mirror renders through
([text-mirror.md](text-mirror.md)); `src-tauri/src/import.rs` (renamed from
`deck_import.rs`), `export.rs`, `collection.rs`'s `collection_import_commit` and `wishlist.rs`'s
`wishlist_import_commit` are the Rust side. `src/components/Dialog.tsx` is the shared modal shell
both `ExportDialog` and `ImportDialog` are built on. `src/features/decks/CLAUDE.md` still owns
deck-specific rules this feature reads or reaches into — categories, validation, formats.

**The inactive-category filter added no file to any of that**, which is the shape a row filter has:
`fields.ts` (`SURFACE_HAS_PILES`), `export/format.ts` (`dropsInactive`, `isActivePile`,
`inactiveCopies` — the three answers the writer already knew privately, each now a named export
with a test under it), `export/ExportDialog.tsx` (the checkbox, `offersInactive`, the filter above
`formatExport` and the count line) and `src/lib/store.ts` (`ExportPrefs.includeInactive`).

The "Add cards to collection" box is three files of that tree: `destinations/DeckPreview.tsx`
(`OwnCopies`, `OWN_COPIES_HINT`, and the outcome line), `destinations/NewDeckPreview.tsx` (which
imports that same component rather than drawing a second), and `useImport.ts` (`OwnedCopies`,
`ownCopies`). `OWNED_WRITE_KEYS` — the four query roots such a write moves — moved to
`src/lib/query.ts` on 2026-08-23, because the deck builder's own `own` add makes the same change
from the other side of the app and the two had drifted to two different invalidations. Where those
copies end up is
[collection-folders.md](collection-folders.md)'s subject, not this page's.
