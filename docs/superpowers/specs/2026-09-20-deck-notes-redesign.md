# Deck notes — the band redesigned

**Status: design settled, nothing implemented.** Drawn on a Design canvas on 2026-09-20 against the
shipped band, and the artboards are in [`deck-notes-redesign/`](deck-notes-redesign/) beside this file.
Every number below was taken off those artboards, which were themselves built from the class strings
in `src/features/decks/DeckNotesPanel.tsx`, `NoteEditor.tsx`, `metaRows.tsx`, `src/components/Dialog.tsx`
and `PullFromCollectionDialog.tsx` — so a measurement here that disagrees with the source is this
document being wrong, not the source.

Four changes, and the fourth is the only one that reaches Rust.

---

## 1. The list becomes a grid

`NotesBand`'s `<ul className="flex flex-col gap-1.5">` becomes a card grid.

| Thing | Value |
| --- | --- |
| columns | `repeat(auto-fill, minmax(280px, 1fr))` |
| gap | 8px (`gap-2`) |
| card max width | 420px |
| card height | **184px, fixed** |
| card | `rounded-lg border border-border bg-surface px-3 py-2.5` |
| name line | 13px (`text-[0.8125rem]`) `font-medium text-text`, one line, truncate |
| body | 12px (`text-xs`) `leading-relaxed text-dim`, `-webkit-line-clamp: 3` with a thumbnail strip, `6` without |
| thumbnail strip | up to three 44×32 crops + a `+N more` chip, `gap-1.5` |
| actions | `Cards` · `Edit` · `Delete`, the existing `RowAction`, right-aligned, `gap-2.5` |

At the editor column's 1192px that is **four up at 292px each**; two columns from ~860px, one below
~580px. The card is uniform height on purpose — a grid whose tiles disagree about their height reads
as a failed masonry rather than a grid — and the body's clamp is what pays for the strip.

**The mono `N cards` chip comes off the name line.** The strip counts the cards now, and two of them
saying the same thing on a 292px card is one too many. It stays in the picker (§4).

Everything `NoteRow` draws below its title row — `NoteEditForm`, `NoteCards`, `DeleteNote` — leaves
the row entirely; see §2 and §4. What is left of `NoteRow` is the card above.

## 2. `New note` opens a dialog, and there is no title field

**Delete the add row** — the `META_FIELD` input, its `sr-only` label, the `Add note` submit and the
`draft` state. The band's header row gains one control at `ml-auto`:

```
New note — META_SUBMIT's recipe (h-8 rounded-md border-accent px-3 text-xs text-accent) + a size-3.5 Plus
```

It opens `Dialog` at **`size="w-[40rem]"`**, title `New note`, body = the lazy `NoteEditor` over a
`min-h-60` surface, footer `Save note` (META_SUBMIT) + `Cancel` (CONFIRM_CANCEL).

**No title input anywhere in the create flow.** The note is written with `title: ""` and
`noteTitle()` answers the first line of the body — which is what it already does for a blank title
today. Two consequences worth stating before anyone writes the code:

- `deckNotes.ts`'s `noteTitle` stops being a fallback and becomes **the** naming path for every note
  made from this dialog. Its tests are load-bearing now, not defensive.
- The surface placeholder does the teaching: *"Start typing — the first line becomes the note's name."*
  The editor has no placeholder today; this is new and belongs to `NoteEditor`'s `EditorContent`.

**The Tiptap chunk rule survives and gets stronger.** `NoteEditor` stays behind `React.lazy` and is
now reachable only from a dialog, so a band that is merely read still loads none of the 141.5 kB.

## 3. `Edit` opens that same dialog

`NoteEditForm` — the in-row editor with its own title field — is **deleted**. Edit opens the §2
dialog seeded with the note's body, titled with `noteTitle(note)`, footer `Save`.

