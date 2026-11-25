# MCP server: card knowledge (project A of the MCP improvements)

Date: 2026-11-24. Status: approved by the owner, 2026-11-24.

This is the first of five designs for improving the local MCP server
(`apps/desktop/src-tauri/src/mcp/`, reference: `docs/reference/local-mcp-server.md`). It describes
project A in full, and records the whole programme and the decisions already made, so the later
designs start from them.

## 1. Why

The owner's words: "We need to improve agent understanding of cards, decks, combos, and how cards
fit together." Today an agent connected to the server can look a card up by name, read one
printing's oracle text, prices and legalities, and read the reader's collection, wishlist and
decks. It cannot see combos, a card's Scryfall tags (what the card *does*), the tokens or partners
it brings, Scryfall's full record of the card, or the rules of a format, unless it learns the read
graph and writes GraphQL, and even then combos are not there at all. The app already holds almost
all of this data locally. Project A puts it in front of an agent as plain tools.

## 2. The whole programme (decided 2026-11-24)

The owner asked for these additions, in this conversation, in this order of projects:

| Project | What it adds | Depends on |
| --- | --- | --- |
| **A. Card knowledge** (this design) | Combos (for a card, in a deck or the collection, one card away), Scryfall's raw card JSON, related cards (tokens, meld, other parts), oracle tags (a card's tags, cards by function, similar cards), format rules and the game-changer list, the `card_interactions` prompt, a guide tool, structured tool results | nothing |
| **B. Show a search in the app** | A tool that opens the app's Search page with a search text (Scryfall syntax) and the app's filters filled in. The agent asks the user in chat first ("want to see this in the app?") and calls it only on a yes | A's filter schema (§5.4) |
| **C. Scryfall syntax** | Port `packages/ui/features/search/queryLanguage.ts` to Rust; tools take Scryfall syntax; the `scryfall_syntax` prompt; rework the `search_cards` prompt | nothing (A first by choice) |
| **D. Rulings** | Import Scryfall's rulings bulk file as a weekly feed; a rulings tool; rulings added to `card_interactions` | nothing |
| **E. Decks** | Port deck validation, the bracket estimate and deck stats (`packages/ui/features/decks/validation/`, `stats/`) to Rust; deck tools: full deck information, stats, validation, bracket, deck as compact text, collection-aware help (what is missing, which owned cards fit), draw odds; the `review_deck` and `build_from_collection` prompts | C is not needed; E is last by choice |

Decisions that bind every project:

- **The TypeScript logic is ported to Rust, not called through the window.** The TypeScript stays
  where it is for the page; shared golden files hold both versions to the same answers (the
  pattern `packages/ui/features/home/generated/__golden__/widget-state.json` already uses). Reason:
  the planned remote tier (issue #1396 PR 5) has no window, and an agent must not depend on a
  loaded page.
- **No tool writes the reader's collection, wishlist or decks** (the owner's decision of
  2026-10-31 stands). Project B changes what a window shows, which is not a write of data.
- **Every prompt is also reachable by the agent**, through one guide tool (§5.6), because most
  clients run a prompt only when the user picks it. Rules that must always hold go in the
  server's `instructions`.
- **New prompts:** `card_interactions` (A), `scryfall_syntax` (C), `review_deck` and
  `build_from_collection` (E); `search_cards` is reworked in B and C.
- Considered and not chosen: a fixed set of agent questions run against a real client before and
  after (the owner did not pick it).

Each later project gets its own design document when it is reached.

## 3. Goals, non-goals, anti-goals

**Goals (project A):**

1. An agent can ask what combos a card is in, read any combo whole (pieces, steps,
   prerequisites, mana needed, what it produces), and learn which pieces the reader owns.
2. An agent can ask which combos a deck, or the reader's whole collection, holds completely and
   which it is **one card away** from, with the missing card named and whether the reader owns it.
3. An agent can read Scryfall's own record of a printing, the fields it asks for, from the local
   copy.
4. An agent can see what a card brings with it: tokens, emblems, meld partners and other parts.
5. An agent can see what a card does in Scryfall's oracle-tag vocabulary, find cards by function
   ("ramp", "board wipe") with ordinary filters beside, and find cards similar to a given card.
6. An agent can read each format's deck rules and find the Commander game changers.
7. Answers are compact, and every tool's result is also structured data.

