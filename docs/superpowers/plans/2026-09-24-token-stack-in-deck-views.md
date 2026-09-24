# Tokens & Emblems as a pile in the deck views — plan

Issue [#507](https://github.com/Msgaihede/mtg-grimoire/issues/507). Builds on #388/#397 (the
Tokens & Emblems band). Decisions settled with the repo owner on 2026-09-24:

- **The band stays.** The new pile is an *additional* drawing of the same `useDeckTokens` answer;
  dismissed tokens, `Show dismissed` and `Reset` stay the band's alone.
- **The pill counts distinct tokens** — the number that read `N to bring` — drawn as a bare
  number in a pill, on the band header and on the pile's heading alike.
- **A token in a view behaves like a band tile**: pressing it opens the art picker, it carries the
  quantity stepper, and nothing else. No drag, no deck-card menu, no card modal, not a drop
  target, not in the arrow walk — a token is not a `deck_cards` row, so no deck write may reach it.
- **Off by default, per deck**, set in Deck settings.
- **Never counted** toward the deck's size, any pile total, the ledger, the stats or validation.
  That is structural: the pile is appended in the view layer and never enters `deck.cards` or
  `buildGroups`.
- **"Emblems" is capitalised**: `TOKENS_HEADING` becomes `Tokens & Emblems` everywhere.

## Storage — `decks.token_stack` (user schema v47)

`INTEGER NOT NULL DEFAULT 0`, read as `DeckRow.tokenStack: boolean`, written through
`DeckPatch.tokenStack?: boolean` on the ordinary `deck_update`. Storage only, like `tokens_open`:
no audit row, not an undo op. **Carried by `duplicate_deck`** (it is a setting, unlike the
disclosures). Synced with the rest of the `decks` row, the same way `tokens_open` is. Not on
`DeckInput` — the create dialog does not ask.

## The shared interface (the contract between the fan-out's pieces)

`src/features/decks/views/TokenPile.tsx` exports:

```ts
export interface TokenPile {
  /** What the pile draws, in `deckTokenViews` order — never a dismissed token. */
  tokens: readonly DeckTokenView[];
  setQuantity: (oracleId: string, quantity: number) => void;
  /** Open the one art picker the editor mounts, on this token. */
  pickArt: (oracleId: string) => void;
}
export const TOKEN_PILE_ATTR = "data-token-pile";
```

`src/features/decks/TokenCountPill.tsx` exports `TokenCountPill({ count })` — the pill both the
band and the pile heading draw.

All four views take `tokenPile?: TokenPile`. Absent, or with no tokens, the view is exactly what
it was.

## Per view

- **Stacks**: the **last** pile in the right-hand rail, after the Sideboard, the Maybeboard and
  every switched-off pile. Drawn with the stacked card's own geometry (`stackCardWidth`,
  `stackHeight`, the collapsed advance and the flip-through), heading `Tokens & Emblems` + pill.
  The rail is drawn when the pile is, even for a deck with no railed pile.
- **Grid**: a trailing group after every other group, tiles at the Grid tile width.
- **Text**: a trailing group of lines.
- **Table**: a trailing section after the table's bands.

## Fan-out

| Piece | Owns |
| --- | --- |
| 1 Storage | `src-tauri/**`, `src/lib/ipc.ts`, `src/lib/ipc.test.ts`, `.storybook/fake/**`, every existing TS/story fixture that builds a `DeckRow` **except** the files pieces 2 and 4 own; `docs/reference/decks-storage.md`, `docs/reference/data-and-sync.md` |
| 2 Settings | `DeckSettingsForm.tsx` (+test, +stories), `DeckSettingsDialog.tsx` (+test) |
| 3 Views | `views/TokenPile.tsx` (+test, +stories), `TokenCountPill.tsx`, `views/StackView.tsx`, `GridView.tsx`, `TextView.tsx`, `TableView.tsx`, `views/views.test.tsx`, `CardStack.tsx` (exports only) |
| 4 Band + editor | `DeckTokensPanel.tsx` (+stories), `TokenArtPicker.tsx`, `DeckEditor.tsx`, `DeckEditor.test.tsx`, every `Tokens & emblems` literal outside pieces 1–3 |

Tests run once after fan-in (`npm run verify`), then a live pass in the shipped window.
