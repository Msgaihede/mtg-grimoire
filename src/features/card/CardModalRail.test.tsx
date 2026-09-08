import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { openExternal } from "@/lib/externalLinks";
import type { CardDetail } from "@/lib/ipc";
import { MARKETPLACES, type Marketplace } from "@/lib/marketplace";
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
    marketplace?: Marketplace;
  } = {},
) {
  return render(
    <CardModalRail
      card={over.card ?? BOLT}
      scope={over.scope ?? searchScope}
      actions={over.actions ?? []}
      counts={over.counts ?? counts}
      marketplace={over.marketplace ?? MARKETPLACES.tcgplayer}
    />,
  );
}

describe("the card modal's options rail", () => {
  /**
   * The four read-only overlays are one store field with one writer, so the rail's whole job for
   * them is to name which — see `AppState.cardOverlay`. Asserting against the live store rather
   * than a spy is what makes this break if that field is renamed or if a fifth surface starts
   * keeping open-state of its own.
   *
   * **Each assertion reads the *value*, and that is the whole of what this file can catch here.**
   * All four of these rows call the identical `openCardOverlay`, so a check that only counted the
   * calls — or that only asserted the writer ran — passes against a `Combos` row wired to
   * `"legality"`, which is a row that opens the wrong dialog and looks completely correct in the
   * DOM. The store read is what tells the four apart.
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

    // Issue #359's row. Last of the four because it went last in the block, which is the one
    // thing about its placement a reader could have learnt from the other three.
    await user.click(screen.getByRole("button", { name: "Combos" }));
    expect(useAppStore.getState().cardOverlay).toBe("combos");
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
   * The block sits at the **foot** of the rail at the rung that draws it, which is the mockup's
   * `margin-top: auto` — and an auto margin absorbs a flex line's *free* space, so it means
   * nothing in a column that is as tall as its own content.
   *
   * **That is why this asserts a pair.** The two classes are one change: `mt-auto` on the section
   * with a content-height root is the fix present and inert — the block draws directly under the
   * options list, in the window, with this file's other tests all green. jsdom resolves no
   * container query and gives every box a height of 0, so nothing here can see either half work;
   * the class **is** the behaviour at this layer and the pixels were read in the running window.
   */
  it("pins the grimoire block to the foot of the rail, and gives it a column to be pinned in", () => {
    const { container } = renderRail();
    const grimoire = screen.getByText("In your grimoire").closest("section");
    const root = container.firstElementChild;

    expect(grimoire?.classList.contains("@min-[1200px]/card:mt-auto")).toBe(true);
    // The root's floor, at the same rung. Without it the margin above has no space to take.
    expect(root?.classList.contains("@min-[1200px]/card:min-h-full")).toBe(true);
  });

  /**
   * The rail is a list rather than a fixed set of slots — spec §7 — so the count of entries is a
   * property of the surface and not of this file. A component with seven named slots plus an
   * "extras" hole would draw the deck editor's eight and the search wall's seven differently;
   * this draws one list and the surface says how long it is — **nine** below, because the fixture
   * hands it two actions where the editor hands one (`CardDetailModal`'s `railActions`).
   *
   * **The order is asserted whole, and that is what places `Combos` rather than merely finding
   * it.** A `getByRole` for the row passes wherever it sits, including four rows down among the
   * `Open on …` links — where it would read as somewhere this app sends you rather than a surface
   * it draws. `toEqual` against the full list is the only assertion here that goes red for a row
   * that is present and in the wrong block.
   */
  it("appends the surface's own entries after the seven every surface has", async () => {
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
      "Combos",
      "Open on Scryfall",
      "Open on EDHREC",
      "Open on TCGplayer",
      "Set as commander",
      "Set deck image",
    ]);

    await user.click(screen.getByRole("button", { name: "Set as commander" }));
    expect(setCommander).toHaveBeenCalledOnce();
  });

  /**
   * The other half of the block boundary, and the half the order above cannot see: `external` is
   * what draws the arrow glyph, and a row can be in the right place with the wrong mark on it.
   *
   * The glyph is `aria-hidden`, so it is invisible to every name query in this file — which is
   * deliberate (it must not join the accessible name) and is exactly why it needs an assertion of
   * its own rather than falling out of one. Asserted as a **pair**: `Combos` bare and
   * `Open on Scryfall` marked, because a `svg` count of zero also passes on a rail that has
   * stopped drawing the mark at all.
   */
  it("draws no outbound arrow on Combos, and still draws one on the links", () => {
    renderRail();

    const combos = screen.getByRole("button", { name: "Combos" });
    const scryfall = screen.getByRole("button", { name: "Open on Scryfall" });

    expect(combos.querySelector("svg")).toBeNull();
    expect(scryfall.querySelector("svg")).not.toBeNull();
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
   * Issue #402's first row. The URL is `edhrecCardUrl`'s, unmocked, so this reads the real
   * builder — EDHREC's own router by card *name*, which is the shape Scryfall publishes as a
   * card's EDHREC link — and a rail that started slugging names itself would fail here.
   */
  it("opens the card on EDHREC by name, through the same outbound call", async () => {
    const user = userEvent.setup();
    renderRail();

    await user.click(screen.getByRole("button", { name: "Open on EDHREC" }));

    expect(vi.mocked(openExternal)).toHaveBeenCalledExactlyOnceWith(
      "https://edhrec.com/route/?cc=Lightning%20Bolt",
    );
  });

  /**
   * Issue #402's second row, and it is **the selected marketplace, not TCGplayer**: the row is
   * named after the marketplace Settings quotes prices from and opens that site's search for the
   * card, which is what the context menu's `Open on` ladder already does. A non-default
   * marketplace here is what proves the label and the URL both follow the prop rather than the
   * default — with TCGplayer both would pass against a rail that ignored it.
   */
  it("names the selected marketplace and opens that site's search for the card", async () => {
    const user = userEvent.setup();
    renderRail({ marketplace: MARKETPLACES.cardkingdom });

    expect(screen.queryByRole("button", { name: "Open on TCGplayer" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Open on Card Kingdom" }));

    expect(vi.mocked(openExternal)).toHaveBeenCalledExactlyOnceWith(
      "https://www.cardkingdom.com/catalog/search?search=header&filter%5Bname%5D=Lightning%20Bolt",
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
