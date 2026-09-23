import type { TagNamespace } from "@/lib/ipc";

/**
 * Scryfall's query syntax, read out of every card search box in this app.
 *
 * `t:goblin`, `o:"draw a card"`, `c>=rg`, `cmc>=3`, `-kw:flying`, `otag:removal` — the keyword
 * names a field or a taxonomy, the operator says how the value is compared, and everything the
 * parser does not recognise is left alone as free text for FTS. This module is the whole of the
 * grammar; `tagResolve` turns a tag value into a slug, `filters::TagTerms` is what the slugs
 * become, and `filters::QueryPredicate` is what everything else becomes.
 *
 * # Terms AND, `-` excludes, and there is still no `or`
 *
 * Scryfall's language also has `or`, parentheses and forty more keywords. None of that is here,
 * because the backend composes by conjunction: every term becomes its own clause and they are
 * ANDed, so `or` would need new SQL in `filters.rs` *and* a matching change in
 * `index/facets.rs` — materially more work than this whole feature. A reader who types `or`
 * gets it as free text.
 *
 * # `a:` and `o:` are Scryfall's again, since 2026-09-22
 *
 * From 2026-08-22 (`81251d3b`) to 2026-09-22 this module read `a:` as the *art taxonomy* and
 * `o:` as the *oracle taxonomy*, on the argument that `atag:`/`otag:` are the spellings nobody
 * mistypes. That is reversed: **`a:` is the artist and `o:` is the card's rules text**, which is
 * what they mean on Scryfall and what a reader carrying that muscle memory expects. Both
 * taxonomies keep every unambiguous spelling they had — `otag:` `oracletag:` `function:`
 * `oracle_tag:` `oracle-tag:`, and `atag:` `arttag:` `art_tag:` `art-tag:` `art:`. Only the two
 * single letters moved. Nothing persists a query string, so there is no migration; the cost is
 * paid by a reader who typed `o:ramp` for a tag and now gets rules text, in a search that
 * returns the wrong thing rather than an error — the same cost the original departure accepted,
 * now paid in the other direction.
 *
 * # Every alias is Scryfall's, verified rather than guessed
 *
 * The art-tags research measured all of them live against `api.scryfall.com/cards/search` on
 * 2026-08-20: `art:` `atag:` `arttag:` `art_tag:` all answer 1,145 for `dragon`, and `otag:`
 * `oracletag:` `function:` `oracle_tag:` `oracle-tag:` all answer 6,428 for `removal`, while
 * `itag:`, `ftag:` and `otags:` are HTTP 400. **`art:` therefore stays a tag keyword** where the
 * two single letters did not — it is one on Scryfall too. Separators are normalised out of the
 * *keyword* as well as the value, which is why the `_` and `-` spellings work and why
 * {@link keywordKey} strips them rather than {@link QUERY_KEYWORDS} listing six variants of two
 * words.
 */

/**
 * Every column a predicate can name — mirrored by `filters::PredicateField` in Rust, whose
 * `#[serde(rename_all = "camelCase")]` is what makes these exact strings the wire format.
 *
 * `typeLine` and `oracleText` are the two that are **not** SQL at the far end: they ride the
 * FTS5 MATCH string instead, because `LIKE` over the real corpus measured 80–250× slower than a
 * column-filtered MATCH. They travel in the same list as the rest anyway, so the parser has one
 * answer rather than two, and `push_card_filters` skips them by name.
 */
export type PredicateField =
  | "typeLine"
  | "oracleText"
  | "keyword"
  | "artist"
  | "colors"
  | "colorIdentity"
  | "cmc"
  | "power"
  | "toughness"
  | "rarity"
  | "setCode"
  | "format";

/**
 * The seven comparisons, named rather than punctuated so the wire carries no mini-language.
 *
 * `colon` survives resolution only where `:` is genuinely its own thing — a substring-ish match
 * on a type line or a tag — because every other field resolves `:` to its own default. See
 * {@link KeywordSpec.defaultOp}.
 */
