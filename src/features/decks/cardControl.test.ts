import { describe, expect, it } from "vitest";
/**
 * The stylesheet as it ships. Read through Vite with `?raw`, exactly as `lib/motion.test.ts` and
 * `lib/tokens.test.ts` read the files they assert against — this project has no `@types/node`,
 * so `node:fs` is not available to a test and is not going to be.
 */
import css from "@/index.css?raw";
import type { DeckCard } from "@/lib/ipc";
import {
  CARD_BODY_ATTR,
  deckCardName,
  deckCardShort,
  keepsSelection,
  LANDED_MS,
} from "./cardControl";

/** The token the mark's fade is written as, and the duration inside it. */
const FADE = /--animate-card-landed:\s*card-landed\s+([\d.]+)(ms|s)\b/;

describe("the landed mark's five seconds", () => {
  /**
   * **Two files, one number, and nothing else would notice.**
   *
   * The stylesheet fades the mark over five seconds and {@link LANDED_MS} takes it out of the DOM
   * after five seconds, and the two are genuinely two consumers rather than a copy — there is no
   * expression that could compute one from the other, because a CSS animation cannot read a TS
   * constant and Tailwind emits no rule for an interpolated class.
   *
   * The failure they drift into is the quiet kind: shorten the CSS and every mark blinks out
   * early with a dead overlay left on the card; shorten the TS and the mark is torn off
   * mid-fade. Neither breaks anything, so nothing else here can go red for it.
   */
  it("fades in CSS for exactly as long as the mark lives in TypeScript", () => {
    const found = FADE.exec(css);
    expect(found, "--animate-card-landed is not in index.css").not.toBeNull();
    const [, value, unit] = found as RegExpExecArray;
    expect(Number(value) * (unit === "s" ? 1000 : 1)).toBe(LANDED_MS);
  });

  /** The token names a keyframe, and a keyframe that is not there animates nothing at all —
   *  silently, with the mark simply sitting at full strength until it is unmounted. */
  it("names a keyframe the stylesheet actually defines", () => {
    expect(css).toContain("@keyframes card-landed");
  });
});

/**
 * A live row of the Main deck, short by three: the deck plays four and the group holds one, which
 * is the red `1/4` a stacked card's chin draws.
 *
 * The whole `DeckCard` rather than a `Pick<>`, for `quickCollection.test.ts`' reason — the
 * functions under test take one, and a narrowed fixture would let a field they start reading
 * arrive as `undefined`.
 */
const BOLT: DeckCard = {
  id: 9,
  cardId: "p1",
  categoryId: 1,
  categoryName: "Main deck",
  categoryKind: "main",
  categoryActive: true,
  variant: "live",
  labelId: null,
  labelName: null,
  labelColor: null,
  quantity: 4,
  name: "Lightning Bolt",
  setCode: "lea",
  setName: "Limited Edition Alpha",
  collectorNumber: "161",
  lang: "en",
  finish: null,
  needsReview: null,
  oracleId: "o1",
  manaCost: "{R}",
  cmc: 1,
  typeLine: "Instant",
  oracleText: "Lightning Bolt deals 3 damage to any target.",
  colors: "R",
  colorIdentity: "R",
  legalities: '{"modern":"legal"}',
  power: null,
  toughness: null,
  layout: "normal",
  rarity: "common",
  faces: null,
  gameChanger: false,
  finishes: null,
  promoTypes: null,
  everUncommon: false,
  unitPrice: 4.5,
  ownedQuantity: 1,
};

const card = (over: Partial<DeckCard> = {}): DeckCard => ({ ...BOLT, ...over });

/** A deck that reads the collection — every deck but a virtual one. Named rather than repeated as
 *  a bare `true`, so the cases that pass `false` are visibly about the deck kind. */
const TRACKS = true;

