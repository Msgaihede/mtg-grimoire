# Scryfall Query Syntax Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `t:`, `o:`, `kw:`, `a:`, `c:`, `id:`, `cmc:`, `pow:`, `tou:`, `r:`, `s:` and `f:` work with Scryfall's operators in every box in this app that searches cards.

**Architecture:** One TS grammar module parses the box into free text + tag tokens + a list of typed predicates. That list crosses the IPC boundary as one new `CardFilters.predicates` field, so all three card searches — `search_cards`, `collection_list`, `wishlist_list` — pick it up from the single `push_card_filters` they already share. `t:`/`o:` are the exception: they are folded into the FTS5 MATCH string instead of into SQL predicates, because LIKE measured 80–250× slower on the real corpus.

**Tech Stack:** TypeScript 6 / React 19 / vitest on the front, Rust + rusqlite + FTS5 behind, Tauri 2.11 between.

**Spec:** [`docs/superpowers/specs/2026-09-22-scryfall-query-syntax-design.md`](../specs/2026-09-22-scryfall-query-syntax-design.md) — read it before starting any task. Every "why" lives there; this plan is the "how".

## Global Constraints

- **Never install `@types/node`.** It retypes `setTimeout` and leaks Node types into the app program.
- **`npm run verify` before every commit** — but see the fan-out rule below: during a parallel wave, do **not** run the suite. The orchestrator runs it once after fan-in.
- Commit messages: `feat:`/`fix:`/`chore:`/`test:`/`docs:`, ending with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- **Do not touch a file this plan assigns to another task.** The ownership table below is exhaustive and was swept against every importer. If you believe you need a file that is not yours, stop and report it rather than editing it.
- **Rust:** `cargo fmt` and `cargo clippy` are **not** run by `npm run verify` but *are* run by CI. Run both yourself on files you touch.
- **`a:` means artist and `o:` means oracle text** after this change. `art:`, `atag:`, `arttag:`, `otag:`, `oracletag:`, `function:` keep meaning tags. This reversal is the point of the change, not a bug to protect against.
- **Rust supplies facts, TS draws conclusions.** Parsing is a conclusion and belongs in TS. Rust receives a typed predicate list and emits SQL; it never parses a query string.

## File ownership

Swept 2026-09-22 against every importer of `tagQuery`, `KeyMap`, `parseTagQuery`, `TagToken`.

| Task | Owns (nothing else may touch these) |
| --- | --- |
| **1 — Grammar** | `src/features/search/queryLanguage.ts`, `src/features/search/queryLanguage.test.ts`, deletion of `src/features/search/tagQuery.ts` + `tagQuery.test.ts` |
| **2 — Rust engine** | `src-tauri/src/filters.rs`, `src-tauri/src/search.rs`, `src-tauri/src/collection.rs`, `src-tauri/src/wishlist.rs`, `src-tauri/src/index/facets.rs`, `src/lib/ipc.ts`, `src/lib/ipc.test.ts` |
| **3 — Corpus rung** | `src-tauri/src/schema.rs`, `src-tauri/src/card_row.rs`, `src-tauri/src/ingest.rs` |
| **4 — Wiring** | `src/features/search/useCardSearch.ts`, `useCardSearch.test.ts`, `TagQueryRow.tsx`, `TagQueryRow.test.tsx`, `FilterBar.test.tsx`, `src/features/collection/useCollection.ts`, `src/features/decks/useCollectionSearch.ts`, `src/features/wishlist/useWishlist.ts`, `src/features/decks/QuickAdd.tsx`, `src/features/decks/DeckCoverPicker.tsx` |
| **5 — F1 panel** | `src/components/KeyMap.tsx`, `src/components/QuerySyntaxHelp.tsx`, `KeyMap.test.tsx`, `KeyMap.stories.tsx` |
| **6 — Docs** | `docs/reference/search-syntax.md` (renamed from `tag-search-syntax.md`), `CLAUDE.md`, `src/CLAUDE.md`, `src-tauri/CLAUDE.md` |

**Tasks 1, 2, 3, 5 and 6 have no file overlap and run in one parallel wave.** Task 4 consumes Task 1's and Task 2's exports and runs after them. Task 7 (verify + live pass) is the orchestrator's and runs last.

## The pinned interface

Every task codes against these exact names. They are defined in Task 1 (TS) and Task 2 (Rust) and consumed everywhere else. **Do not rename anything here.**

```ts
// src/features/search/queryLanguage.ts
export type PredicateField =
  | "typeLine" | "oracleText" | "keyword" | "artist"
  | "colors" | "colorIdentity" | "cmc" | "power" | "toughness"
  | "rarity" | "setCode" | "format";

export type PredicateOp = "colon" | "eq" | "ne" | "gt" | "gte" | "lt" | "lte";

export interface QueryPredicate {
  field: PredicateField;
  op: PredicateOp;
  value: string;
  negated: boolean;
}

/** A predicate plus where it sits in the box, so a chip can rewrite the text. */
export interface PredicateToken extends QueryPredicate { start: number; end: number; }

export interface ParsedQuery {
  text: string;
  tags: TagToken[];          // unchanged shape from tagQuery.ts
  predicates: PredicateToken[];
}

export function parseQuery(input: string): ParsedQuery;

/** One row of the vocabulary. The parser and the F1 panel are its two readers. */
export interface KeywordSpec {
  /** A predicate field, or the tag taxonomy this keyword names. */
  target: PredicateField | { tag: TagNamespace };
  keywords: readonly string[];
  defaultOp: PredicateOp;
  ops: readonly PredicateOp[];
  /** Shown in the F1 panel. Must parse — Task 5 asserts it. */
  example: string;
  /** One short sentence for the F1 panel. */
  blurb: string;
}
export const QUERY_KEYWORDS: readonly KeywordSpec[];

// Re-exported unchanged from the old module so Task 4's imports are a path change only:
export type { TagToken, ParsedTagQuery };
export { removeToken, setTokenNegated, setTokenValue, tokenKey, parseTagQuery };
```

