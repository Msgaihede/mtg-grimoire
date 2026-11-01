import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PlaytestPrompt } from "@/lib/ipc";
import { DamagePanel } from "./DamagePanel";
import { damagePrompt } from "./fixtures";

function setup(prompt: PlaytestPrompt) {
  const onAct = vi.fn();
  const damage = prompt.damage!;
  render(
    <DamagePanel
      prompt={{ ...prompt, damage }}
      table={[]}
      disabled={false}
      onAct={onAct}
      onPoint={vi.fn()}
      onUnpoint={vi.fn()}
    />,
  );
  return { onAct, damage };
}

describe("DamagePanel", () => {
  it("lets the attacker choose which blocker dies (issue #1448)", () => {
    const { onAct, damage } = setup(damagePrompt().view.prompt!);
    const [ragavan, reckoner] = damage.blockers.map((b) => b.card);
    expect(screen.getByRole("heading", { name: "Assign combat damage" })).toBeInTheDocument();
    const confirm = screen.getByRole("button", { name: "Assign damage" });
    expect(confirm).toHaveAttribute("aria-disabled", "true");
    // Lethal to the Reckoner by a click: all three, Ragavan none.
    fireEvent.click(screen.getByRole("button", { name: `${reckoner.name}, 0 damage` }));
    expect(screen.getByText("3 of 3 assigned")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: `More damage to ${ragavan.name}` })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Assign damage" }));
    expect(onAct).toHaveBeenCalledWith({
      type: "assignDamage",
      blockers: [{ blocker: reckoner.id, amount: 3 }],
      excess: 0,
    });
  });

  it("steps one point at a time and confirms only the whole total", () => {
    const { onAct, damage } = setup(damagePrompt().view.prompt!);
    const [ragavan, reckoner] = damage.blockers.map((b) => b.card);
    fireEvent.click(screen.getByRole("button", { name: `More damage to ${ragavan.name}` }));
    fireEvent.click(screen.getByRole("button", { name: `More damage to ${reckoner.name}` }));
    fireEvent.click(screen.getByRole("button", { name: "Assign damage" }));
    expect(onAct).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: `More damage to ${reckoner.name}` }));
    fireEvent.click(screen.getByRole("button", { name: "Assign damage" }));
    expect(onAct).toHaveBeenCalledWith({
      type: "assignDamage",
      blockers: [
        { blocker: ragavan.id, amount: 1 },
        { blocker: reckoner.id, amount: 2 },
      ],
      excess: 0,
    });
  });

  it("tramples past the blockers once each has lethal", () => {
    const { onAct, damage } = setup(damagePrompt(true).view.prompt!);
    const [ragavan, reckoner] = damage.blockers.map((b) => b.card);
    const more = () => screen.getByRole("button", { name: "More damage to The opponent" });
    expect(more()).toBeDisabled();
    expect(screen.getByText("Assign lethal to every blocker first")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: `${ragavan.name}, 0 damage` }));
    fireEvent.click(screen.getByRole("button", { name: `${reckoner.name}, 0 damage` }));
    expect(screen.getByText("Past the blockers to The opponent")).toBeInTheDocument();
    fireEvent.click(more());
    fireEvent.click(screen.getByRole("button", { name: "Assign damage" }));
    expect(onAct).toHaveBeenCalledWith({
      type: "assignDamage",
      blockers: [
        { blocker: ragavan.id, amount: 1 },
        { blocker: reckoner.id, amount: 3 },
      ],
      excess: 1,
    });
  });

  it("still lets the engine choose, and offers its own split behind Other answers", () => {
    const { onAct } = setup(damagePrompt().view.prompt!);
    fireEvent.click(screen.getByRole("button", { name: "Let the engine choose" }));
    expect(onAct).toHaveBeenCalledWith({ type: "auto" });
    fireEvent.click(screen.getByRole("button", { name: "Other answers" }));
    expect(screen.getAllByRole("listitem").length).toBeGreaterThan(2);
  });
});
