import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { BoosterSetSummary } from "@/lib/ipc";
import { byYear, SetGrid } from "./SetGrid";

const SETS: BoosterSetSummary[] = [
  { code: "hob", name: "The Hobbit", releaseDate: "2026-10-01" },
  { code: "fdn", name: "Foundations", releaseDate: "2024-11-15" },
];

describe("byYear", () => {
  it("cuts the list into runs of one release year, in the order given", () => {
    const sets: BoosterSetSummary[] = [
      { code: "tla", name: "Avatar", releaseDate: "2025-11-21" },
      { code: "eoe", name: "Edge of Eternities", releaseDate: "2025-08-01" },
      { code: "fdn", name: "Foundations", releaseDate: "2024-11-15" },
      { code: "xxx", name: "Undated", releaseDate: null },
    ];
    expect(byYear(sets).map((r) => [r.year, r.sets.map((s) => s.code)])).toEqual([
      ["2025", ["tla", "eoe"]],
      ["2024", ["fdn"]],
      [null, ["xxx"]],
    ]);
  });

  it("never reorders: a year that comes back starts a run of its own", () => {
    const sets: BoosterSetSummary[] = [
      { code: "a", name: "A", releaseDate: "2025-01-01" },
      { code: "b", name: "B", releaseDate: "2024-01-01" },
      { code: "c", name: "C", releaseDate: "2025-06-01" },
    ];
    expect(byYear(sets).map((r) => r.year)).toEqual(["2025", "2024", "2025"]);
    expect(byYear([])).toEqual([]);
  });
});

describe("SetGrid", () => {
  it("divides the wall by release year, each year a list named by it", () => {
    const sets: BoosterSetSummary[] = [
      { code: "hob", name: "The Hobbit", releaseDate: "2026-10-01" },
      { code: "eoe", name: "Edge of Eternities", releaseDate: "2026-08-01" },
      ...SETS.slice(1),
    ];
    render(<SetGrid sets={sets} onPick={() => {}} />);
    const y2026 = screen.getByRole("list", { name: "2026" });
    expect(within(y2026).getAllByRole("button")).toHaveLength(2);
    const y2024 = screen.getByRole("list", { name: "2024" });
    expect(within(y2024).getByRole("button", { name: /Foundations/ })).toBeInTheDocument();
  });

  it("drops a year's divider when the filter leaves none of its sets", async () => {
    const user = userEvent.setup();
    render(<SetGrid sets={SETS} onPick={() => {}} />);
    await user.type(screen.getByRole("searchbox"), "hob");
    expect(screen.getByRole("list", { name: "2026" })).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "2024" })).not.toBeInTheDocument();
    expect(screen.queryByText("2024")).not.toBeInTheDocument();
  });

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
