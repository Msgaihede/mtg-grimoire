import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The four reads this widget makes, in front of an intact mirror — `DecksWidget.test.tsx`'s idiom:
 * the `ipc` object is spread from the original so every other command keeps its real wrapper, and
 * the cases with data seed the cache through the widget's own exported keys, so the mocks answer
 * only a cold cache.
 */
const deckList = vi.hoisted(() => vi.fn());
const deckPipCosts = vi.hoisted(() => vi.fn());
const deckCommanderIdentities = vi.hoisted(() => vi.fn());
const deckFolderList = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ipc")>();
  return {
    ...actual,
    ipc: { ...actual.ipc, deckList, deckPipCosts, deckCommanderIdentities, deckFolderList },
  };
});

import type {
  DeckCommanderIdentity,
  DeckFolder,
  DeckPipCosts,
  DeckRow,
  HomeWidget,
} from "@/lib/ipc";
import { useAppStore } from "@/lib/store";
import { makeFit, spanPx, type WidgetFit } from "../fit";
import { deckCommanderIdentitiesKey, deckFoldersKey, deckListKey, deckPipCostsKey } from "../keys";
import {
  COMBO_ROW_ATTR,
  DECK_CHIP_ATTR,
  DeckColorsWidget,
  DeckColorsWidgetSettings,
  LOADING,
  NO_DECKS,
  NOTHING_CHOSEN,
} from "./DeckColorsWidget";

function deck(over: Partial<DeckRow> & { id: number; name: string }): DeckRow {
  return {
    formatKey: "commander",
    formatName: "Commander",
    gameKey: "any",
    description: null,
    coverCardId: null,
    coverKind: "card_art",
    coverArtist: null,
    archived: false,
    cardCount: 100,
    updatedAt: 1_800_000_000,
    folderId: null,
    notesOpen: false,
    theoryEnabled: false,
    virtualOnly: false,
    theoryMarkExact: true,
    theoryMarkName: true,
    theoryMarkUnplanned: true,
    theoryCardCount: 0,
    managedWishlist: "off",
    managedWishlistTokens: false,
    lastVariant: "live",
    lastGroupBy: "category",
    lastSortBy: "alphabetical",
    separateXGroup: false,
    defaultCategoryId: 0,
    bracket: 0,
    tags: [],
    tokensOpen: false,
    tokenMode: "managed",
    tokenRailIndex: -1,
    statsOpen: true,
    curveCreatures: false,
    todosOpen: false,
    syncUid: null,
    draft: false,
    ...over,
  };
}

function widget(config: unknown = null): HomeWidget {
  return { id: "deckColors", kind: "deckColors", x: 0, y: 0, w: 4, h: 4, config };
}

function fitFor(w: number, h: number): WidgetFit {
  return makeFit({
    w,
    h,
    widthPx: spanPx(w, 104),
    heightPx: spanPx(h, 104),
    density: "comfortable",
  });
}

const DECKS = [
  deck({ id: 1, name: "Bruna", bracket: 3, folderId: 10 }),
  deck({ id: 2, name: "Orvar", bracket: 3, tags: ["No GC", "Budget"], folderId: 10 }),
  deck({ id: 3, name: "Lightning", folderId: 11 }),
  deck({ id: 4, name: "Azorius A", folderId: 12 }),
  deck({ id: 5, name: "Azorius B", folderId: 12 }),
  deck({ id: 6, name: "Azorius C", folderId: 12 }),
  deck({ id: 7, name: "Burn", formatKey: "modern", formatName: "Modern" }),
];
const IDENTITIES: DeckCommanderIdentity[] = [
  { deckId: 1, identity: "W", theoryIdentity: null },
  { deckId: 2, identity: "U", theoryIdentity: null },
  { deckId: 3, identity: "RWB", theoryIdentity: null },
  { deckId: 4, identity: "WU", theoryIdentity: null },
  { deckId: 5, identity: "UW", theoryIdentity: null },
  { deckId: 6, identity: "WU", theoryIdentity: null },
];
const PIPS: DeckPipCosts[] = [
  // Lightning's cards so far are red; its commander still files it as Mardu.
  { deckId: 3, costs: [{ cost: "{R}", copies: 4 }], theoryCosts: [] },
  { deckId: 7, costs: [{ cost: "{R}", copies: 8 }], theoryCosts: [] },
];
const FOLDERS: DeckFolder[] = [
  { id: 10, parentId: null, name: "Commander", sortOrder: 0 },
  { id: 11, parentId: 10, name: "Bracket 3", sortOrder: 0 },
  { id: 12, parentId: null, name: "Old", sortOrder: 1 },
];