**Non-goals (project A):** rulings (D); Scryfall syntax in any tool (C); deck stats, validation or
the bracket estimate (E); opening a search in the app (B); any change to the read graph; the remote
tier; any change to what the page draws. The only TypeScript changes are to the hand-written
mirror: `CardCombo` gains `requires` and `combos_for_card` gains an optional `produces` argument
(§6.2), so `packages/ui/lib/ipc/combos.ts` and the Storybook fake (`packages/fake/`) follow,
because `packages/ui/lib/ipc.test.ts` holds the mirror to the Rust source.

**Anti-goals, which would make this a failure even if it works:**

- An agent told "no combos" when the combo list has simply never been downloaded. Every answer
  that rests on a feed says when that feed is missing.
- Answers large enough to swamp an agent's context: a raw Scryfall object with its image links
  for a hundred cards, or a combo list with full steps for every hit.
- Tool sprawl that makes an agent pick the wrong tool. Project A adds eight tools and widens two,
  and folds what it can into existing tools.
- Any network call from a tool. Everything answers from the local databases; Scryfall's and
  Commander Spellbook's servers are never asked.

## 4. Constraints

- **Every tool is a translation onto `grimoire_core::commands::dispatch`** (`mcp/tools.rs`'s
  rule): no SQL in the MCP module. Where core has no command for a question, core gets one. A new
  command that no page calls goes on `command_table::TABLE_ONLY` in
  `apps/desktop/src-tauri/src/command_table.rs` with its reason (that list exists for exactly
  this; never add a dead desktop wrapper to pass the check).
- **Read-only.** Every new tool is annotated `readOnlyHint: true, openWorldHint: false`.
- **Bounded answers.** The existing `MAX_LIMIT` (200 rows) is the ceiling; each tool below names
  its own default and maximum.
