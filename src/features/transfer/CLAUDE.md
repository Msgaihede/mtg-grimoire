# src/features/transfer — card import and export

`import/` and `export/` — decklist parsing, planning and writing, and the two dialogs that drive
them. Moved out of `src/features/decks/` (this used to be that feature's `## Import` and
`## Export` sections, word for word) because the same machinery is meant to serve surfaces
beyond the deck editor. Deck-specific rules this module reads or reaches into — categories,
validation, formats — still live in
[`src/features/decks/CLAUDE.md`](../decks/CLAUDE.md).

## Import

`import/` is `parse.ts` (text → lines), `destinations/deck.ts` (lines + the printings Rust
resolved + **their Oracle tag slugs** → piles, a commander, tallies), `useImport.ts` (the writes)
and `ImportDialog.tsx` (two steps, one panel, nothing written until Import).

- **The dialog is a shell over an `ImportDestination`, and the second step belongs to the
  destination** (2026-08-20). `destination.ts` is the seam: the shell owns the pasted text, the
  file picker, the one `import_resolve` call, the step machine and the dismissal rungs — the
  three questions that are the same wherever the cards are going — and a destination owns its
  options, its preview, its mode radios and its Import button. **It is deliberately not
  generic**: an `ImportDestination<TItem, TOptions>` cannot be held in one array by a shell that
  does not know which it has, because parameter positions are contravariant and nothing widens
  to `ImportDestination<unknown, unknown>`; every escape from that (a union to narrow, a cast, a
  hook whose identity changes when the reader switches destination) is worse than four short
  bodies over shared furniture. Two consequences worth carrying: **the new deck's name, format
  and game are drawn on the preview step**, beside the tally its format changes, rather than
  under the paste box where they used to be — the shell asks one question, what is the list, and
  every question after it belongs to whatever the list is going into; and **`deckDestination` is
  a function while `newDeckDestination` is a value**, because the deck preview's extra props are
  required and a bare descriptor behind a cast would be a value that type-checks and crashes
  wherever anybody mounted it without the wrapper.

- **`destinations/deck.ts` stays pure and takes the slugs as an argument.** It is React-free on
  purpose and not merely by habit: `decklists.test.ts` imports it for the round trip, and a
  descriptor at the bottom of it would drag the whole React and IPC graph into a suite that only
  wants a planner. The tag read is chained inside
  `useImport`'s `resolve` mutation, after `import_resolve` and in the **same**
  `mutationFn` — **one** `oracleTagsForPrintings` over the deduped matched ids for the whole list,
  never one per line. Putting it there rather than in the planner is what closes the tally-flicker
  hole _by construction_: the dialog crosses to step two in that mutation's `onSuccess`, so the
  preview is never reached holding only the printings and there is no window in which a type-line
  tally is on screen waiting to be redrawn. A refused tag read files the whole list by type line
  and never costs the reader their paste. The Rust half and every measurement:
  [docs/reference/decks-storage.md](../../../docs/reference/decks-storage.md).

- **One parser for every export, and every rule in it is a _per-line_ rule.** A format detector
  would have to choose a reader before it had read anything, and would be wrong about exactly the
  lists somebody has edited by hand. So an unfamiliar mixture is read line by line rather than
  refused whole.
- **CSV is the one exception, and it is a _file-level_ judgement made once, on the header row
  alone** (Task 10 — CSV was write-only before this). Two known columns, one of which is Name,
  is the content test; the row after it has to carry the header's own field count before the
  verdict is trusted, which is what stops a plain line like `"Quantity, Name"` — two cells off
  its one comma, both naming a known column — from being read as a header over a file that is
  not a CSV at all. A header this app *nearly* recognises (two known columns, no Name) is a CSV
  from somewhere else and gets one sentence rather than a per-line issue per row. Once the header
  is trusted every later row is read **by column**, never by the line grammar below it — a
  `Condition`/`Purchase price`/… cell is what makes the collection's own import a restore rather
  than a dump. Full header vocabulary and the field-count check:
  [import-export.md](../../../docs/reference/import-export.md).
