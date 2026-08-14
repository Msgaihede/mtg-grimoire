import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { CategoryKind } from "@/lib/ipc";
import { MARKETPLACES } from "@/lib/marketplace";
import { pricesAsOf } from "@/lib/prices";
import type { CardGroup } from "../grouping";
import { GroupHeader } from "./GroupHeader";

function group(over: Partial<CardGroup> = {}): CardGroup {
  return {
    key: "cat-1",
    name: "Ramp",
    kind: "main",
    categoryId: 1,
    isActive: true,
    isPredefined: false,
    // `isAuto` decides whether an *empty* pile is drawn at all (`drawsWhenEmpty`) and nothing
    // about how a drawn one looks: there is no third marker for it, and there should not be —
    // who made the pile is not a fact about the cards under it. It is `false` here for the same
    // reason `isPredefined` is: the fixture is a pile the reader made.
    isAuto: false,
    cards: [],
    count: 0,
    totalPrice: null,
    ...over,
  };
}

const markers = () => ["RULE", "INACTIVE"].filter((label) => screen.queryByText(label) !== null);

/**
 * The two markers answer **different questions** and a pile can carry both. `RULE` is about
 * the ruleset; `INACTIVE` is about the switch. The wrong reading — "RULE means predefined and
 * undeletable" — is plausible, would put the marker on the Maybeboard, and is what this suite
 * exists to catch.
 */
describe("GroupHeader markers", () => {
  it.each<[CategoryKind, boolean, string[]]>([
    // The three piles a format has an opinion about.
    ["commander", true, ["RULE"]],
    ["side", true, ["RULE"]],
    ["companion", true, ["RULE"]],
    // A category the reader made is theirs, whatever they called it.
    ["main", true, []],
    // The Maybeboard is not a rules role. It is a pile seeded with its switch off, and
    // `SIZE_KINDS` counts an *active* one exactly like a `main` pile — so `INACTIVE` is the
    // whole of what is true about it, and `RULE` beside it would claim a role the format has
    // never heard of.
    ["maybe", false, ["INACTIVE"]],
  ])("marks a %s pile as %s → %s", (kind, isActive, expected) => {
    render(<GroupHeader group={group({ kind, isActive })} marketplace={MARKETPLACES.tcgplayer} />);
    expect(markers()).toEqual(expected);
  });

  /** Both, and both true of it: a reader who switches the Sideboard off has a pile the rules
   *  still name and that still counts toward nothing. */
  it("marks a switched-off Sideboard with both", () => {
    render(
      <GroupHeader
        group={group({ kind: "side", isActive: false })}
        marketplace={MARKETPLACES.tcgplayer}
      />,
    );
    expect(markers()).toEqual(["RULE", "INACTIVE"]);
  });

  /** A derived heading — "Mana value 3" — is neither a rules role nor a switch. Nothing can
   *  be dropped into it and nothing can be turned off about it. */
  it("marks a derived group with neither", () => {
    render(
      <GroupHeader
        group={group({ kind: null, categoryId: null, name: "Mana value 3" })}
        marketplace={MARKETPLACES.tcgplayer}
      />,
    );
    expect(markers()).toEqual([]);
  });

  it("says what each marker means, rather than leaving two words to be guessed at", () => {
    render(
      <GroupHeader
        group={group({ kind: "commander", isActive: false })}
        marketplace={MARKETPLACES.tcgplayer}
      />,
    );
    expect(screen.getByText("RULE").getAttribute("title")).toContain("rules read this pile");
    expect(screen.getByText("INACTIVE").getAttribute("title")).toContain("Switched off");
  });
});

/**
 * The heading's other half: the pile's total, in the marketplace the reader picked.
 *
 * This is the one component all four deck views draw their headings with, so it is the single
 * place a currency mistake would reach every one of them at once.
 */
describe("GroupHeader price", () => {
  it("draws the total in the selected marketplace's currency", () => {
    const { rerender } = render(
      <GroupHeader group={group({ totalPrice: 4.97 })} marketplace={MARKETPLACES.tcgplayer} />,
    );
    expect(screen.getByText("$4.97")).toBeInTheDocument();

    rerender(
      <GroupHeader group={group({ totalPrice: 4.97 })} marketplace={MARKETPLACES.cardmarket} />,
    );
    expect(screen.getByText("€4.97")).toBeInTheDocument();
    expect(screen.queryByText("$4.97")).not.toBeInTheDocument();
  });

  /** Spec §5, with the marketplace's name in it: five in the picker means "as of the last
   *  sync" alone would leave the reader guessing whose prices these are. */
  it("names the marketplace in the as-of sentence", () => {
    render(<GroupHeader group={group({ totalPrice: 1 })} marketplace={MARKETPLACES.cardmarket} />);
    expect(screen.getByText("€1.00")).toHaveAttribute("title", pricesAsOf(MARKETPLACES.cardmarket));
  });

  /** A pile nothing in it is priced quotes no number at all — `€0.00` is a price nobody
   *  offered, and on Cardmarket an etched pile is exactly this case. */
  it("is an em dash for a pile with no price in this currency", () => {
    render(
      <GroupHeader group={group({ totalPrice: null })} marketplace={MARKETPLACES.cardmarket} />,
    );
    expect(screen.getByText("—")).toBeInTheDocument();
  });
});
