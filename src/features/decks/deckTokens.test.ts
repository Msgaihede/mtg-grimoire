import { describe, expect, it } from "vitest";
import { WALL_CARD_VARIANT, type ImageVariant } from "@/lib/images";
import { tileKeyOf } from "@/lib/tileKey";
import {
  DEFAULT_TOKEN_QUANTITY,
  deckTokenViews,
  entryRef,
  isEmblem,
  isHandAdded,
  isListedToken,
  isTokenLayout,
  isTokenPrinting,
  NOT_MADE_BY_DECK,
  notMadeByDeckHint,
  pileTokens,
  tokenArtName,
  tokenEntryName,
  tokenSubtitle,
  type DeckTokenRow,
} from "./deckTokens";

/**
 * The views are the only part of this feature that can be wrong without anything going red
 * elsewhere: Rust hands over facts that are true whatever this file does with them, and the
 * panel draws whatever it is given. So every rule the view owns is pinned here.
 *
 * **Since user schema v52 a wire row is one _entry_** — one printing in one finish of one token
 * in one list — and Rust resolves the effective printing and quantity itself (spec §4.2). What
 * is left here is the grain the wall keys on, the order it reads in, which entries the deck's
 * stacks draw (`pileTokens`) and which tokens nothing in the deck makes (`isHandAdded`).
 */

/**
 * One entry as Rust hands it over: the implicit entry of a derived token nobody has touched.
 *
 * Deliberately not a token that exists in the corpus fixtures — this file tests the views and
 * nothing about Scryfall, so the ids are obviously synthetic and a reader is never tempted to
 * check them against real data.
 */
const row = (over: Partial<DeckTokenRow> = {}): DeckTokenRow => ({
  oracleId: "o-treasure",
  name: "Treasure",
  typeLine: "Token Artifact — Treasure",
  layout: "token",
  defaultCardId: "c-default",
  sources: [{ cardId: "d-1", name: "Smothering Tithe" }],
  derived: true,
  cardId: "c-default",
  finish: "nonfoil",
  quantity: 1,
  implicit: true,
  state: "auto",
  power: null,
  toughness: null,
  colors: "",
  oracleText: "{T}, Sacrifice this token: Add one mana of any color.",
  // The effective printing's chin facts and price, all unknown: a printing gone from the corpus
  // answers `null` for every one of them, and that is the state a synthetic id is in.
  setCode: null,
  collectorNumber: null,
  setName: null,
  rarity: null,
  finishes: null,
  unitPrice: null,
  ...over,
});

