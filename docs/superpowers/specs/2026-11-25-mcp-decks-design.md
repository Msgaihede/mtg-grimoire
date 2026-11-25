# MCP server: decks (project E of the MCP improvements)

Date: 2026-11-25. Status: approved by the owner, 2026-11-25 — two pull requests, E2 stacked on E1
(§5); `get_deck` widened and five tools added (§6.3); an explicit golden corpus with a coverage fence
(§4, §6.2); every call in §8 as written.

Project E of the programme recorded in
[2026-11-24-mcp-card-knowledge-design.md](2026-11-24-mcp-card-knowledge-design.md) §2. It starts
from that document's binding decisions and does not restate them beyond what this design leans on:
the TypeScript a tool needs is **ported to Rust and held to the TypeScript by shared golden files**
(the page keeps its TypeScript and nothing on the page changes); **no tool writes the reader's
cards, decks or wishlists** — a review suggests, the reader edits in the app; every prompt is also
reachable through `read_guide`.

Project A merged as Msgaihede/mtg-grimoire#1728, so this project's pull requests are based on
`main`.

## 1. Why

An agent can list the reader's decks and read one pile by pile (`get_deck`), and since project A it
can ask which combos a deck holds. It cannot ask the questions a deck review is made of: is this
deck legal in its format, and if not, why; what Commander bracket do its cards suggest; what does
its mana curve look like, how many lands, which colours does it ask for and which can its mana pay;
what is it short of, what would that cost, and does the reader own those cards somewhere else; which
cards the reader already owns would fit it; how likely is it to find a land, or a particular card,
by turn three. The app answers all of these on the deck page — in TypeScript, in the window. An
agent must not depend on a loaded page (the future remote tier has none), so the answers move into
the core, and the tools read them there.

## 2. Goals, non-goals, anti-goals

**Goals:**

1. The core answers deck validation, the Commander bracket estimate and deck statistics **exactly as
   the page does** for the same deck, held there by goldens both suites read.
2. An agent can read a deck whole: its kind, format, commanders and companion, colour identity,
   settings and counts, and its cards — as piles, or as compact decklist text.
3. An agent can read a deck's statistics: mana curve (with the creature split), card types and
   subtypes, colour demand against mana sources, average mana value, price, owned and missing.
4. An agent can read what is wrong with a deck (every finding the page's validation panel lists,
   and what is wrong with the cards parked in switched-off piles), and its bracket floor with the
   reasons and the cards behind each.
5. An agent can help from the collection: what a deck is short of, what that costs, and where the
   reader already owns copies; which owned cards fit a deck (format, colour identity, not already
   in it).
6. An agent can answer draw odds: the chance of drawing at least / exactly / at most N of some
   cards in the opening hand and by each turn, on the play or the draw.
7. Two prompts, `review_deck` and `build_from_collection`, teach the work, and `read_guide`
   answers both.

**Non-goals:** any change to what the page draws or decides (the TypeScript stays, untouched but
for a golden suite); writing a deck; mulligan arithmetic; a server-side "deck score" or AI-chosen
upgrades (the agent reasons; the tools supply facts); rulings (D) and Scryfall syntax (C); moving the
export writers (`apps/desktop/src-tauri/src/transfer/`) into the core — the MCP is desktop-only and
reads them where they are, and the remote tier will move them when it needs them; the gallery's
bracket read (`deck_bracket_reads`) and every other page read, which stay as they are.

**Anti-goals — this fails if:**

- The Rust and the page answer differently for one deck: a deck the panel calls legal that an agent
  is told is not, or a bracket floor of 3 on the page and 4 in a tool.
- An agent is told a deck has "no problems" when its format is not checked (`unspecified`, or a key
  the seed no longer carries). Such an answer says **not checked**, as the panel does.
- The bracket is presented as the deck's bracket rather than a floor, or a combo list that was
  never downloaded reads as "no combos".
- A switched-off pile (a Maybeboard) is counted as part of the deck anywhere.
- Answers that swamp a context: a 100-card deck's every fact per card, or every owned card at once.
- A tool that changes a deck, or a tool or prompt wording that says it did.

