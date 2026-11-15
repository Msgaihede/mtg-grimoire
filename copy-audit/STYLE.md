# UI copy style

The rules behind the audit's suggestions, for any wording call the sheet doesn't settle.

## Length

- Buttons and menu items: 1–3 words, verb first ("Add to deck", "Rename…").
- Headings and dialog titles: up to 5 words, no full stop. A confirm dialog's title is a question
  ("Clear local cache?").
- Hints, descriptions and empty states: one sentence, ideally under 12 words. Two at most.
- Tooltips: a few words, never the visible label again.
- Screen-reader labels: a name for the control, not a sentence ("Remove filter: ${label}",
  "Filters, 3 active").

## Patterns

- Errors: `Couldn't <verb> <thing> — ${ipcError(e)}`, with no full stop after the detail. Never
  "Could not", "Unable to" or "Failed to".
- Toasts: verb first, past tense, no full stop ("Created deck “${name}”").
- Empty states: "No X yet." With a search, "No X matches “${query}”."
- Disabled menu-item reasons: lowercase fragments ("already first").
- Retry buttons: "Try again".
- `…` on a control that opens a dialog or file picker, and in progress text ("Saving…").

## Voice

Plain, calm, direct. Second person ("your collection", never "the collection"). Sentence case.
US spelling (color, catalog, labeled). Contractions (can't, isn't). No filler (just, simply,
please, note that). No exclamation marks, emoji or cheer. No em-dash asides: use a full stop or a
colon. The only dash is the one before an error detail.

Banned: seamless, effortless, powerful, unlock, elevate, dive in, delve, journey, robust, leverage,
streamline, empower.

## Words

- **Card data**, not "card database" or "corpus". Card data **updates**; **sync** means your
  devices only.
- **Neural scanner**, not "card recognizer".
- **Category** in the deck editor, not "stack".
- Never swap tag, label, keyword, note or rule: see
  [`docs/agent/DOMAIN_VOCABULARY.md`](../docs/agent/DOMAIN_VOCABULARY.md).
- Keep Magic terms exact (mana value, color identity, command zone, library, graveyard, Game
  Changer), along with product names and page names.

## Typography

Curly quotes around names (“${name}”). Straight apostrophes, as the code mostly has them. `×` for
quantities, ` · ` as a separator, `›` in paths ("Settings › Sync").