describe("deckTokenViews", () => {
  /**
   * **One view per wire row, and never one per token.** A token with a foil and a nonfoil
   * Treasure in the list is two entries, and the wall draws two tiles — which is what makes
   * adding art B keep art A (spec §4.2 rule 2). A view that folded on the oracle id would draw
   * one of them and silently drop the other.
   */
  it("draws one view per entry, two printings of one token included", () => {
    const views = deckTokenViews([
      row({ cardId: "c-a", implicit: false, quantity: 2 }),
      row({ cardId: "c-b", finish: "foil", implicit: false, quantity: 1 }),
    ]);
    expect(views).toHaveLength(2);
    expect(views.map((v) => v.oracleId)).toEqual(["o-treasure", "o-treasure"]);
    expect(views.map((v) => v.quantity)).toEqual([2, 1]);
  });

  /**
   * The entry's own printing is the printing drawn — Rust has already resolved it, an implicit
   * entry's to the resolver's default — so the view passes it through rather than choosing.
   */
  it("draws the entry's own printing and finish", () => {
    const [view] = deckTokenViews([row({ cardId: "c-picked", finish: "etched", implicit: false })]);
    expect(view.printingId).toBe("c-picked");
    expect(view.finish).toBe("etched");
  });

  /**
   * **The key every surface keys a tile on is the collection wall's own spelling**,
   * `tileKeyOf(printing, finish)`, so a foil and a nonfoil copy of one printing are two keys —
   * the grain `deck_token_printings` is unique on, less the deck and the list the query named.
   * Asserted against `tileKeyOf` rather than a literal, because that function is the one place
   * the string is spelled.
   */
  it("keys an entry on its printing and its finish", () => {
    const views = deckTokenViews([
      row({ cardId: "c-a", finish: "nonfoil", implicit: false }),
      row({ cardId: "c-a", finish: "foil", implicit: false }),
    ]);
    expect(views.map((v) => v.entryKey).sort()).toEqual(
      [tileKeyOf("c-a", "nonfoil"), tileKeyOf("c-a", "foil")].sort(),
    );
    expect(new Set(views.map((v) => v.entryKey)).size).toBe(2);
  });

  /** `implicit` is a fact about the list — this token has no entry in it — and is passed through
   *  for the writes to read: a step on an implicit entry sends `null` so Rust materialises it. */
  it("passes implicit through", () => {
    expect(deckTokenViews([row()])[0].implicit).toBe(true);
    expect(deckTokenViews([row({ implicit: false })])[0].implicit).toBe(false);
  });

  /**
   * **The quantity is Rust's effective answer and the view does no arithmetic on it** — an
   * implicit entry arrives at `deck_tokens.quantity ?? 0` already, and a legacy count a reader
   * stored before v52 arrives as that count. The constant stays pinned to the literal because it
   * is still what that `?? 0` is, and the fake reads it.
   */
  it("passes the effective quantity through, zero included", () => {
    expect(deckTokenViews([row()])[0].quantity).toBe(1);
    expect(deckTokenViews([row({ quantity: 0, implicit: false })])[0].quantity).toBe(0);
  });

  /**
   * **An untouched token reads 0** (managed tokens spec §3.1): a token is something the reader
   * starts to use, so the default counts nothing and the first `+` is the reader's own. It was
   * `1` until then, which put every token a deck could make into its stacks whether or not the
   * reader ever sleeved one.
   */
  it("defaults an untouched token to zero copies", () => {
    expect(DEFAULT_TOKEN_QUANTITY).toBe(0);
    expect(deckTokenViews([row({ quantity: DEFAULT_TOKEN_QUANTITY })])[0].quantity).toBe(0);
  });

  /**
   * **A token's entries sit together, by set, collector number and finish** (spec §4.2) — after
   * the emblems-last-then-name order that places the token itself. The collector number is
   * compared as a number (`2` before `15`), and the finish in `FINISHES` order: nonfoil, foil,
   * etched. The rows go in scrambled, with a second token between them, so a comparator that
   * preserved input order or grouped by printing id would fail.
   */
  it("sorts a token's entries together by set, collector number and finish", () => {
    const treasure = (setCode: string, collectorNumber: string, finish: DeckTokenRow["finish"]) =>
      row({
        cardId: `c-${setCode}-${collectorNumber}`,
        finish,
        implicit: false,
        setCode,
        collectorNumber,
      });
    const views = deckTokenViews([
      treasure("thob", "13", "nonfoil"),
      treasure("tafr", "15", "etched"),
      row({ oracleId: "o-goblin", name: "Goblin", cardId: "c-goblin", setCode: "tznr" }),
      treasure("tafr", "15", "nonfoil"),
      treasure("tafr", "2", "foil"),
      treasure("tafr", "15", "foil"),
    ]);
    expect(views.map((v) => `${v.name} ${v.setCode} ${v.collectorNumber} ${v.finish}`)).toEqual([
      "Goblin tznr null nonfoil",
      "Treasure tafr 2 foil",
      "Treasure tafr 15 nonfoil",
      "Treasure tafr 15 foil",
      "Treasure tafr 15 etched",
      "Treasure thob 13 nonfoil",
    ]);
  });

  /** A reference the writes can take — the four facts that address an entry, and nothing a
   *  stale view could carry into a write by accident. */
  it("addresses an entry by its oracle, printing, finish and implicitness", () => {
    const [view] = deckTokenViews([row({ cardId: "c-a", finish: "foil", implicit: false })]);
    expect(entryRef(view)).toEqual({
      oracleId: "o-treasure",
      cardId: "c-a",
      finish: "foil",
      implicit: false,
    });
  });

  /**
   * The row's picture map, folded to one URL. The variant is read from {@link WALL_CARD_VARIANT}
   * rather than spelled `"display"`, so the case follows the constant.
   */
  it("folds the wall's variant out of the row's picture map", () => {
    const uris: Partial<Record<ImageVariant, string>> = {
      display: "https://cards.scryfall.io/normal/front/a.jpg?1",
      art: "https://cards.scryfall.io/art_crop/front/a.jpg?1",
    };
    expect(deckTokenViews([row({ imageUris: uris })])[0].imageUrl).toBe(uris[WALL_CARD_VARIANT]);
  });

  /**
   * Three ways a row says *no art*, and all three are the same answer rather than an error: a
   * printing the backend refused a URI for (`null`), a DTO from a build that predates the field
   * (absent), and a printing publishing only variants this wall does not draw. **`null` is never
   * a reason to build a URL** — the backend has already refused the host or the missing
   * `?<epoch>` — so the frame is the answer.
   */
  it("answers no picture as null rather than an undefined a frame would try to load", () => {
    expect(deckTokenViews([row({ imageUris: null })])[0].imageUrl).toBeNull();
    expect(deckTokenViews([row()])[0].imageUrl).toBeNull();
    expect(deckTokenViews([row({ imageUris: { thumb: "t" } })])[0].imageUrl).toBeNull();
  });

  /**
   * **The chin's facts and the price are passed through, and nothing here concludes anything
   * from them.** Rust resolves them off the *effective* printing — the one `imageUris` already
   * describes — and prices it at the marketplace the read was asked for, so the only way this
   * file could be wrong about them is by dropping or renaming one on the way to the view. Every
   * value is distinct from the fixture's `null` default, so a field left uncopied fails rather
   * than passing on a coincidence.
   *
   * `finishes` stays the JSON **text** `cards.finishes` stores: what a token is drawn at is
   * `playedFinish(null, finishes)`'s decision at the surface that draws it, and a parsed array
   * here would be a second reading of one column.
   */
  it("carries the effective printing's chin facts and price through untouched", () => {
    const [view] = deckTokenViews([
      row({
        setCode: "tclb",
        collectorNumber: "5",
        setName: "Commander Legends: Battle for Baldur's Gate Tokens",
        rarity: "common",
        finishes: '["nonfoil"]',
        unitPrice: 0.25,
      }),
    ]);
    expect(view).toMatchObject({
      setCode: "tclb",
      collectorNumber: "5",
      setName: "Commander Legends: Battle for Baldur's Gate Tokens",
      rarity: "common",
      finishes: '["nonfoil"]',
      unitPrice: 0.25,
    });
    // An unpriced printing stays unpriced: `null` is the em dash, and a `0` would be a Treasure
    // quoted as free.
    expect(deckTokenViews([row({ unitPrice: null })])[0].unitPrice).toBeNull();
  });

  /**
   * **The whole map travels beside the resolved `imageUrl`**, not narrowed. The absent key folds
   * to `null` for `imageUrl`'s reason: a DTO from a build that predates the field has no picture,
   * and `undefined` is a third state nothing downstream should have to spell.
   */
  it("passes the row's picture map through beside the resolved URL", () => {
    const uris: Partial<Record<ImageVariant, string>> = {
      display: "https://cards.scryfall.io/normal/front/a.jpg?1",
      art: "https://cards.scryfall.io/art_crop/front/a.jpg?1",
    };
    expect(deckTokenViews([row({ imageUris: uris })])[0].imageUris).toEqual(uris);
    expect(deckTokenViews([row({ imageUris: null })])[0].imageUris).toBeNull();
    expect(deckTokenViews([row()])[0].imageUris).toBeNull();
  });

  /**
   * **A zeroed entry is still a tile.** Rule 3 keeps a token's last entry at 0 rather than
   * deleting it, so the implicit default does not reappear under a reader who zeroed the only
   * printing they had — and a view that filtered on the quantity would undo that on screen.
   */
  it("keeps an entry at zero on the wall", () => {
    const views = deckTokenViews([row({ quantity: 0, implicit: false })]);
    expect(views).toHaveLength(1);
    expect(views[0].quantity).toBe(0);
  });

  /**
   * **A `hidden` row is drawn like any other** (managed tokens spec §3.3, Review Focus 1). Dismiss
   * is gone, and a launch pass retires the word — but a dismissal an older peer writes arrives by
   * sync *after* that pass has run, and until the next launch retires it too, it must draw as an
   * ordinary token. Nothing may hide it: a token that vanished on a sync, with no control anywhere
   * to bring it back, is the one outcome worse than a stale word.
   */
  it("draws a hidden row like any other, and filters nothing", () => {
    const views = deckTokenViews([
      row({ oracleId: "o-a", name: "Angel", state: "hidden", quantity: 2, implicit: false }),
      row({ oracleId: "o-b", name: "Bird", state: "hidden" }),
      row({ oracleId: "o-c", name: "Cat", quantity: 0 }),
    ]);
    expect(views.map((v) => [v.name, v.state])).toEqual([
      ["Angel", "hidden"],
      ["Bird", "hidden"],
      ["Cat", "auto"],
    ]);
  });

  /**
   * A `manual` row is what a derived token becomes when the reader wants it kept after cutting
   * the card that made it, and it is also what a hand-added token arrives as. `derived: false`
   * with an empty `sources` is therefore a state the panel must draw, not an inconsistency to
   * filter out.
   */
  it("keeps a manual row that nothing in the deck derives", () => {
    const v = deckTokenViews([row({ state: "manual", derived: false, sources: [] })]);
    expect(v).toHaveLength(1);
    expect(v[0].derived).toBe(false);
    expect(v[0].state).toBe("manual");
  });

  /** An emblem is a one-off; a Treasure pile is what you reach for. */
  it("orders emblems last and the rest by name", () => {
    const v = deckTokenViews([
      row({ oracleId: "o-e", name: "Elspeth Emblem", layout: "emblem" }),
      row({ oracleId: "o-s", name: "Soldier" }),
      row({ oracleId: "o-g", name: "Goblin" }),
    ]);
    expect(v.map((t) => t.name)).toEqual(["Goblin", "Soldier", "Elspeth Emblem"]);
  });

  /**
   * **A shared name is not a tiebreak, and the order must not depend on what the backend
   * happened to return.** `Wurmcoil Engine` makes two tokens both called `Wurm 3/3`, separated
   * only by Deathtouch and Lifelink, and 104 token/emblem names are shared by more than one
   * `oracle_id` (debug corpus, 2026-09-07). Sorted on the name alone the two are tied, so the
   * wall could put them in either order on two opens of one deck — which is how this was
   * found, by a story play that got them the other way round.
   *
   * The rows go in *reversed* so a comparator that merely preserves input order fails.
   */
  it("puts two same-named tokens in a stable order, by their subtitles", () => {
    const wurm = (oracleId: string, oracleText: string) =>
      row({ oracleId, name: "Wurm", power: "3", toughness: "3", colors: "", oracleText });
    const v = deckTokenViews([wurm("o-lifelink", "Lifelink"), wurm("o-deathtouch", "Deathtouch")]);
    expect(v.map((t) => t.subtitle)).toEqual(["Colorless 3/3 · Deathtouch", "Colorless 3/3 · Lifelink"]);
  });

  /**
   * The final term, and the only reason it is there: two tokens that agree on name *and*
   * subtitle would otherwise still be tied. Nothing in the corpus is known to hit this — it is
   * what makes the comparator total rather than nearly total.
   */
  it("falls back to the oracle id when name and subtitle both agree", () => {
    const twin = (oracleId: string) => row({ oracleId, name: "Copy", power: null, toughness: null, colors: null, oracleText: null });
    expect(deckTokenViews([twin("o-b"), twin("o-a")]).map((t) => t.oracleId)).toEqual(["o-a", "o-b"]);
  });

  /**
   * The view carries the disambiguator, so the panel never computes one itself — two tiles
   * announcing one name is the bug this whole line exists to prevent, and a surface that had
   * to remember to ask would be a surface that could forget.
   */
  it("carries each token's subtitle, and none for an emblem", () => {
    const [soldier] = deckTokenViews([
      row({ name: "Soldier", power: "1", toughness: "1", colors: "W", oracleText: "" }),
    ]);
    expect(soldier.subtitle).toBe("White 1/1");
    const [emblem] = deckTokenViews([row({ name: "Elspeth Emblem", layout: "emblem" })]);
    expect(emblem.subtitle).toBeNull();
  });

  /**
   * `implicit` is what **Remove printing** is drawn by (managed tokens spec §3.4), on the band and
   * the pile alike, so it passes through as Rust answered it and nothing else bends it —
   * `deck_token_remove` deletes one stored entry, and an implicit one is not stored. The token's
   * state is not part of it: a `hidden` implicit entry is as unstored as an `auto` one.
   */
  it("passes implicit through as the read answered it, whatever the state", () => {
    const untouched = deckTokenViews([row()])[0];
    expect(untouched.implicit).toBe(true);
    expect(untouched.state).toBe("auto");
    expect(deckTokenViews([row({ implicit: false })])[0].implicit).toBe(false);
    expect(deckTokenViews([row({ state: "hidden" })])[0].implicit).toBe(true);
  });
});