export type PredicateOp = "colon" | "eq" | "ne" | "gt" | "gte" | "lt" | "lte";

/** One structured term, in the shape `filters::QueryPredicate` deserialises. */
export interface QueryPredicate {
  field: PredicateField;
  op: PredicateOp;
  value: string;
  negated: boolean;
}

/**
 * A predicate plus where it sits in the box, so a chip can rewrite the text.
 *
 * The spans are {@link TagToken}'s and exist for {@link removeToken}'s reason — a chip drawn
 * from a term the reader cannot remove would be a control that lies. They are the *box's*
 * business and are stripped before the list crosses IPC, or two identical searches would make
 * two query keys.
 */
export interface PredicateToken extends QueryPredicate {
  start: number;
  end: number;
}

/**
 * A tag the reader named, and where in the box they named it.
 *
 * `start`/`end` are what make the chips honest: a chip drawn from a token the reader cannot
 * remove would be a control that lies, so {@link removeToken} splices the source text instead of
 * the box keeping a second, editable copy of the query beside the one on screen.
 */
export interface TagToken {
  namespace: TagNamespace;
  /** What sat after the keyword, unquoted and untrimmed of nothing else. Never blank — see
   *  {@link parseQuery}. */
  value: string;
  /** `-otag:ramp`. Decides which of `TagTerms`' two lists the resolved slug lands in. */
  negated: boolean;
  /** Where the whole term — the `-`, the keyword, the operator and the value — sits in the
   *  source. Half-open, so `input.slice(start, end)` is the term. */
  start: number;
  end: number;
}

/** What one query string says: the tags, and whatever is left for FTS. */
export interface ParsedTagQuery {
  /** The unrecognised words, rejoined with single spaces. This is what rides as
   *  `SearchRequest.text`, so `dragon atag:dragon` searches the name *and* filters by the
   *  motif. */
  text: string;
  tokens: TagToken[];
}

/** What one query string says, in full: the free text, the tags, and the typed predicates. */
export interface ParsedQuery {
  /** The unrecognised words, rejoined with single spaces — `SearchRequest.text`. */
  text: string;
  tags: TagToken[];
  predicates: PredicateToken[];
}

/**
 * A keyword's identity: lowercased with every separator dropped.
 *
 * Scryfall normalises separators out of the keyword as well as out of the value, which is why
 * `oracle_tag:` and `oracle-tag:` both work there. Doing the same here means the table below
 * lists the real names rather than six spellings of them — `MANAVALUE:` and `mana-value:` are
 * one keyword for free — and it is a different function from the *value's* normalisation, which
 * is Rust's (`tags::normalize`) and must stay Rust's: two copies of the value rule would leave
 * both halves self-consistent and the search matching nothing.
 */
function keywordKey(word: string): string {
  return word.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
}

/**
 * One row of the vocabulary. The parser and the F1 panel are its two readers.
 *
 * `shortcuts.ts`' principle, one module over: a panel that draws its rows from the same table
 * the parser reads cannot advertise a keyword nothing parses. `TAG_KEYWORDS` — a
 * `Record<TagNamespace, string[]>` exported here for a help text that was never built — was
 * absorbed into this table on 2026-09-22 and deleted, because two lists of keywords is exactly
 * the drift one table exists to prevent.
 */
export interface KeywordSpec {
  /** A predicate field, or the tag taxonomy this keyword names. */
  target: PredicateField | { tag: TagNamespace };
  keywords: readonly string[];
  /**
   * What a bare `:` means for this keyword, which is **not** the same answer twice.
   *
   * Measured on Scryfall 2026-09-22: `c:rg` = `c>=rg` = 676 cards, while `id:rg` = `id<=rg` =
   * 13,399 — `c:` asks "has at least these colours" and `id:` asks "fits in this identity". A
   * single rule for `:` would get one of them wrong, so each row states its own.
   */
  defaultOp: PredicateOp;
  /** The operators this keyword accepts. One it does not is free text, never an error. */
  ops: readonly PredicateOp[];
  /** Shown in the F1 panel. Must parse — `KeyMap.test.tsx` asserts it. */
  example: string;
  /** One short sentence for the F1 panel. */
  blurb: string;
}

