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
import { makeFit, spanPx, type WidgetFit } from "../fit";
import { upcomingSetsKey } from "../keys";
import {
  ComingSoonWidget,
  daysUntil,
  emptySentence,
  setCaption,
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

function widget(config: unknown = null): HomeWidget {
  return { id: "comingSoon", kind: "comingSoon", x: 0, y: 0, w: 4, h: 4, config };
}

function fitFor(w: number, h: number): WidgetFit {
  return makeFit({ w, h, widthPx: spanPx(w, 104), heightPx: spanPx(h, 104), density: "comfortable" });
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
