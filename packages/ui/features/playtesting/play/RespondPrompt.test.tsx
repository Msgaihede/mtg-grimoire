import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PlaytestStackItem, PlaytestView } from "@/lib/ipc";
import { respondStep, withStack } from "./fixtures";
import { RespondPrompt, respondingTo, targetWords } from "./RespondPrompt";

/** The respond step with its top item replaced: Ragavan's ability, aimed at Tarmogoyf and the
 *  reader, set off by Ragavan's attack. */
function abilityStep(): { view: PlaytestView; item: PlaytestStackItem } {
  const t = respondStep();
  const item: PlaytestStackItem = {
    ...t.view.stack[0],
    id: 9001,
    name: t.ragavan.name,
    cardId: t.ragavan.cardId,
    ability: true,
    text: "Create a Treasure token.",
    cause: { event: "attacks", id: t.ragavan.id, name: t.ragavan.name, player: null },
    targets: [t.goyf.id],
    targetPlayers: ["you"],
  };
  return { view: { ...t.view, stack: [item] }, item };
}

function setup(view: PlaytestView, item: PlaytestStackItem, disabled = false) {
  const onAct = vi.fn();
  const onPoint = vi.fn();
  render(
    <RespondPrompt
      item={item}
      view={view}
      disabled={disabled}
      onAct={onAct}
      onPoint={onPoint}
      onUnpoint={vi.fn()}
    />,
  );
  return { onAct, onPoint };
}

describe("respondingTo", () => {
  it("is the opponent's item on top of the stack while the reader may respond", () => {
    const { view } = respondStep();
    expect(respondingTo(view)?.name).toBe("Lightning Bolt");
  });

  it("is nothing at another stage, with the stack empty, or with the reader's own spell on top", () => {
    const { view } = respondStep();
    expect(respondingTo(null)).toBeNull();
    expect(respondingTo({ ...view, stage: "main" })).toBeNull();
    expect(respondingTo({ ...view, stack: [] })).toBeNull();
    expect(respondingTo({ ...withStack().view, stage: "respond" })).toBeNull();
  });
});

describe("targetWords", () => {
  it("names the cards, then the players, as a sentence's end", () => {
    const { view, item } = abilityStep();
    expect(targetWords(item, view)).toBe("Tarmogoyf and you");
    expect(targetWords({ ...item, targetPlayers: [] }, view)).toBe("Tarmogoyf");
    expect(targetWords({ ...item, targets: [], targetPlayers: [] }, view)).toBeNull();
  });
});

describe("RespondPrompt", () => {
  it("asks about the opponent's spell, says what it targets, and lets it resolve", () => {
    const { view } = respondStep();
    const { onAct } = setup(view, view.stack[0]);
    expect(screen.getByRole("heading", { name: "Respond to Lightning Bolt?" })).toBeInTheDocument();
    expect(screen.getByText("The opponent cast")).toBeInTheDocument();
    expect(screen.getByText("you")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Let it resolve/ }));
    expect(onAct).toHaveBeenCalledWith({ type: "pass" });
  });

  it("says an ability's words and what set it off", () => {
    const { view, item } = abilityStep();
    setup(view, item);
    expect(screen.getByText("The opponent's ability")).toBeInTheDocument();
    expect(screen.getByText("Create a Treasure token.")).toBeInTheDocument();
    expect(screen.getByText(/for Ragavan, Nimble Pilferer/)).toBeInTheDocument();
    expect(screen.getByText("Tarmogoyf and you")).toBeInTheDocument();
  });

  it("points at its card for the preview", () => {
    const { view } = respondStep();
    const { onPoint } = setup(view, view.stack[0]);
    fireEvent.mouseEnter(document.querySelector(`[data-point="${view.stack[0].id}"]`)!);
    expect(onPoint).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Lightning Bolt" }),
      view.stack[0],
      expect.anything(),
    );
  });

  it("sends nothing while an action is with the engine", () => {
    const { view } = respondStep();
    setup(view, view.stack[0], true);
    expect(screen.getByRole("button", { name: /Let it resolve/ })).toBeDisabled();
  });
});
