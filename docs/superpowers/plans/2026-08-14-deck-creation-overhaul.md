# Deck creation overhaul — one settings form, two surfaces

**Date:** 2026-08-14 · **Branch:** `worktree-deck-creation-overhaul`

## The problem

`CreateDeckDialog` asks two questions — name and format. Everything else a deck carries
(description, notes, cover, folder, theory) is reachable only from `DeckSettingsDialog`, which
means the app's one **creating** act produces a deck the reader then has to go and configure.
The two surfaces also hand-roll the same controls: there are **three** spellings of the format
`<select>` in this feature already (`FormatSelect.tsx:59`, `DeckSettingsDialog.tsx:718`,
`DeckEditor.tsx:1011`).

## The shape

One presentational component, `DeckSettingsForm`, owns every deck-level field and **no
mutation**. Two hosts drive it:

| Host | Value comes from | A change writes |
| --- | --- | --- |
| `DeckSettingsDialog` (edit) | `useDeck(deckId)`, plus text drafts | immediately — a select on change, the switch on press, a text field on blur. Unchanged. |
| `CreateDeckDialog` (create) | local draft state | nothing until **Create deck**, which is one `deck_create`. |

That difference is the whole reason the form takes both `onChange` (every keystroke and press)
and `onCommit` (a text field the reader is finished with). The edit host writes on `onChange`
for the controls that settle in one act and on `onCommit` for the three text fields; the create
host merges `onChange` into its draft and **ignores `onCommit` entirely**.

**The form imports no hook that reaches the backend** — not `useDeck`, not `useDeckFolders`,
not `useFormatSpecs`, and no mutation. That is what makes it usable before the deck exists, and
it is the rule to hold when the file grows.

## The wire: `deck_create` grows to carry a whole deck

Creating a configured deck as create-then-patch-then-setFolder is three transactions and a
half-made deck to roll back by hand — the trap `deck_import_commit` exists to avoid
(`docs/reference/decks-storage.md`). So `DeckInput` grows instead, and one INSERT makes the
whole deck:

```rust
pub struct DeckInput {
    pub name: String,
    pub format_key: String,
    pub description: Option<String>,
    pub notes: Option<String>,          // new
    pub cover_card_id: Option<String>,  // new
    pub folder_id: Option<i64>,         // new
    pub theory_enabled: Option<bool>,   // new
}
```

Four things to know about it:

- **`folder_id` here has no `coalesce` trap.** `DeckPatch.folder_id` cannot un-file a deck
  because a patch writes `coalesce(?n, folder_id)` and reads a bound NULL as "leave it". This is
  an INSERT: `None` *is* the top level, and it means it. `ipc.deckSetFolder` remains the only way
  to un-file an **existing** deck; nothing about that changes.
- **`cover_kind` is not settable at create** — it stays its DDL default, `card_art`. A custom
  picture is `deck_set_cover_image`, which takes a path and needs a deck id, so it can only be a
  follow-up call. See "the upload arm" below.
- **`theory_enabled` at create sets the column and seeds nothing**, because there are no live
  cards to seed from. `DeckPatch`'s seeding behaviour is untouched.
- **A deck's birth stays exactly one audit row** — the existing
  `{field:"name", from:null, to:name}`. `deck_update` records one row per changed field because
  each of those is an event; being born is one event however many fields it was born with, and
  `every_deck_write_leaves_exactly_one_audit_row` says so.

No new validation. `name` and `format_key` keep `valid_name`/`valid_format`; `folder_id` is
fenced by the real foreign key (`decks.folder_id REFERENCES deck_folders(id)`, enforced because
both are user tables) and `cover_card_id` is a soft reference like every card id in a user
table, so neither is checked in Rust.

## The cover picker gains a card search

A brand-new deck has no cards, so "Pick art from cards in this deck" offers nothing at create.
`DeckCoverPicker` therefore grows a second source: **search every printing in the database**.

- One grid, two modes. Empty search box → the deck's own cards (today's `coverChoices`, today's
  empty-state sentence at create). A query → the results, under a heading that says so.
