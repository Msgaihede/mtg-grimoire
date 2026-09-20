# Sticky notes: prose on the home page, in a table of its own

Issue [#479](https://github.com/Msgaihede/mtg-grimoire/issues/479). Reported through Discord by
**Supreme** on the Luminia server.

> Add a sticky notes widget to the dashboard page. Users should be able to store a stack of sticky
> notes with names and contents. Use the rich text editor already used for deck notes.

The design was drawn against the published design system on 2026-09-20 and the artboards are the
visual record: [Sticky Notes Widget — Concepts](https://claude.ai/artifact/CH3UweXFxCNhq8ZW4Vz51J).
Three layouts were drawn at a 3×3 footprint, then the two survivors were drawn again at 2×2, 4×2
and 6×3 on the real grid. Every pixel figure below comes from `fit.ts`'s own arithmetic
(`TARGET_CELL` 104, `GAP` 12), not from a guess.

Everything measured here was measured on Windows.

---

## 1. What is already true

**Nothing about this feature is new to the codebase except the table.** Four mechanisms it needs
are already built, shipped and fenced:

| Need | Already exists | Where |
| --- | --- | --- |
| A rich-text editor over CommonMark | `NoteEditor` — `value` / `onChange` / `ariaLabel`, three plain props, no deck state, no required provider | `src/features/decks/NoteEditor.tsx:339` |
| A read-only renderer that loads no editor | `parseNoteBody` — a small closed AST, nothing dropped for not being understood | `src/features/decks/noteMarkdown.ts:298` |
| A plain-text rendering for somewhere that cannot draw | `noteToPlainText` — zero-dependency, pure regex, deliberately un-truncated | `src/features/decks/noteMarkdown.ts:436` |
| A widget that grows its own settings without the panel learning a special case | the `widgets.ts` registry — `picks`, `toggles`, `chip`, read generically by `WidgetSettingsPanel` | `src/features/home/widgets.ts:150` |

`DeckNotesPanel.test.tsx:40` already swaps `NoteEditor` for a bare `<textarea>` keeping only those
three props, which is the proof that the contract is substitutable rather than an argument that it
ought to be. **So this feature writes one table, five commands, one widget and one dialog, and
reuses every renderer.**

**The one thing it must not do is import `NoteEditor` statically.** `DeckNotesPanel.test.tsx:691`
sweeps all of `src/` for `import … from "…/NoteEditor"` with an anti-vacuity guard, and a static
import puts a measured 141.5 kB gzip back in the main chunk with nothing else going red. The sweep
has one hole worth knowing: it matches the *path*, so a file importing `@tiptap/react` directly
would pass it. Nothing here does that.

---

## 2. The model, and the three things already called "notes"

⚠️ **This app now has three unrelated things spelled `notes`, and this feature adds the fourth.
Never let the words trade places.**

| Thing | What it is | Spelled |
| --- | --- | --- |
| a **deck note** | the reader's prose about one deck, with card attachments | `deck_notes`, `DeckNote` |
| a **card note** | the same row read from the card's side, across every deck | `card_notes`, `CardNoteRow` |
| an **entry note** | a free-text column on one collection or wishlist row | `collection_entries.notes` |
| a **sticky note** | the reader's prose about nothing in particular, on the home page | `sticky_notes`, `StickyNote` |

**A sticky note belongs to the reader and to nothing else.** That is the whole model, and it is
what separates it from a deck note: there is no parent, no attachment and no scope. It is the
fourth synced table to hang off nothing — `deck_labels`, `device_names` and `muted_tags` already
carry `parents: &[]` — so the shape is precedented rather than novel, and `muted_tags` is the one
to read first.

Three properties follow, and each decides something later:

- **A sticky note has a title and a body**, the deck note's shape verbatim. The title may be empty
  and the body's first line is printed in its place, **computed at render and never stored** —
  `schema.rs:4044` states the reason and it is unchanged here: a stored derivation goes stale the
  moment the body is edited and no writer could notice.
- **A sticky note has a colour, and the colour is the reader's filing, not the app's.** It carries
  no meaning the app reads. This is the one genuinely new vocabulary and §3 pins it.
- **A sticky note is not a widget's property.** Two `stickyNotes` widgets show one stack, exactly
  as two `decks` widgets show one gallery — `home-page.md:129` already establishes that a kind may
  appear more than once and that the `id` identifies the *widget*, never its contents.

### ⚠️ The notes do not live in `config`, and the cap is why

`config` is opaque to Rust and rides the layout document, so a note body *would* store and sync
with no table at all. It is refused on three counts, the first of which is decisive:

- **`home.rs:156` caps the whole layout document at `MAX_BYTES = 64 * 1024`**, and `home.rs:151`
  says what the cap is aimed at in words: "anything over it is a `config` being used as a document
  store". A reader whose notes grew past it would stop being able to save **their dashboard** — not
  their note — and the failure would arrive while dragging a widget.
- Two widgets could not show one stack, which §2 has already decided they must.
- Removing a widget would silently delete prose. `useHomeLayout`'s remove is optimistic and
  deliberately un-rolled-back.

---

## 3. Storage — user schema v46

⚠️ **45 is the highest rung today (`schema.rs:424`), so this is 46 — but take the next free number
at the moment you land, never at the moment you start.** A `USER_SCHEMA_VERSION` collision is
invisible to git because both branches write the same line; rungs 12/13/14 collided three times in
one day and v37 was renumbered three times. `grep USER_SCHEMA_VERSION src-tauri/src/schema.rs` is
the only thing that settles it.

```sql
CREATE TABLE sticky_notes (
    id INTEGER PRIMARY KEY,
    -- May be empty. The widget prints the body's first line when it is, computed at render.
    title TEXT NOT NULL DEFAULT '',
    -- CommonMark, in the same narrowed dialect `noteMarkdown.ts` pins for deck notes. Never
    -- HTML and never ProseMirror JSON: a body Rust can hand to anything as text is what keeps
    -- a renderer out of this crate.
    body TEXT NOT NULL DEFAULT '',
    -- One of five names the page knows. **Deliberately no CHECK** — see below.
    color TEXT NOT NULL DEFAULT 'slate',
    pinned INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
 , sync_uid TEXT);

CREATE UNIQUE INDEX idx_sticky_notes_uid ON sticky_notes (sync_uid);
```

`user.db`, `Side::User`. The registry comment on `deck_notes` (`schema.rs:539`) is the sentence to
copy: it was "the one table on the list whose whole content is typing" and now there are two.

**No grain index, uid only** — `deck_notes`' reason verbatim (`schema.rs:6105`): two devices each
typing a note about the same thing must stay two notes, and there is no column pair that could tell
an accidental duplicate from a deliberate one.

### ⚠️ `color` carries no CHECK, and the reason is what the vocabulary *is*

**It is not that enumerated CHECKs and sync do not mix** — an earlier draft of this document said
that and it was wrong. Eight enumerated `CHECK`s already sit on seven synced tables:
`collection_entries.finish` and `.condition`, `decks.cover_kind`, `deck_categories.kind`,
`deck_cards.variant`, `deck_audit.variant`, `collection_folders.kind`, `deck_tokens.state`.

What separates those from this one is **who owns the list and how it grows.** Every one of them is
Magic's vocabulary or this app's model — finishes, conditions, card variants — and a word joins it
only in a rung that migrates the existing rows at the same time. A note's colour is none of those:
it is a **palette the page owns**, carries no meaning the app reads, and is expected to grow
because someone will want a sixth. A `CHECK` would make that a schema rung on every device rather
than a line in `NOTE_COLORS`, and until every device had climbed it, a note wearing the new colour
would be a row the older device **refuses at the constraint** — a failed apply, not a note that
arrives looking wrong.

So the page decides instead, which is `widgets.ts:118`'s existing rule one table over: "A stored
value no option carries reads as the default too, so a word a newer build wrote cannot reach a
widget that has no branch for it." An unknown colour draws as `slate`.

Rust stores the string it is handed and validates nothing about it.

### The five colours

Five, drawn as a 3 px strip across the top of the note rather than as a fill or a left border. They
are a new `--color-note-*` family in `src/index.css`'s `@theme`, placed **after** the rarity block
and outside the pie deeps, for the theory marks' stated reason (`index.css:362`): they are not a
sixth identity colour and must not read as one.

| Stored | Surface | Strip |
| --- | --- | --- |
| `amber` | `oklch(0.26 0.04 85)` | `oklch(0.62 0.1 85)` |
| `jade` | `oklch(0.26 0.04 155)` | `oklch(0.6 0.1 155)` |
| `azure` | `oklch(0.26 0.04 250)` | `oklch(0.62 0.1 250)` |
| `rose` | `oklch(0.26 0.04 20)` | `oklch(0.62 0.11 20)` |
| `slate` | `oklch(0.26 0.008 270)` | `oklch(0.55 0.015 270)` |

**Low chroma on purpose.** Mana fills and pie deeps are saturated because they carry meaning the
app reads; a sticky note's colour carries meaning only its author knows, so it must not out-shout
them. The surfaces sit at L 26% against `--color-surface`'s 21%, so a note reads as paper raised
off the panel.

⚠️ **`--color-dim` is not legible on these surfaces.** Measured against the L 26% fills it lands at
about 4.3:1, under the 4.5:1 floor for body text. The family therefore carries
`--color-note-dim: oklch(0.73 0.012 90)` for the secondary line **on** a note, and the ordinary
`text-dim` stays for everything on the page background. A widget that uses `text-dim` inside a note
tile is a contrast bug that no test will catch.

The family carries a third text token, `--color-note-body: oklch(0.88 0.005 90)`, for the reader's
own prose — **a step below `--color-text`'s 93%, deliberately.** A note is paper laid on the page
rather than more page, and ink at full strength makes it read as another panel. It is far above the
contrast floor against the L 26% fills, so the step costs nothing legibility owns.

⚠️ **Set these inline from the custom property, never as a Tailwind class.** `src/CLAUDE.md`'s rule
for reader-chosen marks applies verbatim, and a mistyped Tailwind arbitrary value emits no rule at
all rather than failing.

---

## 4. What the new synced table owes

**It syncs.** `deck_notes` — the only other table that is entirely typing — does, and a reader who
writes a note on the desktop and finds it missing on the laptop has lost prose rather than a
preference. The two tables that *don't* sync are both machine-generated and per-device by
construction: `activity` is an append-only log whose absence `home-page.md:373` records as a known
consequence, and `price_snapshots` is every device taking its own snapshot of the same public
prices. Neither argument reaches typing.

The cost is ten registration sites, and **nothing at any of them points at the tenth**
(`sync.md:920`):

| # | Site | What goes there |
| --- | --- | --- |
| 0 | `schema::USER_SCHEMA_VERSION` | 45 → **46**, and the literal assertion at `schema.rs:9168` |
| 1 | the `v < 46` rung | the `CREATE TABLE` + index above |
| 2 | `schema::USER_SCHEMA_SQL` | the same DDL at head shape, **byte-identical** — `the_user_schema_is_byte_identical_to_what_the_ladder_builds` compares them string for string |
| 3 | `UNDO_V46` + every chain literal | `DROP INDEX`, `DROP TABLE`. **It runs first**, before `UNDO_V45` — rewinds walk the ladder backwards. ⚠️ **There are sixteen chain literals, not the handful a glance suggests** — `grep -c '"{UNDO_V45}'` is what settles it, and a miss leaves a fixture rewinding to the wrong shape while still climbing green. There is **no** `user_file_at_45()`: the fixtures stop at 44, and adding an uncalled one is a `dead_code` warning that CI's `clippy -D warnings` turns red |
| 4 | `schema::TABLES` | one `Side::User` entry, 29 → **30**, plus the name in `the_user_side_is_the_twenty_nine_tables_no_feed_can_rebuild`'s spelled-out list — whose *name* carries the count and so is renamed too |
| 5 | `schema::SYNCED_TABLES` | 15 → **16**, sorted |
| 6 | grain constants | **none** — the table has no grain |
| 7 | `mirror::watch::surface_of` | an explicit decision: a sticky note reaches **no** mirror surface, because it is neither a deck nor the collection. The default arm is `_ => None`, so an undecided table is silently invisible; `every_table_in_the_schema_has_been_decided_about` is the fence, and `activity` and `app_meta` at `watch.rs:1088` are the precedent |
| 8 | `capture::TABLES` | one `Spec`; `[Spec; 16]` |
| 9 | `apply::META` | one `Meta` at `order: 15`; `[Meta; 16]` |
| 10 | `apply/tests.rs` | ⚠️ **nothing, and that is the answer.** `every_unique_index_on_a_synced_table_has_been_decided_about` skips a table's own uid index by name (`if name == format!("idx_{table}_uid") { continue; }`), so adding `idx_sticky_notes_uid` to its list makes the assertion fail. `deck_notes` is absent from it for the same reason. A comment where the row would have sorted is what this site is owed |

The index count in `schema.rs:7663`'s prose moves too. **Re-count it; do not add one to the number
written there** — the repo's own rule for a figure a build already answers.

### The `capture::Spec`

```rust
Spec {
    table: "sticky_notes",
    keys: &["id"],
    fields: &["title", "body", "color", "pinned", "sort_order"],
    counters: &[],
    // Hangs off nothing, as `deck_labels`, `device_names` and `muted_tags` already do.
    parents: &[],
    append_only: false,
},
```

⚠️ `created_at` and `updated_at` are on no field list, `capture.rs:50`'s rule: syncing a timestamp
would put two answers to "when" in the database.

**No INSERT in `sticky_notes.rs` may name `sync_uid`.** The capture trigger mints it —
`lower(hex(randomblob(16)))`, unconditionally, on unpaired devices too — and nothing in any
`deck*.rs` has ever written that column.

### Two sites owed by any new user table, synced or not

- **`src/lib/userTables.json`** — a Rust test asserts it equals the user side of `schema::TABLES`.
- **`src/lib/crossWindow.ts`** — a Vitest test asserts the map's keys equal that file. The entry is
  the union of what this table's own mutations invalidate in the window that made them, so:
  `["stickyNotes"]`. ⚠️ `multi-window.md:213` names the trap to check it against — a query whose
  command *writes* the table its own key reads is a refresh loop. None of these five commands
  writes on read.

`changes.rs` needs nothing: it is only owed by a `WITHOUT ROWID` table, and this one has an
`INTEGER PRIMARY KEY`.

---

## 5. The boundary

### Rust supplies facts

`src-tauri/src/sticky_notes.rs`, pure functions over `&Connection` with the command wrappers in one
`#[cfg(not(target_family = "wasm"))]` block at the foot — `deck_notes.rs`'s file shape.

| Command | Answers |
| --- | --- |
| `sticky_notes` | every note, `ORDER BY sort_order, id` |
| `sticky_note_create(title, body, color)` | the new id |
| `sticky_note_update(id, title?, body?, color?, pinned?)` | `()` |
| `sticky_note_delete(id)` | `()` |
| `sticky_note_reorder(ids)` | `()` |

The patch idiom is `deck_notes.rs:541`'s: `SET title = coalesce(?2, title), …, updated_at =
unixepoch()` — absent means leave it, and `Some("")` really empties. Refusals are `pub const`
sentences fired **before** the transaction opens, never `CHECK`s: one is needed,
`NOTE_GONE`.

**Three things `deck_notes.rs` does that this module must not.** There is no `touch_deck`, no
`deck_audit::record` and no `deck_undo::record_step` — a sticky note belongs to no deck, so none of
those tables has a row shape for it.

**And no `activity` row either.** Not a judgement call: `activity.scope` is
`CHECK (scope IN ('collection','wishlist'))`, so there is no word to write, and widening a CHECK
constraint is a table rebuild. The feed is about the collection; a sticky note is not in it.

Registration is three places and **a miss is silent — `unknown command` at runtime with nothing
red** (`home-page.md:415`): `lib.rs`'s module map, `desktop.rs`'s `generate_handler!`, and
`web::route`'s `COMMANDS` array **plus** a `match` arm. All five are synchronous, connection-only
and touch no network, so they are legal routed commands on the web target.

**No capability entry.** Tauri v2's ACL gates only `core:` and `plugin:` commands; `capabilities/`
names no app command and must not start.

### TypeScript draws conclusions

`src/features/home/stickyNotes.ts` — pure, tested, no React:

- `noteTitle(note)` — the title, or the body's first line, or `UNTITLED_NOTE`. **Reuse
  `deckNotes.ts:50` verbatim**; it already takes a `Pick<…, "title" | "body">` precisely so a
  non-deck note shape can use it.
- `notePreview(body, lines)` — `noteToPlainText` split on `"\n"`, blanks dropped, clamped. ⚠️ A
  wrapped paragraph is **one** line in that string (`joinRuns` joins source lines with a space), so
  `lines` counts blocks and list items, not visual lines — the tile still needs a character clamp.
- `noteColor(stored)` — the five names, anything else `slate`.
- `orderedNotes(notes, pinnedFirst)` — `sort_order`, with pinned lifted when the toggle is on.

---

## 6. The editor

**One dialog, `StickyNoteDialog.tsx`, mounting `NoteEditor` behind `React.lazy` + `Suspense`** —
`DeckNotesPanel.tsx:997`'s pattern, one line each, with a sentence rather than a spinner for the
fallback because the chunk arrives off local disk.

It differs from the deck band in exactly one way, and it is a real gap rather than a copy:
**saving.** `DeckNotesPanel` is an explicit Save button with no debounce and no unsaved-change
guard — a draft is discarded silently on close. That is tolerable in a band the reader deliberately
opened to edit; on a dashboard, where the dialog closes on a scrim press, it loses prose. So the
sticky-note dialog **autosaves on a debounce and reports it** ("Saved just now"), and there is no
Cancel. Nothing in this codebase does that today; it is new code, and it is the only new
interaction in the feature.

⚠️ **The dialog is a `fixed` overlay mounted inside the widget body, and that is legal here only
because this page has no containment.** `fit.ts:15` and `HomePage.tsx` both state it: there is no
`container-type` anywhere on the home page, deliberately, because `@container` makes a box the
containing block for every `fixed` descendant. A future container query on this page breaks this
dialog, and the widget cards' two anchored popovers, together.

### The two fences on `WidgetBodyProps`

`widgetProps.ts:27` hands the body `still` and `editing`, and a notes widget must honour both:

- **`still`** is a catalogue preview. It must not open a dialog and must not load a 141.5 kB chunk
  to draw a thumbnail; its scroller clips rather than scrolls.
- **`editing`** is Customize. The page makes the body `inert`, so the whole card is a drag handle —
  a press on a note is a pick-up, not an open.

### Rendering a note

The widget draws note bodies through `parseNoteBody` with its **own** block components. Three
renderers of that AST already exist and sharing was deliberately refused because they draw at
different type scales (`DeckNotesPanel.tsx:1028`); this is the fourth and the refusal still holds.

⚠️ **It must set `whitespace-pre-line`.** A hard break travels as a `"\n"` *inside a text run*, so a
renderer that does not set it draws a lost line boundary as a space. This is a rule
`src/features/decks/CLAUDE.md` states and `NotesOverlay.tsx` currently breaks.

---

## 7. The UI

The widget is `stickyNotes`; the table is `sticky_notes`; the word on screen is **Notes**, because
on the home page there is nothing else it could be. All three spellings are deliberate and the
registry row is where they meet.

```ts
stickyNotes: {
  label: "Notes",
  description: "Sticky notes you write yourself, in the editor deck notes already use.",
  def: [4, 3],
  min: [3, 2],
  max: [8, 6],
  picks: [{ key: "layout", label: "Layout", options: [
    { id: "board", label: "Board" },
    { id: "pad", label: "Pad" },
  ]}],
  toggles: [
    { key: "dates", label: "Show edited date" },
    { key: "strip", label: "Show colour strip" },
    { key: "pinned", label: "Pinned note first" },
  ],
  chip: "layout",
},
```

⚠️ **`RESERVED_KEYS = ["title", "density"]`** (`widgets.test.ts:45`) — neither may be a pick or
toggle key here. `title` is already the reader's own card name.

⚠️ **All three toggles default on, and since 2026-09-20 that is a choice rather than the only
option.** `WidgetToggle` gained a `dflt` field when `newPrintings` landed on `main` — it starts two
of its three off — so "absent means on" is the default rather than the rule. All three above are
written to be correct that way round.

**It does not join `DEFAULT_LAYOUT`.** That layout fills an eight-by-seven rectangle exactly so a
first launch shows no hole (`home-page.md:127`), and a tenth widget breaks it. Catalogue only —
which also means none of the three copies of that literal (`widgets.ts`, `home.rs`,
`.storybook/fake/db.ts:2623`) moves.

### Board — the default

A grid of tinted tiles, each a 3 px strip, the note's name in the display face, and a preview
clamped to the tile. A pinned note wears a 6 px gold dot. Columns come from the body's width, not
from cells: **two at 2×2, three at 4×3, four at 6×3**, which is
`clamp(2, floor(bodyWidthPx / 115), 4)` as a starting point — the artboards are the target and a
live pass settles whether 4×2 wants three columns or four.

Rows are whole rows. `fit.fitCount(tileH, footerPx)` is the existing helper and **zero is a real
answer** — a card with room for no tile draws none rather than one it clips.

**What the 2×2 costs, stated because it is the reason `min` is `[3, 2]`.** At 220 px the tiles are
96×67 and every name truncates: "Trade night — Friday" becomes "Trade nig…". `min` is the only
thing that makes that size unreachable — `boundsOf` clamps the steppers, the resize corner and the
arrow keys against it — and every other kind's `min` is `[2, 2]` or smaller, so this one is doing
real work and will look like a mistake to the next reader. It is not.

### Pad — the option

One note at full size with the rest of the stack as sheets behind it. It reads better small than
Board does and worse large, which is why it is the option rather than the default. It changes with
the tier:

| tier | `w` | What carries the other notes |
| --- | --- | --- |
| 0–1 | 2–3 | a pager, `‹ 2 / 7 ›` |
| 2 | 4–5 | a horizontal rail of names, the current one in gold |
| 3 | 6+ | the rail turns vertical and becomes the pad's index |

**Which note the Pad shows is not stored.** It opens on the pinned note if there is one, else the
first in order, and the reader's flip lives in the widget's own `useState`. Storing it would sync a
transient and spend layout bytes on it; §2's cap argument applies in miniature.

### Empty

A stacked-paper mark, "No notes yet", one dim sentence, and a New note button — `WidgetMessage`'s
tone, drawn as its own block because the button is not a sentence.

---

## 8. Testing

- **Rust.** The rung's rewind (`UNDO_V46` first in every chain), the byte-identity of
  `USER_SCHEMA_SQL`, the capture census, and `sticky_notes.rs`'s own `#[cfg(test)]` module over the
  five commands — including that `Some("")` empties a title and `None` leaves it.
- **The cross-boundary fence.** `src/lib/ipc.test.ts` is opt-in and is what catches Rust↔`ipc.ts`
  drift; all five commands go on it. A `vi.fn()` mock erases the mirror, so a new field fails at
  runtime rather than at `tsc`.
- **TypeScript.** `stickyNotes.ts`'s four derivations against a committed corpus, the preview
  clamp's block-versus-visual-line behaviour explicitly, and `noteColor`'s unknown-word fallback.
- **The widget.** Both layouts at each tier, the whole-row cut at a height that fits none, `still`
  opening nothing, and the empty state.
- **⚠️ The story gap this inherits.** `home-page.md:507` records that six widgets' "could not be
  read" branches have no Storybook world that produces them, because `refuseIfBusy` is wired into
  every write handler and no read. A `sticky_notes` read refusal will be equally unstoryable and is
  covered by the widget's unit test instead. Do not add a fault to chase it.

---

## 9. Out of scope

- **Filtering a widget to one colour.** Two widgets showing two colours is the obvious next ask and
  `config` is the right home for it — but it is a second pick and a second empty state, and the
  feature is answerable without it.
- **Attaching a card to a sticky note.** That is a deck note, and it already exists.
- **Sticky notes in the text mirror, an export format, or a share.** §4 decides the first; the
  other two would each need a field-registry entry and a golden-corpus row.
- **Moving `NoteEditor` or `noteMarkdown.ts` out of `features/decks`.** A cross-feature import is
  idiomatic here — the widgets already pull `StatsCard` from that directory — and being the second
  caller is not enough to pay for a move while other branches are editing those files.
  `home-page.md:475` records the same trade and the same regret.
