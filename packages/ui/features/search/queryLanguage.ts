import type { PredicateField, PredicateOp, QueryPredicate, TagNamespace } from "@/lib/ipc";

/**
 * Scryfall's query syntax, read out of every card search box in this app.
 *
 * `t:goblin`, `o:"draw a card"`, `c>=rg`, `cmc>=3`, `-kw:flying`, `otag:removal`,
 * `(t:goblin or t:elf) is:commander`, `!"lightning bolt"` — the keyword names a field or a
 * taxonomy, the operator says how the value is compared, and everything the parser does not
 * recognise is left alone as free text for FTS. This module is the whole of the grammar;
 * `tagResolve` turns a top-level tag value into a slug, `filters::TagTerms` is what the slugs
 * become, and `filters::QueryPredicate` is what everything else becomes.
 *
 * # `or` and parentheses, since 2026-10-11 (issue #909)
 *
 * Until then this header said "there is still no `or`", because the backend composed by
 * conjunction and every term was its own ANDed clause. It still does — and that is what makes
 * the grouping cheap: **an `or`, or a group that has to stay one unit, travels as one term of the
 * same conjunctive list**, an `anyOf`/`allOf` predicate whose `terms` are its branches, and
 * `filters.rs` answers it as one parenthesised SQL clause. Everything a box sent before still
 * travels exactly as it did, because the mapping in {@link parseQuery} keeps every top-level
 * plain term on its old path — free text in `text`, a tag in `tags`, a predicate in
 * `predicates` — and only a real group takes the new one. The facet index skips groups and
 * counts wide, which is the direction a count may err in.
 *
 * AND binds tighter than OR, as on Scryfall: `t:goblin or t:elf c:r` is a goblin, or a red elf.
 * The grammar itself is three small steps — {@link lex}, {@link parseSequence}, {@link simplify}
 * — and it is tolerant by construction, because the box is parsed on every keystroke and most of
 * what it holds is a query on its way to being one: a dangling `or` is dropped, an unclosed `(`
 * runs to the end of the box, and a stray `)` is a character of the word it ends.
 *
 * # A `-` on a bare word or a quoted phrase excludes a *name*, since 2026-09-27
 *
 * `-bolt` and `-"lightning bolt"` are Scryfall's name exclusions (issue #571). Until then they
 * fell through to free text with the `-` read as punctuation, so `-bolt` searched *for* bolt —
 * the opposite of what was typed, and with nothing on screen to say so. They are now a negated
 * `name` predicate. **Name only, never every column free text matches**, and the two directions
 * differ on purpose: a positive bare word still matches the name, the type line and the rules
 * text, while Scryfall's `-bolt` is `-name:bolt` — measured live 2026-09-27, `t:instant -bolt` and
 * `t:instant -name:bolt` both answer 3,891 of 3,909. On this corpus `goblin` is 969 printings by
 * name and 2,224 across every column, so reading the wider set would take every Goblin
 * *creature* out of a reader who only asked to lose the ones called Goblin. A positive bare word
 * stays free text, which is why its chip's include press leaves no chip behind — see
 * {@link excludedName}. `name:` (issue #909) is the keyword spelling of the same field, and `!`
 * the exact one.
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
 *
 * # What is still not here
 *
 * Regular expressions (`o:/^draw/`), `~` standing for the card's own name, `cube:`,
 * `cheapest:`, `artists>` and `illustrations>`. Each stays the free text it always was — an
 * unknown keyword is a word, and a `/…/` value is refused by {@link predicateValue} — so typing
 * one narrows by its words rather than silently by nothing. The display keywords (`unique:`,
 * `order:`, `direction:`, `prefer:`, `display:`, `include:extras`) are recognised and **dropped**:
 * they ask how results are shown, never which cards match, and as free text they would search
 * the corpus for `prints`. See {@link DISPLAY_KEYWORDS}.
 */

/**
 * The wire types are `@/lib/ipc`'s — `PredicateField`, `PredicateOp` and `QueryPredicate` —
 * re-exported so the box's own callers can keep naming them from here.
 *
 * Until issue #909 this module declared a second copy of all three, structurally identical to
 * the mirror in `lib/ipc/cards.ts`. Two copies of a closed union is a drift with no witness:
 * `ipc.test.ts` holds the mirror to `filters.rs` and nothing held this copy to the mirror, so a
 * field added on one side and not the other would have compiled until the day a token of it was
 * passed to `ipc`. One declaration, checked once.
 */
export type { PredicateField, PredicateOp, QueryPredicate };

/**
 * A predicate plus where it sits in the box, so a chip can rewrite the text.
 *
 * The spans are {@link TagToken}'s and exist for {@link removeToken}'s reason — a chip drawn
 * from a term the reader cannot remove would be a control that lies. They are the *box's*
 * business and are stripped before the list crosses IPC ({@link wirePredicate}), or two
 * identical searches would make two query keys.
 *
 * A group's span is the whole group, `-(` to `)`, so its chip's ✕ takes the parentheses with
 * it. Its `terms` carry no spans at all: nothing on screen addresses a term inside a group on its
 * own, and a span nobody reads is one more thing to keep true.
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
 *
 * Only a **top-level** tag is a token. A tag inside a group is an `oracleTag`/`artTag` term of
 * that group's predicate, resolved by Rust in SQL — the round trip that turns a token into a slug
 * cannot sit under an `or`, and does not have to.
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

/** What one query string says, in full: the free text, the tags, and the typed predicates. */
export interface ParsedQuery {
  /** The unrecognised words, rejoined with single spaces — `SearchRequest.text`. */
  text: string;
  tags: TagToken[];
  /** In source order, plain terms and groups alike. */
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
 * The F1 panel's sections, in the order it draws them.
 *
 * **Declared on each row rather than derived from it**, which reverses what the panel did while
 * the table had fourteen rows. It used to ask each row a question — a tag, a keyword that takes
 * `<`, or neither — and that was the right call for three groups of five: no second list to
 * drift. At forty-five rows those three buckets put `usd<1`, `year<=1994` and `pow>=4` under one
 * heading and `game:arena` beside `t:goblin`, which is a dictionary sorted by the shape of its
 * entries rather than by what a reader is looking for. The section is still a property of the row
 * itself — one table, read by the parser and the panel — so a keyword cannot reach the parser
 * without also naming where the panel draws it; the compiler holds the name to this list.
 */
export const QUERY_SECTIONS = [
  "Text and names",
  "Colors and mana",
  "Numbers",
  "Sets and printings",
  "Formats and prices",
  "Card properties",
  "Tags",
] as const;

/** One of {@link QUERY_SECTIONS}. */
export type QuerySection = (typeof QUERY_SECTIONS)[number];

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
   * single rule for `:` would get one of them wrong, so each row states its own. The rule of
   * thumb the rows follow: a text-ish field keeps `colon` (contains), a number or a closed
   * vocabulary is `eq`, and a field that is a *set of symbols* — colours, mana cost, devotion,
   * produced mana — is `gte`, "at least these".
   */
  defaultOp: PredicateOp;
  /** The operators this keyword accepts. One it does not is free text, never an error. */
  ops: readonly PredicateOp[];
  /** Shown in the F1 panel. Must parse — `KeyMap.test.tsx` asserts it. Unique across the table,
   *  because the panel test finds each row by it. */
  example: string;
  /** One short sentence for the F1 panel. Unique across the table, for the same reason. */
  blurb: string;
  /** Where the F1 panel draws the row — see {@link QUERY_SECTIONS}. */
  section: QuerySection;
}