- `ipc.searchCards({ text, limit, offset, collapse: false, playableOnly: false })`.
  **`collapse: false`** because different printings are different art and collapsing them hides
  exactly the choice being made; **`playableOnly: false`** because art series and tokens are some
  of the best crops and a cover is not a card you cast. Debounce and page size follow
  `useCardSearch` (300 ms, 50).
- **Result tiles do not credit the illustrator, following the documented exception on
  `ChoiceTile`** (`DeckSettingsDialog.tsx:526-543`): `CardSummary` carries no `artist`, the same
  crop is drawn uncredited by `CardStack`, `GridView` and `TheoryDiffDialog`, and every tile is a
  control that names its card. Repeat that reasoning in the new component's doc — an
  undocumented instance of a known gap is how a known gap becomes an unknown one. The **preview**
  stays strict: it draws `Art by {coverArtist}` and refuses a crop whose artist is unknown, which
  is `DeckRow.coverArtist`'s existing ruling.

## Tasks

Contract-first: every task below codes against the interfaces in this document, so waves 1's
five tasks run at once. Nobody runs the test suite — `npm run verify` runs once, after fan-in.

### Wave 1 — parallel, disjoint files

**T1 — Rust: `deck_create` carries a whole deck.** `src-tauri/src/deck.rs` only.
Widen `DeckInput` with the four fields above, extend `create_deck`'s INSERT, keep the single
audit row, keep `ensure_predefined_categories`. Fix the stale doc on `DeckPatch.notes`
(`deck.rs:127-129`) which says the "New deck" dialog fills `description` — it does now.
Tests, in the file's own `#[cfg(test)]` module: a create carrying every field reads back with
all of them; `folder_id: None` lands at the top level; a bogus `folder_id` is refused by the FK;
`theory_enabled: true` on a new deck seeds no cards; the create still writes exactly one audit
row. Re-run `every_deck_write_leaves_exactly_one_audit_row`'s case list — do not renumber it.

**T2 — the TS mirror.** `src/lib/ipc.ts` + `src/lib/ipc.test.ts` only.
Mirror the four fields on `DeckInput` with doc comments carrying the four bullets above
(especially: `folderId` here **can** mean the top level, unlike `DeckPatch.folderId`). Update the
`deck_create` arg-shape test.

**T3 — the Storybook fake.** `.storybook/fake/db.ts` + `.storybook/fake/db.test.ts` only.
`deck_create` (db.ts:4321) honours the new fields, matching T1's behaviour including the single
audit row and the top-level default. **Grep does not read `db.ts`** — ripgrep calls it binary;
Read it.

**T4 — `DeckCoverPicker`.** New `src/features/decks/DeckCoverPicker.tsx` + stories + test only.
Move `CoverPreview`, `ChoiceTile`, `Upload` and `coverChoices` out of `DeckSettingsDialog.tsx`
into it (keep every doc comment — they carry measurements), and add the search mode above.
Props, exactly:

```ts
export interface DeckCoverPickerProps {
  /** What the preview draws, and what a tile marks as current. `null` before a deck has one. */
  coverCardId: string | null;
  coverKind: DeckCoverKind;
  /** Credited under the preview. `null` draws no line — never the word "null". */
  coverArtist: string | null;
  /** A custom cover's URL names the deck, not the picture, so the preview keys on this to
   *  notice a replaced file. Absent at create. */
  customCoverUrl: string | null;
  customCoverKey?: string | number;
  /** The deck's own printings, offered when the search box is empty. `[]` at create. */
  deckCards: readonly DeckCard[];
  onPickCard: (cardId: string) => void;
  /** The file picker's answer — a path the backend reads. */
  onPickFile: (sourcePath: string) => void;
  /** A file chosen but not applied yet: the create dialog has no deck id to upload against,
   *  so it shows the name instead of a preview. `null` in the settings dialog. */
  pendingFileName: string | null;
  uploading: boolean;
  idPrefix: string;
}
```

**T5 — `DeckSettingsForm` + `useDeckField`.** New `src/features/decks/DeckSettingsForm.tsx`,
new `src/features/decks/useDeckField.ts`, plus stories and a test, only.
Move `useDeckField` out of `DeckSettingsDialog.tsx` **verbatim, doc comment included** — it is
the edit host's hook, not the form's; the form is controlled. Move `Fields`, `TheorySwitch`,
`FolderRow` and `folderPaths` into the form. It renders `<DeckCoverPicker>` in the left column
against T4's props. Props, exactly:

