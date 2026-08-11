import { StrictMode, useState } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { monitorForElements } from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import { readDragData } from "@/features/decks/dnd";
import type { CardDetail, CardFace, DeckVariant, Printing, PrintingsResponse } from "@/lib/ipc";
// Type-only, so it is erased before the `vi.mock` below runs — the store's *value* import stays
// under the mock with `CardDetailPane`'s, where the hoisting order needs it.
import type { PaneDeckContext } from "@/lib/store";
import { startDrag } from "@/test-drag";

const detail: CardDetail = {
  id: "p1",
  oracleId: "o1",
  name: "Delver of Secrets // Insectile Aberration",
  setCode: "isd",
  setName: "Innistrad",
  collectorNumber: "51",
  rarity: "common",
  layout: "transform",
  lang: "en",
  manaCost: "{U}",
  cmc: 1,
  typeLine: "Creature — Human Wizard",
  oracleText: "At the beginning of your upkeep…",
  illustrationId: "art-a",
  artist: "Nils Hamm",
  releasedAt: "2011-09-30",
  legalities: '{"modern":"legal","standard":"not_legal"}',
  prices:
    '{"usd":"0.50","usd_foil":"3.00","usd_etched":null,"eur":null,"eur_foil":null,"tix":null}',
  finishes: '["nonfoil","foil"]',
  imageStatus: "highres_scan",
  faces: [
    {
      name: "Delver of Secrets",
      typeLine: "Creature — Human Wizard",
      oracleText: "…",
      manaCost: "{U}",
      artist: "Nils Hamm",
    },
    {
      name: "Insectile Aberration",
      typeLine: "Creature — Human Insect",
      oracleText: "Flying",
      manaCost: null,
      artist: "Nils Hamm",
    },
  ],
};

const printing = (over: Partial<Printing> = {}): Printing => ({
  id: "p1",
  setCode: "isd",
  setName: "Innistrad",
  collectorNumber: "51",
  releasedAt: "2011-09-30",
  rarity: "common",
  illustrationId: "art-a",
  artist: "Nils Hamm",
  lang: "en",
  finishes: '["nonfoil","foil"]',
  prices:
    '{"usd":"0.50","usd_foil":"3.00","usd_etched":null,"eur":null,"eur_foil":null,"tix":null}',
  promo: false,
  fullArt: false,
  frameEffects: null,
  borderColor: "black",
  layout: "transform",
  ...over,
});

/** What `card_printings` answers: a capped page plus the size of the list it came from. */
const page = (items: Printing[], total = items.length): PrintingsResponse => ({ items, total });

/**
 * Enough of a `deck_get` answer for the pane, which asks it one question: is this deck still
 * there? (`useSwapFromPane` mounts the editor's own read so the two surfaces agree.)
 */
const DECK_DETAIL = { deck: { id: 4, name: "Burn" }, cards: [] };

const printings = [printing()];

/**
 * The deck slot the pane is opened from in the swap tests — one deck, one category, one
 * printing.
 *
 * Schema v8 made a category a `deck_categories` row the user names, so a context carries the
 * **id** the write is addressed by *and* the **name** the pane spells out (the fold sentence,
 * and every "Use this printing" label). The pane is a sibling of the deck editor and has no
 * category list to translate one through, which is why both travel — `PaneDeckContext` is where
 * that is argued. `1` and `"Main deck"` mirror the v8 migration's own pile.
 */
const MAIN: PaneDeckContext = {
  deckId: 4,
  categoryId: 1,
  categoryName: "Main deck",
  cardId: "p1",
  variant: "live",
};

const cardDetail = vi.fn();
const cardPrintings = vi.fn();
/**
 * The two deck commands the pane can reach, and it reaches them only when the card was opened
 * from a deck row: the swap its printings rows offer, and the deck read that comes with the
 * hook the swap is mounted from (`useSwapFromPane` takes the whole of `useDeck`, whose query
 * the editor is normally already sharing).
 */
const deckGet = vi.fn();
const deckSwapPrinting = vi.fn();
vi.mock("@/lib/ipc", async (original) => ({
  ...(await original<typeof import("@/lib/ipc")>()),
  ipc: {
    cardDetail: (id: string) => cardDetail(id),
    cardPrintings: (o: string) => cardPrintings(o),
    deckGet: (id: number, variant: DeckVariant) => deckGet(id, variant),
    deckSwapPrinting: (
      deckId: number,
      from: string,
      to: string,
      categoryId: number,
      variant: DeckVariant,
    ) => deckSwapPrinting(deckId, from, to, categoryId, variant),
  },
}));
import { CardDetailPane } from "./CardDetailPane";
import { useAppStore } from "@/lib/store";