- **Four decorations and one heading rule, and the heading rule is the _only_ lookahead in the
  file.** The four are per-line and cost nothing: an **empty `()`** printing hint, an Archidekt
  `^Tag,#colour^`, the `[Category]` bracket, and the `*F*`/`*E*` finish markers it always had (a
  trailing `#tag` rides with those). **Two of the four are read rather than merely stripped** —
  `*F*`/`*E*` since 2026-08-17 and `^Tag,#colour^` since 2026-08-24, each because the app grew
  somewhere to put it. `namesASection` is the fifth rule and it reads one line past
  the one in front of it, because `Anthem`, `Creature` and `Land` are indistinguishable from card
  lines to a per-line reader and a category name can be a real card (`Fog`, `Wrath`, `Duress`).
  **Its four clauses each protect a hand-written list `parse.test.ts` carries as its own test**: a
  candidate has **no quantity, no printing hint and no bracket** (a heading is a bare word, and
  every card line in an export that writes headings carries at least one of the three); **the next
  line that makes a claim carries a count**, which is what leaves `Sol Ring` / `Arcane Signet` /
  `Path to Exile` alone _and_ what makes a heading over an empty section impossible, so "nothing is
  ever silently dropped" stays true — a line consumed as a heading always opened at least one card;
  **it is preceded by a blank line**, without which `Sol Ring` / `4 Shock` loses its first card;
  **or it is the first line of the file and that next line carries a bracket**, because an
  Archidekt deck with no commander opens on a heading with nothing above it while a hand-written
  list writes no brackets at all. **The failure it keeps, named rather than hidden**: a
  hand-written list with a blank line, then a bare card name, then a counted line, loses that name.
  No exporter in scope emits that shape.
- **The first bracket entry is the pile, and `{flag}`s come off.**
  `[Land,Maybe (New){noDeck}{noPrice}]` is `Land`. **Verified 105/105 against a real Archidekt
  export** (re-counted 2026-08-16): in every one of its 105 lines the first entry is the heading
  that line is printed under — 14 headings against 14 distinct first-bracket names, identical sets,
  0 disagreements — which is what makes it safe for the bracket to override the open heading rather
  than merely agree with it.
  `{top}`/`{noDeck}`/`{noPrice}` are Archidekt's and anything in braces is a flag rather than part
  of a name. **`{noDeck}` on the _first_ entry is `is_active = 0`** — the file saying this pile
  counts toward nothing — and on a **later** entry it means nothing here: the card is also filed in
  some maybeboard and is still in the deck. **17 of that export's 105 lines** carry it first, and
  the flat export's four `[Land,Maybe (New){noDeck}{noPrice}]` lines are the later shape;
  `parse.test.ts` counts the 17 and pins the flat list at **0** excluded lines, which is the whole
  of the difference.
- **`^Keeper,#4aab08^` is a label and the reader picks which ones come across** (2026-08-24).
  Archidekt's caret group is per-card and this app's `deck_cards.tag_id` holds exactly one, so the
  two line up; the parser reads `ParsedLine.tagName`/`tagColor`, the planner folds the distinct
  ones onto `ImportPlan.tags`, `shared/ImportTags.tsx` draws a checkbox each — **all ticked**,
  because a list that carries labels is a list somebody labelled on purpose — and
  `toImportItems` puts the surviving name and colour on every item wearing it. Six rules, each
  with a failure behind it:
  - **The colour is split off at the _last_ comma, not the second.** A label's text is free —
    `Fence (flavor)` is a real one — so a comma inside it is possible, and `/^([^,]+),(#.+)$/`
    would be right by accident and wrong on the first `Cut, maybe`. A tail that is not a hex is
    read as part of the name, and a group with no colour at all is still a label:
    `ImportPlan.tags` gives it `DEFAULT_TAG_COLOR` so the swatch on the step is the colour the row
    would really be made with.
  - **Distinct by `tagNameKey`, never by the word** — the webview's copy of
    `schema::tag_name_key`, which is `deck_tags.name_key`'s own grain. A file writing `Keeper` and
    `keeper` names one label, and two boxes for it would let a reader tick one and untick the
    other over a distinction the database does not have. First spelling and first colour win, for
    `ImportItem.inactive`'s reason.
  - **The picker draws what the import will _use_, not what the file said.** One
    `deck_tag_all` read (the same `["decks", "tagsAll"]` key `useDeckMeta` holds, so an open
    editor makes it free): a name this app already has draws that row's swatch and that row's
    capitals and reads *already yours*. `commit_import` finds before it creates and changes
    nothing it finds, so drawing the file's green over a reader's purple would be a preview of an
    import that is not going to happen — and a tag is app-wide since schema v21, so a recolour
    would reach every deck they own.
  - **The selection is held as the labels that are _off_.** "All ticked" as a `useState` seeded
    from the plan is derived state, stale the moment the plan changes, and repairable only with a
    `setState` inside an effect this repo's lint refuses. Holding the exclusions makes the default
    the empty set, which is correct for every plan without being about any of them.
  - **`toImportItems` tells an empty tick set from `null`.** `null` is a caller that draws no
    picker; an empty set is a reader who unticked every box. Collapsing them would make unticking
    the last box bring every label silently back.
  - **A label survives the commander choice**, where the pile and the `{noDeck}` flag do not. Those
    two are filing and the command zone outranks filing; a label is what the reader thinks of the
    card, and a commander they marked `Keeper` is still a keeper.

  The Rust half — find-or-create by `name_key`, the `coalesce` that makes a merge keep a tag the
  reader put on by hand, and the undo step that sweeps the labels an import invented — is
  [`src-tauri/CLAUDE.md`](../../../src-tauri/CLAUDE.md)'s and
  [decks-storage.md](../../../docs/reference/decks-storage.md)'s. The **export** half is the
  `## Export` section below. **Not yet driven in the shipped window.**
