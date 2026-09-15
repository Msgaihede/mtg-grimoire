import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** The one read, in front of an intact mirror — `RecentCardsWidget.test.tsx`'s note. */
const setCompletion = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ipc")>();
  return { ...actual, ipc: { ...actual.ipc, setCompletion } };
});

import type { HomeWidget, SetCompletion } from "@/lib/ipc";
import { makeFit, type WidgetFit } from "../fit";
import { setCompletionKey } from "../keys";
import {
  countLabel,
  EMPTY,
  percentLabel,
  SetCompletionWidget,
  sortSets,
} from "./SetCompletionWidget";

function set(over: Partial<SetCompletion> & { setCode: string; name: string }): SetCompletion {
  return { releasedAt: null, owned: 1, size: 100, ...over };
}

const MH3 = set({ setCode: "mh3", name: "Modern Horizons 3", owned: 248, size: 303 });
const BLB = set({ setCode: "blb", name: "Bloomburrow", owned: 191, size: 261 });
const LEA = set({ setCode: "lea", name: "Limited Edition Alpha", owned: 300, size: null });
const TMP = set({ setCode: "tmp", name: "Tempest", owned: 62, size: 350 });

function fitFor(
  w: number,
  h: number,
  density: "comfortable" | "compact" = "comfortable",
): WidgetFit {
  return makeFit({
    w,
    h,
    widthPx: w * 104 + (w - 1) * 12,
    heightPx: h * 104 + (h - 1) * 12,
    density,
  });
}

let qc: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

function draw(config: unknown = null, fit: WidgetFit = fitFor(3, 6)) {
  const widget: HomeWidget = {
    id: "setCompletion",
    kind: "setCompletion",
    x: 0,
    y: 0,
    w: fit.w,
    h: fit.h,
    config,
  };
  return render(
    <SetCompletionWidget
      widget={widget}
      fit={fit}
      editing={false}
      still={false}
      onConfig={vi.fn()}
    />,
    { wrapper },
  );
}

/** The set names in drawn order — the one assertion that sees both which rows and what order. */
function drawnNames(): string[] {
  return within(screen.getByRole("list", { name: "Sets" }))
    .getAllByRole("listitem")
    .map((row) => row.querySelector(".font-medium")?.textContent ?? "");
}

beforeEach(() => {
  setCompletion.mockReset().mockResolvedValue([]);
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
});

describe("sortSets", () => {
  // A set nobody can measure is not the set a reader is closest to finishing, so it sinks.
  it("orders by how complete, with unmeasurable sets last", () => {
    expect(sortSets([TMP, LEA, BLB, MH3], "complete").map((s) => s.setCode)).toEqual([
      "mh3",
      "blb",
      "tmp",
      "lea",
    ]);
  });

  it("orders by cards held, and alphabetically", () => {
    expect(sortSets([TMP, LEA, BLB, MH3], "cards").map((s) => s.setCode)).toEqual([
      "lea",
      "mh3",
      "blb",
      "tmp",
    ]);
    expect(sortSets([TMP, LEA, BLB, MH3], "name").map((s) => s.setCode)).toEqual([
      "blb",
      "lea",
      "mh3",
      "tmp",
    ]);
  });

  it("settles a tie by name and never sorts the cached array in place", () => {
    const a = set({ setCode: "b", name: "Beta", owned: 5, size: 10 });
    const b = set({ setCode: "a", name: "Alpha", owned: 5, size: 10 });
    const input = [a, b];
    expect(sortSets(input, "complete").map((s) => s.name)).toEqual(["Alpha", "Beta"]);
    expect(input).toEqual([a, b]);
  });
});