/**
 * **The deck's stacks draw what the reader has counted; the band draws everything** (managed
 * tokens spec §3.2). `pileTokens` is the one filter, and `DeckEditor` applies it to the pile's
 * list alone — the band, Add printing and the plan's live side keep every row.
 */
describe("pileTokens", () => {
  it("keeps only the entries with at least one copy, in the order it was handed", () => {
    const views = deckTokenViews([
      row({ oracleId: "o-a", name: "Angel", quantity: 0 }),
      row({ oracleId: "o-b", name: "Bird", quantity: 1, implicit: false }),
      row({ oracleId: "o-c", name: "Cat", quantity: 3, implicit: false }),
      row({ oracleId: "o-d", name: "Dog", quantity: 0, implicit: false }),
    ]);
    expect(pileTokens(views).map((v) => v.name)).toEqual(["Bird", "Cat"]);
  });

  /** A token's two entries are two answers: the counted one is drawn, its zero twin is not. */
  it("filters entry by entry, so one token can be half in the pile", () => {
    const views = deckTokenViews([
      row({ cardId: "c-a", finish: "nonfoil", quantity: 0, implicit: false }),
      row({ cardId: "c-a", finish: "foil", quantity: 2, implicit: false }),
    ]);
    expect(pileTokens(views).map((v) => v.finish)).toEqual(["foil"]);
  });

  /** Review Focus 1 on the pile's side: a `hidden` entry with copies is a counted token. */
  it("draws a hidden entry with copies like any other", () => {
    const views = deckTokenViews([row({ state: "hidden", quantity: 2, implicit: false })]);
    expect(pileTokens(views)).toHaveLength(1);
  });

  /** A new array, never the argument: the input is the hook's memo and must not be reordered. */
  it("answers a new array and leaves its input alone", () => {
    const views = deckTokenViews([row({ quantity: 0 })]);
    const pile = pileTokens(views);
    expect(pile).not.toBe(views);
    expect(views).toHaveLength(1);
  });
});

