import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PlaytestPrompt } from "@/lib/ipc";
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
});
