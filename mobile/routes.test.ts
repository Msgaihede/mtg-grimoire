import { describe, expect, it } from "vitest";
import { parsePlace, placeHref } from "./routes";

describe("parsePlace", () => {
  it("reads a destination off the path", () => {
    expect(parsePlace("/collection", "")).toEqual({ view: "collection", deckId: null, cardId: null });
  });

  it("reads an open deck", () => {
    expect(parsePlace("/decks/12", "")).toEqual({ view: "decks", deckId: 12, cardId: null });
  });

  it("reads an open card off the query, over any destination", () => {
    expect(parsePlace("/wishlist", "?card=abc-123")).toEqual({
      view: "wishlist",
      deckId: null,
      cardId: "abc-123",
    });
  });

  it.each([
    ["/", "the root"],
    ["", "an empty path"],
    ["/nope", "a word that is no destination"],
    ["/index.html", "the document's own file name"],
    ["/home", "a desktop destination the light app does not draw"],
  ])("opens on Search for %s (%s)", (path) => {
    expect(parsePlace(path, "").view).toBe("search");
  });

  it.each([["/decks/abc"], ["/decks/"], ["/decks/-3"], ["/decks/1.5"], ["/decks/12abc"]])(
    "opens the gallery, not a deck, for %s",
    (path) => {
      expect(parsePlace(path, "")).toEqual({ view: "decks", deckId: null, cardId: null });
    },
  );

  it("opens the gallery for a deck id too large to be one", () => {
    // Every character is a digit, so the pattern alone lets it through — as 1e20, which
    // `placeHref` would spell back as `/decks/100000000000000000000` and Rust cannot read as an id.
    expect(parsePlace("/decks/99999999999999999999", "")).toEqual({
      view: "decks",
      deckId: null,
      cardId: null,
    });
    // The largest id that is still an exact integer is still an id.
    expect(parsePlace(`/decks/${Number.MAX_SAFE_INTEGER}`, "").deckId).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("ignores a deck id under a destination that is not Decks", () => {
    expect(parsePlace("/search/12", "").deckId).toBeNull();
  });

  it("reads an empty card parameter as no card", () => {
    expect(parsePlace("/search", "?card=").cardId).toBeNull();
  });
});

describe("placeHref", () => {
  it("round-trips every shape", () => {
    for (const href of ["/search", "/decks", "/decks/12", "/collection?card=abc-123", "/decks/7?card=x"]) {
      const [path, search = ""] = href.split("?");
      expect(placeHref(parsePlace(path, search && `?${search}`))).toBe(href);
    }
  });

  it("escapes a card id, which is not ours to trust", () => {
    expect(placeHref({ view: "search", deckId: null, cardId: "a b&c" })).toBe("/search?card=a%20b%26c");
  });
});
