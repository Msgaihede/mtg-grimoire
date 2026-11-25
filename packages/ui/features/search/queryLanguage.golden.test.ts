import { describe, expect, it } from "vitest";
import { COLOR_NAMES, parseQuery, QUERY_KEYWORDS, QUERY_VOCABULARY } from "./queryLanguage";

/**
 * **The query grammar as a file two languages hold** — `__golden__/query-language.json`.
 *
 * The MCP server takes Scryfall syntax and has no window to ask, so this module's grammar is
 * ported to Rust (`crates/grimoire-core/src/query_language.rs`), and the golden is what keeps the
 * two one grammar rather than two that happen to agree today. **The Rust port reads this file and
 * must answer the same parse for every query in it** — `parseQuery`'s answer exactly, spans and
 * all, its byte offsets converted to the UTF-16 ones written here — and must hold its vocabulary
 * constants equal to `tables`. `pnpm vitest run -u` rewrites the file after an intended change to
 * the grammar, and the diff is the review; the Rust follows in the same change, or its test goes
 * red. The design is `docs/superpowers/specs/2026-11-25-mcp-scryfall-syntax-design.md` §6.
 *
 * Three parts. `tables` is every table the parser reads. `cases` are hand-picked, each named for
 * what it pins: every branch of the grammar, and every place where JavaScript's standard library
 * and Rust's disagree — whitespace, letters, case, UTF-16 offsets — because those are where a
 * faithful port goes wrong without any line of it looking wrong. `random` is 500 queries from a
 * seeded generator, for the corners nobody thought to name. The queries are stored, so Rust needs
 * no generator; the seed is stored so the set can be regrown on purpose.
 *
 * **Every string is escaped to ASCII**, each UTF-16 code unit from U+007F up written as `\uXXXX`.
 * A third of these cases are about characters a diff draws as nothing — a no-break space, U+FEFF,
 * U+0085 — and a reviewer has to be able to see which one moved. The layout is fixed by hand
 * rather than by `JSON.stringify`'s indent, one case per line, so a changed parse is a changed
 * line and not a reflowed screen; `.prettierignore` keeps Prettier from undoing that.
 */