```rust
// src-tauri/src/filters.rs
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PredicateField {
    TypeLine, OracleText, Keyword, Artist,
    Colors, ColorIdentity, Cmc, Power, Toughness,
    Rarity, SetCode, Format,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PredicateOp { Colon, Eq, Ne, Gt, Gte, Lt, Lte }

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryPredicate {
    pub field: PredicateField,
    pub op: PredicateOp,
    pub value: String,
    #[serde(default)]
    pub negated: bool,
}

// on CardFilters:
pub predicates: Option<Vec<QueryPredicate>>,
```

**The `typeLine`/`oracleText` split is the subtlest thing in this plan.** Those two fields are carried in the same `predicates` list as everything else, but they are **not** emitted by `push_card_filters` — they are picked up by the FTS builder instead. `push_card_filters` must skip them explicitly, and Task 2 Step 8 is the test that it does. A field handled by neither side is a filter that silently does nothing.

---

### Task 1: The grammar

**Files:**
- Create: `src/features/search/queryLanguage.ts`
- Create: `src/features/search/queryLanguage.test.ts`
- Delete: `src/features/search/tagQuery.ts`, `src/features/search/tagQuery.test.ts`

**Interfaces:**
- Consumes: `TagNamespace` from `@/lib/ipc`.
- Produces: everything in "The pinned interface" TS block above. Task 4 imports `parseQuery`, `removeToken`, `setTokenNegated`, `setTokenValue`, `tokenKey`, `TagToken`, `PredicateToken`. Task 5 imports `QUERY_KEYWORDS`, `KeywordSpec`, `parseQuery`.

**Read first:** the whole of `src/features/search/tagQuery.ts`. You are widening it, not replacing it — the scanner, `keywordKey`, `unquote`, the `"partial"` three-way answer and the three rewrite functions all survive with their doc comments. Spec §3 is the contract.

- [ ] **Step 1: Move the file and make the suite green unchanged**

`git mv src/features/search/tagQuery.ts src/features/search/queryLanguage.ts` and the same for the test. Fix the test's import path. Change nothing else.

Run: `npx vitest run src/features/search/queryLanguage.test.ts`
Expected: PASS, same count as before. This isolates the rename from the behaviour change so a later bisect can tell them apart.

- [ ] **Step 2: Write the failing tests for the operator scan**

Add to `queryLanguage.test.ts`:

```ts
describe("parseQuery — operators", () => {
  it("reads the longest operator first, so >= is never > then =", () => {
    const { predicates } = parseQuery("cmc>=3");
    expect(predicates).toEqual([
      { field: "cmc", op: "gte", value: "3", negated: false, start: 0, end: 6 },
    ]);
  });

  it("gives each keyword its own default operator", () => {
    // Scryfall measured 2026-09-22: c:rg = c>=rg = 676, id:rg = id<=rg = 13,399.
    expect(parseQuery("c:rg").predicates[0]).toMatchObject({ field: "colors", op: "gte" });
    expect(parseQuery("id:rg").predicates[0]).toMatchObject({ field: "colorIdentity", op: "lte" });
    expect(parseQuery("t:goblin").predicates[0]).toMatchObject({ field: "typeLine", op: "colon" });
    expect(parseQuery("cmc:3").predicates[0]).toMatchObject({ field: "cmc", op: "eq" });
  });

  it("negates with a leading dash", () => {
    expect(parseQuery("-t:goblin").predicates[0]).toMatchObject({ negated: true, value: "goblin" });
  });

  it("keeps a quoted value whole", () => {
    expect(parseQuery('o:"draw a card"').predicates[0]).toMatchObject({
      field: "oracleText", value: "draw a card",
    });
  });

  it("ANDs repeated terms rather than collapsing them", () => {
    expect(parseQuery("t:creature t:goblin").predicates).toHaveLength(2);
  });
});

describe("parseQuery — the a:/o: reassignment", () => {
  // Reverses 81251d3b (2026-08-22). Asserted head-on so the break is recorded.
  it("reads o: as oracle text and a: as artist", () => {
    expect(parseQuery("o:ramp").predicates[0]).toMatchObject({ field: "oracleText" });
    expect(parseQuery("a:rebecca").predicates[0]).toMatchObject({ field: "artist" });
    expect(parseQuery("o:ramp a:rebecca").tags).toEqual([]);
  });

  it("leaves every unambiguous tag spelling alone", () => {
    for (const kw of ["otag", "oracletag", "function", "oracle_tag"]) {
      expect(parseQuery(`${kw}:ramp`).tags[0]).toMatchObject({ namespace: "oracle" });
    }
    // art: is genuinely Scryfall's art-tag alias (measured: art: = atag: = 1,145 for dragon).
    for (const kw of ["atag", "arttag", "art", "art-tag"]) {
      expect(parseQuery(`${kw}:dragon`).tags[0]).toMatchObject({ namespace: "art" });
    }
  });
});

describe("parseQuery — partial and unparseable", () => {
  it("answers partial at every keystroke on the way to cmc>=3", () => {
    for (const s of ["cmc", "cmc>", "cmc>="]) {
      const p = parseQuery(s);
      expect(p.predicates).toEqual([]);
      expect(p.text).toBe(""); // not free text either — neither a term nor a word
    }
  });

  it("hands an unparseable value to FTS as words rather than refusing it", () => {
    const p = parseQuery("cmc>=banana");
    expect(p.predicates).toEqual([]);
    expect(p.text).toBe("cmc>=banana");
  });

  it("leaves an unknown keyword as free text", () => {
    expect(parseQuery("itag:dragon").text).toBe("itag:dragon");
  });
});
```

