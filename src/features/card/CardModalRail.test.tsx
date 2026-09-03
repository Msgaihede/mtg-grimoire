import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { openExternal } from "@/lib/externalLinks";
import type { CardDetail } from "@/lib/ipc";
import { useAppStore, type PaneDeckContext } from "@/lib/store";
import { CardModalRail, type RailAction, type RailCounts } from "./CardModalRail";
import type { CardModalScope } from "./cardModalScope";

/**
 * The one call in this component that leaves the app, faked at the module that owns it — the
 * shape `cardMenu.test.tsx` already uses. `scryfallCardUrl` is deliberately *not* faked, so the
 * assertion below reads the real permalink builder and would notice a rail that started
 * assembling its own URL.
 */
vi.mock("@/lib/externalLinks", async (original) => ({
  ...(await original<typeof import("@/lib/externalLinks")>()),
  openExternal: vi.fn(() => Promise.resolve()),
}));

/**
 * The store is module-level state, so a test that writes it leaves it written for whatever runs
 * next — `cardModalScope.test.ts`'s line, and the same reason: every test here reads
 * `cardOverlay` back out of the real store rather than a mock, so a leftover value from the
 * previous test would make the next one pass without pressing anything.
 */
beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState());
  vi.mocked(openExternal).mockClear();
});

const BOLT: CardDetail = {
  id: "p1",
  oracleId: "o1",
  name: "Lightning Bolt",
  setCode: "LEA",
  setName: "Limited Edition Alpha",
  collectorNumber: "161",
  rarity: "common",
  layout: "normal",
  lang: "en",
  manaCost: "{R}",
  cmc: 1,
  typeLine: "Instant",
  oracleText: "Deal 3 damage.",
  illustrationId: "art-a",
  artist: "Christopher Rush",
  releasedAt: "1993-08-05",
  legalities: '{"modern":"legal"}',
  finishPrices: { nonfoil: 1.5, foil: null, etched: null },
  finishes: '["nonfoil"]',
  promoTypes: null,
  imageStatus: "highres_scan",
  faces: [],
};

/** Six required fields — `DeckVariant` is `"live" | "theory"` and `finish` is not optional. */
const deckRow: PaneDeckContext = {
  deckId: 1,
  categoryId: 2,
  categoryName: "Burn spells",
  cardId: "p1",
  variant: "live",
  finish: null,
};

const searchScope: CardModalScope = {
  surface: "search",
  deck: null,
  quantity: null,
  deckControls: false,
};

const deckScope: CardModalScope = {
  surface: "deck",
  deck: deckRow,
  quantity: "deck",
  deckControls: true,
};

const counts: RailCounts = { owned: 2, wished: 1, decks: 3, deck: null };

function renderRail(
  over: {
    scope?: CardModalScope;
    actions?: readonly RailAction[];
    counts?: RailCounts;
    card?: CardDetail;
  } = {},
) {
  return render(
    <CardModalRail
      card={over.card ?? BOLT}
      scope={over.scope ?? searchScope}
      actions={over.actions ?? []}
      counts={over.counts ?? counts}
    />,
  );
}