## 3. Constraints

- **No SQL in the MCP module**: every tool is a translation onto `grimoire_core::commands::dispatch`.
  Where the core has no command for a question, it gets one, on `command_table::TABLE_ONLY` with its
  reason (no page calls it).
- **The core's fences hold** (`crates/grimoire-core/CLAUDE.md` §2): no new platform cfg, clock or
  I/O; the crate still builds for `wasm32-unknown-unknown` and Android.
- **No new dependency.** The core has no `regex` and does not gain one for this: the TypeScript's
  twenty or so regular expressions have no lookaround and no backreference, each is simple enough to
  write as a string matcher, and the goldens are what prove each matcher equal to its expression
  (JavaScript's `\s` is Unicode whitespace and its `\b` an ASCII word boundary; the matchers say
  which they mean).
- Multi-line Rust strings are built with `concat!`. Tests needing files use `crate::scratch::path`.
- Projects C and D edit `mcp/tools.rs`, `mcp/prompts.rs`, `mcp/rpc.rs`, `command_table.rs` and
  `docs/reference/local-mcp-server.md` in parallel: changes there stay tight and additive.
- `pnpm verify` once, at the end of each pull request. This session runs on Linux and cannot drive
  the Windows app's WebView2: the live pass is owed on the owner's machine, and each PR says so.

## 4. Approaches considered

**For the port:**

1. **Port onto the core's own row types** (chosen). The TypeScript engine reads `DeckCard` and
   `FormatSpec`, which are hand-written mirrors of `deck::DeckCardRow` and `deck::FormatSpecRow`.
   The Rust port reads those two structs directly, so a core command is `deck::get` → the port, with
   no conversion and no second card type.
2. Port onto a narrow `CardFacts` struct of the fields the engine reads. Cleaner in isolation, but
   a third shape of one card to keep in step, and every caller converts.
3. Run the TypeScript in an embedded JavaScript engine. Rejected: a new heavy dependency, no WASM
   story, and the decision of 2026-11-24 is a port.

**For the goldens:**

1. **An explicit scenario corpus, written by TypeScript** (chosen). A new TypeScript suite builds
   named cases with the validation suites' own fixture builders (`validation/fixtures.ts`), runs the
   TypeScript functions over them and holds the committed golden files to what they answer; the Rust
   suites read the same files and must answer the same. A **coverage fence** on both sides fails
   when a case is missing for any issue code in `types.ts`' vocabulary, any `commanderRule`, any
   companion in `COMPANIONS`, any bracket reason code, any format in `fixtures.SPECS`.
2. Record every call the existing ~430 TypeScript tests make, as goldens. Maximum coverage for free,
   but it needs a filesystem in the webview suite (no `@types/node` there) and module interception,
   and a golden that changes whenever any test is reworded.
3. Hand-written expected answers (the `widget-state.json` pattern). Fine for six cases; not for
   several hundred.

**For the tools:**

1. **Widen `get_deck`, add five tools** (chosen, §6.3): one tool per question an agent asks, each
   answer small.
2. One `deck_report` tool answering everything at once. Fewest tools, but every review pays for
   every section, and the answer is the size of the page.
3. A tool per page panel (curve, pips, types, odds, validation, bracket, price…). Precise, and the
   sprawl project A's anti-goals warn about.

## 5. The split: two pull requests

The design is two pieces of work with a clean seam, and the seam is also where projects C and D's
files begin. **Proposed: two pull requests**, the second stacked on the first:

| PR | Contents | Touches the MCP files? |
| --- | --- | --- |
| **E1. The port** | `crates/grimoire-core`'s deck rules and deck stats (§6.1), the goldens and the TypeScript suite that writes them (§6.2), two core read commands (`deck_check`, `deck_stats`) on `TABLE_ONLY`, their tests, the reference docs | `command_table.rs` only (two `TABLE_ONLY` rows) |
| **E2. The tools** | Two more core commands (`deck_owned_fits`, `deck_draw_odds`), the `get_deck` widening and five tools (§6.3), the two prompts and their `read_guide` topics (§6.4), the server's `instructions`, `local-mcp-server.md` | yes |

