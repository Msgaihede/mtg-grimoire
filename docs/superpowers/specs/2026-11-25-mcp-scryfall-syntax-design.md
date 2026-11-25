# MCP server: Scryfall syntax (project C of the MCP improvements)

Date: 2026-11-25. Status: approved by the owner, 2026-11-25.

Project C of the programme recorded in
[2026-11-24-mcp-card-knowledge-design.md](2026-11-24-mcp-card-knowledge-design.md) §2: port the
Scryfall query parser to Rust, let the MCP tools take Scryfall syntax, and add the
`scryfall_syntax` prompt. Project A (that design) merged as Msgaihede/mtg-grimoire#1728 before
this one started, so C is built on `main`.

## 1. Why

Today an agent searches cards by name words (`find_cards`' `query`) and by the Search page's filter
bar (`filters`). Everything else the app can search by (keyword abilities, rules text, power,
`is:fetchland`, `or`, exact names, about forty more keywords) needs the read graph's
`predicates` input, written by hand as JSON. Scryfall's syntax is the language agents already know
for Magic searches, and the app already speaks all of it in every search box
(`docs/reference/search-syntax.md`, issue #909). But it speaks it in **TypeScript**, in the page
(`packages/ui/features/search/queryLanguage.ts`), and the MCP server has no window to ask.

**The binding decision (owner, 2026-11-24, A's spec §2): TypeScript logic the MCP needs is ported
to Rust, not called through the window.** The TypeScript stays for the page; shared golden files
hold both versions to the same answers. The reason is the planned remote tier (issue #1396 PR 5),
which has no window.

## 2. Decisions the owner made for C (2026-11-25)

1. **A term the tools cannot apply as written is refused, naming each one.** The parser reads
   `cmc>=banana` as the words *cmc banana* and drops a bare `t:`, because the box is parsed on
   every keystroke. That forgiveness suits typing and fails an agent, which would read an empty
   answer as "no such cards". So the tools refuse, in one answer naming every such term, what its
   keyword takes, and how to search for the words instead. Syntax runs exactly as written or not at
   all. **The parse itself stays the page's**: the refusal is a separate check beside it (§5.3).
2. **Three tools take `syntax`**: `find_cards`, `search_collection` and `search_wishlist`.
3. **The golden corpus is hand-picked cases, seeded random queries and the vocabulary tables**
   (§6).
4. **The prompt's keyword reference is generated at runtime** from the Rust parser's keyword table,
   which the golden holds to the F1 panel's (§7).

## 3. Goals, non-goals, anti-goals

**Goals:**

1. A Rust port of `parseQuery` in `crates/grimoire-core`, answering the same `ParsedQuery` for
   every input, source spans included.
2. One golden file that both suites read and that fails whichever side drifts.
3. `find_cards`, `search_collection` and `search_wishlist` take `syntax` beside their existing
   arguments, with tags resolved and unknown tags refused.
4. An agent can learn the language from the server alone: the `scryfall_syntax` prompt (and its
   `read_guide` topic) says what each keyword means here, where the app differs from Scryfall,
   and how a refusal reads.
5. Every example search in every prompt is checked against the Rust parser in a test.

**Non-goals:** any change to what the page parses or draws (the TypeScript changes are an export
of its tables and a golden test, §6.3); the chip rewrites (`removeToken`, `setTokenNegated`,
`setTokenValue`, `predicateLabel`), which edit a text box and have no use without one; syntax in
the read graph; syntax in `similar_cards`, the combo tools or `get_deck` (deck tools are E's);
opening a search in the app (B); the remote tier itself.

**Anti-goals, which would make this a failure even if it works:**

- A Rust parse that differs from the page's on any input the golden does not happen to hold.
  The seeded random queries (§6.2) exist to catch the drift nobody thought to write a case for.
- An agent told "no cards" because a term it wrote was silently read as words, or a tag it
  misspelt matched nothing.
- A prompt that advertises a keyword the parser does not read, or an example that does not parse.
- A crash from a pathological query. The page's parser recurses on parentheses; the tools'
  entry point bounds nesting and length before any recursion (§5.3).

## 4. Constraints

- **Rust supplies facts, TypeScript draws conclusions, except where the owner has ruled
  otherwise.** The query grammar is the third thing that lives on both sides by design (after the
  export writers and the widget state), each fenced by a golden; `docs/agent/ARCHITECTURE.md`'s
  "lives on both sides" section names it.
- **The port lives in `grimoire-core`** and is pure: no I/O, no clock, no SQL. It compiles to every
  target the crate does (CI's Windows, Android and `wasm32` checks), and LTO leaves it out of the
  web module until something there calls it.
- **No SQL in the MCP module.** The tools parse with the core's function, resolve tags with the
  existing `tag_resolve` and `tag_search` commands, and search with the existing `search_cards`,
  `collection_list` and `wishlist_list`. No new core command, so no `TABLE_ONLY` entry.
- **Shared files stay tight.** Projects B, D and E edit `mcp/tools.rs`, `mcp/prompts.rs`,
  `mcp/rpc.rs`, `command_table.rs` and `docs/reference/local-mcp-server.md` in parallel. C's MCP
  logic goes in a new file, `mcp/syntax.rs`; `tools.rs` gains only the three argument schemas and
  one call per tool. `prompts/search_cards.md` is being rewritten by B, so C's edit there is one
  table row and one sentence, and C expects to rebase on B.
- Multi-line Rust strings are built with `concat!`. `pnpm verify` once, at the end.

## 5. The design

### 5.1 The port: `grimoire_core::query_language`

A new module, `crates/grimoire-core/src/query_language.rs`, named after the TypeScript file it
ports. It ports `queryLanguage.ts`' grammar function by function, keeping its names in snake case
so a reader can hold the two side by side: `keyword_key`, `QUERY_KEYWORDS`, `predicate_value`,
`numeric_value`, `unquote`, `classify`, `excluded_name`, `negated_text`, `QUOTE_OPENS`'s test,
`closes_quote`, `lex`, `parse_sequence`, `simplify`, `resolve_term`, `term_of`, `group_of` and
`parse_query`. Each Rust doc comment says what it ports and leaves the *why* in the TypeScript,
where it already is, so the reasoning has one home.

**Its output is the page's `ParsedQuery`**: `text`, `tags` (namespace, value, negated, start,
end) and `predicates` (`filters::QueryPredicate` plus start and end), in source order.
`QueryPredicate`, `PredicateField` and `PredicateOp` gain `Serialize` (camelCase, `terms` omitted
when empty, as `wirePredicate` sends it), so a parse can be handed to `search_cards` as JSON and
compared with the golden. Spans are byte offsets in Rust; the golden test converts them to the
UTF-16 offsets JavaScript strings use.

**JavaScript's semantics are the reference, ported exactly.** Where the two languages' standard
libraries disagree, the port follows JavaScript:

| TypeScript | Not Rust's | The port |
| --- | --- | --- |
| `/\s/` and `.trim()` (Unicode spaces and U+FEFF, not U+0085) | `char::is_whitespace` (U+0085, not U+FEFF) | a `js_space` helper and a `js_trim` over it |
| `/[\p{L}\p{N}]/u` (a letter or a number) | `char::is_alphanumeric` (also every Other_Alphabetic mark, such as Ⓐ) | the general category, from a small crate (`unicode-properties` or similar) if its size in the web module is small, else a generated table; the builder measures |
| `\d`, `[A-Za-z]`, `/i` without `u` | Unicode-aware classes | ASCII tests |
| regular expressions (`TERM`, `MANA_COST`, `DEVOTION`, `QUOTE_OPENS`…) | — | hand-written matchers; every one of these patterns is deterministic (no backtracking changes the match), so each is a short scan |

**The vocabulary is the page's.** The keyword table (target, keywords, default operator,
operators, example, blurb, section), the display keywords, the closed vocabularies, the language
codes, the rarity words, the cross-field names and the colour names are Rust constants equal to
the TypeScript ones, and the golden holds them equal (§6.1). Where Rust already has the list
(`filters::IS_VALUES`), the port uses it rather than a copy.

**`filters.rs`' doc on `QueryPredicate` is rewritten.** It says the grammar is "parsed in
TypeScript and never here", which stops being true. The new text: the page parses in TypeScript,
hosts with no window parse with `query_language`, and the golden holds the two to one answer.

### 5.2 The tools' entry point: `query_language::read`

`parse_query` is the parity function: it answers what the page answers for any input, however
broken. The tools call **`read(input) -> Result<ParsedQuery, Vec<Unread>>`** instead, which runs
the checks below first and parses only an input that passes all of them.

**Bounds, checked by a linear scan before any recursion**: at most `MAX_SYNTAX_CHARS` (2,000)
characters and groups nested at most `MAX_DEPTH` (16) deep. `parse_query` recurses on
parentheses, as the page's does, and a 1 MiB request body could hold half a million of them.

### 5.3 What is refused: `Unread`

One `Unread` per problem, each with the term's own text and one sentence. All are reported at
once. **The checks read the parser's own decisions**: `classify` gains an internal reason (why a
chunk became words or nothing) that `parse_query` ignores and `read` reports, so the check cannot
disagree with the parse.

| Kind | Example | The page does | Sentence (shape) |
| --- | --- | --- | --- |
| A value the keyword does not take | `cmc>=banana`, `is:fetchlnad`, `c:rgx`, `r>special` | words | "`cmc>=banana`: cmc takes a number, `even` or `odd`, or another stat (`pow`, `tou`, `loy`). To search for the words, quote them." |
| An operator the keyword does not take | `t>goblin`, `is=commander` | words | "`t>goblin`: t takes `:` or `=`." |
| A keyword this app does not read | `cube:vintage`, `cheapest:usd` | words | "`cube:vintage`: cube is not a keyword here; read_guide's scryfall_syntax lists them." |
| A regular expression | `o:/^draw/` | words | "Regular expressions are not supported; …" |
| A keyword with no value | `t:`, `cmc>=`, `!`, `-` | dropped | "`t:` has no value." |
| A display keyword | `unique:prints`, `order:usd`, `include:extras` | dropped | "`order:usd` is about how Scryfall lays results out, which these tools do not take; leave it out (`allPrintings` answers every printing)." |
| A dangling connective | `t:goblin or`, `or or`, `and t:elf` | dropped | "`or` needs a term on each side." |
| An unbalanced group | `(t:goblin`, `bolt)`, `()` | runs to the end / a character / dropped | "A `(` is never closed." / "A `)` closes nothing." / "`()` is empty." |
| An unclosed quote | `o:"draw a` | runs to the end | "A quote is never closed." |
| A term with no word in it (added in the build, 2026-11-25) | `+++`, `t:'--'` | stands, and matches everything or nothing | "`+++` holds no word to search for." |
| Past the bounds | 2,001 characters, 17 groups deep | — | "syntax is at most 2,000 characters." / "Groups nest at most 16 deep." |

An unknown keyword is refused only when it has a value (`foo:bar`). `foo:` alone is a word, which
is how `Circle of Protection: Red` stays a name. Free text is never refused: `bolt t:instant` is
the name words *bolt* and a type.

Each keyword's "takes" phrase comes from a per-field table beside `predicate_value` (one short
phrase per `PredicateField`), tested to cover every field.

### 5.4 The tools

`find_cards`, `search_collection` and `search_wishlist` each gain:

```json
"syntax": { "type": "string", "maxLength": 2000,
  "description": "A Scryfall search, e.g. \"t:goblin cmc<=2 -is:token\" or \"(o:draw or o:scry) id<=ur\". read_guide's scryfall_syntax has the keywords; a term this app cannot apply is refused, naming it." }
```

`syntax` is optional and combines with everything the tool already takes (all of it ANDed):
`find_cards`' `query`, `set` and `filters`, and the other two's `query` and `folderId`. A tool
needs a `query`, a `filters` field or a `syntax` (today's "needs a query or a filter" refusal
widens to say so). One shared function in `mcp/syntax.rs` reads it into the request fields:

1. `query_language::read(syntax)`; any `Unread` → one refusal, every sentence joined.
2. **Tags.** Every tag the parse names, top-level tokens and those inside groups alike, is resolved
   in one `tag_resolve` call (at most 64, its `MAX_LOOKUPS`; more is refused). An unknown one is
   refused with its closest tags from `tag_search` (three, the page's "Did you mean" note), in
   one refusal naming every unknown. This is stricter than the page inside an `or`, where an
   unknown tag matches nothing in its branch; for an agent that is the same silent trap as
   decision 1. Top-level tags go into `oracleTags`/`artTags` as `include`/`exclude` slugs,
   **merged** with `filters.oracleTags` (a union, `mergeTagTerms`' rule). Tags inside a group stay
   in their group's predicate, which the SQL resolves by name as it does for the page.
3. **Text.** The parse's free text is joined after `query` with a space, into the request's
   `text`.
4. **Predicates.** The parse's predicates, spans dropped (`wirePredicate`'s shape), followed by
   `filters.gameChanger`'s, into `predicates`.

The answers are unchanged. Nothing echoes the parse: with refusals, what ran is what the agent
wrote.

**What differs by tool is the free text**, and the prompt says so: in `find_cards` and
`search_collection` it is a full-text prefix match on the name, type line and rules text; in
`search_wishlist` it is a substring of the card's name (the wishlist's own column, so a wish whose
printing left the corpus still answers). Every keyword means the same in all three.

### 5.5 The `scryfall_syntax` prompt

A new `mcp/prompts/scryfall_syntax.md`, compiled in like the others, title *Search with Scryfall
syntax*, one optional argument `search` ("The search the user wants, in their words or in Scryfall
syntax"). Hand-written, it covers:

- the grammar: terms, a leading `-`, quotes, `or`/`and` and their precedence, parentheses, `!` for
  an exact name, `not:`;
- the traps: what a bare `:` means differs by keyword (`c:rg` is "at least red and green",
  `id:rg` is "fits inside red-green"); `t:` and `o:` match word prefixes, not substrings; `-bolt`
  excludes by name only; tag keywords (`otag:`, `atag:`) take tag names (`find_tags`);
- what this app does not take: regular expressions, `~`, `cube:`, `cheapest:`, the display
  keywords, and how a refusal reads;
- which tool takes it, and how the free text differs by tool (§5.4);
- worked examples, each an agent question and its search.

**Then the keyword reference, generated at runtime**: `prompts::get` appends a Markdown table
rendered from `query_language::QUERY_KEYWORDS` (in `mcp/syntax.rs`), one row per keyword
grouped by the F1 panel's sections: every spelling, the operators it takes, what `:` means for
it, the blurb and the example. That is `create_widget`'s pattern (it appends the committed
catalogue).

**Elsewhere:** `read_guide`'s topics follow `prompts::names()` with no edit; the server's
`instructions` gain one sentence ("`find_cards`, `search_collection` and `search_wishlist` take
Scryfall syntax in `syntax`; read the `scryfall_syntax` guide first") and the prompt count; the
`search_cards` prompt gains one table row naming `syntax` and a sentence pointing at
`scryfall_syntax`, nothing more (B is rewriting that file).

### 5.6 Example searches are checked

A test in `mcp/prompts.rs` reads **every** prompt (C's, and whatever B, D and E add):

- every line of a fenced ` ```scryfall ` block must pass `query_language::read` with at least one
  term or word;
- every line of a fenced ` ```scryfall-refused ` block must be refused, so a prompt that says
  "this is refused" is held to it;
- every `"syntax": "…"` value in a fenced ` ```json ` block (a tool call written out) must pass;
- the generated reference's examples must each parse to exactly one term of their row's field
  (the page's `KeyMap.test.tsx` rule, held again on the Rust side);
- at least one example was read, so a renamed fence does not pass by checking nothing.

The authors' rule, in the module doc: an example a reader could copy goes in a `scryfall` block.

## 6. The golden

### 6.1 The file

`packages/ui/features/search/__golden__/query-language.json`, beside the TypeScript it is
generated from (the `widget-state.json` precedent). One object:

- `tables`: every vocabulary table, as JSON: the keyword table (each row whole), the display
  keywords, the closed vocabularies, the language codes, the rarity words, the cross-field names,
  the colour names and the `is:` values.
- `cases`: `{ name, query, parsed }`, hand-picked (§6.2).
- `random`: `{ seed, query, parsed }`, seeded random queries (§6.2).

### 6.2 What is in it

**Hand-picked cases (about 300)**: every branch of the grammar, taken from the TypeScript suite's
own cases (`queryLanguage.test.ts`'s parse cases, rewritten as queries) plus the cases that exist
only because there are now two languages: Unicode whitespace (U+00A0, U+3000, U+FEFF, U+0085),
letters and marks outside ASCII (`Æther`, `Lim-Dûl`, `Ⓐ`, combining marks, a value of one emoji),
astral characters before a span (so the UTF-16 conversion is exercised), every operator on every
field kind, every vocabulary's first and last word, quotes and apostrophes at every position the
lexer distinguishes, every shape of unbalanced group and dangling connective.

**Seeded random queries (500)**: built from a fragment alphabet (keywords with each operator,
values valid and invalid, `(`, `-(`, `)`, `or`, `and`, `-`, `!`, both quotes, an apostrophe word,
spaces of several kinds, a few non-ASCII words) by a small seeded generator in the TypeScript test
(mulberry32). The queries are stored, so Rust needs no generator; the seed is stored so the set
can be regrown on purpose.

### 6.3 Who writes it, who reads it

- **TypeScript writes it.** A new `queryLanguage.golden.test.ts` builds the object from the tables,
  the case list and the generator, and `toMatchFileSnapshot`s it; `pnpm vitest run -u` rewrites it
  after an intended change, and the diff is the review (the catalogue snapshot's mechanism). The
  tables it serialises are exported from `queryLanguage.ts` as one `QUERY_VOCABULARY` object, the
  only change to that file.
- **Rust reads it.** A test in `query_language.rs` `include_str!`s the file, asserts every table
  equals its Rust constant, and asserts `parse_query(query)` equals `parsed` for every case and
  every random query, spans converted to UTF-16. A failure names the case and prints both
  parses.

So a change to the TypeScript grammar fails CI until the golden is regenerated, and then fails
until the Rust follows, and a Rust change that is not the page's fails at once.

## 7. Documentation

- `docs/reference/search-syntax.md`: a section *The Rust port (project C)* saying what is ported
  and what is not, the golden, `read` and its refusals, and the semantics table of §5.1. The
  module table at "Where it lives" gains the two new files.
- `docs/reference/local-mcp-server.md`: the three tools' rows name `syntax`; the prompts table gains
  `scryfall_syntax`; §6's "Card knowledge is not whole" drops C. Edits kept to those lines (D and
  E edit this file too).
- `docs/agent/ARCHITECTURE.md`: "Export writing lives on both sides" gains one bullet naming the
  query grammar and its golden.
- `apps/desktop/src-tauri/CLAUDE.md` (the MCP bullets: the fifth prompt, `syntax`, and that example
  searches are held to the parser), `packages/ui/CLAUDE.md` (the query-syntax bullet: a Rust port
  is held to this file by the golden, regenerate with `-u`) and `crates/grimoire-core/CLAUDE.md`
  (one line: `query_language` is the page's grammar ported, golden-held).

## 8. Testing

- **Core**: the golden test (§6.3); `read`'s refusals, one test per `Unread` kind with its
  sentence, including the bounds and a 100,000-deep `(` refused without recursing; the "takes"
  table covers every `PredicateField` the keyword table names; `Serialize` round-trips through
  `QueryPredicate`'s `Deserialize`.
- **TypeScript**: the golden snapshot test; the existing `queryLanguage.test.ts` and `ipc.test.ts`
  unchanged and green (the `Serialize` derive must not disturb `ipc.test.ts`' reading of
  `QueryPredicate`).
- **MCP** (`mcp/syntax.rs` and `tools.rs`, against a real database on disk): `find_cards` with a
  plain term, an `or` group, a negated group, an exact name, and syntax beside `query` and
  `filters`; a top-level tag merged with `filters.oracleTags`; a tag inside an `or`; an unknown tag
  refused with suggestions; several unreadable terms refused in one answer; `search_collection`
  and `search_wishlist` narrowed by a type and a tag; the "needs a query" refusal naming `syntax`.
- **Prompts**: `scryfall_syntax` is listed and read by `read_guide`; the example check of §5.6; the
  generated reference names every keyword of the table; the existing instructions test (every
  tool and prompt named) passes.
- `pnpm verify` once at the end. **The live WebView2 pass is owed on the owner's machine**: this
  session runs on Linux. C changes no page, so that pass is a check of the MCP tools through a real
  client against the real corpus rather than of a window.

## 9. Calls made in this design that the owner did not make

These are proposals; each can be overruled:

1. Unknown tags are refused inside an `or` too, where the page lets that branch match nothing.
2. A free-text word is never refused, and an unknown keyword only when it has a value.
3. Display keywords (`unique:`, `order:`, `include:extras`) are refused rather than ignored, under
   decision 1's "as written or not at all".
4. Bounds: 2,000 characters and 16 levels of nesting.
5. The `\p{L}` difference is closed with a small dependency (or a generated table) rather than
   accepted as a known divergence.
6. The answers do not echo how the syntax was read.
7. No new core command: the tools call `query_language` directly, as they call `filters`' constants
   today. A host that needs syntax later calls the same function.

## 10. Considered and not chosen

- **A `syntax` field on `SearchRequest`**, parsed inside `search_cards`. Every host would take
  syntax at once, but the page would then have two ways to send the same search, and the parse
  belongs before tag resolution, which is a round trip the request cannot make.
- **Making `query` itself syntax.** Plain words parse as free text, so it would mostly work, but
  `-bolt` would change meaning in place; a new argument says what it takes.
- **Syntax in the read graph** (`searchCards(syntax:)`): a change to the graph, which A kept out
  and C does too.

## 11. Left to the builder

- The order of work and how it is split into commits.
- Exact Rust type names inside `query_language` and `mcp/syntax.rs`.
- The wording of the refusal sentences, the prompt and the "takes" phrases, within §5.3's shapes.
- How the `\p{L}` test is met (crate or table), measured against the web module's size.
