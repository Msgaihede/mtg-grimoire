import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { DeckCard } from "@/lib/ipc";
import { LAYER } from "@/lib/layers";
import {
  CardStack,
  STACK_ADVANCE,
  STACK_CARD_HEIGHT,
  STACK_CARD_WIDTH,
  STACK_COLLAPSED_MARGIN,
  STACK_IMAGE_HEIGHT,
  STACK_LIFTED_MARGIN,
  stackHeight,
} from "./CardStack";
import { card } from "./validation/fixtures";
import type { ValidationIssue } from "./validation/types";

/** Sol Ring is the only card here the collection cannot cover, so the shortage is legible in
 *  one place and its absence is legible everywhere else. */
const CARDS: DeckCard[] = [
  card({ name: "Sol Ring", quantity: 2, ownedQuantity: 1, unitPriceUsd: 1.99, rarity: "uncommon" }),
  card({ name: "Arcane Signet", ownedQuantity: 1, unitPriceUsd: 0.99, colorIdentity: null }),
  card({
    name: "The Great Henge",
    ownedQuantity: 1,
    unitPriceUsd: 38.5,
    colorIdentity: "G",
    gameChanger: true,
  }),
];

/** The names those three cards answer to, once every mark is folded into them. */
const SOL_RING = "Sol Ring, 2 copies, you own 1 of 2";
const SIGNET = "Arcane Signet";
const HENGE = "The Great Henge, game changer";

const list = () => screen.getByRole("list", { name: "Ramp" });
const items = () => screen.getAllByRole("listitem");

describe("CardStack geometry", () => {
  /**
   * The numbers have to agree or the trick does not work: a card advances the stack by exactly
   * one reveal strip, and the list is the collapsed stack plus one lift's worth of slack.
   * Written out here because the component spells two of them as Tailwind literals, which no
   * arithmetic can reach.
   *
   * **A card's height is now derived rather than chosen** — it is a Magic card's aspect applied
   * to the width `StackView`'s fixed 14rem column leaves, since the card *is* a whole card image
   * now. So this checks the derivation as well as the sums: get the width or the ratio wrong and
   * every number below moves together, which is exactly the failure a single asserted constant
   * would hide.
   */
  it("advances by one reveal strip per card and leaves one lift of slack", () => {
    // 210px of image at 488×680, rounded, plus the card's own 1px border top and bottom.
    expect(STACK_CARD_WIDTH).toBe(210);
    expect(STACK_IMAGE_HEIGHT).toBe(Math.round((STACK_CARD_WIDTH * 680) / 488));
    expect(STACK_IMAGE_HEIGHT).toBe(293);
    expect(STACK_CARD_HEIGHT).toBe(STACK_IMAGE_HEIGHT + 2);

    expect(STACK_CARD_HEIGHT + STACK_COLLAPSED_MARGIN).toBe(STACK_ADVANCE);
    expect(STACK_ADVANCE).toBe(34);
    expect(STACK_COLLAPSED_MARGIN).toBe(-261);
    expect(STACK_LIFTED_MARGIN).toBe(8);

    // The canvas's own formula, `34 * cards.length + 269`.
    for (const n of [1, 2, 5, 17]) expect(stackHeight(n)).toBe(34 * n + 269);
    // The last card's bottom edge, with the slack under it.
    expect(stackHeight(5) - (STACK_ADVANCE * 4 + STACK_CARD_HEIGHT)).toBe(STACK_LIFTED_MARGIN);
  });

  it("draws no box for a group with nothing in it", () => {
    expect(stackHeight(0)).toBe(0);
    const { container } = render(<CardStack cards={[]} label="Ramp" />);
    expect(container).toBeEmptyDOMElement();
  });

  /**
   * The two spellings of one number. The component writes the collapsed margin as
   * `mb-[-278px]` and the lift as `mb-2`, because Tailwind scans source text for whole class
   * names and a class assembled from a constant emits no rule at all — so this is what keeps
   * the literals and the arithmetic from drifting apart.
   */
  it("a stacked card is pulled up by exactly one card's advance", () => {
    render(<CardStack cards={CARDS} label="Ramp" />);

    for (const item of items()) {
      expect(item.className).toContain(`mb-[${STACK_COLLAPSED_MARGIN}px]`);
      // `mb-2` is 0.5rem, and the app's root font size is the browser's 16px.
      expect(item.className).toContain("hover:mb-2");
      expect(STACK_LIFTED_MARGIN).toBe(8);
    }
  });
});