```ts
export interface DeckSettingsValue {
  name: string;
  formatKey: string;
  description: string;
  notes: string;
  theoryEnabled: boolean;
  folderId: number | null;
}

export interface DeckSettingsFormProps {
  value: DeckSettingsValue;
  /** Every change, live: a keystroke, a select, a press. */
  onChange: (patch: Partial<DeckSettingsValue>) => void;
  /** A text field the reader is finished with — blur, Enter, or the surface closing. The
   *  settings dialog writes here; the create dialog has nothing to write yet and ignores it. */
  onCommit?: (patch: Partial<DeckSettingsValue>) => void;
  formats: readonly { key: string; name: string }[];
  folders: {
    paths: readonly { id: number; path: string }[];
    /** The folder list could not be read; the select is no use without it and says so. */
    unread: string | null;
    loading: boolean;
    pending: boolean;
  };
  cover: DeckCoverPickerProps;
  idPrefix: string;
}
```

### Wave 2 — after wave 1, parallel

**T6 — rewire `DeckSettingsDialog`.** `src/features/decks/DeckSettingsDialog.tsx` + its test and
stories only. It keeps everything that is about *this deck existing*: `useDeck`, `useDeckFolders`,
`useFormatSpecs`, the three mutations, `writeFailure`'s banner, the loading / read-failure / gone
states, the scrim, `trapTab`, the Escape rung and the focus-the-panel effect. It keeps three
`useDeckField`s and maps them into `value`/`onChange`/`onCommit`. **Acceptance: its 34 existing
tests pass with no change to what they assert.** Any test edit must be a label or an id, never a
behaviour — if a behaviour has to change, stop and say so.

**T7 — rebuild `CreateDeckDialog`.** `src/features/decks/CreateDeckDialog.tsx` + its test and
stories only (and `DecksPage.tsx` **only** if the wider panel needs it). Same 55rem two-column
panel as the settings dialog, one `DeckSettingsForm`, a **Create deck** button. Keep every
existing behaviour its suite pins: caret starts in Name, blank/whitespace name refuses by pointer
and by Enter, the refusal line survives and keeps what was typed, Escape hands focus back, a
scrim press closes and an inside press does not, Tab is trapped, no formats falls back to Casual.
Submit sends one call:

```ts
create.mutate({ name: trimmed, formatKey, description, notes, coverCardId, folderId, theoryEnabled })
```

**The upload arm needs a deck id, so it is a follow-up and gets a real state.** On success, if a
file was chosen, `ipc.deckSetCoverImage(deck.id, path)` runs before `onCreated`. If *that* fails,
the deck exists and must not be lost or duplicated: hold the created deck in state, show
`The deck was made, but its picture could not be saved — {error}`, and turn the submit control
into **Open deck**. Pressing Create again with a deck already created is not a second deck.

### Wave 3 — fan-in (the lead, not a subagent)

`npm run verify` → fix → docs → live CDP pass → commit → PR.

Docs owed, all in the commit that changes the behaviour:
`src/features/decks/CLAUDE.md` (the shared form, the two commit models, the widened create),
`docs/reference/decks-storage.md` (`deck_create`'s new fields and the four bullets above), and
the create-dialog story/test counts anywhere they are written down — a prose-only edit routes to
neither CI job, so nothing goes red when one rots.

## Out of scope, deliberately

- **`isBuilt` and `archived` stay where they are** — the editor header's toggle and the gallery
  tile's action. Both are meaningless on a deck that does not exist yet, and `isBuilt` reallocates.
- **`FormatSelect`'s third spelling.** The form absorbs the settings dialog's `<select>`;
  `DeckEditor`'s header select and `FormatSelect.tsx` are left alone.
- **`DeckPatch`'s double-`Option`.** Still no way to clear a description or un-file through a
  patch. Unchanged, and still worth doing once, deliberately.
- **`artist` on `CardSummary`.** See the cover-picker section — the new tiles follow the
  documented exception rather than widening `search.rs`.
