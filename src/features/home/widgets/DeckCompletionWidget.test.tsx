import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DeckCompletion, DeckRow, HomeWidget } from "@/lib/ipc";
import type { MarketplaceId } from "@/lib/marketplace";

/**
 * The two reads this widget makes, in front of an **intact** mirror — `DecksWidget.test.tsx`'s
 * note: the module and the `ipc` object are both spread from the original, so every other command
 * stays real and a struct that grew a field fails under `tsc` rather than inside a render. Each
 * stub is typed against its own signature for the same reason.
 *
 * The cases that have data seed the cache through the widget's **exported** keys, so a seeded
 * answer only reaches the screen if the body reads the key it claims to. The stubs are for what a
 * cache cannot hold: a read still out, a read refused, and the refetch a bridge or a marketplace
 * switch causes.
 */
const deckList = vi.hoisted(() => vi.fn<() => Promise<DeckRow[]>>());
const deckCompletion = vi.hoisted(() =>
  vi.fn<(marketplace: MarketplaceId) => Promise<DeckCompletion[]>>(),
);
vi.mock("@/lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ipc")>();
  return { ...actual, ipc: { ...actual.ipc, deckList, deckCompletion } };
});

import { DEFAULT_MARKETPLACE, MARKETPLACES } from "@/lib/marketplace";
import { useAppStore } from "@/lib/store";
import { MARKETPLACE_FEEDS_KEY, MARKETPLACE_KEY } from "@/lib/useMarketplace";
import { makeFit, spanPx, type WidgetFit } from "../fit";
import { deckCompletionKey, deckListKey } from "../keys";
import type { Density } from "../widgetSettings";
import {
  ALL_COMPLETE,
  completionFooter,
  completionRows,
  countCaption,
  DeckCompletionWidget,
  NO_DECKS,
  NOTHING_PINNED,
  PINS_UNMEASURABLE,
  rowHint,
  sortCompletions,
  type CompletionRow,
} from "./DeckCompletionWidget";

/** A deck row, annotated so the mirror checks the fixture — `DecksWidget.test.tsx`'s factory. */
function deck(over: Partial<DeckRow> & { id: number; name: string }): DeckRow {
  return {
    formatKey: "modern",
    formatName: "Modern",
    gameKey: "any",
    description: null,
    coverCardId: null,
    coverKind: "card_art",
    coverArtist: null,
    archived: false,
    cardCount: 60,
    updatedAt: 1_800_000_000,
    folderId: null,
    notesOpen: false,
    theoryEnabled: false,
    virtualOnly: false,
    theoryMarkExact: true,
    theoryMarkName: true,
    theoryMarkUnplanned: true,
    managedWishlist: "off",
    lastVariant: "live",
    lastGroupBy: "category",
    lastSortBy: "alphabetical",
    separateXGroup: false,
    defaultCategoryId: 0,
    bracket: 0,
    tokensOpen: false,
    tokenStack: false,
    statsOpen: true,
    ...over,
  };
}

/**
 * One deck's answer. The default is a **complete, priced** deck — `missingCost: 0` and not `null`,
 * because `null` means *nothing on the list is priced at all* (`DeckStats.tsx:497-509`), which is a
 * different deck.
 */
function completion(over: Partial<DeckCompletion> & { deckId: number }): DeckCompletion {
  return {
    list: "live",
    wanted: 60,
    owned: 60,
    missing: 0,
    missingCost: 0,
    unpricedMissing: 0,
    ...over,
  };
}

function row(name: string, over: Partial<DeckCompletion> & { deckId: number }): CompletionRow {
  return { ...completion(over), name };
}

const BURN = deck({ id: 1, name: "Burn" });
const ATRAXA = deck({ id: 2, name: "Atraxa", formatKey: "commander", cardCount: 100 });
const MONO = deck({ id: 3, name: "Mono Red" });
const SHELF = deck({ id: 4, name: "Old Shelf", archived: true });
const PROXIES = deck({ id: 5, name: "Proxy Pile", virtualOnly: true });