describe("CardStack does not reflow", () => {
  /**
   * **The rule the whole component exists for.** The list's height is a function of the card
   * count and nothing else, so lifting a card cannot resize the group — the header above it
   * does not move, and neither does any group under it in the column.
   *
   * The mechanism is that there is *no hover state in JavaScript to depend on*: the lift is
   * `hover:`/`focus-within:` in CSS, which jsdom does not apply. So this test drives the two
   * gestures that would set such a state if one existed and reads the height back. It fails
   * the day someone reaches for `useState` here, which is the only way this can regress.
   *
   * What it cannot see is the paint. That is the live pass's, and the numbers it would
   * measure are pinned by the geometry suite above.
   */
  it("hovering_a_card_does_not_change_the_group_height", async () => {
    const user = userEvent.setup();
    render(<CardStack cards={CARDS} label="Ramp" onSelect={vi.fn()} />);

    const before = list().style.height;
    expect(before).toBe(`${stackHeight(CARDS.length)}px`);

    // The first card, which every card after it would be pushed down by; then the last,
    // which nothing follows.
    for (const name of [SOL_RING, HENGE]) {
      await user.hover(screen.getByRole("button", { name }));
      expect(list().style.height).toBe(before);
      await user.unhover(screen.getByRole("button", { name }));
      expect(list().style.height).toBe(before);
    }

    // And the caret, which does the same thing the pointer does.
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: SOL_RING }));
    expect(list().style.height).toBe(before);
  });

  /**
   * **And the controls cannot change it either**, which is the claim worth making twice.
   *
   * A stepper and a move select were added to every card after this component was built, and
   * the obvious place to put them — in the card, under the data line — would have made
   * {@link STACK_CARD_HEIGHT} a lie and every number above it with it. They are drawn *over*
   * the card instead, absolutely positioned, so they take no height at all: the same card is
   * still 312px whether it can be edited or not, and `stackHeight` never learns that actions
   * exist.
   *
   * This is the test that fails the day somebody puts them in the flow. It is deliberately not
   * "the classes contain `absolute`" — it is the height, measured both ways, which is the thing
   * that actually has to hold.
   */
  it("keeps its height when its cards carry controls", () => {
    const actions = { setQuantity: vi.fn(), move: vi.fn(), moveTargets: [], drop: vi.fn() };
    const { unmount } = render(<CardStack cards={CARDS} label="Ramp" />);
    const plain = list().style.height;
    unmount();

    render(<CardStack cards={CARDS} label="Ramp" actions={actions} />);

    expect(list().style.height).toBe(plain);
    expect(list().style.height).toBe(`${stackHeight(CARDS.length)}px`);
    // …and the controls really are there, so this is not passing by drawing nothing.
    expect(screen.getByRole("button", { name: "Decrease Copies of Sol Ring in Main deck" }));
  });

  /**
   * The other half of the same idea, and neither works alone: the height is what stops the
   * group resizing, and `overflow: visible` is what lets the lifted card — and the cards it
   * pushes down — leave the box instead of being clipped inside it.
   */
  it("lets a lifted card leave the box rather than clipping it", () => {
    render(<CardStack cards={CARDS} label="Ramp" />);
    expect(list().className).toContain("overflow-visible");
  });

  /** The lift travels up as well as out: the card comes forward over the cards before it,
   *  and the stack comes forward over the groups below it in the column. */
  it("lifts the card and its stack out of the paint order, for the pointer and the caret", () => {
    render(<CardStack cards={CARDS} label="Ramp" />);

    for (const element of [list(), ...items()]) {
      expect(element.className).toContain(LAYER.raisedOnHover);
      expect(element.className).toContain(LAYER.raisedOnFocus);
    }
  });

  /** WCAG 2.3.3, and the app's own rule: every transition has an opt-out. Probed as the
   *  *property*, never the duration — `transition-none` leaves the duration alone. */
  it("stands still for a reader who asked for less motion", () => {
    render(<CardStack cards={CARDS} label="Ramp" />);
    for (const item of items()) {
      expect(item.className).toContain("transition-[margin-bottom]");
      expect(item.className).toContain("motion-reduce:transition-none");
    }
  });
});