/**
 * **A hand-added token is one nothing in the deck makes — `derived === false`, never `state`**
 * (managed tokens spec §3.5). A token the deck derives can still be `manual` (kept by hand after a
 * cut, or restored before this build), and marking it as not made by the deck would be a false
 * sentence about a card that is sitting in the deck making it.
 */
describe("isHandAdded", () => {
  it("reads derived and never the state", () => {
    expect(isHandAdded({ derived: false })).toBe(true);
    expect(isHandAdded({ derived: true })).toBe(false);
    const [derivedManual] = deckTokenViews([row({ state: "manual", derived: true })]);
    expect(isHandAdded(derivedManual)).toBe(false);
    const [byHand] = deckTokenViews([row({ state: "manual", derived: false, sources: [] })]);
    expect(isHandAdded(byHand)).toBe(true);
  });
});

/**
 * **The mark's words, spelled once**: the badge, its tooltip and the clause the art press's name
 * carries — because the badge is `aria-hidden`, and a mark only sighted readers can see is a fact
 * half the readers never get.
 */
describe("the not-made-by-deck mark", () => {
  it("says the badge and the tooltip in the spec's words", () => {
    expect(NOT_MADE_BY_DECK).toBe("NOT MADE BY DECK");
    expect(notMadeByDeckHint("Treasure")).toBe(
      "Nothing in this deck makes Treasure. It was added by hand.",
    );
  });

  it("folds the mark's words into the art press's name for a hand-added token only", () => {
    const [made] = deckTokenViews([row({ cardId: "c-a", setCode: "tafr", collectorNumber: "15" })]);
    const [byHand] = deckTokenViews([
      row({ cardId: "c-a", setCode: "tafr", collectorNumber: "15", derived: false, sources: [] }),
    ]);
    expect(tokenArtName(made)).toBe(tokenEntryName("Change the art for", made));
    expect(tokenArtName(byHand)).toBe(
      `${tokenEntryName("Change the art for", byHand)}, not made by deck`,
    );
  });
});

