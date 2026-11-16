import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** The one read, in front of an intact mirror — `RecentCardsWidget.test.tsx`'s note. */
const setCompletion = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ipc")>();
  return { ...actual, ipc: { ...actual.ipc, setCompletion } };
});

import type { HomeWidget, SetCompletion } from "@/lib/ipc";
import { useAppStore } from "@/lib/store";
import { footerLinePx, makeFit, type WidgetFit } from "../fit";
import { setCompletionKey } from "../keys";
import { chipLabel } from "../widgetSettings";
import {
  allComplete,
  CHOSEN_GONE,
  chosenSetCodes,
  countLabel,
  EMPTY,
  measureSet,
  NOTHING_CHOSEN,
  onlyExtras,
  percentLabel,
  rowHint,
  SetCompletionWidget,
  SetCompletionWidgetSettings,
  setsFooter,
  setsInScope,
  sortSets,
  UNSIZED_HINT,
} from "./SetCompletionWidget";

function set(over: Partial<SetCompletion> & { setCode: string; name: string }): SetCompletion {
  const owned = over.owned ?? 1;
  const size = over.size === undefined ? 100 : over.size;
  return {
    releasedAt: null,
    owned,
    size,
    ownedAll: owned,
    total: size ?? owned,
    setType: "expansion",
    changedAt: 0,
    ...over,
  };
}

const MH3 = set({
  setCode: "mh3",
  name: "Modern Horizons 3",
  owned: 248,
  size: 303,
  ownedAll: 260,
  total: 524,
  releasedAt: "2024-06-14",
  changedAt: 30,
});
const BLB = set({
  setCode: "blb",
  name: "Bloomburrow",
  owned: 191,
  size: 261,
  total: 397,
  releasedAt: "2024-08-02",
  changedAt: 20,
});
/** A set of the last few years: Scryfall publishes no printed size for it (issue #1692). */
const DSK = set({
  setCode: "dsk",
  name: "Duskmourn: House of Horror",
  owned: 3,
  size: null,
  ownedAll: 3,
  total: 417,
  releasedAt: "2024-09-27",
  changedAt: 50,
});
const TMP = set({
  setCode: "tmp",
  name: "Tempest",
  owned: 62,
  size: 350,
  releasedAt: "1997-10-14",
  changedAt: 10,
});
const TOKENS = set({
  setCode: "tdsk",
  name: "Duskmourn: House of Horror Tokens",
  owned: 2,
  size: null,
  total: 17,
  setType: "token",
  changedAt: 60,
});

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

function widget(config: unknown, fit: WidgetFit = fitFor(3, 6)): HomeWidget {
  return {
    id: "setCompletion",
    kind: "setCompletion",
    x: 0,
    y: 0,
    w: fit.w,
    h: fit.h,
    config,
  };
}

function draw(config: unknown = null, fit: WidgetFit = fitFor(3, 6), still = false) {
  return render(
    <SetCompletionWidget
      widget={widget(config, fit)}
      fit={fit}
      editing={false}
      still={still}
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
  // The store is module-level and leaks between tests; the press cases read what it was handed.
  useAppStore.setState(useAppStore.getInitialState(), true);
  useAppStore.setState({ activeView: "home" });
});

describe("measureSet", () => {
  it("measures against the printed run where the set has one", () => {
    expect(measureSet(MH3, "printed")).toMatchObject({ held: 248, of: 303, unsized: false });
  });

  // Issue #1692: no printed size is every set since early 2023, and it is measured whole.
  it("measures a set with no printed size against every printing it has, and says so", () => {
    expect(measureSet(DSK, "printed")).toMatchObject({ held: 3, of: 417, unsized: true });
  });

  it("measures every set whole under Every printing, variants included", () => {
    expect(measureSet(MH3, "all")).toMatchObject({ held: 260, of: 524, unsized: false });
    expect(measureSet(DSK, "all")).toMatchObject({ held: 3, of: 417, unsized: false });
  });

  it("never divides by less than what is held, nor by zero", () => {
    const odd = set({ setCode: "x", name: "X", owned: 0, size: 0, ownedAll: 4, total: 0 });
    expect(measureSet(odd, "printed")).toMatchObject({ held: 4, of: 4 });
  });
});