- **A heading _or_ a bracket naming a section word sets the _section_, not a category** — one
  mechanism for the four seeded piles, not two. `[Commander{top}]` reaches the command zone through
  the same `SECTIONS` map a `Commander` heading goes through, so nothing downstream has to know
  which of the two a line arrived by, and only a name the section vocabulary has never heard of
  becomes a `categoryName`.
- **`ParsedLine.categoryName` is `null` whenever the section is not `deck`**, enforced on the way
  out of the loop rather than left to whoever reads it. That invariant is the whole of what makes
  `categoryFor` **three** rungs rather than four: no reachable line carries a zone and a free-form
  pile at once, so the two can never both answer.
- **The chain, in the order the reader's own intent narrows:**
  `forcedCategoryName > SECTION_CATEGORY[kind] > line.categoryName > autoCategoryFor(…)`. **The
  zone is above the name and not below it**, which is not the order the two arrived in: a section
  is a _rules fact_ (the command zone, a sideboard) and a category name is _filing_, so if that
  invariant were ever relaxed a card in the command zone must not be filed out of it by a bracket.
  **A file naming a pile is the reader naming one** — the app's rule has always been that an add
  naming a category is untouched, and an Archidekt export naming `Flash Enabler` is that same
  statement, made weeks ago in somebody else's deck builder. `autoCategoryFor` is untouched and is
  still the app's one filing rule for everything that names nothing, and the command zone still
  outranks all four, applied in `toImportItems` after the pile is chosen. The reasoning for the
  order is
  [the spec's §2](../../../docs/superpowers/specs/2026-08-15-deck-format-support-design.md).
- **An empty `()` is a real hint shape, and it costs `hintMissed` rows.** `1 Aerith, Last Ancient
  () 76` is **33 of one reference export's 88 lines** — the exporter had a collector number and no
  set and wrote the parentheses anyway — so `LINE`'s set group is `\w{0,10}` and an empty match is
  `setCode: null` with the number kept. Widening the count to zero cannot cost `Erase (Not the
  Urza's Legacy One)` its parentheses: the hint is still anchored to the end and a set code still
  holds no spaces, so a parenthesised _phrase_ can never satisfy it. **What it costs, stated rather
  than discovered**: `resolve_lines` sets `hint_missed` for a collector number with **no** set
  beside it without trying it at all — a number is not unique across sets, so it can only ever
  narrow one — so that list previews **33 hint misses** where it used to preview 33 unresolved
  cards. Both halves are re-derived rather than remembered: `parse.test.ts` counts the 33
  `setCode: null` lines out of 88, and the branch that sets the flag is `import.rs`'s. **Not
  yet driven in the shipped window.**
- **`[Foil]` is decoration and never a pile — and never a _finish_ either.** `FINISH_WORDS`
  matches `foil`/`etched`/`non-foil` whole and case-insensitively, because reading one as a
  category would put a pile called "Foil" in somebody's deck. **Anything else in a bracket
  is a category** — guessing which words are "really" categories is the format detector this file
  exists without. Since 2026-08-17 a line's `*F*`/`*E*` **is** read (`FINISH_MARKER` →
  `ParsedLine.finish` → `ImportItem.finish`), which makes the second half worth stating: a
  bracket is the *category* channel, so a finish that arrived there is an exporter being loose
  with a field, while `*F*` is the channel every format that says anything about a finish agrees
  on.
- **`//` is a comment only at the _start_ of a line.** `1 Branchloft Pathway // Boulderloft
Pathway` is one card and there are seven such names in the reference list alone, so a `//` found
  anywhere else is part of the name and must never be cut.