/**
 * **One entry, one name, on every surface that draws it** — the band's tile and the pile's card
 * both call this, so the whole string is pinned here once rather than twice by two surfaces'
 * literals. Two entries of one printing differ only in the finish, and the finish is spelled on
 * the plain copy too: without it the two steppers would announce one name, which is the collection
 * wall's shipped duplicate-name bug reached through a token.
 */
describe("tokenEntryName", () => {
  const SUBTITLE = "Colorless · {T}, Sacrifice this token: Add one mana of any color.";
  const entry = (over: Partial<DeckTokenRow>) =>
    deckTokenViews([
      row({ cardId: "c-tafr", setCode: "tafr", collectorNumber: "15", implicit: false, ...over }),
    ])[0];

  it("spells the verb, the token, its subtitle, the printing and the finish", () => {
    expect(tokenEntryName("Quantity of", entry({ finish: "nonfoil" }))).toBe(
      `Quantity of Treasure, ${SUBTITLE}, TAFR · 15, Nonfoil`,
    );
    expect(tokenEntryName("Quantity of", entry({ finish: "foil" }))).toBe(
      `Quantity of Treasure, ${SUBTITLE}, TAFR · 15, Foil`,
    );
  });

  it("says no printing for one gone from the corpus, and still says its finish", () => {
    expect(tokenEntryName("Remove", entry({ setCode: null, collectorNumber: null }))).toBe(
      `Remove Treasure, ${SUBTITLE}, Nonfoil`,
    );
  });
});