describe("sortSets", () => {
  const rows = [TMP, DSK, BLB, MH3].map((s) => measureSet(s, "printed"));
  const codes = (order: Parameters<typeof sortSets>[1]) =>
    sortSets(rows, order).map((s) => s.setCode);

  it("puts the set changed most recently first", () => {
    expect(codes("recent")).toEqual(["dsk", "mh3", "blb", "tmp"]);
  });

  it("orders by how complete, a set with no printed size measured like any other", () => {
    expect(codes("complete")).toEqual(["mh3", "blb", "tmp", "dsk"]);
  });

  it("orders by cards held, by the newest set, and alphabetically", () => {
    expect(codes("cards")).toEqual(["mh3", "blb", "tmp", "dsk"]);
    expect(codes("newest")).toEqual(["dsk", "blb", "mh3", "tmp"]);
    expect(codes("name")).toEqual(["blb", "dsk", "mh3", "tmp"]);
  });

  it("puts a set with no release date last when newest first", () => {
    const undated = measureSet(set({ setCode: "u", name: "Undated" }), "printed");
    const sorted = sortSets([undated, ...rows], "newest");
    expect(sorted[sorted.length - 1].setCode).toBe("u");
  });

  it("settles a tie by name and never sorts the cached array in place", () => {
    const a = measureSet(set({ setCode: "b", name: "Beta", owned: 5, size: 10 }), "printed");
    const b = measureSet(set({ setCode: "a", name: "Alpha", owned: 5, size: 10 }), "printed");
    const input = [a, b];
    expect(sortSets(input, "complete").map((s) => s.name)).toEqual(["Alpha", "Beta"]);
    expect(input).toEqual([a, b]);
  });
});

describe("the figures", () => {
  const at = (owned: number, size: number) =>
    measureSet(set({ setCode: "x", name: "X", owned, size }), "printed");

  it("floors a percentage so only a complete set reads 100", () => {
    expect(percentLabel(at(302, 303))).toBe("99%");
    expect(percentLabel(at(303, 303))).toBe("100%");
    expect(percentLabel(measureSet(MH3, "printed"))).toBe("81%");
  });

  it("says <1% for a set barely started, a new set included", () => {
    expect(percentLabel(at(1, 331))).toBe("<1%");
    expect(percentLabel(measureSet(DSK, "printed"))).toBe("<1%");
  });

  it("captions every set as a fraction of what it is measured against", () => {
    expect(countLabel(measureSet(MH3, "printed"))).toBe("248 of 303");
    expect(countLabel(measureSet(MH3, "all"))).toBe("260 of 524");
    expect(countLabel(measureSet(DSK, "printed"))).toBe("3 of 417");
  });

  it("counts the footer over every set in scope", () => {
    const rows = [MH3, set({ setCode: "d", name: "Done", owned: 10, size: 10 })].map((s) =>
      measureSet(s, "printed"),
    );
    expect(setsFooter(rows, 1)).toEqual({
      line: "1 of 2 sets · 1 complete",
      said: "Showing 1 of 2 sets. 1 complete.",
    });
    expect(setsFooter(rows.slice(0, 1), 0).line).toBe("0 of 1 set");
  });
});

describe("setsInScope", () => {
  const all = [MH3, TOKENS, DSK];

  it("leaves token and promo sets out unless asked for", () => {
    const codes = (extras: boolean) =>
      setsInScope(all, "all", [], extras, "printed").map((s) => s.setCode);
    expect(codes(false)).toEqual(["mh3", "dsk"]);
    expect(codes(true)).toEqual(["mh3", "tdsk", "dsk"]);
  });

  it("draws only the chosen sets, and a set the type switch hides stays hidden", () => {
    const codes = (extras: boolean) =>
      setsInScope(all, "chosen", ["dsk", "tdsk", "gone"], extras, "printed").map((s) => s.setCode);
    expect(codes(false)).toEqual(["dsk"]);
    expect(codes(true)).toEqual(["tdsk", "dsk"]);
  });

  it("reads the checklist's codes once each, and nothing that is not a code", () => {
    expect(chosenSetCodes(widget({ setCodes: ["dsk", "dsk", 3, "", "blb"] }))).toEqual([
      "dsk",
      "blb",
    ]);
    expect(chosenSetCodes(widget(null))).toEqual([]);
  });
});