E1 lands without touching what C and D are editing, and is reviewable as a port: every line is held
to a golden. E2 is then a translation layer of the kind project A was.

## 6. The design

### 6.1 The port (E1)

Two new core modules. Names are proposals (§10):

- **`crates/grimoire-core/src/deck_rules/`** — `engine.rs` (`validate_deck`, `validate_for_marks`,
  `deck_size_issue`, `copy_limit_for`, `mana_value_of`, `is_orphan`, `SIZE_KINDS`), `singleton.rs`,
  `commanders.rs` (eligibility, partners and their variants, Backgrounds, the Doctor and companion,
  Oathbreaker, banned-as-commander, `commander_identity`, `color_identity_issues`), `companions.rs`
  (the ten conditions, Yorion, Umori, companion zone and count), `bracket.rs` (`estimate_bracket`,
  `bracket_warning`, `describe_reason`, `COMBO_FLOOR`), and `issue.rs` (`ValidationIssue`:
  `severity`, `code`, `message`, `card_ids`, `row_ids`, serialised as the TypeScript type is).
- **`crates/grimoire-core/src/deck_stats/`** — `mana.rs` (the parts of `packages/ui/lib/mana.ts` the
  stats read: the cost tokeniser, `count_pips`, `produced_keys`, `has_variable_cost`),
  `buckets.rs` (the parts of `deckBuckets.ts`: `front`, `is_land`, `is_mdfc_land`,
  `card_mana_value`, `curve_bucket`, `type_bucket`, `is_creature`, `sized_cards`, `library_cards`,
  `type_counts`), `summary.rs` (`deck_stats` → `DeckStatsSummary`, every field the TypeScript has),
  `types.rs` (`type_breakdown`, `creature_split`, `subtypes`) and `odds.rs` (`choose`,
  `hand_odds`).

What is ported is **the functions the deck page draws conclusions with**, not the page: chart
geometry, labels, folding buckets for display and React state stay where they are.

**The port's inputs are the core's own rows**: `&[DeckCardRow]`, `&FormatSpecRow` and
`&[DeckCombo]` (`combos.rs`), which are exactly what `DeckCard`, `FormatSpec` and `DeckCombo` mirror.
`DeckCardRow`, `FormatSpecRow` and `DeckCombo` gain `Deserialize` (camelCase, as they serialise) so
the goldens can be read into them.

**Rules for the port**, each a place a port goes quietly wrong:

- Sentences byte for byte: curly quotes, `—`, `Infinity` read as "no limit", plurals, the
  three-names-then-"and N more" lists.
- JavaScript's semantics where they differ from Rust's: `\b` is an ASCII word boundary;
  `toLowerCase`; `Number(token)` for a generic mana symbol (`"½"`, `""`, `" 2"`); `Math.max` over an
  empty list; `JSON.parse` of a malformed `legalities` or `faces` blob is a warning, never a panic.
- Floating point in the same order of operations, so sums, averages and odds are bit-identical; the
  goldens compare numbers exactly.
- Ordering as the TypeScript's: `Map` insertion order, `Set` dedupe order, the read's row order.

**Two core read commands** (on `TABLE_ONLY`; the page computes these itself):

- **`deck_check(deck_id, variant)`** → `DeckCheck`: `format_key`, `checked` (false when the format's
  `validates` cell is false, or the key is not in `format_specs`), `issues` (`validate_deck`),
  `parked` (the inactive half of `validate_for_marks`: what is wrong with cards in switched-off piles
  — "could this ever come in"), and `bracket` — present only where the format has a commander rule
  (the page's own condition for drawing the bracket, `DeckEditor.tsx`'s `spec?.commanderRule !=
  null`): the `BracketEstimate`, the deck's set bracket (`0` is Auto), `bracket_warning`'s sentence,
  and the combo list's `downloaded_at` (`combos_status`), so an empty combo list can be told apart
  from no combos. Combos are matched by `combos_for_cards` over the **active** rows' printings,
  deduplicated — the page's `useBracketReading` rule.