function wrap(cardId: string, onClose = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <CardDetailPane cardId={cardId} onClose={onClose} />
    </QueryClientProvider>,
  );
}

/**
 * Open the pane the way the app does — from a control that had the focus — and hand back
 * that control, which is where the pane owes the caret when it closes. Rendering the pane
 * already mounted would capture `<body>` as the opener and prove nothing about either
 * hand-back.
 */
async function openFromAButton({ strict = false } = {}): Promise<HTMLElement> {
  function Harness() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          Open the card
        </button>
        {open && <CardDetailPane cardId="p1" onClose={() => setOpen(false)} />}
      </>
    );
  }
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = (
    <QueryClientProvider client={qc}>
      <Harness />
    </QueryClientProvider>
  );
  render(strict ? <StrictMode>{tree}</StrictMode> : tree);

  const opener = screen.getByRole("button", { name: "Open the card" });
  await userEvent.click(opener);
  await screen.findByRole("complementary", { name: /card details/i });
  return opener;
}

/** The card as it arrives, with the given fields replaced. */
const card = (over: Partial<CardDetail>): CardDetail => ({ ...detail, ...over });

const face = (over: Partial<CardFace>): CardFace => ({
  name: "",
  typeLine: null,
  oracleText: null,
  manaCost: null,
  artist: null,
  ...over,
});

beforeEach(() => {
  cardDetail.mockReset();
  cardPrintings.mockReset();
  // A deck the read can find: a `deck_get` that answers nothing means the deck was deleted,
  // and the pane stops offering swaps it could only have refused (see the `gone` test).
  deckGet.mockReset().mockResolvedValue(DECK_DETAIL);
  deckSwapPrinting.mockReset().mockResolvedValue({ folded: false, quantity: 4 });
  useAppStore.setState(useAppStore.getInitialState());
});