describe("SetCompletionWidget", () => {
  it("says it is counting while the read is out", () => {
    setCompletion.mockImplementation(() => new Promise(() => {}));
    draw();
    expect(screen.getByText("Loading sets…")).toBeInTheDocument();
  });

  it("says where sets come from when there are none", async () => {
    draw();
    expect(await screen.findByText(EMPTY)).toBeInTheDocument();
  });

  it("says a refusal in the backend's words", async () => {
    setCompletion.mockRejectedValue("no such table");
    draw();
    expect(await screen.findByText("Couldn't load sets — no such table")).toBeInTheDocument();
  });

  it("is ordered by the set changed most recently unless the reader picked otherwise", () => {
    qc.setQueryData(setCompletionKey, [TMP, BLB, MH3, DSK]);
    draw();
    expect(drawnNames()).toEqual([
      "Duskmourn: House of Horror",
      "Modern Horizons 3",
      "Bloomburrow",
      "Tempest",
    ]);
    expect(chipLabel(widget(null))).toBe("Recently changed");
  });

  it("draws the reader's order with a caption, a figure and a track", () => {
    qc.setQueryData(setCompletionKey, [TMP, BLB, MH3]);
    draw({ sort: "name" });

    expect(drawnNames()).toEqual(["Bloomburrow", "Modern Horizons 3", "Tempest"]);
    const row = screen.getByText("Modern Horizons 3").closest("li") as HTMLElement;
    expect(within(row).getByText("248 of 303")).toBeInTheDocument();
    expect(within(row).getByText("81%")).toBeInTheDocument();
    expect(row.querySelector(".bg-accent")).toHaveStyle({ width: "81%" });
  });

  /**
   * **The issue's regression** (#1692): a set with no printed size used to draw an em dash, no
   * track, and sort below every row the card had room for. It is measured whole now, draws a
   * figure and a track like any other, and its hint says what it is measured against.
   */
  it("draws a figure and a track for a set with no printed size, and says why", () => {
    qc.setQueryData(setCompletionKey, [DSK]);
    draw();

    const row = screen.getByText("Duskmourn: House of Horror").closest("li") as HTMLElement;
    expect(within(row).getByText("3 of 417")).toBeInTheDocument();
    expect(within(row).getByText("<1%")).toBeInTheDocument();
    expect(row.querySelector(".bg-accent")).not.toBeNull();
    expect(within(row).queryByText("—")).toBeNull();
    expect(rowHint(measureSet(DSK, "printed"))).toBe(UNSIZED_HINT);
  });

  it("measures every set whole under Every printing, with no hint", () => {
    qc.setQueryData(setCompletionKey, [MH3, DSK]);
    draw({ measure: "all" });

    const mh3 = screen.getByText("Modern Horizons 3").closest("li") as HTMLElement;
    expect(within(mh3).getByText("260 of 524")).toBeInTheDocument();
    expect(within(mh3).getByText("49%")).toBeInTheDocument();
    expect(rowHint(measureSet(DSK, "all"))).toBeUndefined();
    expect(rowHint(measureSet(MH3, "printed"))).toBeUndefined();
  });

  it("drops the tracks when the reader switched bars off", () => {
    qc.setQueryData(setCompletionKey, [MH3]);
    const { container } = draw({ bars: false });
    expect(container.querySelector(".bg-accent")).toBeNull();
  });

  it("leaves token and promo sets off the card until they are asked for", () => {
    qc.setQueryData(setCompletionKey, [TOKENS, MH3]);
    const { unmount } = draw();
    expect(drawnNames()).toEqual(["Modern Horizons 3"]);
    unmount();

    draw({ extras: true });
    expect(drawnNames()).toEqual(["Duskmourn: House of Horror Tokens", "Modern Horizons 3"]);
  });

  it("names the switch when every set held is a token or promo set", () => {
    qc.setQueryData(setCompletionKey, [TOKENS]);
    draw();
    expect(screen.getByText(onlyExtras())).toBeInTheDocument();
    expect(onlyExtras()).toContain("Token & promo sets");
  });

  it("hides complete sets when asked, and says so when that is all of them", () => {
    const done = set({ setCode: "d", name: "Done", owned: 10, size: 10 });
    qc.setQueryData(setCompletionKey, [done, MH3]);
    const { unmount } = draw({ complete: false });
    expect(drawnNames()).toEqual(["Modern Horizons 3"]);
    unmount();

    qc.setQueryData(setCompletionKey, [done]);
    draw({ complete: false });
    expect(screen.getByText(allComplete())).toBeInTheDocument();
  });

  describe("Chosen…", () => {
    it("asks for a choice when none is made", () => {
      qc.setQueryData(setCompletionKey, [MH3]);
      draw({ scope: "chosen" });
      expect(screen.getByText(NOTHING_CHOSEN)).toBeInTheDocument();
    });

    it("draws only the chosen sets", () => {
      qc.setQueryData(setCompletionKey, [TMP, BLB, MH3, DSK]);
      draw({ scope: "chosen", setCodes: ["blb", "dsk"] });
      expect(drawnNames()).toEqual(["Duskmourn: House of Horror", "Bloomburrow"]);
    });

    it("says so when no chosen set has a card in the collection", () => {
      qc.setQueryData(setCompletionKey, [MH3]);
      draw({ scope: "chosen", setCodes: ["lea"] });
      expect(screen.getByText(CHOSEN_GONE)).toBeInTheDocument();
    });
  });

  it("opens a set's cards on the Search page when its row is pressed", async () => {
    const user = userEvent.setup();
    qc.setQueryData(setCompletionKey, [BLB]);
    draw();

    const press = screen.getByRole("button", { name: /^Bloomburrow/ });
    expect(press).toHaveAccessibleName("Bloomburrow · 191 of 261 · 73%");
    await user.click(press);

    expect(useAppStore.getState().activeView).toBe("search");
    expect(useAppStore.getState().pendingSearchSet).toBe("blb");
  });

  it("opens nothing from a catalogue preview", () => {
    qc.setQueryData(setCompletionKey, [BLB]);
    draw(null, fitFor(3, 6), true);
    expect(screen.queryByRole("button", { name: /^Bloomburrow/ })).toBeNull();
  });

  // Whole rows only: a 3×2 card has room for so many 57px rows, less the footer saying how many
  // more there are.
  it("cuts the list to the rows the box holds, and says how many sets there are", () => {
    const fit = fitFor(3, 2);
    qc.setQueryData(
      setCompletionKey,
      Array.from({ length: 20 }, (_, i) => set({ setCode: `s${i}`, name: `Set ${i}` })),
    );
    draw(null, fit);
    const shown = fit.rowsFit(57, footerLinePx(fit));
    expect(screen.getAllByRole("listitem")).toHaveLength(shown);
    expect(screen.getByText(`${shown} of 20 sets`)).toBeInTheDocument();
  });

  it("draws no footer when every set in scope is on the card", () => {
    qc.setQueryData(setCompletionKey, [MH3]);
    draw();
    expect(screen.queryByText(/of 1 set/)).toBeNull();
  });

  it("drops the caption on a compact card and keeps the figure", () => {
    qc.setQueryData(setCompletionKey, [MH3]);
    draw(null, fitFor(3, 3, "compact"));
    expect(screen.queryByText("248 of 303")).not.toBeInTheDocument();
    expect(screen.getByText("81%")).toBeInTheDocument();
  });

  // At two cells the figure moves under the name — for a new set too, which has one now.
  it("moves the figure under the name on a two-cell tile", () => {
    qc.setQueryData(setCompletionKey, [MH3, DSK]);
    draw(null, fitFor(2, 3));
    const mh3 = screen.getByText("Modern Horizons 3").closest("li") as HTMLElement;
    expect(within(mh3).getByText("81%").className).toContain("text-text");
    expect(within(mh3).queryByText("248 of 303")).not.toBeInTheDocument();
    const dsk = screen.getByText("Duskmourn: House of Horror").closest("li") as HTMLElement;
    expect(within(dsk).getByText("<1%")).toBeInTheDocument();
  });
});