/** Everything a row with a numeric or ordered field accepts. */
const COMPARISONS: readonly PredicateOp[] = ["colon", "eq", "ne", "gt", "gte", "lt", "lte"];

/**
 * The whole vocabulary, in the order the F1 panel draws it.
 *
 * A row added here is read by the parser and drawn by the panel with no second edit, which is
 * the point of there being one table. Keywords must be unique across rows after
 * {@link keywordKey} — `queryLanguage.test.ts` pins that, because a collision is a silent `Map`
 * overwrite rather than an error.
 */
export const QUERY_KEYWORDS: readonly KeywordSpec[] = [
  {
    target: "typeLine",
    keywords: ["t", "type"],
    defaultOp: "colon",
    ops: ["colon", "eq"],
    example: "t:goblin",
    blurb: "Card type line",
  },
  {
    target: "oracleText",
    keywords: ["o", "oracle"],
    defaultOp: "colon",
    ops: ["colon", "eq"],
    example: 'o:"draw a card"',
    blurb: "Rules text",
  },
  {
    target: "keyword",
    keywords: ["kw", "keyword"],
    defaultOp: "colon",
    ops: ["colon", "eq"],
    example: "kw:flying",
    blurb: "Keyword ability",
  },
  {
    target: "artist",
    keywords: ["a", "artist"],
    defaultOp: "colon",
    ops: ["colon", "eq"],
    example: "a:avon",
    blurb: "Illustrator",
  },
  {
    target: "colors",
    keywords: ["c", "color", "colour"],
    defaultOp: "gte",
    ops: COMPARISONS,
    example: "c>=rg",
    blurb: "Card colours",
  },
  {
    target: "colorIdentity",
    keywords: ["id", "identity", "ci"],
    defaultOp: "lte",
    ops: COMPARISONS,
    example: "id<=wu",
    blurb: "Colour identity",
  },
  {
    target: "cmc",
    keywords: ["cmc", "mv", "manavalue"],
    defaultOp: "eq",
    ops: COMPARISONS,
    example: "cmc>=3",
    blurb: "Mana value",
  },
  {
    target: "power",
    keywords: ["pow", "power"],
    defaultOp: "eq",
    ops: COMPARISONS,
    example: "pow>=4",
    blurb: "Power",
  },
  {
    target: "toughness",
    keywords: ["tou", "tough", "toughness"],
    defaultOp: "eq",
    ops: COMPARISONS,
    example: "tou<=2",
    blurb: "Toughness",
  },
  {
    target: "rarity",
    keywords: ["r", "rarity"],
    defaultOp: "eq",
    ops: COMPARISONS,
    example: "r>=rare",
    blurb: "Rarity, ordered",
  },
  {
    target: "setCode",
    keywords: ["s", "set", "e", "edition"],
    defaultOp: "eq",
    ops: ["colon", "eq"],
    example: "s:neo",
    blurb: "Set code",
  },
  {
    target: "format",
    keywords: ["f", "format", "legal"],
    defaultOp: "eq",
    ops: ["colon", "eq"],
    example: "f:modern",
    blurb: "Format legality",
  },
  {
    target: { tag: "oracle" },
    keywords: ["otag", "oracletag", "function"],
    defaultOp: "colon",
    ops: ["colon"],
    example: "otag:removal",
    blurb: "Oracle tag — what it does",
  },
  {
    target: { tag: "art" },
    keywords: ["atag", "arttag", "art"],
    defaultOp: "colon",
    ops: ["colon"],
    example: "atag:dragon",
    blurb: "Art tag — what it shows",
  },
];

