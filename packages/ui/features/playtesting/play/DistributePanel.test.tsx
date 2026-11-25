import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PlaytestDistribute } from "@/lib/ipc";
import { DistributePanel } from "./DistributePanel";

const bears = { id: 7, name: "Grizzly Bears", cardId: null, text: null, cause: null };

function setup(distribute: PlaytestDistribute, disabled = false) {
  const onAct = vi.fn();
  const onPoint = vi.fn();
  render(
    <DistributePanel
      distribute={distribute}
      table={[]}
      disabled={disabled}
      onAct={onAct}
      onPoint={onPoint}
      onUnpoint={vi.fn()}
    />,
  );
  return { onAct, onPoint };
}

const fireball: PlaytestDistribute = {
  total: 4,
  unit: "Damage",
  targets: [
    { card: bears, player: null, min: 1 },
    { card: null, player: "opponent", min: 1 },
  ],
};

describe("DistributePanel", () => {
  it("divides the whole amount, each target at least its least, and sends it", () => {
    const { onAct } = setup(fireball);
    expect(screen.getByRole("region", { name: "Divide 4 damage" })).toBeInTheDocument();
    const item = (label: string) => screen.getByLabelText(`Damage to ${label}`).closest("li");
    expect(item("Grizzly Bears")).toHaveTextContent("Grizzly Bears");
    expect(item("the opponent")).toHaveTextContent("The opponent");
    expect(screen.getByLabelText("Damage to Grizzly Bears")).toHaveTextContent("1");
    expect(screen.getByRole("button", { name: "Less damage to Grizzly Bears" })).toBeDisabled();
    expect(screen.getByText("2 of 4 left")).toBeInTheDocument();
    const divide = screen.getByRole("button", { name: "Divide" });
    fireEvent.click(divide);
    expect(onAct).not.toHaveBeenCalled();
    expect(divide).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(screen.getByRole("button", { name: "More damage to Grizzly Bears" }));
    fireEvent.click(screen.getByRole("button", { name: "More damage to the opponent" }));
    expect(screen.getByText("All 4 divided")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "More damage to the opponent" })).toBeDisabled();
    fireEvent.click(divide);
    expect(onAct).toHaveBeenCalledWith({
      type: "distribute",
      shares: [
        { id: 7, player: null, amount: 2 },
        { id: null, player: "opponent", amount: 2 },
      ],
    });
  });

  it("clears back to each target's least, and says counters as counters", () => {
    setup({ ...fireball, unit: "Counters" });
    fireEvent.click(screen.getByRole("button", { name: "More counters to Grizzly Bears" }));
    expect(screen.getByLabelText("Counters to Grizzly Bears")).toHaveTextContent("2");
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(screen.getByLabelText("Counters to Grizzly Bears")).toHaveTextContent("1");
  });

  it("points at a card target while it is hovered", () => {
    const { onPoint } = setup(fireball);
    fireEvent.mouseEnter(screen.getByLabelText("Damage to Grizzly Bears").closest("li")!);
    expect(onPoint).toHaveBeenCalledWith(
      expect.objectContaining({ id: 7, name: "Grizzly Bears" }),
      expect.anything(),
    );
  });

  it("sends nothing while the engine is busy", () => {
    const { onAct } = setup({ ...fireball, total: 2 }, true);
    fireEvent.click(screen.getByRole("button", { name: "Divide" }));
    expect(onAct).not.toHaveBeenCalled();
  });
});