describe("SetCompletionWidgetSettings", () => {
  function settings(config: unknown) {
    const onConfig = vi.fn();
    qc.setQueryData(setCompletionKey, [TMP, TOKENS, MH3, DSK]);
    render(<SetCompletionWidgetSettings widget={widget(config)} onConfig={onConfig} />, {
      wrapper,
    });
    return onConfig;
  }

  async function offered(user: ReturnType<typeof userEvent.setup>): Promise<string[]> {
    await user.click(screen.getByRole("button", { name: "Sets to track" }));
    return screen.getAllByRole("option").map((el) => el.textContent ?? "");
  }

  it("points at the scope row instead of drawing a picker that would do nothing", () => {
    settings(null);
    expect(screen.queryByRole("button", { name: "Sets to track" })).toBeNull();
    expect(screen.getByText("Set Which sets to Chosen… to pick sets.")).toBeInTheDocument();
  });

  it("offers every set the card can draw, alphabetically", async () => {
    const user = userEvent.setup();
    settings({ scope: "chosen" });
    expect(await offered(user)).toEqual([
      expect.stringContaining("Duskmourn: House of Horror"),
      expect.stringContaining("Modern Horizons 3"),
      expect.stringContaining("Tempest"),
    ]);
  });

  it("offers the token and promo sets once the switch brings them in", async () => {
    const user = userEvent.setup();
    settings({ scope: "chosen", extras: true });
    expect(await offered(user)).toContainEqual(
      expect.stringContaining("Duskmourn: House of Horror Tokens"),
    );
  });

  /** A choice the switch hides is carried through, not dropped, and the scope is written beside. */
  it("keeps a choice it does not offer, and writes the scope beside the codes", async () => {
    const user = userEvent.setup();
    const onConfig = settings({ scope: "chosen", setCodes: ["tdsk", "mh3"] });

    expect(screen.getByRole("button", { name: "Sets to track" })).toHaveTextContent("1 set");
    await user.click(screen.getByRole("button", { name: "Sets to track" }));
    await user.click(screen.getByRole("option", { name: /^Tempest/ }));

    expect(onConfig).toHaveBeenCalledWith({ setCodes: ["tdsk", "mh3", "tmp"], scope: "chosen" });
  });
});