describe("isTokenLayout", () => {
  /**
   * `deck_tokens::is_token_layout`'s TypeScript twin: the three `cards.layout` words that make a
   * row a token. The layout and never the type line, `isEmblem`'s reason — and absent is not a
   * token, because a surface that has no layout for a card has no business drawing it as one.
   */
  it("answers the three token layouts and nothing else", () => {
    expect(isTokenLayout("token")).toBe(true);
    expect(isTokenLayout("double_faced_token")).toBe(true);
    expect(isTokenLayout("emblem")).toBe(true);
    expect(isTokenLayout("normal")).toBe(false);
    expect(isTokenLayout("art_series")).toBe(false);
    // The two a token can wear without being one: the layout alone says nothing, which is
    // `a_token_layout_is_one_of_the_three`'s half of the crate's table.
    expect(isTokenLayout("flip")).toBe(false);
    expect(isTokenLayout("reversible_card")).toBe(false);
    expect(isTokenLayout("meld")).toBe(false);
    expect(isTokenLayout("")).toBe(false);
    expect(isTokenLayout(null)).toBe(false);
    expect(isTokenLayout(undefined)).toBe(false);
  });
});

describe("isTokenPrinting", () => {
  /**
   * `deck_tokens::is_token_printing`'s TypeScript twin, driven by the crate's own table
   * (`a_token_printing_is_a_token_layout_or_a_two_sided_token_line`) row for row: a token layout
   * on its own, or a `flip` / `reversible_card` printing whose type line — or any ` // ` face of
   * it — begins `Token` or `Emblem`. Every line is one the debug corpus stores except the one
   * marked, which is the "any face" half.
   */
  it("is a token layout, or a two-sided layout whose line says Token", () => {
    const yes: [string, string | null][] = [
      ["token", "Token Artifact — Treasure"],
      ["double_faced_token", null],
      ["emblem", "Emblem — Elspeth"],
      ["flip", "Token Enchantment — Aura Role // Token Enchantment — Aura Role"],
      ["reversible_card", "Token Legendary Artifact Creature — Construct"],
      // Not in the corpus: a token on the second face alone.
      ["flip", "Creature — Human // Token Creature — Spirit"],
    ];
    for (const [layout, line] of yes) {
      expect(isTokenPrinting(layout, line), `${layout} ${line}`).toBe(true);
    }
    const no: [string, string | null][] = [
      ["reversible_card", "Legendary Creature — Elf Druid"],
      ["reversible_card", "Basic Land — Plains"],
      ["flip", "Creature — Human Monk // Legendary Creature — Spirit"],
      ["reversible_card", null],
      // A `Token` line on a layout outside the two is never read as one.
      ["normal", "Token Creature — Goblin"],
      ["normal", "Instant"],
    ];
    for (const [layout, line] of no) {
      expect(isTokenPrinting(layout, line), `${layout} ${line}`).toBe(false);
    }
  });

  /** Absent answers `false` in both arguments, and the prefix is case-sensitive, as `starts_with`
   *  is — `token` in lower case is not Scryfall's supertype. */
  it("answers false for an absent layout, an absent line and a lower-case word", () => {
    expect(isTokenPrinting(null, "Token Creature — Spirit")).toBe(false);
    expect(isTokenPrinting(undefined, "Token Creature — Spirit")).toBe(false);
    expect(isTokenPrinting("flip", undefined)).toBe(false);
    expect(isTokenPrinting("flip", "")).toBe(false);
    expect(isTokenPrinting("flip", "token Creature — Spirit")).toBe(false);
  });
});