- [ ] **Step 3: Run them and watch them fail**

Run: `npx vitest run src/features/search/queryLanguage.test.ts`
Expected: FAIL — `parseQuery is not a function`.

- [ ] **Step 4: Write `QUERY_KEYWORDS`**

One row per line of spec §2's table, in that order. `example` must be a string `parseQuery` turns into exactly one predicate or tag — Task 5 asserts this, so get it right here. Example rows:

```ts
export const QUERY_KEYWORDS: readonly KeywordSpec[] = [
  { target: "typeLine", keywords: ["t", "type"], defaultOp: "colon", ops: ["colon", "eq"],
    example: "t:goblin", blurb: "Card type line" },
  { target: "oracleText", keywords: ["o", "oracle"], defaultOp: "colon", ops: ["colon", "eq"],
    example: 'o:"draw a card"', blurb: "Rules text" },
  { target: "keyword", keywords: ["kw", "keyword"], defaultOp: "colon", ops: ["colon", "eq"],
    example: "kw:flying", blurb: "Keyword ability" },
  { target: "artist", keywords: ["a", "artist"], defaultOp: "colon", ops: ["colon", "eq"],
    example: "a:avon", blurb: "Illustrator" },
  { target: "colors", keywords: ["c", "color", "colour"], defaultOp: "gte",
    ops: ["colon", "eq", "ne", "gt", "gte", "lt", "lte"],
    example: "c>=rg", blurb: "Card colours" },
  { target: "colorIdentity", keywords: ["id", "identity", "ci"], defaultOp: "lte",
    ops: ["colon", "eq", "ne", "gt", "gte", "lt", "lte"],
    example: "id<=wu", blurb: "Colour identity" },
  { target: "cmc", keywords: ["cmc", "mv", "manavalue"], defaultOp: "eq",
    ops: ["colon", "eq", "ne", "gt", "gte", "lt", "lte"],
    example: "cmc>=3", blurb: "Mana value" },
  { target: "power", keywords: ["pow", "power"], defaultOp: "eq",
    ops: ["colon", "eq", "ne", "gt", "gte", "lt", "lte"],
    example: "pow>=4", blurb: "Power" },
  { target: "toughness", keywords: ["tou", "tough", "toughness"], defaultOp: "eq",
    ops: ["colon", "eq", "ne", "gt", "gte", "lt", "lte"],
    example: "tou<=2", blurb: "Toughness" },
  { target: "rarity", keywords: ["r", "rarity"], defaultOp: "eq",
    ops: ["colon", "eq", "ne", "gt", "gte", "lt", "lte"],
    example: "r>=rare", blurb: "Rarity, ordered" },
  { target: "setCode", keywords: ["s", "set", "e", "edition"], defaultOp: "eq",
    ops: ["colon", "eq"], example: "s:neo", blurb: "Set code" },
  { target: "format", keywords: ["f", "format", "legal"], defaultOp: "eq",
    ops: ["colon", "eq"], example: "f:modern", blurb: "Format legality" },
  { target: { tag: "oracle" }, keywords: ["otag", "oracletag", "function"],
    defaultOp: "colon", ops: ["colon"], example: "otag:removal", blurb: "Oracle tag — what it does" },
  { target: { tag: "art" }, keywords: ["atag", "arttag", "art"],
    defaultOp: "colon", ops: ["colon"], example: "atag:dragon", blurb: "Art tag — what it shows" },
];
```

Build the lookup map from it with the existing `keywordKey` (case folded, separators dropped) so `MANAVALUE:` and `mana-value:` are one keyword for free.

- [ ] **Step 5: Widen the term pattern**

Replace `TERM` with an operator-aware scan. **Longest match first** — order the alternation `>=|<=|!=|:|=|>|<` so `>=` cannot be read as `>` then a value starting `=`:

```ts
const TERM = /^(-?)([A-Za-z][A-Za-z0-9_-]*)(>=|<=|!=|:|=|>|<)([\s\S]*)$/;

const OP_BY_SIGN: Record<string, PredicateOp> = {
  ":": "colon", "=": "eq", "!=": "ne", ">": "gt", ">=": "gte", "<": "lt", "<=": "lte",
};
```

