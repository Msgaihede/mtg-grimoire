import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { SetSummary } from "@/lib/ipc";
import { SetGrid } from "./SetGrid";

const SETS: SetSummary[] = [
  { code: "hob", name: "The Hobbit", setType: "expansion", releasedAt: "2026-10-01", cardCount: 1 },
  { code: "fdn", name: "Foundations", setType: "core", releasedAt: "2024-11-15", cardCount: 1 },
];

describe("SetGrid", () => {
  it("draws a tile per set and hands the pressed one back", async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    render(<SetGrid sets={SETS} onPick={onPick} picked="fdn" />);
    const wall = screen.getByRole("list", { name: "Sets" });
    expect(within(wall).getAllByRole("button")).toHaveLength(2);
    expect(screen.getByRole("button", { name: /Foundations/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await user.click(screen.getByRole("button", { name: /The Hobbit/ }));
    expect(onPick).toHaveBeenCalledWith(SETS[0]);
  });

  it("filters by name or code, and says when nothing matches", async () => {
    const user = userEvent.setup();
    render(<SetGrid sets={SETS} onPick={() => {}} />);
    const box = screen.getByRole("searchbox", { name: "Filter sets by name or code" });
    await user.type(box, "fdn");
    expect(screen.getAllByRole("button")).toHaveLength(1);
    await user.clear(box);
    await user.type(box, "hobb");
    expect(screen.getByRole("button", { name: /The Hobbit/ })).toBeInTheDocument();
    await user.type(box, "zzz");
    expect(screen.getByText("No set matches “hobbzzz”.")).toBeInTheDocument();
  });
});
