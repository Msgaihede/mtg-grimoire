import { describe, expect, it } from "vitest";
import {
  IS_VALUES,
  parseQuery,
  predicateKey,
  predicateLabel,
  QUERY_KEYWORDS,
  QUERY_SECTIONS,
  removeToken,
  setTokenNegated,
  tokenKey,
  wirePredicate,
  type PredicateToken,
  type QueryPredicate,
  type TagToken,
} from "./queryLanguage";

/** `namespace:value`, negation marked with a leading `-`, so a whole parse reads on one line. */
const terms = (input: string): string[] =>
  parseQuery(input).tags.map((t) => `${t.negated ? "-" : ""}${t.namespace}:${t.value}`);

describe("parseQuery — tags", () => {
  it("reads every alias Scryfall documents", () => {
    // Measured live 2026-08-20 (see the art-tags research): all four art spellings answer 1,145
    // for `dragon` and all five oracle ones answer 6,428 for `removal`. `a:` and `o:` were on
    // these two lists from 2026-08-22 to 2026-09-22 and are Scryfall's artist and oracle text
    // again — see the `a:`/`o:` reassignment below.
    expect(terms("art:dragon atag:dragon arttag:dragon art_tag:dragon")).toEqual(
      Array(4).fill("art:dragon"),
    );
    expect(terms("otag:removal oracletag:removal function:removal oracle_tag:removal")).toEqual(
      Array(4).fill("oracle:removal"),
    );
    // `oracle-tag:` too — separators are normalised out of the keyword, not just the value.
    expect(terms("oracle-tag:removal")).toEqual(["oracle:removal"]);
  });

  it("takes a keyword however it is capitalised", () => {
    expect(terms("OTAG:removal Art:dragon ArtTag:dragon")).toEqual([
      "oracle:removal",
      "art:dragon",
      "art:dragon",
    ]);
  });

  it("leaves a keyword it does not know as free text", () => {
    // `itag:`, `ftag:` and `otags:` are HTTP 400 on Scryfall; here they are words to search for.
    const parsed = parseQuery("itag:dragon ftag:removal otags:removal bolt");
    expect(parsed.tags).toEqual([]);
    expect(parsed.text).toBe("itag:dragon ftag:removal otags:removal bolt");
  });

  it("keeps a quoted value whole and hands the rest to FTS", () => {
    const parsed = parseQuery('bolt otag:"spot removal" dragon');
    expect(terms('bolt otag:"spot removal" dragon')).toEqual(["oracle:spot removal"]);
    // The decisive half: `spot` must not fall out of the quotes into the text.
    expect(parsed.text).toBe("bolt dragon");
  });

  it("takes single quotes too, and an opening quote the reader has not closed yet", () => {
    expect(terms("otag:'spot removal'")).toEqual(["oracle:spot removal"]);
    // What the box holds through the whole phrase. Without this the chip would read `"spot`.
    expect(terms('otag:"spot removal')).toEqual(["oracle:spot removal"]);
  });

  it("reads a leading dash as an exclude", () => {
    expect(terms("-atag:dragon otag:ramp -otag:removal")).toEqual([
      "-art:dragon",
      "oracle:ramp",
      "-oracle:removal",
    ]);
  });

  it("drops a keyword with nothing after it rather than filtering or searching by it", () => {
    // Every keystroke on the way to a tag passes through this state. A token would sit there
    // reporting `""` as an unknown tag; free text would search the corpus for `otag`.
    const parsed = parseQuery("otag: -atag: bolt");
    expect(parsed.tags).toEqual([]);
    expect(parsed.text).toBe("bolt");
  });

  it("keeps two terms naming the same tag rather than silently folding them", () => {
    expect(terms("atag:dog atag:dog")).toEqual(["art:dog", "art:dog"]);
  });

  it("answers an empty query with no tags, no predicates and no text", () => {
    expect(parseQuery("")).toEqual({ text: "", tags: [], predicates: [] });
    expect(parseQuery("   ")).toEqual({ text: "", tags: [], predicates: [] });
  });

  it("spans the whole term, dash and quotes included", () => {
    const input = 'bolt -otag:"spot removal" x';
    const [token] = parseQuery(input).tags;
    expect(input.slice(token.start, token.end)).toBe('-otag:"spot removal"');
  });

  it("names both taxonomies in one query", () => {
    expect(terms("atag:dog otag:ramp")).toEqual(["art:dog", "oracle:ramp"]);
  });
});

describe("removeToken", () => {
  const only = (input: string): TagToken => parseQuery(input).tags[0];

  it("takes the term out and leaves one space between what is left", () => {
    const input = "bolt atag:dragon lightning";
    expect(removeToken(input, only(input))).toBe("bolt lightning");
  });

  it("leaves nothing behind when the term was the whole query", () => {
    const input = "atag:dragon";
    expect(removeToken(input, only(input))).toBe("");
  });

  it("takes a quoted term out whole", () => {
    const input = 'bolt -otag:"spot removal"';
    expect(removeToken(input, only(input))).toBe("bolt");
  });

  it("removes the term it was given rather than the first one that looks like it", () => {
    const input = "atag:dog otag:ramp atag:dog";
    const second = parseQuery(input).tags[2];
    expect(removeToken(input, second)).toBe("atag:dog otag:ramp");
  });
});