/** Everything a row with a numeric or ordered field accepts. */
const COMPARISONS: readonly PredicateOp[] = ["colon", "eq", "ne", "gt", "gte", "lt", "lte"];

/** What a row with a text or a closed-vocabulary field accepts: contains, or equals. */
const MATCHES: readonly PredicateOp[] = ["colon", "eq"];

/**
 * The whole vocabulary, in the order the F1 panel draws it within each section.
 *
 * A row added here is read by the parser and drawn by the panel with no second edit, which is
 * the point of there being one table. Keywords must be unique across rows after
 * {@link keywordKey} — `queryLanguage.test.ts` pins that, because a collision is a silent `Map`
 * overwrite rather than an error.
 *
 * Thirty-one rows arrived with issue #909. The fourteen before them are unchanged except that
 * `oracleText` gained Scryfall's `fo`/`fulloracle` (its `search_text` column already holds the
 * reminder text `fo:` asks for) and `name:` became a keyword of its own.
 */
export const QUERY_KEYWORDS: readonly KeywordSpec[] = [
  {
    target: "name",
    keywords: ["name"],
    defaultOp: "colon",
    ops: MATCHES,
    example: "name:goblin",
    blurb: "Card name",
    section: "Text and names",
  },
  {
    target: "typeLine",
    keywords: ["t", "type"],
    defaultOp: "colon",
    ops: MATCHES,
    example: "t:goblin",
    blurb: "Card type line",
    section: "Text and names",
  },
  {
    target: "oracleText",
    keywords: ["o", "oracle", "fo", "fulloracle"],
    defaultOp: "colon",
    ops: MATCHES,
    example: 'o:"draw a card"',
    blurb: "Rules text",
    section: "Text and names",
  },
  {
    target: "flavor",
    keywords: ["ft", "flavor"],
    defaultOp: "colon",
    ops: MATCHES,
    example: "ft:mishra",
    blurb: "Flavor text",
    section: "Text and names",
  },
  {
    target: "keyword",
    keywords: ["kw", "keyword"],
    defaultOp: "colon",
    ops: MATCHES,
    example: "kw:flying",
    blurb: "Keyword ability",
    section: "Text and names",
  },
  {
    target: "artist",
    keywords: ["a", "artist"],
    defaultOp: "colon",
    ops: MATCHES,
    example: "a:avon",
    blurb: "Illustrator",
    section: "Text and names",
  },
  {
    target: "watermark",
    keywords: ["wm", "watermark"],
    defaultOp: "colon",
    ops: MATCHES,
    example: "wm:orzhov",
    blurb: "Watermark",
    section: "Text and names",
  },
  {
    target: "colors",
    keywords: ["c", "color", "colour"],
    defaultOp: "gte",
    ops: COMPARISONS,
    example: "c>=rg",
    blurb: "Card colors — letters, a guild or shard, m, or a count",
    section: "Colors and mana",
  },
  {
    target: "colorIdentity",
    keywords: ["id", "identity", "ci"],
    defaultOp: "lte",
    ops: COMPARISONS,
    example: "id<=wu",
    blurb: "Color identity",
    section: "Colors and mana",
  },
  {
    target: "manaCost",
    keywords: ["m", "mana"],
    defaultOp: "gte",
    ops: COMPARISONS,
    example: "m:{G}{U}",
    blurb: "Mana cost symbols",
    section: "Colors and mana",
  },
  {
    target: "devotion",
    keywords: ["devotion"],
    defaultOp: "gte",
    ops: COMPARISONS,
    example: "devotion:{U}{U}{U}",
    blurb: "Devotion to a color",
    section: "Colors and mana",
  },
  {
    target: "produces",
    keywords: ["produces"],
    defaultOp: "gte",
    ops: COMPARISONS,
    example: "produces:wu",
    blurb: "Mana it can produce",
    section: "Colors and mana",
  },
  {
    target: "cmc",
    keywords: ["cmc", "mv", "manavalue"],
    defaultOp: "eq",
    ops: COMPARISONS,
    example: "cmc>=3",
    blurb: "Mana value — or even, odd",
    section: "Numbers",
  },
  {
    target: "power",
    keywords: ["pow", "power"],
    defaultOp: "eq",
    ops: COMPARISONS,
    example: "pow>=4",
    blurb: "Power",
    section: "Numbers",
  },
  {
    target: "toughness",
    keywords: ["tou", "tough", "toughness"],
    defaultOp: "eq",
    ops: COMPARISONS,
    example: "tou<=2",
    blurb: "Toughness",
    section: "Numbers",
  },
  {
    target: "loyalty",
    keywords: ["loy", "loyalty"],
    defaultOp: "eq",
    ops: COMPARISONS,
    example: "loy>=5",
    blurb: "Starting loyalty",
    section: "Numbers",
  },
  {
    target: "powTou",
    keywords: ["pt", "powtou"],
    defaultOp: "eq",
    ops: COMPARISONS,
    example: "pt>=10",
    blurb: "Power plus toughness",
    section: "Numbers",
  },
  {
    target: "collectorNumber",
    keywords: ["cn", "number"],
    defaultOp: "eq",
    ops: COMPARISONS,
    example: "cn>=250",
    blurb: "Collector number",
    section: "Numbers",
  },
  {
    target: "rarity",
    keywords: ["r", "rarity"],
    defaultOp: "eq",
    ops: COMPARISONS,
    example: "r>=rare",
    blurb: "Rarity, ordered",
    section: "Sets and printings",
  },
  {
    target: "setCode",
    keywords: ["s", "set", "e", "edition"],
    defaultOp: "eq",
    ops: MATCHES,
    example: "s:neo",
    blurb: "Set code",
    section: "Sets and printings",
  },
  {
    target: "setType",
    keywords: ["st", "settype"],
    defaultOp: "eq",
    ops: MATCHES,
    example: "st:masters",
    blurb: "Set type",
    section: "Sets and printings",
  },
  {
    target: "block",
    keywords: ["b", "block"],
    defaultOp: "eq",
    ops: MATCHES,
    example: "b:zen",
    blurb: "Block, by code or name",
    section: "Sets and printings",
  },
  {
    target: "inPrinting",
    keywords: ["in"],
    defaultOp: "eq",
    ops: MATCHES,
    example: "in:lea",
    blurb: "Ever printed in a set, game, rarity or language",
    section: "Sets and printings",
  },
  {
    target: "game",
    keywords: ["game"],
    defaultOp: "eq",
    ops: MATCHES,
    example: "game:arena",
    blurb: "Printed for paper, Arena or MTGO",
    section: "Sets and printings",
  },
  {
    target: "language",
    keywords: ["lang", "language"],
    defaultOp: "eq",
    ops: MATCHES,
    example: "lang:ja",
    blurb: "Printing language",
    section: "Sets and printings",
  },
  {
    target: "year",
    keywords: ["year"],
    defaultOp: "eq",
    ops: COMPARISONS,
    example: "year<=1994",
    blurb: "Release year",
    section: "Sets and printings",
  },
  {
    target: "date",
    keywords: ["date"],
    defaultOp: "eq",
    ops: COMPARISONS,
    example: "date>=2020-01-01",
    blurb: "Release date, or a set's",
    section: "Sets and printings",
  },
  {
    target: "border",
    keywords: ["border"],
    defaultOp: "eq",
    ops: MATCHES,
    example: "border:white",
    blurb: "Border color",
    section: "Sets and printings",
  },
  {
    target: "frame",
    keywords: ["frame"],
    defaultOp: "eq",
    ops: MATCHES,
    example: "frame:1997",
    blurb: "Frame edition or frame effect",
    section: "Sets and printings",
  },
  {
    target: "stamp",
    keywords: ["stamp"],
    defaultOp: "eq",
    ops: MATCHES,
    example: "stamp:acorn",
    blurb: "Security stamp",
    section: "Sets and printings",
  },
  {
    target: "prints",
    keywords: ["prints"],
    defaultOp: "eq",
    ops: COMPARISONS,
    example: "prints=1",
    blurb: "How many printings",
    section: "Sets and printings",
  },
  {
    target: "paperPrints",
    keywords: ["paperprints"],
    defaultOp: "eq",
    ops: COMPARISONS,
    example: "paperprints>=10",
    blurb: "How many paper printings",
    section: "Sets and printings",
  },
  {
    target: "sets",
    keywords: ["sets"],
    defaultOp: "eq",
    ops: COMPARISONS,
    example: "sets>=20",
    blurb: "How many sets it is in",
    section: "Sets and printings",
  },
  {
    target: "paperSets",
    keywords: ["papersets"],
    defaultOp: "eq",
    ops: COMPARISONS,
    example: "papersets=1",
    blurb: "How many paper sets it is in",
    section: "Sets and printings",
  },
  {
    target: "newFeature",
    keywords: ["new"],
    defaultOp: "colon",
    ops: ["colon"],
    example: "new:art",
    blurb: "First printing with this art, frame, rarity…",
    section: "Sets and printings",
  },
  {
    target: "format",
    keywords: ["f", "format", "legal"],
    defaultOp: "eq",
    ops: MATCHES,
    example: "f:modern",
    blurb: "Format legality",
    section: "Formats and prices",
  },
  {
    target: "banned",
    keywords: ["banned"],
    defaultOp: "eq",
    ops: MATCHES,
    example: "banned:modern",
    blurb: "Banned in a format",
    section: "Formats and prices",
  },
  {
    target: "restricted",
    keywords: ["restricted"],
    defaultOp: "eq",
    ops: MATCHES,
    example: "restricted:vintage",
    blurb: "Restricted in a format",
    section: "Formats and prices",
  },
  {
    target: "usd",
    keywords: ["usd"],
    defaultOp: "eq",
    ops: COMPARISONS,
    example: "usd<1",
    blurb: "Price in US dollars",
    section: "Formats and prices",
  },
  {
    target: "eur",
    keywords: ["eur"],
    defaultOp: "eq",
    ops: COMPARISONS,
    example: "eur>=10",
    blurb: "Price in euros",
    section: "Formats and prices",
  },
  {
    target: "tix",
    keywords: ["tix"],
    defaultOp: "eq",
    ops: COMPARISONS,
    example: "tix<0.5",
    blurb: "Price in MTGO tickets",
    section: "Formats and prices",
  },
  {
    target: "is",
    keywords: ["is", "not"],
    defaultOp: "colon",
    ops: ["colon"],
    example: "is:fetchland",
    blurb: "A property — not: asks for its absence",
    section: "Card properties",
  },
  {
    target: "has",
    keywords: ["has"],
    defaultOp: "colon",
    ops: ["colon"],
    example: "has:watermark",
    blurb: "Has a watermark, indicator, flavor or stamp",
    section: "Card properties",
  },
  {
    target: { tag: "oracle" },
    keywords: ["otag", "oracletag", "function"],
    defaultOp: "colon",
    ops: ["colon"],
    example: "otag:removal",
    blurb: "Oracle tag — what it does",
    section: "Tags",
  },
  {
    target: { tag: "art" },
    keywords: ["atag", "arttag", "art"],
    defaultOp: "colon",
    ops: ["colon"],
    example: "atag:dragon",
    blurb: "Art tag — what it shows",
    section: "Tags",
  },
];