describe("CardStack cards", () => {
  it("reaches every card with the keyboard, in the order they are stacked", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<CardStack cards={CARDS} label="Ramp" onSelect={onSelect} />);

    await user.tab();
    expect(screen.getByRole("button", { name: SOL_RING })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: SIGNET })).toHaveFocus();
    await user.keyboard("{Enter}");

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0].name).toBe("Arcane Signet");
  });

  /**
   * **The focus outline is drawn inside the card's own edge**, and it has to be: the button
   * fills an `overflow-hidden` `<li>`, so an outline standing 2px *off* it is painted
   * entirely in the clipped region and is never seen. A positive offset here is not a
   * smaller ring — it is no focus indicator at all, WCAG 2.4.7, and invisible to anyone
   * testing with a mouse. `VirtualTable`'s rows already document the same trap.
   */
  it("keeps the focus outline inside the box that clips it", () => {
    render(<CardStack cards={CARDS} label="Ramp" />);

    for (const button of screen.getAllByRole("button")) {
      expect(button.className).toContain("focus-visible:-outline-offset-2");
      expect(button.className).not.toContain("focus-visible:outline-offset-2");
    }
  });

  it("draws the copies, the rarity, the printing and its own price over the card", () => {
    render(<CardStack cards={CARDS} label="Ramp" />);

    // The copies badge — 2 of the Sol Ring, and nothing else on screen is a bare "2".
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByText("$1.99")).toBeInTheDocument();
    expect(screen.getAllByText("LEA · 161")).toHaveLength(3);
    // `RarityGem` names the rarity even where it only draws a dot ("Rarity: uncommon").
    expect(screen.getAllByText(/uncommon/)).not.toHaveLength(0);
  });

  /**
   * **The name and the mana cost are on the picture now, and that is the change.**
   *
   * The card used to be three app-drawn bands with the name in text and the cost as `mana-font`
   * pills; it is one whole `grid` image, so both are printed where every player already reads
   * them. What must not go with them is the *accessible* name — a card whose only name is inside a
   * decorative `<img alt="">` is a card a screen reader cannot tell from any other, so
   * `deckCardName` carries it on the button and this is the test that says so.
   */
  it("leaves the name and cost to the printed card, but not the accessible name", () => {
    render(<CardStack cards={CARDS} label="Ramp" />);

    expect(screen.queryByText("Sol Ring")).not.toBeInTheDocument();
    expect(document.querySelectorAll("i.ms-cost")).toHaveLength(0);

    // The picture is the card, and it is decoration: the button beside it does the talking.
    const art = document.querySelectorAll("img");
    expect(art).toHaveLength(CARDS.length);
    for (const image of art) expect(image).toHaveAttribute("alt", "");
    expect(screen.getByRole("button", { name: SOL_RING })).toBeInTheDocument();
  });

  /**
   * …and where the picture cannot be drawn, the name comes back in text.
   *
   * An orphan is the case that reaches it without a network: its printing has left `cards`, so
   * nothing is fetched at all, and a tile reading only "No card" would be the one place in the app
   * that shows a deck card without saying which card it is.
   */
  it("writes the name in the fallback when there is no picture to draw", () => {
    render(
      <CardStack
        cards={[card({ name: "Gone Card", needsReview: "This printing has left the database." })]}
        label="Ramp"
      />,
    );

    expect(screen.getByText("Gone Card")).toBeInTheDocument();
    expect(screen.getByText("No card")).toBeInTheDocument();
    expect(document.querySelectorAll("img")).toHaveLength(0);
  });

  /**
   * The shortage is drawn as a red figure and **said in the button's name**, which is the
   * only text inside an `aria-label`-ed button that anybody hears. An `sr-only` span here
   * would be announced to nobody — which is how a keyboard reader came to get no word of the
   * one number on this card that is about them.
   */
  it("says how many copies are missing, in the figure and in the name", () => {
    render(<CardStack cards={CARDS} label="Ramp" />);

    expect(screen.getByText("1/2")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: SOL_RING })).toBeInTheDocument();
    expect(SOL_RING).toContain("you own 1 of 2");
    // The two fully covered rows print nothing and say nothing.
    expect(screen.queryByText("1/1")).not.toBeInTheDocument();
    expect(SIGNET).not.toContain("you own");
  });

  /** The allocator claims no copy for an inactive category, so every card in one reads 0
   *  owned by construction — a shortage there is one the reader does not have. */
  it("never calls an inactive category short of copies", () => {
    render(
      <CardStack
        cards={[card({ name: "Avacyn", quantity: 3, ownedQuantity: 0, categoryActive: false })]}
        label="Maybeboard"
      />,
    );

    expect(screen.queryByText("0/3")).not.toBeInTheDocument();
  });

  it("shows a tag as a dot with its name behind it", () => {
    render(
      <CardStack
        cards={[
          card({
            name: "Sol Ring",
            ownedQuantity: 1,
            tagId: 1,
            tagName: "Wincon",
            tagColor: "moss",
          }),
        ]}
        label="Ramp"
      />,
    );

    // A `title` for the pointer; the word itself in the button's name, which is the only
    // place a reader inside a labelled button hears anything.
    expect(screen.getByTitle("Wincon")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByRole("button", { name: "Sol Ring, Wincon" })).toBeInTheDocument();
  });

  /**
   * Every mark on a card is decoration and says so, which is `FoilOverlay`'s rule for
   * `FoilOverlay`'s reason: an `aria-label` replaces its element's content, so an `sr-only`
   * span inside one of these buttons is announced to nobody and only looks accessible.
   */
  it("marks every badge as decoration, and says all of it in the name instead", () => {
    render(
      <CardStack
        cards={[
          card({
            name: "Mana Crypt",
            quantity: 2,
            ownedQuantity: 0,
            gameChanger: true,
            tagId: 1,
            tagName: "Fast mana",
            tagColor: "ember",
          }),
        ]}
        label="Ramp"
        violations={
          new Map([
            [
              "c-Mana Crypt",
              [
                {
                  severity: "error" as const,
                  code: "banned",
                  message: "Mana Crypt is banned in Commander.",
                  cardIds: ["c-Mana Crypt"],
                },
              ],
            ],
          ])
        }
      />,
    );

    for (const label of ["GC", "RULE BREAK", "0/2"]) {
      expect(screen.getByText(label)).toHaveAttribute("aria-hidden", "true");
    }
    expect(screen.getByTitle("Fast mana")).toHaveAttribute("aria-hidden", "true");

    expect(
      screen.getByRole("button", {
        name: "Mana Crypt, 2 copies, you own 0 of 2, Fast mana, game changer, rule break: Mana Crypt is banned in Commander.",
      }),
    ).toBeInTheDocument();
  });
});

