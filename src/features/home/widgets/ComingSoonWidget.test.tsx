import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { HomeWidget, UpcomingSet, UpcomingSets } from "@/lib/ipc";

/** The one read, typed, in front of an intact mirror. Cases with data seed `upcomingSetsKey`. */
const upcomingSets = vi.hoisted(() => vi.fn<(days: number) => Promise<UpcomingSets>>());
vi.mock("@/lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ipc")>();
  return { ...actual, ipc: { ...actual.ipc, upcomingSets } };
});

import { useAppStore } from "@/lib/store";
import { CELL_MIN, makeFit, spanPx, type WidgetFit } from "../fit";
import { upcomingSetsKey } from "../keys";
import {
  ComingSoonWidget,
  daysUntil,
  emptySentence,
  setCaption,
  shortCaption,
  whenLabel,
  windowWords,
} from "./ComingSoonWidget";

/** The UTC date the read used. Every expectation is counted from this, never from the clock. */
const TODAY = "2026-09-26";

function upcoming(over: Partial<UpcomingSet> & { code: string; name: string; releasedAt: string }): UpcomingSet {
  return { previewed: 10, inDecks: 0, ...over };
}

/** Soonest first, the order the read answers in. Constructed — no real set is being described. */
const GLASS = upcoming({ code: "gls", name: "Glass Tides", releasedAt: "2026-09-27", previewed: 12 });
const TREK = upcoming({
  code: "trk",
  name: "Horizon Trek",
  releasedAt: "2026-10-08",
  previewed: 79,
  inDecks: 3,
});
const ASH = upcoming({
  code: "ash",
  name: "Echoes of Ash",
  releasedAt: "2026-12-04",
  previewed: 5,
  inDecks: 1,
});

const ANSWER: UpcomingSets = { today: TODAY, sets: [GLASS, TREK, ASH] };

/** More sets than any box below holds, so a cut shows whichever reservation it was cut under. */
const MANY: UpcomingSets = {
  today: TODAY,
  sets: [
    GLASS,
    TREK,
    ASH,
    ...[1, 2, 3, 4, 5, 6].map((day) =>
      upcoming({ code: `n0${day}`, name: `Next ${day}`, releasedAt: `2027-01-0${day}` }),
    ),
  ],
};

function widget(config: unknown = null): HomeWidget {
  return { id: "comingSoon", kind: "comingSoon", x: 0, y: 0, w: 4, h: 4, config };
}

function fitFor(
  w: number,
  h: number,
  density: "comfortable" | "compact" = "comfortable",
  cell = 104,
): WidgetFit {
  return makeFit({ w, h, widthPx: spanPx(w, cell), heightPx: spanPx(h, cell), density });
}

/** Four cells wide is two list columns, and room for every row. */
const ROOMY = fitFor(4, 4);

let qc: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

function draw(
  config: unknown = null,
  { fit = ROOMY, still = false }: { fit?: WidgetFit; still?: boolean } = {},
) {
  return render(
    <ComingSoonWidget
      widget={widget(config)}
      fit={fit}
      editing={false}
      still={still}
      onConfig={vi.fn()}
    />,
    { wrapper },
  );
}

function drawnNames(): string[] {
  return screen
    .getAllByRole("listitem")
    .map((row) => row.querySelector(".font-medium")?.textContent ?? "");
}

beforeEach(() => {
  upcomingSets.mockReset().mockResolvedValue({ today: TODAY, sets: [] });
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  useAppStore.setState(useAppStore.getInitialState(), true);
  useAppStore.setState({ activeView: "home" });
});

describe("daysUntil", () => {
  it("counts whole days between two calendar dates", () => {
    expect(daysUntil(TODAY, "2026-10-08")).toBe(12);
    expect(daysUntil(TODAY, "2026-09-27")).toBe(1);
    expect(daysUntil(TODAY, "2026-12-04")).toBe(69);
  });

  /** Both dates are read as UTC midnights, so a daylight-saving change is not an hour short. */
  it("crosses a month, a year, a leap day and a clock change without drifting", () => {
    expect(daysUntil("2026-12-31", "2027-01-01")).toBe(1);
    expect(daysUntil("2026-02-28", "2026-03-01")).toBe(1);
    expect(daysUntil("2028-02-28", "2028-03-01")).toBe(2);
    expect(daysUntil("2026-03-28", "2026-03-30")).toBe(2);
    expect(daysUntil("2026-10-24", "2026-10-26")).toBe(2);
  });
});