describe("the figures", () => {
  it("floors a percentage so only a complete set reads 100", () => {
    expect(percentLabel(set({ setCode: "x", name: "X", owned: 302, size: 303 }))).toBe("99%");
    expect(percentLabel(set({ setCode: "x", name: "X", owned: 303, size: 303 }))).toBe("100%");
    expect(percentLabel(MH3)).toBe("81%");
  });

  it("says <1% for a set barely started and an em dash for one with no size", () => {
    expect(percentLabel(set({ setCode: "x", name: "X", owned: 1, size: 331 }))).toBe("<1%");
    expect(percentLabel(LEA)).toBe("—");
  });

  it("captions a measurable set as a fraction and an unmeasurable one as a count", () => {
    expect(countLabel(MH3)).toBe("248 of 303");
    expect(countLabel(LEA)).toBe("300 cards");
    expect(countLabel(set({ setCode: "x", name: "X", owned: 1, size: null }))).toBe("1 card");
  });
});

describe("SetCompletionWidget", () => {
  it("says it is counting while the read is out", () => {
    setCompletion.mockImplementation(() => new Promise(() => {}));
    draw();
    expect(screen.getByText("Counting your sets…")).toBeInTheDocument();
  });

  it("says where sets come from when there are none", async () => {
    draw();
    expect(await screen.findByText(EMPTY)).toBeInTheDocument();
  });

  it("says a refusal in the backend's words", async () => {
    setCompletion.mockRejectedValue("no such table");
    draw();
    expect(
      await screen.findByText("Could not count your sets — no such table"),
    ).toBeInTheDocument();
  });

  it("draws the reader's order with a caption, a figure and a track", () => {
    qc.setQueryData(setCompletionKey, [TMP, LEA, BLB, MH3]);
    draw({ sort: "name" });

    expect(drawnNames()).toEqual([
      "Bloomburrow",
      "Limited Edition Alpha",
      "Modern Horizons 3",
      "Tempest",
    ]);
    const row = screen.getByText("Modern Horizons 3").closest("li") as HTMLElement;
    expect(within(row).getByText("248 of 303")).toBeInTheDocument();
    expect(within(row).getByText("81%")).toBeInTheDocument();
    expect(row.querySelector(".bg-accent")).toHaveStyle({ width: "81%" });
    // No track for the set nobody can measure — a bar at 0 would be a claim.
    const alpha = screen.getByText("Limited Edition Alpha").closest("li") as HTMLElement;
    expect(alpha.querySelector(".bg-accent")).toBeNull();
    expect(within(alpha).getByText("—")).toBeInTheDocument();
  });

  it("drops the tracks when the reader switched bars off", () => {
    qc.setQueryData(setCompletionKey, [MH3]);
    const { container } = draw({ bars: false });
    expect(container.querySelector(".bg-accent")).toBeNull();
  });

  // Whole rows only: a 3×2 card has room for so many 57px rows and draws no more.
  it("cuts the list to the rows the box holds", () => {
    const fit = fitFor(3, 2);
    qc.setQueryData(
      setCompletionKey,
      Array.from({ length: 20 }, (_, i) => set({ setCode: `s${i}`, name: `Set ${i}` })),
    );
    draw(null, fit);
    expect(screen.getAllByRole("listitem")).toHaveLength(fit.rowsFit(57));
  });

  it("drops the caption on a compact card and keeps the figure", () => {
    qc.setQueryData(setCompletionKey, [MH3]);
    draw(null, fitFor(3, 3, "compact"));
    expect(screen.queryByText("248 of 303")).not.toBeInTheDocument();
    expect(screen.getByText("81%")).toBeInTheDocument();
  });

  // At two cells the figure moves under the name — and a set with no figure keeps its count.
  it("moves the figure under the name on a two-cell tile", () => {
    qc.setQueryData(setCompletionKey, [MH3, LEA]);
    draw(null, fitFor(2, 3));
    const mh3 = screen.getByText("Modern Horizons 3").closest("li") as HTMLElement;
    expect(within(mh3).getByText("81%").className).toContain("text-text");
    expect(within(mh3).queryByText("248 of 303")).not.toBeInTheDocument();
    const lea = screen.getByText("Limited Edition Alpha").closest("li") as HTMLElement;
    expect(within(lea).getByText("300 cards")).toBeInTheDocument();
  });
});