describe("isListedToken", () => {
  /**
   * `deck_tokens::is_listed_token`'s twin over the shapes the crate's
   * `token_printings_keeps_the_game_helpers_and_leaves_out_other_games` holds: every real token
   * and emblem, and the game helpers a deck brings to the table — while other games' cards, the
   * minigames and the checklists stay out. Lines, texts and set types off the debug corpus.
   */
  it("lists tokens, emblems and game helpers, and nothing from another game", () => {
    const FACE_DOWN = "(You can cover a face-down manifested creature with this reminder card.)";
    const CHECKLIST = "(You can mark this card to represent a double-faced card in your library.)";
    const yes: [string, string, string | null, string | null][] = [
      ["token", "Token Artifact — Treasure", null, "token"],
      ["emblem", "Emblem — Elspeth", null, "token"],
      ["flip", "Token Enchantment — Aura Role // Token Enchantment — Aura Role", null, "token"],
      // A real token is listed from any set, an other game's included.
      ["token", "Token Creature — Soldier", null, "memorabilia"],
      ["token", "Card", "At the beginning of your end step, draw a card.", "token"], // The Monarch
      ["double_faced_token", "Card // Card", null, "token"], // Day // Night
      ["double_faced_token", "Dungeon — Undercity // Card", null, "token"], // The Initiative
      ["token", "Creature", FACE_DOWN, "token"], // Manifest
      ["token", "Artifact Creature — Cyberman", "(You can cover a face-down creature…)", "token"],
      ["token", "Card", null, "masters"], // The List's City's Blessing
      ["token", "Card", null, null], // a set `sets` does not list: in doubt, kept
    ];
    for (const [layout, line, text, setType] of yes) {
      expect(isListedToken(layout, line, text, setType), `${layout} ${line} ${setType}`).toBe(
        true,
      );
    }
    const no: [string, string, string | null, string | null][] = [
      ["token", "Card", null, "memorabilia"], // a World Championships ad
      ["token", "Creature — Minotaur", "Haste", "memorabilia"], // Battle the Horde
      ["double_faced_token", "Card // Card", null, "minigame"], // Booster Sleuth
      ["token", "Card", CHECKLIST, "token"], // Innistrad Checklist
      ["token", "Boss", "Whenever a creature the bosses control dies…", "token"], // TMNT arena
      ["token", "Event", "Destroy all Turtles.", "token"],
      ["token", "Creature — Ninja", "This creature can't block.", "token"],
      // The helper arm is `token` and `double_faced_token` only, and never a real card.
      ["emblem", "Card", null, "token"],
      ["normal", "Card", null, "token"],
      ["flip", "Creature — Human Monk // Legendary Creature — Spirit", null, "expansion"],
      // Case-sensitive, as the crate's `instr` is.
      ["token", "card", null, "token"],
    ];
    for (const [layout, line, text, setType] of no) {
      expect(isListedToken(layout, line, text, setType), `${layout} ${line} ${setType}`).toBe(
        false,
      );
    }
    expect(isListedToken(null, "Card", null, "token")).toBe(false);
  });
});