/** {@link QUERY_KEYWORDS} by {@link keywordKey}, so `art_tag`, `art-tag` and `ARTTAG` are one. */
const SPEC_BY_KEYWORD = new Map<string, KeywordSpec>(
  QUERY_KEYWORDS.flatMap((spec) => spec.keywords.map((word) => [keywordKey(word), spec] as const)),
);

/**
 * Scryfall's presentation keywords, which this parser **recognises and drops**.
 *
 * `unique:prints`, `order:cmc`, `direction:desc`, `prefer:newest`, `display:grid` and
 * `include:extras` change how Scryfall lays out an answer and never which cards are in it, and
 * this app's wall has its own controls for every one of those questions. Dropped rather than
 * left as free text, because a reader pasting a Scryfall URL's query would otherwise search the
 * corpus for the words `prints` and `cmc` and see nothing — the one reading of the term that is
 * certainly wrong. `include:` is the only one whose value is checked: `include:extras` is the
 * whole of it on Scryfall, so any other value is an unknown term and stays a word.
 */
const DISPLAY_KEYWORDS = new Set(["unique", "order", "direction", "prefer", "display", "include"]);

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

/** A count: prints, sets, a colour count. Never negative and never a fraction. */
const COUNT = /^\d+$/;

/** A price: `1`, `0.5`, `.5`. Never negative — Scryfall has no price below nothing. */
const PRICE = /^(?:\d+(?:\.\d+)?|\.\d+)$/;

/** Scryfall's five colour letters plus `c` for colourless. */
const COLOR_LETTERS = /^[wubrgc]+$/i;

/**
 * Mana symbols, braced (`{G}{U}`, `{2/W}`, `{G/P}`, `{½}`) or bare (`2uu`). The braced ones are
 * taken whole whatever is inside — Rust's `mana_symbols` reads them into the multiset it
 * compares — so a typo inside braces reaches Rust and matches nothing, while a word that is not a
 * cost at all (`m:green`) never gets this far and stays free text.
 */
const MANA_COST = /^(?:\{[^{}\s]+\}|[0-9wubrgcxyzs])+$/i;

/** Devotion's value: one colour, repeated — `uuu`, `{U}{U}{U}` — or a hybrid pair, `{U/B}`. */
const DEVOTION = /^(?:\{[wubrg](?:\/[wubrg])?\}|[wubrg])+$/i;

/** `YYYY`, `YYYY-MM` or `YYYY-MM-DD` — the three precisions Scryfall's `date:` takes. */
const DATE = /^\d{4}(?:-\d{2}(?:-\d{2})?)?$/;

/** A set code, which `date:` also takes — "released on or after DOM". */
const SET_CODE = /^[a-z0-9]{3,6}$/i;

/** A four-digit year. */
const YEAR = /^\d{4}$/;

/**
 * Every colour *name* Scryfall's `c:` and `id:` read, plus `m`/`multicolor`, as keys of
 * {@link keywordKey}. Rust's `color_letters` turns a name into its letters; this side only has to
 * know that the value is one, so `c:esper` is a term and `c:green` stays a word.
 */