- **`deck_stats(deck_id, variant, marketplace)`** → `DeckStatsSummary` (read with the deck's own
  `separate_x_group`), `type_counts`, and `type_breakdown`.

Both read `deck::get` and `list_format_specs`; neither writes. Budget: under 50 ms for a 100-card
deck on the real corpus.

### 6.2 The goldens (E1)

`packages/ui/features/decks/__golden__/`, written by a new TypeScript suite
(`packages/ui/features/decks/golden/*.golden.test.ts`, regenerated with `pnpm exec vitest run --project ui <suite> -u`,
as the widget catalogue's files are) and read by the Rust suites through `include_str!`:

| File | Cases | Each case holds |
| --- | --- | --- |
| `validation.json` | every rule of `engine.ts`, `commanders.ts`, `companions.ts`, `singleton.ts`, across every spec in `fixtures.SPECS` | the spec key, the cards, `validateDeck`'s answer and `validateForMarks`' |
| `bracket.json` | every signal and every combo letter, the floor at 2, 3 and 4, the warning at set brackets 0–5 | the cards, the combos, `estimateBracket`'s answer, each reason's `describeReason`, `bracketWarning` per set bracket |
| `stats.json` | lands, MDFCs, X spells (both `separateXGroup` settings), orphans, gold and colourless cards, hybrid and Phyrexian pips, produced mana known and not, prices, owned and short rows, switched-off piles | the cards, `deckStats`' answer, `typeCounts`, `typeBreakdown` |
| `odds.json` | a grid of deck sizes, successes, hand sizes, wants and the three modes, edges included | the inputs and `handOdds`' answer |
| `text.json` | every printed cost, type line and oracle text in the fixtures, plus edge strings | `manaValueOf`, `countPips`, `hasVariableCost`, `producedKeys`, `copyException`, `unreadableCopyCount`, `isBasicLand`, `front`, `isLand`, `isMdfcLand`, `typeBucket` per string |

- **Cards are stored as overrides of one base card** — `fixtures.card()`'s default, written once at
  the top of each file — so a case reads as what makes it that case, and the files stay small.
- The specs are the fixture's `SPECS`, written once per file, so a case names its spec by key.
- **The coverage fence** (§4) runs on both sides.
- A golden that disagrees with the Rust is the Rust's bug: the TypeScript is the behaviour of record,
  as it is for the export writers. Nothing massages a golden by hand.

### 6.3 The tools (E2)

Six tools change: `get_deck` is widened and five are added, which makes 32 with project B's `show_search` (31 as first designed).

| Tool | Arguments | Calls | Answers |
| --- | --- | --- | --- |
| `get_deck` (widened) | `deckId`, `list`, **`as`** (`piles`, the default, or `text`), **`textFormat`** (`moxfield` default, `arena`, `mtgo`, `plain`; built as `plain` first, and moved because plain text is one flat list that puts a switched-off Maybeboard among the deck's cards, where Moxfield's heads each zone) | `deck_get`, `format_specs_list` | Today's answer, plus `kind` (`regular`, `theory` or `virtual`, `deckKind.ts`'s three), `game`, `commanders` and `companion` (name, cardId), `identity` (the commanders' colour identity, or the active cards' union where the deck has none), `settings` (set bracket or `auto`, X spells apart, theory list on, tags, archived, folder) and `counts` (`sized` — what the format counts — `copies`, `inactive`, per pile). With `as: "text"` the piles are replaced by `text`: the deck written by the app's export writer in that format, switched-off piles under `Maybeboard` (the mirror's `from_deck_card`, then `transfer::write::format_export` with the format's default fields) |
| `deck_stats` | `deckId`, `list` | `deck_stats`, `get_marketplace` | `curve` (mana values 0–7 and 8+, an `X` bar when the deck sets X spells apart, each with its creatures), `averageManaValue`, `lands`, `nonlands`, `mdfcLands`, `unknownManaValue`, `types` (card types by count), `subtypes` (creature types, land types), per colour `pips`, `pipCards`, `sources` and `spells`, `sourcesKnown`, and `price`, `ownedPrice`, `missingPrice`, `unpriced`, `owned`, `missing`, in the reader's marketplace currency |
| `check_deck` | `deckId`, `list` | `deck_check` | `checked` (with a `note` naming why when false), `problems` (severity, code, sentence, the cards by name and cardId), `parked` (the same for switched-off piles), and `bracket` where the format has a commander rule: `floor`, `set`, `warning`, `reasons` (code, floor, cards, sentence), `gameChangers`, `massLandDenial`, `extraTurns`, `combos` and `possibleCombos` in project A's short shape, and `comboData`. Its description says the bracket is a **floor** read from the cards, never the deck's bracket, and that 1 and 5 are the reader's to set |
| `deck_shortfall` | `deckId`, `list`, `limit` (default 50, max 200), `offset` | `deck_get`, `deck_owned_elsewhere`, `deck_missing_plan`, `get_marketplace` | Every short row of the active piles (the ledger's `isShort`): name, cardId, finish, `wanted`, `have`, `missing`, `unitPrice`, `cost`, `elsewhere` (live list only: each place the reader owns another copy, with its count — a binder, another deck, Recently removed) and `onWishlist`; totals `missing`, `cost`, `unpriced`, and `toBuy` / `toBuyCost` for the copies owned nowhere. A virtual deck answers a `note` and no rows: it tracks no cardboard |
| `owned_for_deck` | `deckId`, `list`, `query` (name words), `oracleTags`, `types`, `manaValues`, `limit` (default 20, max 100), `offset` | `deck_owned_fits` | Cards the reader owns (any printing, finish or folder) that the deck could play and does not: legal in its format (when the format has legality data), inside its `identity` (as `get_deck` reads it), and in no active pile of the list. Each `name`, `cardId` (the printing the reader owns), `typeLine`, `manaCost`, `owned` (copies); ordered by EDHREC rank (most played first, unranked last, then name), with `total` |
| `draw_odds` | `deckId`, `list`, what to draw — any of `cards` (names or cardIds), `pile` (a pile's name), `type` (a card type: `Land`, `Creature`…) — and `want` (default 1), `mode` (`atLeast` default, `exactly`, `atMost`), `hand` (default 7), `turns` (default 4, max 20), `onThePlay` (default `true`) | `deck_draw_odds` | `library` (copies an opening hand is drawn from: the sized piles less the command zone, `libraryCards`' rule), `successes` (the copies matched, and their names), and per turn from the opening hand on, `cardsSeen` and `chance`. Its description says it ignores mulligans and tutors |

**Two more core read commands** (E2, `TABLE_ONLY`):

- **`deck_owned_fits(deck_id, variant, text, oracle_tags, types, mana_values, limit, offset)`**: the
  candidate set and order above, in one query whose exclusion of the deck's cards is in SQL, so
  pagination is honest. Reuses `filters.rs`' clauses for the format, identity, tag, type and mana
  value conditions rather than spelling them again. Budget: under one second on the owner's real
  collection.
- **`deck_draw_odds(deck_id, variant, cards, pile, type, want, mode, hand, turns, on_the_play)`**:
  `library_cards`, the match, and `hand_odds` once per turn with `hand + turn - (on_the_play ? 1 :
  0)` cards seen from turn 1 (turn 0 is the opening hand). A selector matching nothing answers
  `successes: 0` and a note, never a refusal.

Every tool is `readOnlyHint: true, openWorldHint: false`, refuses an unknown deck naming
`list_decks` (as `held_combos` does), and answers `structuredContent` (project A's rule).

### 6.4 The prompts (E2)

Two new Markdown prompts in `mcp/prompts/`, each with one optional argument for the user's own
words (`request`), compiled in like the others, both in `read_guide`'s enum:

- **`review_deck`** teaches a review in order: `get_deck` (what the deck is), `check_deck` (what is
  wrong, the bracket floor), `deck_stats` (curve, lands, colours against sources), `held_combos`
  (what it holds and what it is one card from), `draw_odds` (consistency questions),
  `deck_shortfall` (what it is short of), `owned_for_deck` and `similar_cards` (swaps from the
  collection). And the rules: suggestions are for the reader to make in the app — never say a change
  was made; a switched-off pile is not the deck; the bracket is a floor and a conversation opener,
  1 and 5 are the reader's intent; an unchecked format is "not checked", never "legal"; a missing
  combo list is said so.
- **`build_from_collection`** teaches building from what the reader owns: choose the format and
  `format_rules`; for Commander, find owned commanders (`find_cards` with `owned`, `types`,
  `format`), then owned cards inside the identity by function (`find_tags`, then `find_cards` with
  `oracleTags`, `owned`, `colors`, `format`) and `held_combos` over the collection; for an existing
  deck, `owned_for_deck`. It ends with the deck as plain decklist text the reader pastes into the
  app's import, since no tool creates a deck.

The server's `instructions` gain one sentence naming the deck tools and the two prompts.

### 6.5 Documentation

- E1: `docs/reference/deck-builder.md`'s validation section says the core holds a port held to the
  page by the goldens, and names them; `packages/ui/features/decks/CLAUDE.md` §1 gains the rule that
  **a change to the validation, bracket or stats TypeScript regenerates the goldens and is ported in
  the same commit**; `crates/grimoire-core/CLAUDE.md` names the two modules.
- E2: `docs/reference/local-mcp-server.md`'s tool and prompt tables and §6; the MCP bullet in
  `apps/desktop/src-tauri/CLAUDE.md`.

## 7. Testing

- **E1**: the golden suites on both sides, with the coverage fence; Rust unit tests for each string
  matcher against the expression it replaces (beside the goldens, so a failure names the matcher);
  `deck_check` and `deck_stats` over a scratch database (a legal deck, an illegal one, an
  `unspecified` one, a switched-off Maybeboard, a non-Commander format with no `bracket`, a combo
  list not downloaded); `command_table::` with the new rows; the WASM build.
- **E2**: each tool in `tools.rs` against a real database on disk, as the existing tools are,
  including every refusal and every note (an unknown deck, a virtual deck's shortfall, an unchecked
  format, a selector matching nothing); `get_deck`'s text equals the mirror's file for the same
  deck; `read_guide`'s enum equals the prompt list; the `instructions` test names every tool and
  prompt.
- `pnpm verify` at the end of each PR. The live WebView2 pass is owed on the owner's machine (no page
  changes, so it is a check that nothing moved).

## 8. Calls made in this design that the owner did not make

Proposals, each open to overruling:

1. Two pull requests, E2 stacked on E1 (§5).
2. The port reads the core's own `DeckCardRow` / `FormatSpecRow` / `DeckCombo`, which gain
   `Deserialize`.
3. No `regex` dependency: hand-written matchers, proved by the goldens.
4. An explicit golden corpus built from the TypeScript fixtures, with a coverage fence, cards stored
   as overrides of the base fixture card; regenerated by `vitest -u`.
5. `get_deck` is widened (deck information, and `as: "text"`) rather than a new overview tool, and
   five tools are added (31 in all).
6. The decklist text comes from the desktop's existing export writers; moving them to the core is
   left to the remote tier.
7. `check_deck` reports switched-off piles' problems apart (`parked`), as the page's card marks do.
8. The bracket is answered only where the format has a commander rule, the page's own condition.
9. `owned_for_deck` fits by format legality and colour identity (the commanders', else the active
   cards' union), excludes cards already in an active pile, and ranks by EDHREC rank.
10. `deck_shortfall` names where else the reader owns a copy at the oracle grain (the page's
    gold-or-red figure, `deck_owned_elsewhere`), and whether a wish exists.
11. Draw odds count turns on the play by default and ignore mulligans.
12. Both prompts end with something the reader does in the app; `build_from_collection` hands over
    decklist text for the import.

## 9. Left to the builder

- Exact module, struct and command names, within §6.
- The cases in each golden beyond the coverage fence's floor.
- Descriptions, notes, refusal sentences and the prompts' wording, within the rules above.
- The order of work inside each PR and its commits.