/** {@link QUERY_KEYWORDS} by {@link keywordKey}, so `art_tag`, `art-tag` and `ARTTAG` are one. */
const SPEC_BY_KEYWORD = new Map<string, KeywordSpec>(
  QUERY_KEYWORDS.flatMap((spec) => spec.keywords.map((word) => [keywordKey(word), spec] as const)),
);

/**
 * `keyword<op>value`, with the optional leading `-`.
 *
 * **Longest match first.** The alternation is ordered `>=|<=|!=|:|=|>|<` so `cmc>=3` can never
 * be read as `>` followed by a value beginning `=`; a shorter sign first would match and the
 * regex would never back up to try the longer one. The value is whatever the scanner decided the
 * term was, quotes and all — {@link unquote} deals with those.
 */
const TERM = /^(-?)([A-Za-z][A-Za-z0-9_-]*)(>=|<=|!=|:|=|>|<)([\s\S]*)$/;


const OP_BY_SIGN: Record<string, PredicateOp> = {
  ":": "colon",
  "=": "eq",
  "!=": "ne",
  ">": "gt",
  ">=": "gte",
  "<": "lt",
  "<=": "lte",
};

/** A whole number or a half — Unstable printed `cmc:3.5`. A leading `-` is a loyalty thing. */
const NUMERIC = /^-?\d+(?:\.\d+)?$/;

/** Scryfall's five colour letters plus `c` for colourless. */
const COLOR_LETTERS = /^[wubrgc]+$/i;

/**
 * Rarity is a closed vocabulary with an order, so the parser canonicalises it rather than
 * handing Rust a letter to guess at.
 *
 * Measured on Scryfall 2026-09-22: `r>=rare` = 13,951 against `r:rare` = 11,856, so `:` here is
 * equality and the ordered operators expand over `common < uncommon < rare < mythic`. That
 * expansion is the SQL side's, and it can only do it against the full word — `r:c` reaching it
 * as `c` would compare `rarity = 'c'` and answer zero rows, silently.
 */
const RARITY_BY_WORD = new Map<string, string>([
  ["c", "common"],
  ["common", "common"],
  ["u", "uncommon"],
  ["uncommon", "uncommon"],
  ["r", "rare"],
  ["rare", "rare"],
  ["m", "mythic"],
  ["mythic", "mythic"],
]);

/**
 * The value a field will accept, canonicalised — or `null`, which makes the whole chunk free
 * text.
 *
 * **An unparseable value is text, never an error.** `cmc>=banana` is not a number, so the term
 * goes to FTS as the words the reader typed rather than being refused; that is the rule that
 * already makes `itag:dragon` free text, and it keeps the box's one failure mode about tags,
 * where it already is.
 *
 * `*` is a value for the three numeric fields and not a wildcard: a power can be `*`, `1+`, `X`
 * or `∞`, and Scryfall's own answers say `*` participates in comparisons rather than being
 * excluded from them (`pow>=0` = `pow>=*` = 19,128, while `pow:*` = 1,059 — a literal star,
 * matched as a string before any cast).
 */
function predicateValue(field: PredicateField, raw: string): string | null {
  switch (field) {
    case "cmc":
    case "power":
    case "toughness":
      return raw === "*" || NUMERIC.test(raw) ? raw : null;
    case "colors":
    case "colorIdentity":
      return COLOR_LETTERS.test(raw) ? raw : null;
    case "rarity":
      return RARITY_BY_WORD.get(raw.toLowerCase()) ?? null;
    default:
      return raw === "" ? null : raw;
  }
}

/**
 * Strip the quotes Scryfall allows around a value with a space in it.
 *
 * An *unterminated* opening quote is stripped too, because that is what the box holds for as
 * long as it takes to type the closing one: `otag:"spot removal` would otherwise resolve as a
 * tag literally called `"spot`, and the reader would watch an "unknown tag" note sit there
 * through the whole phrase. Rust normalises the quote away in the end either way — it is not
 * alphanumeric — so this is about what the *chip* says, not about what matches.
 */
