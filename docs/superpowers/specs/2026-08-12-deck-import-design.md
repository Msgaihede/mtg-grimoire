# Deck import — design

**Date:** 2026-08-12
**Status:** approved, ready to plan

Import a pasted or file-loaded decklist into a deck: a new one from the Decks page, or the one
already open in the editor, into whichever variant is on screen. Cards are filed into
categories automatically. Deck creation moves from the docked inline form to a modal at the
same time.

Nothing here is speculative about the codebase: `autoCategoryFor` already exists and is the
categorisation rule; four modal surfaces already exist and set the pattern this one follows;
there is no import path anywhere yet, though `spec §Import` has described one since day one.

---

## 1. Scope

**In:**

- One parser covering plain lists, Moxfield/Archidekt exports, Arena exports and MTGO text.
- Name → printing resolution against the local corpus, preferring a printing the reader owns.
- Preview-then-commit, per `spec §Import`: "nothing writes without confirmation".
- Two entry points: the Decks gallery (create-and-import) and the deck editor (import-into).
- Merge or Replace when importing into a deck that already has cards.
- Automatic categorisation: file sections win, then `autoCategoryFor`'s type buckets.
- Commander resolution: header, else an unambiguous guess, else the reader picks in the preview.
- Deck **creation** converted to a modal.

**Out, deliberately:**

- Export. This is the import half only; a round-trip test needs an exporter and there is none.
- Collection/wishlist import (CSV, Excel). Different parsers, different grain, different screen.
- Finish, condition, language or foil markers in a decklist. A deck names a printing, not a
  finish (`CLAUDE.md`, hard rules — decks), so `*F*` and `[Foil]` markers are parsed off and
  discarded rather than stored.
- Any schema change. Nothing new is persisted, so there is no migration and no renumber.

---

## 2. Architecture

The existing boundary decides the split: **Rust owns data plumbing, TypeScript owns domain
logic** — and import parsing is named in `spec §Architecture` as TypeScript's.

```
┌─ TypeScript ─────────────────────────────┐   ┌─ Rust ────────────────────────────┐
│ parse.ts    text → ParsedLine[] + issues │   │ deck_import_read_file(path)       │
│ plan.ts     matches → ImportItem[]       │──▶│ deck_import_resolve(lines)        │
│             (category, commander)        │   │ deck_import_commit(deck, items)   │
│ ImportDeckDialog  paste → preview → go   │   │   one transaction, one allocation │
│ CreateDeckDialog  name + format          │   └───────────────────────────────────┘
└──────────────────────────────────────────┘
```

Rust answers two questions and performs one write. It makes no decision about where a card
belongs, which card is the commander, or what a line means.

### New files

| Path | Purpose |
|---|---|
| `src/features/decks/import/parse.ts` | Text → `ParsedLine[]` + `ParseIssue[]`. Pure. |
| `src/features/decks/import/plan.ts` | Resolved matches → `ImportItem[]`, commander choice. Pure. |
| `src/features/decks/import/fixtures.ts` | Sample decklists, shared by tests and stories. |
| `src/features/decks/import/ImportDeckDialog.tsx` | The modal, both targets. |
| `src/features/decks/import/useDeckImport.ts` | Resolve/commit/read-file mutations. |
| `src/features/decks/CreateDeckDialog.tsx` | Replaces `DecksPage`'s inline `CreateDeckForm`. |
| `src-tauri/src/deck_import.rs` | The three commands. |

Each with its `.test.ts(x)` beside it, and `.stories.tsx` for the two dialogs.

---

## 3. The parser (`parse.ts`)

Pure text in, structure out. No IPC, no card knowledge.

```ts
interface ParsedLine {
  lineNumber: number;        // 1-based, for the preview to quote
  raw: string;
  quantity: number;          // ≥ 1
  name: string;
  setCode: string | null;    // uppercased
  collectorNumber: string | null;
  section: Section;          // where the reader put it
}
type Section = "deck" | "commander" | "sideboard" | "companion" | "maybeboard";
interface ParseIssue { lineNumber: number; raw: string; reason: string; }
```

### Line grammar

Accepted, in one regex pass per line:

