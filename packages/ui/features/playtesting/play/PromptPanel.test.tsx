import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PlaytestPrompt } from "@/lib/ipc";
import { castChoicePrompt, targetPrompt } from "./fixtures";
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

  it("offers only the engine's choice for a question it cannot draw", () => {
    setup({ kind: "ChooseRingBearer", source: null, options: [], cancellable: false });
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