describe("the card modal's options rail", () => {
  /**
   * The three read-only overlays are one store field with one writer, so the rail's whole job for
   * them is to name which — see `AppState.cardOverlay`. Asserting against the live store rather
   * than a spy is what makes this break if that field is renamed or if a fourth surface starts
   * keeping open-state of its own.
   */
  it("opens each overlay through the store's single writer", async () => {
    const user = userEvent.setup();
    renderRail();

    await user.click(screen.getByRole("button", { name: "Legality" }));
    expect(useAppStore.getState().cardOverlay).toBe("legality");

    await user.click(screen.getByRole("button", { name: "Oracle tags" }));
    expect(useAppStore.getState().cardOverlay).toBe("oracleTags");

    await user.click(screen.getByRole("button", { name: "Card text" }));
    expect(useAppStore.getState().cardOverlay).toBe("cardText");
  });

  /**
   * Artboard `2c` (906–1501px) drops the counts and `1a` (1502+) keeps them, which lands as the
   * fold at `@min-[1200px]/card` measured on the panel.
   *
   * **jsdom resolves no container query and every box is 0**, so this asserts the *class* rather
   * than a measurement — at this layer the class **is** the behaviour, and the real widths are
   * settled by driving the window. `classList.contains`, never `className.includes`: a substring
   * test passes on `@min-[1200px]/card:flex` when asked about `flex` and would make the first
   * assertion vacuous.
   */
  it("hides the grimoire counts at the middle rung and shows them at the widest", () => {
    renderRail();
    const grimoire = screen.getByText("In your grimoire").closest("section");

    expect(grimoire).not.toBeNull();
    expect(grimoire?.classList.contains("hidden")).toBe(true);
    expect(grimoire?.classList.contains("@min-[1200px]/card:flex")).toBe(true);
  });

  /**
   * The rail is a list rather than a fixed set of slots — spec §7 — so the count of entries is a
   * property of the surface and not of this file. A component with four named slots plus an
   * "extras" hole would draw the deck's six and the search's four differently; this draws one
   * list and the surface says how long it is.
   */
  it("appends the surface's own entries after the four every surface has", async () => {
    const setCommander = vi.fn();
    const user = userEvent.setup();
    renderRail({
      scope: deckScope,
      actions: [
        { label: "Set as commander", onSelect: setCommander },
        { label: "Set deck image", onSelect: vi.fn() },
      ],
    });

    const entries = screen.getAllByRole("button").map((b) => b.textContent);
    expect(entries).toEqual([
      "Legality",
      "Oracle tags",
      "Card text",
      "Open on Scryfall",
      "Set as commander",
      "Set deck image",
    ]);

    await user.click(screen.getByRole("button", { name: "Set as commander" }));
    expect(setCommander).toHaveBeenCalledOnce();
  });

  /**
   * `openExternal` is the single call that leaves the app — never a raw `window.open`, which in a
   * Tauri webview navigates the app's own window rather than the reader's browser. The URL is
   * `scryfallCardUrl`'s, unmocked, so a rail that built `scryfall.com/card/LEA/161` itself would
   * fail here on the un-lowercased set code.
   */
  it("opens the printing's own Scryfall page through the app's one outbound call", async () => {
    const user = userEvent.setup();
    renderRail();

    await user.click(screen.getByRole("button", { name: "Open on Scryfall" }));

    expect(vi.mocked(openExternal)).toHaveBeenCalledExactlyOnceWith(
      "https://scryfall.com/card/lea/161",
    );
  });

  /**
   * The deck line is the one part of the block that is not a fact about the whole grimoire, so it
   * is drawn only where there is a row to be a fact about. One text node rather than a label and a
   * number in two spans: a CSS `gap` between two elements is not a word separator, so the pair
   * computes as `4×in Burn spells` and a reader gets it read out that way too.
   */
  it("names the deck pile the card was opened out of, and only there", () => {
    const { unmount } = renderRail({ scope: searchScope });
    expect(screen.queryByText(/in Burn spells/)).not.toBeInTheDocument();
    unmount();

    renderRail({ scope: deckScope, counts: { ...counts, deck: 4 } });
    expect(screen.getByText("4× in Burn spells · Actual")).toBeInTheDocument();
  });

  /** Each of the three figures says what it counts, beside the number. */
  it("says what each grimoire figure counts", () => {
    renderRail({ counts: { owned: 2, wished: 1, decks: 3, deck: null } });

    expect(screen.getByText("Owned").nextElementSibling).toHaveTextContent("2");
    expect(screen.getByText("Wished").nextElementSibling).toHaveTextContent("1");
    expect(screen.getByText("In decks").nextElementSibling).toHaveTextContent("3");
  });
});