let qc: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

function seed(decks: readonly DeckRow[] = DECKS) {
  qc.setQueryData(deckListKey, decks);
  qc.setQueryData(deckPipCostsKey, PIPS);
  qc.setQueryData(deckCommanderIdentitiesKey, IDENTITIES);
  qc.setQueryData(deckFoldersKey, FOLDERS);
}

function draw(
  config: unknown = null,
  {
    fit = fitFor(4, 4),
    still = false,
    onConfig = vi.fn(),
  }: {
    fit?: WidgetFit;
    still?: boolean;
    onConfig?: (fields: Record<string, unknown>) => void;
  } = {},
) {
  return render(
    <DeckColorsWidget
      widget={widget(config)}
      fit={fit}
      editing={false}
      still={still}
      onConfig={onConfig}
    />,
    { wrapper },
  );
}

function row(key: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[${COMBO_ROW_ATTR}="${key}"]`);
  if (el === null) throw new Error(`no row for "${key}"`);
  return el;
}

/** The decks a row draws, by name, in the order drawn. */
function decksIn(key: string): string[] {
  return [...row(key).querySelectorAll<HTMLElement>(`[${DECK_CHIP_ATTR}]`)].map(
    (chip) => (chip.getAttribute("aria-label") ?? chip.textContent ?? "").split(" · ")[0],
  );
}

beforeEach(() => {
  deckList.mockReset().mockResolvedValue([]);
  deckPipCosts.mockReset().mockResolvedValue([]);
  deckCommanderIdentities.mockReset().mockResolvedValue([]);
  deckFolderList.mockReset().mockResolvedValue([]);
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  useAppStore.setState(useAppStore.getInitialState(), true);
  useAppStore.setState({ activeView: "home" });
});

describe("DeckColorsWidget", () => {
  describe("the sheet", () => {
    it("draws every one of the 32 combinations, the empty ones included", () => {
      seed();
      draw();
      expect(document.querySelectorAll(`[${COMBO_ROW_ATTR}]`)).toHaveLength(32);
      expect(decksIn("WUBRG")).toEqual([]);
      expect(within(row("WUBRG")).getByText("No deck")).toBeInTheDocument();
    });

    it("files a Commander deck by its commander and a deck without one by its cards", () => {
      seed();
      draw();
      expect(decksIn("WBR")).toEqual(["Lightning"]);
      expect(decksIn("R")).toEqual(["Burn"]);
      expect(decksIn("WU")).toEqual(["Azorius A", "Azorius B", "Azorius C"]);
    });

    it("says how many combinations have a deck", () => {
      seed();
      draw();
      expect(screen.getByText("5 of 32 colors · 7 decks")).toBeInTheDocument();
    });

    it("draws the declared bracket and the deck's tags, and hides them when switched off", () => {
      seed();
      const { unmount } = draw();
      expect(within(row("U")).getByText("B3")).toBeInTheDocument();
      expect(within(row("U")).getByText("No GC")).toBeInTheDocument();
      expect(within(row("U")).getByText("+1")).toBeInTheDocument();
      unmount();

      draw({ bracket: false, tags: false });
      expect(within(row("U")).queryByText("B3")).toBeNull();
      expect(within(row("U")).queryByText("No GC")).toBeNull();
    });

    it("leaves empty combinations off when asked", () => {
      seed();
      draw({ empty: false });
      expect(document.querySelectorAll(`[${COMBO_ROW_ATTR}]`)).toHaveLength(5);
    });

    it("drops the combination names on a two-cell tile, where the symbols are the name", () => {
      seed();
      const { unmount } = draw();
      expect(within(row("WU")).getByText("Azorius", { selector: "[aria-hidden]" })).toBeTruthy();
      unmount();
      draw(null, { fit: fitFor(2, 4) });
      expect(within(row("WU")).queryByText("Azorius", { selector: "[aria-hidden]" })).toBeNull();
    });
  });

  describe("pressing and arranging", () => {
    it("opens a deck in the editor", async () => {
      seed();
      draw();
      await userEvent.click(within(row("W")).getByRole("button", { name: /^Bruna/ }));
      expect(useAppStore.getState().activeView).toBe("decks");
      expect(useAppStore.getState().openDeckId).toBe(1);
    });

    it("moves a deck one place with Ctrl+arrow, storing the row's new order", () => {
      seed();
      const onConfig = vi.fn();
      draw(null, { onConfig });
      const chip = within(row("WU")).getByRole("button", { name: /^Azorius A/ });
      fireEvent.keyDown(chip, { key: "ArrowRight", ctrlKey: true });
      expect(onConfig).toHaveBeenCalledWith({ deckOrder: [5, 4, 6] });
    });

    it("draws the reader's arrangement", () => {
      seed();
      draw({ deckOrder: [6, 4] });
      expect(decksIn("WU")).toEqual(["Azorius C", "Azorius A", "Azorius B"]);
    });

    it("ignores a plain arrow, which is left for a caret walk", () => {
      seed();
      const onConfig = vi.fn();
      draw(null, { onConfig });
      fireEvent.keyDown(within(row("WU")).getByRole("button", { name: /^Azorius A/ }), {
        key: "ArrowRight",
      });
      expect(onConfig).not.toHaveBeenCalled();
    });

    it("shows one deck a combination under First only, and the rest on request", async () => {
      seed();
      draw({ limit: "first" });
      expect(decksIn("WU")).toEqual(["Azorius A"]);
      await userEvent.click(screen.getByRole("button", { name: "Show 2 more decks in Azorius" }));
      expect(decksIn("WU")).toEqual(["Azorius A", "Azorius B", "Azorius C"]);
    });

    it("draws a catalogue preview with nothing to press", () => {
      seed();
      draw(null, { still: true });
      expect(within(row("WU")).queryAllByRole("button")).toEqual([]);
      expect(decksIn("WU")).toHaveLength(3);
    });
  });

  describe("which decks count", () => {
    it("counts only the chosen folders, and their subfolders", () => {
      seed();
      draw({ scope: "chosen", folderIds: [10] });
      expect(decksIn("W")).toEqual(["Bruna"]);
      expect(decksIn("WBR")).toEqual(["Lightning"]);
      expect(decksIn("WU")).toEqual([]);
      expect(decksIn("R")).toEqual([]);
    });

    it("asks for folders when none are chosen", () => {
      seed();
      draw({ scope: "chosen" });
      expect(screen.getByText(NOTHING_CHOSEN)).toBeInTheDocument();
    });

    it("says so when there are no decks at all", () => {
      seed([]);
      draw();
      expect(screen.getByText(NO_DECKS)).toBeInTheDocument();
    });

    it("says it is loading while a read is out", () => {
      deckList.mockReturnValue(new Promise(() => {}));
      draw();
      expect(screen.getByText(LOADING)).toBeInTheDocument();
    });

    it("says why when the colours cannot be read", async () => {
      qc.setQueryData(deckListKey, DECKS);
      qc.setQueryData(deckPipCostsKey, PIPS);
      deckCommanderIdentities.mockRejectedValue("database is locked");
      draw();
      expect(
        await screen.findByText("Couldn't read your decks' colors — database is locked"),
      ).toBeInTheDocument();
    });
  });
});

describe("DeckColorsWidgetSettings", () => {
  function settings(config: unknown, onConfig = vi.fn()) {
    render(<DeckColorsWidgetSettings widget={widget(config)} onConfig={onConfig} />, { wrapper });
    return onConfig;
  }

  it("points at the scope row while every deck counts", () => {
    seed();
    settings(null);
    expect(
      screen.getByText("Set Which decks to Chosen folders… to count only some folders."),
    ).toBeInTheDocument();
  });

  it("ticks a folder into the whitelist", async () => {
    seed();
    const onConfig = settings({ scope: "chosen" });
    await userEvent.click(screen.getByRole("button", { name: /Folders to count/ }));
    await userEvent.click(await screen.findByRole("option", { name: /Commander › Bracket 3/ }));
    expect(onConfig).toHaveBeenCalledWith({ folderIds: [11], scope: "chosen" });
  });

  it("stores subfolders off as false and back on as absence", async () => {
    seed();
    const onConfig = settings({ scope: "chosen", folderIds: [10] });
    await userEvent.click(screen.getByRole("checkbox", { name: "Include subfolders" }));
    expect(onConfig).toHaveBeenCalledWith({ subfolders: false });
  });

  it("offers to reset the arrangement once there is one", async () => {
    seed();
    const onConfig = settings({ deckOrder: [2, 1] });
    await userEvent.click(screen.getByRole("button", { name: "Reset deck order" }));
    expect(onConfig).toHaveBeenCalledWith({ deckOrder: undefined });
  });
});