- **Feeds may be missing.** The combo list (Commander Spellbook, weekly) and the oracle tags
  (Scryfall's tagger, weekly) are downloaded on their own schedules and may never have been.
  `combos_status` and `oracle_tags_status` say which.
- **Desktop only**, as the server is.
- Tests that need files use `crate::scratch::path`. Core functions are tested in core; each tool is
  tested in `tools.rs` against a real database on disk, as the existing tools are.
- `pnpm verify` once, at the end.

## 5. Approaches

Three ways were considered for exposing this data:

1. **New tools over core commands** (chosen). Each tool calls a command in core's table, as the
   existing seven simple tools do; core gets the commands it lacks. Agents find the tools in
   `tools/list` and need nothing else to read; answers stay small.
2. **Grow the read graph**, with few new tools. One surface, and home widgets could show combos.
   But an agent must read a large schema and write GraphQL for basic questions, every answer
   costs more tokens, and the graph has no combos today, so this is the larger build.
3. **Both**: each item a tool and a graph field. Serves agents and widgets, at roughly twice the
   work and two copies to keep in step.

The owner chose 1 (2026-11-24): the request is about agent understanding, and tools are what an
agent uses untaught. The new core functions can become graph fields later if a widget wants them.

## 6. The design

### 6.1 Tool list after project A

Existing tools stay. Project A **widens** `find_cards` and `get_card` and **adds** eight:
`card_combos`, `get_combo`, `held_combos`, `card_scryfall`, `find_tags`, `similar_cards`,
`format_rules`, `read_guide`. That is 26 tools.

### 6.2 Combos

What core has today (`crates/grimoire-core/src/combos.rs`):

- `combos_for_card(oracle_id, search, card_count, owned_only, limit, offset)` →
  `CardCombosPage`: each `CardCombo` carries `id`, `bracket_tag` (one letter of
  `R|S|P|O|C|E|B`), `card_count`, `template_count`, `identity`, `produces` (newline-joined),
  `description` (the numbered steps, newline-joined), `easy_prerequisites`,
  `notable_prerequisites`, `mana_needed`, `popularity`, and `pieces` (each with `oracle_id`,
  `name`, `quantity`, `must_be_commander`, `card_id`, `owned`).
- `combos_for_cards(card_ids)` → `Vec<DeckCombo>`: combos whose named cards are **all** in the
  given printings, ordered fully checkable first, then by popularity. `DeckCombo` is the short
  shape (names only, no steps).
- `combos_status` → `ComboStatus`, including when the list was last fetched.

**The combo list is Commander's.** The ingest keeps only variants Spellbook marks
Commander-legal (`reduce`, `combos.rs:396`). So a combo that needs a card banned in Commander is
not in the list at all. Every combo tool's description and the `card_interactions` prompt say so,
and `held_combos` on a deck whose format is not `commander` adds a `note` saying the list covers
Commander-legal combos only, so "none found" there is not "none exist".

What core does not have, and project A adds:

- **`combo_get(id)`**: one combo whole, the `CardCombo` shape. A read command.
- **`combos_near(card_ids, format, identity, limit, offset)`**: combos whose named cards are all
  in the given printings **but one** (`have = card_count - 1`, `card_count >= 2`), each with the
  missing piece: its name, its `card_id` (the same printing tie-break `ComboPiece.card_id` uses)
  and how many the reader owns. Same ordering as `combos_for_cards`. Built from `MATCH_SQL`'s
  shape: start from the given cards' oracle ids and the `idx_combo_cards_oracle` index, never a
  scan of every combo. **A combo is offered only if the deck could play the missing card**: with
  `format`, the missing card must be legal in it (`cards.legal_mask`); with `identity`, it must fit
  inside that colour identity. A combo whose missing card no local `cards` row resolves is left
  out, since nothing can be said about it.
- **`combos_in_collection(near, format, identity, limit, offset)`**: the same two questions over
  every card the reader owns (any printing, any finish, any folder: the same count
  `ComboPiece.owned` reads), with the same two optional filters on the missing piece. Answers the
  short shape plus, for `near`, the missing piece.
- **A `produces` filter on `combos_for_card`**: an optional argument matching words in what a
  combo produces ("infinite mana"), beside today's `search`, which matches a substring of piece
  names only (`SEL_CTE`, `combos.rs:1680`). The page's mirror gains the optional argument and
  sends nothing, so the deck page's combo dialog finds exactly what it finds today.
- **The template text** (my call, see §8): today the combo table stores only how many
  `requires[]` templates a combo needs (`template_count`), not what they say ("a creature with
  flying"). An agent told "this combo also needs 2 unnamed cards" cannot use it. Project A adds a
  `requires` column (newline-joined template text) to `combos` and its staging table, in a new
  corpus schema rung, and fills it in the ingest. `CardCombo` gains `requires`. **The rung follows
  corpus schema 2's precedent**: it drops and rebuilds the three combo tables
  (`rebuild_combo_tables`, `schema.rs:897`), which also removes `combo_meta`, so the refresh is due
  at the next launch (`due_at_launch`). Clearing only the ETag would not do: a refresh is due only
  once `checked_at` is a week old, so the new column would sit empty for up to seven days. Between
  the rung and the refresh the combo tables are empty, so every combo tool answers
  `comboData: { downloadedAt: null }` with its `note`, never a combo with blank template text.

The tools:

| Tool | Arguments | Calls | Answers |
| --- | --- | --- | --- |
| `card_combos` | `cardId` (required), `search` (a piece's name, or part of it), `produces` (words in what the combo produces), `cardCount`, `ownedOnly`, `limit` (default 10, max 50), `offset` | `card_detail` for the oracle id, then `combos_for_card` | Combos in the **short shape** below, `total`, the size buckets, and `comboData` |
| `get_combo` | `comboId` (required) | `combo_get` | One combo in the **full shape** |
| `held_combos` | `deckId` (omit for the whole collection), `list` (`live` default, or `theory`), `oneCardAway` (default `true`), `format` and `identity` (collection only: what the missing card must fit), `limit` (default 20, max 100), `offset` | `deck_get` and `deck_commander_identities`, then `combos_for_cards` and `combos_near`; or `combos_in_collection` | `complete` and `oneCardAway` lists in the short shape (the latter with `missing`), `comboData`, and a `note` where one applies |

A deck's cards are the printings in its **active piles only**, deduplicated: the rule the deck
page's own combo check uses (`useBracketReading` in `packages/ui/features/decks/DeckBracket.tsx`
filters on `categoryActive`), so a switched-off Maybeboard is not the deck. Quantities do not
matter. For a deck, `combos_near`'s filters come from the deck itself: `format` is the deck's
format when that format has legality data, and `identity` is the commanders' colour identity
when the deck has commanders (`deck_commander_identities`, which core answers today, per list).
No deck validation is needed for either, so this does not wait for project E.

**The short shape** (list answers): `comboId`, `cards` (names), `produces` (a list),
`bracketTag` (the word: Ruthless, Spicy, Powerful, Oddball, Core, Exhibition, Banned; an unknown
letter is passed through as itself), `templatesNeeded` (count), `popularity`, and for one-away
`missing: { name, cardId, owned }`.

**The full shape** (`get_combo`): the short shape plus `identity`, `pieces` (name, cardId,
quantity, mustBeCommander, owned), `requires` (the template text, a list), `steps` (a list),
`prerequisites: { easy, notable }` (lists), `manaNeeded`, and `url`, the combo's page on Commander
Spellbook (`https://commanderspellbook.com/combo/{id}/`) so the agent can hand the reader a link.

**`comboData`** on every combo answer: `{ downloadedAt }` (Unix seconds, or `null`). When it is
`null` the answer also carries `note`: one sentence saying the combo list has not been downloaded
yet, that the app fetches it weekly, and where in the app to fetch it now. An empty list with a
`null` `downloadedAt` is never presented as "no combos".

**Performance budget:** `held_combos` over a 100-card deck and over the owner's real collection
answers in under one second on the real corpus. Measure on a copy of the real dev database
(`docs/agent/RUNNING_AND_VERIFYING.md` names its path), not only on fixtures.

### 6.3 Raw Scryfall JSON

Every printing's whole Scryfall card object, as it came in the `default_cards` bulk file, is stored
gzipped in `cards.raw` (`card_row::gzip_raw`); `card_row::raw_json` inflates it.

- New core read command **`card_raw(ids)`**: for each id, the inflated JSON (or nothing for an id
  the corpus lacks). At most 20 ids.
- Tool **`card_scryfall`**: `cardIds` (1–20, required), `fields` (optional list of top-level
  Scryfall field names). With `fields`, it answers only those fields; without, every field except
  the image and shop links: `image_uris`, `card_faces[].image_uris`, `purchase_uris`,
  `related_uris`. An id the corpus lacks is named in a `missing` list rather than failing the call.
  The tool description says the object is Scryfall's own format and that `prices` there are as of
  the last card sync, not the app's marketplace prices (which `get_card` answers).

### 6.4 `find_cards` and `get_card`, widened

**`find_cards` gains the app's filters**, beside its existing `query` (name words), `set`,
`allPrintings` and `limit`. `query` becomes optional when any filter is given. The filters are one
object, `filters`, whose fields mirror the Search page's filter bar (`FilterState` in
`packages/ui/features/search/useCardSearch.ts`), so project B can reuse the same schema for
opening a search in the app:

| Field | Meaning | Maps to `SearchRequest` |
| --- | --- | --- |
| `format` | a format key that has legality data: one of the 23 `LEGALITY_KEYS` (`legalities.rs:31`), which `format_rules` marks `searchable` | `format` |
| `colors`, `colorsExact` | colour letters `WUBRG`, and whether exactly those | `colors`, `colors_strict` |
| `types` | card types (the filter bar's list, `CARD_TYPES`) | `types` |
| `rarities` | `common`, `uncommon`, `rare`, `mythic`, `special`, `bonus` | `rarities` |
| `sets` | set codes | `sets` |
| `manaValues`, `manaX` | mana values (8 means 8 or more), and cards with `{X}` | `mana_values`, `mana_x` |
| `owned` | `true` only owned, `false` only not owned | `owned` |
| `priceMin`, `priceMax` | in the reader's marketplace currency | `price_min`, `price_max` |
| `oracleTags` | oracle tag slugs, all of which a card must hold (from `find_tags`) | `oracle_tags` |
| `gameChanger` | `true`: only Commander game changers | a `QueryPredicate` for `is:gamechanger` |

Borders, finishes and Universes Beyond/Within are left out of `find_cards` (they describe a
printing's look, not what the card does); project B adds them to the shared schema for the Search
page. Every value is checked before the search runs; a value that is not in its field's vocabulary
is refused with a sentence naming the field and the allowed words. A format key without legality
data (`casual`, `limited`, `unspecified`) is refused the same way, since the search's format
filter would silently match nothing for it (`filters.rs:708`). An oracle tag slug that does not
resolve is refused, naming `find_tags`, because the page's rule is that an unresolved tag fails
closed rather than matching nothing quietly.

**Names follow the page where the page has the field**: `format`, `colors`, `types`,
`rarities`, `sets`, `manaValues`, `manaX`, `owned`, `priceMin` and `priceMax` are `FilterState`'s
own names (`useCardSearch.ts:318`). Three are this schema's own: `colorsExact` is the page's
`ColorFilter.strict` (a separate piece of state there, not a `FilterState` field), and the page
takes `oracleTags` through its tag selection (`tagTerms`) and `gameChanger` only as
`is:gamechanger` in the box. How project B carries those three onto the page is B's design.

**`get_card` gains three fields** in its answer, from existing or new core commands:

- `tags`: the card's oracle tags, direct taggings only (not their ancestors), each `{ slug, label }`,
  from a new core read command over `oracle_taggings` joined to `oracle_tags` (on `TABLE_ONLY`).
  The existing `oracle_tags_for_printings` will not do: it reads the `oracle_tag_cards` closure,
  so it answers every ancestor too, and as bare slugs with no labels (`tags/oracle.rs:162`). With
  `tagData: { downloadedAt }` and a `note` when the tag feed is missing, as for combos.
- `related`: what the card brings or belongs with, from a new core read command
  **`card_related(id)`** that walks `all_parts` the way `card::meld_parts` and `deck_tokens` already
  do (inflate, parse, resolve each id in `cards`). **The card itself is excluded by oracle id, not
  by name**: a name test would also drop the Embalm and Eternalize tokens, which wear the card's own
  name (154 entries across 55 cards; `deck_tokens.rs:534` measures and explains it). Each entry is
  `{ relation, name, cardId, typeLine }`, with `relation` one of `token`, `emblem`, `meldPart`,
  `meldResult` or `comboPiece` (Scryfall's `component`, with emblems told apart by layout as
  `deck_tokens` does). The helper markers `deck_tokens` recognises from rules text (the Monarch,
  the Ring, the Initiative) are included as `relation: "helper"` with no `cardId`.
- `comboCount`: how many combos name the card (the `total` of `combos_for_card` with `limit` 0, or
  a dedicated count if that is cheaper).

### 6.5 Oracle tags

- **`find_tags`**: `text` (required), `limit` (default 10, max 50). Calls `tag_search` with the
  `oracle` namespace. Answers `{ slug, label, cardCount }` per tag, plus `tagData`. This is how an
  agent turns "ramp" or "card draw" into slugs for `find_cards`' `oracleTags`.
- **`similar_cards`**: `cardId` (required), `format`, `identity` (colour letters: only cards that
  fit inside this colour identity), `limit` (default 10, max 50). New core read command
  **`cards_similar(oracle_id, format, identity, limit)`**:
  - Candidates are cards sharing at least one **direct** tagging (`oracle_taggings`) with the
    given card; the card itself is excluded.
  - Score is the sum, over shared tags, of the tag's inverse frequency, `ln(N / df)`, where `N` is
    the number of tagged cards and `df` the number of cards with that tag. A tag held by
    thousands of cards counts for little, a rare one for a lot.
  - `format` keeps only cards legal in it (a key without legality data is refused, as in
    `find_cards`); `identity` only cards whose colour identity fits inside it (Scryfall's `id<=`
    meaning).
  - Each answer row: `name`, `cardId` (the printing tie-break used elsewhere), `typeLine`,
    `manaCost`, `score`, and `sharedTags` (the three highest-weighted shared tags' labels).
  - Ties broken by name, so two runs answer in one order.

### 6.6 Format rules and game changers

- **`format_rules`**: `format` (optional key). Calls `format_specs_list`. Answers each format's
  `key`, `name`, `deckMin`, `deckMax`, `maxCopies`, `sideboardMax`, `singleton`,
  `requiresCommander`, `commanderRule`, `life`, `allowsCompanion`, `maxManaValue`,
  `restrictedMeaning`, `validates` (whether the app checks decks in it) and `searchable` (whether
  it has legality data, so `find_cards` and `similar_cards` accept it as `format`). With `format`,
  that one; without, every format the picker offers.
- **Game changers** are `find_cards` with `filters: { gameChanger: true }` (and usually
  `format: "commander"`); no tool of their own.

### 6.7 Structured results

Every tool, old and new, returns its answer as MCP `structuredContent` as well as the JSON text it
returns today, which stays for clients on older revisions. `structuredContent` must be an object,
so any tool that answers a bare array today answers `{ <name>: [...] }` instead (the text block
carries the same object). No `outputSchema` in project A. This is a change in `mcp/rpc.rs`'s
`tools/call` arm and in any tool whose answer is not already an object.

### 6.8 The guide tool and the `card_interactions` prompt

- **`read_guide`**: `topic` (required, an enum of the prompt names: today `search_cards`,
  `create_widget`, `graphql_discovery`, `card_interactions`). Answers the same Markdown
  `prompts/get` answers for that prompt with no argument. Every prompt added later joins the enum;
  a test holds the enum to `prompts::list()`.
- **`card_interactions`** prompt: a new `mcp/prompts/card_interactions.md`, compiled in like the
  others, with one optional argument, `question`. It teaches:
  - which tool answers which question: what a card does (`get_card`: oracle text, tags, related),
    combos (`card_combos`, `get_combo`, `held_combos`), cards by function (`find_tags` then
    `find_cards` with `oracleTags`), similar cards (`similar_cards`), edge facts such as layout,
    faces, keywords and produced mana (`card_scryfall` with `fields`), and format rules
    (`format_rules`);
  - to say so when a feed is missing rather than concluding "none";
  - that combos are Commander Spellbook's and tags are Scryfall's community tagger's, not rules
    text, and that the app has no rulings yet (project D adds them and updates this prompt);
  - to keep answers small: short shapes first, `get_combo` and `card_scryfall` for the one
    thing that needs detail.
- **Server `instructions`** (`mcp/rpc.rs`'s `INSTRUCTIONS`) gain one or two sentences naming the
  combo, tag and raw tools and `read_guide`, and keep the existing rules.

### 6.9 Documentation

- `docs/reference/local-mcp-server.md`: the tool table gains the eight tools and the two widenings;
  the prompts table gains `card_interactions`; §6 ("What is not done") is rewritten, since it is
  out of date today (it says there are no prompts, and that widgets cannot be changed or deleted).
- `apps/desktop/src-tauri/CLAUDE.md`'s MCP bullet: mention that combos, tags and raw card data are
  read through core commands, and the guide tool.
- The corpus rung for `combos.requires` follows the schema docs' own rules (`data-and-sync.md`).

## 7. Testing

- Core: `combo_get`, `combos_near`, `combos_in_collection`, `card_raw`, `card_related`,
  `cards_similar` each have unit tests over a scratch database, including the empty-feed case and
  ordering.
- The corpus rung: migrating a database that holds combos leaves a `requires` column, and the next
  refresh re-ingests (the ETag is cleared). Prove it on a copy of the real dev database too.
- MCP: every new tool and both widenings are tested in `tools.rs` against a real database on disk,
  including every refusal sentence (unknown filter value, unresolved tag, missing card, a deck id
  that does not exist) and the `note` when a feed is missing.
- `structuredContent` is present and an object on every tool's answer (one test over `tools::list()`
  calling each tool with valid arguments, or asserting it at the `rpc` layer).
- `read_guide`'s enum equals the prompt list; `card_interactions` is listed by `prompts/list`.
- `command_table::` tests pass with the new `TABLE_ONLY` entries.

## 8. Calls made in this design that the owner did not make

These are proposals; each can be overruled:

1. Store the combo template text (`requires`), which needs a corpus schema rung and a re-ingest.
2. Fold tags, related cards and a combo count into `get_card` rather than adding tools for them.
3. Game changers and cards by function go through `find_cards`' filters rather than tools of their
   own; borders, finishes and Universes Beyond are left out of `find_cards`.
4. Similar cards are ranked by inverse tag frequency over direct taggings.
5. `held_combos` covers both a deck and the whole collection (moving "combos you can build from what
   you own" from project E into A).
6. One `read_guide` tool rather than one tool per prompt.
7. `structuredContent` for every tool, without `outputSchema`.
8. "One card away" offers a combo only when the deck could play the missing card: legal in the
   deck's format, inside its commanders' colour identity.
9. Non-Commander decks get combo answers with a note that the list covers Commander-legal combos
   only, rather than a refusal.
10. `card_combos` keeps the page's piece-name search and gains a separate `produces` filter; the
    page's combo dialog is unchanged.
11. The `requires` rung rebuilds the combo tables (corpus schema 2's precedent), so combos are
    absent until the next launch's refresh, and the tools say so meanwhile.

## 9. Left to the builder

- Exact Rust names of the new core functions, their structs, and where in `combos.rs`, `card.rs` and
  `tags/` they live.
- Whether `comboCount` is a dedicated count query or `combos_for_card`'s total.
- The order of work inside the project, and how it is split into commits.
- Wording of descriptions, refusal sentences and the prompt, within the rules above.