const COLOR_NAMES = new Set([
  "m",
  "multicolor",
  // Guilds.
  "azorius",
  "dimir",
  "rakdos",
  "gruul",
  "selesnya",
  "orzhov",
  "izzet",
  "golgari",
  "boros",
  "simic",
  // Strixhaven's colleges.
  "silverquill",
  "prismari",
  "witherbloom",
  "lorehold",
  "quandrix",
  // Shards.
  "bant",
  "esper",
  "grixis",
  "jund",
  "naya",
  // Wedges.
  "abzan",
  "jeskai",
  "sultai",
  "mardu",
  "temur",
  // Four colours, short and long.
  "glint",
  "dune",
  "ink",
  "witch",
  "yore",
  "glinteye",
  "dunebrood",
  "inktreader",
  "witchmaw",
  "yoretiller",
  // All five.
  "wubrg",
  "fivecolor",
]);

/**
 * The column names a numeric term may be compared *with* — `pow>tou`, `cmc<loy` — and the one
 * canonical `@field` each is sent as. Rust reads a value starting with `@` as a second column
 * rather than a number; the canonicalisation is here so it has four spellings to know, not ten.
 */
const CROSS_FIELD = new Map<string, string>([
  ["pow", "@power"],
  ["power", "@power"],
  ["tou", "@toughness"],
  ["tough", "@toughness"],
  ["toughness", "@toughness"],
  ["cmc", "@cmc"],
  ["mv", "@cmc"],
  ["manavalue", "@cmc"],
  ["loy", "@loyalty"],
  ["loyalty", "@loyalty"],
]);

/**
 * Rarity is a closed vocabulary with an order, so the parser canonicalises it rather than
 * handing Rust a letter to guess at.
 *
 * Measured on Scryfall 2026-09-22: `r>=rare` = 13,951 against `r:rare` = 11,856, so `:` here is
 * equality and the ordered operators expand over `common < uncommon < rare < mythic`. That
 * expansion is the SQL side's, and it can only do it against the full word — `r:c` reaching it
 * as `c` would compare `rarity = 'c'` and answer zero rows, silently. `special` and `bonus` sit
 * outside the order, so they take equality only — see {@link predicateValue}.
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
  ["s", "special"],
  ["special", "special"],
  ["b", "bonus"],
  ["bonus", "bonus"],
]);

/**
 * Scryfall's `is:` vocabulary — the **same list** as `filters.rs`' `pub const IS_VALUES`, which
 * is the source. `ipc.test.ts` reads the Rust text and compares, the
 * way it holds every other mirror in this app, because a value this side accepts and Rust does
 * not is a chip on screen over a search that matches nothing.
 *
 * Unknown `is:` values are free text, the rule every keyword here follows: `is:fetchlnad` is a
 * typo the reader can see in the wall, where a term that matched nothing would only look like a
 * collection with no fetchlands in it.
 */
export const IS_VALUES: readonly string[] = [
  // Layout and faces.
  "split",
  "flip",
  "transform",
  "meld",
  "leveler",
  "adventure",
  "mdfc",
  "dfc",
  "saga",
  "class",
  "case",
  "prototype",
  "battle",
  "token",
  "emblem",
  "artseries",
  "reversible",
  // Card kinds.
  "spell",
  "permanent",
  "historic",
  "party",
  "outlaw",
  "vanilla",
  "frenchvanilla",
  "bear",
  "modal",
  "hybrid",
  "phyrexian",
  "commander",
  "brawler",
  "companion",
  "funny",
  "masterpiece",
  // The printing.
  "promo",
  "digital",
  "reprint",
  "reserved",
  "foil",
  "nonfoil",
  "etched",
  "glossy",
  "full",
  "fullart",
  "hires",
  "textless",
  "oversized",
  "spotlight",
  "booster",
  "variation",
  "gamechanger",
  "showcase",
  "extendedart",
  "borderless",
  "colorshifted",
  "inverted",
  "nyxtouched",
  // Promo types.
  "datestamped",
  "prerelease",
  "buyabox",
  "bundle",
  "boosterfun",
  "planeswalkerdeck",
  "promopack",
  "release",
  "gameday",
  "intropack",
  "judgegift",
  "league",
  "convention",
  "fnm",
  "openhouse",
  "setpromo",
  "stamped",
  "serialized",
  "surgefoil",
  "galaxyfoil",
  "textured",
  "halofoil",
  "confettifoil",
  "doublerainbow",
  "neonink",
  "oilslick",
  "rainbowfoil",
  "stepandcompleat",
  "embossed",
  "gilded",
  "ripplefoil",
  "raisedfoil",
  "poster",
  "universesbeyond",
  "ub",
  // Land nicknames.
  "dual",
  "fetchland",
  "shockland",
  "checkland",
  "fastland",
  "slowland",
  "painland",
  "gainland",
  "scryland",
  "surveilland",
  "bounceland",
  "karoo",
  "filterland",
  "canopyland",
  "bikeland",
  "cycleland",
  "triland",
  "triome",
  "shadowland",
  "storageland",
  "tangoland",
  "battleland",
  "creatureland",
  "manland",
  "pathway",
];

/**
 * The closed vocabularies besides `is:`, each a set of {@link keywordKey}s. A value outside its
 * set is free text, for {@link IS_VALUES}' reason.
 *
 * `frame:` takes two kinds of word — the five frame *editions* Scryfall's `frame` field holds and
 * the frame *effects* in `frame_effects` — and Rust tells them apart; both are listed here so
 * neither is free text.
 */
const VOCABULARY: Partial<Record<PredicateField, ReadonlySet<string>>> = {
  game: new Set(["paper", "arena", "mtgo"]),
  border: new Set(["black", "white", "borderless", "silver", "gold", "yellow"]),
  stamp: new Set(["oval", "triangle", "acorn", "circle", "arena", "heart"]),
  has: new Set(["watermark", "indicator", "flavor", "stamp"]),
  newFeature: new Set(["art", "artist", "flavor", "frame", "language", "rarity", "card"]),
  is: new Set(IS_VALUES),
  frame: new Set([
    "1993",
    "1997",
    "2003",
    "2015",
    "future",
    "legendary",
    "miracle",
    "enchantment",
    "nyxtouched",
    "draft",
    "devoid",
    "tombstone",
    "colorshifted",
    "inverted",
    "sunmoondfc",
    "compasslanddfc",
    "originpwdfc",
    "mooneldrazidfc",
    "waxingandwaningmoondfc",
    "showcase",
    "extendedart",
    "companion",
    "etched",
    "snow",
    "lesson",
    "shatteredglass",
    "convertdfc",
    "fandfc",
    "upsidedowndfc",
    "spree",
  ]),
};

/**
 * Scryfall's language codes, and the English name of each, all as the code they are sent as.
 *
 * **The parser sends the code, never the name** — `lang:japanese` goes out as `"ja"`. Rust maps a
 * name too (the wire's contract allows either), but a code is the one spelling both sides are
 * certain to agree on, and the chip still reads what the reader typed. `any` is Scryfall's "every
 * language" and is sent as itself; Rust reads it as no clause.
 */