describe("deckCardShort", () => {
  /** The ordinary case, and the one every other assertion here is a subtraction from. */
  it("marks a row the deck's group cannot fill", () => {
    expect(deckCardShort(card(), TRACKS)).toBe(true);
    expect(deckCardShort(card({ quantity: 4, ownedQuantity: 4 }), TRACKS)).toBe(false);
    // A group holding *more* than the list asks for is an ordinary state — a 4-of cut to 2 with
    // the cardboard left in the box — and reads as nothing missing rather than as a shortage.
    expect(deckCardShort(card({ quantity: 2, ownedQuantity: 5 }), TRACKS)).toBe(false);
  });

  /**
   * The two guards this predicate had before the third deck kind existed, kept as regressions —
   * and the two are no longer the same kind of statement.
   *
   * **The inactive pile is still arithmetic**: `attribute_owned` hands a switched-off pile nothing
   * out of either variant's pool, so its `0` is a fact about the pile rather than about the
   * reader's shelves.
   *
   * **The theory row is a product call since 2026-09-09**
   * ([issue #435](https://github.com/Msgaihede/mtg-grimoire/issues/435)). It used to be arithmetic
   * too — a plan held nothing and `attribute_owned` zeroed every theory row — and now a plan's row
   * counts every copy the reader owns that this deck could use, so the mark would be *accurate*
   * and is still refused. **The fixture says so**: `ownedQuantity: 1` against `quantity: 2` is a
   * real, truthful shortage, so this case cannot pass for want of one — take the `variant` clause
   * out of `deckCardShort` and it goes red.
   */
  it("still refuses an inactive pile, and refuses a theory row that really is short", () => {
    expect(deckCardShort(card({ categoryActive: false }), TRACKS)).toBe(false);
    expect(
      deckCardShort(card({ variant: "theory", quantity: 2, ownedQuantity: 1 }), TRACKS),
    ).toBe(false);
  });

  /**
   * **The third deck kind — issue #401.** A virtual deck has no `collection_folders` group, so
   * it can draw on no pool at all and *every* row reads `0` owned: a hundred red marks all
   * saying the same untrue thing, which is the failure issue #354 reported on a plan, reached by
   * a different route and over the whole deck rather than one list. (That plan's half has since
   * stopped being an arithmetic — see the case above — while this one has not.)
   *
   * **Asserted on rows that are `live` and in an active pile**, because that is the whole point:
   * the two guards above pass, `card.variant` says `live` — deliberately, since `DeckRow.cardCount`
   * and the gallery's colour bar both count `variant = 'live'` — and nothing on the row can answer
   * the question. The flag is the only thing that can.
   */
  it("marks nothing at all on a deck that tracks no cardboard", () => {
    expect(deckCardShort(card(), false)).toBe(false);
    expect(deckCardShort(card({ quantity: 4, ownedQuantity: 0 }), false)).toBe(false);
    expect(deckCardShort(card({ quantity: 1, ownedQuantity: 0 }), false)).toBe(false);
  });
});

describe("deckCardName", () => {
  /** The clause the figure is announced by, and the one this predicate exists to keep in step
   *  with it — three of the four views draw no figure at all, so on those this is the only place
   *  a shortage is stated. */
  it("says the shortage in words where the mark is drawn", () => {
    expect(deckCardName(card(), null, null, TRACKS)).toContain("you own 1 of 4");
  });

  /**
   * **One predicate behind both, which is the whole reason `deckCardShort` is a function.** The
   * figure and the words must never disagree about whether there is a shortage at all — so the
   * flag is required on this function too rather than defaulted, and a view that passed `false`
   * to the mark while letting the name default would go on announcing *you own 0 of 4* on every
   * card of a virtual deck under no red figure anywhere.
   */
  it("drops that clause on a deck that tracks no cardboard, exactly as the mark does", () => {
    const virtual = deckCardName(card(), null, null, false);
    expect(virtual).not.toContain("you own");
    expect(deckCardShort(card(), false)).toBe(false);
    // And the rest of the sentence is untouched — the card is still a card.
    expect(virtual).toContain("Lightning Bolt");
    expect(virtual).toContain("4 copies");
  });
});

describe("keepsSelection", () => {
  /** A leaf inside `wrapper`, which is what a click's target actually is — the glyph in a
   *  button, the truncated span in a row — so every case below asks the real question. */
  function leafIn(html: string): Element {
    const wrapper = document.createElement("div");
    wrapper.innerHTML = html;
    const leaf = wrapper.querySelector("[data-leaf]");
    return leaf ?? wrapper;
  }

  it("keeps the selection for a click anywhere on a card's body", () => {
    expect(
      keepsSelection(leafIn(`<li ${CARD_BODY_ATTR}><span data-leaf>MH2 · 123</span></li>`)),
    ).toBe(true);
  });

  /** The stack card's data line and the grid tile's control bar are both outside the card's
   *  button, which is the whole reason the body attribute exists — but the button itself is
   *  the commonest target of all and must never end a selection either. */
  it("keeps the selection for a click on any control", () => {
    for (const html of [
      `<button><span data-leaf>Add</span></button>`,
      `<div role="row"><span data-leaf>Sol Ring</span></div>`,
      `<label><input data-leaf /></label>`,
      `<select data-leaf></select>`,
      `<div role="dialog"><p data-leaf>Categories</p></div>`,
    ]) {
      expect(keepsSelection(leafIn(html)), html).toBe(true);
    }
  });

  /** The desk: the gap between two piles, a group's padding, the blank under a short column.
   *  This is the one gesture the app has for putting a card down. */
  it("drops the selection for a click on the desk", () => {
    expect(keepsSelection(leafIn(`<section><span data-leaf>Ramp</span></section>`))).toBe(false);
  });

  /** No element to ask about — a synthetic event, or a target that is not an `Element` — reads
   *  as the desk. It is the safe answer of the two: the worst it costs is a selection the
   *  reader has to make again, where the other way round is a mark that cannot be dismissed. */
  it("treats a click with no element as a click on nothing", () => {
    expect(keepsSelection(null)).toBe(false);
  });
});
