import { describe, expect, it } from "vitest";
import { WALL_CARD_VARIANT, type ImageVariant } from "@/lib/images";
import {
  DEFAULT_TOKEN_QUANTITY,
  deckTokenViews,
  isEmblem,
  tokenSubtitle,
  type DeckTokenRow,
} from "./deckTokens";

/**
 * The merge is the only part of this feature that can be wrong without anything going red
 * elsewhere: Rust hands over facts that are true whatever this file does with them, and the
 * panel draws whatever it is given. So every rule from spec §5 is pinned here.
 *
 * **The zero-quantity case is the one that matters most.** `stored || 1` is the natural way to
 * write "fall back to one copy", and it is wrong — it reads a deliberate 0 as absent and
 * silently shows 1, on the exact row where the reader said *none*, while keeping the art
 * choice that is the reason the row still exists (spec §4). Only `??` distinguishes the two,
 * and only this test can tell them apart.
 */

/**
 * One resolved token as Rust hands it over: derived, with no override stored against it.
 *
 * Deliberately not a token that exists in the corpus fixtures — this file tests the merge and
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
  cardId: null,
  quantity: null,
  state: null,
  power: null,
  toughness: null,
  colors: "",
  oracleText: "{T}, Sacrifice this token: Add one mana of any color.",
  ...over,
});

describe("deckTokenViews", () => {
  /**
   * The floor, and the whole of the quantity rule. There is no heuristic behind it and there
   * must not be one: parsing *"create two 1/1 white Soldier tokens"* out of oracle text is
   * defeated by `create X`, by *for each*, by copy-tokens and by repeatable makers like
   * Krenko — and a guess the reader has to correct is worse than a floor they raise.
   *
   * The literal `1` is asserted rather than the constant, and the constant is pinned to the
   * literal separately: an assertion that reads the same constant the implementation reads
   * passes against the exact defect it was written for.
   */
  it("defaults an untouched token to one copy", () => {
    expect(deckTokenViews([row()])[0].quantity).toBe(1);
    expect(DEFAULT_TOKEN_QUANTITY).toBe(1);
  });

  it("prefers the reader's printing over the resolver's", () => {
    expect(deckTokenViews([row({ cardId: "c-picked" })])[0].printingId).toBe("c-picked");
  });

  it("falls back to the resolver's printing when nothing was picked", () => {
    expect(deckTokenViews([row()])[0].printingId).toBe("c-default");
  });

  /**
   * **The web target's and the phone's only picture**, folded to the one URL the tile draws.
   *
   * Neither has the `mtgimg://` protocol to ask, so `cardArtSrc` falls through to whatever the
   * row carried and a tile with nothing draws the no-art frame — which is what every token tile
   * did in a browser before `DeckTokenRow` grew this field. Nothing in jsdom can see a picture,
   * so the fold is the only part of it a test can hold.
   *
   * The variant is read from {@link WALL_CARD_VARIANT} rather than spelled `"display"`: a
   * literal here would pass against the exact defect of picking a variant no wall pre-warms.
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
   * **The `||`-versus-`??` test.** A stored 0 is a token the reader zeroed, which is
   * information — the row survives precisely so the art choice is not thrown away as a side
   * effect of stepping a number down to nothing (spec §4). `stored || 1` turns that into a
   * silent 1 and the reader's decision is gone.
   */
  it("keeps a stored quantity of zero rather than treating it as absent", () => {
    expect(deckTokenViews([row({ quantity: 0, state: "auto" })])[0].quantity).toBe(0);
  });

  it("hides a dismissed token, and shows it when asked", () => {
    const rows = [row({ state: "hidden" })];
    expect(deckTokenViews(rows)).toHaveLength(0);
    expect(deckTokenViews(rows, { showDismissed: true })).toHaveLength(1);
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
   * `overridden` drives the reset affordance, so it has to mean "there is something to reset"
   * and nothing else. An untouched row also proves the state fallback: no stored row at all
   * still reads as `auto`, which is the word the rest of the app branches on.
   */
  it("marks a row overridden only when the reader deviated", () => {
    const untouched = deckTokenViews([row()])[0];
    expect(untouched.overridden).toBe(false);
    expect(untouched.state).toBe("auto");
    expect(deckTokenViews([row({ quantity: 4, state: "auto" })])[0].overridden).toBe(true);
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
