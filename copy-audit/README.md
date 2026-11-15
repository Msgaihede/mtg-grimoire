# Copy audit

`copy-audit.xlsx` lists the app's UI copy, one row per string: 6,813 strings, audited on
2026-11-11. The rewrite shipped on branch `claude/app-copy-audit-29841f` on 2026-11-15, and 838 of
the strings changed.

| Column | What it holds |
| --- | --- |
| ID | Stable row ID (`C0001`…). |
| Where | Where the text shows: `Decks > Deck editor > Add label dialog`. |
| Type | Heading, button, toast, error, screen-reader label, and so on. |
| Existing text | The text before the audit. |
| New suggestion | The text in the code now (yellow where it changed). |
| Changed | Formula: says `changed` when E differs from D. |
| Note | Why the shipped text differs from the suggestion, or a heads-up from the audit. |
| Component, Source | The component, and the `file:line` the text lives in now. |

## What changed from the suggestions while shipping

- **Kept word for word**: four sentences that must equal the Rust backend's, because a test pins
  each one (the scanner's two refusals, the scan-sound tier rule, the share-link refusal).
- **Kept for accessibility or a documented reason**: the deck tile's rename pencil, the wishlist's
  Move to folder name, and Sync's Leave the group confirm button.
- **Facts put back**: in a few Sync, web-storage and deck sentences, where a test says the reader
  must be told something.
- **Made consistent**: the scanner's finish caption, the import file error, the Recently removed
  sentence and the filter chips' names. "Art Mismatch" became "Art mismatch" beside its siblings.
- **Outside the sheet**: the relay's pairing page now says "choose Enter a code", to match the
  renamed button.

## Editing again

Change column E, then give an agent this file. To turn the sheet into JSON:

```bash
python copy-audit/copy_audit_to_json.py copy-audit/copy-audit.xlsx --changed -o changes.json
```

Each row has `id, where, type, existing, new, note, component, file, line`. Before applying a row,
compare it with the current code: column E is the shipped text, so diff your edit against E, not D.
Keep every `${…}` and `{…}` exactly as written, because they are code. A placeholder ending in `…`
was shortened for the sheet. Tests and stories assert copy, so search for the old string. Wording
calls go by [`STYLE.md`](STYLE.md).

## What the audit covers

The TypeScript UI in `packages/ui`, `apps/light`, `apps/desktop/src` and `apps/share`. That means
JSX text, copy props (`title`, `label`, `placeholder`, `aria-label`…), toasts, errors and the text
helpers in `.ts` files.

It leaves out error sentences written in Rust (the backend's half of "Couldn't … — reason"), the
privacy page, the PWA manifest, HTML `<title>`s, Scryfall card data, search keywords, CSV column
headers, and test and Storybook text.