In `tokenFrom`, after resolving the keyword: an operator the spec's `ops` list does not allow makes the chunk `"text"`, not an error. A `colon` op resolves to the keyword's `defaultOp` for every field whose default is not `colon` (colors, colorIdentity, cmc, power, toughness, rarity, setCode, format) — so `c:rg` becomes `gte` and `cmc:3` becomes `eq`, while `t:goblin` stays `colon`.

Validate the value per field and return `"text"` when it does not parse:
- `cmc`/`power`/`toughness`: a number, **or** the literal `*` (spec §6.1).
- `colors`/`colorIdentity`: letters from `wubrgc` only, case-insensitive.
- `rarity`: one of `common`/`uncommon`/`rare`/`mythic` (also accept `c`/`u`/`r`/`m`).
- everything else: any non-empty string.

- [ ] **Step 6: Write `parseQuery`**

Same scanner loop as `parseTagQuery`, but the three-way answer becomes four: `"text"`, `"partial"`, a `TagToken`, or a `PredicateToken`. Keep `parseTagQuery` exported and working — it is `parseQuery` with the predicates dropped — so nothing that still calls it breaks mid-fan-out.

- [ ] **Step 7: Run the tests**

Run: `npx vitest run src/features/search/queryLanguage.test.ts`
Expected: PASS, including every test that came over from `tagQuery.test.ts` unchanged.

- [ ] **Step 8: Commit**

```bash
git add src/features/search/queryLanguage.ts src/features/search/queryLanguage.test.ts
git commit -m "feat(search): widen the tagger grammar into a query language"
```

---

### Task 2: The Rust predicate engine and the wire

**Files:**
- Modify: `src-tauri/src/filters.rs` — the types, `push_card_filters`, the FTS builder
- Modify: `src-tauri/src/search.rs:809` area, `src-tauri/src/collection.rs:1956` area, `src-tauri/src/wishlist.rs:1232` area — the three callers
- Modify: `src/lib/ipc.ts` (the mirror), `src/lib/ipc.test.ts` (the drift fence)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: the Rust block in "The pinned interface", plus the TS mirror `QueryPredicate`/`PredicateField`/`PredicateOp` exported from `@/lib/ipc`, and `predicates?: QueryPredicate[]` on `SearchRequest`, `CollectionQuery["cards"]` and `WishlistQuery["cards"]`. Task 4 sends these.

**Read first:** spec §4, §5 and §6.1. Then `push_card_filters`' own doc comment at `filters.rs:225-239` — the `alias`/`rows` asymmetry and the orphan rule are load-bearing and you must not break them.

- [ ] **Step 1: Write the failing test for a single predicate**

In `filters.rs`'s `#[cfg(test)]` module, following the existing `push_card_filters` test idiom:

```rust
#[test]
fn a_type_line_predicate_is_left_to_the_fts_builder() {
    let f = CardFilters {
        predicates: Some(vec![QueryPredicate {
            field: PredicateField::TypeLine, op: PredicateOp::Colon,
            value: "goblin".into(), negated: false,
        }]),
        ..Default::default()
    };
    let mut p = Predicates::default();
    push_card_filters(&mut p, &f, "c", None);
    // Not a WHERE clause — it rides the MATCH. A field handled by neither
    // side is a filter that silently does nothing, which is what this pins.
    assert!(p.wheres.is_empty(), "type line must not become SQL: {:?}", p.wheres);
}

#[test]
fn a_cmc_predicate_becomes_a_comparison() {
    let f = CardFilters {
        predicates: Some(vec![QueryPredicate {
            field: PredicateField::Cmc, op: PredicateOp::Gte,
            value: "3".into(), negated: false,
        }]),
        ..Default::default()
    };
    let mut p = Predicates::default();
    push_card_filters(&mut p, &f, "c", None);
    assert_eq!(p.wheres.len(), 1);
    assert!(p.wheres[0].contains("c.cmc"), "{}", p.wheres[0]);
    assert!(p.wheres[0].contains(">="), "{}", p.wheres[0]);
}
```

- [ ] **Step 2: Run and watch it fail**

Run: `cd src-tauri && cargo test --lib filters::tests::a_cmc_predicate`
Expected: FAIL to compile — `QueryPredicate` not found.

- [ ] **Step 3: Add the types**

Exactly the Rust block from "The pinned interface", plus `predicates: Option<Vec<QueryPredicate>>` on `CardFilters`. `CardFilters` already carries `#[serde(rename_all = "camelCase", default)]`, so the new field needs nothing extra.

- [ ] **Step 4: Emit the SQL in `push_card_filters`**

One match arm per field. **`PredicateField::TypeLine` and `PredicateField::OracleText` are skipped with a comment saying the FTS builder owns them** — a bare `_ => {}` would hide the next field somebody forgets, so match all twelve explicitly.

Per field, against `{alias}`:
- `Cmc` → `CAST({alias}.cmc AS REAL) <op> ?`
- `Power`/`Toughness` → the value `*` is string equality (`{alias}.power = '*'`); anything else is `CAST({alias}.power AS REAL) <op> ?`. Spec §6.1 — `CAST` yields `0.0` for `*`, which matches Scryfall's measured `pow>=0` = `pow>=*` = 19,128.
- `Artist` → `instr(lower({alias}.artist), lower(?)) > 0`
- `Keyword` → spec §6's two-arm bridge, verbatim:
  `({alias}.keywords IS NOT NULL AND instr({alias}.keywords, ?) > 0) OR ({alias}.keywords IS NULL AND instr(lower({alias}.search_text), lower(?)) > 0)`
  with the first `?` bound to the value lowercased **and delimiter-wrapped** (`|flying|`) so `kw:fly` cannot match `flying` — Scryfall refuses `kw:fly` outright, measured.