const LANGUAGE_CODE = new Map<string, string>([
  ...["en", "es", "fr", "de", "it", "pt", "ja", "ko", "ru", "zhs", "zht", "he", "la"].map(
    (code) => [code, code] as const,
  ),
  ...["grc", "ar", "sa", "ph", "qya", "any"].map((code) => [code, code] as const),
  ["english", "en"],
  ["spanish", "es"],
  ["french", "fr"],
  ["german", "de"],
  ["italian", "it"],
  ["portuguese", "pt"],
  ["japanese", "ja"],
  ["korean", "ko"],
  ["russian", "ru"],
  ["simplifiedchinese", "zhs"],
  ["traditionalchinese", "zht"],
  ["hebrew", "he"],
  ["latin", "la"],
  ["ancientgreek", "grc"],
  ["arabic", "ar"],
  ["sanskrit", "sa"],
  ["phyrexian", "ph"],
  ["quenya", "qya"],
]);

/** The two operators that are not a comparison of order — what an unordered value accepts. */
const isEquality = (op: PredicateOp) => op === "colon" || op === "eq" || op === "ne";

/**
 * The value a field will accept, canonicalised — or `null`, which makes the whole chunk free
 * text.
 *
 * **An unparseable value is text, never an error.** `cmc>=banana` is not a number, so the term
 * goes to FTS as the words the reader typed rather than being refused; that is the rule that
 * already makes `itag:dragon` free text, and it keeps the box's one failure mode about tags,
 * where it already is. Every closed vocabulary follows it: `is:fetchlnad`, `game:xbox` and
 * `frame:2020` are words.
 *
 * `*` is a value for the star-able numeric fields and not a wildcard: a power can be `*`, `1+`,
 * `X` or `∞`, and Scryfall's own answers say `*` participates in comparisons rather than being
 * excluded from them (`pow>=0` = `pow>=*` = 19,128, while `pow:*` = 1,059 — a literal star,
 * matched as a string before any cast). Another column's name is a value for the same fields —
 * `pow>tou` — and goes out as `@toughness` ({@link CROSS_FIELD}).
 *
 * A `/…/` value is a Scryfall regular expression, which this app does not run; refusing it here
 * leaves the chunk free text for every field at once, rather than sending `/^draw/` to an FTS
 * column as the word `draw`.
 */
function predicateValue(field: PredicateField, raw: string, op: PredicateOp): string | null {
  if (raw === "") return null;
  if (raw.length > 1 && raw.startsWith("/") && raw.endsWith("/")) return null;
  const key = keywordKey(raw);
  switch (field) {
    case "cmc":
      if (key === "even" || key === "odd") return isEquality(op) ? key : null;
      return numericValue(raw);
    case "power":
    case "toughness":
    case "loyalty":
    case "powTou":
      return numericValue(raw);
    case "colors":
    case "colorIdentity":
      return COLOR_LETTERS.test(raw) || COUNT.test(raw) || COLOR_NAMES.has(key) ? raw : null;
    case "manaCost":
      return MANA_COST.test(raw) ? raw : null;
    case "devotion":
      return DEVOTION.test(raw) ? raw : null;
    case "produces":
      return COLOR_LETTERS.test(raw) ? raw : null;
    case "rarity": {
      const word = RARITY_BY_WORD.get(raw.toLowerCase()) ?? null;
      // `special` and `bonus` are outside `common < … < mythic`, so `r>=special` has no answer.
      return (word === "special" || word === "bonus") && !isEquality(op) ? null : word;
    }
    case "collectorNumber":
      // `cn:12a` is a string match; `cn>12a` has no order to compare by.
      return isEquality(op) || NUMERIC.test(raw) ? raw : null;
    case "year":
      return YEAR.test(raw) ? raw : null;
    case "date":
      return DATE.test(raw) || SET_CODE.test(raw) ? raw : null;
    case "usd":
    case "eur":
    case "tix":
      return PRICE.test(raw) ? raw : null;
    case "prints":
    case "paperPrints":
    case "sets":
    case "paperSets":
      return COUNT.test(raw) ? raw : null;
    case "language":
      return LANGUAGE_CODE.get(key) ?? null;
    case "game":
    case "border":
    case "stamp":
    case "has":
    case "newFeature":
    case "is":
    case "frame":
      return VOCABULARY[field]?.has(key) ? key : null;
    default:
      return raw;
  }
}