function unquote(value: string): string {
  const quote = value[0];
  if (quote !== '"' && quote !== "'") return value;
  const rest = value.slice(1);
  return rest.endsWith(quote) ? rest.slice(0, -1) : rest;
}

/**
 * One whitespace-separated chunk of the source, read four ways.
 *
 * `"text"` is a chunk that is not a term at all and goes to FTS. A {@link TagToken} and a
 * {@link PredicateToken} are the two kinds of term. `"partial"` is a known keyword with nothing
 * usable after it yet — **neither a term nor free text**, and the distinction is what the
 * four-way answer exists for: as a token `otag:` would sit there reporting `""` as an unknown
 * tag through the whole of the next word, and as free text it would search the corpus for
 * `otag`. Every keystroke on the way to a term passes through that state, so it is the common
 * case rather than an edge one.
 *
 * **The operator is what makes a term, so a keyword with no operator is free text.** `otag:`
 * and `cmc>=` are partial because the operator says a term was intended and only the value is
 * missing. Bare `cmc` is not: it is a word.
 *
 * That distinction is load-bearing rather than tidy. Treating a bare keyword as partial drops it
 * from the query, and a query left with nothing in it is not "no results" — it is the
 * **unfiltered wall**. `art`, `set`, `type`, `power`, `legal`, `oracle`, `format`, `rarity`,
 * `colour`, `keyword`, `identity` and every single letter are all keywords, so a reader who
 * types `power` looking for *Power Conduit* would be shown their whole collection instead. Free
 * text answers that keystroke with the cards they asked for.
 */
function tokenFrom(
  chunk: string,
  start: number,
  end: number,
): TagToken | PredicateToken | "partial" | "text" {
  const m = TERM.exec(chunk);
  if (!m) return "text";
  const spec = SPEC_BY_KEYWORD.get(keywordKey(m[2]));
  if (!spec) return "text";
  const sign = m[3];
  if (!spec.ops.includes(OP_BY_SIGN[sign])) return "text";
  const value = unquote(m[4]).trim();
  if (value === "") return "partial";
  const negated = m[1] === "-";
  if (typeof spec.target !== "string") {
    return { namespace: spec.target.tag, value, negated, start, end };
  }
  const canonical = predicateValue(spec.target, value);
  if (canonical === null) return "text";
  // `:` is the one sign that does not mean itself: each row states what a bare colon asks, and
  // for eight of the twelve fields that is a comparison rather than a match.
  const op = sign === ":" ? spec.defaultOp : OP_BY_SIGN[sign];
  return { field: spec.target, op, value: canonical, negated, start, end };
}

/**
 * Split a query string into tag terms, typed predicates and the free text around them.
 *
 * The scan is whitespace-separated with one exception: a quote swallows spaces, so
 * `otag:"spot removal"` is one chunk and `spot` does not fall out of it into the FTS text.
 * Unbalanced quotes run to the end of the string, which is the state the box is in for as long
 * as it takes to type the closing one.
 *
 * Order is preserved and nothing is deduplicated here — two chips reading the same term is a
 * thing the reader can see and fix, whereas a term that vanished on being typed twice is not.
 * Repetition is also meaningful on the predicate side: `t:creature t:goblin` is two terms and
 * both must hold. `filters::picked_tags` sorts and dedups the tag slugs at the far end anyway.
 */
export function parseQuery(input: string): ParsedQuery {
  const tags: TagToken[] = [];
  const predicates: PredicateToken[] = [];
  const words: string[] = [];
  let i = 0;
  while (i < input.length) {
    if (/\s/.test(input[i])) {
      i += 1;
      continue;
    }
    const start = i;
    let quote: string | null = null;
    while (i < input.length) {
      const ch = input[i];
      if (quote) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (/\s/.test(ch)) {
        break;
      }
      i += 1;
    }
    const chunk = input.slice(start, i);
    const token = tokenFrom(chunk, start, i);
    if (token === "text") words.push(chunk);
    else if (token !== "partial") {
      if ("field" in token) predicates.push(token);
      else tags.push(token);
    }
  }
  return { text: words.join(" "), tags, predicates };
}