/**
 * The name is not the identity. Measured on the debug corpus 2026-09-07: 104 token and emblem
 * names are shared by more than one `oracle_id`. Each case below is a real pair from it, and
 * each is a pair that one of the three terms on its own cannot separate.
 */
describe("tokenSubtitle", () => {
  it("tells Wurmcoil's two Wurms apart", () => {
    // Both "Wurm", both 3/3, both colourless artifacts; only the text differs, which is why
    // colours and size alone are not enough.
    const a = tokenSubtitle({
      layout: "token",
      typeLine: "Token Creature — Wurm",
      power: "3",
      toughness: "3",
      colors: "",
      oracleText: "Deathtouch",
    });
    const b = tokenSubtitle({
      layout: "token",
      typeLine: "Token Creature — Wurm",
      power: "3",
      toughness: "3",
      colors: "",
      oracleText: "Lifelink",
    });
    expect(a).not.toBe(b);
  });

  it("tells a colorless 1/1 Soldier from a white one", () => {
    // Both exist in the corpus with no oracle text at all, so colours must participate.
    const a = tokenSubtitle({
      layout: "token",
      typeLine: "Token Creature — Soldier",
      power: "1",
      toughness: "1",
      colors: "",
      oracleText: "",
    });
    const b = tokenSubtitle({
      layout: "token",
      typeLine: "Token Creature — Soldier",
      power: "1",
      toughness: "1",
      colors: "W",
      oracleText: "",
    });
    expect(a).not.toBe(b);
  });

  it("gives an emblem no subtitle", () => {
    expect(
      tokenSubtitle({
        layout: "emblem",
        typeLine: "Emblem — Elspeth",
        power: null,
        toughness: null,
        colors: null,
        oracleText: "Creatures you control get +2/+2 and have flying.",
      }),
    ).toBeNull();
  });

  /**
   * A size is what Scryfall printed, never a number. The corpus holds a real `*`-over-`*` Elemental,
   * and `1+*` and `∞` are printed sizes too — a parse would turn each of them into `NaN` and
   * fold every one of them into a single unreadable line.
   */
  it("prints a starred power and toughness exactly as they were printed", () => {
    expect(
      tokenSubtitle({
        layout: "token",
        typeLine: "Token Creature — Elemental",
        power: "*",
        toughness: "*",
        colors: "R",
        oracleText: "",
      }),
    ).toBe("Red */*");
  });
});

describe("isEmblem", () => {
  /**
   * The layout, never the type line. `layout` is a column Scryfall fills; a type line is prose
   * that a reader — or a future localisation — can spell differently, and `"Emblem — Elspeth"`
   * is only one of the shapes it takes.
   */
  it("reads the layout, not the type line, for an emblem", () => {
    expect(isEmblem({ layout: "emblem" })).toBe(true);
    expect(isEmblem({ layout: "token" })).toBe(false);
  });
});
