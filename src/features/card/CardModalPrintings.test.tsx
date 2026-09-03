import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { CardDetail, Printing } from "@/lib/ipc";
import { MARKETPLACES } from "@/lib/marketplace";
import type { PaneDeckContext } from "@/lib/store";

/**
 * The grouping preference, which is an `app_meta` row behind a query.
 *
 * Mocked at `ipc` rather than at `usePrintingGroupBy`, so the hook's own narrowing, optimism and
 * refusal behaviour are exercised here exactly as they are in the shipped window — the same
 * boundary `.storybook/CLAUDE.md` puts the fake under, one layer down.
 */
const printingGroupBy = vi.hoisted(() => vi.fn());
const setPrintingGroupBy = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: { printingGroupBy, setPrintingGroupBy },
}));

import { CardModalPrintings } from "./CardModalPrintings";
import type { CardModalScope } from "./cardModalScope";

const USD = MARKETPLACES.tcgplayer;

const deckRow: PaneDeckContext = {
  deckId: 1,
  categoryId: 2,
  categoryName: "Burn spells",
  cardId: "c1",
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

const card = {
  id: "c1",
  oracleId: "o1",
  name: "Lightning Bolt",
  setCode: "lea",
  setName: "Limited Edition Alpha",
  collectorNumber: "161",
  rarity: "common",
  layout: "normal",
  lang: "en",
  manaCost: "{R}",
  cmc: 1,
  typeLine: "Instant",
  oracleText: "Lightning Bolt deals 3 damage to any target.",
  illustrationId: null,
  artist: "Christopher Rush",
  releasedAt: "1993-08-05",
  legalities: null,
  finishPrices: { nonfoil: null, foil: null, etched: null },
  finishes: null,
  promoTypes: null,
  imageStatus: null,
  faces: [],
} satisfies CardDetail;

/** One printing, with every field `Printing` requires and only the interesting ones named. */
function printing(over: Partial<Printing> & Pick<Printing, "id">): Printing {
  return {
    setCode: "lea",
    setName: "Limited Edition Alpha",
    collectorNumber: "161",
    releasedAt: "1993-08-05",
    rarity: "common",
    illustrationId: null,
    artist: "Christopher Rush",
    lang: "en",
    finishes: '["nonfoil"]',
    finishPrices: { nonfoil: null, foil: null, etched: null },
    promo: false,
    promoTypes: null,
    fullArt: false,
    frameEffects: null,
    borderColor: null,
    layout: "normal",
    ...over,
  };
}

/**
 * Two artists over three printings, which is the smallest list where grouping is visible at all:
 * one group of two and one of one, so a build that drew every printing under one heading and a
 * build that drew one heading per printing both fail.
 */
const ALPHA = printing({ id: "c1" });
const BETA = printing({
  id: "c2",
  setCode: "leb",
  setName: "Limited Edition Beta",
  finishPrices: { nonfoil: 410.5, foil: null, etched: null },
});
const RETRO = printing({
  id: "c3",
  setCode: "2x2",
  setName: "Double Masters 2022",
  collectorNumber: "117",
  releasedAt: "2022-07-08",
  artist: "Christopher Moeller",
  rarity: "uncommon",
});

let client: QueryClient;

function Wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function renderList(props: Partial<Parameters<typeof CardModalPrintings>[0]> = {}) {
  return render(
    <CardModalPrintings
      card={card}
      scope={searchScope}
      items={[ALPHA, BETA, RETRO]}
      total={3}
      loading={false}
      error={null}
      marketplace={USD}
      onPick={vi.fn()}
      {...props}
    />,
    { wrapper: Wrapper },
  );
}

beforeEach(() => {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  printingGroupBy.mockReset().mockResolvedValue("artist");
  setPrintingGroupBy.mockReset().mockResolvedValue(undefined);
});

/**
 * The card modal's printings list — the control the `Printing` combobox used to be, and the
 * reason the modal's main column is no longer empty.
 *
 * Everything below is about the two things this list has that a picker did not: the printings are
 * all on screen at once, in an order the reader chose, and each row says what pressing it will do.
 */
describe("CardModalPrintings", () => {
  it("draws one heading per group, in the mode the reader stored", async () => {
    // **The heading is the whole of what this list has over `AllPrintingsDialog`'s wall**, which
    // flattens `buildPrintingGroups` away because a `CardGrid` cannot interleave one. Two artists
    // over three printings: a build that drew nothing would show zero headings, and one that
    // headed every row would show three.
    renderList();

    await waitFor(() => expect(screen.getByText("Christopher Rush")).toBeInTheDocument());
    expect(screen.getByText("Christopher Moeller")).toBeInTheDocument();
    // The caption counts the groups in the mode's own word — "artists" under Artist. A count of
    // *printings* would read `3` here and would not move when the mode changed.
    expect(screen.getByText(/3 printings · 2 artists/)).toBeInTheDocument();
  });

  it("re-groups when the sort control is changed, and remembers the choice", async () => {
    // The control is the pane's `Group by`, back with the list. `set` puts each printing in its
    // own bucket, so the noun and the count both move — `2 artists` becoming `3 sets` is the one
    // assertion that can tell a re-render from a re-group.
    renderList();
    await waitFor(() => expect(screen.getByText(/2 artists/)).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: "Group printings by" }));
    await userEvent.click(await screen.findByRole("option", { name: "Set" }));

    await waitFor(() => expect(screen.getByText(/3 printings · 3 sets/)).toBeInTheDocument());
    // …and it is written through, so the next card, the next open and `AllPrintingsDialog` all
    // get the order this reader asked for. A local `useState` would pass every assertion above.
    expect(setPrintingGroupBy).toHaveBeenCalledWith("set");
  });

  it("hands a pressed printing's id to the host, unchanged", async () => {
    // **`onPick`'s meaning is the host's** — a swap with a deck row behind the modal, a browse
    // without one — so the whole of this component's contract is that the right id arrives.
    const onPick = vi.fn();
    renderList({ onPick });

    await userEvent.click(await screen.findByRole("button", { name: "Show LEB · 161 · 1993" }));

    expect(onPick).toHaveBeenCalledWith("c2");
  });

  it("says a press will rewrite the deck, and names the pile it would rewrite", async () => {
    // The row *is* the press, so the accessible name is the only place a reader who cannot see
    // the list finds out that clicking rewrites their deck rather than browsing. The pile is
    // named because one printing can sit in the main deck and the sideboard, and the slot being
    // rewritten is the one the modal was opened on.
    renderList({ scope: deckScope });

    expect(
      await screen.findByRole("button", { name: "Use this printing (LEB 161) in Burn spells" }),
    ).toBeInTheDocument();
    // …and the wording is not a blanket one: outside a deck the same row only browses.
    expect(screen.queryByRole("button", { name: /Show LEB/ })).not.toBeInTheDocument();
  });

  it("draws the open printing as a marked row rather than as a press", async () => {
    // A row that navigated to the card already on screen is a control that does nothing, and in
    // a deck context it is worse — `useDeck.swapPrinting` refuses a swap onto the printing the
    // slot already plays. `aria-current` is what says "this one" to a reader who cannot see the
    // gold hairline, which is the only other thing saying it.
    renderList({ scope: deckScope });

    await waitFor(() => expect(screen.getByText("LEA · 161 · 1993")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /LEA · 161/ })).not.toBeInTheDocument();
    const current = screen.getByText("LEA · 161 · 1993").closest("li");
    expect(current).toHaveAttribute("aria-current", "true");
  });

  it("refuses a press while a write is in flight", async () => {
    // Every row that would swap, not only the pressed one: they all send the same `from`
    // printing and the write in flight is in the middle of moving it. `aria-disabled` and a
    // guard rather than the `disabled` attribute, so the control never leaves the tab order
    // under the reader's hand.
    const onPick = vi.fn();
    renderList({ scope: deckScope, busy: true, onPick });

    const row = await screen.findByRole("button", {
      name: "Use this printing (LEB 161) in Burn spells",
    });
    expect(row).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(row);

    expect(onPick).not.toHaveBeenCalled();
  });

  it("prices every finish the printing is sold in, at the marketplace it was read at", async () => {
    // Per finish and never one number standing for both — an etched-only promo is priced in that
    // column and nowhere else. `formatPrice` draws an em dash for a finish this feed has not
    // answered for and never invents a zero.
    renderList({
      items: [
        printing({
          id: "c2",
          setCode: "leb",
          finishes: '["nonfoil","foil"]',
          finishPrices: { nonfoil: 410.5, foil: null, etched: null },
        }),
      ],
      total: 1,
    });

    const row = (await screen.findByRole("button", { name: /LEB/ })).closest("li");
    expect(row).not.toBeNull();
    expect(within(row!).getByText("$410.50")).toBeInTheDocument();
    expect(within(row!).getByText("—")).toBeInTheDocument();
  });

  it("says the page was capped rather than reporting it as the whole list", async () => {
    // `items.length` is capped by the page the host asked for and `total` is not — saying only
    // the first would report a Forest as having 400 printings when it has 862.
    renderList({ total: 862 });

    await waitFor(() =>
      expect(screen.getByText(/3 of 862 printings/)).toBeInTheDocument(),
    );
  });

  it("says a card has no printings rather than drawing nothing", async () => {
    // **This reverses the docked pane's answer on purpose.** There an empty section was a heading
    // taking width off the deck beside it; here the list *is* the modal's main column, and a
    // column that silently disappears leaves exactly the empty space this change exists to fill.
    renderList({ items: [], total: 0 });

    expect(await screen.findByText("This card has no paper printings.")).toBeInTheDocument();
  });

  it("says a refused read beside the heading, and says the card is unaffected", async () => {
    // The printings are a second read behind the card's own: one that fails must not read as the
    // card having failed, because the card is right there above it.
    renderList({ items: [], total: 0, error: "The database is busy with a sync." });

    expect(await screen.findByText(/Could not read the other printings/)).toHaveTextContent(
      "The card above is unaffected.",
    );
    // …and the empty state is not drawn under it: "no printings" and "we could not ask" are two
    // different facts and only one of them is true here.
    expect(
      screen.queryByText("This card has no paper printings."),
    ).not.toBeInTheDocument();
  });
});