- `1 Sol Ring` · `1x Sol Ring` · `4 Lightning Bolt` — a leading count, optional `x`.
- `1 Sol Ring (LTC) 285` — a parenthesised set code and an optional collector number after it.
  Collector numbers are TEXT (`★`, `123a`, `A-45`), so the token is taken verbatim.
- `SB: 2 Duress` — an MTGO sideboard prefix, a per-line override of the current section.
- A line with **no leading count** and a name that is not a header is read as quantity 1.

Ignored:

- Blank lines and whitespace-only lines.
- `//` or `#` **at the start of a line** (after trimming) — a comment.
- A trailing `*F*`, `[Foil]`, `*E*` marker, and a trailing `#tag` — stripped from the name.

### `//` is not always a comment

`1 Branchloft Pathway // Boulderloft Pathway` is one card and appears five times in the
reference list. **A comment is `//` at the start of a line; `//` inside a line is part of the
name.** This gets its own test, and the reference list below is the fixture that keeps it true.

### Section headers

A line that is only a section word — optionally followed by a parenthesised count, a colon, or
both — switches the current section for every line after it:

| Header text (case-insensitive) | Section |
|---|---|
| `deck`, `deck (99)`, `main`, `maindeck`, `mainboard`, `main deck` | `deck` |
| `commander`, `commanders`, `commander (1)` | `commander` |
| `sideboard`, `sideboard (15)`, `sb` | `sideboard` |
| `companion` | `companion` |
| `maybeboard`, `maybe`, `considering` | `maybeboard` |

The starting section is `deck`. A blank line does **not** end a section — Moxfield separates
its commander from the deck with a blank line *and* a header, and a plain list uses blank lines
decoratively.

### Failure

A line that matches no rule becomes a `ParseIssue` carrying its number, its raw text and a
reason. It is never silently dropped, and it never aborts the parse.

---

## 4. Resolution (`deck_import_resolve`)

One IPC call carrying the whole list. Read-only, on `db_read`, inside one `spawn_blocking`.

```rust
// request
struct ImportResolveRequest { lines: Vec<ResolveLine> }   // name, set_code, collector_number
// response, one entry per request line, same order
struct ImportResolveRow {
  index: usize,
  match_: Option<ImportMatch>,     // None = unmatched
  hint_missed: bool,               // a (SET) CN hint that named no printing
}
struct ImportMatch {
  card_id: String, name: String, set_code: String, collector_number: String, lang: String,
  oracle_id: Option<String>, mana_cost, cmc, type_line, oracle_text, colors, color_identity,
  legalities, power, toughness, faces, ever_uncommon, game_changer, price_usd, rarity,
  owned_quantity: i64,             // copies in the collection, any finish
  printing_count: i64,             // how many paper printings share this name
}
```

The card-fact columns are exactly those `deck.rs`'s `DECK_CARD_SELECT` already pulls, so the
validation modules can read an `ImportMatch` unchanged (see §5).

### Matching, per line, in order

1. **An explicit hint wins.** `set_code` + `collector_number` → that printing, matched
   case-insensitively. `set_code` alone → the named card's printing in that set.
   **A hint that names no printing does not fail the line**: resolution falls through to step 2
   and the row comes back with `hint_missed: true`, which the preview reports.
2. **Exact name**, case-insensitive, against `cards.name` **or** the front face — the substring
   before ` // `. A list naming only `Kolvori, God of Kinship` and one naming
   `Kolvori, God of Kinship // The Ringhart Crest` both resolve to the same card.
