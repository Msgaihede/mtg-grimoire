import { describe, expect, it } from "vitest";
import {
  parseQuery,
  parseTagQuery,
  QUERY_KEYWORDS,
  removeToken,
  setTokenNegated,
  tokenKey,
  type TagToken,
} from "./queryLanguage";

/** `namespace:value`, negation marked with a leading `-`, so a whole parse reads on one line. */
const terms = (input: string): string[] =>
  parseTagQuery(input).tokens.map((t) => `${t.negated ? "-" : ""}${t.namespace}:${t.value}`);

describe("parseTagQuery", () => {
  it("reads every alias Scryfall documents", () => {
    // Measured live 2026-08-20 (see the art-tags research): all four art spellings answer 1,145
    // for `dragon` and all five oracle ones answer 6,428 for `removal`. `a:` and `o:` were on
    // these two lists from 2026-08-22 to 2026-09-22 and are Scryfall's artist and oracle text
    // again — see the `a:`/`o:` reassignment below.
    expect(terms("art:dragon atag:dragon arttag:dragon art_tag:dragon")).toEqual(
      Array(4).fill("art:dragon"),
    );
    expect(
      terms("otag:removal oracletag:removal function:removal oracle_tag:removal"),
    ).toEqual(Array(4).fill("oracle:removal"));
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
    const parsed = parseTagQuery("itag:dragon ftag:removal otags:removal bolt");
    expect(parsed.tokens).toEqual([]);
    expect(parsed.text).toBe("itag:dragon ftag:removal otags:removal bolt");
  });

  it("keeps a quoted value whole and hands the rest to FTS", () => {
    const parsed = parseTagQuery('bolt otag:"spot removal" dragon');
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
    const parsed = parseTagQuery("otag: -atag: bolt");
    expect(parsed.tokens).toEqual([]);
    expect(parsed.text).toBe("bolt");
  });

  it("keeps two terms naming the same tag rather than silently folding them", () => {
    expect(terms("atag:dog atag:dog")).toEqual(["art:dog", "art:dog"]);
  });

  it("answers an empty query with no tokens and no text", () => {
    expect(parseTagQuery("")).toEqual({ text: "", tokens: [] });
    expect(parseTagQuery("   ")).toEqual({ text: "", tokens: [] });
  });

  it("spans the whole term, dash and quotes included", () => {
    const input = 'bolt -otag:"spot removal" x';
    const [token] = parseTagQuery(input).tokens;
    expect(input.slice(token.start, token.end)).toBe('-otag:"spot removal"');
  });

  it("names both taxonomies in one query", () => {
    expect(terms("atag:dog otag:ramp")).toEqual(["art:dog", "oracle:ramp"]);
  });
});

describe("removeToken", () => {
  const only = (input: string): TagToken => parseTagQuery(input).tokens[0];

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
    const second = parseTagQuery(input).tokens[2];
    expect(removeToken(input, second)).toBe("atag:dog otag:ramp");
  });
});

describe("setTokenNegated", () => {
  const only = (input: string): TagToken => parseTagQuery(input).tokens[0];

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
    const first = parseTagQuery(input).tokens[0];
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
        const parsed = parseQuery(`${keyword}${spec.example.slice(spec.example.search(/[:=<>!]/))}`);
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