- `Colors`/`ColorIdentity` → letter-set logic over `{alias}.colors` / `{alias}.color_identity`. `gte` = has at least each named letter; `lte` = has no letter outside the named set (the existing subset idiom in this file — reuse it, do not re-derive it); `eq` = both; `gt`/`lt` = the same plus "not equal"; `ne` = not `eq`.
- `Rarity` → `=` on `{alias}.rarity` for `eq`; for the ordered ops expand to an `IN (…)` over `common < uncommon < rare < mythic`.
- `SetCode` → reuse the existing `set_code` expression built at the top of the function, so the collection's coalesce rule is not bypassed.
- `Format` → reuse `crate::legalities::bit`, exactly as the existing `f.format` arm does.

`negated: true` wraps the clause in `NOT (…)`.

- [ ] **Step 5: Run the two tests**

Run: `cd src-tauri && cargo test --lib filters::tests::a_cmc_predicate filters::tests::a_type_line`
Expected: PASS.

- [ ] **Step 6: Write the failing test for the FTS builder**

```rust
#[test]
fn a_positive_type_term_joins_the_match_string() {
    let preds = vec![QueryPredicate {
        field: PredicateField::TypeLine, op: PredicateOp::Colon,
        value: "goblin".into(), negated: false,
    }];
    let (m, neg) = fts_match(Some("bolt"), &preds);
    let m = m.unwrap();
    assert!(m.contains("type_line :"), "{m}");
    assert!(neg.is_empty());
}

#[test]
fn a_purely_negative_term_produces_no_match_string() {
    // FTS5's NOT is binary — `NOT x` alone is a syntax error, so a query that
    // is only `-t:goblin` has to become a NOT IN subquery instead.
    let preds = vec![QueryPredicate {
        field: PredicateField::TypeLine, op: PredicateOp::Colon,
        value: "goblin".into(), negated: true,
    }];
    let (m, neg) = fts_match(None, &preds);
    assert!(m.is_none());
    assert_eq!(neg.len(), 1);
    assert!(neg[0].contains("type_line :"), "{}", neg[0]);
}
```

- [ ] **Step 7: Write `fts_match`**

```rust
/// The FTS side of a parsed query: the positive MATCH string, and one MATCH
/// string per negated text term for a `rowid NOT IN (…)` subquery.
///
/// **Negatives are never folded into the MATCH.** FTS5's `NOT` is binary, so
/// `-t:goblin` on its own has no left operand and is a syntax error. Splitting
/// unconditionally is uniform and cheaper to reason about than deciding per query.
///
/// `text` is `None` for the wishlist, whose free text is a `LIKE` over its own
/// denormalised name column so that an orphan wish still answers a name search.
pub fn fts_match(text: Option<&str>, preds: &[QueryPredicate]) -> (Option<String>, Vec<String>)
```