describe("CardDetailPane", () => {
  it("shows the card, its artist and the required copyright line", async () => {
    cardDetail.mockResolvedValue(detail);
    cardPrintings.mockResolvedValue(page(printings));

    wrap("p1");

    expect(
      await screen.findByText("Delver of Secrets // Insectile Aberration"),
    ).toBeInTheDocument();
    // Scryfall's image policy: the artist and the source have to be identifiable in the
    // same interface that shows the art. Deleting either line is a policy violation, not
    // a style change.
    expect(screen.getByText(/Illustrated by Nils Hamm/)).toBeInTheDocument();
    expect(
      screen.getByText(/Card images © Wizards of the Coast · Data © Scryfall/),
    ).toBeInTheDocument();
  });

  it("flips a double-faced card to the back image", async () => {
    cardDetail.mockResolvedValue(detail);
    cardPrintings.mockResolvedValue(page(printings));

    wrap("p1");
    const flip = await screen.findByRole("button", { name: /flip/i });
    expect(screen.getByAltText(/Delver of Secrets/)).toHaveAttribute(
      "src",
      expect.stringContaining("/display/p1/0"),
    );

    await userEvent.click(flip);

    await waitFor(() =>
      expect(screen.getByAltText(/Insectile Aberration/)).toHaveAttribute(
        "src",
        expect.stringContaining("/display/p1/1"),
      ),
    );
    // The back's rules text comes with it: a flip that changes only the picture leaves the
    // front's abilities sitting under the back's art.
    expect(screen.getByText("Creature — Human Insect")).toBeInTheDocument();
    expect(screen.queryByText("Creature — Human Wizard")).not.toBeInTheDocument();
  });

  /**
   * The pane blanks its art while a card it has never opened is fetched, so the obvious path
   * hides this — but a card already in the query cache is handed over *in the same render*,
   * with no pending state to unmount the picture. Browsing back to a card you just looked at
   * is therefore the one path where the pane can be left painting the previous card's art
   * under the new card's name, and it is also the most common one.
   */
  it("never leaves the last card's art on screen when a cached card is reopened", async () => {
    const bolt: CardDetail = {
      ...detail,
      id: "p2",
      name: "Lightning Bolt",
      layout: "normal",
      faces: [
        {
          name: "Lightning Bolt",
          typeLine: "Instant",
          oracleText: "Deal 3 damage to any target.",
          manaCost: "{R}",
          artist: "Christopher Rush",
        },
      ],
    };
    cardDetail.mockImplementation((id: string) => Promise.resolve(id === "p1" ? detail : bolt));
    cardPrintings.mockResolvedValue(page(printings));

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const paneFor = (id: string) => (
      <QueryClientProvider client={qc}>
        <CardDetailPane cardId={id} onClose={vi.fn()} />
      </QueryClientProvider>
    );
    const { rerender } = render(paneFor("p1"));
    await screen.findByAltText(/Delver of Secrets/);

    // Open the other card, then come back. The second visit to `p1` is answered out of the
    // cache, so the pane never unmounts the picture on the way.
    rerender(paneFor("p2"));
    const boltArt = await screen.findByAltText("Lightning Bolt");
    rerender(paneFor("p1"));

    const delverArt = await screen.findByAltText(/Delver of Secrets/);
    expect(delverArt).not.toBe(boltArt);
    expect(boltArt).not.toBeInTheDocument();
  });

  it("prices each finish from its own key", async () => {
    cardDetail.mockResolvedValue(detail);
    cardPrintings.mockResolvedValue(page(printings));

    wrap("p1");

    // $0.50 nonfoil and $3.00 foil, never one number for both — `price_usd`'s fallback
    // chain would price this plain copy at its foil rate.
    const [nonfoil, foil] = await screen.findAllByRole("definition");
    expect(nonfoil).toHaveTextContent("$0.50");
    expect(foil).toHaveTextContent("$3.00");
  });

  it("shows a legality chip for modern and none for standard", async () => {
    cardDetail.mockResolvedValue(detail);
    cardPrintings.mockResolvedValue(page(printings));

    wrap("p1");

    expect(await screen.findByText("modern")).toBeInTheDocument();
    expect(screen.queryByText("standard")).not.toBeInTheDocument();
  });

  /**
   * The grid's rarity gem is `aria-hidden` — it is decoration on a tile whose name says
   * everything. This pane is the one place a rarity is *read*, so here it is a word.
   */
  it("says the rarity rather than only tinting a dot with it", async () => {
    cardDetail.mockResolvedValue(detail);
    cardPrintings.mockResolvedValue(page(printings));

    wrap("p1");

    expect(await screen.findByText("common")).toHaveTextContent("Rarity: common");
  });

  /**
   * The backend caps a printings list at 400 rows and sends the full count beside it.
   * Without the caption a Forest reads as a card with 400 printings, and nothing on screen
   * contradicts it.
   */
  it("says what a truncated printings list is a truncation of", async () => {
    cardDetail.mockResolvedValue(detail);
    cardPrintings.mockResolvedValue(page(printings, 862));

    wrap("p1");

    expect(await screen.findByText(/1 of 862 printings/)).toBeInTheDocument();
  });

  /**
   * `list_printings` returns every language — Lightning Bolt's 62 paper printings include
   * three that are not English. An unbadged row claims to be the English printing at that
   * collector number, which is a different card to own.
   */
  it("badges a printing that is not in English", async () => {
    cardDetail.mockResolvedValue(detail);
    cardPrintings.mockResolvedValue(
      page([printing(), printing({ id: "p2", lang: "ja", collectorNumber: "51b" })]),
    );

    wrap("p1");

    expect(await screen.findByText("ja")).toBeInTheDocument();
    // English is the assumption, so saying it on 59 of 62 rows is noise.
    expect(screen.queryByText("en")).not.toBeInTheDocument();
  });

  it("groups printings that share an artwork, and counts both", async () => {
    cardDetail.mockResolvedValue(detail);
    cardPrintings.mockResolvedValue(
      page([
        printing({ id: "a", illustrationId: "art-a", artist: "Christopher Rush" }),
        printing({ id: "b", illustrationId: "art-a", artist: "Christopher Rush" }),
        printing({ id: "c", illustrationId: "art-b", artist: "Rebecca Guay" }),
      ]),
    );

    wrap("p1");

    // Awaited on the caption, not on the section: the section is rendered while the list
    // is still loading, so finding it proves nothing about the rows inside it yet.
    expect(await screen.findByText(/3 printings · 2 artworks/)).toBeInTheDocument();
    const list = within(screen.getByRole("region", { name: /printings/i }));
    const groups = list.getAllByRole("list");
    expect(groups).toHaveLength(2);
    expect(within(groups[0]).getAllByRole("listitem")).toHaveLength(2);
    // The artwork's identity is its illustrator — "Artwork 1 / Artwork 2" would be a
    // number the reader cannot check against anything.
    expect(list.getByText("Christopher Rush")).toBeInTheDocument();
    expect(list.getByText("Rebecca Guay")).toBeInTheDocument();
  });

  /**
   * Escape is a keyboard word, and the pane it dismisses holds the focus. Without the
   * hand-back the caret lands on `<body>` and the next Tab restarts from the top of the
   * app, several hundred cards away from the one the reader was looking at.
   */
  it("closes on Escape and hands focus back to whatever opened it", async () => {
    cardDetail.mockResolvedValue(detail);
    cardPrintings.mockResolvedValue(page(printings));

    const opener = await openFromAButton();

    // Focus moves in, so the pane's own controls are the next thing Tab reaches.
    expect(screen.getByRole("complementary", { name: /card details/i })).toHaveFocus();

    await userEvent.keyboard("{Escape}");

    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  /**
   * The same hand-back under StrictMode, which is how the app actually runs in development
   * — and where it was broken for two plans without a single test noticing.
   *
   * StrictMode runs a mount effect twice: mount, unmount, mount. The first run had already
   * pulled the caret into the pane, so the second recorded the **pane** as its own opener;
   * `close()` then focused an element that was unmounting and the caret landed on `<body>`.
   * Seen in the running app on 2026-08-06 — every Escape out of the pane, from every view.
   */
  it("hands focus back under StrictMode, where the mount effect runs twice", async () => {
    cardDetail.mockResolvedValue(detail);
    cardPrintings.mockResolvedValue(page(printings));

    const opener = await openFromAButton({ strict: true });

    await userEvent.keyboard("{Escape}");

    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it("closes from the button and hands focus back the same way", async () => {
    cardDetail.mockResolvedValue(detail);
    cardPrintings.mockResolvedValue(page(printings));

    const opener = await openFromAButton();
    await userEvent.click(screen.getByRole("button", { name: /close card details/i }));

    // The close button is about to unmount with the caret on it, which drops focus to
    // `<body>` exactly as Escape would — so it owes the same hand-back.
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  /**
   * A `split`, `adventure` or `flip` card has two faces printed on one side of one piece
   * of cardboard. Offering to flip it shows a card back, and showing only the first face's
   * text hides half the card.
   */
  it("shows both halves of a split card and offers no flip", async () => {
    cardDetail.mockResolvedValue(
      card({
        name: "Fire // Ice",
        layout: "split",
        faces: [
          face({ name: "Fire", typeLine: "Instant", oracleText: "Deals 2 damage divided…" }),
          face({ name: "Ice", typeLine: "Instant", oracleText: "Tap target permanent." }),
        ],
      }),
    );
    cardPrintings.mockResolvedValue(page(printings));

    wrap("p1");

    expect(await screen.findByText("Fire")).toBeInTheDocument();
    expect(screen.getByText("Ice")).toBeInTheDocument();
    expect(screen.getByText("Tap target permanent.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /flip/i })).not.toBeInTheDocument();
  });

  /**
   * Rust keeps a nameless face in its slot rather than dropping it, because the flip
   * control indexes `faces` directly. The control has to survive the face it was kept for.
   */
  it("still flips a card whose back face has no name", async () => {
    cardDetail.mockResolvedValue(
      card({ faces: [face({ name: "Delver of Secrets" }), face({ name: "" })] }),
    );
    cardPrintings.mockResolvedValue(page(printings));

    wrap("p1");

    const flip = await screen.findByRole("button", { name: /flip/i });
    expect(flip).toHaveTextContent("Flip to the other face");

    await userEvent.click(flip);

    // The card's own name is the fallback: an `alt` of "" is an image with no description.
    expect(screen.getByAltText("Delver of Secrets // Insectile Aberration")).toBeInTheDocument();
  });

  it("says so when the id is not in the database rather than showing an empty pane", async () => {
    cardDetail.mockResolvedValue(null);

    wrap("gone");

    expect(await screen.findByText(/not in the card database/i)).toBeInTheDocument();
    // Nothing to ask about: the oracle id is unknown, so no printings request goes out.
    expect(cardPrintings).not.toHaveBeenCalled();
  });

  it("reports a card that could not be read", async () => {
    cardDetail.mockRejectedValue("database is locked");

    wrap("p1");

    expect(await screen.findByRole("alert")).toHaveTextContent(/database is locked/);
  });

  /**
   * The carryover fold: the printings list is the fastest way to record "I have the Alpha
   * one", and it can only be that if each row adds *its own* printing. The button is built
   * from the row rather than from the card the pane is about — those are different cards to
   * own, at different collector numbers, in different sets.
   */
  it("offers to add each printing from its own row", async () => {
    cardDetail.mockResolvedValue(detail);
    cardPrintings.mockResolvedValue(
      page([printing(), printing({ id: "p2", setCode: "2ed", collectorNumber: "162" })]),
    );

    wrap("p1");

    expect(
      await screen.findByRole("button", {
        name: /^Add Delver of Secrets.*\(ISD 51\) to collection/,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /^Add Delver of Secrets.*\(2ED 162\) to collection/ }),
    ).toBeInTheDocument();
  });

  /**
   * The Escape handshake where it actually lives: a popup standing inside the pane. Without
   * the capture-phase consumption one press closes both, and the reader loses the card they
   * were adding from.
   */
  it("keeps the pane open when Escape closes a quick-add popup inside it", async () => {
    cardDetail.mockResolvedValue(detail);
    cardPrintings.mockResolvedValue(page(printings));

    const opener = await openFromAButton();
    const add = await screen.findByRole("button", { name: /^Add Delver of Secrets/ });
    await userEvent.click(add);
    expect(await screen.findByRole("dialog")).toBeInTheDocument();

    await userEvent.keyboard("{Escape}");

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: /card details/i })).toBeInTheDocument();
    expect(add).toHaveFocus();

    // And the second press is the pane's, exactly as it is for the set filter.
    await userEvent.keyboard("{Escape}");

    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  /**
   * A printings row is *that printing*, and can be carried off the list — spec §1's fourth
   * source, and the only one where the reader picks a piece of cardboard rather than a card.
   *
   * Two rows, two payloads: the id is the row's own and the name is the card's, because a
   * `Printing` has no name of its own and every row of this list is the same card. A
   * registration that closed over the pane's card instead would drag ISD 51 from every row,
   * which is the failure the `draggable="true"` attribute cannot see.
   */
  it("carries each printing off its own row", async () => {
    cardDetail.mockResolvedValue(detail);
    cardPrintings.mockResolvedValue(
      page([printing(), printing({ id: "p2", setCode: "2ed", collectorNumber: "162" })]),
    );

    const { container } = wrap("p1");
    // A row's line is set, number *and* year, so it is matched loosely — the exact string
    // "ISD · 51" belongs to the card's own heading above the list.
    await screen.findByText(/2ED · 162/);

    const rows = [...container.querySelectorAll('[draggable="true"]')];
    expect(rows).toHaveLength(2);

    const carried: Record<string, unknown>[] = [];
    const stop = monitorForElements({ onDragStart: ({ source }) => carried.push(source.data) });
    for (const row of rows) {
      const held = await startDrag(row);
      await held.cancel();
    }
    stop();

    expect(carried.map(readDragData)).toEqual([
      // The **card's** type line on both rows, not the printing's: a `Printing` carries none,
      // and which pile a card belongs in is a fact about the card rather than about the piece of
      // cardboard it was picked up from.
      { kind: "card", cardId: "p1", name: detail.name, typeLine: detail.typeLine },
      { kind: "card", cardId: "p2", name: detail.name, typeLine: detail.typeLine },
    ]);
  });

  /**
   * The printings list is a second request, and it can fail on its own — a lock, an ingest
   * mid-swap. The card in front of the reader must stay on screen when it does.
   */
  it("keeps the card when only the printings fail", async () => {
    cardDetail.mockResolvedValue(detail);
    cardPrintings.mockRejectedValue("database is locked");

    wrap("p1");

    expect(
      await screen.findByText("Delver of Secrets // Insectile Aberration"),
    ).toBeInTheDocument();
    expect(await screen.findByText(/could not read the other printings/i)).toBeInTheDocument();
  });
});

/**
 * A printings row is first of all a way to *look at* that printing: clicking it re-anchors
 * the pane onto the row's card. Navigation inside the pane, so the deck row the card was
 * opened from — and the swap offers it carries — survives the trip (`store.test.ts` pins the
 * write itself; these pin the rows).
 */
describe("browsing the printings list", () => {
  const PRINTINGS = [printing(), printing({ id: "p2", setCode: "m10", collectorNumber: "146" })];

  it("shows the printing a row is clicked on", async () => {
    cardDetail.mockResolvedValue(detail);
    cardPrintings.mockResolvedValue(page(PRINTINGS));

    wrap("p1");
    await userEvent.click(await screen.findByRole("button", { name: "Show M10 · 146" }));

    expect(useAppStore.getState().selectedCardId).toBe("p2");
  });

  /** The current printing is where the reader already is: its row offers no trip, and its
   *  facts are plain text rather than a control. */
  it("offers no click on the row the pane is already showing", async () => {
    cardDetail.mockResolvedValue(detail);
    cardPrintings.mockResolvedValue(page(PRINTINGS));

    wrap("p1");

    // Every other row is a trip; the pane's own printing is not offered one.
    expect(await screen.findByRole("button", { name: "Show M10 · 146" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Show ISD/ })).not.toBeInTheDocument();
  });

  it("keeps the deck row while the reader browses", async () => {
    cardDetail.mockResolvedValue(detail);
    cardPrintings.mockResolvedValue(page(PRINTINGS));
    useAppStore.getState().openCardFromDeck(MAIN);

    wrap("p1");
    await userEvent.click(await screen.findByRole("button", { name: "Show M10 · 146" }));

    expect(useAppStore.getState().selectedCardId).toBe("p2");
    expect(useAppStore.getState().paneDeckContext).toEqual(MAIN);
  });

  /** The row's own controls keep their clicks to themselves: a press on the quick-add is not
   *  a request to show that printing. */
  it("does not navigate from a press on a row's quick-add", async () => {
    cardDetail.mockResolvedValue(detail);
    cardPrintings.mockResolvedValue(page(PRINTINGS));
    useAppStore.getState().setSelectedCardId("p1");

    wrap("p1");
    const row = (await screen.findByRole("button", { name: "Show M10 · 146" })).closest(
      "li",
    ) as HTMLElement;
    await userEvent.click(within(row).getByRole("button", { name: /^Add / }));

    expect(useAppStore.getState().selectedCardId).toBe("p1");
  });
});

/**
 * "Use this printing" — the printings list read as a way to *change* the deck rather than only
 * to look at it (spec §2).
 *
 * The affordance exists only when the card was opened from a deck row, because only then is
 * there a slot to rewrite. Everywhere else the same list is what it always was.
 */
describe("the printings list, opened from a deck row", () => {
  const SWAPPABLE = [printing(), printing({ id: "p2", setCode: "m10", collectorNumber: "146" })];

  /** The store's one context write, as the deck editor's category columns make it. */
  function fromDeckRow(cardId = "p1") {
    useAppStore.getState().openCardFromDeck({ ...MAIN, cardId });
  }

  /** The row a printing is drawn in — where its own action and its own refusal belong. */
  const rowOf = (control: HTMLElement) => control.closest("li") as HTMLElement;

  const useIt = () =>
    screen.getByRole("button", { name: "Use this printing (M10 146) in Main deck" });
  /** The same button while its own write is in flight — the visible label changes, so the
   *  accessible name has to change with it (WCAG 2.5.3). */
  const swapping = () => screen.getByRole("button", { name: "Swapping… (M10 146) in Main deck" });

  /**
   * A card opened from a search tile, the collection or the wishlist has no deck row behind it,
   * and a swap needs one — so the list keeps every bit of its old behaviour and adds nothing.
   */
  it("offers no swap when the card was not opened from a deck", async () => {
    cardDetail.mockResolvedValue(detail);
    cardPrintings.mockResolvedValue(page(SWAPPABLE));

    wrap("p1");

    expect(await screen.findByText("ISD · 51")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /use this printing/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/this deck uses this printing/i)).not.toBeInTheDocument();
    // And no deck is read for a pane that has no deck behind it.
    expect(deckGet).not.toHaveBeenCalled();
  });

  /**
   * With a row behind it, every printing offers itself — except the one the deck already holds,
   * which says so instead. Two states in one column down the list, so the answer to "which one
   * is in my deck" is read rather than deduced from which row has no button.
   */
  it("marks the printing the deck holds and offers every other one", async () => {
    cardDetail.mockResolvedValue(detail);
    cardPrintings.mockResolvedValue(page(SWAPPABLE));
    fromDeckRow();

    wrap("p1");

    expect(await screen.findByText("This deck uses this printing")).toBeInTheDocument();
    // On the deck's own row, and on no other.
    expect(rowOf(screen.getByText("This deck uses this printing"))).toHaveTextContent("ISD · 51");
    expect(screen.getAllByRole("button", { name: /^Use this printing/ })).toHaveLength(1);
    expect(rowOf(useIt())).toHaveTextContent("M10 · 146");
  });

  /**
   * The write itself: the slot the pane was opened from, and the printing that was pressed.
   *
   * And then the pane **re-anchors**. The reader asked for the deck to use this printing, so
   * the card in front of them becomes it — art, prices, set and all — and the mark moves onto
   * the row they pressed. Leaving the pane on the old printing would show the card the deck no
   * longer has, with the row they just filled sitting under a button offering to fill it again.
   */
  it("swaps the deck's row to the printing that was pressed, and follows it", async () => {
    cardDetail.mockResolvedValue(detail);
    cardPrintings.mockResolvedValue(page(SWAPPABLE));
    fromDeckRow();

    wrap("p1");
    await userEvent.click(await screen.findByRole("button", { name: /^Use this printing/ }));

    expect(deckSwapPrinting).toHaveBeenCalledWith(4, "p1", "p2", MAIN.categoryId, "live");
    await waitFor(() => expect(useAppStore.getState().selectedCardId).toBe("p2"));
    expect(useAppStore.getState().paneDeckContext).toEqual({ ...MAIN, cardId: "p2" });
  });

  /**
   * **The list the row is in, and not whichever one the hook defaults to.**
   *
   * Schema v8 made a deck two lists and put `variant` in `DECK_CARD_GRAIN`, so a slot is four
   * things. `PaneDeckContext` named three of them for one task and `useSwapFromPane` filled the
   * fourth with its `live` default — which is refused where the theory row has no live twin, and,
   * where the same printing sits in the same category of *both* lists, quietly rewrites the live
   * row while the reader is looking at the theory one and reports success.
   *
   * The pane cannot tell those two cases apart and must not try: it swaps the row it was opened
   * from. This is that, from the only surface that presses it.
   */
  it("swaps the theory row when the pane was opened from one", async () => {
    cardDetail.mockResolvedValue(detail);
    cardPrintings.mockResolvedValue(page(SWAPPABLE));
    useAppStore.getState().openCardFromDeck({ ...MAIN, variant: "theory" });

    wrap("p1");
    await userEvent.click(await screen.findByRole("button", { name: /^Use this printing/ }));

    expect(deckSwapPrinting).toHaveBeenCalledWith(4, "p1", "p2", MAIN.categoryId, "theory");
    // And the re-anchor keeps it: the pane is still showing a theory row afterwards, so a
    // second press addresses the same list rather than falling back to `live`.
    await waitFor(() => expect(useAppStore.getState().paneDeckContext?.variant).toBe("theory"));
  });

  /**
   * **A press on "Use this printing" is a press on the button.**
   *
   * The row is the drag handle now, and Chromium starts a drag from the nearest draggable
   * *ancestor* of whatever was pressed — so without the mark, a press here that travelled five
   * pixels would carry the printing off instead of swapping the deck's row to it, and the
   * click would never be delivered. This is the one control this list grew after the drag did,
   * which is exactly the case `cardDraggable`'s marked exclusion exists for.
   */
  it("does not drag the row when the press landed on its swap button", async () => {
    cardDetail.mockResolvedValue(detail);
    cardPrintings.mockResolvedValue(page(SWAPPABLE));
    fromDeckRow();

    wrap("p1");
    const use = await screen.findByRole("button", { name: /^Use this printing/ });
    const row = rowOf(use);

    const held = await startDrag(row, { pressOn: use });
    expect(held.started).toBe(false);
    await held.cancel();
    expect(deckSwapPrinting).not.toHaveBeenCalled();

    // And the row itself still is one: the guard is a control's press, not a row's.
    const again = await startDrag(row, { pressOn: within(row).getByText(/M10 · 146/) });
    expect(again.started).toBe(true);
    await again.cancel();
  });

  /**
   * A refusal is said **beside the row that was pressed**, which is where the reader is looking
   * — the docked search panel's add says its own refusals the same way, and for the same reason
   * a banner at the top of the pane would not: forty rows, one of them refused, and nothing on
   * screen to say which.
   *
   * And the context does not move: the deck still holds the printing it held, so the mark stays
   * where it was and the pane goes on showing the card it was showing.
   */
  it("says why beside the row it was pressed on, and leaves the deck row where it was", async () => {
    cardDetail.mockResolvedValue(detail);
    cardPrintings.mockResolvedValue(page(SWAPPABLE));
    deckSwapPrinting.mockRejectedValue("That deck is not there any more.");
    fromDeckRow();

    wrap("p1");
    await userEvent.click(await screen.findByRole("button", { name: /^Use this printing/ }));

    const refusal = await screen.findByRole("alert");
    expect(refusal).toHaveTextContent(
      "Could not use this printing — That deck is not there any more.",
    );
    expect(rowOf(refusal)).toHaveTextContent("M10 · 146");
    expect(useAppStore.getState().selectedCardId).toBe("p1");
    expect(useAppStore.getState().paneDeckContext).toEqual(MAIN);
    // The mark has not moved either: the deck holds what it held.
    expect(rowOf(screen.getByText("This deck uses this printing"))).toHaveTextContent("ISD · 51");
  });

  /**
   * One press is one swap, however many times it is pressed.
   *
   * The guard is not only about double-clicks: while a swap is in flight every *other* row's
   * button is disabled too, because they would all be sent the same `from` printing — the one
   * the write in flight is in the middle of moving. The second write would be refused by the
   * backend for a row that no longer exists, which is a true sentence about a press the reader
   * should never have been allowed to make.
   */
  it("presses once, however many times it is pressed", async () => {
    cardDetail.mockResolvedValue(detail);
    cardPrintings.mockResolvedValue(page(SWAPPABLE));
    deckSwapPrinting.mockReturnValue(new Promise(() => {}));
    fromDeckRow();

    wrap("p1");
    const button = await screen.findByRole("button", { name: /^Use this printing/ });
    await userEvent.click(button);
    await userEvent.click(button);

    expect(deckSwapPrinting).toHaveBeenCalledTimes(1);
    // It says what it is doing while it does it — in the visible label *and* in the accessible
    // name, which `swapping()` is querying by: a name that still said "Use this printing" over
    // a button reading "Swapping…" is a control voice control can no longer press.
    expect(swapping()).toBeDisabled();
    expect(swapping()).toHaveTextContent("Swapping…");
  });

  /**
   * The disabled-on-press hazard, in the shape it takes **inside a dismissible layer**: a
   * browser blurs a control that disables itself with no `relatedTarget` at all, so the caret
   * lands on `<body>` — and this button is inside the card pane, whose Escape hand-back is the
   * app's most-repaired piece of focus plumbing. A reader who pressed a row, was refused, and
   * pressed Escape would be closing the pane from nowhere, with the sentence they had not
   * finished reading going with it.
   *
   * So the button takes the caret back when the write settles, and only from `<body>` — a
   * reader who has moved on in the meantime owns where they are. `DeckStats`' send button is
   * the same guard outside a layer; this is the one the pane needs.
   */
  it("takes the caret back after the swap it disabled itself for", async () => {
    cardDetail.mockResolvedValue(detail);
    cardPrintings.mockResolvedValue(page(SWAPPABLE));
    let refuse!: (reason: string) => void;
    deckSwapPrinting.mockReturnValue(
      new Promise((_resolve, reject) => {
        refuse = reject;
      }),
    );
    fromDeckRow();

    wrap("p1");
    const button = await screen.findByRole("button", { name: /^Use this printing/ });
    await userEvent.click(button);

    // What a browser does to a focused control that becomes disabled and jsdom does not: blurs
    // it with no `relatedTarget` at all, leaving the caret on `<body>`. jsdom will not blur a
    // control that is already disabled — `blur()` returns early on an element that is not a
    // focusable area — so the caret is walked off it through the pane, which is where the DOM
    // ends up either way, and the event a real blur would carry is delivered on top. Without
    // this the test passes over a missing hand-back, because the caret never left.
    const pane = screen.getByRole("complementary", { name: /card details/i });
    pane.focus();
    pane.blur();
    fireEvent.focusOut(button, { relatedTarget: null });
    expect(document.body).toHaveFocus();

    refuse("The database is busy with a sync — try again in a moment.");

    expect(await screen.findByRole("alert")).toHaveTextContent("The database is busy with a sync");
    await waitFor(() => expect(useIt()).toHaveFocus());
  });
});