describe("CardStack marks", () => {
  const banned: ValidationIssue = {
    severity: "error",
    code: "banned",
    message: "Mana Crypt is banned in Commander.",
    cardIds: ["c-Mana Crypt"],
  };

  const withIssue = () =>
    render(
      <CardStack
        cards={[
          card({ name: "Mana Crypt", gameChanger: true }),
          card({ name: "Sol Ring", gameChanger: true }),
        ]}
        label="Ramp"
        violations={new Map([["c-Mana Crypt", [banned]]])}
      />,
    );

  /**
   * The spec's own requirement: a rule break and a game changer must not be confusable,
   * because one is a problem and the other is a fact about a powerful card. Four things
   * separate them and this pins all four — the words, the colour, the place, and the card's
   * own edge, which only a rule break changes.
   */
  it("tells a rule break and a game changer apart four ways", () => {
    withIssue();
    const [first, second] = screen.getAllByRole("listitem");
    const mark = screen.getByText("RULE BREAK");

    // The words, and the whole sentence behind them — in the mark's `title` for the pointer
    // and in the card's own name for everyone else.
    expect(mark).toBeInTheDocument();
    expect(mark).toHaveAttribute("title", "Mana Crypt is banned in Commander.");
    expect(
      screen.getByRole("button", {
        name: /rule break: Mana Crypt is banned in Commander\./,
      }),
    ).toBeInTheDocument();
    expect(screen.getAllByText("GC")).toHaveLength(2);

    // The colour: destructive for the break, the pie gold for the badge.
    expect(mark.className).toContain("text-destructive");
    expect(screen.getAllByText("GC")[0].className).toContain("text-pie-gold");

    // The place: the break is over the art, the badge is in the title bar.
    expect(mark.className).toContain("absolute");

    // The edge: only the card that breaks a rule gets one.
    expect(first.className).toContain("border-destructive");
    expect(second.className).toContain("border-border");
    expect(second.className).not.toContain("border-destructive");
  });

  /** A warning is a fact worth a look, not a rule the reader broke — `ruleBreak`'s rule,
   *  seen from the surface that draws it. */
  it("draws no rule break for a warning", () => {
    render(
      <CardStack
        cards={[card({ name: "Sword of the Meek" })]}
        label="Ramp"
        violations={
          new Map([
            [
              "c-Sword of the Meek",
              [
                {
                  severity: "warning" as const,
                  code: "orphan",
                  message: "This printing is not in the card database.",
                },
              ],
            ],
          ])
        }
      />,
    );

    expect(screen.queryByText("RULE BREAK")).not.toBeInTheDocument();
    expect(screen.getAllByRole("listitem")[0].className).not.toContain("border-destructive");
  });
});