const BURN_AT = completion({ deckId: 1, owned: 56, missing: 4, missingCost: 12.5 });
const ATRAXA_AT = completion({ deckId: 2, wanted: 100, owned: 40, missing: 60, missingCost: 209.2 });
const MONO_AT = completion({ deckId: 3 });
const SHELF_AT = completion({ deckId: 4, owned: 10, missing: 50, missingCost: 5 });
// No answer for the virtual deck: `deck_completion` answers none (spec §3.1).

/**
 * **A deck whose measured list asks for nothing** — a deck just made, a plan not yet written. The
 * answer is the one the backend gives such a deck: nothing wanted, nothing missing, and `null`
 * money because nothing on an empty list is priced. `missing === 0` would read it as complete, so
 * the widget leaves it off entirely (controller ruling, 2026-09-26).
 */
const SHELL = deck({ id: 9, name: "Empty Shell", cardCount: 0 });
const SHELL_AT = completion({ deckId: 9, wanted: 0, owned: 0, missing: 0, missingCost: null });

/** A deck that keeps a plan, measured by it — the list the editor's Theory tab counts. */
const PLAN = deck({ id: 8, name: "Esper Control", theoryEnabled: true, lastVariant: "theory" });
const PLAN_AT = completion({
  deckId: 8,
  list: "theory",
  wanted: 100,
  owned: 81,
  missing: 19,
  missingCost: 50,
});

const DECKS = [BURN, ATRAXA, MONO, SHELF, PROXIES];
const ANSWERS = [BURN_AT, ATRAXA_AT, MONO_AT, SHELF_AT];

function widget(config: unknown = null): HomeWidget {
  return { id: "deckCompletion", kind: "deckCompletion", x: 0, y: 0, w: 3, h: 3, config };
}

/** The box a widget is told it is drawn in, at the grid's target cell. */
function fitFor(w: number, h: number, density: Density = "comfortable"): WidgetFit {
  return makeFit({ w, h, widthPx: spanPx(w, 104), heightPx: spanPx(h, 104), density });
}

/** Room for every fixture below, one list column, and a footer (three cells wide is tier 1). */
const ROOMY = fitFor(3, 6);

let qc: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

function seed(decks: readonly DeckRow[], answers: readonly DeckCompletion[]) {
  qc.setQueryData(deckListKey, decks);
  qc.setQueryData(deckCompletionKey(DEFAULT_MARKETPLACE), answers);
}

function draw(
  config: unknown = null,
  { fit = ROOMY, still = false }: { fit?: WidgetFit; still?: boolean } = {},
): ReturnType<typeof render> {
  return render(
    <DeckCompletionWidget
      widget={widget(config)}
      fit={fit}
      editing={false}
      still={still}
      onConfig={vi.fn()}
    />,
    { wrapper },
  );
}

/** Every row's accessible name, in drawn order — which rows, and what order, in one assertion. */
function rowNames(): string[] {
  return screen
    .queryAllByRole("button")
    .map((el) => el.getAttribute("aria-label") ?? "")
    .filter((name) => name !== "");
}

const deckNames = () => rowNames().map((name) => name.split(" · ")[0]);

/** Replace the two store actions a press writes, recording the order they were called in. */
function recordWrites(): string[] {
  const writes: string[] = [];
  const { setActiveView, setOpenDeckId } = useAppStore.getState();
  useAppStore.setState({
    setActiveView: (view) => {
      writes.push(`view:${view}`);
      setActiveView(view);
    },
    setOpenDeckId: (id) => {
      writes.push(`deck:${id}`);
      setOpenDeckId(id);
    },
  });
  return writes;
}

beforeEach(() => {
  deckList.mockReset().mockResolvedValue([]);
  deckCompletion.mockReset().mockResolvedValue([]);
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(MARKETPLACE_KEY, DEFAULT_MARKETPLACE);
  qc.setQueryData(MARKETPLACE_FEEDS_KEY, []);
  // The store is module-level and leaks between tests; the press cases replace two actions.
  useAppStore.setState(useAppStore.getInitialState(), true);
  useAppStore.setState({ activeView: "home" });
});

