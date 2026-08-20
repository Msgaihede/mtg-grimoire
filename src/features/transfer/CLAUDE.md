# src/features/transfer — card import and export

`import/` and `export/` — decklist parsing, planning and writing, and the two dialogs that drive
them. Moved out of `src/features/decks/` (this used to be that feature's `## Import` and
`## Export` sections, word for word) because the same machinery is meant to serve surfaces
beyond the deck editor. Deck-specific rules this module reads or reaches into — categories,
validation, formats — still live in
[`src/features/decks/CLAUDE.md`](../decks/CLAUDE.md).

## Import

`import/` is `parse.ts` (text → lines), `plan.ts` (lines + the printings Rust resolved + **their
Oracle tag slugs** → piles, a commander, tallies), `useDeckImport.ts` (the writes) and
`ImportDeckDialog.tsx` (two steps, one panel, nothing written until Import).

- **`plan.ts` stays pure and takes the slugs as an argument.** The tag read is chained inside
  `useDeckImport`'s `resolve` mutation, after `deck_import_resolve` and in the **same**
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
- **Four decorations and one heading rule, and the heading rule is the _only_ lookahead in the
  file.** The four are per-line and cost nothing: an **empty `()`** printing hint, an Archidekt
  `^Tag,#colour^`, the `[Category]` bracket, and the `*F*`/`*E*` finish markers it always had (a
  trailing `#tag` rides with those). `namesASection` is the fifth rule and it reads one line past
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
  `setCode: null` lines out of 88, and the branch that sets the flag is `deck_import.rs`'s. **Not
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
- **`plan.ts` makes every deck decision and the dialog makes none.** The pile is `autoCategoryFor`
  (the app's one rule, never copied — a plain add, a drag with no column under it and an imported
  line have to agree) and the commander is `commanderIneligibility`, the same rule the validation
  panel judges a built deck by. A looser "looks like a commander" test here would offer a card the
  panel then refuses.
- **`row.index` is the address, never the array position.** `deck_import_resolve` carries the
  caller's own index back precisely so the two can differ; reading `rows[i]` against
  `parsed.lines[i]` works today and mis-files the whole list the day anything filters between them.
- **`CardIdentity` is the card-level half of `CardFacts`, and `CardFacts` was deliberately _not_
  narrowed to it.** It exists so the importer can ask "could this be a commander?" about a card
  that is in no deck yet and therefore has no `id`, no `categoryKind` and no honest `quantity` to
  invent — but the engine really does read `categoryKind`, `categoryActive` and `quantity`, so a
  card in a deck is more than a card. Every existing caller passes a whole `DeckCard`, which
  satisfies a `Pick` of itself, so the widening changed no call site.
- **An import is not an add path and must never become one.** Routing a list through
  `useDeck.addCard` would be one transaction and one **allocator run per line**;
  `deck_import_commit` is one of each. `useDeckImport`'s fourth mutation, `importIntoNewDeck`, is
  `deck_create` then that commit with a **hand-rolled rollback** — two commands are two
  transactions, and a refused import must not leave half a deck in the gallery. The commit's
  refusal is what the caller hears, never the clean-up delete's.
- **The file picker's own half is unverified**, for the reason `deck_set_cover_image`'s is:
  `dialog:allow-open` opens a native window CDP cannot reach. Path → text → preview is tested;
  click → path is not.
- **Driven in the shipped window 2026-08-12** (`npm run tauri dev`, a **debug** build): the
  gallery path end to end put **105 of 105** reference-list lines and all **117 copies** into a
  new deck, `deck_import_resolve` cost **120.4 ms** and `deck_import_commit` **7.9 ms** through
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
  else, because **`plan.ts` makes every deck decision**;
  the dialog only reports it, in the step-two heading (`Into <pile> · <deck>`). The argument is
  **optional and defaults to today's behaviour**, so the toolbar's own Import passes nothing and is
  unchanged — which is what keeps a shared importer from being reshaped by one caller.

## Export

`export/` is the mirror of `import/`, and the split is the repo's boundary: `format.ts` is pure
(`(cards, format) => string` — no React, no hook, no IPC), `ExportDialog.tsx` is the surface (a
format picker, a live preview, Copy and Save as…), and Rust supplies only the file write. **Two
controls open that dialog** — the editor header's `Export deck` and a category heading's
`Export cards…` — and the only thing that differs between them is which cards the caller passes.

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
- **Two formats are write-only**, and `decklists.test.ts` excludes each **by name** rather than by
  omission (`expect(READABLE).toEqual([…])`), so a format dropped out of that table by accident is a
  failure rather than a quietly smaller matrix. **CSV**, because nothing in `parse.ts` reads a
  comma-separated decklist and teaching it one would be a second grammar rather than a rule inside
  the one there is. **TCGplayer**, because its line is addressed to a shopping cart rather than to
  us: `parse.ts`'s `BRACKET` is anchored to the **end of the line**, so a bracket with a collector
  number after it is not a bracket to that parser at all and the whole tail lands in the card's
  name — `2 Lightning Bolt [2X2] 117` comes back as a card *called* `Lightning Bolt [2X2] 117`, the
  copies surviving and the name not. That is **measured in `format.test.ts` rather than asserted
  here**, so the day `parse.ts` learns to read an unanchored bracket the exclusion fails rather
  than quietly outliving its reason.
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