/** `JSON.stringify`, then every code unit from U+007F up as `\uXXXX` — see the module doc. */
function asciiJson(value: unknown, indent?: number): string {
  return JSON.stringify(value, null, indent).replace(
    /[\u007f-\uffff]/g,
    (unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/** Every table the parser reads, as plain JSON, in the order the module declares its entries. */
function tables() {
  const { displayKeywords, vocabulary, languageCodes, rarityWords, crossFields } = QUERY_VOCABULARY;
  return {
    keywords: QUERY_KEYWORDS.map((spec) => ({
      target: typeof spec.target === "string" ? spec.target : { tag: spec.target.tag },
      keywords: [...spec.keywords],
      defaultOp: spec.defaultOp,
      ops: [...spec.ops],
      example: spec.example,
      blurb: spec.blurb,
      section: spec.section,
    })),
    displayKeywords: [...displayKeywords],
    vocabulary: Object.fromEntries(
      Object.entries(vocabulary).map(([field, words]) => [field, [...(words ?? [])]]),
    ),
    languageCodes: Object.fromEntries(languageCodes),
    rarityWords: Object.fromEntries(rarityWords),
    crossFields: Object.fromEntries(crossFields),
    colorNames: [...COLOR_NAMES],
  };
}

/**
 * Every keyword spelling of every row, with that row's example operator and value — the existing
 * suite's "lists only keywords the parser actually reads", as cases. Each spelling is its own entry
 * in the keyword map, so each is a place the port could mistype one. Built from the table rather
 * than listed, so a spelling added to a row is a case without a second edit.
 */
const SPELLINGS: [string, string][] = QUERY_KEYWORDS.flatMap((spec) =>
  spec.keywords.map((keyword): [string, string] => [
    `spelling ${keyword}`,
    `${keyword}${spec.example.slice(spec.example.search(/[:=<>!]/))}`,
  ]),
);

/**
 * The hand-picked cases, `[name, query]`.
 *
 * The first half is every input `queryLanguage.test.ts` hands `parseQuery`, by its describe
 * block — except its loop over all of `IS_VALUES`, which is the first and the last word here
 * like every other vocabulary's, since `tables` holds the whole list. The second half exists
 * because there are two implementations now. Invisible characters are written as escapes, so the
 * source says which one a case is about.
 */
const CASES: readonly (readonly [name: string, query: string])[] = [
  // Tags.
  ["tags: every art spelling", "art:dragon atag:dragon arttag:dragon art_tag:dragon"],
  [
    "tags: every oracle spelling",
    "otag:removal oracletag:removal function:removal oracle_tag:removal",
  ],
  ["tags: oracle-tag, a dash in the keyword", "oracle-tag:removal"],
  ["tags: keywords in any case", "OTAG:removal Art:dragon ArtTag:dragon"],
  ["tags: unknown tag keywords are text", "itag:dragon ftag:removal otags:removal bolt"],
  ["tags: quoted value between words", 'bolt otag:"spot removal" dragon'],
  ["tags: single-quoted value", "otag:'spot removal'"],
  ["tags: unterminated double quote", 'otag:"spot removal'],
  ["tags: negated and plain", "-atag:dragon otag:ramp -otag:removal"],
  ["tags: keywords with no value are dropped", "otag: -atag: bolt"],
  ["tags: one tag twice", "atag:dog atag:dog"],
  ["empty query", ""],
  ["spaces only", "   "],
  ["tags: span of a negated quoted tag", 'bolt -otag:"spot removal" x'],
  ["tags: both taxonomies", "atag:dog otag:ramp"],
  ["tags: between two words", "bolt atag:dragon lightning"],
  ["tags: negated quoted tag last", 'bolt -otag:"spot removal"'],
  ["tags: a tag repeated around another", "atag:dog otag:ramp atag:dog"],
  ["tags: misspelt tag between words", "bolt -atag:dogg x"],
  ["tags: one-word oracle tag", "otag:spot"],
  ["tags: between single words", "bolt atag:dragon x"],
  ["tags: negated between single words", "bolt -atag:dragon x"],
  ["tags: quoted alone", 'otag:"spot removal"'],
  ["tags: negated alone", "-atag:dog"],
  ["tags: otag:ramp", "otag:ramp"],
  ["tags: oracletag:ramp", "oracletag:ramp"],
  ["tags: function:ramp", "function:ramp"],
  ["tags: oracle_tag:ramp", "oracle_tag:ramp"],
  ["tags: art-tag:dragon", "art-tag:dragon"],

  // Spans under uneven spacing (issue #1565).
  ["spans: double space before terms", "bolt  cmc>=3 mv>=3"],
  ["spans: leading space", " cmc>=3 mv>=3"],
  ["spans: uneven spacing all through", "  cmc>=3   bolt  mv>=3 "],
  ["spans: double space, word between", "bolt  cmc>=3 x mv>=3"],

  // A lone term of a parenthesised group takes the group's span (issue #1565).
  ["lone child: unclosed tag group", "(otag:remov"],
  ["lone child: closed tag group", "(otag:remov)"],
  ["lone child: negated tag group", "-(otag:remov)"],
  ["lone child: dangling or", "(otag:remov or "],
  ["lone child: empty keyword beside it", "(otag:remov t:"],
  ["lone child: two parens, negated inside", "bolt ((-otag:remov))"],
  ["lone child: tag beside a type", "(otag:remov t:elf)"],

  // Operators and the a:/o: reassignment.
  ["op: c: is at least", "c:rg"],
  ["op: id: is at most", "id:rg"],
  ["op: cmc: is equality", "cmc:3"],
  ["op: negated type", "-t:goblin"],
  ["op: two types are two terms", "t:creature t:goblin"],
  ["a/o: o: is rules text", "o:ramp"],
  ["a/o: a: is the artist", "a:rebecca"],
  ["a/o: both", "o:ramp a:rebecca"],

  // Partial and unparseable.
  ["partial: cmc>", "cmc>"],
  ["partial: cmc>=", "cmc>="],
  ["partial: otag:", "otag:"],
  ["bare keyword: power", "power"],
  ["bare keyword: art", "art"],
  ["bare keyword: set", "set"],
  ["bare keyword: type", "type"],
  ["bare keyword: legal", "legal"],
  ["bare keyword: oracle", "oracle"],
  ["bare keyword: t", "t"],
  ["bare keyword: o", "o"],
  ["bare keyword: power sink", "power sink"],
  ["word before a term", "bolt t:goblin"],
  ["unparseable value is text", "cmc>=banana"],
  ["unknown keyword is text", "itag:dragon"],

  // A negated name (issue #571).
  ["name out: -bolt", "-bolt"],
  ["name out: quoted phrase between words", 'bolt -"lightning bolt" x'],
  ["name out: single-quoted phrase", "-'lightning bolt'"],
  ["name out: unterminated phrase", '-"lightning bol'],
  ["text: one word", "bolt"],
  ["text: quoted phrase", '"lightning bolt"'],
  ["text: hyphenated word", "god-pharaoh"],
  ["name out: beside text and a term", "lightning -bolt -t:creature"],
  ["name out: unparseable term negated", "-cmc>=banana"],
  ["name out: unknown keyword negated", "-itag:dragon"],
  ["nothing: lone dash", "-"],
  ["nothing: dash and quote", '-"'],
  ["nothing: two dashes", "--"],
  ["nothing: dash and bangs", "-!!!"],
  ["nothing: word then dash", "bolt -"],
  ["name out: Cyrillic", "-Молния"],
  ["name out: after a type", "t:instant -bolt"],
  ["text: after a type", "t:instant bolt"],

  // An apostrophe inside a word (issue #552).
  ["apostrophe: possessive then a term", "sensei's -t:artifact"],
  ["apostrophe: urza's saga", "urza's saga"],
  ["apostrophe: ajani's then a colour", "ajani's pridemate c:w"],
  ["apostrophe: in a value, then a term", "o:can't t:creature"],
  ["apostrophe: possessive excluded", "-urza's t:land"],
  ["apostrophe: quoted possessive excluded", `-"urza's saga" t:land`],
  ["apostrophe: single-quoted value, then a term", "o:'can't block' t:creature"],
  ["apostrophe: inside double quotes", `o:"can't block"`],
  ["apostrophe: single quote opens a chunk", "'lightning bolt' t:instant"],
  ["apostrophe: single quote opens a value", "otag:'spot removal' bolt"],

  // Or and parentheses (issue #909).
  ["or: two terms", "t:goblin or t:elf"],
  ["or: OR", "t:goblin OR t:elf"],
  ["or: Or", "t:goblin Or t:elf"],
  ["or: and binds tighter, after", "t:goblin or t:elf c:r"],
  ["or: and binds tighter, before", "c:r t:goblin or t:elf"],
  ["or: parens override", "(t:goblin or t:elf) c:r"],
  ["and: dropped", "t:goblin and c:r"],
  ["and: AND", "t:goblin AND c:r"],
  ["and: juxtaposed", "t:goblin c:r"],
  ["and: between words", "fire and ice"],
  ["or: dangling at the end", "t:goblin or"],
  ["or: dangling at the start", "or t:goblin"],
  ["or: doubled", "t:goblin or or t:elf"],
  ["or: alone", "or"],
  ["or: dangling in parens", "(t:goblin or)"],
  ["group: plain conjunction flattened", "(t:goblin c:r) bolt"],
  ["group: negated conjunction", "-(t:goblin c:r)"],
  ["group: negated or", "-(t:goblin or t:elf)"],
  ["group: nested or folds", "((t:goblin or t:elf) or t:dwarf)"],
  ["group: or of and of or", "t:goblin or (c:r (t:elf or t:dwarf))"],
  ["group: nested and folds under a negation", "-(t:goblin (c:r c:g))"],
  ["group: one term", "(t:goblin)"],
  ["group: one term, negated", "-(t:goblin)"],
  ["group: one negated term", "(-t:goblin)"],
  ["group: double negation", "-(-t:goblin)"],
  ["group: negated, doubly parenthesised or", "-((t:goblin or t:elf))"],
  ["group: one word", "(bolt)"],
  ["group: one word, negated", "-(bolt)"],
  ["group: one tag, negated", "-(otag:removal)"],
  ["group: lone term span between words", "bolt -(t:goblin) x"],
  ["group: empty", "()"],
  ["group: empty, negated", "-()"],
  ["group: only a partial term", "(otag:)"],
  ["group: only or", "(or)"],
  ["group: only a space", "( )"],
  ["group: unclosed or", "c:r (t:goblin or t:elf"],
  ["group: lone open after a term", "c:r ("],
  ["group: stray close", "bolt)"],
  ["group: one close too many", "(bolt))"],
  ["group: open inside a word", "foo(bar"],
  ["group: close inside a word", "x)y"],
  ["quotes: or inside quotes", 'o:"(this or that)"'],
  ["quotes: or inside a quoted phrase", '"fight or flight"'],
  ["quotes: close after a double quote", '(o:"draw a card" or t:goblin)'],
  ["quotes: close after a single quote", "(o:'can't block' or t:wall)"],
  ["quotes: close inside an unterminated quote", '(o:"draw)'],
  ["or: two words", "bolt or shock"],
  ["or: name exclusion in a group", "(t:goblin or -bolt)"],
  ["or: tags in a group", "(otag:removal or -atag:dragon)"],
  ["or: tag beside a group", "otag:ramp (t:elf or t:druid)"],
  ["group: span with dash, parens and quotes", 'bolt -(t:goblin or o:"draw a card") x'],
  ["or: span without parens", "t:goblin or t:dwarf"],
  ["or: negated second term", "t:goblin or -t:elf"],
  ["or: capitalised value", "t:Goblin or t:elf"],
  ["or: parenthesised", "(t:goblin or t:elf)"],
  ["or: parenthesised, unclosed", "(t:goblin or t:elf"],
  ["or: negated first term", "-t:goblin or t:elf"],
  ["or: group between a term and a word", "c:r (t:goblin or t:elf) x"],
  ["or: negated group between a term and a word", "c:r -(t:goblin or t:elf) x"],

  // Exact names and not:.
  ["exact: one word", "!fire"],
  ["exact: double-quoted", '!"lightning bolt"'],
  ["exact: single-quoted", "!'lightning bolt'"],
  ["exact: negated, then a term", '-!"lightning bolt" t:instant'],
  ["exact: bang alone", "!"],
  ["exact: bang and quote", '!"'],
  ["exact: dash and bang", "-!"],
  ["exact: three bangs", "!!!"],
  ["exact: unterminated", '!"lightning bol'],
  ["exact: negated alone", '-!"lightning bolt"'],
  ["name: equals", "name=fire"],
  ["not: is negated", "not:reprint"],
  ["not: dash cancels", "-not:reprint"],
  ["not: any case", "NOT:Reprint"],
  ["not: beside a type", "not:reprint t:elf"],
  ["is: reprint", "is:reprint"],
  ["is: misspelt", "is:fetchlnad"],
  ["not: unknown value", "not:banana"],

  // Display keywords and refusals.
  ["display: unique:prints", "unique:prints"],
  ["display: unique:art", "unique:art"],
  ["display: order:cmc", "order:cmc"],
  ["display: direction:desc", "direction:desc"],
  ["display: prefer:newest", "prefer:newest"],
  ["display: display:grid", "display:grid"],
  ["display: include:extras", "include:extras"],
  ["display: Unique=prints", "Unique=prints"],
  ["display: between a term and a word", "t:elf unique:prints bolt"],
  ["display: include: another value", "include:foils"],
  ["display: bare word", "order"],
  ["regex: o:/^draw/", "o:/^draw/"],
  ["regex: name:/bolt/", "name:/bolt/"],
  ["unsupported: cube:", "cube:vintage"],
  ["unsupported: cheapest:", "cheapest:usd"],
  ["unsupported: artists>", "artists>1"],
  ["unsupported: illustrations>", "illustrations>1"],

  // The long tail of keywords (issue #909).
  ["default op: devotion", "devotion:uuu"],
  ["default op: produces", "produces:g"],
  ["default op: is:dual", "is:dual"],
  ["default op: loy", "loy:3"],
  ["default op: pt", "pt:10"],
  ["default op: cn", "cn:1"],
  ["default op: year", "year:1994"],
  ["default op: usd", "usd:1"],
  ["default op: prints", "prints:1"],
  ["colour name: id:esper", "id:esper"],
  ["colour name: id:Azorius", "id:Azorius"],
  ["colour name: id:silverquill", "id:silverquill"],
  ["colour name: id:glint-eye", "id:glint-eye"],
  ["colour name: id:m", "id:m"],
  ["colour name: id:multicolor", "id:multicolor"],
  ["colour name: id:wubrg", "id:wubrg"],
  ["colour count: c=2", "c=2"],
  ["colour count: id>=3", "id>=3"],
  ["colour name: c:green", "c:green"],
  ["colour name: c:white", "c:white"],
  ["colour name: c:blue", "c:blue"],
  ["colour name: c:black", "c:black"],
  ["colour name: c:red", "c:red"],
  ["colour name: c:c", "c:c"],
  ["colour name: c:colorless", "c:colorless"],
  ["colour name: c:colourless", "c:colourless"],
  ["colour name: c:multi", "c:multi"],
  ["colour name: c:multicolour", "c:multicolour"],
  ["colour name: id:white", "id:white"],
  ["colour name: id:blue", "id:blue"],
  ["colour name: id:black", "id:black"],
  ["colour name: id:red", "id:red"],
  ["colour name: id:green", "id:green"],
  ["colour name: id:c", "id:c"],
  ["colour name: id:colorless", "id:colorless"],
  ["colour name: id:colourless", "id:colourless"],
  ["colour name: id:multi", "id:multi"],
  ["colour name: id:multicolour", "id:multicolour"],
  ["colour name: beside a type", "c:red t:goblin"],
  ["colour name: negated", "t:goblin -c:red"],
  ["colour name: capitalised", "c:Red"],
  ["colour letters: capitalised, sent as typed", "c:RG"],
  ["colour name: capitalised wubrg is folded", "c:WUBRG"],
  ["cross field: pow>tou", "pow>tou"],
  ["cross field: tou>power", "tou>power"],
  ["cross field: cmc<loy", "cmc<loy"],
  ["cross field: loy=mv", "loy=mv"],
  ["cross field: pt>=manavalue", "pt>=manavalue"],
  ["cross field: not for a type line", "t:pow"],
  ["even: cmc:even", "cmc:even"],
  ["odd: mv!=odd", "mv!=odd"],
  ["even: refused for >", "cmc>even"],
  ["even: refused for power", "pow:even"],
  ["rarity: r:special", "r:special"],
  ["rarity: r:b", "r:b"],
  ["rarity: special refused for >=", "r>=special"],
  ["mana: bare symbols", "m:2uu"],
  ["mana: hybrid and Phyrexian, equals", "m={2/W}{G/P}"],
  ["mana: a word is refused", "m:green"],
  ["devotion: hybrid pairs", "devotion>={U/B}{U/B}"],
  ["devotion: a number is refused", "devotion:2"],
  ["produces: equals c", "produces=c"],
  ["produces: x is refused", "produces:x"],
  ["date: year", "date>=2020"],
  ["date: year and month", "date>=2020-06"],
  ["date: full", "date>=2020-06-26"],
  ["date: set code", "date>=dom"],
  ["date: capital set code", "date>=M21"],
  ["date: a word is refused", "date>=yesterday"],
  ["year: two digits refused", "year:94"],
  ["price: usd<0.5", "usd<0.5"],
  ["price: eur>=.5", "eur>=.5"],
  ["price: a word is refused", "tix<cheap"],
  ["price: negative refused", "usd<-1"],
  ["count: a fraction is refused", "paperprints>1.5"],
  ["collector number: equality is a string", "cn:12a"],
  ["collector number: a range needs a number", "cn>12a"],
  ["vocabulary: game:Arena", "game:Arena"],
  ["vocabulary: border:Borderless", "border:Borderless"],
  ["vocabulary: two frames", "frame:future frame:showcase"],
  ["vocabulary: stamp:triangle", "stamp:triangle"],
  ["vocabulary: has:indicator", "has:indicator"],
  ["vocabulary: new:rarity", "new:rarity"],
  ["vocabulary: game:xbox refused", "game:xbox"],
  ["vocabulary: border:blue refused", "border:blue"],
  ["vocabulary: frame:2020 refused", "frame:2020"],
  ["vocabulary: stamp:star refused", "stamp:star"],
  ["vocabulary: has:wings refused", "has:wings"],
  ["vocabulary: new:x refused", "new:x"],
  ["language: name", "language:Japanese"],
  ["language: dashed name", "lang:ancient-greek"],
  ["language: unknown", "lang:klingon"],
  ["open vocabulary: in:", "in:lea in:arena in:Japanese"],
  ["open vocabulary: four keywords", "st:masters b:zen banned:modern restricted:vintage"],
  ["open vocabulary: quoted flavor", 'ft:"the gods"'],
  ["open vocabulary: fo and fulloracle", "fo:flying fulloracle:trample"],
  ["refused op: is>dual", "is>dual"],
  ["refused op: has=flavor", "has=flavor"],
  ["refused op: game>arena", "game>arena"],
  ["refused op: new=art", "new=art"],
  ["refused op: otag>removal", "otag>removal"],
  ["label: negated exact name", "-!fire"],

  // Every keyword spelling, from the table.
  ...SPELLINGS,

  // Whitespace — `/\s/` and `.trim()`, which are not Rust's `char::is_whitespace`.
  ["space: U+00A0 separates", "t:goblin\u00a0bolt"],
  ["space: U+1680 separates", "t:goblin\u1680bolt"],
  ["space: U+2000 separates", "t:goblin\u2000bolt"],
  ["space: U+200A separates", "t:goblin\u200abolt"],
  ["space: U+2028 separates", "t:goblin\u2028bolt"],
  ["space: U+2029 separates", "t:goblin\u2029bolt"],
  ["space: U+202F separates", "t:goblin\u202fbolt"],
  ["space: U+205F separates", "t:goblin\u205fbolt"],
  ["space: U+3000 separates", "t:goblin\u3000bolt"],
  ["space: U+FEFF separates", "t:goblin\ufeffbolt"],
  ["space: tab separates", "t:goblin\tbolt"],
  ["space: newline separates", "t:goblin\nbolt"],
  ["space: CR separates", "t:goblin\rbolt"],
  ["space: vertical tab separates", "t:goblin\u000bbolt"],
  ["space: form feed separates", "t:goblin\fbolt"],
  ["space: U+0085 is part of the word", "t:goblin\u0085bolt"],
  ["space: U+180E is part of the word", "t:goblin\u180ebolt"],
  ["space: U+200B is part of the word", "t:goblin\u200bbolt"],
  ["space: U+FEFF around a term", "\ufefft:goblin\ufeff"],
  ["space: U+0085 before a keyword makes a word", "\u0085t:goblin"],
  ["space: U+0085 as a whole value", "t:\u0085"],
  ["space: U+00A0 around or", "t:goblin\u00a0or\u00a0t:elf"],
  ["space: U+0085 after or makes a word", "t:goblin or\u0085 t:elf"],
  ["trim: strips U+00A0", 'o:"\u00a0draw\u00a0"'],
  ["trim: strips U+FEFF", 'o:"\ufeffdraw\ufeff"'],
  ["trim: keeps U+0085", 'o:"\u0085draw\u0085"'],
  ["trim: U+3000 alone is empty", 'o:"\u3000"'],
  ["trim: U+0085 alone is a value", 'o:"\u0085"'],
  ["trim: line separators around a name out", '-"\u2028bolt\u2029"'],
  ["trim: exact name in no-break spaces", '!"\u00a0fire\u00a0"'],
  ["trim: U+0085 alone is no name to exclude", '-"\u0085"'],
  ["trim: U+0085 kept in a name out", '-"\u0085bolt"'],
  ["trim: tag keeps a trailing U+0085", 'otag:"\u00a0ramp\u0085"'],
  ["quote: U+00A0 after an apostrophe closes", "o:'a'\u00a0b'"],
  ["quote: U+0085 after an apostrophe does not", "o:'a'\u0085b'"],
  ["paren: U+0085 after a close keeps it a character", "(t:goblin)\u0085"],
  ["paren: U+00A0 after a close", "(t:goblin)\u00a0x"],
  ["mana: U+0085 inside braces is a symbol", 'm:"{\u0085}"'],
  ["mana: U+00A0 inside braces is refused", 'm:"{\u00a0}"'],

  // Letters, marks and numbers — `\p{L}`/`\p{N}`, which is not `char::is_alphanumeric`.
  ["letter: Æther", "Æther"],
  ["letter: Lim-Dûl", "Lim-Dûl"],
  ["letter: -Lim-Dûl", "-Lim-Dûl"],
  ["letter: t:Æther", "t:Æther"],
  ["letter: circled A is not a letter", "-Ⓐ"],
  ["letter: circled small a is not a letter", "-ⓐ"],
  ["letter: lone combining mark", "-\u0301"],
  ["letter: letter and combining mark", "-a\u0301"],
  ["letter: emoji is no name to exclude", "-😀"],
  ["letter: emoji is no exact name", "!😀"],
  ["letter: emoji beside a word, exact", '!"😀 bolt"'],
  ["letter: ellipsis is no name to exclude", '-"…"'],
  ["letter: CJK", "-稲妻"],
  ["letter: Arabic-Indic digit", "-٣"],
  ["letter: Roman numeral twelve", "-Ⅻ"],
  ["ascii: Arabic-Indic digit is not a number", "cmc:٣"],
  ["ascii: fullwidth digit is not a number", "cmc:３"],
  ["ascii: fullwidth keyword is a word", "ｔ:goblin"],
  ["ascii: non-ASCII keyword is a word", "tÆ:goblin"],
  ["ascii: long s is not s in a mana cost", "m:ſ"],
  ["ascii: long s is not a rarity", "r:ſ"],
  ["ascii: non-ASCII dropped from a colour name", "c:rÆed"],
  ["ascii: emoji dropped from an is: value", "is:fetch😀land"],
  ["ascii: non-ASCII dropped from a game", "game:arÆena"],
  ["ascii: emoji as a whole game value", "game:😀"],
  ["ascii: emoji in braces is a mana symbol", "m:{😀}"],

  // Astral characters before a span, so the UTF-16 offsets are exercised.
  ["astral: emoji before a term", "😀 t:goblin"],
  ["astral: two emoji before a group and a name out", "😀😀 (t:goblin or t:elf) -bolt"],
  ["astral: mathematical letter before a tag", "𝔊oblin otag:ramp"],

  // Case folding.
  ["case: OR alone", "OR"],
  ["case: AND alone", "AND"],
  ["case: Or between words", "bolt Or shock"],
  ["case: AND between words", "fire AND ice"],
  ["case: T:goblin", "T:goblin"],
  ["case: CMC>=3", "CMC>=3"],
  ["case: IS:FETCHLAND", "IS:FETCHLAND"],
  ["case: R:RARE", "R:RARE"],
  ["case: LANG:JAPANESE", "LANG:JAPANESE"],
  ["case: dotted capital I in a type", "t:İstanbul"],
  ["case: dotted capital I is not a rarity", "r:İ"],
  ["case: sharp s is not extras", "include:ß"],
  ["case: sharp s excluded", "-ß"],
  ["case: İ OR ß", "İ OR ß"],
  ["case: include:EXTRAS", "include:EXTRAS"],
  ["case: include:ExTrAs", "include:ExTrAs"],

  // Every operator on one keyword of each field kind.
  ["op t=", "t=goblin"],
  ["op t!=", "t!=goblin"],
  ["op t>", "t>goblin"],
  ["op t>=", "t>=goblin"],
  ["op t<", "t<goblin"],
  ["op t<=", "t<=goblin"],
  ["op c=", "c=rg"],
  ["op c!=", "c!=rg"],
  ["op c>", "c>rg"],
  ["op c<", "c<rg"],
  ["op c<=", "c<=rg"],
  ["op cmc=", "cmc=3"],
  ["op cmc!=", "cmc!=3"],
  ["op cmc>", "cmc>3"],
  ["op cmc<", "cmc<3"],
  ["op cmc<=", "cmc<=3"],
  ["op pow: cross field", "pow:tou"],
  ["op pow= cross field", "pow=tou"],
  ["op pow!= cross field", "pow!=tou"],
  ["op pow>= cross field", "pow>=tou"],
  ["op pow< cross field", "pow<tou"],
  ["op pow<= cross field", "pow<=tou"],
  ["op r:", "r:rare"],
  ["op r=", "r=rare"],
  ["op r!=", "r!=rare"],
  ["op r>", "r>rare"],
  ["op r<", "r<rare"],
  ["op r<=", "r<=rare"],
  ["op r!= special is equality", "r!=special"],
  ["op r< bonus refused", "r<bonus"],
  ["op s=", "s=neo"],
  ["op s!= refused", "s!=neo"],
  ["op s> refused", "s>neo"],
  ["op s>= refused", "s>=neo"],
  ["op s< refused", "s<neo"],
  ["op s<= refused", "s<=neo"],
  ["op game=", "game=arena"],
  ["op game!= refused", "game!=arena"],
  ["op game>= refused", "game>=arena"],
  ["op game< refused", "game<arena"],
  ["op game<= refused", "game<=arena"],
  ["op is= refused", "is=dual"],
  ["op is!= refused", "is!=dual"],
  ["op is>= refused", "is>=dual"],
  ["op is< refused", "is<dual"],
  ["op is<= refused", "is<=dual"],
  ["op prints!=", "prints!=1"],
  ["op prints>", "prints>1"],
  ["op prints>=", "prints>=1"],
  ["op prints<", "prints<1"],
  ["op prints<=", "prints<=1"],
  ["op usd=", "usd=1"],
  ["op usd!=", "usd!=1"],
  ["op usd>", "usd>1"],
  ["op usd>=", "usd>=1"],
  ["op usd<=", "usd<=1"],
  ["op date:", "date:2020-01-01"],
  ["op date=", "date=2020-01-01"],
  ["op date!=", "date!=2020-01-01"],
  ["op date>", "date>2020-01-01"],
  ["op date<", "date<2020-01-01"],
  ["op date<=", "date<=2020-01-01"],
  ["op year=", "year=1994"],
  ["op year!=", "year!=1994"],
  ["op year>", "year>1994"],
  ["op year>=", "year>=1994"],
  ["op year<", "year<1994"],
  ["op lang=", "lang=ja"],
  ["op lang!= refused", "lang!=ja"],
  ["op lang> refused", "lang>ja"],
  ["op lang>= refused", "lang>=ja"],
  ["op lang< refused", "lang<ja"],
  ["op lang<= refused", "lang<=ja"],
  ["op otag= refused", "otag=removal"],
  ["op atag< refused", "atag<dragon"],
  ["op >== is >= then =3", "cmc>==3"],
  ["op => is = then >3", "cmc=>3"],
  ["op <> is < then >3", "cmc<>3"],
  ["op ! is not an operator", "cmc!3"],
  ["op a!b", "a!b"],
  ["op refused, no value, is text", "t>"],
  ["op refused on is:, no value, is text", "is>"],

  // Every vocabulary's first and last word.
  ["first word: game:paper", "game:paper"],
  ["last word: game:mtgo", "game:mtgo"],
  ["first word: border:black", "border:black"],
  ["last word: border:yellow", "border:yellow"],
  ["first word: stamp:oval", "stamp:oval"],
  ["last word: stamp:heart", "stamp:heart"],
  ["last word: has:stamp", "has:stamp"],
  ["last word: new:card", "new:card"],
  ["first word: is:split", "is:split"],
  ["last word: is:pathway", "is:pathway"],
  ["first word: frame:1993", "frame:1993"],
  ["last word: frame:spree", "frame:spree"],
  ["colour group: guilds, azorius", "c:azorius"],
  ["colour group: shards, bant", "c:bant"],
  ["colour group: wedges, abzan", "c:abzan"],
  ["colour group: four colours, glint", "c:glint"],
  ["colour group: four colours long, glinteye", "c:glinteye"],
  ["colour group: wubrg", "c:wubrg"],
  ["colour group: fivecolor", "c:fivecolor"],
  ["language: en", "lang:en"],
  ["language: es", "lang:es"],
  ["language: fr", "lang:fr"],
  ["language: de", "lang:de"],
  ["language: it", "lang:it"],
  ["language: pt", "lang:pt"],
  ["language: ko", "lang:ko"],
  ["language: ru", "lang:ru"],
  ["language: zhs", "lang:zhs"],
  ["language: zht", "lang:zht"],
  ["language: he", "lang:he"],
  ["language: la", "lang:la"],
  ["language: grc", "lang:grc"],
  ["language: ar", "lang:ar"],
  ["language: sa", "lang:sa"],
  ["language: ph", "lang:ph"],
  ["language: qya", "lang:qya"],
  ["language: any", "lang:any"],
  ["language: quenya", "lang:quenya"],
  ["rarity word: c", "r:c"],
  ["rarity word: common", "r:common"],
  ["rarity word: u", "r:u"],
  ["rarity word: uncommon", "r:uncommon"],
  ["rarity word: r", "r:r"],
  ["rarity word: m", "r:m"],
  ["rarity word: mythic", "r:mythic"],
  ["rarity word: s", "r:s"],
  ["rarity word: bonus", "r:bonus"],
  ["cross field: pow", "loy<pow"],
  ["cross field: power", "loy<power"],
  ["cross field: tou", "loy<tou"],
  ["cross field: tough", "loy<tough"],
  ["cross field: toughness", "loy<toughness"],
  ["cross field: cmc", "loy<cmc"],
  ["cross field: mv", "loy<mv"],
  ["cross field: manavalue", "loy<manavalue"],
  ["cross field: loy", "loy<loy"],
  ["cross field: loyalty", "loy<loyalty"],
  ["cross field: dashes dropped", "pow>t-o-u"],
  ["colour name: dashes dropped", "c:G-R-E-E-N"],
  ["colour letters: a dash is refused", "c:r-g"],

  // Value shapes.
  ["value: cmc:3.5", "cmc:3.5"],
  ["value: cmc:-1", "cmc:-1"],
  ["value: cmc:1.", "cmc:1."],
  ["value: cmc:.5", "cmc:.5"],
  ["value: usd:.5", "usd:.5"],
  ["value: usd:-1", "usd:-1"],
  ["value: usd:0.50", "usd:0.50"],
  ["value: m:{2/W}{G/P}", "m:{2/W}{G/P}"],
  ["value: m:{}", "m:{}"],
  ["value: m:{ } in quotes", 'm:"{ }"'],
  ["value: m:{ } splits", "m:{ }"],
  ["value: m:{G}{U unclosed", "m:{G}{U"],
  ["value: devotion:{u/b}", "devotion:{u/b}"],
  ["value: devotion:{u/x}", "devotion:{u/x}"],
  ["value: date:2020", "date:2020"],
  ["value: date:2020-01", "date:2020-01"],
  ["value: date:20200101", "date:20200101"],
  ["value: date:dom", "date:dom"],
  ["value: date:toolong1", "date:toolong1"],
  ["value: date:2020-1-1", "date:2020-1-1"],
  ["value: date:abc", "date:abc"],
  ["value: date:ab", "date:ab"],
  ["value: year:12345", "year:12345"],
  ["value: cn!=12a", "cn!=12a"],
  ["value: pow:*", "pow:*"],
  ["value: pow>toughness", "pow>toughness"],
  ["value: pow>banana", "pow>banana"],
  ["value: o:/", "o:/"],
  ["value: o://", "o://"],
  ["value: quoted regex", 'o:"/^draw/"'],

  // Quotes and apostrophes at every position the lexer distinguishes.
  ["quote: closed, then a letter", '"a"b c'],
  ["quote: mid-word does not open", 'a"b c"'],
  ["quote: mid-word does not open, after a letter", 'x"y" z'],
  ["quote: a double quote always closes", 'o:"a"b"c d"'],
  ["quote: name out, closed then a letter", '-"a"b'],
  ["quote: negated phrase", '-"lightning bolt"'],
  ["quote: exact phrase", '!"sift through sands"'],
  ["quote: unterminated value", 'o:"draw a card'],
  ["quote: single-quoted value", "o:'can't block'"],
  ["quote: unterminated single-quoted value", "o:'can't block"],
  ["quote: possessive then a negated term", "sensei's -t:artifact c:u"],
  ["quote: single-quoted word", "'quoted'"],
  ["quote: two single quotes", "''"],
  ["quote: two double quotes", '""'],
  ["quote: lone double quote", '"'],
  ["quote: lone single quote", "'"],
  ["quote: dash and single quote", "-'"],
  ["quote: parens inside", 'o:"(this ability)"'],
  ["quote: or inside a value", 'o:"a or b"'],
  ["quote: unknown keyword keeps its quotes together", 'itag:"spot removal"'],
  ["quote: newline inside", 'o:"draw\na card"'],
  ["quote: close after a single quote then a letter", "(o:'a')b"],
  ["quote: close after a single quote at top level", "o:'a')"],
  ["quote: a ) inside closed quotes does not close", '(t:goblin o:"a)"'],

  // Groups and connectives.
  ["group: open alone", "("],
  ["group: close alone", ")"],
  ["group: two opens and two closes", "(())"],
  ["group: two opens, one close", "(()"],
  ["group: close then open", ")("],
  ["group: dash-open inside a word", "a-(b"],
  ["group: two parens", "((t:goblin))"],
  ["group: unclosed term", "(t:goblin"],
  ["group: stray close after a term", "t:goblin)"],
  ["group: one word, one close too many", "(a))"],
  ["group: negated conjunction of two", "-(t:goblin t:creature)"],
  ["group: dangling or, closed", "(t:goblin or )"],
  ["or: or or", "or or"],
  ["and: alone", "and"],
  ["and: dangling", "t:goblin and"],
  ["and and or: mixed", "t:goblin and t:elf or t:human c:r"],
  ["or: dangling at the end of a top-level or", "t:goblin or t:elf or"],
  ["or: dangling inside an unclosed group", "(t:goblin or t:elf or"],
  ["group: tags and words in an or of groups", "(otag:ramp bolt) or (atag:dragon -shock)"],
  ["group: nested tags and a quoted word", '((otag:ramp or bolt) -(atag:dragon "fire ball"))'],
  ["group: dash-open alone", "-("],
  ["group: two dashes then an open", "--("],
  ["group: open, dash-open", "(-("],
  ["group: two dashes before a term", "--t:goblin"],
  ["group: double negation of a word is a name", "-(-bolt)"],
  ["group: negated quoted phrase in parens", '-("lightning bolt")'],
  ["group: punctuation word beside a term", "-(+++ t:goblin)"],
  ["group: one term survives a negated group", "-(-(+++) t:goblin)"],
  ["group: or whose other branch reads as nothing", "(t:goblin or -(+++))"],
  ["exact: bang-equals is a name", "!=3"],
  ["exact: a term after a bang is a name", "!t:goblin"],
  ["display: negated display keyword is dropped", "-unique:prints"],
  ["display: negated include: another value", "-include:foils"],
  ["display: negated include:extras is dropped", "-include:extras"],
  ["display: quoted extras", 'include:"extras"'],
  ["display: include: with no value", "include:"],
  ["display: unique> is not a display keyword", "unique>prints"],
  ["keyword: trailing dash is dropped", "t-:goblin"],
  ["keyword: dashed letters", "T-Y-P-E:goblin"],
  ["keyword: unknown with separators", "foo-bar_baz:x"],
];

/** The generator's seed. Change it only to regrow the random set on purpose. */
const SEED = 20261125;

/** mulberry32: a 32-bit state and four lines, so the set can be regrown anywhere from the seed. */
function mulberry32(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A keyword and its operator. After one, the generator usually writes a value with no space. */
const HEADS = [
  "t:",
  "o:",
  "c>=",
  "c:",
  "id<=",
  "id:",
  "cmc>",
  "cmc=",
  "cmc<=",
  "pow>=",
  "tou<",
  "r:",
  "r>=",
  "s:",
  "f:",
  "is:",
  "not:",
  "-not:",
  "has:",
  "otag:",
  "atag:",
  "art:",
  "kw:",
  "m:",
  "devotion:",
  "produces:",
  "lang:",
  "year<",
  "date>=",
  "usd<",
  "cn:",
  "frame:",
  "border:",
  "game:",
  "name:",
  "include:",
  "unique:",
  "order:",
  "cube:",
  "foo-bar_baz:",
  "t!=",
  "is=",
];

/** Values, valid for some keyword and not for most. */
const VALUES = [
  "goblin",
  "rg",
  "wubrg",
  "3",
  "3.5",
  "-1",
  "*",
  "tou",
  "banana",
  "rare",
  "special",
  "neo",
  "modern",
  "fetchland",
  "reprint",
  "watermark",
  "ramp",
  '"spot removal"',
  "'can't block'",
  "{G}{U}",
  "2uu",
  "{U/B}",
  "ja",
  "japanese",
  "1994",
  "2020-01-01",
  "dom",
  "0.5",
  ".5",
  "12a",
  "1997",
  "white",
  "esper",
  "/^draw/",
  "extras",
  "prints",
];

/** Grouping, connectives, the punctuation the lexer reads, and words it must leave alone. */
const STRUCTURE = [
  "(",
  "-(",
  ")",
  "or",
  "and",
  "OR",
  "-",
  "!",
  '"',
  "'",
  "Urza's",
  "bolt",
  "Æther",
  "Lim-Dûl",
  "😀",
  "Ⓐ",
];

/** Whitespace to JavaScript and not to Rust (U+FEFF), the reverse (U+0085), and the plain kinds. */
const SEPARATORS = [" ", "  ", "\t", "\u00a0", "\u3000", "\ufeff", "\u0085", "\n"];

const FRAGMENTS = [...HEADS, ...VALUES, ...STRUCTURE];

/**
 * `count` distinct queries from `seed`: each 1–12 steps of one fragment, a value straight after a
 * keyword head four times in five, and a separator after a step about two times in three — so
 * values glue to their keywords and fragments to each other often enough to make terms, quotes
 * and groups that open in one fragment and close in another.
 */
function randomQueries(seed: number, count: number): string[] {
  const next = mulberry32(seed);
  const pick = (list: readonly string[]): string => list[Math.floor(next() * list.length)];
  const seen = new Set<string>();
  while (seen.size < count) {
    const steps = 1 + Math.floor(next() * 12);
    let query = "";
    for (let step = 0; step < steps; step += 1) {
      const fragment = pick(FRAGMENTS);
      query += fragment;
      if (HEADS.includes(fragment) && next() < 0.8) query += pick(VALUES);
      if (next() < 0.65) query += pick(SEPARATORS);
    }
    if (query !== "") seen.add(query);
  }
  return [...seen];
}

const HAND_PICKED = CASES.map(([name, query]) => ({ name, query, parsed: parseQuery(query) }));
const RANDOM = randomQueries(SEED, 500).map((query) => ({ query, parsed: parseQuery(query) }));

/** The file, laid out by hand: one case per line, in the shape the module doc describes. */
function golden(): string {
  const rows = (list: readonly object[], indent: string): string =>
    list.map((row) => `${indent}${asciiJson(row)}`).join(",\n");
  return [
    "{",
    `  "tables": ${asciiJson(tables(), 2).replace(/\n/g, "\n  ")},`,
    '  "cases": [',
    rows(HAND_PICKED, "    "),
    "  ],",
    '  "random": {',
    `    "seed": ${SEED},`,
    '    "cases": [',
    rows(RANDOM, "      "),
    "    ]",
    "  }",
    "}",
    "",
  ].join("\n");
}

describe("the query-language golden", () => {
  it("names every hand-picked case once and asks each query once", () => {
    // A twin name makes a Rust failure ambiguous; a twin query is a case that pins nothing new.
    const twins = (list: readonly string[]) => list.filter((x, i) => list.indexOf(x) !== i);
    expect(twins(CASES.map(([name]) => name))).toEqual([]);
    expect(twins(CASES.map(([, query]) => query))).toEqual([]);
  });

  it("draws 500 distinct random queries", () => {
    expect(new Set(RANDOM.map((c) => c.query)).size).toBe(500);
  });

  it("is JSON that reads back as what it was built from", () => {
    // The layout is hand-made and the escape runs over the whole text, so check both kept it JSON
    // and kept every string what it was.
    expect(JSON.parse(golden())).toEqual({
      tables: tables(),
      cases: HAND_PICKED,
      random: { seed: SEED, cases: RANDOM },
    });
    expect(golden()).toMatch(/^[\x20-\x7e\n]*$/);
  });

  it("matches the committed golden", async () => {
    await expect(golden()).toMatchFileSnapshot("./__golden__/query-language.json");
  });
});