describe("sortCompletions", () => {
  const alpha = row("Alpha", { deckId: 1, wanted: 10, owned: 5, missing: 5, missingCost: 3 });
  const beta = row("Beta", {
    deckId: 2,
    wanted: 10,
    owned: 5,
    missing: 5,
    missingCost: null,
    unpricedMissing: 5,
  });
  const gamma = row("Gamma", { deckId: 3, wanted: 10, owned: 10 });
  const delta = row("Delta", { deckId: 4, wanted: 10, owned: 9, missing: 1, missingCost: 40 });

  it("orders nearest done first, settling a tie by name", () => {
    expect(sortCompletions([beta, alpha, delta, gamma], "done").map((r) => r.name)).toEqual([
      "Gamma",
      "Delta",
      "Alpha",
      "Beta",
    ]);
  });

  /** A complete deck costs nothing to finish, so it leads; a deck nothing is priced in trails. */
  it("orders cheapest to finish, a complete deck first and an unpriced one last", () => {
    expect(sortCompletions([beta, delta, alpha, gamma], "cheapest").map((r) => r.name)).toEqual([
      "Gamma",
      "Alpha",
      "Delta",
      "Beta",
    ]);
  });

  it("orders by name through the app's one collator", () => {
    expect(sortCompletions([gamma, delta, beta, alpha], "name").map((r) => r.name)).toEqual([
      "Alpha",
      "Beta",
      "Delta",
      "Gamma",
    ]);
  });

  /** The rows are the query cache's own array one `completionRows` away — sorting it in place
   *  would reorder what every other reader of that answer sees. */
  it("never sorts the cached array in place", () => {
    const input = [alpha, gamma];
    expect(sortCompletions(input, "done").map((r) => r.name)).toEqual(["Gamma", "Alpha"]);
    expect(input.map((r) => r.name)).toEqual(["Alpha", "Gamma"]);
  });
});

describe("completionFooter", () => {
  const done = row("Done", { deckId: 1 });
  const short = row("Short", { deckId: 2, owned: 56, missing: 4, missingCost: 12.5 });
  const nothingPriced = row("Tokens", {
    deckId: 3,
    wanted: 40,
    owned: 0,
    missing: 40,
    missingCost: null,
    unpricedMissing: 40,
  });
  /** The coordinator's case: missing copies, all of them unpriced, over a list that is priced. */
  const unpricedGap = row("Proxy Night", {
    deckId: 4,
    owned: 57,
    missing: 3,
    missingCost: 0,
    unpricedMissing: 3,
  });

  it("counts the complete decks and prices the rest", () => {
    expect(completionFooter([done, short], "usd")).toEqual({
      complete: 1,
      cost: 12.5,
      unpriced: 0,
      text: "1 deck complete · $12.50 to finish the rest",
    });
  });

  it("says every deck when none is complete", () => {
    expect(completionFooter([short], "usd").text).toBe("$12.50 to finish every deck here");
  });

  /**
   * **`missing === 0` is what complete means, never the money.** A deck whose missing copies are
   * all unpriced answers `missingCost: 0` — it is short three cards and is not complete, and its
   * three copies are said as unpriced rather than summed as nothing.
   */
  it("counts a deck short only unpriced copies as not complete, and says the copies", () => {
    expect(completionFooter([done, unpricedGap], "usd")).toEqual({
      complete: 1,
      cost: 0,
      unpriced: 3,
      text: "1 deck complete · $0.00 to finish the rest · 3 copies unpriced",
    });
  });

  it("adds nothing for a deck nothing is priced in, and says its copies", () => {
    expect(completionFooter([short, nothingPriced], "eur")).toEqual({
      complete: 0,
      cost: 12.5,
      unpriced: 40,
      text: "€12.50 to finish every deck here · 40 copies unpriced",
    });
  });

  it("has no cost when every deck is complete, and nothing to say about nothing", () => {
    expect(completionFooter([done], "usd")).toEqual({
      complete: 1,
      cost: null,
      unpriced: 0,
      text: "1 deck complete",
    });
    expect(completionFooter([], "usd").text).toBe("");
  });
});

