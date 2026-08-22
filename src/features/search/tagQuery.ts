import type { TagNamespace } from "@/lib/ipc";

/**
 * Scryfall's tagger syntax, read out of the card search box.
 *
 * `o:ramp`, `otag:"spot removal"`, `-a:dragon` — the keyword names a taxonomy, the value names
 * a tag, and everything the parser does not recognise is left alone as free text for FTS. This
 * module is the whole of the grammar; `tagResolve` turns a value into a slug and
 * `filters::TagTerms` is what the slugs become.
 *
 * # Only the keywords, and deliberately not the rest of Scryfall's language
 *
 * Scryfall's query language has `or`, parentheses, comparison operators and forty more
 * keywords. None of that is here, because the backend filter cannot express it: every included
 * tag becomes its own `EXISTS` and they are ANDed, so `or` would need new SQL in `filters.rs`
 * *and* a matching change in `index/facets.rs` — materially more work than this whole feature.
 * What is here is exactly what `TagTerms { include, exclude }` can already say: tags AND
 * together, and `-` puts one in the other list. A reader who types `or` gets it as free text.
 *
 * # `a:` and `o:` mean something else on Scryfall, and that is the point
 *
 * On Scryfall `a:` is `artist:` and `o:` is `oracle:` — the card's rules text. Here they are the
 * art and oracle **taxonomies**, which is a deliberate departure asked for on 2026-08-22:
 * `atag:`/`otag:` are the spellings nobody mistypes and also the ones nobody reaches for twice
 * a minute. Nothing in this app collides today — the box had no keyword syntax at all before
 * this module — so the cost is paid only by a reader carrying Scryfall muscle memory, and it is
 * paid in a search that returns the wrong thing rather than an error. **If artist or oracle-text
 * keywords are ever added here, they cannot have these two spellings**, and that is the reason
 * this paragraph exists rather than a line in the table below.
 *
 * # Every other alias is Scryfall's, verified rather than guessed
 *
 * The art-tags research measured all of them live against `api.scryfall.com/cards/search` on
 * 2026-08-20: `art:` `atag:` `arttag:` `art_tag:` all answer 1,145 for `dragon`, and `otag:`
 * `oracletag:` `function:` `oracle_tag:` `oracle-tag:` all answer 6,428 for `removal`, while
 * `itag:`, `ftag:` and `otags:` are HTTP 400. Separators are normalised out of the *keyword*
 * too, which is why the `_` and `-` spellings work and why {@link keywordKey} strips them
 * rather than the table listing six variants of two words.
 */

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
   *  {@link parseTagQuery}. */
  value: string;
  /** `-o:ramp`. Decides which of `TagTerms`' two lists the resolved slug lands in. */
  negated: boolean;
  /** Where the whole term — the `-`, the keyword, the colon and the value — sits in the source.
   *  Half-open, so `input.slice(start, end)` is the term. */
  start: number;
  end: number;
}

/** What one query string says: the tags, and whatever is left for FTS. */
export interface ParsedTagQuery {
  /** The unrecognised words, rejoined with single spaces. This is what rides as
   *  `SearchRequest.text`, so `dragon a:dragon` searches the name *and* filters by the motif. */
  text: string;
  tokens: TagToken[];
}

/**
 * A keyword's identity: lowercased with every separator dropped.
 *
 * Scryfall normalises separators out of the keyword as well as out of the value, which is why
 * `oracle_tag:` and `oracle-tag:` both work there. Doing the same here means the table below
 * lists the two real names rather than six spellings of them — and it is a different function
 * from the *value's* normalisation, which is Rust's (`tags::normalize`) and must stay Rust's:
 * two copies of the value rule would leave both halves self-consistent and the search matching
 * nothing.
 */
function keywordKey(word: string): string {
  return word.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
}

/**
 * Every keyword, by the taxonomy it names.
 *
 * Keyed by {@link keywordKey}, so `art_tag`, `art-tag` and `ARTTAG` all arrive as `arttag`.
 */
const NAMESPACE_BY_KEYWORD = new Map<string, TagNamespace>([
  // Scryfall's three, plus the `a:` asked for here.
  ["art", "art"],
  ["atag", "art"],
  ["arttag", "art"],
  ["a", "art"],
  // Scryfall's three, plus the `o:` asked for here.
  ["otag", "oracle"],
  ["oracletag", "oracle"],
  ["function", "oracle"],
  ["o", "oracle"],
]);

