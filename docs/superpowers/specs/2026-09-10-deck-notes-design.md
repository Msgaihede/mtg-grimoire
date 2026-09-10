# Deck notes: many notes, each naming any number of cards

Issue [#447](https://github.com/Msgaihede/mtg-grimoire/issues/447). Reported through Discord by
**Supreme** on the Luminia server.

> Replace the deck "notes" field with support for multiple notes that can be added after deck
> creation and managed or deleted independently. A note may refer to a specific card, but the card
> should only serve as a reference. Notes should always appear in the notes list, even when they
> are attached to a card. A note may have any number of attached cards, since it may refer to
> multiple cards.

Everything measured here was measured on Windows. Bundle figures are from a **release** `vite build`
in this worktree on 2026-09-10; every other figure names its own build.

---

## 1. What is already true

`decks.notes` is a `TEXT` column added at user schema **v8**, and it is narrower than a repository
grep suggests: nearly every `notes` in this tree is `collection_entries.notes`,
`wishlist_entries.notes` or a GitHub release note. The deck's own notebook reaches exactly five
subsystems.

| Layer | Carries deck notes? | Sites |
| --- | --- | --- |
| Storage — `deck.rs`, `schema.rs` | **yes** | `DeckInput`/`DeckPatch`/`DeckRow`, `DECK_SELECT`, the create `INSERT`, `update_deck`'s `coalesce`, the before-image, `duplicate_deck` |
| Audit — `deck_audit.rs` | **yes** | `deck.field == "notes"`, carrying `from` and `to` verbatim |
| Undo — `deck_undo.rs` | **yes** | on `DECK_FIELDS`; the only path that can write the column back to `NULL` |
| Sync — `capture.rs` | **yes** | one entry on the `decks` `Spec.fields` list |
| UI | **one textarea** | `DeckSettingsForm.tsx:486-496`, drawn by both the create dialog and Deck settings |
| Mirror — `mirror/` | **no** | `mirror::read` loads `DeckDetail` and maps only `detail.cards` |
| Transfer — all seven formats, Rust **and** TS | **no** | `FieldId::Notes` is the collection/wishlist field; `Surface::Deck`'s list omits it |
| Golden fixtures | **no** | zero matches for `note` across all 70 `deck.*.txt`; absent from `fields.json`'s `deck` block |
| Share | **no** | a share publishes a collection, never a deck |

**So the blast radius of removing the column is storage, audit, undo, sync, one form and the
Storybook fake — and nothing else.** No golden file moves, no export format grows or loses a
column, and the text mirror renders identical bytes before and after. That is the single most
useful fact in this document, because it is what makes a replacement affordable.

Two properties of the old column are worth stating before they are deleted, because both shaped
what replaces it:

- **`update_deck` writes `notes = coalesce(?8, notes)`**, so no patch has ever been able to empty
  the column; only `deck_undo::apply`, which writes the raw value, can. A multi-note model needs a
  real delete, so there is no precedent here to copy and the new commands own that path
  themselves.
- **`auditText.ts` prints `Edited the deck notes` and never the paragraph** — "a note is a
  paragraph nobody wants in a one-line history". That rule survives this change unchanged, and its
  `case "notes"` **must stay in the file for good**: audit rows are durable, and every history row
  written before v43 still says `notes`. Deleting the arm would silently demote years of history to
  the default `Changed the deck`.

---

## 2. The model

**A note belongs to a deck. A card reference is a pointer the note holds, never a place the note
lives.** That is the issue's central sentence — *"the card should only serve as a reference"* — and
it decides the schema: attachments hang off the note, so the notes list is the complete list by
construction and a note cannot become invisible by acquiring a card.

**A note attaches by `oracle_id`, not by `card_id`.** `deck_tokens`' argument applies verbatim: a
printing id means nothing on the far device's shelf, while an oracle id is Scryfall's and is the
same everywhere. Three things follow, and each is a feature rather than a consequence:

- a note survives the reader swapping to a different printing of the same card;
- a note written against the Theory list shows on the Live list and the other way round, because
  both hold the same oracle id;
- one note naming Lightning Bolt names it once, however many copies or finishes the deck holds.

**A note has a title and a body.** The title is what the band's list, the card menu's submenu and
the card modal's row can print in one line; the body is the rich text. A blank title is legal and
reads as the body's first line, computed at render and never stored — a stored derivation would go
stale the moment the body was edited, and there is no writer that could notice.

**A note carries no card-level anchor inside the body.** There is no "this paragraph is about that
card" — an attachment is a fact about the whole note. That is what the issue asks for and it is
also the only shape whose plain-text rendering stays honest.

---

## 3. Storage — user schema v43

### The two tables

```sql
CREATE TABLE deck_notes (
    id INTEGER PRIMARY KEY,
    deck_id INTEGER NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
    -- May be empty. The list prints the body's first line when it is, computed at render.
    title TEXT NOT NULL DEFAULT '',
    -- CommonMark, in the dialect §6 pins. Never HTML, never ProseMirror JSON.
    body TEXT NOT NULL DEFAULT '',
    sort_order INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
 , sync_uid TEXT);

CREATE TABLE deck_note_cards (
    id INTEGER PRIMARY KEY,
    note_id INTEGER NOT NULL REFERENCES deck_notes(id) ON DELETE CASCADE,
    -- The card's identity across every printing of it. Soft, like every other card reference
    -- in a user table: no enforced foreign key has ever pointed at `cards.id`.
    oracle_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
 , sync_uid TEXT);

CREATE UNIQUE INDEX idx_deck_note_cards_grain ON deck_note_cards (note_id, oracle_id);
CREATE UNIQUE INDEX idx_deck_notes_uid ON deck_notes (sync_uid);
CREATE UNIQUE INDEX idx_deck_note_cards_uid ON deck_note_cards (sync_uid);
```

**`deck_notes` gets no grain and is uid-only**, joining `decks`, the three folder tables and
`deck_audit`. Two devices each typing a note about the mana base must stay two notes; there is no
column pair that could tell an accidental duplicate from a deliberate one, and inventing one — a
title grain, say — would silently fold two readers' separate thoughts into whichever arrived
second.

**`deck_note_cards` needs its grain for the opposite reason.** Two devices attaching Lightning Bolt
to the same note describe *one* fact. Without `idx_deck_note_cards_grain` the far op is an insert
that hits nothing, both rows land, and the card modal reads "2 notes" for one note. With it, the
applier resolves on `(note_uid, oracle_id)`, takes `min(uid)`, and the two converge with no alias
table — the rule [sync.md](../../reference/sync.md) states and `idx_deck_tokens_grain`
already relies on.

### The deck's own columns

```sql
ALTER TABLE decks DROP COLUMN notes;
ALTER TABLE decks ADD COLUMN notes_open INTEGER NOT NULL DEFAULT 0;
```

**`DEFAULT 0` and not `1`, which is v37's answer rather than v42's.** The two rungs asked the same
question and answered it opposite ways, and which one applies turns on whether the upgrade changes
what is on screen. v42 gave `stats_open` a `DEFAULT 1` because the stats band was already on screen
for every deck on every disk and a `0` would have closed a band the reader had been reading for
months. The Notes band is *new*: no deck has ever shown one, so a collapsed default takes nothing
from anybody, and `decks.tokens_open` is the precedent character for character.

### ⚠️ The rung must drop three triggers before it drops the column

`sync_upd_decks` is `AFTER UPDATE OF <watched columns>` and its `OF` list **names `notes`**. Capture
triggers are persistent objects — `capture::install` writes real `CREATE TRIGGER`s, not temp ones —
so on an upgraded file they are already in the schema when the rung runs, and SQLite refuses
`DROP COLUMN` on a column a trigger references. The fix is v33's, verbatim: drop the three `decks`
triggers inside the rung and let `prepare_database` reinstall them, which it does on the very next
line for every target.

```rust
if v < 43 {
    let tx = conn.unchecked_transaction()?;
    tx.execute_batch(
        "-- Off before the drop: `sync_upd_decks` names `notes` in its `OF` list, and SQLite
         -- refuses DROP COLUMN on a column a trigger references. `capture::install` puts the
         -- current set back, right after this function. v33's move.
         DROP TRIGGER IF EXISTS sync_ins_decks;
         DROP TRIGGER IF EXISTS sync_upd_decks;
         DROP TRIGGER IF EXISTS sync_del_decks;

         CREATE TABLE deck_notes ( ... );
         CREATE TABLE deck_note_cards ( ... );
         CREATE UNIQUE INDEX idx_deck_note_cards_grain ON deck_note_cards (note_id, oracle_id);
         CREATE UNIQUE INDEX idx_deck_notes_uid ON deck_notes (sync_uid);
         CREATE UNIQUE INDEX idx_deck_note_cards_uid ON deck_note_cards (sync_uid);

         ALTER TABLE decks DROP COLUMN notes;
         ALTER TABLE decks ADD COLUMN notes_open INTEGER NOT NULL DEFAULT 0;",
    )?;
    tx.execute_batch("PRAGMA main.user_version = 43;")?;
    tx.commit()?;
}
```

### ⚠️ `DECK_SELECT` maps by position

`decks.notes` is column 12 in the whole-deck read and `deck.rs:1072` is `notes: r.get(12)?`. Every
`r.get(n)` after it shifts down by one when the column goes — fourteen of them in `deck_row` and
nine in the before-image mapper, plus `update_deck`'s `?9`–`?20` and `cover_kind`'s `ELSE ?10`.

**⚠️ `IMAGE_COL` nevertheless stays at 27, and this section said 26 until the build corrected it
on 2026-09-10.** Removing `notes` at column 12 drops it to 26, and appending `notes_open` puts it
straight back — the two edits cancel at the *end* of the row and nowhere in the middle of it. So
the one constant a reader would check to decide whether the read had moved is the one number that
did not move, while every read between 12 and 26 did. That is the trap, and it is written into
`IMAGE_COL`'s own doc comment now rather than only here.

### The text already in the column is discarded

**Decided 2026-09-10.** No migration copies `decks.notes` into a first `deck_notes` row. The
alternative was written and refused: a copy would put a paragraph nobody asked to keep into a list
whose whole point is that its rows are deliberate, and the column has never been shown anywhere but
one textarea in a dialog most readers never open. What that costs is stated rather than hidden — a
reader who used the old field loses it, with no undo, at the upgrade.

---

## 4. What the two new synced tables owe

**Ten registration sites, and nothing at any of them points at the tenth.**

| # | Site | What goes there |
| --- | --- | --- |
| 0 | `schema::USER_SCHEMA_VERSION` | 42 → **43** |
| 1 | the `v < 43` rung | above |
| 2 | `schema::USER_SCHEMA_SQL` | the same `CREATE TABLE`s and indexes at head shape, byte-identical to what the ladder builds — `the_user_schema_is_byte_identical_to_what_the_ladder_builds` compares them |
| 3 | `UNDO_V43` + every chain literal + `user_file_at_42()` | `DROP INDEX`×3, `DROP TABLE`×2, `ALTER TABLE decks DROP COLUMN notes_open`, **and re-adding `notes TEXT`** — a rewind must land on v42's shape, not merely near it |
| 4 | `schema::TABLES` | two `Side::User` entries, plus both names in `the_user_side_is_the_twenty_five_tables_no_feed_can_rebuild`'s spelled-out list (25 → 27) |
| 5 | `schema::SYNCED_TABLES` | 13 → **15**, sorted |
| 6 | grain constants | `DECK_NOTE_CARD_GRAIN = "note_id, oracle_id"`, added to `every_plain_grain_constant_names_the_index_the_head_schema_carries` |
| 7 | `mirror::watch::surface_of` | both tables → `DECKS_ONLY`, and both spelled-out lists in `every_table_in_the_schema_has_been_decided_about` |
| 8 | `capture::TABLES` | two `Spec`s; `[Spec; 15]` |
| 9 | `apply::META` | two `Meta`s at `order: 13` and `14`; `[Meta; 15]` |
| 10 | `apply/tests.rs` | `idx_deck_note_cards_grain` added to `every_unique_index_on_a_synced_table_has_been_decided_about` |

And one **removal**: `"notes"` comes off the `decks` `capture::Spec.fields` list.

### Dropping a synced column is safe on the wire, and this was read rather than assumed

A device on v42 goes on emitting `decks` ops carrying a `notes` field. A v43 device applying one
walks `apply::updates()`, which iterates **the local spec's** field list and looks each name up in
the incoming op:

```rust
for f in spec.fields {
    let (Some((v, incoming)), Some((_, winner))) =
        (g.resolved.fields.get(*f), combined.fields.get(*f))
    else { continue };
```

A field the op carries and the local spec does not is never visited. It is not an error, it does
not fail the row, and it does not roll the group's savepoint back — so it cannot stall that peer's
stream the way an unknown *table* does. `insert_row` iterates the same list. **The mixed-version
group therefore keeps syncing decks normally in both directions**, which is what made discarding
the column affordable; the v42 device simply keeps a dead paragraph nothing will ever clear.

The reverse case is the ordinary sparse one: a v43 device's op names no `notes`, the v42 device's
lookup returns `None`, and the arm `continue`s.

### The `capture::Spec`s

```rust
Spec {
    table: "deck_notes",
    keys: &["id"],
    fields: &["title", "body", "sort_order"],
    counters: &[],
    parents: &[Parent { key: "deck", col: "deck_id", table: "decks",
                        absent: Absent::Null, soft: false }],
    append_only: false,
},
Spec {
    table: "deck_note_cards",
    keys: &["id"],
    // `oracle_id` is on the field list although it is half the grain — `deck_tokens`',
    // `muted_tags`' and `device_names`' reason: the far device has to be able to *build* the
    // row, and the grain `apply::META` restates is a way of recognising one already there.
    fields: &["oracle_id"],
    counters: &[],
    parents: &[Parent { key: "note", col: "note_id", table: "deck_notes",
                        absent: Absent::Null, soft: false }],
    append_only: false,
},
```

`deck_note_cards`' parent is `deck_notes` and **not** `decks`: the row hangs off the note, so
`order: 14` must sort after `deck_notes`' `13`, which sorts after `decks`' `1`. Neither table takes
`needs_review` — no reconciler walks them, and an oracle id is not a printing that can go missing.

---

## 5. The boundary

### Rust supplies facts

A new module, `src-tauri/src/deck_notes.rs`, in `deck_meta.rs`'s idiom: core functions take a
`Connection` and return a DTO, the `#[tauri::command]` wrappers sit at the bottom behind
`#[cfg(not(target_family = "wasm"))]`, and the module body names no `tauri::`.

| Command | Answers |
| --- | --- |
| `deck_notes(deckId)` | `Vec<DeckNoteRow>` — every note on the deck in `sort_order`, each with its attached oracle ids and their names |
| `deck_note_create(deckId, title, body, oracleIds)` | the new `DeckNoteRow` |
| `deck_note_update(deckId, id, title?, body?)` | the updated row |
| `deck_note_delete(deckId, id)` | `()` |
| `deck_note_attach(deckId, noteId, oracleId)` | the updated row |
| `deck_note_detach(deckId, noteId, oracleId)` | the updated row |
| `deck_note_reorder(deckId, ids)` | `()` |
| `card_notes(oracleId)` | `Vec<CardNoteRow>` — every note in **every** deck naming this card, with the deck's id and name |

`card_notes` is the one read that is not deck-scoped, and it is what the card modal's row asks. A
card opened from the collection, from search or from another deck still answers "what have I
written about this card", which is the question the modal exists to answer completely.

**No command answers "which cards in this deck have notes".** The band already holds every note and
every note holds its oracle ids, so the marks are a `Set` built in TypeScript from the read the page
has made. A second command would be a second source of truth for a fact already in hand — the rule
`Empty a list` follows for its two counts.

### TypeScript draws conclusions

`src/features/decks/deckNotes.ts` owns the derivations, and none of them is a fact:

- `notedOracleIds(notes)` → the `Set` the marks read;
- `noteTitle(note)` → the stored title, or the body's first line, or `Untitled note`;
- `notesForCard(notes, oracleId)` → the card menu's submenu and the modal's list;
- `parseNoteBody(body)` → the block AST §6 describes.

### Audit

Notes ride the existing `deck` kind. `AUDIT_KINDS` stays at nine — the vocabulary is inside a
`CHECK` and SQLite has no `ALTER … CHECK`, so a tenth word costs a full `deck_audit` rebuild, which
would in turn fire `deck_undo`'s `ON DELETE CASCADE` and silently empty the undo stack on every real
launch while leaving it intact in every test. v33 paid that price for a rename that had no
alternative; a note does not need to.

The payload is `deck`'s `{field, from, to}` with `field: "note"`, plus an `action` and the note's
title, and `auditText.ts` grows one arm printing `Added a note`, `Edited a note`, `Deleted a note`,
`Attached <card> to a note` and `Detached <card> from a note`. The title is **not** printed for
edits, for the reason the old `Edited the deck notes` gave.

### Undo — a fifth `Op`

**Decided 2026-09-10.** `deck_undo::Op` grows `Notes`, mirroring `Labels` field for field:

```rust
/// The same three lists over `deck_notes`, plus which cards each note named.
Notes {
    #[serde(default)] restore: Vec<NoteRow>,
    #[serde(default)] patch: Vec<NoteRow>,
    #[serde(default)] delete: Vec<i64>,
    #[serde(default)] attachments: Vec<NoteCard>,
},
```

`restore` and `patch` are two lists for `Categories`' reason and it applies with full force here:
`deck_notes.id` is a rowid alias, so deleting the highest-numbered note and writing a new one reuses
the number, and a single list deciding by "is there a row at this id" would overwrite the reader's
newest note with the one they deleted — the failure
`a_restored_category_keeps_its_cards_even_when_its_id_was_reused` already caught one table over.

`attachments` restores the whole `deck_note_cards` set for the notes in the step, not a diff: the
rows cascade away with the note, so an undo has to rebuild them, and a set is what
`Labels`' `carriers` already is.

**No `#[serde(alias)]` is owed.** The aliases on `Op::Labels` exist because v33 *renamed* something
that steps already on disk had written down. `Notes` has never had another spelling.

---

## 6. The editor, and why there are two renderers

**The body is CommonMark.** It stays readable in SQLite, in a `from`/`to` audit payload and in any
future export with no renderer in Rust — which matters in this repository more than in most,
because a Rust-side renderer would be a second implementation of a TypeScript one and
`src/features/transfer/__golden__` is the fence that exists to make exactly that kind of pair go red.

**Editing is Tiptap 3, loaded lazily.** Measured with `esbuild --bundle --minify`, React external,
`gzip -9`:

| Bundle | gzip |
| --- | --- |
| the app today, `dist/assets/index-*.js` | **481.45 kB** (1,541.78 kB raw) |
| `@tiptap/react` + `@tiptap/starter-kit` + `@tiptap/markdown` | **141.5 kB** (461.85 kB raw) |
| the same without `@tiptap/markdown` | 123.0 kB |
| `marked` alone, for comparison | 12.6 kB |

Behind `React.lazy` + `Suspense`, so the main chunk is unchanged and the 141.5 kB arrives the first
time a reader opens a note to edit. StarterKit is narrowed to exactly the dialect pinned
below; nothing else is configured on.

### ⚠️ The CSP is the constraint, and Tiptap clears it — checked, not assumed

The shipped policy is `style-src 'self'; style-src-attr 'unsafe-inline'; script-src 'self'`, and the
dev policy adds `style-src 'unsafe-inline'` — **so a violation here would be invisible under
`tauri dev` and only appear in a built binary.** That is the shape of `motion`'s two forbidden APIs,
which append a `<style>` to `document.head` and fail silently.

`prosemirror-view@latest`, read on 2026-09-10:

- it ships `style/prosemirror.css` for the bundler and **appends no `<style>` to
  `document.head`** — the only `styleSheets` reference in `dist/index.js` is inside `readHTML`,
  reading rules off a *detached* document while parsing pasted clipboard HTML;
- its seven `innerHTML` uses are all in that same clipboard path, on a detached document, never in
  rendering the editor;
- the inline `style` attributes it does set are covered by `style-src-attr 'unsafe-inline'`, which
  the policy already carries.

No `eval`, no `new Function`, no runtime stylesheet. Tiptap is legal under this CSP.

### Reading a note loads no editor

The band's list, the card menu's submenu and the card modal's overlay all render **read-only**, and
mounting a ProseMirror instance per note to do it would be absurd. They render through
`parseNoteBody` — a small closed AST modelled directly on `src/lib/releaseNotes.ts`, whose header
already states the constraint this inherits:

> **This is a reader for release-please's output, not a markdown parser** … the shipped CSP is
> `script-src 'self'` with **no `dangerouslySetInnerHTML` anywhere in `src/`**, so a library that
> answers an HTML string could not be used at all.

Same shape, same rule that nothing is ever dropped for not being understood — a construct the
reader has no rule for falls through to a paragraph and renders as written.

**The two renderers are pinned to one dialect by a round-trip test**, which is the only thing
keeping them from drifting into disagreement: bold, italic, strike, inline code, headings 1–3,
bullet and ordered lists, blockquote, link, paragraph, hard break. `noteMarkdown.test.ts` asserts
that for a committed corpus of bodies, Tiptap's `getMarkdown()` is byte-identical to its input and
`parseNoteBody` produces the same blocks either side of that round trip. Anything outside the
dialect is a paragraph on both sides, which is agreement rather than a gap.

---

## 7. The UI

### The band

`DeckNotesPanel.tsx`, a third collapsible section, mounted in `DeckEditor` **after `DeckStats`** and
wearing `DeckTokensPanel`'s grammar character for character: `<section aria-label>` with
`shrink-0 border-t border-border pt-3`, one rotated `ChevronRight` on a
`duration-[var(--duration-fast)] ease-standard` transition with `motion-reduce:transition-none`,
`aria-expanded`/`aria-controls`, and a body region that stays in the tree while shut. Open state is
`decks.notes_open` through the ordinary `deck.update.mutate({ notesOpen: next })` — `DeckPatch`
names no field per write, so the column is free.

**Nothing may be placed between the deck and `PriceStrip`**: the remove tray sits at `-top-3` into
the desk column's own `gap-3`. The band goes at the bottom of the page, where the other two are.

A row per note: the title, a card-count chip when the note names any, `Edit` and a
destructive-confirm `Delete` through `metaRows.tsx`'s `RowAction` / `CONFIRM_BOX` /
`useConfirmFocus`, and the rendered body below it. Adding is one field and one button in the band's
own header, `META_FIELD` + `META_SUBMIT`, which is `LabelsDialog`'s add-first shape — a reader with
no notes is who this screen is hardest for.

Editing opens the lazy Tiptap editor in place. Attaching cards is a picker over the deck's own
cards, since a note is about a card *in this deck*.

### The card mark

**Folded into `QuantityTag` beside the crown, never drawn as a new corner** — decided 2026-09-10.
`CardMarks.tsx:419-530` argues that a new per-card mark must separate from the existing four on
place, shape, words and the card's own edge, and there is no free corner: the marks strip is
`overflow-hidden` and was measured overflowing a 165 px tile by 11 px. `crowned` is the precedent
for a fifth fact — it was folded *into* an existing mark at a cost of 14 px rather than drawn beside
it.

So `QuantityTag` takes a `noted` prop next to `crowned`. A card that is both a Game Changer and
noted shows **both glyphs and the quantity**, in that order, on the label's own fill. The
accessible name is one text node, per `CardModalRail.tsx:231-234`'s worked example — a CSS `gap` is
not a word separator to name computation, and `Missing2` is the bug that rule exists to prevent.

On the two row views (`Table`, `Text`) the note glyph sits beside `LabelDot` and separates from it
by **shape**: a glyph against an 8 px filled square. It takes no colour of its own — the
`--color-pie-*` deeps are spoken for by labels and gold is spoken for by selection.

### The card menu

`deckCardMenu.tsx` grows, under its own separator:

- `Add note…` — always present, opens the editor with the card already attached;
- `Notes ▸` — a submenu listing the notes that name this card, present only when there are any,
  each row opening that note.

A greyed row's accessible name must include its reason, so an unavailable row is simply absent
rather than disabled.

### The card modal

`CardModalRail` gains a `Notes` row in the first block — nouns naming a surface, so `Notes` and not
`View notes`, which is `Combos`' rule. It opens a fifth `CardOverlay` (`store.ts:890`), mounted in
`App.tsx` as a sibling of the shell and never as a child of the modal, because `CardDetailModal`
asks `Dialog` for `container` and `container-type` implies layout containment.

**Four states, and silence may never imply the fourth.** `Combos`' `ComboState` is the precedent:
notes for this card, no notes for this card, the read in flight, and the read failed. An empty list
and a failed query look identical and mean opposite things.

---

## 8. What is deleted

`decks.notes` and its textarea, with everything that fed them: the field on `DeckInput`,
`DeckPatch`, `DeckRow`, `DeckBefore` and the Storybook fake's `FakeDeck`; the `Notes` control in
`DeckSettingsForm`; `notes` in `CreateDeckDialog`'s draft and payload; `notes` on
`deck_undo::DECK_FIELDS`; `notes` on the `decks` `capture::Spec`; the `field("notes", …)` arm in
`record_deck_edit`; `duplicate_deck`'s carry; the three seeded prose bodies in
`.storybook/fake/seeds.ts`; and `decks-storage.md:828`'s sentence.

**`auditText.ts`'s `case "notes"` stays.** See §1.

---

## 9. Testing

- **Rust.** The rung over a real upgraded file — the column gone, both tables present, the triggers
  back, and `PRAGMA user_version` at 43. The `UNDO_V43` rewind landing on v42's exact shape. Every
  command's refusals in words. The grain folding two devices' identical attachment into one row.
  A `deck` delete cascading to `deck_notes` and on to `deck_note_cards`. The `Op::Notes` step
  round-tripping, including a restore whose id was reused.
- **The wire.** A `decks` op carrying `notes` applied by a build whose spec has no such field —
  asserting `Outcome::Written` and an unstalled watermark, which is §4's claim made checkable.
- **TypeScript.** `parseNoteBody` over the committed corpus; the Tiptap round trip; `noteTitle`'s
  three arms; `notedOracleIds`; `notesForCard`. `ipc.test.ts`'s mirror table gains `DeckNoteRow`
  and `CardNoteRow` — and note that `DeckInput`/`DeckPatch` are **not** on that table, so their
  field removals are pinned only by the hand-written `deckCreate` assertions.
- **Storybook.** A band with no notes, with one, with many, with a long body, and with a note
  naming four cards. A `QuantityTag` crowned, noted, and both. Story counts are not written down.
- **The shipped window.** A green suite and a green Storybook prove nothing about WebView2. The
  CSP check in particular is only real in a **built** binary, because `devCsp` carries
  `style-src 'unsafe-inline'` and would hide exactly the failure §6 rules out.

---

## 10. Out of scope

- **Notes on the collection or the wishlist.** Both already have a per-row `notes` column and this
  is a deck feature.
- **Any export or mirror carrying a note.** No format has a channel for deck-level prose, and
  inventing one would move the golden corpus for a feature nobody asked to export. `surface_of`
  over-approximates both tables into `DECKS_ONLY` anyway, on `deck_tokens`' argument: being wrong
  that way costs a render, being wrong the other way costs a file that never catches up.
- **A note attached to a card the deck does not hold.** The picker offers the deck's own cards. The
  row would survive the card leaving the deck, which is deliberate — a note about a card you cut is
  the note most worth keeping.
- **Images, tables and card-link nodes in a body.** The dialect is §6's list. Widening it later
  costs a rule on both renderers, which is why the round-trip test exists.
- **A block inside a blockquote.** `Block`'s `quote` member holds `Inline[]`, so a list written
  inside a quote reads back with its `-` markers visible as literal text rather than as a list.
  The words are all there — this is the *nothing is dropped* rule doing its job rather than
  failing — and the editor round-trips the construct fine, so only the read-only rendering differs.
  Fixing it means `quote: { blocks: Block[] }`, a recursive union every consumer has to handle,
  and it was **declined on 2026-09-10 with the alternative costed**: three renderers grow a
  recursive case so that a list nested inside a quote in a deck note loses two visible characters.
  If a reader ever reports it, that is the fix and it is bounded (a quote may hold any block but
  another quote).
- **Two marks on one run.** `~~struck [link](…)~~` reads back as struck text with the words intact
  and **the href gone**, because `Inline` is one mark per run. Same trade, same reason, and the
  same fix if it ever matters — a nested inline union.
- **A hard break is a `"\n"` inside a text run**, since the union has no break member. Every
  renderer of these blocks must set `whitespace-pre-line`, or a break a reader typed draws as a
  space. That is a contract on the consumers rather than a limitation of the reader.