describe("countCaption", () => {
  it("says how much of the deck is held, and what is missing or that nothing is", () => {
    expect(countCaption(BURN_AT)).toBe("56 of 60 · 4 missing");
    expect(countCaption(MONO_AT)).toBe("60 of 60 · complete");
  });

  /**
   * **A figure measured on the plan says so where it is drawn** (controller ruling, 2026-09-26):
   * the hint is a hover away, and "81 of 100" beside a deck whose sleeved list holds 60 would read
   * as the widget disagreeing with the deck.
   */
  it("starts a figure measured on the theory list with Plan", () => {
    expect(countCaption(PLAN_AT)).toBe("Plan · 81 of 100 · 19 missing");
    expect(countCaption(completion({ deckId: 8, list: "theory" }))).toBe(
      "Plan · 60 of 60 · complete",
    );
  });
});

describe("rowHint", () => {
  const tcg = MARKETPLACES.tcgplayer;

  it("says nothing about a deck whose missing copies are all priced", () => {
    expect(rowHint(completion({ deckId: 1, missing: 4, missingCost: 12.5 }), tcg)).toBeUndefined();
  });

  it("says which copies the figure leaves out", () => {
    expect(
      rowHint(completion({ deckId: 1, missing: 4, missingCost: 9, unpricedMissing: 1 }), tcg),
    ).toBe("1 missing copy with no price at TCGplayer is not in this figure.");
    expect(
      rowHint(completion({ deckId: 1, missing: 3, missingCost: 0, unpricedMissing: 3 }), tcg),
    ).toBe("3 missing copies with no price at TCGplayer are not in this figure.");
  });

  it("says when nothing on the list is priced at all", () => {
    expect(
      rowHint(completion({ deckId: 1, missing: 40, missingCost: null, unpricedMissing: 40 }), tcg),
    ).toBe("Nothing on this deck's list has a price at TCGplayer.");
  });

  it("says a theory deck is measured against its plan", () => {
    expect(rowHint(completion({ deckId: 1, list: "theory" }), tcg)).toMatch(
      /^Measured against this deck's theory list/,
    );
  });
});

describe("completionRows", () => {
  it("keeps deck_list's order, leaves archived and virtual decks out, and drops an unanswered deck", () => {
    const answers = [SHELF_AT, MONO_AT, BURN_AT];
    expect(completionRows(DECKS, answers, "recent", []).map((r) => r.name)).toEqual([
      "Burn",
      "Mono Red",
    ]);
  });

  it("keeps a pinned archived deck, and drops a pin to a virtual deck", () => {
    expect(completionRows(DECKS, ANSWERS, "pinned", [4, 5, 2]).map((r) => r.name)).toEqual([
      "Old Shelf",
      "Atraxa",
    ]);
  });

  /**
   * **A deck that wants nothing is neither complete nor in progress**, so it is not a row at all —
   * and dropping it here, before anything orders, counts or decides the card is empty, is what
   * keeps every one of those from reading it as done. In either scope: pinning an empty deck does
   * not make it measurable.
   */
  it("leaves out a deck whose measured list asks for nothing, in either scope", () => {
    const decks = [SHELL, ...DECKS];
    const answers = [SHELL_AT, ...ANSWERS];
    expect(completionRows(decks, answers, "recent", []).map((r) => r.name)).toEqual([
      "Burn",
      "Atraxa",
      "Mono Red",
    ]);
    expect(completionRows(decks, answers, "pinned", [9, 1]).map((r) => r.name)).toEqual(["Burn"]);
  });
});