describe("the words", () => {
  it("says tomorrow for one day and counts the rest", () => {
    expect(whenLabel(1)).toBe("tomorrow");
    expect(whenLabel(12)).toBe("in 12 days");
    expect(whenLabel(0)).toBe("today");
    expect(whenLabel(Number.NaN)).toBe("date unknown");
  });

  it("captions a set, naming the deck cards only when there are some", () => {
    expect(setCaption(TREK, TODAY)).toBe("TRK · in 12 days · 79 seen · 3 in your decks");
    expect(setCaption(GLASS, TODAY)).toBe("GLS · tomorrow · 12 seen");
    expect(
      setCaption(upcoming({ code: "big", name: "Big", releasedAt: "2026-10-01", previewed: 1234 }), TODAY),
    ).toBe("BIG · in 5 days · 1,234 seen");
  });

  /** The tile's caption is the full one's head, so the two can never name a set differently. */
  it("shortens a caption to the code and the day", () => {
    expect(shortCaption(TREK, TODAY)).toBe("TRK · in 12 days");
    expect(shortCaption(GLASS, TODAY)).toBe("GLS · tomorrow");
    expect(setCaption(TREK, TODAY).startsWith(`${shortCaption(TREK, TODAY)} · `)).toBe(true);
  });

  it("says the window in its own words", () => {
    expect(windowWords(30)).toBe("30 days");
    expect(windowWords(90)).toBe("90 days");
    expect(windowWords(365)).toBe("year");
    expect(emptySentence(90)).toBe("Nothing announced for the next 90 days.");
    expect(emptySentence(365)).toBe("Nothing announced for the next year.");
  });
});