`NotesBand`'s three single-tenant states (`editing` / `confirming` / `picking`, and the `only()`
helper that keeps them exclusive) collapse to one nullable union — the layer this band has open —
which is `Panel`'s shape one file over in `panels.ts`. Three flags that must never be two at once
become one value that structurally cannot be.

`NoteFocus` and the `focus` prop survive **in a changed job**: an `add` request from the card menu
opens the dialog rather than an in-row editor, so the `edit: true` arm no longer sets `editing` —
it opens the dialog. `NoteRow`'s `scrollIntoView` landing-pad effect stays for `open` requests.

## 4. `Cards` becomes a picker dialog

`NoteCards` — the `max-h-40` scroller of text rows inside the note — is **deleted**. `Cards` opens a
dialog built on `PullFromCollectionDialog`'s grammar, because this app already knows how to pick
cards in a dialog and a fourth spelling of it would be a fourth thing to keep in step.

- **Panel** `size="w-[47.5rem]"`. Header: the note's name, subtitle *"Which cards this note is about"*.
- **Controls band** (`border-b border-border px-5 py-3.5`): a full-width `type="search"` with
  `FILTER_FIELD`'s recipe and the existing placeholder *"Find a card in this deck…"*, then a
  `role="radiogroup"` of chips carrying counts — `All 34` · `Named 2` · then one per pile
  (`Lands 37`, `Creatures 28`) — with `N named` at `ml-auto` in mono.
- **Rows**, `PullFromCollectionDialog`'s exactly: `li` `rounded-md px-2 py-2 hover:bg-surface`;
  `size-4 accent-accent` checkbox with a per-card `aria-label`; the 44×32
  `shrink-0 overflow-hidden rounded bg-surface` art frame; a `min-w-0 flex-1 flex-col gap-1` column
  with the name at `text-sm` over a `text-[0.7rem] text-dim` line carrying `font-mono` `SET · number`
  and the pile it sits in; copies right-aligned in `font-mono text-xs tabular-nums`.
  A ticked row takes the surface fill so the named ones read at a glance.
- **Footer**: the standing sentence *"A note keeps the cards it names even after they leave the deck
  — cutting a card never takes the note with it."* and one **`Done`**. Ticking calls
  `note_card_attach` / `note_card_detach` immediately, as the row actions do today, so a `Cancel`
  would be a lie.
- **States**: keep the picker's existing four sentences — `attachable.length === 0` →
  *"This deck has no cards to name yet."*, and the no-match line. The `mx-auto max-w-md px-2 py-6
  text-center` empty box is the house shape for both.

The per-pile chips are **new** — `TheoryDiffDialog`'s radiogroup is the recipe, but its rungs are
views, not categories. They are the cheapest way to make a 100-card deck findable without typing;
drop them if the search field alone proves enough.

## 5. Thumbnails — and the one thing here that reaches Rust

The card carries the first three cards a note names as 44×32 art crops, then `+N more`.
**`DeckNoteCard` cannot draw one.** It is `{ oracleId, name }` — a note attaches by oracle id, on
purpose, and there is no printing in the DTO to ask for a picture of.

So `attachments_by_note` in `src-tauri/src/deck_notes.rs` gains a representative printing, preferring
one **this deck holds** and falling back to any printing the corpus has:

```sql
SELECT nc.note_id,
       nc.oracle_id,
       coalesce(min(c.name), nc.oracle_id),
       coalesce(min(CASE WHEN dc.card_id IS NOT NULL THEN c.id END), min(c.id))
  FROM deck_note_cards nc
  JOIN deck_notes n   ON n.id = nc.note_id
  LEFT JOIN cards c   ON c.oracle_id = nc.oracle_id
  LEFT JOIN deck_cards dc ON dc.card_id = c.id AND dc.deck_id = n.deck_id
 WHERE {filter}
 GROUP BY nc.note_id, nc.oracle_id
 ORDER BY nc.note_id, coalesce(min(c.name), nc.oracle_id), nc.oracle_id
```