3. **Normalised name** over FTS-narrowed candidates: lowercase, strip diacritics, unify the
   apostrophe variants (`'` `'` `` ` ``), collapse whitespace. `cards_fts` narrows the candidate
   set first so this never scans the corpus.

Every step is filtered to `is_paper = 1`. A digital-only printing is never imported.

### Which printing

Among the printings that survive the match:

1. **One the reader owns** — the highest `owned_quantity`, ties broken by newest `released_at`,
   then `id`. This is the feature's own purpose: populating a deck from cards already owned, so
   the allocator claims a copy on the first commit rather than showing a shortage on a card
   sitting in the binder in a different set.
2. Else the **newest paper printing** — `released_at DESC, id DESC`, the browse's own rule
   (`ORDER_NAME`'s trailing term), so an import and a search agree about which printing a name
   means.

Deterministic in both arms — the tie-break runs to `id`, which is unique.

### Cost

~100 names, one prepared statement reused, an in-process SQLite read. Expected well under the
100 ms a preview can absorb; the implementation measures it and records the figure.

---

## 5. `CardFacts` narrowing

`src/features/decks/validation/types.ts` today reads `export type CardFacts = DeckCard`, so
`commanderIneligibility` can only be asked about a card that is already a row in a deck. The
preview has to ask it about a card that is not in the deck yet.

`CardFacts` becomes a `Pick<DeckCard, …>` of the fields the validation modules actually read —
`cardId`, `name`, `quantity`, `typeLine`, `oracleText`, `power`, `toughness`, `colorIdentity`,
`legalities`, `faces`, `everUncommon`, and whatever else the sweep finds. Every existing full
`DeckCard` still satisfies it, so no call site changes; the type-check is the proof, and
`npm run verify` is where it lands. The implementation derives the field list by reading the
five validation modules, not from this list — this list is a description, not a specification.

**If the sweep finds that the validation modules genuinely read deck-row fields beyond
`quantity`** (a `categoryKind`, a `tagId`), the narrowing is abandoned and the importer builds
a full `DeckCard` with placeholder deck fields instead. That is the fallback, and it is a
local ugliness rather than a wrong type.

---

## 6. Categorisation and the commander (`plan.ts`)

Pure: parsed lines + resolved matches + the deck's format spec → `ImportItem[]`.

```ts
interface ImportItem { cardId: string; quantity: number; categoryName: string; }
```

### Where a card lands

1. **A file section other than `deck` names its category directly** — `Commander`,
   `Sideboard`, `Companion`, `Maybeboard`. These are `schema::PREDEFINED_CATEGORIES`, seeded
   per deck, and find-or-create matches on `(deck_id, name)` — so the card lands on the
   predefined row with the right `kind` and nothing new is created.
2. **Everything else goes through `autoCategoryFor`** — Land, Creature, Artifact, Enchantment,
   Planeswalker, Battle, Instant, Sorcery, and `Uncategorised` for a card whose type line is
   missing. These are created on demand as `kind = 'main'` categories, which is what
   `category_for_name` does and what the reader wants: a plain list becomes a deck split by
   type.

A card filed into **Maybeboard** lands in an **inactive** category and counts toward nothing —
not size, not copy limits, not legality, not allocation. That is correct and is what the header
asked for; the preview's category breakdown marks it *(inactive)* so it is not a surprise.

### The commander

In order:

1. **A `commander` section in the file wins.** Every card under it is filed there, however many.
2. **No section, and the deck's format has a commander rule**: gather every resolved card that
   `commanderIneligibility` passes. If **exactly one** is eligible, file it in Commander and say
   so in the preview ("Captain Sisay will be your commander").
3. **Otherwise the preview asks.** The eligible cards are listed with their art; the reader
   picks one, picks two (partners — the eligibility module already knows about them), or picks
   none and presses Import anyway. The validation panel then says the deck has no commander,
   which is a true statement about a deck that has none.

If the format has no commander rule, none of this runs and step 1's section is honoured as a
plain category anyway.

**Never guessed from position.** "The first line is the commander" and "the last line is the
commander" are both conventions and both wrong about half the lists in the wild.

---

## 7. The commit (`deck_import_commit`)

```rust
fn deck_import_commit(deck_id: i64, variant: &str, mode: ImportMode, items: Vec<ImportItem>)
    -> Result<ImportOutcome, String>
enum ImportMode { Merge, Replace }
struct ImportOutcome { added: i64, removed: i64, categories_created: i64 }
```

One transaction on the write connection through `db::lock_for(…, WRITE_LOCK_WAIT)`, answering
`collection::BUSY` if it cannot take it. Inside it, in order:

1. Fence the variant against `schema::DECK_VARIANTS` and the deck against existence — the two
   fences every deck write opens with.
2. **Replace only:** `DELETE FROM deck_cards WHERE deck_id = ?1 AND variant = ?2`, counting the
   rows. Categories are left alone: a category is the reader's, not the list's.
3. Find-or-create each distinct category name (`deck_meta::category_for_name`), counting the
   creations.
4. Insert each item with `ON CONFLICT (deck_id, variant, category_id, card_id) DO UPDATE SET
   quantity = quantity + excluded.quantity` — the same fold `deck_add_card` uses. Two
   consequences, both wanted: importing the same list twice in Merge mode doubles the
   quantities rather than erroring, and **a list naming the same card on two lines folds into
   one row with the sum** without `plan.ts` having to deduplicate first.
5. **One `allocate_deck`**, at the end. This is the whole reason the command exists: looping
   `deck_add_card` from TypeScript would run the allocator once per line — 100 rebuilds of the
   deck's claims for one import.
6. History (§8).

`deck_import_read_file(path) -> String` is the third command: opens the path Rust-side, refuses
anything over **1 MiB** with a sentence, and reads UTF-8 lossily so a Windows-1252 apostrophe
becomes a replacement character in one name rather than failing the whole file. It takes a
**path, not bytes** — the same contract `deck_set_cover_image` uses, which is why
`dialog:allow-open` alone is sufficient and no `fs:` permission is added.

---

## 8. History

`deck_audit` records facts; `auditText.ts` writes the sentence. An import writes:

- one `add` row — `card_id`/`card_name` NULL, `delta` = cards added, payload
  `{ "import": { "mode": "merge"|"replace", "lines": N, "cards": M, "categories": K } }`;
- **and, in Replace mode only, one `remove` row** — `delta` = −(cards cleared), payload
  `{ "import": { "mode": "replace", "cleared": N } }`.

No new `AUDIT_KINDS` value, so no CHECK-constraint rebuild and no migration. One row per
*effect the command had*, which is the same shape `deck_update` already uses (one row per
changed field). `every_deck_write_leaves_exactly_one_audit_row` gains two cases — a Merge
import asserting one row, a Replace import asserting two — and the count named in its doc
comment is re-counted in the same commit rather than remembered.

`auditText.ts` gains the two sentences: "Imported 117 cards into Live" and "Replaced Live with
117 imported cards — 42 removed".

**Not per-card rows.** An import of 117 cards would put 117 rows in the drawer and bury every
other event of that day. The payload carries the counts; the deck itself carries the cards.

---

## 9. The modals

### `CreateDeckDialog`

Replaces `DecksPage`'s docked `CreateDeckForm`. Same two fields — name and format — same
mutation, same refusal reporting, new presentation. It follows the pattern the editor's four
overlays already set, and the implementation reads `TheoryDiffDialog` rather than reinventing
it:

- a scrim at `LAYER.overlay` (`fixed inset-0`, `bg-bg/70`);
- `role="dialog"`, `aria-modal="true"`, `aria-labelledby` on its heading;
- `onKeyDown={trapTab}` on the panel, which is what makes `aria-modal` true rather than claimed;
- `useDismissOnEscape({ layer: "inner", onDismiss })`;
- focus into the name field on open, handed back to the trigger on close.

It keeps `DecksPage`'s existing `panel` state (`{ kind: "createDeck" }`), so "never two open"
stays structural rather than remembered.

**No new layer rung.** `LAYER.overlay` is one rung for every full-window surface deliberately
(`CLAUDE.md`), and at most one of these is ever mounted.

### `ImportDeckDialog`

One component, one discriminated target prop:

```ts
type ImportTarget =
  | { kind: "new" }                                       // from the Decks gallery
  | { kind: "deck"; deckId: number; variant: DeckVariant } // from the editor
```

**Step 1 — Source.** A large textarea, a **Choose file…** button (`dialog:allow-open` with a
`.txt`/`.dek`/`.csv` filter, then `deck_import_read_file`), and — for `kind: "new"` — the name
and format fields. **Next** is disabled until the box is non-empty.

**Step 2 — Preview.** Nothing has been written. It shows:

- the headline: *N cards across K categories*;
- the category breakdown, each with its count, inactive ones marked;
- **unmatched lines**, quoted with their line numbers — the failure the reader can act on;
- **printing-hint misses**, quoted with what was used instead;
- the **commander** row: the automatic choice, or the picker (§6.3);
- for `kind: "deck"`, the **Merge / Replace** radio, Merge selected, with Replace naming what
  it will clear ("Replace — removes the 42 cards in Live first").

**Step 3 — Import.** One press. For `kind: "new"` it creates the deck first, then commits; if
the commit fails the deck it just made is deleted, so a failed import leaves no half-deck. On
success the dialog closes and the editor opens on the new deck; from the editor it closes and
the deck re-reads.

**Entry points:** an **Import deck** button beside *New deck* in the gallery heading, and an
**Import** item in the deck editor's toolbar which targets the variant currently on screen.

---

## 10. Errors

| Case | Behaviour |
|---|---|
| A line the parser cannot read | Quoted in the preview by line number. Import proceeds without it. |
| A name that matches no card | Quoted in the preview. Import proceeds without it. |
| Every line unmatched | The preview says so and **Import is disabled** — there is nothing to write. |
| A `(SET) CN` hint that names nothing | Falls back to the name match; the preview says which printing was used. |
| The corpus is empty (first run, mid-sync) | Everything is unmatched; the preview says the card data is still syncing rather than "no such card". |
| `deck_import_commit` refused (`BUSY`) | The dialog stays open with the sentence, nothing written, the reader presses again. |
| The commit throws in `kind: "new"` | The just-created deck is deleted; the reader sees the refusal and their pasted text. |
| A file over 1 MiB, or unreadable | The sentence from Rust, shown beside the Choose file button. The textarea keeps whatever was in it. |

Every one of these is a sentence in the dialog, never a toast and never a console line.

---

## 11. Testing

**Vitest (the domain core):**

- `parse.test.ts` — the reference list below **verbatim** as a fixture (**105 lines, 117 cards,
  seven `//` split names**, `6 Forest`, `8 Plains` — counted, not remembered); Moxfield,
  Archidekt, Arena and MTGO samples; `SB:`;
  every header spelling; comments; a foil marker; garbage lines; CRLF; a UTF-8 BOM.
- `plan.test.ts` — section → category; type → category; `Uncategorised`; the Maybeboard's
  inactivity; the commander's three paths (header, unambiguous, ambiguous → asks); partners.
- `useDeckImport.test.ts` — the create-then-commit rollback.
- `ImportDeckDialog.test.tsx`, `CreateDeckDialog.test.tsx` — the steps, the disabled states,
  Escape, focus return, `trapTab`.
- `App.test.tsx`'s Escape-stack test gains the new modals.

**Rust:**

- Resolution: an owned printing beats a newer unowned one; a front-face-only name matches; a
  hint wins; a missed hint falls through and flags; a digital-only printing is never returned;
  a diacritic name matches; determinism (the same list twice gives the same ids).
- Commit: Merge folds on the grain; Replace clears only the named variant and leaves the other
  alone; categories are found-or-created; **the allocator runs exactly once**; a rolled-back
  commit leaves no history; the audit rows are one (Merge) and two (Replace).
- `deck_import_read_file`: over-size refusal, missing file, lossy UTF-8.

**Storybook:** both dialogs, with the fake world gaining `deckImportResolve`,
`deckImportCommit` and `deckImportReadFile`; stories for the empty box, a clean preview, a
preview with unmatched lines, the ambiguous-commander picker, and a refused commit. Story
counts in `CLAUDE.md` are re-counted in the same commit.

**Live, over CDP in the shipped window** — because Storybook runs in a browser and the test
suite runs in jsdom, and neither ships. Paste the reference list, walk the preview, import,
and read the deck back: the category split, the commander, the audit drawer's sentence, and
the allocator's shortage marks against a seeded collection.

---

## 12. The reference list

The list this design was written against, supplied by the user: a green-white Commander list
with **no section headers**, seven `//` split names and two basics with counts above 1. It goes
into `src/features/decks/import/fixtures.ts` **verbatim** — not retyped, not tidied — and is the
parser's primary test.

**Counted, not remembered: 105 lines · 117 cards · 7 `//` names.** (117 rather than 100 because
the list is what the user pasted, not a legal deck. The parser has no opinion about deck size;
the validation panel does, afterwards, and that is the right division.) The implementation
re-counts these three numbers off the fixture in the same commit that adds it.

```
1 Aerith Gainsborough
1 Aerith, Last Ancient
1 Akroma's Will
1 Animist's Might
1 Arcane Signet
1 Arwen, Weaver of Hope
1 Ashaya, Soul of the Wild
1 Avacyn, Angel of Hope
1 Boromir, Warden of the Tower
1 Boseiju, Who Endures
1 Bountiful Promenade
1 Branchloft Pathway // Boulderloft Pathway
1 Bridgeworks Battle // Tanglespan Bridgeworks
1 Brigid, Clachan's Heart // Brigid, Doun's Mind
1 Brushland
1 Bugenhagen, Wise Elder
1 Canopy Vista
1 Captain Sisay
1 Celestine, the Living Saint
1 Clive's Hideaway
1 Command Beacon
1 Command Tower
1 Dawn's Truce
1 Day of Destiny
1 Delighted Halfling
1 Dragonlord Dromoka
1 Eiganjo, Seat of the Empire
1 Eladamri's Call
1 Elena, Turk Recruit
1 Elesh Norn, Grand Cenobite
1 Elesh Norn, Mother of Machines
1 Fabled Passage
1 Flowering of the White Tree
6 Forest
1 Gandalf the White
1 Garruk's Uprising
1 Ghalta, Primal Hunger
1 Ghalta, Stampede Tyrant
1 Goreclaw, Terror of Qal Sisma
1 Great Hall of the Citadel
1 Gwenna, Eyes of Gaea
1 Heroes' Podium
1 Heroic Intervention
1 Hushwood Verge
1 Kamahl's Druidic Vow
1 Karametra, God of Harvests
1 Kogla, the Titan Ape
1 Kolvori, God of Kinship // The Ringhart Crest
1 Kutzil, Malamet Exemplar
1 Loran of the Third Path
1 Lush Portico
1 Mangara, the Diplomat
1 Master's Guidance
1 Minas Tirith
1 Mona Lisa, Science Geek
1 Monumental Henge
1 Mox Amber
1 Nylea, Keen-Eyed
1 Odric, Lunarch Marshal
1 Ojer Kaslem, Deepest Growth // Temple of Cultivation
1 Old Gnawbone
1 Overgrown Farmland
1 Path to Exile
1 Phelia, Exuberant Shepherd
8 Plains
1 Plaza of Heroes
1 Radagast of Rhosgobel
1 Reki, the History of Kamigawa
1 Relic of Legends
1 Saryth, the Viper's Fang
1 Selvala, Eager Trailblazer
1 Selvala, Heart of the Wilds
1 Serah Farron // Crystallized Serah
1 Shalai, Voice of Plenty
1 Sigarda, Font of Blessings
1 Sigarda, Host of Herons
1 Skrelv, Defector Mite
1 Sol Ring
1 Sovereign Okinec Ahau
1 Stroke of Midnight
1 Sungrass Prairie
1 Sunpetal Grove
1 Surrak and Goreclaw
1 Sutina, Speaker of the Tajuru
1 Swords to Plowshares
1 Tataru Taru
1 Temple Garden
1 Thalia, Heretic Cathar
1 The Earth King
1 The Great Henge
1 The Grey Havens
1 The Seriema
1 The Wandering Rescuer
1 Torgal, A Fine Hound
1 Toski, Bearer of Secrets
1 Urza's Ruinous Blast
1 Venat, Heart of Hydaelyn // Hydaelyn, the Mothercrystal
1 Wakka, Devoted Guardian
1 War of the Last Alliance
1 Windswept Heath
1 Wooded Bastion
1 Yasharn, Implacable Earth
1 Yavimaya, Cradle of Growth
1 Yeva, Nature's Herald
1 Yoshimaru, Ever Faithful
```

Expected of the parser: **105 parsed lines, 117 cards, 0 parse issues**, every `//` name kept
whole. Expected of the plan against a synced corpus: dozens of commander-eligible cards, so the
preview **asks** rather than guessing — which is exactly the case §6.3 exists for, and the
reason this list is the fixture.

---

## 13. What this does not solve

- **Growing the collection still does not re-run the allocator** (`CLAUDE.md`, hard rules —
  decks). An import runs it once at the end, so an imported deck reads its shortages correctly
  the moment it opens; buying a card afterwards still needs a deck write before the deck sees
  it. Unchanged by this work, and Plan 6's to close.
- **No export**, so there is no round-trip test. The parser is tested against samples produced
  by the tools people actually use, which is the honest substitute.
- **The file picker's own half stays unverified** — `dialog:allow-open` opens a native window
  CDP cannot reach, exactly as `deck_set_cover_image`'s picker does. The path → text → preview
  half is measured; the click → path half is not, and that is recorded rather than claimed.
