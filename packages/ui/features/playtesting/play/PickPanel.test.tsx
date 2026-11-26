import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PlaytestPick, PlaytestPrompt } from "@/lib/ipc";
import { castPick, discardPick, scryPick } from "./fixtures";
import { PickPanel } from "./PickPanel";

function setup(prompt: PlaytestPrompt) {
  const onAct = vi.fn();
  const pick = prompt.pick!;
  render(
    <PickPanel
      prompt={{ ...prompt, pick }}
      table={[]}
      disabled={false}
      onAct={onAct}
      onPoint={vi.fn()}
      onUnpoint={vi.fn()}
    />,
  );
  return { onAct, pick };
}

/** A question answered by a set of four library cards, of `over`'s purpose. */
function libraryPick(over: Partial<PlaytestPick>): PlaytestPrompt {
  const cards = ["Opt", "Island", "Brainstorm", "Ponder"].map((name, i) => ({
    id: 10 + i,
    name,
    cardId: null,
    text: null,
    cause: null,
  }));
  return {
    kind: "DigRestSplitChoice",
    source: "Telling Time",
    sourceText: null,
    cause: null,
    options: [],
    cancellable: false,
    keyword: null,
    damage: null,
    shown: [],
    distribute: null,
    nameEntry: false,
    counters: null,
    triggers: null,
    results: null,
    pick: {
      purpose: "order",
      cards,
      eligible: cards.map((c) => c.id),
      min: cards.length,
      max: cards.length,
      ordered: true,
      powerCap: null,
      powerMin: null,
      contributions: [],
      zone: "libraryTop",
      split: null,
      ...over,
    },
  };
}

const labels = (region: HTMLElement) =>
  within(region)
    .queryAllByRole("button")
    .map((el) => el.getAttribute("aria-label"));