describe("setTokenNegated", () => {
  const only = (input: string): TagToken => parseQuery(input).tags[0];

  it("adds and removes the dash in place", () => {
    expect(setTokenNegated("bolt atag:dragon x", only("bolt atag:dragon x"), true)).toBe(
      "bolt -atag:dragon x",
    );
    expect(setTokenNegated("bolt -atag:dragon x", only("bolt -atag:dragon x"), false)).toBe(
      "bolt atag:dragon x",
    );
  });

  it("does not move the term to the end of the query", () => {
    // `toggleChipMode`'s rule: a chip that jumped when it was flipped would make the row
    // unreadable exactly while the reader is editing it — and here it reorders their sentence.
    const input = "atag:dog otag:ramp";
    const first = parseQuery(input).tags[0];
    expect(setTokenNegated(input, first, true)).toBe("-atag:dog otag:ramp");
  });

  it("leaves a quoted value quoted", () => {
    const input = 'otag:"spot removal"';
    expect(setTokenNegated(input, only(input), true)).toBe('-otag:"spot removal"');
  });

  it("is a no-op when the term is already the way it was asked for", () => {
    const input = "-atag:dog";
    expect(setTokenNegated(input, only(input), true)).toBe("-atag:dog");
  });
});

describe("tokenKey", () => {
  it("is the namespace and the value, because both taxonomies hold `dog`", () => {
    expect(tokenKey({ namespace: "art", value: "dog" })).not.toBe(
      tokenKey({ namespace: "oracle", value: "dog" }),
    );
  });

  it("folds case, so one round trip answers `A:Dog` and `a:dog`", () => {
    expect(tokenKey({ namespace: "art", value: "Dog" })).toBe(
      tokenKey({ namespace: "art", value: "dog" }),
    );
  });
});

