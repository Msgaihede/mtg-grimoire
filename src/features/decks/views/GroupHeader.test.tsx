import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { CategoryKind } from "@/lib/ipc";
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
    cards: [],
    count: 0,
    totalPriceUsd: null,
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
    render(<GroupHeader group={group({ kind, isActive })} />);
    expect(markers()).toEqual(expected);
  });

  /** Both, and both true of it: a reader who switches the Sideboard off has a pile the rules
   *  still name and that still counts toward nothing. */
  it("marks a switched-off Sideboard with both", () => {
    render(<GroupHeader group={group({ kind: "side", isActive: false })} />);
    expect(markers()).toEqual(["RULE", "INACTIVE"]);
  });

  /** A derived heading — "Mana value 3" — is neither a rules role nor a switch. Nothing can
   *  be dropped into it and nothing can be turned off about it. */
  it("marks a derived group with neither", () => {
    render(<GroupHeader group={group({ kind: null, categoryId: null, name: "Mana value 3" })} />);
    expect(markers()).toEqual([]);
  });

  it("says what each marker means, rather than leaving two words to be guessed at", () => {
    render(<GroupHeader group={group({ kind: "commander", isActive: false })} />);
    expect(screen.getByText("RULE").getAttribute("title")).toContain("rules read this pile");
    expect(screen.getByText("INACTIVE").getAttribute("title")).toContain("Switched off");
  });
});