/** A star-able number, or another numeric column's name ({@link CROSS_FIELD}). */
function numericValue(raw: string): string | null {
  if (raw === "*" || NUMERIC.test(raw)) return raw;
  return CROSS_FIELD.get(keywordKey(raw)) ?? null;
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
 * One chunk of the source, read without regard to where it sits in a group.
 *
 * `"text"` is a positive chunk that is not a term at all and goes to FTS. A tag and a predicate
 * are the two kinds of term. `null` is **neither a term nor free text** — a known keyword with
 * nothing usable after it yet, or a display keyword ({@link DISPLAY_KEYWORDS}) — and the
 * distinction is what the three-way answer exists for: as a token `otag:` would sit there
 * reporting `""` as an unknown tag through the whole of the next word, and as free text it would
 * search the corpus for `otag`. Every keystroke on the way to a term passes through that state,
 * so it is the common case rather than an edge one.
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
 *
 * Every chunk that would have been `"text"` is asked one more question on the way out — does it
 * start with `-`? — by {@link excludedName}, which is where `-bolt` stops being free text. A
 * chunk starting `!` (after an optional `-`) is Scryfall's exact name, `!"lightning bolt"`.
 */
type Classified =
  | { kind: "tag"; namespace: TagNamespace; value: string; negated: boolean }
  | { kind: "predicate"; predicate: QueryPredicate }
  | { kind: "text" };

function classify(chunk: string): Classified | null {
  const exact = /^(-?)!([\s\S]*)$/.exec(chunk);
  if (exact) {
    const value = unquote(exact[2]).trim();
    if (!INDEXABLE.test(value)) return null;
    return {
      kind: "predicate",
      predicate: { field: "name", op: "eq", value, negated: exact[1] === "-" },
    };
  }
  const m = TERM.exec(chunk);
  if (!m) return excludedName(chunk);
  const key = keywordKey(m[2]);
  const sign = m[3];
  const value = unquote(m[4]).trim();
  if (DISPLAY_KEYWORDS.has(key) && (sign === ":" || sign === "=")) {
    if (key !== "include") return null;
    if (value === "" || value.toLowerCase() === "extras") return null;
    return excludedName(chunk);
  }
  const spec = SPEC_BY_KEYWORD.get(key);
  if (!spec) return excludedName(chunk);
  const op = OP_BY_SIGN[sign];
  if (!spec.ops.includes(op)) return excludedName(chunk);
  if (value === "") return null;
  // `not:x` is `-is:x`, so a dash on it cancels: Scryfall reads `-not:reprint` as `is:reprint`.
  const negated = (m[1] === "-") !== (key === "not");
  if (typeof spec.target !== "string") {
    return { kind: "tag", namespace: spec.target.tag, value, negated };
  }
  // `:` is the one sign that does not mean itself: each row states what a bare colon asks, and
  // for most fields a keyword names that is a comparison rather than a match.
  const resolved = sign === ":" ? spec.defaultOp : op;
  const canonical = predicateValue(spec.target, value, resolved);
  if (canonical === null) return excludedName(chunk);
  return {
    kind: "predicate",
    predicate: { field: spec.target, op: resolved, value: canonical, negated },
  };
}

/** A letter or a digit in any script — what `filters::fts_query` keeps, since Rust's
 *  `char::is_alphanumeric` is Unicode-aware too. */
const INDEXABLE = /[\p{L}\p{N}]/u;

/**
 * A chunk that is not a term, read once more for a leading `-`: Scryfall's `-bolt` and
 * `-"lightning bolt"`, which exclude a card **by its name**.
 *
 * Anything else stays `"text"`, so a *positive* bare word is exactly the free text it has always
 * been. The rule is "whatever free text would have been, negated" rather than a grammar of its
 * own, which is why an unparseable term negates too: `-cmc>=banana` was the words `cmc banana`
 * and is now a name that cannot contain them — Scryfall reads it the same way.
 *
 * **A value with nothing indexable in it is `null`, not a term.** A lone `-` is what the box
 * holds on the way to `-bolt`, and `-"` on the way to `-"lightning bolt"`; as a term either would
 * draw a chip that narrows nothing, because the FTS builder drops a value that tokenises to no
 * word. The same guard keeps `--` and `-!!!` from drawing one.
 *
 * **Its chip is the one whose include press does not keep it.** Flipping `-bolt` writes `bolt`,
 * which is free text and draws no chip — the wall answers the press the way the reader asked;
 * only the chip goes.
 */
function excludedName(chunk: string): Classified | null {
  if (!chunk.startsWith("-")) return { kind: "text" };
  return negatedText(chunk.slice(1));
}

/** Free text under a negation — a name exclusion, or `null` when there is no word to exclude. */
function negatedText(text: string): Classified | null {
  const value = unquote(text).trim();
  if (!INDEXABLE.test(value)) return null;
  return { kind: "predicate", predicate: { field: "name", op: "colon", value, negated: true } };
}

/**
 * What may sit before a quote for it to *open* one: nothing, a lone `-`, a `!` (an exact name),
 * or `-?keyword<op>` — the start of a chunk or the start of a value, and nowhere else (issue
 * #552).
 *
 * Until 2026-09-27 any `'` opened a quote, and an apostrophe is the commonest punctuation in a
 * card name. `sensei's -t:artifact` became one free-text chunk that ran to the end of the box and
 * returned the Sensei's Divining Top the reader had excluded; `o:can't t:creature` swallowed its
 * type filter into the rules-text value. A quote mid-word is now just a character of the word.
 * The keyword need not be one this module knows — `itag:"spot removal"` stays one chunk of free
 * text rather than two, which is what it was before.
 */
const QUOTE_OPENS = /^-?(?:!|[A-Za-z][A-Za-z0-9_-]*(?:>=|<=|!=|:|=|>|<))?$/;

/**
 * Whether the quote at `i` closes the one that is open.
 *
 * A `"` always does. A `'` does only at the end of a word — before whitespace, the end of the
 * box, or the `)`s that close groups there — because the same character is an apostrophe inside
 * one: `o:'can't block'` is one value, `can't block`, where closing at the first `'` would leave
 * `t` glued to the term and `block'` adrift as free text. The rule is `'`-only because `"` is
 * never an apostrophe, and applying it there would let `"a"b` swallow the rest of the box.
 */
function closesQuote(input: string, i: number): boolean {
  if (input[i] === '"') return true;
  let next = i + 1;
  while (input[next] === ")") next += 1;
  return next >= input.length || /\s/.test(input[next]);
}

/**
 * One lexeme of the box: a chunk of a term or a word, a `(` (with its optional `-`), a `)`, or
 * one of the two connectives. Spans are half-open offsets into the source, like a token's.
 */
type Lexeme =
  | { kind: "chunk"; text: string; start: number; end: number }
  | { kind: "open"; negated: boolean; start: number; end: number }
  | { kind: "close"; start: number; end: number }
  | { kind: "or"; start: number; end: number }
  | { kind: "and"; start: number; end: number };

/**
 * Split the box into {@link Lexeme}s.
 *
 * The scan is whitespace-separated with one exception: a quote swallows spaces, so
 * `otag:"spot removal"` is one chunk and `spot` does not fall out of it into the FTS text.
 * Unbalanced quotes run to the end of the string, which is the state the box is in for as long
 * as it takes to type the closing one. **Only a quote where a value can begin opens one** — see
 * {@link QUOTE_OPENS} — so an apostrophe inside `Urza's` is part of the word.
 *
 * **Parentheses are read only at a chunk's two ends**, which is Scryfall's practice and the one
 * that leaves card names alone: a `(` at the head of a chunk (after an optional `-`) opens a
 * group, and a `)` at its tail closes one *if one is open* — so `bolt)` with nothing open is the
 * word `bolt)`, and `(a))` closes once and keeps the second `)` as a character. A paren inside a
 * quote is a character too, `o:"(this)"`, because the tail is counted only past the last closing
 * quote. An unclosed `(` is simply never closed, and the parser runs its group to the end.
 *
 * `or` and `and`, in any case and unquoted, are connectives; quoted, `"fight or flight"` is a
 * phrase as it always was.
 */
function lex(input: string): Lexeme[] {
  const out: Lexeme[] = [];
  let depth = 0;
  let i = 0;
  while (i < input.length) {
    if (/\s/.test(input[i])) {
      i += 1;
      continue;
    }
    while (input[i] === "(" || (input[i] === "-" && input[i + 1] === "(")) {
      const negated = input[i] === "-";
      const start = i;
      i += negated ? 2 : 1;
      out.push({ kind: "open", negated, start, end: i });
      depth += 1;
    }
    const start = i;
    let quote: string | null = null;
    let afterQuote = start;
    while (i < input.length) {
      const ch = input[i];
      if (quote) {
        if (ch === quote && closesQuote(input, i)) {
          quote = null;
          afterQuote = i + 1;
        }
      } else if ((ch === '"' || ch === "'") && QUOTE_OPENS.test(input.slice(start, i))) {
        quote = ch;
      } else if (/\s/.test(ch)) {
        break;
      }
      i += 1;
    }
    let end = i;
    const closes: Lexeme[] = [];
    if (quote === null) {
      while (depth > 0 && end > afterQuote && input[end - 1] === ")") {
        end -= 1;
        depth -= 1;
        closes.unshift({ kind: "close", start: end, end: end + 1 });
      }
    }
    if (end > start) {
      const text = input.slice(start, end);
      const word = text.toLowerCase();
      if (word === "or" || word === "and") out.push({ kind: word, start, end });
      else out.push({ kind: "chunk", text, start, end });
    }
    out.push(...closes);
  }
  return out;
}

/**
 * The tree the lexemes make. A term is one chunk; a group is a run of nodes joined by one
 * connective. `flip` is a negation a term inherited when a one-child group around it was
 * unwrapped (`-(t:goblin)`), and `parens` says whether a group was typed with parentheses —
 * the root and an `or`'s AND branches were not, which decides whose span a lone child takes.
 */
type Node =
  | { kind: "term"; text: string; start: number; end: number; flip: boolean }
  | {
      kind: "group";
      op: "and" | "or";
      negated: boolean;
      parens: boolean;
      start: number;
      end: number;
      children: Node[];
    };

/**
 * Read lexemes from `at.i` up to the `)` that closes `open` (or the end of the box), as one
 * group. AND binds tighter than OR: each `or` ends a branch, and a branch of several items is an
 * AND group of its own.
 *
 * **A dangling `or` is dropped**, at the start, at the end, or doubled. It is a keystroke, not a
 * statement: every `t:goblin or t:elf` passes through `t:goblin or`, and reading that as "a
 * goblin, or anything" would flash the unfiltered wall between two words. `and` is always
 * dropped, because juxtaposition already says it.
 */
function parseSequence(lexemes: Lexeme[], at: { i: number }, open: Lexeme | null): Node {
  const branches: Node[][] = [];
  let current: Node[] = [];
  let end = open?.end ?? 0;
  while (at.i < lexemes.length) {
    const lexeme = lexemes[at.i];
    at.i += 1;
    end = lexeme.end;
    if (lexeme.kind === "close") break;
    if (lexeme.kind === "and") continue;
    if (lexeme.kind === "or") {
      if (current.length > 0) branches.push(current);
      current = [];
      continue;
    }
    if (lexeme.kind === "open") {
      const group = parseSequence(lexemes, at, lexeme);
      current.push(group);
      end = group.end;
      continue;
    }
    current.push({
      kind: "term",
      text: lexeme.text,
      start: lexeme.start,
      end: lexeme.end,
      flip: false,
    });
  }
  if (current.length > 0) branches.push(current);
  const andOf = (nodes: Node[]): Node =>
    nodes.length === 1
      ? nodes[0]
      : {
          kind: "group",
          op: "and",
          negated: false,
          parens: false,
          start: nodes[0].start,
          end: nodes[nodes.length - 1].end,
          children: nodes,
        };
  const children = branches.length > 1 ? branches.map(andOf) : (branches[0] ?? []);
  const first = children[0];
  const last = children[children.length - 1];
  return {
    kind: "group",
    op: branches.length > 1 ? "or" : "and",
    negated: open?.kind === "open" ? open.negated : false,
    parens: open !== null,
    start: open?.start ?? first?.start ?? 0,
    end: open ? end : (last?.end ?? 0),
    children,
  };
}

/**
 * The tree, with everything that says nothing taken out and everything redundant folded.
 *
 * - A term that is neither a term nor free text (`otag:`, `unique:prints`) is dropped.
 * - A child group with the same connective and no negation is spliced into its parent —
 *   `a or (b or c)` is one `or` of three, and `(a b) c` one conjunction of three.
 * - A group that empties out is dropped; a group of **one** is that one, carrying the group's
 *   negation with its own. A lone child of a parenthesised group takes the group's span, so its
 *   chip's ✕ takes the parentheses too and does not leave `()` behind.
 */
function simplify(node: Node): Node | null {
  if (node.kind === "term") return classify(node.text) === null ? null : node;
  const children: Node[] = [];
  for (const child of node.children) {
    const kept = simplify(child);
    if (kept === null) continue;
    if (kept.kind === "group" && kept.op === node.op && !kept.negated) {
      children.push(...kept.children);
    } else {
      children.push(kept);
    }
  }
  if (children.length === 0) return null;
  if (children.length > 1) return { ...node, children };
  const only = children[0];
  const span = node.parens ? { start: node.start, end: node.end } : {};
  return only.kind === "term"
    ? { ...only, ...span, flip: only.flip !== node.negated }
    : { ...only, ...span, negated: only.negated !== node.negated };
}

/** A term's reading with any inherited negation applied — free text under one becomes a name
 *  exclusion, exactly as a leading `-` on it would. */
function resolveTerm(node: Extract<Node, { kind: "term" }>): Classified | null {
  const read = classify(node.text);
  if (read === null || !node.flip) return read;
  if (read.kind === "text") return negatedText(node.text);
  if (read.kind === "tag") return { ...read, negated: !read.negated };
  return { kind: "predicate", predicate: { ...read.predicate, negated: !read.predicate.negated } };
}

/**
 * A node inside a group, as the term of an `anyOf`/`allOf` it will travel as.
 *
 * Free text becomes `text` and a tag becomes `oracleTag`/`artTag` here, because neither of the
 * top level's paths reaches under an `or`: `SearchRequest.text` is one string ANDed with
 * everything, and a resolved tag is one of two ANDed lists.
 */
function termOf(node: Node): QueryPredicate | null {
  if (node.kind === "group") return groupOf(node);
  const read = resolveTerm(node);
  if (read === null) return null;
  if (read.kind === "predicate") return read.predicate;
  if (read.kind === "tag") {
    const field = read.namespace === "oracle" ? "oracleTag" : "artTag";
    return { field, op: "colon", value: read.value, negated: read.negated };
  }
  return { field: "text", op: "colon", value: node.text, negated: false };
}

/** A group as one predicate — `anyOf` for an `or`, `allOf` for a conjunction that had to stay
 *  one unit. A group whose terms all read as nothing is nothing; one whose terms come to a single
 *  one is that term, negated if the group was. */
function groupOf(node: Extract<Node, { kind: "group" }>): QueryPredicate | null {
  const terms = node.children.map(termOf).filter((t): t is QueryPredicate => t !== null);
  if (terms.length === 0) return null;
  if (terms.length === 1) return { ...terms[0], negated: terms[0].negated !== node.negated };
  return {
    field: node.op === "or" ? "anyOf" : "allOf",
    op: "colon",
    value: "",
    negated: node.negated,
    terms,
  };
}

/**
 * Split a query string into tag terms, typed predicates and the free text around them.
 *
 * {@link lex} cuts the box into chunks, parentheses and connectives; {@link parseSequence} builds
 * the tree with AND tighter than OR; {@link simplify} drops what says nothing and folds what is
 * redundant. What is left is mapped onto the three lists the box has always answered:
 *
 * - **The top level is a conjunction**, and each of its items that is a plain term keeps
 *   exactly the path it had before issue #909: a positive word is free text, a tag is a token, a
 *   predicate is a predicate token. A parenthesised conjunction at the top level is flattened
 *   into it, so `(t:goblin c:r)` is two chips and not one.
 * - **What is left is a group that has to stay one unit** — an `or`, or a negated group — and
 *   it becomes ONE predicate token, `anyOf` or `allOf`, spanning the whole group in the source
 *   so its chip can take it out.
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
  const root = simplify(parseSequence(lex(input), { i: 0 }, null));
  const items =
    root === null
      ? []
      : root.kind === "group" && root.op === "and" && !root.negated
        ? root.children
        : [root];
  for (const item of items) {
    const { start, end } = item;
    if (item.kind === "group") {
      const group = groupOf(item);
      if (group !== null) predicates.push({ ...group, start, end });
      continue;
    }
    const read = resolveTerm(item);
    if (read === null) continue;
    if (read.kind === "text") words.push(item.text);
    else if (read.kind === "tag") {
      tags.push({
        namespace: read.namespace,
        value: read.value,
        negated: read.negated,
        start,
        end,
      });
    } else predicates.push({ ...read.predicate, start, end });
  }
  return { text: words.join(" "), tags, predicates };
}

/**
 * One parsed term as the **wire** carries it: the span dropped, at every depth.
 *
 * `start`/`end` are the box's business — they exist so a chip can splice the term back out of
 * the text — and the backend has no use for them at all. Sending them would be worse than
 * useless: the payload is what every query key is hashed from, so `t:goblin bolt` and
 * `bolt t:goblin` are one search that would cost two cache entries, and the same query typed
 * two characters further along the box would miss its own cached pages.
 *
 * **`terms` survives**, and only where it means something: a group's branches are the whole of
 * what it asks, while on every other field the key is absent rather than an empty list, so a
 * plain term's payload is byte-for-byte what it was before groups existed. Every hook that sends
 * typed terms goes through this one function, so no caller can strip a group to its empty value.
 */
export function wirePredicate(p: QueryPredicate): QueryPredicate {
  const { field, op, value, negated, terms } = p;
  return terms
    ? { field, op, value, negated, terms: terms.map(wirePredicate) }
    : { field, op, value, negated };
}

/**
 * A predicate's identity — what a chip row dedupes on: `field|op|value`, case-folded, and for a
 * group its terms after it, each with its own `-`.
 *
 * Case-folded because Rust folds the value too, so `c:RG` and `c:rg` are one question and must
 * not be two chips. The top-level negation is deliberately **not** in it: that is the chip's
 * mode, and `t:goblin -t:goblin` is one chip whose first spelling wins, the tag row's rule. A
 * group's terms *are* in it, or every `anyOf` — whose value is always `""` — would be one chip.
 */
export function predicateKey(p: QueryPredicate): string {
  const own = `${p.field}|${p.op}|${p.value.toLowerCase()}`;
  if (!p.terms) return own;
  return `${own}|[${p.terms.map((t) => `${t.negated ? "-" : ""}${predicateKey(t)}`).join(",")}]`;
}

/**
 * Whether `term` is one unit of the grammar — a single chunk, or one parenthesised group from
 * its first character to its last — rather than several items side by side.
 *
 * A top-level `t:goblin or t:elf` is a group with no parentheses of its own, and a `-` in front
 * of it negates only `t:goblin`; {@link setTokenNegated} asks this to know when the dash needs
 * parentheses to reach the whole of it.
 */
function isUnit(term: string): boolean {
  const lexemes = lex(term);
  if (lexemes.length === 1) return lexemes[0].kind === "chunk";
  if (lexemes[0]?.kind !== "open") return false;
  let depth = 0;
  for (let i = 0; i < lexemes.length; i += 1) {
    const kind = lexemes[i].kind;
    if (kind === "open") depth += 1;
    else if (kind === "close") depth -= 1;
    if (depth === 0) return i === lexemes.length - 1;
  }
  // Never closed — an unclosed group runs to the end of the box, so it is still one unit.
  return true;
}

/**
 * What a predicate's chip says — the reader's own spelling, with three exceptions that read
 * better as words.
 *
 * **The rule is the source slice**, minus any leading `-` (the chip's `mode` says that) and minus
 * the parentheses around a group or a lone term, peeled as many times as they nest —
 * `(-t:goblin)` reads `t:goblin`, in the exclude mode. A reader who typed `mv>=3` should read
 * `mv>=3` back, not the canonical `cmc>=3`, because the ✕ edits *their* sentence and a chip
 * naming a term they cannot find in the box is a control that lies. `(t:goblin or t:elf)` reads
 * `t:goblin or t:elf`; the parentheses are the grammar's and the chip is already the unit they
 * draw.
 *
 * The exceptions are spellings that are punctuation rather than words. `!fire` reads
 * `name = "fire"`; `is:fetchland` and `not:fetchland` both read `is fetchland`, the second in the
 * exclude mode that draws it as `not is fetchland`. Both are still findable in the box: the value
 * is the reader's, and so is everything else in the chip.
 */
export function predicateLabel(input: string, token: PredicateToken): string {
  if (token.field === "name" && token.op === "eq") return `name = "${token.value}"`;
  if (token.field === "is") return `is ${token.value}`;
  let label = input.slice(token.start, token.end);
  for (;;) {
    // A dash comes off only where it is the whole unit's: the `-` of `-t:goblin or t:elf`
    // belongs to `t:goblin` alone, and the chip over the `or` has to say so.
    if (label.startsWith("-") && isUnit(label.slice(1))) label = label.slice(1);
    else if (label.startsWith("(") && isUnit(label)) {
      // An unclosed group has no `)` of its own to take off — the last character is the reader's.
      const lexemes = lex(label);
      const closed = lexemes[lexemes.length - 1].kind === "close";
      label = label.slice(1, closed ? -1 : undefined).trim();
    } else break;
  }
  return label;
}

/**
 * The query with one term taken out — what a chip's ✕ writes back into the box.
 *
 * The box stays the single source of truth for the query, so removing a chip edits the text the
 * reader can see rather than a hidden second list that would then disagree with it. The space
 * collapse is what stops `atag:dog b` becoming `  b` after a removal.
 *
 * It takes a span rather than a {@link TagToken}, because a predicate's chip removes itself the
 * same way and the three rewrites care about nothing else on the token. A group's span is the
 * whole group, so `(t:goblin or t:elf)` goes in one press, parentheses and all.
 */
export function removeToken(input: string, token: Pick<TagToken, "start" | "end">): string {
  return `${input.slice(0, token.start)}${input.slice(token.end)}`.replace(/\s+/g, " ").trim();
}

/**
 * The query with one term's negation flipped — what a chip's include/exclude toggle writes back.
 *
 * Rewrites the term in place rather than removing and re-appending it, for `toggleChipMode`'s
 * reason one file over: a chip that jumped to the end of the row when it was flipped would make
 * the row unreadable exactly while the reader is editing it. Here it would also reorder the
 * reader's own sentence.
 *
 * **The token's own `negated` is what is flipped, when it is given**, because since issue #909 a
 * term's negation is not always a dash at the front of its span. `not:reprint` is negated with no
 * dash, and is rewritten as `is:reprint` / `not:reprint` rather than gaining one. `(-t:goblin)` is
 * negated by a dash *inside* its span, so including it writes `-(-t:goblin)` — a double negation,
 * but the term the reader asked for, where stripping a leading dash would do nothing at all. And a
 * top-level `t:goblin or t:elf` has no parentheses of its own, so excluding it writes
 * `-(t:goblin or t:elf)`, since a bare dash would exclude only the goblins. A span-only caller
 * gets the rule this had before: strip a leading dash, then add one if asked.
 */
export function setTokenNegated(
  input: string,
  token: Pick<TagToken, "start" | "end"> & { negated?: boolean },
  negated: boolean,
): string {
  const term = input.slice(token.start, token.end);
  const not = /^-?not:/i.exec(term);
  let next: string;
  if (!isUnit(term)) next = negated ? `-(${term})` : term;
  else if (not) next = `${negated ? "not" : "is"}:${term.slice(not[0].length)}`;
  else if (token.negated === undefined) next = `${negated ? "-" : ""}${term.replace(/^-/, "")}`;
  else if (token.negated === negated) next = term;
  else next = term.startsWith("-") ? term.slice(1) : `-${term}`;
  return `${input.slice(0, token.start)}${next}${input.slice(token.end)}`;
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
    /^-?[A-Za-z][A-Za-z0-9_-]*(?:>=|<=|!=|:|=|>|<)/.exec(
      input.slice(token.start, token.end),
    )?.[0] ?? "";
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