describe("QUERY_KEYWORDS", () => {
  it("lists only keywords the parser actually reads", () => {
    for (const spec of QUERY_KEYWORDS) {
      for (const keyword of spec.keywords) {
        const parsed = parseQuery(
          `${keyword}${spec.example.slice(spec.example.search(/[:=<>!]/))}`,
        );
        expect(parsed.text, `${keyword} leaked free text`).toBe("");
        expect(parsed.predicates.length + parsed.tags.length).toBe(1);
      }
    }
  });

  it("gives every keyword to exactly one row", () => {
    // The lookup is a Map, so a second row claiming `set` would silently win and the first
    // row's field would stop being reachable — no error, no red, just a keyword that means
    // something else.
    const seen = new Set<string>();
    for (const spec of QUERY_KEYWORDS) {
      for (const keyword of spec.keywords) {
        const key = keyword.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
        expect(seen.has(key), `${keyword} is claimed twice`).toBe(false);
        seen.add(key);
      }
    }
  });
});

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
      field: "oracleText",
      value: "draw a card",
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
  it("answers partial once an operator is typed, since that is what says a term was meant", () => {
    for (const s of ["cmc>", "cmc>=", "otag:"]) {
      const p = parseQuery(s);
      expect(p.predicates).toEqual([]);
      expect(p.tags).toEqual([]);
      expect(p.text).toBe(""); // not free text either — neither a term nor a word
    }
  });

  it("leaves a keyword with no operator as free text, wherever it sits", () => {
    // A bare keyword swallowed from the query leaves an EMPTY query, which draws the
    // unfiltered wall rather than no results — and `power`, `art`, `set`, `type`, `legal`
    // and `oracle` are all keywords. A reader typing `power` wants Power Conduit.
    for (const word of ["power", "art", "set", "type", "legal", "oracle", "t", "o"]) {
      expect(parseQuery(word).text, `${word} was swallowed`).toBe(word);
      expect(parseQuery(word).predicates).toEqual([]);
      expect(parseQuery(word).tags).toEqual([]);
    }
    expect(parseQuery("power sink").text).toBe("power sink");
    expect(parseQuery("bolt t:goblin").text).toBe("bolt");
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

describe("parseQuery — a negated name (issue #571)", () => {
  // Until 2026-09-27 these fell through to free text and the `-` was tokenised away, so `-bolt`
  // searched FOR bolt. Scryfall's `-bolt` is `-name:bolt`: measured live 2026-09-27, both answer
  // 3,891 of `t:instant`'s 3,909.
  it("reads a dash on a bare word as a name to exclude", () => {
    expect(parseQuery("-bolt")).toEqual({
      text: "",
      tags: [],
      predicates: [{ field: "name", op: "colon", value: "bolt", negated: true, start: 0, end: 5 }],
    });
  });

  it("takes a quoted phrase whole, dash and quotes inside the span", () => {
    const input = 'bolt -"lightning bolt" x';
    const { text, predicates } = parseQuery(input);
    expect(text).toBe("bolt x");
    expect(predicates).toHaveLength(1);
    expect(predicates[0]).toMatchObject({ field: "name", value: "lightning bolt", negated: true });
    expect(input.slice(predicates[0].start, predicates[0].end)).toBe('-"lightning bolt"');
    expect(parseQuery("-'lightning bolt'").predicates[0]).toMatchObject({
      value: "lightning bolt",
    });
  });

  it("holds the phrase through the keystrokes before its closing quote", () => {
    expect(parseQuery('-"lightning bol').predicates[0]).toMatchObject({ value: "lightning bol" });
  });

  it("leaves a positive bare word, quoted or not, as the free text it has always been", () => {
    for (const input of ["bolt", '"lightning bolt"', "god-pharaoh"]) {
      const parsed = parseQuery(input);
      expect(parsed.text, input).toBe(input);
      expect(parsed.predicates, input).toEqual([]);
    }
  });

  it("sits beside free text and keyword terms, each keeping its own meaning", () => {
    const { text, predicates } = parseQuery("lightning -bolt -t:creature");
    expect(text).toBe("lightning");
    expect(predicates.map((p) => [p.field, p.value, p.negated])).toEqual([
      ["name", "bolt", true],
      ["typeLine", "creature", true],
    ]);
  });

  it("negates whatever would have been free text, an unparseable term included", () => {
    // `cmc>=banana` and `itag:dragon` are words to FTS; negated, they are names that cannot
    // contain them — Scryfall's reading of both.
    expect(parseQuery("-cmc>=banana").predicates[0]).toMatchObject({
      field: "name",
      value: "cmc>=banana",
    });
    expect(parseQuery("-itag:dragon").predicates[0]).toMatchObject({
      field: "name",
      value: "itag:dragon",
    });
  });

  it("is neither a term nor free text until there is a word to exclude", () => {
    // Every keystroke on the way to `-bolt` or `-"lightning bolt"` passes through one of the
    // first two, and a chip reading `not -` would narrow nothing — the FTS builder drops a value
    // with no word in it.
    for (const input of ["-", '-"', "--", "-!!!", "bolt -"]) {
      const parsed = parseQuery(input);
      expect(parsed.predicates, input).toEqual([]);
      expect(parsed.text, input).toBe(input === "bolt -" ? "bolt" : "");
    }
  });

  it("reads a word in any script", () => {
    expect(parseQuery("-Молния").predicates[0]).toMatchObject({ field: "name", value: "Молния" });
  });

  it("becomes free text again when its chip is flipped to include", () => {
    // There is no positive name to flip to: `bolt` is the ordinary free text, which draws no chip.
    const input = "t:instant -bolt";
    const [, name] = parseQuery(input).predicates;
    const flipped = setTokenNegated(input, name, false);
    expect(flipped).toBe("t:instant bolt");
    expect(parseQuery(flipped).predicates.map((p) => p.field)).toEqual(["typeLine"]);
    expect(parseQuery(flipped).text).toBe("bolt");
    expect(removeToken(input, name)).toBe("t:instant");
  });
});

describe("parseQuery — an apostrophe inside a word (issue #552)", () => {
  // Until 2026-09-27 any `'` opened a quote that ran to the end of the box, so an apostrophe in a
  // card name swallowed every term after it.
  it("keeps a possessive name as one word and the terms after it as terms", () => {
    const { text, predicates } = parseQuery("sensei's -t:artifact");
    expect(text).toBe("sensei's");
    expect(predicates.map((p) => [p.field, p.value, p.negated])).toEqual([
      ["typeLine", "artifact", true],
    ]);
  });

  it("reads Urza's and Ajani's beside other words", () => {
    for (const input of ["urza's saga", "ajani's pridemate c:w"]) {
      const parsed = parseQuery(input);
      expect(parsed.text, input).toBe(input.replace(" c:w", ""));
    }
    expect(parseQuery("ajani's pridemate c:w").predicates).toHaveLength(1);
  });

  it("keeps an apostrophe in a value inside that value and the next term out of it", () => {
    const { text, predicates } = parseQuery("o:can't t:creature");
    expect(text).toBe("");
    expect(predicates.map((p) => [p.field, p.value])).toEqual([
      ["oracleText", "can't"],
      ["typeLine", "creature"],
    ]);
  });

  it("excludes a possessive name, with or without quotes around it", () => {
    expect(parseQuery("-urza's t:land").predicates.map((p) => [p.field, p.value])).toEqual([
      ["name", "urza's"],
      ["typeLine", "land"],
    ]);
    expect(parseQuery('-"urza\'s saga" t:land').predicates[0]).toMatchObject({
      field: "name",
      value: "urza's saga",
    });
  });

  it("does not close a single quote on an apostrophe mid-word", () => {
    expect(parseQuery("o:'can't block' t:creature").predicates.map((p) => p.value)).toEqual([
      "can't block",
      "creature",
    ]);
    // Nor does a double-quoted value care about the apostrophe inside it.
    expect(parseQuery('o:"can\'t block"').predicates[0]).toMatchObject({ value: "can't block" });
  });

  it("still opens a quote at the start of a chunk or a value", () => {
    expect(parseQuery("'lightning bolt' t:instant").text).toBe("'lightning bolt'");
    expect(terms("otag:'spot removal' bolt")).toEqual(["oracle:spot removal"]);
  });
});

/** A predicate as one line — `-field:op:value`, a group as `anyOf(…)` — so a whole tree reads
 *  in one `toEqual`. */
const show = (p: QueryPredicate): string =>
  `${p.negated ? "-" : ""}${
    p.terms ? `${p.field}(${p.terms.map(show).join(", ")})` : `${p.field}:${p.op}:${p.value}`
  }`;
const tree = (input: string): string[] => parseQuery(input).predicates.map(show);

describe("parseQuery — or and parentheses (issue #909)", () => {
  it("reads or between two terms as one group", () => {
    expect(tree("t:goblin or t:elf")).toEqual(["anyOf(typeLine:colon:goblin, typeLine:colon:elf)"]);
    // In any case, as on Scryfall.
    expect(tree("t:goblin OR t:elf")).toEqual(tree("t:goblin or t:elf"));
    expect(tree("t:goblin Or t:elf")).toEqual(tree("t:goblin or t:elf"));
  });

  it("binds AND tighter than OR", () => {
    // A goblin, or a red elf — never "a goblin or an elf, and red".
    expect(tree("t:goblin or t:elf c:r")).toEqual([
      "anyOf(typeLine:colon:goblin, allOf(typeLine:colon:elf, colors:gte:r))",
    ]);
    expect(tree("c:r t:goblin or t:elf")).toEqual([
      "anyOf(allOf(colors:gte:r, typeLine:colon:goblin), typeLine:colon:elf)",
    ]);
  });

  it("lets parentheses override the precedence, and ANDs the group with what is beside it", () => {
    expect(tree("(t:goblin or t:elf) c:r")).toEqual([
      "anyOf(typeLine:colon:goblin, typeLine:colon:elf)",
      "colors:gte:r",
    ]);
  });

  it("drops and, which juxtaposition already says", () => {
    expect(tree("t:goblin and c:r")).toEqual(["typeLine:colon:goblin", "colors:gte:r"]);
    expect(tree("t:goblin AND c:r")).toEqual(tree("t:goblin c:r"));
    expect(parseQuery("fire and ice").text).toBe("fire ice");
  });

  it("drops a dangling or — at the start, at the end and doubled — as the keystroke it is", () => {
    // Every `t:goblin or t:elf` passes through the first one. Read as "a goblin, or anything",
    // it would flash the whole collection between two words.
    expect(tree("t:goblin or")).toEqual(["typeLine:colon:goblin"]);
    expect(tree("or t:goblin")).toEqual(["typeLine:colon:goblin"]);
    expect(tree("t:goblin or or t:elf")).toEqual(tree("t:goblin or t:elf"));
    expect(parseQuery("or")).toEqual({ text: "", tags: [], predicates: [] });
    expect(parseQuery("(t:goblin or)").predicates).toEqual([
      { field: "typeLine", op: "colon", value: "goblin", negated: false, start: 0, end: 13 },
    ]);
  });

  it("flattens a plain parenthesised conjunction into the top level", () => {
    // Two chips rather than one: the parentheses changed nothing about what is asked.
    const parsed = parseQuery("(t:goblin c:r) bolt");
    expect(parsed.predicates.map(show)).toEqual(["typeLine:colon:goblin", "colors:gte:r"]);
    expect(parsed.text).toBe("bolt");
    expect(parsed.predicates[0]).toMatchObject({ start: 1, end: 9 });
  });

  it("keeps a negated group whole, as one allOf", () => {
    expect(tree("-(t:goblin c:r)")).toEqual(["-allOf(typeLine:colon:goblin, colors:gte:r)"]);
    expect(tree("-(t:goblin or t:elf)")).toEqual([
      "-anyOf(typeLine:colon:goblin, typeLine:colon:elf)",
    ]);
  });

  it("nests, and folds a group into a parent with the same connective", () => {
    expect(tree("((t:goblin or t:elf) or t:dwarf)")).toEqual([
      "anyOf(typeLine:colon:goblin, typeLine:colon:elf, typeLine:colon:dwarf)",
    ]);
    expect(tree("t:goblin or (c:r (t:elf or t:dwarf))")).toEqual([
      "anyOf(typeLine:colon:goblin, allOf(colors:gte:r, anyOf(typeLine:colon:elf, typeLine:colon:dwarf)))",
    ]);
    expect(tree("-(t:goblin (c:r c:g))")).toEqual([
      "-allOf(typeLine:colon:goblin, colors:gte:r, colors:gte:g)",
    ]);
  });

  it("unwraps a group of one, carrying its negation onto the term", () => {
    expect(tree("(t:goblin)")).toEqual(["typeLine:colon:goblin"]);
    expect(tree("-(t:goblin)")).toEqual(["-typeLine:colon:goblin"]);
    expect(tree("(-t:goblin)")).toEqual(["-typeLine:colon:goblin"]);
    expect(tree("-(-t:goblin)")).toEqual(["typeLine:colon:goblin"]);
    expect(tree("-((t:goblin or t:elf))")).toEqual([
      "-anyOf(typeLine:colon:goblin, typeLine:colon:elf)",
    ]);
    // A lone word in parentheses is the free text it would have been, and a negated one the name
    // exclusion `-bolt` is.
    expect(parseQuery("(bolt)")).toMatchObject({ text: "bolt", predicates: [] });
    expect(tree("-(bolt)")).toEqual(["-name:colon:bolt"]);
    // A lone tag is the top-level token it would have been, not a group term.
    expect(terms("-(otag:removal)")).toEqual(["-oracle:removal"]);
  });

  it("gives a lone term of a parenthesised group the group's span, so its ✕ takes the parens", () => {
    const input = "bolt -(t:goblin) x";
    const [token] = parseQuery(input).predicates;
    expect(input.slice(token.start, token.end)).toBe("-(t:goblin)");
    expect(removeToken(input, token)).toBe("bolt x");
  });

  it("drops a group that empties out", () => {
    for (const input of ["()", "-()", "(otag:)", "(or)", "( )"]) {
      expect(parseQuery(input), input).toEqual({ text: "", tags: [], predicates: [] });
    }
  });

  it("runs an unclosed group to the end of the box", () => {
    const input = "c:r (t:goblin or t:elf";
    const { predicates } = parseQuery(input);
    expect(predicates.map(show)).toEqual([
      "colors:gte:r",
      "anyOf(typeLine:colon:goblin, typeLine:colon:elf)",
    ]);
    expect(input.slice(predicates[1].start, predicates[1].end)).toBe("(t:goblin or t:elf");
    // And a lone `(` on the way to typing one is nothing at all.
    expect(parseQuery("c:r (").predicates.map(show)).toEqual(["colors:gte:r"]);
  });

  it("keeps a stray ) as a character of its word", () => {
    expect(parseQuery("bolt)")).toEqual({ text: "bolt)", tags: [], predicates: [] });
    // One `)` closes the one open group; the other is the word's.
    expect(parseQuery("(bolt))").text).toBe("bolt)");
  });

  it("reads parentheses only at a chunk's ends, so a word with one inside is a word", () => {
    expect(parseQuery("foo(bar").text).toBe("foo(bar");
    expect(parseQuery("x)y").text).toBe("x)y");
  });

  it("lets quotes swallow parentheses and connectives", () => {
    expect(tree('o:"(this or that)"')).toEqual(["oracleText:colon:(this or that)"]);
    expect(parseQuery('"fight or flight"').text).toBe('"fight or flight"');
    // A closing paren after the quote still closes the group the quote sits in.
    expect(tree('(o:"draw a card" or t:goblin)')).toEqual([
      "anyOf(oracleText:colon:draw a card, typeLine:colon:goblin)",
    ]);
    // Single quotes too — the `)` after a closing `'` does not keep the quote open.
    expect(tree("(o:'can't block' or t:wall)")).toEqual([
      "anyOf(oracleText:colon:can't block, typeLine:colon:wall)",
    ]);
    // An unterminated quote holds the paren inside it, so the group stays open.
    expect(tree('(o:"draw)')).toEqual(["oracleText:colon:draw)"]);
  });

  it("makes a bare word inside a group a text term", () => {
    expect(tree("bolt or shock")).toEqual(["anyOf(text:colon:bolt, text:colon:shock)"]);
    expect(parseQuery("bolt or shock").text).toBe("");
    // A dashed word inside a group is the name exclusion it is everywhere else.
    expect(tree("(t:goblin or -bolt)")).toEqual(["anyOf(typeLine:colon:goblin, -name:colon:bolt)"]);
  });

  it("makes a tag inside a group an oracleTag or artTag term, not a token to resolve", () => {
    const parsed = parseQuery("(otag:removal or -atag:dragon)");
    expect(parsed.tags).toEqual([]);
    expect(parsed.predicates.map(show)).toEqual([
      "anyOf(oracleTag:colon:removal, -artTag:colon:dragon)",
    ]);
    // A tag beside the group is still a token.
    expect(terms("otag:ramp (t:elf or t:druid)")).toEqual(["oracle:ramp"]);
  });

  it("spans the whole group, dash and parentheses included", () => {
    const input = 'bolt -(t:goblin or o:"draw a card") x';
    const { text, predicates } = parseQuery(input);
    expect(text).toBe("bolt x");
    expect(input.slice(predicates[0].start, predicates[0].end)).toBe(
      '-(t:goblin or o:"draw a card")',
    );
    expect(removeToken(input, predicates[0])).toBe("bolt x");
  });

  it("spans a top-level or with no parentheses from its first term to its last", () => {
    const input = "t:goblin or t:elf";
    expect(parseQuery(input).predicates[0]).toMatchObject({ start: 0, end: input.length });
  });
});

describe("parseQuery — exact names and not:", () => {
  it("reads ! as an exact name", () => {
    expect(parseQuery("!fire").predicates).toEqual([
      { field: "name", op: "eq", value: "fire", negated: false, start: 0, end: 5 },
    ]);
    expect(tree('!"lightning bolt"')).toEqual(["name:eq:lightning bolt"]);
    expect(tree("!'lightning bolt'")).toEqual(["name:eq:lightning bolt"]);
    expect(tree('-!"lightning bolt" t:instant')).toEqual([
      "-name:eq:lightning bolt",
      "typeLine:colon:instant",
    ]);
  });

  it("holds an exact name through the keystrokes before it has a word", () => {
    for (const input of ["!", '!"', "-!", "!!!"]) {
      expect(parseQuery(input), input).toEqual({ text: "", tags: [], predicates: [] });
    }
    expect(tree('!"lightning bol')).toEqual(["name:eq:lightning bol"]);
  });

  it("reads name: as the name, contains", () => {
    expect(tree("name:goblin")).toEqual(["name:colon:goblin"]);
    expect(tree("name=fire")).toEqual(["name:eq:fire"]);
  });

  it("reads not: as a negated is:, and a dash on it as a positive one", () => {
    expect(tree("not:reprint")).toEqual(["-is:colon:reprint"]);
    expect(tree("-not:reprint")).toEqual(["is:colon:reprint"]);
    expect(tree("NOT:Reprint")).toEqual(["-is:colon:reprint"]);
  });

  it("leaves an is: value it does not know as free text", () => {
    expect(parseQuery("is:fetchlnad")).toMatchObject({ text: "is:fetchlnad", predicates: [] });
    expect(parseQuery("not:banana").text).toBe("not:banana");
  });

  it("knows every value of the is: vocabulary", () => {
    for (const value of IS_VALUES) {
      expect(tree(`is:${value}`), value).toEqual([`is:colon:${value}`]);
    }
  });
});

describe("parseQuery — display keywords and refusals", () => {
  it("ignores the display keywords — neither a term nor free text", () => {
    for (const input of [
      "unique:prints",
      "unique:art",
      "order:cmc",
      "direction:desc",
      "prefer:newest",
      "display:grid",
      "include:extras",
      "Unique=prints",
    ]) {
      expect(parseQuery(input), input).toEqual({ text: "", tags: [], predicates: [] });
    }
    expect(parseQuery("t:elf unique:prints bolt")).toMatchObject({
      text: "bolt",
      predicates: [{ field: "typeLine", value: "elf" }],
    });
  });

  it("leaves include: with any other value, and a bare display word, as free text", () => {
    expect(parseQuery("include:foils").text).toBe("include:foils");
    expect(parseQuery("order").text).toBe("order");
  });

  it("leaves a regular expression as free text rather than sending its words to a column", () => {
    expect(parseQuery("o:/^draw/")).toMatchObject({ text: "o:/^draw/", predicates: [] });
    expect(parseQuery("name:/bolt/").text).toBe("name:/bolt/");
  });

  it("leaves Scryfall's unsupported keywords as free text", () => {
    for (const input of ["cube:vintage", "cheapest:usd", "artists>1", "illustrations>1"]) {
      expect(parseQuery(input).text, input).toBe(input);
    }
  });
});

describe("parseQuery — the long tail of keywords (issue #909)", () => {
  it("parses every row's example to exactly one term with that row's field", () => {
    for (const spec of QUERY_KEYWORDS) {
      const parsed = parseQuery(spec.example);
      expect(parsed.text, spec.example).toBe("");
      if (typeof spec.target === "string") {
        expect(parsed.predicates, spec.example).toHaveLength(1);
        expect(parsed.predicates[0].field, spec.example).toBe(spec.target);
      } else {
        expect(parsed.tags, spec.example).toHaveLength(1);
      }
    }
  });

  it("gives each new field its default operator", () => {
    const op = (input: string) => parseQuery(input).predicates[0]?.op;
    // Sets of symbols ask "at least these".
    expect(op("m:{G}{U}")).toBe("gte");
    expect(op("devotion:uuu")).toBe("gte");
    expect(op("produces:g")).toBe("gte");
    // Text-ish fields contain.
    expect(op("ft:mishra")).toBe("colon");
    expect(op("wm:orzhov")).toBe("colon");
    expect(op("is:dual")).toBe("colon");
    // Numbers and closed vocabularies are equality.
    for (const input of [
      "loy:3",
      "pt:10",
      "cn:1",
      "year:1994",
      "usd:1",
      "prints:1",
      "game:arena",
    ]) {
      expect(op(input), input).toBe("eq");
    }
  });

  it("reads a colour name, m, or a colour count for c: and id:", () => {
    for (const value of [
      "esper",
      "Azorius",
      "silverquill",
      "glint-eye",
      "m",
      "multicolor",
      "wubrg",
    ]) {
      expect(tree(`id:${value}`), value).toHaveLength(1);
    }
    expect(tree("c=2")).toEqual(["colors:eq:2"]);
    expect(tree("id>=3")).toEqual(["colorIdentity:gte:3"]);
    expect(parseQuery("c:green").text).toBe("c:green");
  });

  it("compares a number with another column as @field", () => {
    expect(tree("pow>tou")).toEqual(["power:gt:@toughness"]);
    expect(tree("tou>power")).toEqual(["toughness:gt:@power"]);
    expect(tree("cmc<loy")).toEqual(["cmc:lt:@loyalty"]);
    expect(tree("loy=mv")).toEqual(["loyalty:eq:@cmc"]);
    expect(tree("pt>=manavalue")).toEqual(["powTou:gte:@cmc"]);
    // Only the numeric fields read one — `t:pow` is a type line.
    expect(tree("t:pow")).toEqual(["typeLine:colon:pow"]);
  });

  it("takes even and odd for mana value, by equality only", () => {
    expect(tree("cmc:even")).toEqual(["cmc:eq:even"]);
    expect(tree("mv!=odd")).toEqual(["cmc:ne:odd"]);
    expect(parseQuery("cmc>even").text).toBe("cmc>even");
    expect(parseQuery("pow:even").text).toBe("pow:even");
  });

  it("takes special and bonus rarities by equality only", () => {
    expect(tree("r:special")).toEqual(["rarity:eq:special"]);
    expect(tree("r:b")).toEqual(["rarity:eq:bonus"]);
    expect(parseQuery("r>=special").text).toBe("r>=special");
  });

  it("reads mana costs, devotion and produced mana, and refuses words", () => {
    expect(tree("m:2uu")).toEqual(["manaCost:gte:2uu"]);
    expect(tree("m={2/W}{G/P}")).toEqual(["manaCost:eq:{2/W}{G/P}"]);
    expect(parseQuery("m:green").text).toBe("m:green");
    expect(tree("devotion>={U/B}{U/B}")).toEqual(["devotion:gte:{U/B}{U/B}"]);
    expect(parseQuery("devotion:2").text).toBe("devotion:2");
    expect(tree("produces=c")).toEqual(["produces:eq:c"]);
    expect(parseQuery("produces:x").text).toBe("produces:x");
  });

  it("reads a date at three precisions or as a set code, and a year as four digits", () => {
    for (const value of ["2020", "2020-06", "2020-06-26", "dom", "M21"]) {
      expect(tree(`date>=${value}`), value).toEqual([`date:gte:${value}`]);
    }
    expect(parseQuery("date>=yesterday").text).toBe("date>=yesterday");
    expect(tree("year<=1994")).toEqual(["year:lte:1994"]);
    expect(parseQuery("year:94").text).toBe("year:94");
  });

  it("reads prices and counts as numbers", () => {
    expect(tree("usd<0.5")).toEqual(["usd:lt:0.5"]);
    expect(tree("eur>=.5")).toEqual(["eur:gte:.5"]);
    expect(parseQuery("tix<cheap").text).toBe("tix<cheap");
    expect(parseQuery("usd<-1").text).toBe("usd<-1");
    expect(tree("sets>=20")).toEqual(["sets:gte:20"]);
    expect(parseQuery("paperprints>1.5").text).toBe("paperprints>1.5");
  });

  it("reads a collector number as a string by equality and as a number in a range", () => {
    expect(tree("cn:12a")).toEqual(["collectorNumber:eq:12a"]);
    expect(tree("number>=250")).toEqual(["collectorNumber:gte:250"]);
    expect(parseQuery("cn>12a").text).toBe("cn>12a");
  });

  it("canonicalises the closed vocabularies, and leaves an unknown value as free text", () => {
    expect(tree("game:Arena")).toEqual(["game:eq:arena"]);
    expect(tree("border:Borderless")).toEqual(["border:eq:borderless"]);
    expect(tree("frame:future frame:showcase")).toEqual(["frame:eq:future", "frame:eq:showcase"]);
    expect(tree("stamp:triangle")).toEqual(["stamp:eq:triangle"]);
    expect(tree("has:indicator")).toEqual(["has:colon:indicator"]);
    expect(tree("new:rarity")).toEqual(["newFeature:colon:rarity"]);
    for (const input of [
      "game:xbox",
      "border:blue",
      "frame:2020",
      "stamp:star",
      "has:wings",
      "new:x",
    ]) {
      expect(parseQuery(input).text, input).toBe(input);
    }
  });

  it("sends a language as its code, names included, and any as itself", () => {
    expect(tree("lang:ja")).toEqual(["language:eq:ja"]);
    expect(tree("language:Japanese")).toEqual(["language:eq:ja"]);
    expect(tree("lang:ancient-greek")).toEqual(["language:eq:grc"]);
    expect(tree("lang:any")).toEqual(["language:eq:any"]);
    expect(parseQuery("lang:klingon").text).toBe("lang:klingon");
  });

  it("passes the open vocabularies through as typed", () => {
    expect(tree("in:lea in:arena in:Japanese")).toEqual([
      "inPrinting:eq:lea",
      "inPrinting:eq:arena",
      "inPrinting:eq:Japanese",
    ]);
    expect(tree("st:masters b:zen banned:modern restricted:vintage")).toEqual([
      "setType:eq:masters",
      "block:eq:zen",
      "banned:eq:modern",
      "restricted:eq:vintage",
    ]);
    expect(tree('ft:"the gods"')).toEqual(["flavor:colon:the gods"]);
    expect(tree("fo:flying fulloracle:trample")).toEqual([
      "oracleText:colon:flying",
      "oracleText:colon:trample",
    ]);
  });

  it("refuses an operator a keyword does not take", () => {
    for (const input of ["is>dual", "has=flavor", "game>arena", "new=art", "otag>removal"]) {
      expect(parseQuery(input).text, input).toBe(input);
    }
  });
});

describe("QUERY_KEYWORDS — the panel's sections", () => {
  it("files every row under a section the panel draws", () => {
    for (const spec of QUERY_KEYWORDS) {
      expect(QUERY_SECTIONS, spec.example).toContain(spec.section);
    }
  });

  it("gives every row its own example and its own blurb", () => {
    // The F1 panel's test finds each row by both, and a twin would make the lookup ambiguous.
    expect(new Set(QUERY_KEYWORDS.map((s) => s.example)).size).toBe(QUERY_KEYWORDS.length);
    expect(new Set(QUERY_KEYWORDS.map((s) => s.blurb)).size).toBe(QUERY_KEYWORDS.length);
  });
});

describe("wirePredicate and predicateKey", () => {
  it("drops the spans and keeps a group's terms", () => {
    const [group] = parseQuery("(t:goblin or t:elf)").predicates;
    expect(wirePredicate(group)).toEqual({
      field: "anyOf",
      op: "colon",
      value: "",
      negated: false,
      terms: [
        { field: "typeLine", op: "colon", value: "goblin", negated: false },
        { field: "typeLine", op: "colon", value: "elf", negated: false },
      ],
    });
    // A plain term's payload has no `terms` key at all — byte for byte what it always was.
    expect(wirePredicate(parseQuery("cmc>=3").predicates[0])).toEqual({
      field: "cmc",
      op: "gte",
      value: "3",
      negated: false,
    });
  });

  it("tells two groups apart by their terms, and folds case", () => {
    const key = (input: string) => predicateKey(parseQuery(input).predicates[0]);
    expect(key("t:goblin or t:elf")).not.toBe(key("t:goblin or t:dwarf"));
    expect(key("t:goblin or t:elf")).not.toBe(key("t:goblin or -t:elf"));
    expect(key("t:Goblin or t:elf")).toBe(key("t:goblin or t:elf"));
    expect(key("cmc>=3")).toBe("cmc|gte|3");
  });
});

describe("predicateLabel", () => {
  const label = (input: string, at = 0): string => {
    const token: PredicateToken = parseQuery(input).predicates[at];
    return predicateLabel(input, token);
  };

  it("is the reader's own spelling, minus the dash", () => {
    expect(label("mv>=3")).toBe("mv>=3");
    expect(label("-t:goblin")).toBe("t:goblin");
  });

  it("reads a group without its parentheses", () => {
    expect(label("(t:goblin or t:elf)")).toBe("t:goblin or t:elf");
    expect(label("-(t:goblin c:r)")).toBe("t:goblin c:r");
    expect(label("t:goblin or t:elf")).toBe("t:goblin or t:elf");
    expect(label("(t:goblin or t:elf")).toBe("t:goblin or t:elf");
    expect(label("(-t:goblin)")).toBe("t:goblin");
  });

  it("keeps a dash that belongs to one term of an unparenthesised or", () => {
    expect(label("-t:goblin or t:elf")).toBe("-t:goblin or t:elf");
  });

  it("words the two punctuation spellings", () => {
    expect(label("!fire")).toBe('name = "fire"');
    expect(label('-!"lightning bolt"')).toBe('name = "lightning bolt"');
    expect(label("is:fetchland")).toBe("is fetchland");
    expect(label("not:fetchland")).toBe("is fetchland");
  });
});

describe("the chip rewrites over groups", () => {
  it("negates and includes a parenthesised group in place", () => {
    const input = "c:r (t:goblin or t:elf) x";
    const [, group] = parseQuery(input).predicates;
    const excluded = setTokenNegated(input, group, true);
    expect(excluded).toBe("c:r -(t:goblin or t:elf) x");
    const [, again] = parseQuery(excluded).predicates;
    expect(again.negated).toBe(true);
    expect(setTokenNegated(excluded, again, false)).toBe(input);
  });

  it("wraps an unparenthesised or before it negates it", () => {
    // A bare dash would exclude only the goblins.
    const input = "t:goblin or t:elf";
    const [group] = parseQuery(input).predicates;
    const excluded = setTokenNegated(input, group, true);
    expect(excluded).toBe("-(t:goblin or t:elf)");
    expect(tree(excluded)).toEqual(["-anyOf(typeLine:colon:goblin, typeLine:colon:elf)"]);
  });

  it("includes a term negated inside its own parentheses", () => {
    const input = "(-t:goblin)";
    const [token] = parseQuery(input).predicates;
    const included = setTokenNegated(input, token, false);
    expect(tree(included)).toEqual(["typeLine:colon:goblin"]);
  });

  it("flips not: and is: rather than adding a dash", () => {
    const input = "not:reprint t:elf";
    const [token] = parseQuery(input).predicates;
    expect(setTokenNegated(input, token, false)).toBe("is:reprint t:elf");
    expect(setTokenNegated("is:reprint", parseQuery("is:reprint").predicates[0], true)).toBe(
      "-is:reprint",
    );
    expect(setTokenNegated("-not:reprint", parseQuery("-not:reprint").predicates[0], true)).toBe(
      "not:reprint",
    );
  });

  it("negates an exact name with a dash", () => {
    const input = "!fire";
    expect(setTokenNegated(input, parseQuery(input).predicates[0], true)).toBe("-!fire");
  });
});