describe("PickPanel", () => {
  it("sorts a scry into Keep on top and Bottom, in the order picked", () => {
    const { onAct, pick } = setup(scryPick().view.prompt!);
    const [a, b, c] = pick.cards;
    expect(screen.getByRole("heading", { name: "Scry 3" })).toBeInTheDocument();
    const bottom = () => screen.getByRole("region", { name: "Bottom" });
    const top = () => screen.getByRole("region", { name: "Keep on top" });
    expect(within(bottom()).getAllByRole("button")).toHaveLength(3);
    fireEvent.click(within(bottom()).getByRole("button", { name: c.name }));
    fireEvent.click(within(bottom()).getByRole("button", { name: a.name }));
    expect(
      within(top())
        .getAllByRole("button")
        .map((el) => el.getAttribute("aria-label")),
    ).toEqual([`${c.name}, 1`, `${a.name}, 2`]);
    expect(screen.getByText("2 of up to 3")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onAct).toHaveBeenCalledWith({ type: "pickCards", ids: [c.id, a.id] });
    expect(b.id).not.toBe(a.id);
  });

  it("discards exactly the count asked, never an ineligible card", () => {
    const { onAct, pick } = setup(discardPick().view.prompt!);
    const land = pick.cards.find((c) => !pick.eligible.includes(c.id))!;
    const [first, second] = pick.cards.filter((c) => pick.eligible.includes(c.id));
    expect(screen.getByRole("heading", { name: "Discard 2" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: `${land.name}, cannot be picked` }));
    fireEvent.click(screen.getByRole("button", { name: first.name }));
    const confirm = screen.getByRole("button", { name: "Discard 1" });
    expect(confirm).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(confirm);
    expect(onAct).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: second.name }));
    fireEvent.click(screen.getByRole("button", { name: "Discard 2" }));
    expect(onAct).toHaveBeenCalledWith({ type: "pickCards", ids: [first.id, second.id] });
  });

  it("stops at the max, and still lets the engine choose", () => {
    const { onAct, pick } = setup(discardPick().view.prompt!);
    const eligible = pick.cards.filter((c) => pick.eligible.includes(c.id));
    for (const c of eligible) fireEvent.click(screen.getByRole("button", { name: c.name }));
    expect(screen.getByText("2 of 2")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Let the engine choose" }));
    expect(onAct).toHaveBeenCalledWith({ type: "auto" });
  });

  it("asks whether to cast from the graveyard before it shows the cards (issue #1329)", () => {
    const { onAct, pick } = setup(castPick().view.prompt!);
    const [bolt] = pick.cards;
    expect(
      screen.getByRole("heading", { name: "Cast a spell from your graveyard?" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: bolt.name })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Choose a card" }));
    expect(onAct).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "Choose up to 1 to cast" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: bolt.name }));
    fireEvent.click(screen.getByRole("button", { name: "Cast it" }));
    expect(onAct).toHaveBeenCalledWith({ type: "pickCards", ids: [bolt.id] });
  });

  it("declines an optional cast without showing the cards", () => {
    const { onAct } = setup(castPick().view.prompt!);
    fireEvent.click(screen.getByRole("button", { name: "Don’t cast" }));
    expect(onAct).toHaveBeenCalledWith({ type: "pickCards", ids: [] });
  });

  it("puts cards on the bottom in the order picked, every one of them", () => {
    const { onAct } = setup(libraryPick({}));
    expect(screen.getByRole("heading", { name: "Put on the bottom in order" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Ponder" }));
    fireEvent.click(screen.getByRole("button", { name: "Opt" }));
    expect(screen.getByRole("button", { name: "Ponder, 1" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Opt, 2" })).toBeInTheDocument();
    const done = screen.getByRole("button", { name: "Done" });
    expect(done).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(screen.getByRole("button", { name: "Island" }));
    fireEvent.click(screen.getByRole("button", { name: "Brainstorm" }));
    fireEvent.click(done);
    expect(onAct).toHaveBeenCalledWith({ type: "pickCards", ids: [13, 10, 11, 12] });
  });

  it("shows which picked cards go on top and which on the bottom (Telling Time)", () => {
    const { onAct } = setup(libraryPick({ split: 1 }));
    expect(
      screen.getByRole("heading", { name: "Put 1 on top and the rest on the bottom" }),
    ).toBeInTheDocument();
    const top = () => screen.getByRole("region", { name: "On top" });
    const bottom = () => screen.getByRole("region", { name: "On the bottom" });
    const place = () => screen.getByRole("region", { name: "To place" });
    expect(labels(place())).toHaveLength(4);
    expect(within(bottom()).getByText(/Once 1 is on top/)).toBeInTheDocument();
    fireEvent.click(within(place()).getByRole("button", { name: "Brainstorm" }));
    fireEvent.click(within(place()).getByRole("button", { name: "Opt" }));
    fireEvent.click(within(place()).getByRole("button", { name: "Ponder" }));
    expect(labels(top())).toEqual(["Brainstorm, top 1"]);
    expect(labels(bottom())).toEqual(["Opt, bottom 1", "Ponder, bottom 2"]);
    expect(labels(place())).toEqual(["Island"]);
    fireEvent.click(within(place()).getByRole("button", { name: "Island" }));
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onAct).toHaveBeenCalledWith({ type: "pickCards", ids: [12, 10, 13, 11] });
  });

  it("pays a cost with the cards picked", () => {
    const { onAct } = setup(libraryPick({ purpose: "pay", min: 2, max: 2, ordered: false }));
    expect(screen.getByRole("heading", { name: "Choose 2 to pay the cost" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Opt" }));
    fireEvent.click(screen.getByRole("button", { name: "Island" }));
    fireEvent.click(screen.getByRole("button", { name: "Pay" }));
    expect(onAct).toHaveBeenCalledWith({ type: "pickCards", ids: [10, 11] });
  });

  it("separates the cards into two piles, the picked ones pile A", () => {
    const { onAct } = setup(libraryPick({ purpose: "pile", min: 0, max: 4, ordered: false }));
    expect(
      screen.getByRole("heading", { name: "Separate into two piles: picked cards are pile A" }),
    ).toBeInTheDocument();
    const a = () => screen.getByRole("region", { name: "Pile A" });
    const b = () => screen.getByRole("region", { name: "Pile B" });
    expect(within(a()).getByText("Click a card to put it in pile A.")).toBeInTheDocument();
    fireEvent.click(within(b()).getByRole("button", { name: "Ponder" }));
    expect(labels(a())).toEqual(["Ponder"]);
    expect(labels(b())).toEqual(["Opt", "Island", "Brainstorm"]);
    fireEvent.click(screen.getByRole("button", { name: "Make piles" }));
    expect(onAct).toHaveBeenCalledWith({ type: "pickCards", ids: [13] });
  });
});