/**
 * The keywords a reader can type, for the box's help text — grouped, so the hint can say which
 * taxonomy each names rather than listing eight words in one row.
 *
 * Exported so the hint, the test and this table are one list. A ninth keyword added above shows
 * up in the UI without a second edit, which is the point.
 */
export const TAG_KEYWORDS: Readonly<Record<TagNamespace, readonly string[]>> = {
  art: ["art", "atag", "arttag", "a"],
  oracle: ["otag", "oracletag", "function", "o"],
};

/** `keyword:value`, with the optional leading `-`. The value is whatever the scanner decided the
 *  term was, quotes and all — {@link unquote} deals with those. */
const TERM = /^(-?)([A-Za-z][A-Za-z0-9_-]*):([\s\S]*)$/;

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
 * One whitespace-separated chunk of the source, read three ways.
 *
 * `"text"` is a chunk that is not a tag term at all and goes to FTS. `"partial"` is a known
 * keyword with nothing after it yet — **neither a token nor free text**, and the distinction is
 * what the three-way answer exists for: as a token `o:` would sit there reporting `""` as an
 * unknown tag through the whole of the next word, and as free text it would search the corpus
 * for `o`. Every keystroke on the way to a tag passes through that state, so it is the common
 * case rather than an edge one.
 */
function tokenFrom(chunk: string, start: number, end: number): TagToken | "partial" | "text" {
  const m = TERM.exec(chunk);
  if (!m) return "text";
  const namespace = NAMESPACE_BY_KEYWORD.get(keywordKey(m[2]));
  if (!namespace) return "text";
  const value = unquote(m[3]).trim();
  if (value === "") return "partial";
  return { namespace, value, negated: m[1] === "-", start, end };
}

/**
 * Split a query string into tag terms and the free text around them.
 *
 * The scan is whitespace-separated with one exception: a quote swallows spaces, so
 * `otag:"spot removal"` is one chunk and `spot` does not fall out of it into the FTS text.
 * Unbalanced quotes run to the end of the string, which is the state the box is in for as long
 * as it takes to type the closing one.
 *
 * Order is preserved and nothing is deduplicated here — two chips reading the same tag is a
 * thing the reader can see and fix, whereas a term that vanished on being typed twice is not.
 * `filters::picked_tags` sorts and dedups the slugs at the far end anyway.
 */
export function parseTagQuery(input: string): ParsedTagQuery {
  const tokens: TagToken[] = [];
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
    else if (token !== "partial") tokens.push(token);
  }
  return { text: words.join(" "), tokens };
}

/**
 * The query with one term taken out — what a chip's ✕ writes back into the box.
 *
 * The box stays the single source of truth for the query, so removing a chip edits the text the
 * reader can see rather than a hidden second list that would then disagree with it. The space
 * collapse is what stops `a:dog b` becoming `  b` after a removal.
 */
export function removeToken(input: string, token: TagToken): string {
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
export function setTokenNegated(input: string, token: TagToken, negated: boolean): string {
  const term = input.slice(token.start, token.end).replace(/^-/, "");
  return `${input.slice(0, token.start)}${negated ? "-" : ""}${term}${input.slice(token.end)}`;
}

/**
 * The query with one term's *value* replaced, keeping the keyword the reader typed — what
 * pressing a suggested tag under a "no such tag" note writes back.
 *
 * The keyword is carried over rather than normalised to a canonical one: a reader who types
 * `o:` and takes a suggestion should get `o:` back, not `oracletag:`. A value with a space in
 * it is quoted on the way in, because the scanner splits on whitespace and an unquoted phrase
 * would come back as one tag term and one stray word.
 */
export function setTokenValue(input: string, token: TagToken, value: string): string {
  const keyword = /^-?[A-Za-z][A-Za-z0-9_-]*:/.exec(input.slice(token.start, token.end))?.[0] ?? "";
  const quoted = /\s/.test(value) ? `"${value}"` : value;
  return `${input.slice(0, token.start)}${keyword}${quoted}${input.slice(token.end)}`;
}

/**
 * A token's identity for a React key and for the resolve query's cache key — the namespace and
 * the value, never the value alone.
 *
 * `chipKey`'s rule in `tagFilters.ts`, for the same reason: the two taxonomies share plenty of
 * slugs and `dog` is in both. Case-folded because the resolver is, so `A:Dog` and `a:dog` are
 * one question and cost one round trip.
 */
export function tokenKey(token: Pick<TagToken, "namespace" | "value">): string {
  return `${token.namespace}:${token.value.toLowerCase()}`;
}
