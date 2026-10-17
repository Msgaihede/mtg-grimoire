import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PlaytestPrompt } from "@/lib/ipc";
import { castChoicePrompt, orderTriggersPrompt, targetPrompt } from "./fixtures";
import { PromptPanel } from "./PromptPanel";

function setup(prompt: PlaytestPrompt, disabled = false) {
  const onAct = vi.fn();
  const onPoint = vi.fn();
  render(
    <PromptPanel
      prompt={prompt}
      table={[]}
      disabled={disabled}
      onAct={onAct}
      onPoint={onPoint}
      onUnpoint={vi.fn()}
    />,
  );
  return { onAct, onPoint };
}

describe("PromptPanel", () => {
  it("titles the question, names its source and sends the answer picked", () => {
    const prompt = targetPrompt().view.prompt!;
    const { onAct } = setup(prompt);
    expect(screen.getByRole("heading", { name: "Choose a target" })).toBeInTheDocument();
    expect(screen.getByText("Swords to Plowshares")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Boros Reckoner/ }));
    expect(onAct).toHaveBeenCalledWith({ type: "choose", index: 1 });
  });

  it("points at a row's card while it is hovered", () => {
    const { onPoint } = setup(targetPrompt().view.prompt!);
    fireEvent.mouseEnter(screen.getByRole("button", { name: /Ragavan/ }));
    expect(onPoint).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Ragavan, Nimble Pilferer" }),
      expect.anything(),
    );
  });

  it("lets the engine choose, and cancels a cast of the reader's", () => {
    const { onAct } = setup(castChoicePrompt().view.prompt!);
    expect(screen.getByRole("button", { name: /Stomp/ })).toHaveTextContent("Cast adventure");
    fireEvent.click(screen.getByRole("button", { name: "Let the engine choose" }));
    expect(onAct).toHaveBeenLastCalledWith({ type: "auto" });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onAct).toHaveBeenLastCalledWith({ type: "cancel" });
  });

  it("says what an order of triggers decides, and each answer's order with its pictures", () => {
    const prompt = orderTriggersPrompt().view.prompt!;
    const { onAct } = setup(prompt);
    expect(screen.getByRole("heading", { name: "Put your triggers in order" })).toBeInTheDocument();
    expect(screen.getByText("Pick which one resolves first")).toBeInTheDocument();
    // Two Delvers' upkeep triggers read alike either way round: one answer, not two the same
    // (issue #1076).
    const answers = screen.getAllByRole("button", { name: /resolves first/ });
    expect(answers).toHaveLength(1);
    expect(answers[0]).toHaveTextContent("then Delver of Secrets");
    expect(answers[0].getAttribute("title")).toMatch(/^1\. Delver of Secrets.*: At the beginning/);
    // A picture per trigger, numbered in the order they resolve.
    expect(within(answers[0]).getByText("1")).toBeInTheDocument();
    expect(within(answers[0]).getByText("2")).toBeInTheDocument();
    fireEvent.click(answers[0]);
    expect(onAct).toHaveBeenCalledWith({ type: "choose", index: 0 });
  });

  it("says which trigger a target is for: what set it off, and its words in the tooltip", () => {
    const text = "Whenever another creature enters, it deals 1 damage to any target.";
    setup({
      ...targetPrompt().view.prompt!,
      kind: "TriggerTargetSelection",
      source: "Impact Tremors",
      sourceText: text,
      cause: { event: "ZoneChanged", id: 70, name: "Grizzly Bears", player: "you" },
      cancellable: false,
    });
    const line = screen.getByText("Impact Tremors for Grizzly Bears");
    expect(line.getAttribute("title")).toBe(`Impact Tremors: ${text} (for Grizzly Bears)`);
  });

  it("offers only the engine's choice for a question it cannot draw", () => {
    setup({
      kind: "ChooseRingBearer",
      source: null,
      sourceText: null,
      cause: null,
      options: [],
      cancellable: false,
      pick: null,
    });
    expect(screen.getByRole("heading", { name: "Choose ring bearer" })).toBeInTheDocument();
    expect(screen.getByText(/can’t show this choice/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });

  it("sends nothing while the engine is busy", () => {
    const { onAct } = setup(targetPrompt().view.prompt!, true);
    fireEvent.click(screen.getByRole("button", { name: /Ragavan/ }));
    expect(onAct).not.toHaveBeenCalled();
  });
});