describe("DeckCompletionWidget", () => {
  describe("what it draws", () => {
    it("draws a row per deck in scope, nearest done first, with its count, cost and track", () => {
      seed(DECKS, ANSWERS);

      draw();

      // Most recent, complete decks off: the archived shelf, the virtual pile and the complete
      // deck are all out.
      expect(deckNames()).toEqual(["Burn", "Atraxa"]);
      const burn = screen.getByRole("button", { name: /^Burn/ });
      expect(burn).toHaveAccessibleName("Burn · 56 of 60 · 4 missing · $12.50");
      expect(within(burn).getByText("56 of 60 · 4 missing")).toBeInTheDocument();
      expect(within(burn).getByText("$12.50")).toBeInTheDocument();
      // 56 of 60 is 93.3%, floored so a track never reaches its end before the deck does.
      expect(burn.querySelector(".bg-accent")).toHaveStyle({ width: "93%" });
    });

    /** The footer is about every deck in scope, not about the rows that fit. */
    it("counts a complete deck in the footer instead of listing it", () => {
      seed(DECKS, ANSWERS);

      draw();

      expect(screen.getByText("1 deck complete · $221.70 to finish the rest")).toBeInTheDocument();
      expect(screen.queryByText("Mono Red")).toBeNull();
    });

    it("lists complete decks when the switch is on, with no money to show", () => {
      seed(DECKS, ANSWERS);

      draw({ complete: true });

      expect(deckNames()).toEqual(["Mono Red", "Burn", "Atraxa"]);
      const mono = screen.getByRole("button", { name: /^Mono Red/ });
      expect(mono).toHaveAccessibleName("Mono Red · 60 of 60 · complete");
      expect(within(mono).queryByText("$0.00")).toBeNull();
    });

    /**
     * **The empty deck is left off even with complete decks listed, and is not counted as one.**
     * `missing === 0` is true of it, so a widget that let it through would list it beside Mono Red
     * and say `2 decks complete`.
     */
    it("leaves a deck that asks for nothing off the card, and out of the footer's count", () => {
      seed([SHELL, ...DECKS], [SHELL_AT, ...ANSWERS]);

      draw({ complete: true });

      expect(deckNames()).toEqual(["Mono Red", "Burn", "Atraxa"]);
      expect(screen.queryByText("Empty Shell")).toBeNull();
      expect(screen.getByText("1 deck complete · $221.70 to finish the rest")).toBeInTheDocument();
    });

    it("orders by the reader's pick", () => {
      seed(DECKS, ANSWERS);

      draw({ order: "name", complete: true });

      expect(deckNames()).toEqual(["Atraxa", "Burn", "Mono Red"]);
    });

    it("draws the pinned decks, an archived pin included", () => {
      seed(DECKS, ANSWERS);

      draw({ scope: "pinned", deckIds: [4, 2] });

      // Nearest done: Atraxa has 40 of 100, the shelf 10 of 60.
      expect(deckNames()).toEqual(["Atraxa", "Old Shelf"]);
    });

    /** `null` is *nothing priced*, and the only case that draws an em dash. */
    it("draws an em dash for a deck nothing on whose list is priced", () => {
      const tokens = deck({ id: 6, name: "Tokens" });
      seed(
        [tokens],
        [
          completion({
            deckId: 6,
            wanted: 40,
            owned: 0,
            missing: 40,
            missingCost: null,
            unpricedMissing: 40,
          }),
        ],
      );

      draw();

      expect(screen.getByRole("button", { name: /^Tokens/ })).toHaveAccessibleName(
        "Tokens · 0 of 40 · 40 missing · —",
      );
    });

    /**
     * **Short three copies, none of them priced, on a priced list** — `missingCost: 0`. The deck is
     * listed with the switch off (it is not complete), its figure is the `$0.00` the editor's own
     * arithmetic answers, and the footer says the three copies rather than summing them as nothing.
     */
    it("lists a deck short only unpriced copies, and says them in the footer", () => {
      const proxies = deck({ id: 7, name: "Proxy Night" });
      seed(
        [proxies, MONO],
        [completion({ deckId: 7, owned: 57, missing: 3, missingCost: 0, unpricedMissing: 3 }), MONO_AT],
      );

      draw();

      expect(deckNames()).toEqual(["Proxy Night"]);
      expect(screen.getByRole("button", { name: /^Proxy Night/ })).toHaveAccessibleName(
        "Proxy Night · 57 of 60 · 3 missing · $0.00",
      );
      expect(
        screen.getByText("1 deck complete · $0.00 to finish the rest · 3 copies unpriced"),
      ).toBeInTheDocument();
    });

    /** The caption says the figure is the plan's, and so does the name a reader drives by. */
    it("says Plan on a row measured on the theory list", () => {
      seed([PLAN], [PLAN_AT]);

      draw();

      const plan = screen.getByRole("button", { name: /^Esper Control/ });
      expect(plan).toHaveAccessibleName("Esper Control · Plan · 81 of 100 · 19 missing · $50.00");
      expect(within(plan).getByText("Plan · 81 of 100 · 19 missing")).toBeInTheDocument();
    });

    it("moves the shortfall under the name on a two-cell tile", () => {
      seed([BURN], [BURN_AT]);

      draw(null, { fit: fitFor(2, 3) });

      const burn = screen.getByRole("button", { name: /^Burn/ });
      expect(burn).toHaveTextContent("Burn4 missing · $12.50");
      expect(screen.queryByText("56 of 60 · 4 missing")).toBeNull();
      // A tile is too narrow for the footer.
      expect(screen.queryByText(/to finish/)).toBeNull();
    });

    it("keeps Plan in the shortfall a tile moves under the name", () => {
      seed([PLAN], [PLAN_AT]);

      draw(null, { fit: fitFor(2, 3) });

      expect(screen.getByRole("button", { name: /^Esper Control/ })).toHaveTextContent(
        "Esper ControlPlan · 19 missing · $50.00",
      );
    });

    it("drops the caption on a compact card and keeps the cost", () => {
      seed([BURN], [BURN_AT]);

      draw(null, { fit: fitFor(3, 3, "compact") });

      expect(screen.queryByText("56 of 60 · 4 missing")).toBeNull();
      expect(screen.getByText("$12.50")).toBeInTheDocument();
      // Nothing under the name at all: the row is the name and the figure.
      expect(screen.getByRole("button", { name: /^Burn/ })).toHaveTextContent(/^Burn\$12\.50$/);
    });

    /**
     * **A compact panel draws no count, and a plan's figures still need saying** (fix round 1): the
     * price and the track beside `Esper Control` are the plan's, so the word alone is its caption.
     * A live row beside it stays bare.
     */
    it("keeps the word Plan as the caption of a theory row on a compact card", () => {
      seed([PLAN, BURN], [PLAN_AT, BURN_AT]);

      draw(null, { fit: fitFor(3, 3, "compact") });

      const plan = screen.getByRole("button", { name: /^Esper Control/ });
      expect(plan).toHaveTextContent(/^Esper ControlPlan\$50\.00$/);
      expect(within(plan).getByText("Plan")).toBeInTheDocument();
      expect(within(plan).queryByText(/81 of 100/)).toBeNull();
      expect(screen.getByRole("button", { name: /^Burn/ })).toHaveTextContent(/^Burn\$12\.50$/);
      // The name a reader drives by still carries the whole caption.
      expect(plan).toHaveAccessibleName("Esper Control · Plan · 81 of 100 · 19 missing · $50.00");
    });

    it("cuts the list to the rows the box holds", () => {
      const many = Array.from({ length: 12 }, (_, i) => deck({ id: 100 + i, name: `Deck ${i}` }));
      seed(
        many,
        many.map((d) => completion({ deckId: d.id, owned: 50, missing: 10, missingCost: 4 })),
      );
      const fit = fitFor(3, 3);

      draw(null, { fit });

      // A captioned row with a track is 57px, and the footer takes 22 before rows are counted.
      expect(screen.getAllByRole("listitem")).toHaveLength(fit.rowsFit(57, 22));
    });

    /**
     * **One row height for the whole list, and it has to be the tallest row drawn.** A compact
     * panel of live decks is bare rows (42px with the track); one theory row among them carries the
     * `Plan` line, so every row is counted at the captioned 57px — counting at 42 would cut the list
     * to more rows than the box holds. The fixture is chosen so the two counts differ (5 against 4).
     */
    it("counts rows at the captioned height on a compact card once a theory row is listed", () => {
      const fit = fitFor(3, 3, "compact");
      expect(fit.rowsFit(42, 22)).not.toBe(fit.rowsFit(57, 22));
      const many = Array.from({ length: 12 }, (_, i) => deck({ id: 100 + i, name: `Deck ${i}` }));
      const answers = many.map((d) =>
        completion({ deckId: d.id, owned: 50, missing: 10, missingCost: 4 }),
      );
      seed(many, answers);

      const { unmount } = draw(null, { fit });

      expect(screen.getAllByRole("listitem")).toHaveLength(fit.rowsFit(42, 22));
      unmount();

      // The same decks with one of them measured on its plan.
      seed(many, [...answers.slice(0, 11), { ...answers[11], list: "theory" }]);
      draw(null, { fit });

      expect(screen.getAllByRole("listitem")).toHaveLength(fit.rowsFit(57, 22));
    });
  });

  describe("the states", () => {
    it("says it is measuring while a read is out", () => {
      qc.setQueryData(deckListKey, DECKS);
      deckCompletion.mockReturnValue(new Promise(() => {}));

      draw();

      expect(screen.getByText("Measuring your decks…")).toBeInTheDocument();
    });

    it("says a refusal in the backend's words", async () => {
      qc.setQueryData(deckListKey, DECKS);
      deckCompletion.mockRejectedValue("The database is busy.");

      draw();

      expect(
        await screen.findByText("Could not measure your decks — The database is busy."),
      ).toBeInTheDocument();
    });

    it("says there is nothing to measure when there are no decks", () => {
      seed([], []);

      draw();

      expect(screen.getByText(NO_DECKS)).toBeInTheDocument();
    });

    it("says there is nothing to measure when every deck is archived or virtual", () => {
      seed([SHELF, PROXIES], [SHELF_AT]);

      draw();

      expect(screen.getByText(NO_DECKS)).toBeInTheDocument();
    });

    /**
     * **Nothing to measure, not every deck complete.** A reader whose one deck is a fresh shell
     * has finished nothing, and the sentence that tells them to switch on `Complete decks` would
     * send them to a switch that lists nothing either.
     */
    it("says there is nothing to measure when the only deck asks for nothing", () => {
      seed([SHELL], [SHELL_AT]);

      const { unmount } = draw();

      expect(screen.getByText(NO_DECKS)).toBeInTheDocument();
      expect(screen.queryByText(ALL_COMPLETE)).toBeNull();
      unmount();

      draw({ complete: true });

      expect(screen.getByText(NO_DECKS)).toBeInTheDocument();
      expect(rowNames()).toEqual([]);
    });

    it("points at the settings when Pinned has nothing pinned", () => {
      seed(DECKS, ANSWERS);

      draw({ scope: "pinned" });

      expect(screen.getByText(NOTHING_PINNED)).toBeInTheDocument();
      expect(rowNames()).toEqual([]);
    });

    /**
     * **Pins that answer to nothing measurable are the pins' problem, not the collection's**
     * (fix round 1). `NO_DECKS` would tell a reader who has decks to build one, and say archived
     * decks are left out — false under `Pinned`, where an archived pin is drawn. Here the pins are
     * a virtual deck, an empty one and an id no deck has any more, while four real decks exist.
     */
    it("says the pins cannot be measured when every pin is gone, virtual or empty", () => {
      seed([SHELL, ...DECKS], [SHELL_AT, ...ANSWERS]);

      draw({ scope: "pinned", deckIds: [5, 9, 404] });

      expect(screen.getByText(PINS_UNMEASURABLE)).toBeInTheDocument();
      expect(screen.queryByText(NO_DECKS)).toBeNull();
      expect(rowNames()).toEqual([]);
    });

    it("says every deck is complete when the switch is off and nothing is short", () => {
      seed([MONO], [MONO_AT]);

      draw();

      expect(screen.getByText(ALL_COMPLETE)).toBeInTheDocument();
      expect(ALL_COMPLETE).toContain("Complete decks");
    });
  });

  describe("opening a deck", () => {
    /** `setActiveView` clears `openDeckId` on the way in, so the view is written first. */
    it("opens the deck it was pressed on, view first and id second", async () => {
      const user = userEvent.setup();
      const writes = recordWrites();
      seed(DECKS, ANSWERS);
      draw();

      await user.click(screen.getByRole("button", { name: /^Atraxa/ }));

      expect(writes).toEqual(["view:decks", "deck:2"]);
      expect(useAppStore.getState().activeView).toBe("decks");
      expect(useAppStore.getState().openDeckId).toBe(2);
    });

    /** A row measured on the plan opens the same deck the same way — the caption changes what
     *  the figure is called, never where the press goes. */
    it("opens a deck measured on its plan exactly as it opens any other", async () => {
      const user = userEvent.setup();
      const writes = recordWrites();
      seed([PLAN], [PLAN_AT]);
      draw();

      await user.click(screen.getByRole("button", { name: /^Esper Control/ }));

      expect(writes).toEqual(["view:decks", "deck:8"]);
      expect(useAppStore.getState().openDeckId).toBe(8);
    });

    it("draws a still body with no presses", () => {
      seed(DECKS, ANSWERS);

      draw(null, { still: true });

      expect(screen.queryByRole("button")).toBeNull();
      expect(screen.getByText("Burn")).toBeInTheDocument();
    });
  });

  /**
   * **A switch re-issues the read.** The marketplace is in the key, so the card says it is
   * measuring rather than drawing the last marketplace's figure beside the new one's symbol.
   */
  it("measures again at a new marketplace rather than relabelling the old figure", async () => {
    seed(DECKS, ANSWERS);
    qc.setQueryData(MARKETPLACE_KEY, "cardmarket");
    deckCompletion.mockResolvedValue([
      completion({ deckId: 1, owned: 56, missing: 4, missingCost: 9.5 }),
    ]);

    draw();

    expect(screen.getByText("Measuring your decks…")).toBeInTheDocument();
    expect(screen.queryByText("$12.50")).toBeNull();
    expect(
      await screen.findByRole("button", { name: "Burn · 56 of 60 · 4 missing · €9.50" }),
    ).toBeInTheDocument();
    expect(deckCompletion).toHaveBeenCalledWith("cardmarket");
  });

  /**
   * **Owned copies are collection rows**, and a binder write invalidates `["collection"]` and
   * nothing under `["decks"]` — so the widget bridges the one root itself (`ActivityWidget`'s
   * mechanism).
   */
  describe("staying fresh", () => {
    it("measures again when a collection write invalidates its root", async () => {
      seed([BURN], [BURN_AT]);
      deckCompletion.mockResolvedValue([
        completion({ deckId: 1, owned: 58, missing: 2, missingCost: 6 }),
      ]);
      draw();
      expect(deckCompletion).not.toHaveBeenCalled();

      await act(async () => {
        await qc.invalidateQueries({ queryKey: ["collection"] });
      });

      expect(
        await screen.findByRole("button", { name: "Burn · 58 of 60 · 2 missing · $6.00" }),
      ).toBeInTheDocument();
    });

    /**
     * **One write, one measurement** (fix round 1). A binder write invalidates `["collection"]`,
     * which dispatches one `invalidate` event per cached query under that root — the marker plus
     * whatever the collection page, the search and the other widgets hold. Answered one by one,
     * each event re-issues the read and the next cancels it, and a cancelled TanStack fetch does
     * not abort a Tauri invoke: K events cost K backend runs over every deck, K − 1 discarded. The
     * bridge coalesces a burst in one tick into one invalidation.
     */
    it("measures once for a burst of collection invalidations in one tick", async () => {
      seed([BURN], [BURN_AT]);
      // Three more readers under the root, so one write dispatches four `invalidate` events.
      qc.setQueryData(["collection", "list", "a"], []);
      qc.setQueryData(["collection", "list", "b"], []);
      qc.setQueryData(["collection", "count"], 0);
      deckCompletion.mockResolvedValue([
        completion({ deckId: 1, owned: 58, missing: 2, missingCost: 6 }),
      ]);
      draw();

      await act(async () => {
        await qc.invalidateQueries({ queryKey: ["collection"] });
      });

      expect(
        await screen.findByRole("button", { name: "Burn · 58 of 60 · 2 missing · $6.00" }),
      ).toBeInTheDocument();
      expect(deckCompletion).toHaveBeenCalledTimes(1);
    });

    it("leaves the read alone when an unrelated root is invalidated", async () => {
      seed([BURN], [BURN_AT]);
      draw();

      await act(async () => {
        await qc.invalidateQueries({ queryKey: ["cards", "search"] });
      });

      expect(deckCompletion).not.toHaveBeenCalled();
    });

    it("does not bridge from a still body", async () => {
      seed([BURN], [BURN_AT]);
      draw(null, { still: true });

      await act(async () => {
        await qc.invalidateQueries({ queryKey: ["collection"] });
      });

      expect(deckCompletion).not.toHaveBeenCalled();
    });
  });
});