- The `GROUP BY` already collapses the printing multiplication the existing doc comment warns about;
  the new `LEFT JOIN` multiplies within the same group and changes no row count.
- `DeckNoteCard` gains `cardId: string | null` (and the web build's `imageUris` art url, the way the
  picker rows carry it). `null` is the orphan case the `name` fallback already covers — draw the
  empty `bg-surface` frame, never a broken image.
- `CardNote` asks the opposite question and carries no attachments, so it is untouched.
- **No migration.** `deck_note_cards` is unchanged, so the fifteen synced tables, the grain index and
  `deck_undo`'s attachment snapshot are all untouched. This is a read widening and nothing else.

Draw it with `CardImage` at `h-8 w-11`, the `art` crop, `loading="lazy"`, `aria-hidden` on the frame
and the card's name as the button's accessible name. Each thumbnail is its own control (it goes to
that card); `+N more` opens §4's dialog.

## Files this touches

| File | What |
| --- | --- |
| `src/features/decks/DeckNotesPanel.tsx` | the grid, the header button, the dialog union; `NoteEditForm`, `NoteCards` and the add row deleted |
| `src/features/decks/NoteEditor.tsx` | a placeholder on the empty surface; otherwise unchanged |
| `src/features/decks/deckNotes.ts` | `noteTitle` unchanged — but promoted to the primary path |
| `src/features/decks/useDeckNotes.ts` | unchanged: the same five writes |
| `src-tauri/src/deck_notes.rs` | §5's SELECT |
| `src/lib/ipc.ts` | `DeckNoteCard.cardId` |
| `DeckNotesPanel.test.tsx` · `.stories.tsx` | every assertion that names the add row, the in-row editor or the old picker |
| `deckCardMenu.tsx` → `DeckEditor.tsx` | the `add` request now opens a dialog — see the open question below |

## What does not change

The `<section>` that is deliberately not an `<aside>`; `shrink-0`; the band's place below Deck stats;
the disclosure that is a control even at zero notes; `decks.notes_open`; the read that runs while the
band is shut so the header can count; `select-text` on the body; `parseNoteBody` and the pinned
dialect, with its round-trip test; the `React.lazy` import of `NoteEditor` and the rule that nothing
may import it eagerly.

## Open questions — decide these before building

1. **Reading a long note.** Three clamped lines is a preview and there is now no way to read the rest
   without opening the editor. Either the card opens the dialog in a read state, or reading *is*
   editing and we accept that.
2. **The empty state.** With the add row gone, "no notes yet" is a sentence plus the header button.
   Not drawn yet.
3. **The card menu's `Add note…`.** Today it creates the row first (titled with the card's name,
   card attached in the same write) and then opens the editor, so the note appears under that card's
   submenu immediately. A dialog wants create-on-Save. Keeping create-first means a cancelled dialog
   leaves an empty note behind; moving to create-on-save loses the immediate submenu entry.
4. **Pile chips in the picker** (§4) — keep or cut.
5. **Three thumbnails, or as many as fit?** Three fits the 280px floor. A one-column band at a narrow
   window has room for five.

## The artboards

`deck-notes-redesign/` holds the canvas sources. They are `.dc.html` — self-contained HTML with a
`<script src="./support.js">` line the canvas supplies and this repo does not:

- `NotesBand.dc.html` — the band. Opens in a browser as-is.
- `NoteEditor.dc.html`, `AttachCards.dc.html` — the two dialogs. Open in a browser, minus the band
  behind them (they mount it with `<dc-import>`, which only the canvas resolves).
- `Main.dc.html` — the whole deck editor at 1440, for context. **Needs the canvas**: its piles are a
  `<sc-for>` over data in the file's own script block, so a browser shows the template rather than
  the deck.

The band is one file mounted by the other three, which is why a change to `NotesBand.dc.html` shows
up everywhere.