- **The line splitter takes CRLF, a lone LF _and a lone CR_.** `/\r?\n/` — the obvious spelling —
  treats a carriage return on its own as nothing and `.` does not cross one, so a CR-only paste
  arrived as **one** row that matched nothing and the whole list came back as a single issue.
- **Nothing is ever silently dropped.** A line the parser cannot read becomes a `ParseIssue`
  carrying its number and its raw text, and one bad line never aborts the parse. The only lines
  that leave no trace are the ones making no claim — blanks and comments.
- **`destinations/deck.ts` makes every deck decision and the dialog makes none.** The pile is
  `autoCategoryFor` (the app's one rule, never copied — a plain add, a drag with no column under
  it and an imported line have to agree) and the commander is `commanderIneligibility`, the same
  rule the validation
  panel judges a built deck by. A looser "looks like a commander" test here would offer a card the
  panel then refuses.
- **`row.index` is the address, never the array position.** `import_resolve` carries the
  caller's own index back precisely so the two can differ; reading `rows[i]` against
  `parsed.lines[i]` works today and mis-files the whole list the day anything filters between them.
- **`CardIdentity` is the card-level half of `CardFacts`, and `CardFacts` was deliberately _not_
  narrowed to it.** It exists so the importer can ask "could this be a commander?" about a card
  that is in no deck yet and therefore has no `id`, no `categoryKind` and no honest `quantity` to
  invent — but the engine really does read `categoryKind`, `categoryActive` and `quantity`, so a
  card in a deck is more than a card. Every existing caller passes a whole `DeckCard`, which
  satisfies a `Pick` of itself, so the widening changed no call site.
- **An import is not an add path and must never become one.** Routing a list through
  `useDeck.addCard` would be **one transaction per line**; `deck_import_commit` is one for the
  whole file. Both write `deck_cards` and nothing else: since schema v25 the copies that back a
  deck's rows are the `collection_entries` filed in that deck's group, and only
  `collection_to_deck` / `deck_to_collection` move a row across that boundary. So an import
  fills the list and leaves the reader to file the cardboard. `useImport`'s fourth mutation, `importIntoNewDeck`, is
  `deck_create` then that commit with a **hand-rolled rollback** — two commands are two
  transactions, and a refused import must not leave half a deck in the gallery. The commit's
  refusal is what the caller hears, never the clean-up delete's.
- **The file picker's own half is unverified**, for the reason `deck_set_cover_image`'s is:
  `dialog:allow-open` opens a native window CDP cannot reach. Path → text → preview is tested;
  click → path is not.
- **Driven in the shipped window 2026-08-12** (`npm run tauri dev`, a **debug** build): the
  gallery path end to end put **105 of 105** reference-list lines and all **117 copies** into a
  new deck, `import_resolve` cost **120.4 ms** and `deck_import_commit` **7.9 ms** through
  `invoke` on that build, and the commander step offered **56** candidates — the list's 55
  legendary creatures plus a legendary Spacecraft with a P/T box. Every figure, the variant and
  audit checks, and the three resolver-side faults it found — all since fixed: a printing hint
  trusted over the card name, `MOXFIELD_LIST`'s fabricated hints, and `MATCH_ORDER` having no
  language term — are in
  [decks-storage.md](../../../docs/reference/decks-storage.md).