/**
 * {@link parseQuery} with the predicates dropped — the shape this module answered before the
 * grammar widened.
 *
 * It exists so that a caller which has not yet been taught about predicates keeps compiling and
 * keeps working *for tags*. A predicate in the string is neither a token nor free text here, so
 * a box still on this function silently ignores one; every such caller is being repointed at
 * {@link parseQuery} in the same change, and this should have no readers left after it.
 */
export function parseTagQuery(input: string): ParsedTagQuery {
  const { text, tags } = parseQuery(input);
  return { text, tokens: tags };
}

/**
 * The query with one term taken out — what a chip's ✕ writes back into the box.
 *
 * The box stays the single source of truth for the query, so removing a chip edits the text the
 * reader can see rather than a hidden second list that would then disagree with it. The space
 * collapse is what stops `atag:dog b` becoming `  b` after a removal.
 *
 * It takes a span rather than a {@link TagToken}, because a predicate's chip removes itself the
 * same way and the three rewrites care about nothing else on the token.
 */
export function removeToken(input: string, token: Pick<TagToken, "start" | "end">): string {
  return `${input.slice(0, token.start)}${input.slice(token.end)}`.replace(/\s+/g, " ").trim();
}

/**
 * The query with one term's `-` added or taken away — what a chip's include/exclude toggle
 * writes back.
 *
 * Rewrites the term in place rather than removing and re-appending it, for `toggleChipMode`'s
 * reason one file over: a chip that jumped to the end of the row when it was flipped would make
 * the row unreadable exactly while the reader is editing it. Here it would also reorder the
 * reader's own sentence.
 */
export function setTokenNegated(
  input: string,
  token: Pick<TagToken, "start" | "end">,
  negated: boolean,
): string {
  const term = input.slice(token.start, token.end).replace(/^-/, "");
  return `${input.slice(0, token.start)}${negated ? "-" : ""}${term}${input.slice(token.end)}`;
}

/**
 * The query with one term's *value* replaced, keeping the keyword and the operator the reader
 * typed — what pressing a suggested tag under a "no such tag" note writes back.
 *
 * The keyword is carried over rather than normalised to a canonical one: a reader who types
 * `atag:` and takes a suggestion should get `atag:` back, not `arttag:`. The operator is carried
 * with it for the same reason and because replacing `cmc>=` with `cmc:` would change what the
 * term asks. A value with a space in it is quoted on the way in, because the scanner splits on
 * whitespace and an unquoted phrase would come back as one term and one stray word.
 */
export function setTokenValue(
  input: string,
  token: Pick<TagToken, "start" | "end">,
  value: string,
): string {
  const head =
    /^-?[A-Za-z][A-Za-z0-9_-]*(?:>=|<=|!=|:|=|>|<)/.exec(input.slice(token.start, token.end))?.[0] ??
    "";
  const quoted = /\s/.test(value) ? `"${value}"` : value;
  return `${input.slice(0, token.start)}${head}${quoted}${input.slice(token.end)}`;
}

/**
 * A token's identity for a React key and for the resolve query's cache key — the namespace and
 * the value, never the value alone.
 *
 * `chipKey`'s rule in `tagFilters.ts`, for the same reason: the two taxonomies share plenty of
 * slugs and `dog` is in both. Case-folded because the resolver is, so `ATAG:Dog` and `atag:dog`
 * are one question and cost one round trip.
 */
export function tokenKey(token: Pick<TagToken, "namespace" | "value">): string {
  return `${token.namespace}:${token.value.toLowerCase()}`;
}
