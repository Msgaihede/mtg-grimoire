import { describe, expect, it } from "vitest";
import {
  parseTagQuery,
  removeToken,
  setTokenNegated,
  TAG_KEYWORDS,
  tokenKey,
  type TagToken,
} from "./tagQuery";

/** `namespace:value`, negation marked with a leading `-`, so a whole parse reads on one line. */
const terms = (input: string): string[] =>
  parseTagQuery(input).tokens.map((t) => `${t.negated ? "-" : ""}${t.namespace}:${t.value}`);

describe("parseTagQuery", () => {
  it("reads every alias Scryfall documents, plus the two this app adds", () => {
    // Measured live 2026-08-20 (see the art-tags research): all four art spellings answer 1,145
    // for `dragon` and all five oracle ones answer 6,428 for `removal`. `a:` and `o:` are this
    // app's own, and mean the taxonomies rather than Scryfall's artist and oracle text.
    expect(terms("art:dragon atag:dragon arttag:dragon art_tag:dragon a:dragon")).toEqual(
      Array(5).fill("art:dragon"),
    );
    expect(
      terms("otag:removal oracletag:removal function:removal oracle_tag:removal o:removal"),
    ).toEqual(Array(5).fill("oracle:removal"));
    // `oracle-tag:` too — separators are normalised out of the keyword, not just the value.
    expect(terms("oracle-tag:removal")).toEqual(["oracle:removal"]);
  });

  it("takes a keyword however it is capitalised", () => {
    expect(terms("OTAG:removal Art:dragon A:dragon")).toEqual([
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
    expect(terms("-a:dragon o:ramp -o:removal")).toEqual([
      "-art:dragon",
      "oracle:ramp",
      "-oracle:removal",
    ]);
  });

  it("drops a keyword with nothing after it rather than filtering or searching by it", () => {
    // Every keystroke on the way to a tag passes through this state. A token would sit there
    // reporting `""` as an unknown tag; free text would search the corpus for `o`.
    const parsed = parseTagQuery("o: -a: bolt");
    expect(parsed.tokens).toEqual([]);
    expect(parsed.text).toBe("bolt");
  });

  it("keeps two terms naming the same tag rather than silently folding them", () => {
    expect(terms("a:dog a:dog")).toEqual(["art:dog", "art:dog"]);
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
    expect(terms("a:dog o:ramp")).toEqual(["art:dog", "oracle:ramp"]);
  });
});

describe("removeToken", () => {
  const only = (input: string): TagToken => parseTagQuery(input).tokens[0];

  it("takes the term out and leaves one space between what is left", () => {
    const input = "bolt a:dragon lightning";
    expect(removeToken(input, only(input))).toBe("bolt lightning");
  });

  it("leaves nothing behind when the term was the whole query", () => {
    const input = "a:dragon";
    expect(removeToken(input, only(input))).toBe("");
  });

  it("takes a quoted term out whole", () => {
    const input = 'bolt -otag:"spot removal"';
    expect(removeToken(input, only(input))).toBe("bolt");
  });

  it("removes the term it was given rather than the first one that looks like it", () => {
    const input = "a:dog o:ramp a:dog";
    const second = parseTagQuery(input).tokens[2];
    expect(removeToken(input, second)).toBe("a:dog o:ramp");
  });
});

describe("setTokenNegated", () => {
  const only = (input: string): TagToken => parseTagQuery(input).tokens[0];

  it("adds and removes the dash in place", () => {
    expect(setTokenNegated("bolt a:dragon x", only("bolt a:dragon x"), true)).toBe(
      "bolt -a:dragon x",
    );
    expect(setTokenNegated("bolt -a:dragon x", only("bolt -a:dragon x"), false)).toBe(
      "bolt a:dragon x",
    );
  });

  it("does not move the term to the end of the query", () => {
    // `toggleChipMode`'s rule: a chip that jumped when it was flipped would make the row
    // unreadable exactly while the reader is editing it — and here it reorders their sentence.
    const input = "a:dog o:ramp";
    const first = parseTagQuery(input).tokens[0];
    expect(setTokenNegated(input, first, true)).toBe("-a:dog o:ramp");
  });

  it("leaves a quoted value quoted", () => {
    const input = 'otag:"spot removal"';
    expect(setTokenNegated(input, only(input), true)).toBe('-otag:"spot removal"');
  });

  it("is a no-op when the term is already the way it was asked for", () => {
    const input = "-a:dog";
    expect(setTokenNegated(input, only(input), true)).toBe("-a:dog");
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

describe("TAG_KEYWORDS", () => {
  it("lists only keywords the parser actually reads", () => {
    for (const [namespace, keywords] of Object.entries(TAG_KEYWORDS)) {
      for (const keyword of keywords) {
        expect(terms(`${keyword}:dog`)).toEqual([`${namespace}:dog`]);
      }
    }
  });
});