- **The preview's tally is counted over the _items_, never over the plan** — `tallyOf(items)`
  where `items` is `toImportItems(plan, commanderIds)`, so it recomputes on every press. There is
  deliberately **no `categories` field on `ImportPlan`**: the piles are a fact about what is being
  sent, and the commander choice is applied in `toImportItems` and nowhere else, so that is the
  only place a preview of it can be counted. `totalCards` stays on the plan, because the choice
  changes _which_ pile a card lands in and never _how many_ copies land. This was a live bug:
  measured 2026-08-12, the reference list previewed as **`117 cards · 6 categories`** with
  `Creature 56` and no Commander row while `deck_get` after the import read **7 categories**,
  `Creature 55`, `Commander 1`. Worst on the **`automatic`** arm, where the reader presses
  nothing — the dialog printed _"Krenko, Mob Boss goes in the command zone"_ directly above a
  tally filing him under `Creature`. `fromFile` was the one arm that agreed, because there the
  card already carries the Commander category name. The split `toImportItems`' doc calls
  deliberate is still right ("the plan is what the preview draws _while_ they are still
  choosing"); what was wrong is that the tally was ever part of the plan.
- **The layer contract holds and was measured, not assumed.** The dialog's scrim computes to
  `z-index: 45` from both entry points (`LAYER.overlay`, the rung the editor's other full-window
  surfaces share); one Escape closed the dialog and **left the card pane open**, handing focus
  back to the `Import cards` button that opened it, and a second Escape closed the pane; 22 Tab
  presses from the textarea produced 22 focus landings and **every one inside the dialog**.
- **Reduced motion is honoured on both halves, and only the live pass could show it.** Under
  emulated `prefers-reduced-motion: reduce`, the panel's `transform` at 60 ms was **`none`**
  against `matrix(0.9818…)` unemulated — `MotionConfig reducedMotion="user"` reduces `scale`
  because it is a transform, unlike the deck stack's `marginBottom` — while `opacity` kept
  animating (0.137), which is the weaker rule `lib/motion.ts` documents on purpose. No
  `useReducedMotion()` opt-out is owed here. The buttons' CSS half read
  `transition-property: none` **while `transition-duration` still read `0.12s`** — the false
  failure the harness contract warns about, reproduced exactly.
- **An import can be aimed at one pile, and it is a new argument on the import path rather than a
  new import path** (2026-08-14). A category heading's right-click opens the same dialog carrying
  `forcedCategoryName`, and the paste lands in that pile — **overriding `autoCategoryFor` and a
  section heading both**, which is consistent with the rule the importer already follows (an add
  that names a category is left untouched) and is what right-clicking a specific pile means. A
  heading is what somebody else's exporter wrote; the right-click is the reader pointing at a
  column of their own a moment ago, so the later and more specific naming wins. **The command zone
  still outranks it**, applied in `toImportItems` after the pile is chosen — a commander goes to
  the command zone whichever heading was right-clicked. It is applied in `categoryFor` and nowhere
  else, because **`destinations/deck.ts` makes every deck decision**; the dialog only reports
  it, in the header line the deck destination supplies (`Into <pile> · <deck> · <variant>`). The
  argument is
  **optional and defaults to today's behaviour**, so the toolbar's own Import passes nothing and is
  unchanged — which is what keeps a shared importer from being reshaped by one caller.

## Export

`export/` is the mirror of `import/`, and the split is the repo's boundary: `format.ts` is
`(cards, format, fields) => string` — no React, no hook, no IPC, and `arena.ts` beside it holds
to the same rule — `ExportDialog.tsx` is the surface (a format picker, a field-checkbox row, the
Arena format's own filter, a live preview, Copy and Save as…), and Rust supplies only the file
write. **Four controls open that dialog now** — the deck editor header's
`Export deck` and a category heading's `Export cards…` (`DeckEditor.tsx:3443`, one mount both
reach), and one apiece on `CollectionPage.tsx:585` and `WishlistPage.tsx:438` — and what differs
between them is no longer only which cards the caller passes: `surface` and, on the collection
and the wishlist, `scope` differ too. Full reference, every figure kept beside the build it was
measured on: [import-export.md](../../../docs/reference/import-export.md).

- **`fields.ts` declares two independent things and the dialog's checkbox row draws only their
  overlap.** A *format* says what channels it has (`FORMAT_FIELDS[format].optional` — Arena has
  nowhere to put a `Condition` column at all, CSV offers every one) and a *surface* says what
  facts it holds (`SURFACE_FIELDS[surface]` — a deck has no purchase history, a wishlist has no
  piles). `availableFields(format, surface)` is the intersection; `quantity` and `name` are
  `ALWAYS` and never drawn as checkboxes, because a line with no count and no name is not a card.
  Switching format re-derives the checked set from that format's own defaults rather than
  carrying the old selection forward — a set chosen for CSV means nothing to Arena.
- **The Arena format's own checkbox is a _row_ filter, not a field, and that is why it is not in
  `fields.ts`** (issue #192, 2026-08-22). A field says what a line says about a card; **Only cards
  MTG Arena has** says which cards there are lines for, so it sits under the format radios rather
  than in the `Fields` row, is drawn for `arena` alone, and rides in `exportPrefs` beside the
  format and the field set — **surviving a format switch where `fields` is re-derived**, because a
  field set chosen for CSV means nothing to Arena while "leave out what Arena does not have" is
  the same answer whatever the reader passed through. **Off on every surface on a first run**: the
  format has written every card handed to it since it shipped, and a filter that started on would
  quietly change what an existing reader's next export contains. It is applied in the **dialog**,
  before `formatExport` — which keeps that function `(cards, format, fields) => string`, the
  boundary this whole directory is built on, and keeps `omittedCount` honest, since it then
  measures what the format leaves out of the list it was actually handed and a card that is both
  outside Arena and in a switched-off pile is reported once rather than twice. The filter is
  fenced on the **format** as well as the flag, or a reader who ticked it and moved to CSV would
  find their CSV quietly short of rows.
- **`export/arena.ts` reads legality because `games` answers a different question, and the key
  list has one exclusion that cannot be derived.** Scryfall's `games` says `arena` about a
  *printing*: the Alpha Lightning Bolt is `["paper"]` while the card is in Timeless, so a
  `games`-based filter would empty a paper collection. `ARENA_LEGALITY_KEYS` is the `format_specs`
  rows whose seeded `games` cell says `arena` — **minus `gladiator`**, which is a real Arena
  format whose Scryfall legality is not computed from Arena's pool and marks paper-only cards like
  Grand Coliseum and Exotic Orchard `legal`. Measured over the live 116,712-printing corpus on
  2026-08-22: eight keys match 15,973 of the 16,219 cards with an Arena printing and keep **0**
  without one, `gladiator` alone accounts for all **37** false keeps a nine-key list makes, and
  `timeless` alone would drop **462** cards Arena has — every `A-` rebalanced Alchemy card among
  them, since Timeless excludes rebalanced cards and Arena is the only place they exist. The blob
  is read by key **name** and never by bit position: `legal_mask`'s offsets are stored data
  `src-tauri/src/legalities.rs` freezes, and a copy of that order over here would be a second
  place for it to drift. Every figure, and why `CollectionRow`/`WishRow` carry the 483-byte blob
  rather than the 8-byte mask: [import-export.md](../../../docs/reference/import-export.md).
- **`foldForFields` merges rows the chosen fields cannot tell apart, and `DISCRIMINATOR` is why a
  fold never crosses a section.** The collection keeps 2 NM and 1 LP Lightning Bolt as two rows
  on purpose; a plain-text export has no condition channel, so writing them as two identical
  lines hands a reader a decklist naming one card twice, which is what the fold is for. But the
  chosen fields are not the only thing a writer tells two rows apart by: `sectionOf` groups
  Arena, Moxfield and MTGO by section and Archidekt keys on `[categoryName, categoryActive]` for
  `{noDeck}`, whether or not `category` is among the fields the reader switched on. Folding on
  fields alone can merge a Sideboard row into a Main-deck row — the merged row inherits the
  *first* card's section — and that is not a formatting slip, it moves cards between the zones of
  the exported deck. `format.ts`'s `DISCRIMINATOR` map is what closes it, one arm per
  section-writing format plus an explicit `null` for the three flat ones, **total rather than
  partial**: a `Partial` map let a future section-writing format compile with no discriminator at
  all, reproducing this same defect by omission rather than by a typo anyone would catch.
- **The deck label goes out too, and it is the one field a format writes more of than it
  declares** (2026-08-24). `tag` is the name and `tagColor` is the colour, and they are two fields
  because the two media differ: Archidekt writes both as `^Keeper,#4aab08^`, so its line has room
  for the pair and it offers **only `tag`** — a colour checkbox there would be a control that
  changed nothing, and `writeLine` reads `card.tagColor` off the card whenever `tag` is on. A CSV
  cell holds one value, so it spends a column each and offers both boxes. Four rules:
  - **Archidekt and CSV, and no other format.** The trailing `#tag` shape the other writers could
    borrow is stripped-and-discarded by `MARKERS`, so emitting it would be a channel this app
    writes and cannot read — and `\S+` cannot hold `Cut candidate` anyway.
  - **On by default for Archidekt, off for CSV.** Archidekt's defaults are everything the format
    can say and the caret group is something Archidekt itself emits; CSV's are a deliberate core
    with everything else opt-in. `exportPrefs` does not persist, so a default reaches every reader
    on the next launch — acceptable here where the Arena filter's was not, because this adds a
    suffix rather than dropping rows.
  - **The label goes last on the line**, after the bracket and after `*F*` — where Archidekt puts
    it, and the order `stripDecorations` peels from the end.
  - **No `DISCRIMINATOR` entry**: a label is not structural, so with `tag` on it is an ordinary
    keyed field and with it off the fold merging two labels is the fold working. Checked rather
    than assumed, in `format.test.ts`.

  **`Tag` and the collection's `Tags` are two different facts one field apart** — a `deck_tags`
  row against `collection_entries.tags`, free text on a copy the reader owns. No surface holds
  both, so the two boxes can never be drawn together and no file can carry both columns;
  `fields.test.ts` asserts that emptiness rather than leaving it to the naming. Full record:
  [import-export.md](../../../docs/reference/import-export.md).
- **`export/scope.ts` sweeps a filter into a whole list before the dialog opens on it.** The
  collection and the wishlist are paged at 100 rows for their own views, so what is in memory at
  any moment is a scroll position rather than a decision, and exporting that would silently
  truncate a large collection to whatever the reader had scrolled past. `useExportScope` pages at
  `SWEEP_PAGE = 500` and stops on a short page, never on the running total — a write landing
  mid-sweep moves it — and offers "Everything" as the alternative, which re-sweeps with the row
  filters cleared but `marketplace` kept, because which price a row is quoted at is not one of
  the things "ignoring your filters" means.
- **The chosen format and field set are remembered per surface**, `useAppStore`'s `exportPrefs`,
  keyed by `surface` rather than held as local state — a reader who always exports the collection
  as a condition-bearing CSV finds it that way again without a deck export dragging its own
  Moxfield habit onto it.
- **The cards are an argument the dialog never fetches**, and that is what made a whole-deck export
  a _caller_ rather than a rewrite: nothing in `export/` changed shape for it. `DeckEditor` derives
  them from the deck's own rows and **never from `shown`**: exporting "Removal" means the pile, not
  the four of it the toolbar's filter happens to be drawing.
- **Import is permissive; export is canonical.** `parse.ts` reads every variation a site emits —
  that is what the whole `## Import` section above is about — and each writer here emits **one**
  spelling. It is the same rule that makes the output LF with a trailing newline whatever the
  parser would tolerate: a file this app wrote should have one answer.
- **Four of the decisions inside the formats are worth carrying.** `EXPORT_FORMATS` is
  `plain · mtgo · arena · moxfield · archidekt · tcgplayer · csv`, and the dialog's radio row
  **maps that array** rather than listing them, so the count is the array's and never a number
  written down twice. **(1) `mtgo` has stopped being byte-identical to `plain`.** It was, for as long as there
  was no whole-deck export and therefore no sideboard to prefix; it writes `SB: ` on a side or
  companion card now, which is a one-line override rather than a heading — exactly how `parse.ts`
  reads it back. **(2) `arena` and `mtgo` write only switched-on piles**, because neither format
  has a maybeboard and writing one into an Arena deck produces an illegal import at the other end.
  The test is `categoryActive` and never the kind, and **the dialog says how many copies that left
  out** — `omittedCount`, in _copies_ rather than rows, because six basic lands on one row are six
  cards missing from the file — so the omission is never silent. **(3) `archidekt` writes
  `{noDeck}` and a lowercase set code.** The flag is the only thing any of these formats can say
  about a pile that counts toward nothing, which makes Archidekt the one format that writes an
  inactive pile _and_ leaves nothing out; it is the round trip that makes the flag worth writing,
  not fidelity to the site for its own sake. **(4) `tcgplayer` is a _cart_ rather than a decklist**
  (added 2026-08-18), and that decides all three of the ways it differs. Its line is
  `2 Lightning Bolt [2X2] 117` — the most specific of the three shapes TCGplayer Mass Entry
  documents, so the cart lands on the printing the deck names. It is **flat**, because Mass Entry
  reads every line as one item and a heading would be read as a card nobody sells. It writes **no
  finish marker**, because a printing's foil is chosen in the cart. And it is the one flat format
  that **keeps a switched-off pile**, where Arena and MTGO cut theirs: the pile a reader switched
  off is usually exactly what they still have to buy, so `omittedCount` is 0 here and the dialog's
  omission line never fires for it. The lowercase set code is what Archidekt itself emits
  and what its own importer round-trips, and our parser uppercases on read, so it costs the round
  trip nothing.
- **`KIND_SECTION` maps `maybe` to `Deck` and `sectionOf` asks `categoryActive`. That is "nothing
  may branch on `maybe`" held, and it is the entry most likely to be tidied into a bug.** A pile
  whose kind is `maybe` but which the reader has switched **on** counts toward the deck like any
  other, so it writes under `Deck`; a pile switched **off** is a maybeboard whatever its kind,
  because `is_active = 0` is the whole of what the word ever meant. Rewriting that entry to
  `Maybeboard` "because that is what it is called" files a switched-on Maybeboard out of the deck
  it counts toward **and** leaves a reader's own switched-off `Ramp` under `Deck` beside it — one
  edit, both errors, and nothing about it reads as wrong.
- **One format is write-only**, and `decklists.test.ts` excludes it **by name** rather than by
  omission (`expect(READABLE).toEqual([…])`), so a format dropped out of that table by accident is
  a failure rather than a quietly smaller matrix. **TCGplayer**, because its line is addressed to
  a shopping cart rather than to us: `parse.ts`'s `BRACKET` is anchored to the **end of the
  line**, so a bracket with a collector number after it is not a bracket to that parser at all and
  the whole tail lands in the card's name — `2 Lightning Bolt [2X2] 117` comes back as a card
  *called* `Lightning Bolt [2X2] 117`, the copies surviving and the name not. That is **measured
  in `format.test.ts` rather than asserted here**, so the day `parse.ts` learns to read an
  unanchored bracket the exclusion fails rather than quietly outliving its reason. **CSV was the
  second one until Task 10** — it reads now, and the `## Import` section above has the rule.
- **`decklists.test.ts` is where a writer drifting from the parser shows up.** Three real decklists
  crossed with every format, driven text → planner → writer → parser, and **every readable
  format is a fixed point**: export → import → export is byte-identical. One cycle cannot see a
  writer that is not idempotent, because there is nothing to compare the first answer against.
  Every count this branch turns on is re-derived there or in `parse.test.ts` rather than restated
  here.
- **`Export deck` in the header, `Export cards…` on a heading — one `Layer` arm with two scopes.**
  `{ kind: "export"; categoryId: number | null }`, where `null` is the whole deck; `exportSubject`
  turns that into a subject, a card list and a file name, and the deck scope passes **every** row of
  the variant on screen, switched-off piles included, because what a format does with a maybeboard
  is the _format's_ decision and `omittedCount` is what says so. It is the one layer kind two
  controls reach, which is the whole reason `layerMatches` exists: a header button reading
  `aria-expanded` off the kind alone would claim to be open while a pile's dialog was up. The names
  are the argument that produced `Import cards` run again — the category menu's row is already
  `Export cards…`, so the header's row names its **scope** instead of repeating the verb.
- **`format.ts` is `parse.ts`'s rules read backwards.** `//` is part of a card name, so nothing
  here may cut one, and what this writes has to be something that parser reads — which is what the
  round-trip test pins. LF and a trailing newline always: the parser takes CRLF, a lone LF and a
  lone CR, but a file this app wrote should have one answer. **An empty list is an empty string in
  every format, CSV included** — a header row over no rows is a file claiming to be a decklist and
  is not one — and **that now covers a list a format empties for itself**: an Arena export of a
  deck that is entirely maybeboard is `""`, not a `Deck` heading over nothing.
- **Rust writes the file, and that is a permission decision rather than a division of labour.**
  `save()` answers a _path_; writing bytes at it from the page would need an `fs:` permission this
  app grants nowhere, so `export_write_file` takes the path and the text — the same shape
  `deck_set_cover_image` has, for the same reason.
  [`src-tauri/CLAUDE.md`](../../../src-tauri/CLAUDE.md) has both.
- **The preview opens shut** (2026-08-18), which is `DeckSearchPanel`'s collapsed default one rung
  down: a decklist is the tallest thing this dialog draws and the least of what a reader came for,
  and the two presses that do the work are Copy and Save as…. Shut, the dialog is the format row,
  whatever that format leaves out, the toggle and the buttons — and the **toggle's own label
  carries the line count**, so "nothing is showing" is never mistaken for "nothing is there". The
  `<pre>` is **unmounted** rather than hidden, which is the half worth enforcing: a hidden block
  still holding the text is exactly the shape that lets a test assert a line no reader can see, so
  every play and test that reads a rendered line presses the toggle first, as a reader would.
  **It is not the fix for the reported bug it arrived with**, and the two are worth keeping apart —
  the panel itself grew past the window and took the buttons off screen with it, which is
  `Dialog`'s scrim and is fixed there for every dialog on the shell.
- **`save()` resolves `null` on Cancel**, and writing that string to disk is the trap the guard in
  `handleSaveAs` exists to prevent. A refused write is **reported and does not close the dialog**:
  the reader's text is still on screen and still copyable, so the failure costs them nothing they
  cannot immediately retry.
- **The `Copied.` line is a claim about the clipboard's contents, so it is cleared the moment that
  claim could go stale.** Switching format redraws the preview and does nothing to the clipboard,
  which still holds the last text copied — so the format radios clear it on every press. And the
  clipboard write can itself be refused, because it is a real Tauri plugin command rather than a
  browser API, so it reports through the same `role="alert"` line a refused save uses.
- **The picker's own half is unverifiable**, exactly as the importer's `open` is:
  `dialog:allow-save` opens a native window CDP cannot reach and no test or browser can drive.
  Path → written file is covered; click → path is not.