describe("ComingSoonWidget", () => {
  describe("what it draws", () => {
    it("draws the two figures and a row per set, soonest first, in the card's columns", () => {
      qc.setQueryData(upcomingSetsKey(90), ANSWER);

      draw();

      expect(screen.getByText("Previewed so far")).toBeInTheDocument();
      expect(screen.getByText("96")).toBeInTheDocument();
      expect(screen.getByText("cards")).toBeInTheDocument();
      expect(screen.getByText("Reprints of your deck cards")).toBeInTheDocument();
      expect(screen.getByText("4")).toBeInTheDocument();
      expect(drawnNames()).toEqual(["Glass Tides", "Horizon Trek", "Echoes of Ash"]);
      expect(
        screen.getByRole("button", {
          name: "Horizon Trek · TRK · in 12 days · 79 seen · 3 in your decks",
        }),
      ).toBeInTheDocument();
      // The inline template `WidgetRowList` writes — read off `.style`, as
      // `DeckNotesPanel.test.tsx` does, rather than through a computed style jsdom lays out.
      expect(screen.getByRole("list", { name: "Announced sets" }).style.gridTemplateColumns).toBe(
        "repeat(2, minmax(0, 1fr))",
      );
      expect(ROOMY.listColumns).toBe(2);
    });

    it("cuts the list to the rows the box holds", () => {
      qc.setQueryData(upcomingSetsKey(90), ANSWER);
      const fit = fitFor(4, 2);

      draw(null, { fit });

      // A captioned row is 51px, and the figure line takes 74 before rows are counted.
      expect(screen.getAllByRole("listitem")).toHaveLength(fit.rowsFit(51, 74));
      expect(fit.rowsFit(51, 74)).toBeLessThan(3);
    });

    /**
     * Two figures are `basis-[120px]` with a 14px gap, so a body under 254px wraps them onto two
     * lines and the rows are cut under both: compact's one-line 62, plus the 6px gap above the
     * second line and a 38px figure on it. Compact is where a one-line cut overflows — comfortable's
     * rounding slack hid it — and a 3×3 on 76px cells is a panel, not a tile, that wraps as well.
     */
    const WRAPPED_COMPACT = 62 + 6 + 38;

    it.each([
      [2, 2, 104],
      [2, 3, 104],
      [3, 3, 76],
    ])(
      "cuts a compact %i×%i card on %ipx cells under two lines of figures",
      (w, h, cell) => {
        qc.setQueryData(upcomingSetsKey(90), MANY);
        const fit = fitFor(w, h, "compact", cell);

        draw(null, { fit });

        expect(fit.bodyWidthPx).toBeLessThan(2 * 120 + 14);
        expect(screen.getAllByRole("listitem")).toHaveLength(fit.rowsFit(51, WRAPPED_COMPACT));
        // The guard: a one-line reservation promises more rows than this box holds, and there are
        // sets enough to draw them — so a cut under one line cannot pass this case.
        expect(fit.rowsFit(51, WRAPPED_COMPACT)).toBeLessThan(fit.rowsFit(51, 62));
        expect(MANY.sets.length).toBeGreaterThanOrEqual(fit.rowsFit(51, 62));
      },
    );

    it("keeps one line of figures where the two fit side by side", () => {
      qc.setQueryData(upcomingSetsKey(90), MANY);
      const fit = fitFor(4, 3, "compact");

      draw(null, { fit });

      expect(fit.bodyWidthPx).toBeGreaterThanOrEqual(2 * 120 + 14);
      expect(screen.getAllByRole("listitem")).toHaveLength(fit.rowsFit(51, 62));
      // The guard, the other way: a two-line reservation here would draw fewer.
      expect(fit.rowsFit(51, 62)).toBeGreaterThan(fit.rowsFit(51, WRAPPED_COMPACT));
      expect(MANY.sets.length).toBeGreaterThanOrEqual(fit.rowsFit(51, 62));
    });

    /**
     * **Never a row the body cannot hold, down to `CELL_MIN`** (the live pass, 2026-09-26: a 2×2
     * on cells of ~100px or less drew one set row under two wrapped figures and scrolled, 4–28px).
     * `rowsFit` floors at one row, and that floor is the row the body used to draw. At the smallest
     * cell the grid draws, a 2×2 body is 96px comfortable and 98 compact — shorter than even the two
     * wrapped figures (measured at 101px) — so it draws the first figure alone and no row: the
     * one-line reservation less the gap nothing follows is what fits, and the two-line one is not.
     */
    it.each(["comfortable", "compact"] as const)(
      "draws one figure and no row on a %s 2×2 at the smallest cell",
      (density) => {
        qc.setQueryData(upcomingSetsKey(90), MANY);
        const fit = fitFor(2, 2, density, CELL_MIN);
        const line = density === "compact" ? 62 : 74;
        const gap = density === "compact" ? 5 : 8;

        draw(null, { fit });

        expect(screen.queryByRole("listitem")).toBeNull();
        expect(screen.queryByRole("list")).toBeNull();
        expect(screen.getByText("Previewed so far")).toBeInTheDocument();
        expect(screen.queryByText("Reprints of your deck cards")).toBeNull();
        // Why: no row fits under either figure line, and only the one-line figure fits at all.
        expect(fit.fitCount(51, line)).toBe(0);
        expect(line - gap).toBeLessThanOrEqual(fit.bodyHeightPx);
        expect(line + 6 + 38 - gap).toBeGreaterThan(fit.bodyHeightPx);
      },
    );

    /**
     * **The second figure gives way to a row**, where the two wrapped figures leave room for none
     * and one figure on its own line leaves room for one: a 2×2 comfortable on the grid's own 104px
     * cells. The set rows are what the card presses into; the second figure is a total the wider
     * boxes carry.
     */
    it("drops the second figure to make room for a set row", () => {
      qc.setQueryData(upcomingSetsKey(90), MANY);
      const fit = fitFor(2, 2);
      expect(fit.fitCount(51, 74 + 6 + 38)).toBe(0);
      expect(fit.fitCount(51, 74)).toBe(1);

      draw(null, { fit });

      expect(drawnNames()).toEqual(["Glass Tides"]);
      expect(screen.getByText("Previewed so far")).toBeInTheDocument();
      expect(screen.queryByText("Reprints of your deck cards")).toBeNull();
    });

    /**
     * **Both figures, and no row, where they share a line and no row fits under them** — the
     * stacked page's shape: a 2×2 drawn the canvas's width wide and a `CELL_MIN` footprint tall.
     */
    it("keeps both figures and draws no row where no row fits under one line of them", () => {
      qc.setQueryData(upcomingSetsKey(90), MANY);
      const fit = makeFit({ w: 2, h: 2, widthPx: 500, heightPx: spanPx(2, CELL_MIN), density: "comfortable" });
      expect(fit.bodyWidthPx).toBeGreaterThanOrEqual(2 * 120 + 14);
      expect(fit.fitCount(51, 74)).toBe(0);

      draw(null, { fit });

      expect(screen.queryByRole("listitem")).toBeNull();
      expect(screen.getByText("Previewed so far")).toBeInTheDocument();
      expect(screen.getByText("Reprints of your deck cards")).toBeInTheDocument();
    });

    it("shortens the caption to the code and the day on a two-cell tile", () => {
      qc.setQueryData(upcomingSetsKey(90), ANSWER);

      draw(null, { fit: fitFor(2, 4) });

      expect(screen.getByText("GLS · tomorrow")).toBeInTheDocument();
      expect(screen.queryByText("GLS · tomorrow · 12 seen")).toBeNull();
    });

    it("asks for the window the reader picked", async () => {
      draw({ window: 30 });

      await waitFor(() => expect(upcomingSets).toHaveBeenCalledWith(30));
      expect(await screen.findByText("Nothing announced for the next 30 days.")).toBeInTheDocument();
    });

    /** A word no option carries reads as the registry's default, never as the backend's clamp. */
    it("reads a stored window it does not offer as ninety days", async () => {
      draw({ window: "90" });

      await waitFor(() => expect(upcomingSets).toHaveBeenCalledWith(90));
    });
  });

  describe("the states", () => {
    it("says it is looking while the read is out", () => {
      upcomingSets.mockReturnValue(new Promise(() => {}));

      draw();

      expect(screen.getByText("Looking for announced sets…")).toBeInTheDocument();
    });

    it("says a refusal in the backend's words", async () => {
      upcomingSets.mockRejectedValue("The database is busy.");

      draw();

      expect(
        await screen.findByText("Could not read what is announced — The database is busy."),
      ).toBeInTheDocument();
    });

    it.each([
      [30, "Nothing announced for the next 30 days."],
      [90, "Nothing announced for the next 90 days."],
      [365, "Nothing announced for the next year."],
    ])("says nothing is announced in a %i-day window, in its own words", (days, sentence) => {
      qc.setQueryData(upcomingSetsKey(days), { today: TODAY, sets: [] });

      draw({ window: days });

      expect(screen.getByText(sentence)).toBeInTheDocument();
    });
  });

  describe("pressing a set", () => {
    /** `showSetInSearch` is the view change and the hand-off in one action, in the order that
     *  survives — so the body makes one call and the store's own test owns the order. */
    it("shows the set in the search", async () => {
      const user = userEvent.setup();
      const calls: string[] = [];
      const real = useAppStore.getState().showSetInSearch;
      useAppStore.setState({
        showSetInSearch: (code) => {
          calls.push(code);
          real(code);
        },
      });
      qc.setQueryData(upcomingSetsKey(90), ANSWER);
      draw();

      await user.click(screen.getByRole("button", { name: /^Horizon Trek · / }));

      expect(calls).toEqual(["trk"]);
      expect(useAppStore.getState().activeView).toBe("search");
      expect(useAppStore.getState().pendingSearchSet).toBe("trk");
    });

    it("draws a still body with no presses", () => {
      qc.setQueryData(upcomingSetsKey(90), ANSWER);

      draw(null, { still: true });

      expect(screen.queryByRole("button")).toBeNull();
      expect(screen.getByText("Horizon Trek")).toBeInTheDocument();
    });
  });
});
