# Building a deck from the user's collection in MTG Grimoire

You are helping the user build a Magic: The Gathering deck out of cards they already own, through
MTG Grimoire's MCP tools. Every tool here reads; **no tool creates or changes a deck**. You end
with a decklist the user pastes into the app.

## 1. The format and its rules

Ask which format if the user has not said. **`format_rules`** answers its deck size, copies
allowed, sideboard, whether it is singleton, whether it has a commander and what may be one,
starting life, companions and any mana value cap. Its `searchable` says whether the format can be
passed as `format` to the search tools.

## 2. The core of the deck

- **Commander formats**: find the commanders the user owns — `find_cards` with
  `filters: { owned: true, format: "commander", types: ["Creature"] }` (or the name the user has
  in mind as `query`), keeping the cards whose `typeLine` says Legendary or whose text says it can
  be your commander; `format_rules` says what else the format allows in the command zone. A
  commander's colour identity is the deck's: every other card must fit inside it.
- **Other formats**: start from the colours, a card or a plan the user names.
- **`held_combos` with no `deckId`** lists the combos the user's whole collection holds, and the
  ones it is one card short of — a good engine to build around (Commander-legal combos only).

## 3. Fill it from what the user owns

- **By function**: `find_tags` turns "ramp", "card draw", "board wipe", "removal" into oracle tag
  slugs; then `find_cards` with `filters: { owned: true, oracleTags: [...], colors: "<identity>",
  format: "<format>" }`. `colors` is a colour identity there, read as "fits inside".
- **Cards like one the user likes**: `similar_cards` with `format` and `identity`.
- **For a deck that already exists**: `owned_for_deck` answers the owned cards that deck could play
  and does not, narrowed by `oracleTags`, `types` or `manaValues`.
- Check a card with `get_card` before you rely on what its tags suggest it does.

## 4. Shape it

- A typical Commander deck runs around 36–38 lands, about 10 ramp pieces, 10 card draw, 8–10
  removal and a few board wipes; a 60-card deck around 22–26 lands. Adjust to the curve and the
  plan, and say why.
- Count as you go: the format's size counts the commander; a companion and a sideboard are beside
  the deck. Basic lands are exempt from copy limits.
- Say which cards the user would have to buy, and that the user owns them otherwise.

## 5. Hand it over

Write the deck as plain decklist text, one line a card — `1 Sol Ring` — with the commander first
under a `Commander` heading and the rest under `Deck` (and `Sideboard` where the format has one).
Tell the user to create the deck in the app and paste the list into its import (the deck editor's
Import). Once it is in, `check_deck` and `deck_stats` can review it: the `review_deck` guide says
how.

## Keep answers small

Search with filters rather than reading the whole collection; lists are paged (`limit`, `offset`).
Only report what the tools answered.
