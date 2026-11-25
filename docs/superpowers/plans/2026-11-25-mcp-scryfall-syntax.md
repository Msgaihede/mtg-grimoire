# Plan: Scryfall syntax for the MCP server (project C)

Design: [2026-11-25-mcp-scryfall-syntax-design.md](../specs/2026-11-25-mcp-scryfall-syntax-design.md)
(approved by the owner, 2026-11-25). Branch: `claude/modest-cerf-p1fw5p`, from `main` (project A,
Msgaihede/mtg-grimoire#1728, is merged). Execute in order; check steps off as they land.

## The contract between the two halves

Tasks 1 and 2 run in parallel and meet in one file,
`packages/ui/features/search/__golden__/query-language.json`. Its shape, exactly:

```jsonc
{
  "tables": {
    // QUERY_KEYWORDS, every row whole, in order: target is a PredicateField string or {"tag": ns}.
    "keywords": [{ "target": "name", "keywords": ["name"], "defaultOp": "colon",
                   "ops": ["colon", "eq"], "example": "name:goblin", "blurb": "Card name",
                   "section": "Text and names" }],
    "displayKeywords": ["unique", "order", "direction", "prefer", "display", "include"],
    // VOCABULARY, each Set as an array in insertion order.
    "vocabulary": { "game": ["paper", "arena", "mtgo"], "...": [] },
    "languageCodes": { "en": "en", "japanese": "ja" },
    "rarityWords": { "c": "common" },
    "crossFields": { "pow": "@power" },
    "colorNames": ["m", "multi", "..."]
  },
  // One object a line, compact, so a diff reads case by case.
  "cases": [{ "name": "…", "query": "…", "parsed": { "text": "", "tags": [], "predicates": [] } }],
  "random": { "seed": 20261125, "cases": [{ "query": "…", "parsed": { } }] }
}
```

`parsed` is `parseQuery(query)` exactly as it returns (spans in UTF-16 offsets; a group's `terms`
carry no spans; `terms` absent on a plain predicate). Objects compare by key, arrays by order.

## Task 1 — the Rust port (`crates/grimoire-core/src/query_language.rs`)

- [ ] `filters.rs`: `Serialize` on `PredicateField`, `PredicateOp` (camelCase) and `QueryPredicate`
      (`terms` with `skip_serializing_if = "Vec::is_empty"`); rewrite `QueryPredicate`'s doc
      ("Parsed in TypeScript and never here" → both sides, golden-held).
- [ ] `Cargo.toml`: `unicode-properties` (general category only, `default-features = false,
      features = ["general-category"]`), for `\p{L}`/`\p{N}`. Record the web module's size before
      and after if a wasm build is possible here; otherwise say so in the PR.
- [ ] The tables: `KeywordSpec`, `QUERY_KEYWORDS` (45 rows, the TS order), `DISPLAY_KEYWORDS`,
      `VOCABULARY` (per field), `LANGUAGE_CODE`, `RARITY_BY_WORD`, `CROSS_FIELD`, `COLOR_NAMES`
      (the TS set: `filters::COLOR_NAMES` plus the four multicolour spellings); `is:` reads
      `filters::IS_VALUES`.
- [ ] The JavaScript helpers: `js_space`, `js_trim`, `indexable` (`\p{L}|\p{N}`), ASCII digit and
      letter tests, and one matcher per regex (`TERM`, `QUOTE_OPENS`, `NUMERIC`, `COUNT`, `PRICE`,
      `COLOR_LETTERS`, `MANA_COST`, `DEVOTION`, `DATE`, `SET_CODE`, `YEAR`, the exact-name prefix).
- [ ] The grammar, function by function: `keyword_key`, `predicate_value`, `numeric_value`,
      `unquote`, `classify` (with an internal `Why` for §5.3), `excluded_name`, `negated_text`,
      `closes_quote`, `lex` (byte spans), `parse_sequence`, `simplify`, `resolve_term`, `term_of`,
      `group_of`, `parse_query`. Types: `ParsedQuery`, `TagToken`, `PredicateToken` (Serialize,
      camelCase).
- [ ] `read(input) -> Result<ParsedQuery, Vec<Unread>>`: the bounds scan (`MAX_SYNTAX_CHARS`
      2000, `MAX_DEPTH` 16) before any recursion; then the §5.3 checks over the lexemes and the
      classifier's reasons; `Unread { term, sentence }`; the per-field "takes" phrases.
- [ ] `lib.rs`: `pub mod query_language;`.
- [ ] Tests at the foot: the golden (tables equal; every case and random query equal, byte spans
      converted to UTF-16, a failure printing the case and both parses); one test per `Unread`
      kind with its sentence; 100,000 `(` refused without recursing; the "takes" table covers
      every field `QUERY_KEYWORDS` names; `QueryPredicate` serialises and deserialises to itself.

## Task 2 — the TypeScript golden (parallel with task 1)

- [ ] `queryLanguage.ts`: export `QUERY_VOCABULARY` = `{ displayKeywords, vocabulary,
      languageCodes, rarityWords, crossFields }` built from the existing consts (no behaviour
      change).
- [ ] `queryLanguage.golden.test.ts`: the hand-picked case list (about 300: every parse case of
      `queryLanguage.test.ts`, plus the two-language cases of the design's §6.2), a mulberry32
      generator of 500 queries over a fragment alphabet, the serializer of the contract above, and
      `toMatchFileSnapshot("./__golden__/query-language.json")`.
- [ ] `pnpm vitest run -u packages/ui/features/search/queryLanguage.golden.test.ts` writes the file;
      run once more without `-u` to see it hold.
- [ ] `.prettierignore`: the golden, with the catalogue snapshots' reason.

## Task 3 — the tools (`apps/desktop/src-tauri/src/mcp/syntax.rs`, after task 1)

- [ ] `syntax_fields(state, syntax, oracle_slugs) -> Result<Map<String, Value>, String>`:
      `query_language::read` (every `Unread` sentence in one refusal); every tag the parse names
      (top-level and inside groups) resolved in one `tag_resolve` (more than 64 refused); unknown
      ones refused with three `tag_search` suggestions each; answers `text`, `oracleTags`,
      `artTags` (top-level slugs, merged with the caller's) and `predicates` (wire shape).
- [ ] `tools.rs`: `syntax` in the three schemas; `find_cards`, `search_collection` and
      `search_wishlist` call `syntax_fields` and merge (`query` + text, `gameChanger` appended to
      the predicates, `filters.oracleTags` merged); the "needs a query" refusal names `syntax`.
- [ ] `mcp/mod.rs`: `mod syntax;`.
- [ ] Tests against a real database on disk (design §8, MCP bullet).

## Task 4 — the prompt (after task 1)

- [ ] `mcp/prompts/scryfall_syntax.md` (design §5.5), examples in `scryfall` and
      `scryfall-refused` blocks.
- [ ] `syntax::keyword_reference()`: the Markdown table from `QUERY_KEYWORDS`, by section.
- [ ] `prompts.rs`: the fifth prompt; `get` appends the reference for `scryfall_syntax`; the
      listing test names five; the example check (design §5.6) over every prompt; the reference's
      examples each parse to one term of their row's field.
- [ ] `rpc.rs` `INSTRUCTIONS`: the `syntax` sentence and five prompts.
- [ ] `prompts/search_cards.md`: one table row and one sentence, nothing else (B rewrites it).

## Task 5 — documentation

- [ ] `docs/reference/search-syntax.md`: *The Rust port (project C)*; "Where it lives" rows.
- [ ] `docs/reference/local-mcp-server.md`: the three rows, the prompts table, §6.
- [ ] `docs/agent/ARCHITECTURE.md`: the both-sides bullet.
- [ ] `apps/desktop/src-tauri/CLAUDE.md`, `packages/ui/CLAUDE.md`, `crates/grimoire-core/CLAUDE.md`:
      one line each.

## Task 6 — the gate and the PR

- [ ] `cargo fmt -p grimoire-core -p mtg-grimoire`; `pnpm verify` once.
- [ ] Commit (Conventional Commits), push `claude/modest-cerf-p1fw5p`, open the PR against `main`,
      noting the live pass owed on the owner's machine and the rebase on project B's
      `search_cards.md`.
