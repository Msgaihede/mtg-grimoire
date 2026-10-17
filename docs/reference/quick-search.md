# The header's quick search

`packages/ui/features/quickSearch/` — shipped for issue #1098 (2026-10-17). The reporter's model
was VS Code's quick open: a field in the middle of the title bar that drops a list of what the
reader can go to, opening on the recent things and filtering as they type.

## Where it is drawn

`TitleBar` grew a `center` slot and became a three-column grid (`1fr auto 1fr`), and `AppShell`
fills the slot with `<QuickSearch />`. The grid is what keeps the field on the **window's** axis:
in the flex row it replaced, a middle item sits midway between the lockup and the status run and
drifts whenever the status line changes length. A `1fr` track never shrinks below its content's
minimum, so at the 1024px window floor a crowded status run pushes the field off-centre before it
could clip a window verb. The panel is drawn inside the title bar and so rides `LAYER.caption`.

Both editions draw it — the light edition's desktop face has the same header band — and each
group is gated on `editionHas`; the Settings group searches `panelsOf(edition.settings)`, so the
light edition never offers the three panels it does not draw.

`Ctrl+K` (catalogue id `quickSearch`) focuses the field from anywhere except under a modal, and
Escape closes the list and hands the caret back to wherever it was. `Ctrl+P` was the other
candidate; in the light edition's browser tab it is Print.

## Sources and order

| Group | Untyped (recent) | Typed |
| --- | --- | --- |
| Decks | the non-archived decks, most recently edited first (`deck_list`'s own order) | decks by name (archived ones too, marked), then deck folders |
| Collection | the newest copy records (`sort: added desc`) | collection folders (every kind: the reader's, the decks' groups, Recently removed), then the cards |
| Wishlist | the newest wishes | wishlist folders (managed ones included), then the wishes |
| All cards | the cards opened last (`recent_cards`) | a "Search all cards for …" row, then `search_cards` with `collapse: true` |
| Settings | — | the Settings page's own `matches()` over title, group and keywords |

The decks and the three folder lists are read under their pages' own query keys and filtered on
the keystroke. The three card searches are debounced (`DEBOUNCE_MS`) and keyed under the
`["collection"]`, `["wishlist"]` and `["quickSearch"]` roots, so a write that invalidates a list
refreshes what the panel shows of it. Nothing is read until the field is first opened.

**The group order is fixed** (`GROUP_ORDER`) and is the issue's rule rather than a ranking: a
Scryfall result is never drawn above a matching collection or wishlist result. Because the
searches answer at different speeds, order alone would still let a corpus row sit where a
collection row is about to arrive; so each search answers with the text it was asked, and the
All cards group is drawn only once the collection and the wishlist have answered that same text
(or failed). The lit row is held by key, not index, so rows arriving above it never move the
reader's selection to another thing.

Inside a group, `rankName` orders name matches (whole name, then prefix, then a word's start,
then anywhere); the backend's searches also match type lines and rules text, and those rows stay,
below the cards actually called what was typed. Collection and wishlist rows are merged to one per
printing per folder, quantities summed.

## Where a result goes

| Result | Action |
| --- | --- |
| Deck | `setActiveView("decks")`, `setOpenDeckId(id)` |
| Deck folder | `showDeckFolder(id)` → `pendingDeckFolder`, read by `DecksPage` (also leaves the flat wall and drops a deck the trip brought back from the park) |
| Collection / wishlist folder | `setActiveView(scope)`, `setPendingFolder({ scope, id })` |
| Collection / wishlist card | `revealCard({ scope, folderId, query })` → `pendingReveal`: the page clears its filters, puts `!name e:set cn:N lang:x` in the box and stands in the folder — the root included, which `pendingFolder` cannot name |
| All cards row | `showTextInSearch(text)` → `pendingSearchText`: `SearchPage` opens on a clean slate at `Any card` with that text (the exact name, `!name`, for a card row), and puts any picked tags down |
| Settings panel | `setActiveView("settings")`, `setPendingSettingsPanel(panel)` |

All three new hand-offs follow `pendingFolder`'s one-shot rule: cleared by `setActiveView`,
written after it by their action, seeded on a page's mount and applied as a render-phase
adjustment on a page already mounted.