Positive terms join with a space (FTS5's implicit AND). A term's column is `type_line` for `TypeLine` and `search_text` for `OracleText`; the value goes through the same tokenise-and-prefix treatment `fts_query` already applies, then is wrapped as `{col} : (tokens)`.

- [ ] **Step 8: Run and commit the engine**

Run: `cd src-tauri && cargo test --lib filters::`
Expected: PASS, and every pre-existing `filters` test still green.

```bash
cd src-tauri && cargo fmt && cargo clippy --all-targets -- -D warnings
git add src-tauri/src/filters.rs && git commit -m "feat(search): typed query predicates in the shared card filter"
```

- [ ] **Step 9: Wire the three callers**

Each already calls `push_card_filters(&mut p, …, "c", …)` and gets the predicate SQL for free. What each needs is the FTS half:

- `search.rs` — replace the `fts_query` call with `fts_match(req.text.as_deref(), preds)`; the positive string feeds the existing `cards_fts MATCH ?` join, each negative becomes `c.rowid NOT IN (SELECT rowid FROM cards_fts WHERE cards_fts MATCH ?)`.
- `collection.rs` — same, into the existing `c.rowid IN (SELECT rowid FROM cards_fts WHERE cards_fts MATCH ?)` subquery at `:1925-1943`. **Keep it a subquery, not a join** — the comment there says why (a LEFT JOIN lets orphans through).
- `wishlist.rs` — **leave the free-text `LIKE` at `:1233` exactly as it is** and add the FTS subquery only when `fts_match(None, preds)` returns something. Call it with `None` text, never with `q.cards.text`.

- [ ] **Step 10: Write the three-caller test**

This is the design's central bet and nothing else checks it. In whichever of the three files already has a seeded-corpus fixture, assert that one `predicates` payload (`t:goblin`) narrows `search_cards`, `collection_list` **and** `wishlist_list`, and that an orphan row — an entry whose `card_id` has no `cards` row — is excluded by it.

- [ ] **Step 10b: Keep the facet mirror honest**

`src-tauri/src/index/facets.rs` is a **second, in-memory implementation** of what `push_card_filters` answers — its module doc says so at `:14`, and it builds its own FTS bitset at `:793-813` through the same `fts_query` you just replaced.

Two things are needed and no more:

1. **`t:`/`o:` must narrow the facet counts.** Point `run_facets` at `fts_match` so the bitset it folds is built from the same string the search uses. Spec §5.2 — this is the "rides the bitset for free" claim, and it is only free if you make this call.
2. **Every other predicate is left alone, deliberately.** The in-memory index carries no power, toughness, artist or card-colour dimension (`index/mod.rs:45-103`), so those predicates leave facet counts **wider than the result set**. That is spec §7's fail-open decision, not an oversight: a count that is too high is cosmetic, a chip that vanished is a filter the reader cannot reach. **Write that as a comment where the predicates are ignored**, or the next reader will file it as a bug.

Do **not** grow the index. Spec §11 puts that out of scope.

- [ ] **Step 11: Mirror it in TS and fence it**

`src/lib/ipc.ts`: export `PredicateField`, `PredicateOp`, `QueryPredicate` matching the Rust enums' camelCase serde names exactly, and add `predicates?: QueryPredicate[]` to `SearchRequest`, to `CollectionQuery["cards"]` and to `WishlistQuery["cards"]`. Add the new shape to `ipc.test.ts`'s drift fence — it is the only thing catching Rust↔TS skew here, and `vi.fn()` mocks erase the mirror, so a missing field fails at runtime rather than at `tsc`.

- [ ] **Step 12: Commit**

```bash
cd src-tauri && cargo fmt && cargo clippy --all-targets -- -D warnings
git add -A src-tauri/src src/lib/ipc.ts src/lib/ipc.test.ts
git commit -m "feat(search): carry query predicates to all three card searches"
```

---

### Task 3: Corpus schema 5 — `cards.keywords`

**Files:**
- Modify: `src-tauri/src/schema.rs`, `src-tauri/src/card_row.rs`, `src-tauri/src/ingest.rs`

**Interfaces:**
- Consumes: nothing.
- Produces: a `keywords TEXT` column on `cards`, holding the card's keywords **lowercased, delimited and wrapped** — `|flying|vigilance|` — or NULL on a row that predates the rung. Task 2's `Keyword` arm matches `instr(keywords, '|flying|')` against exactly this format. Do not change the delimiter without telling Task 2.

**Read first:** spec §6, then `schema.rs`'s `produced_mana_is_owed` and `add_produced_mana` (around `:6570-6620`). **You are copying that rung in every respect.** Also read `src-tauri/CLAUDE.md` on migrations before writing anything.

- [ ] **Step 1: Write the four failing rung tests**

In `schema.rs`'s test module, mirroring the existing `produced_mana` rung tests: the ALTER is owed on a corpus without the column; it is **not** owed once applied; it is **not** owed when `cards` does not exist at all (`PRAGMA table_info` on a missing table is empty, and `ALTER` on one raises — a launch must survive a repair it cannot carry out); and the column lands on the **corpus**, not on `user.db`.

- [ ] **Step 2: Run and watch them fail**

Run: `cd src-tauri && cargo test --lib schema::tests::` (filter to your new names)
Expected: FAIL — the functions do not exist.

- [ ] **Step 3: Add the rung**

`CORPUS_SCHEMA_VERSION` 4 → **5**. Add `keywords_are_owed` (gated on `PRAGMA {schema}.table_info(cards)` **by column name**, never on `sqlite_master`'s text — `cards` is dropped and recreated by `swap_staging` every sync, so a text probe re-issues the ALTER and dies at `duplicate column name` on exactly the databases that are already correct) and `add_keywords` (`ALTER TABLE {schema}.cards ADD COLUMN keywords TEXT;`, schema-qualified through `on_schema`). Hang both off `migrate_corpus` beside schema 3's, gated on the shape and not on `v < CORPUS_SCHEMA_VERSION`. Add `keywords TEXT` to the tail of `CORPUS_SCHEMA_SQL`.

**No backfill** — `raw` is a gzip BLOB and `json_extract` over one is a hard error. **No `cards_fts` rebuild** — an unindexed column renumbers no rowid. **No `CARDS_INDEXES` entry.**

⚠️ Before you commit, check `main` has not taken corpus schema 5 in the meantime; renumber if it has, and check fixture names for collisions too.

- [ ] **Step 4: Extract the column at ingest**

`card_row.rs`: add `pub keywords: Option<String>` and fill it from the Scryfall `keywords` array — verified live, Serra Angel is `["Flying", "Vigilance"]`. Lowercase each, join delimited and wrapped: `|flying|vigilance|`. An empty or absent array is `None`, **not** `Some("|")` — a card with no keywords must fail `kw:` rather than match a bare delimiter. Add a unit test for both.

`ingest.rs`: add `keywords` to the INSERT column list and the bind. **Check `ingest.rs:630-702`** — there is a swap-detection fixture listing column-to-sentinel pairs that will need the new column, and its comment explains why.

- [ ] **Step 5: Run**

Run: `cd src-tauri && cargo test --lib schema:: card_row:: ingest::`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd src-tauri && cargo fmt && cargo clippy --all-targets -- -D warnings
git add -A src-tauri/src
git commit -m "feat(corpus): schema 5 gives cards their keywords column"
```

---

### Task 4: Wiring every search box

**Runs after Tasks 1 and 2 land.**

**Files:**
- Modify: `src/features/search/useCardSearch.ts`, `useCardSearch.test.ts`, `TagQueryRow.tsx`, `TagQueryRow.test.tsx`, `FilterBar.test.tsx`
- Modify: `src/features/collection/useCollection.ts`, `src/features/decks/useCollectionSearch.ts`, `src/features/wishlist/useWishlist.ts`
- Modify: `src/features/decks/QuickAdd.tsx`, `src/features/decks/DeckCoverPicker.tsx`

**Interfaces:**
- Consumes: `parseQuery`, `PredicateToken`, `TagToken`, `removeToken`, `setTokenNegated`, `setTokenValue`, `tokenKey` from `@/features/search/queryLanguage` (Task 1); `QueryPredicate` from `@/lib/ipc` (Task 2).
- Produces: nothing other tasks consume.

**Read first:** spec §7 and §8. `useCardSearch`'s `tagQueryBlocked` gate is load-bearing and **must keep gating on tags only** — predicates cannot be "unknown", so they must never hold a search closed.

- [ ] **Step 1: Repoint `useCardSearch`**

Change its import from `./tagQuery` to `./queryLanguage`, swap `parseTagQuery` for `parseQuery`, and send `parsed.predicates` (stripped of `start`/`end`) as `predicates` on the `SearchRequest`. Strip the spans — they are the box's business, not the backend's, and sending them makes two query keys out of one query.

**Leave `tagQueryBlocked` reading `parsed.tags` alone.** A predicate must not gate.

- [ ] **Step 2: Write the test that a predicate does not gate**

```ts
it("fires immediately for a predicate, since a predicate cannot be unknown", () => {
  // Tags gate the query closed while they resolve; predicates must not, or
  // every `t:` keystroke would blank the wall waiting for a resolve that
  // never comes.
  const { result } = renderHook(() => useCardSearch(), { wrapper });
  act(() => { result.current.setText("t:goblin"); });
  // …assert the search is enabled and no tag resolve was requested.
});
```

- [ ] **Step 3: Teach the three entry hooks to parse**

`useCollection.ts`, `useCollectionSearch.ts` and `useWishlist.ts` each debounce a raw string into `cards.text` today. Each becomes: parse the debounced string, send `text: parsed.text || undefined` and `predicates: parsed.predicates.length ? stripped : undefined`.

These three have no tag support and gain none here — tags need `tag_resolve` wiring and a chip row, which is out of scope. A tag keyword typed into the collection box therefore parses as a tag token and is **dropped**, which would silently widen the search. Prevent that: in these three hooks, fold any `parsed.tags` back into the free text so the reader gets a name search rather than no filter. Add a test for it in whichever of the three has a hook test already.

- [ ] **Step 4: Wire the two direct callers**

`QuickAdd.tsx:95` and `:159`, and `DeckCoverPicker.tsx:141`, call `ipc.searchCards({ text: … })` with a raw string. Parse first and pass both fields, same shape as Step 1.

- [ ] **Step 5: Fix the chip row**

`TagQueryRow.tsx` draws chips for tag tokens. Predicates need chips too, or a reader has no way to see or remove one. Draw them with the same `TagChips` component, labelled with the keyword the reader typed, and wire ✕ to `removeToken` and the include/exclude press to `setTokenNegated` exactly as tags already do. Deduplicate by `field + op + value`.

- [ ] **Step 6: Run the frontend suite for these files**

Run: `npx vitest run src/features/search src/features/collection/useCollection.test.ts src/features/wishlist src/features/decks/QuickAdd.test.tsx`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A src/features
git commit -m "feat(search): read the query language in every card search box"
```

---

### Task 5: The F1 panel gains a Search syntax tab

**Files:**
- Create: `src/components/QuerySyntaxHelp.tsx`
- Modify: `src/components/KeyMap.tsx`, `src/components/KeyMap.test.tsx`, `src/components/KeyMap.stories.tsx`

**Interfaces:**
- Consumes: `QUERY_KEYWORDS`, `KeywordSpec`, `parseQuery` from `@/features/search/queryLanguage` (Task 1).
- Produces: nothing other tasks consume.

**Read first:** spec §9, the whole of `KeyMap.tsx` (its doc comments explain the disclosure pattern, the CSP constraint on inline styles, and why it carries no `LAYER` rung), and `src/CLAUDE.md`.

- [ ] **Step 1: Write the failing test that the panel cannot lie**

```tsx
it("draws only keywords the parser actually reads", () => {
  // shortcuts.ts's principle, one module over: the panel and the parser read
  // one table, so the panel cannot advertise a keyword nothing parses.
  for (const spec of QUERY_KEYWORDS) {
    const parsed = parseQuery(spec.example);
    expect(
      parsed.predicates.length + parsed.tags.length,
      `${spec.example} did not parse to exactly one term`,
    ).toBe(1);
    expect(parsed.text, `${spec.example} leaked free text`).toBe("");
  }
});

it("shows shortcuts first and switches to syntax on the tab", async () => {
  // …render the open panel, assert a chord row is present, click "Search
  // syntax", assert `t:goblin` is present and the chord row is gone.
});

it("opens on Shortcuts again after being closed", async () => {
  // A reader who opened F1 for a chord should find chords.
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run src/components/KeyMap.test.tsx`
Expected: FAIL — no tab exists.

- [ ] **Step 3: Build `QuerySyntaxHelp`**

A `<dl>` in the same two-column grid `KeyMap` uses, one row per `QUERY_KEYWORDS` entry: the keyword spellings joined with `·` and the `example` in the app's mono face as the term, the `blurb` as the description. Reuse `KeyMap`'s `SECTION` caption style for group headings. Add a short note that terms AND together and `-` excludes — and **do not** write the keyword list a second time in prose.

Follow `src/CLAUDE.md` and the `frontend-design` skill. Do not introduce a colour token that does not exist; a mistyped Tailwind arbitrary value emits nothing at all.

- [ ] **Step 4: Add the tabs to `KeyMap`**

Two buttons at the top of the panel, `useState` local to the component, reset to `"shortcuts"` in the same effect that handles close. Use real `role="tab"`/`role="tabpanel"` semantics with `aria-selected` — the panel is a disclosure and a screen reader walking into it needs to know there are two.

Keep the panel `w-96`. If the syntax tab overflows, give **the tab panel** a `max-h` and `overflow-y-auto`, not the frame — the frame is what `usePopupPlacement` measures.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run src/components/KeyMap.test.tsx`
Expected: PASS.

- [ ] **Step 6: Add a story**

A `SearchSyntax` story with the panel open on the new tab, following `.storybook/CLAUDE.md`. Do not run the full story suite — it collects the whole tree and will fail on your siblings' half-finished files.

- [ ] **Step 7: Commit**

```bash
git add -A src/components
git commit -m "feat(shortcuts): a Search syntax tab in the F1 panel"
```

---

### Task 6: Documentation

**Files:**
- Rename + rewrite: `docs/reference/tag-search-syntax.md` → `docs/reference/search-syntax.md`
- Modify: `CLAUDE.md`, `src/CLAUDE.md`, `src-tauri/CLAUDE.md`

**Interfaces:** consumes the spec; produces nothing code depends on.

**Read first:** the whole of `docs/reference/tag-search-syntax.md` and the spec. The existing doc's voice — measured figures with dates and build kinds, and the *why* behind each rule — is the voice to keep.

- [ ] **Step 1: Rename and rewrite**

`git mv docs/reference/tag-search-syntax.md docs/reference/search-syntax.md`. Keep every still-true section (resolution through `slug_norm`, why substring is refused for tag *filters*, the muted-tag rule, `MAX_LOOKUPS`, the two fail-closed arms) and add the new material from spec §2, §5, §6 and §7.

**Delete the "`a:` and `o:` are a deliberate departure" section and replace it** with the reversal and its date. Do not leave both standing.

- [ ] **Step 2: Carry the measurements over**

Spec §5.2's FTS-vs-LIKE table, §2's Scryfall totals, §6's `kw:flying -o:flying` = 0. Name the corpus (117,738 cards) and the date (2026-09-22) for each, and say the timings came through `node:sqlite` — SQLite's own C, not a cargo profile.

- [ ] **Step 3: Update the three `CLAUDE.md` files**

Root `CLAUDE.md`: the reference-doc table row for `tag-search-syntax.md` needs its new name and a widened description. **Also update the "A _tag_ in this app is one of those two and nothing else" paragraph** — it now has to hold the line against `kw:`, which is a *keyword ability* and a fourth thing entirely. Say so; that vocabulary trap is exactly what that paragraph exists for.

`src/CLAUDE.md` and `src-tauri/CLAUDE.md`: fix every `tagQuery.ts` reference to `queryLanguage.ts`, and add the corpus schema 5 rung to whatever ladder `src-tauri/CLAUDE.md` keeps.

- [ ] **Step 4: Re-count anything countable**

A prose-only edit routes to neither CI job, so nothing goes red when a document rots. If you write a count, re-derive it in this commit.

- [ ] **Step 5: Commit**

```bash
git add -A docs CLAUDE.md src/CLAUDE.md src-tauri/CLAUDE.md
git commit -m "docs(search): rewrite the tag syntax reference as the query syntax reference"
```

---

### Task 7: Fan-in, verify, live pass — the orchestrator's

**Files:** whatever the merge needs.

- [ ] **Step 1: Sweep for unowned files**

`git status` and `git grep` every new symbol (`parseQuery`, `QUERY_KEYWORDS`, `QueryPredicate`, `predicates`, `keywords`) against the ownership table. `git grep` skips untracked files — use `git status` too. Anything nobody owned is the gap this step exists to find.

- [ ] **Step 2: Run the full verify, once**

Run: `npm run verify`
Do **not** pipe it into `tail` — the exit code would be `tail`'s. Do not run two verifies at once.

- [ ] **Step 3: `cargo fmt` and `cargo clippy`**

`npm run verify` runs neither, and CI runs both. They are the only reds a green verify allows.

- [ ] **Step 4: Live pass**

`npm run tauri dev` (take the `app` lock per the `running-the-app` skill), driven over CDP per `live-ui-verification.md`. Type each keyword into at least one surface; the collection and wishlist boxes are the ones nothing else proves. Record counts and the two measurements the spec asks for — §5.3's bare-`a:` timing and §6.1's `pow:*` behaviour — into `docs/reference/search-syntax.md`.

- [ ] **Step 5: Commit the measurements and open the PR**

Per the `auto-pr` skill. The PR body closes issue #485.
