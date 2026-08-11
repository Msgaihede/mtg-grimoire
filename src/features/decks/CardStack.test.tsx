import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { DeckCard } from "@/lib/ipc";
import { LAYER } from "@/lib/layers";
import {
  CardStack,
  STACK_ADVANCE,
  STACK_CARD_HEIGHT,
  STACK_COLLAPSED_MARGIN,
  STACK_LIFTED_MARGIN,
  stackHeight,
} from "./CardStack";
import { card } from "./validation/fixtures";
import type { ValidationIssue } from "./validation/types";

const CARDS: DeckCard[] = [
  card({ name: "Sol Ring", quantity: 2, ownedQuantity: 1, unitPriceUsd: 1.99, rarity: "uncommon" }),
  card({ name: "Arcane Signet", unitPriceUsd: 0.99, colorIdentity: null }),
  card({ name: "The Great Henge", unitPriceUsd: 38.5, colorIdentity: "G", gameChanger: true }),
];

const list = () => screen.getByRole("list", { name: "Ramp" });
const items = () => screen.getAllByRole("listitem");

describe("CardStack geometry", () => {
  /**
   * The four numbers have to agree or the trick does not work: a card advances the stack by
   * exactly its title bar, and the list is the collapsed stack plus one lift's worth of
   * slack. Written out here because the component spells two of them as Tailwind literals,
   * which no arithmetic can reach.
   */
  it("advances by one title bar per card and leaves one lift of slack", () => {
    expect(STACK_CARD_HEIGHT + STACK_COLLAPSED_MARGIN).toBe(STACK_ADVANCE);
    expect(STACK_ADVANCE).toBe(34);
    expect(STACK_COLLAPSED_MARGIN).toBe(-278);
    expect(STACK_LIFTED_MARGIN).toBe(8);

    // The canvas's own formula, `34 * cards.length + 286`.
    for (const n of [1, 2, 5, 17]) expect(stackHeight(n)).toBe(34 * n + 286);
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
    for (const name of ["Sol Ring, 2 copies", "The Great Henge, game changer"]) {
      await user.hover(screen.getByRole("button", { name }));
      expect(list().style.height).toBe(before);
      await user.unhover(screen.getByRole("button", { name }));
      expect(list().style.height).toBe(before);
    }

    // And the caret, which does the same thing the pointer does.
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Sol Ring, 2 copies" }));
    expect(list().style.height).toBe(before);
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
    expect(screen.getByRole("button", { name: "Sol Ring, 2 copies" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Arcane Signet" })).toHaveFocus();
    await user.keyboard("{Enter}");

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0].name).toBe("Arcane Signet");
  });

  it("draws the copies, the name, the cost, the rarity, the printing and its own price", () => {
    render(<CardStack cards={CARDS} label="Ramp" />);

    expect(screen.getByText("Sol Ring")).toBeInTheDocument();
    // The copies badge — 2 of the Sol Ring, and nothing else on screen is a bare "2".
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByText("$1.99")).toBeInTheDocument();
    expect(screen.getAllByText("LEA · 161")).toHaveLength(3);
    // `RarityGem` names the rarity even where it only draws a dot ("Rarity: uncommon").
    expect(screen.getAllByText(/uncommon/)).not.toHaveLength(0);
    // The printed cost, through `ManaText` — real `mana-font` pills, never `{R}` typed out.
    expect(document.querySelectorAll("i.ms-cost").length).toBeGreaterThan(0);
  });

  it("says how many copies are missing, and only when some are", () => {
    render(<CardStack cards={CARDS} label="Ramp" />);

    expect(screen.getByText("You own 1 of 2")).toBeInTheDocument();
    expect(screen.getByText("1/2")).toBeInTheDocument();
    // Two of the three rows are fully covered and print nothing.
    expect(screen.queryByText("1/1")).not.toBeInTheDocument();
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
        cards={[card({ name: "Sol Ring", tagId: 1, tagName: "Wincon", tagColor: "moss" })]}
        label="Ramp"
      />,
    );

    expect(screen.getByText("Tagged Wincon")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sol Ring, Wincon" })).toBeInTheDocument();
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

    // The words, and the whole sentence behind them.
    expect(screen.getByText("RULE BREAK")).toBeInTheDocument();
    expect(screen.getByText("Rule break: Mana Crypt is banned in Commander.")).toBeInTheDocument();
    expect(screen.getAllByText("GC")).toHaveLength(2);

    // The colour: destructive for the break, the pie gold for the badge.
    expect(screen.getByText("RULE BREAK").parentElement?.className).toContain("text-destructive");
    expect(screen.getAllByText("GC")[0].parentElement?.className).toContain("text-pie-gold");

    // The place: the break is over the art, the badge is in the title bar.
    expect(screen.getByText("RULE BREAK").parentElement?.className).toContain("absolute");

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
