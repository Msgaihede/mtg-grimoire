import { StrictMode, useState } from "react";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { monitorForElements } from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import { readDragData } from "@/features/decks/dnd";
import type {
  CardDetail,
  CardFace,
  DeckFinish,
  DeckVariant,
  Printing,
  PrintingsResponse,
} from "@/lib/ipc";
import type { MarketplaceId } from "@/lib/marketplace";
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
  // What the backend answered for the marketplace the pane asked at: one figure per finish,
  // `null` where that marketplace does not price it. Nothing on this side looks a key up.
  finishPrices: { nonfoil: 0.5, foil: 3.0, etched: null },
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
  finishPrices: { nonfoil: 0.5, foil: 3.0, etched: null },
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
  finish: null,
  variant: "live",
};

const cardDetail = vi.fn();
const cardPrintings = vi.fn();
/**
 * What the pane reads the selected marketplace with. Its own `vi.fn()` because two tests below
 * change what it answers — the pane's prices arrive priced, so the marketplace is a *request*
 * parameter here rather than a formatting choice, and a test about Mana Pool's numbers has to
 * be able to say so before the read happens.
 */
const getMarketplace = vi.fn();
/**
 * Both feeds' rows, which `useMarketplace` reads beside the setting. Answered empty: the pane
 * says nothing about a feed's state, so this exists only so the hook's query resolves rather
 * than rejecting on a `vi.fn()` that is not there.
 */
const marketplaceFeedStatus = vi.fn();
/**
 * The grouping preference, which is an `app_meta` row rather than component state — the pane's
 * body is keyed on the card, so a reader clicking down the printings list remounts it on every
 * row and the chosen order has to outlive that (`usePrintingGroupBy` is where that is argued,
 * and where the read's and the write's failure modes are pinned).
 */
const printingGroupBy = vi.fn();
const setPrintingGroupBy = vi.fn();
/**
 * The three deck commands the pane can reach, and it reaches them only when the card was opened
 * from a deck row: the swap its printings rows offer, the **finish** its foil button writes, and
 * the deck read that comes with the hook both are mounted from (`useSwapFromPane` takes the
 * whole of `useDeck`, whose query the editor is normally already sharing).
 */
const deckGet = vi.fn();
const deckSwapPrinting = vi.fn();
const deckSetCardFinish = vi.fn();
/**
 * The write behind the card menu's "Add to → Collection", which is the pane's own — reached
 * through `useCardMenuDeps`, mounted here rather than by a page.
 *
 * It exists so a **refusal** can be driven end to end. The menu cannot report its own: `ctx.run`
 * closes the panel before a row's handler runs, so by the time the answer arrives there is no
 * menu left to put a sentence in, and the surface has to draw it or the add fails silently.
 */
const collectionAdd = vi.fn();
vi.mock("@/lib/ipc", async (original) => ({
  ...(await original<typeof import("@/lib/ipc")>()),
  ipc: {
    cardDetail: (id: string, marketplace: MarketplaceId) => cardDetail(id, marketplace),
    cardPrintings: (o: string, marketplace: MarketplaceId) => cardPrintings(o, marketplace),
    getMarketplace: () => getMarketplace(),
    marketplaceFeedStatus: () => marketplaceFeedStatus(),
    printingGroupBy: () => printingGroupBy(),
    setPrintingGroupBy: (mode: string) => setPrintingGroupBy(mode),
    deckGet: (id: number, variant: DeckVariant) => deckGet(id, variant),
    deckSwapPrinting: (
      deckId: number,
      from: string,
      to: string,
      categoryId: number,
      variant: DeckVariant,
      finish: DeckFinish,
    ) => deckSwapPrinting(deckId, from, to, categoryId, variant, finish),
    deckSetCardFinish: (
      deckId: number,
      cardId: string,
      categoryId: number,
      variant: DeckVariant,
      fromFinish: DeckFinish,
      toFinish: DeckFinish,
    ) => deckSetCardFinish(deckId, cardId, categoryId, variant, fromFinish, toFinish),
    collectionAdd: (input: unknown) => collectionAdd(input),
  },
}));
/**
 * The two doors the card menu opens, mocked because this file is about **which card** they are
 * asked about rather than what they do. Both really answer a promise, which is what the menu's
 * `run` hands to a `catch` — a `vi.fn()` answering `undefined` would be a fake the code under
 * test could not have been written against.
 */
vi.mock("@/lib/clipboard", () => ({ copyText: vi.fn(() => Promise.resolve()) }));
vi.mock("@/lib/externalLinks", async (original) => ({
  ...(await original<typeof import("@/lib/externalLinks")>()),
  openExternal: vi.fn(() => Promise.resolve()),
}));
import { CardDetailPane } from "./CardDetailPane";
import { CardToDeckProvider } from "./cardMenu";
import { ContextMenuProvider } from "@/components/menu/ContextMenuProvider";
import { copyText } from "@/lib/clipboard";
import { openExternal } from "@/lib/externalLinks";
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
 * The pane under the two providers `App.tsx` mounts above it, in that order.
 *
 * `ContextMenuProvider` is not scenery: `useContextMenu` answers a **no-op** where no provider
 * is above it, so a pane rendered bare would open nothing and pass every assertion below by
 * never being asked. `CardToDeckProvider` is **outside** it because the menu panel is a
 * *sibling* of the menu provider's children — a provider mounted inside would be above every
 * view and above none of the menu's rows.
 */
function wrapWithMenu(cardId: string, onClose = vi.fn()) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <CardToDeckProvider>
        <ContextMenuProvider>
          <CardDetailPane cardId={cardId} onClose={onClose} />
        </ContextMenuProvider>
      </CardToDeckProvider>
    </QueryClientProvider>,
  );
}

/**
 * A right-click, and nothing awaited.
 *
 * A real `MouseEvent` rather than `fireEvent.contextMenu`, because the handler reads
 * `clientX`/`clientY` to place the panel — and `bubbles`, because the handler is on the row or
 * on the pane, never on the glyph the pointer happened to be over.
 */
function rightClick(element: HTMLElement): void {
  element.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
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
  // **Cleared per test, or every assertion about them is an assertion about the whole file.**
  // These two are module mocks rather than the `vi.fn()`s above, so nothing resets them between
  // cases: a `toHaveBeenCalledWith` would then be satisfied by a call some *earlier* test made,
  // and a menu wired to the wrong element would pass by inheriting the right one's evidence.
  // Found by breaking exactly that wiring and watching the suite stay green.
  vi.mocked(copyText).mockClear();
  vi.mocked(openExternal).mockClear();
  // Nobody has chosen one, which is what a fresh install reads — and what every test here but
  // the two feed ones is about.
  getMarketplace.mockReset().mockResolvedValue("tcgplayer");
  marketplaceFeedStatus.mockReset().mockResolvedValue([]);
  // Nobody has picked a grouping either, so the list opens where it always did — by artist.
  printingGroupBy.mockReset().mockResolvedValue("artist");
  setPrintingGroupBy.mockReset().mockResolvedValue(undefined);
  // A deck the read can find: a `deck_get` that answers nothing means the deck was deleted,
  // and the pane stops offering swaps it could only have refused (see the `gone` test).
  deckGet.mockReset().mockResolvedValue(DECK_DETAIL);
  deckSwapPrinting.mockReset().mockResolvedValue({ folded: false, quantity: 4 });
  deckSetCardFinish.mockReset().mockResolvedValue({ folded: false, quantity: 4 });
  collectionAdd.mockReset().mockResolvedValue({ id: 9, quantity: 1, removed: false });
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

  it("prices each finish from its own field", async () => {
    cardDetail.mockResolvedValue(detail);
    cardPrintings.mockResolvedValue(page(printings));

    wrap("p1");

    // $0.50 nonfoil and $3.00 foil, never one number for both — `price_usd`'s fallback
    // chain would price this plain copy at its foil rate.
    const [nonfoil, foil] = await screen.findAllByRole("definition");
    expect(nonfoil).toHaveTextContent("$0.50");
    expect(foil).toHaveTextContent("$3.00");
    // TCGplayer, and it says so: a price is never shown without saying how old it is and whose
    // it is (spec §5).
    expect(screen.getByText("TCGplayer prices as of the last card-data sync.")).toBeInTheDocument();
  });

  /**
   * **The gap this pane used to have, closed.**
   *
   * Card Kingdom's and Mana Pool's prices live in `marketplace_prices` and are unreachable from
   * the webview, so while `card_detail` answered Scryfall's blob every finish here was an em
   * dash on half the picker — with a line explaining why. Both commands take a marketplace now
   * and answer per-finish figures, so this is a column of real numbers.
   *
   * The claim is made from both ends: the reads carry the marketplace, and what comes back is
   * drawn. A pane that dropped the argument would quote TCGplayer under a Mana Pool heading,
   * which is exactly the cross-marketplace fallback the feature refuses — and it would look
   * right.
   */
  it("draws real per-finish numbers on a feed-backed marketplace", async () => {
    getMarketplace.mockResolvedValue("manapool");
    cardDetail.mockResolvedValue(
      card({ finishPrices: { nonfoil: 0.44, foil: 2.71, etched: null } }),
    );
    cardPrintings.mockResolvedValue(
      page([printing({ finishPrices: { nonfoil: 0.44, foil: 2.71, etched: null } })]),
    );

    wrap("p1");

    const [nonfoil, foil] = await screen.findAllByRole("definition");
    expect(nonfoil).toHaveTextContent("$0.44");
    expect(foil).toHaveTextContent("$2.71");
    // Both reads carried it — the printings list is priced too, and it is the half a reader
    // compares printings by.
    await waitFor(() => expect(cardDetail).toHaveBeenCalledWith("p1", "manapool"));
    expect(cardPrintings).toHaveBeenCalledWith("o1", "manapool");
    // A downloaded feed has its own clock, and the as-of line is the one that says so — never
    // the old "this marketplace does not reach here" sentence, which is no longer true.
    expect(
      await screen.findByText("Mana Pool prices as of the last price-feed refresh."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/are not read from/)).not.toBeInTheDocument();
  });

  /**
   * A finish the marketplace does not price is an **em dash**, and it is still the answer.
   *
   * `null` arrives per finish now rather than being derived here, but the rule it stands for did
   * not move: there is no `eur_etched` key in Scryfall's data at all, so an etched card has no
   * Cardmarket price, and quoting its nonfoil euro figure — or its dollar one — would be a price
   * nobody ever gave.
   */
  it("draws an em dash for a finish the selected marketplace does not price", async () => {
    getMarketplace.mockResolvedValue("cardmarket");
    cardDetail.mockResolvedValue(
      card({
        finishes: '["nonfoil","foil","etched"]',
        finishPrices: { nonfoil: 2.1, foil: 2.6, etched: null },
      }),
    );
    cardPrintings.mockResolvedValue(page([]));

    wrap("p1");

    const [nonfoil, foil, etched] = await screen.findAllByRole("definition");
    expect(nonfoil).toHaveTextContent("€2.10");
    expect(foil).toHaveTextContent("€2.60");
    expect(etched).toHaveTextContent("—");
    expect(etched).not.toHaveTextContent("0.00");
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

  /**
   * The default grouping, and the behaviour change under it: the list is cut by **artist**, so
   * two artworks by one hand are one group where the illustration grouping made two — two
   * identically headed groups, which reads as a bug in the pane whatever the reason for it. The
   * fixture is that exact case, and the count line says `artists` because that is what the
   * reader is looking at.
   */
  it("groups printings by artist, merging two artworks by one hand", async () => {
    cardDetail.mockResolvedValue(detail);
    cardPrintings.mockResolvedValue(
      page([
        printing({ id: "a", illustrationId: "art-a", artist: "Christopher Rush" }),
        printing({ id: "b", illustrationId: "art-b", artist: "Christopher Rush" }),
        printing({ id: "c", illustrationId: "art-c", artist: "Rebecca Guay" }),
      ]),
    );

    wrap("p1");

    // Awaited on the caption, not on the section: the section is rendered while the list
    // is still loading, so finding it proves nothing about the rows inside it yet.
    expect(await screen.findByText(/3 printings · 2 artists/)).toBeInTheDocument();
    const list = within(screen.getByRole("region", { name: /printings/i }));
    const groups = list.getAllByRole("list");
    expect(groups).toHaveLength(2);
    // Both of Christopher Rush's, under his one heading — and alphabetically first.
    expect(within(groups[0]).getAllByRole("listitem")).toHaveLength(2);
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
 * The grouping control: one list of rows, and the four ways the reader can ask to read it.
 *
 * The orderings themselves are `printings.ts`'s and are pinned there over fixtures this pane
 * would need forty rows to make. What these are for is the half only the pane can be wrong
 * about: that the control is wired to the list at all, that a group's heading is drawn from the
 * group rather than from the first row in it, and that the mode with **no** headings renders as
 * a flat list rather than as a group whose name failed to load.
 */
describe("grouping the printings list", () => {
  /**
   * Three printings that disagree about everything the modes cut by: two artists, three dates,
   * three sets, three prices — and cheapest-last in the order Rust sends them, so a price sort
   * that did nothing would be visible.
   *
   * No September, deliberately: `en-GB` abbreviates it `Sept` in current CLDR and `Sep` in
   * older, and a heading is not the place to find that out.
   */
  const GROUPED = [
    printing({ releasedAt: "2011-10-04" }),
    printing({
      id: "p2",
      setCode: "m10",
      setName: "Magic 2010",
      collectorNumber: "146",
      releasedAt: "2009-07-17",
      artist: "Christopher Rush",
      illustrationId: "art-b",
      finishes: '["nonfoil"]',
      finishPrices: { nonfoil: 12, foil: null, etched: null },
    }),
    printing({
      id: "p3",
      setCode: "2ed",
      setName: "Unlimited Edition",
      collectorNumber: "162",
      releasedAt: "1993-12-01",
      artist: "Christopher Rush",
      illustrationId: "art-c",
      finishes: '["nonfoil"]',
      finishPrices: { nonfoil: 0.25, foil: null, etched: null },
    }),
  ];

  /** Named for a screen reader alone — the pane has no width for a visible label. */
  const groupBy = () => screen.getByRole("combobox", { name: "Group printings by" });

  const list = () => within(screen.getByRole("region", { name: /printings/i }));

  /**
   * Every group's heading, in the order they are drawn — and `null` for a group that has none,
   * which is the whole of what `price` mode looks like from here.
   */
  const headings = () =>
    list()
      .getAllByRole("list")
      .map((ul) => ul.previousElementSibling?.firstElementChild?.textContent ?? null);

  /** Every row, in the order they are drawn. */
  const rows = () =>
    list()
      .getAllByRole("listitem")
      .map((li) => li.textContent);

  async function openList() {
    cardDetail.mockResolvedValue(detail);
    cardPrintings.mockResolvedValue(page(GROUPED));
    wrap("p1");
    await screen.findByText(/3 printings/);
  }

  it("re-orders the list and re-words the count when another grouping is picked", async () => {
    await openList();
    expect(headings()).toEqual(["Christopher Rush", "Nils Hamm"]);

    await userEvent.selectOptions(groupBy(), "released");

    expect(await screen.findByText(/3 printings · 3 release dates/)).toBeInTheDocument();
    expect(headings()).toEqual(["4 Oct 2011", "17 Jul 2009", "1 Dec 1993"]);
    // And it is remembered: the pane's body is keyed on the card, so a preference this control
    // did not write down would be gone by the next row the reader clicked.
    expect(setPrintingGroupBy).toHaveBeenCalledWith("released");
  });

  /**
   * `price` is the mode that makes no groups — a cheapest-first list has nothing to head its
   * runs with that is not a number already printed on the row.
   */
  it("draws price as one list with no headings at all, cheapest first", async () => {
    await openList();

    await userEvent.selectOptions(groupBy(), "price");

    // The second half of the count line is dropped whole rather than reworded: there is one
    // group here and it has no heading, so "1 price" would be counting something invisible.
    expect(await screen.findByText("3 printings")).toBeInTheDocument();
    expect(headings()).toEqual([null]);
    const order = rows();
    expect(order[0]).toContain("2ED · 162");
    expect(order[1]).toContain("ISD · 51");
    expect(order[2]).toContain("M10 · 146");
  });
});

/**
 * **What this printing looks like shiny** — a view, and nothing more.
 *
 * There is no foil photograph to fetch: Scryfall publishes one image per printing and it is the
 * plain one, so what the toggle turns on is this app's own overlay. It is offered because a
 * reader choosing between forty printings wants to see it, and it says nothing whatever about
 * which finish they own — that question belongs to a collection entry's own `finish`.
 */
describe("the foil view", () => {
  it("offers a printing sold in both finishes as the shiny one, and says which it is showing", async () => {
    cardDetail.mockResolvedValue(card({ finishes: '["nonfoil","foil","etched"]' }));
    cardPrintings.mockResolvedValue(page(printings));

    wrap("p1");

    // Foil over etched where a printing has both: it is the far commoner of the two and the one
    // a reader means by "what does it look like shiny".
    const toggle = await screen.findByRole("button", { name: "View as foil" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");

    await userEvent.click(toggle);

    // The visible words **are** the accessible name here, so they move together — a name that
    // no longer contains its label is a control voice control can no longer press (WCAG 2.5.3).
    expect(screen.getByRole("button", { name: "View as nonfoil" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await userEvent.click(screen.getByRole("button", { name: "View as nonfoil" }));

    expect(screen.getByRole("button", { name: "View as foil" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  /**
   * **Inside the deck editor the button is a write, and it says so.**
   *
   * The pane there is showing the reader's *own copy*, so the control that turns the sheen on is
   * the control that says which object the deck plays. The label is the whole of how a reader
   * can tell the two apart before pressing — `Set as` against `View as` — and `regular` rather
   * than `nonfoil`, because "set as nonfoil" is not a thing anybody says.
   */
  it("sets the deck row's finish where the pane is showing one, and only shows it where it is not", async () => {
    cardDetail.mockResolvedValue(card({ finishes: '["nonfoil","foil"]' }));
    cardPrintings.mockResolvedValue(page(printings));

    // No deck row: the view toggle it has always been, and nothing is written.
    wrap("p1");
    await userEvent.click(await screen.findByRole("button", { name: "View as foil" }));
    expect(deckSetCardFinish).not.toHaveBeenCalled();

    cleanup();
    useAppStore.getState().openCardFromDeck(MAIN);
    wrap("p1");

    const set = await screen.findByRole("button", { name: "Set as foil" });
    expect(set).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(set);

    // The row is addressed by its slot, `finish` included — the pile can hold this printing
    // twice, and the press is about the row the pane was opened from.
    expect(deckSetCardFinish).toHaveBeenCalledWith(4, "p1", MAIN.categoryId, "live", null, "foil");
    // The sheen turns on at the press rather than at the answer, so the label moves with it.
    expect(screen.getByRole("button", { name: "Set as regular" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  /**
   * **The press moves the row's address, so it moves the context with it** — the other half of
   * the 2026-08-18 defect, reached from the pane instead of the deck's menu.
   *
   * A row is addressed by `(deck, category, card, variant, finish)`, and this write changes the
   * fifth part. A context left pointing at the finish that has just been left names no row: the
   * deck editor's mark goes out, and the *next* press of this very button sends `null → null`,
   * which the backend refuses as `SAME_FINISH` — so a toggle that has been pressed once can
   * never be pressed back. Re-anchoring is `swapPrinting`'s answer one axis over.
   */
  it("re-anchors the deck context on the finish it just set, so the toggle comes back", async () => {
    cardDetail.mockResolvedValue(card({ finishes: '["nonfoil","foil"]' }));
    cardPrintings.mockResolvedValue(page(printings));
    useAppStore.getState().openCardFromDeck(MAIN);

    wrap("p1");
    await userEvent.click(await screen.findByRole("button", { name: "Set as foil" }));

    await waitFor(() =>
      expect(useAppStore.getState().paneDeckContext).toEqual({ ...MAIN, finish: "foil" }),
    );

    // The way back: addressed from `foil` because that is the row the deck now holds.
    await userEvent.click(screen.getByRole("button", { name: "Set as regular" }));
    expect(deckSetCardFinish).toHaveBeenLastCalledWith(
      4,
      "p1",
      MAIN.categoryId,
      "live",
      "foil",
      null,
    );
  });

  /** The pane opens on the copy the deck actually plays, rather than on the plain photograph of
   *  it — which is the one thing the `key={cardId}` reset cannot do on its own. */
  it("opens showing the finish the deck row already plays", async () => {
    cardDetail.mockResolvedValue(card({ finishes: '["nonfoil","foil"]' }));
    cardPrintings.mockResolvedValue(page(printings));
    useAppStore.getState().openCardFromDeck({ ...MAIN, finish: "foil" });

    wrap("p1");

    expect(await screen.findByRole("button", { name: "Set as regular" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  /** Browsing the printings list moves the pane onto a card the deck does not hold, so there is
   *  no row for a press to write to and the button goes back to being a view. */
  it("is a view again on a printing the deck does not hold", async () => {
    cardDetail.mockResolvedValue(card({ finishes: '["nonfoil","foil"]' }));
    cardPrintings.mockResolvedValue(page(printings));
    useAppStore.getState().openCardFromDeck(MAIN);

    // The context still names `p1`; the pane is showing `p2`.
    wrap("p2");

    expect(await screen.findByRole("button", { name: "View as foil" })).toBeVisible();
  });

  it("names the etched view where etched is the only shiny finish there is", async () => {
    cardDetail.mockResolvedValue(card({ finishes: '["nonfoil","etched"]' }));
    cardPrintings.mockResolvedValue(page(printings));

    wrap("p1");

    expect(await screen.findByRole("button", { name: "View as etched" })).toBeInTheDocument();
  });

  /**
   * Both exclusions, and neither is an oversight: a **nonfoil-only** printing has nothing to
   * show, and a **foil-only** one already wears the treatment permanently — 12 366 printings
   * exist in no other finish, and a toggle that turned it off would un-say a fact about the
   * object rather than offering a view of it.
   */
  it("offers no foil view where there is nothing to switch between", async () => {
    cardDetail.mockResolvedValue(card({ finishes: '["nonfoil"]' }));
    cardPrintings.mockResolvedValue(page(printings));

    const { unmount } = wrap("p1");
    await screen.findByAltText(/Delver of Secrets/);
    expect(screen.queryByRole("button", { name: /^View as/ })).not.toBeInTheDocument();
    unmount();

    cardDetail.mockResolvedValue(card({ finishes: '["foil"]' }));
    wrap("p1");

    await screen.findByAltText(/Delver of Secrets/);
    expect(screen.queryByRole("button", { name: /^View as/ })).not.toBeInTheDocument();
  });
});

/**
 * A printings row is first of all a way to *look at* that printing: clicking it re-anchors the
 * pane onto the row's card. Navigation inside the pane, and what a row means everywhere the pane
 * was **not** opened from a deck — where the same press rewrites the deck slot instead, which is
 * the describe below (`store.test.ts` pins the write itself; these pin the rows).
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

  /**
   * **A deck that has been deleted turns the list back into a list.**
   *
   * In a deck context a row's click *is* the swap, so this is the one path on which a pane that
   * was opened from a deck row browses at all — and it is a real one: another view can delete
   * the deck while the pane is open, and a press against it could only ever be refused. The
   * offer is withdrawn before it is made (`deckGone` is the read the editor is already doing),
   * the deck stops claiming a printing, and what is left is the list every other pane has.
   */
  it("browses again when the deck behind the pane has been deleted", async () => {
    cardDetail.mockResolvedValue(detail);
    cardPrintings.mockResolvedValue(page(PRINTINGS));
    // The read succeeds and answers nothing, which is what a deleted deck looks like. Loading
    // is not gone, so the row is an offer until this lands.
    deckGet.mockResolvedValue(null);
    useAppStore.getState().openCardFromDeck(MAIN);

    wrap("p1");
    await userEvent.click(await screen.findByRole("button", { name: "Show M10 · 146" }));

    expect(deckSwapPrinting).not.toHaveBeenCalled();
    expect(useAppStore.getState().selectedCardId).toBe("p2");
    // The context itself is untouched — this is still the pane that was opened from a deck row,
    // and it is only the offer that is gone.
    expect(useAppStore.getState().paneDeckContext).toEqual(MAIN);
    expect(screen.queryByText("In deck")).not.toBeInTheDocument();
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
 * to look at it (spec §2), where since `DeckLine`'s deletion **the row itself is the press**.
 *
 * The affordance exists only when the card was opened from a deck row, because only then is
 * there a slot to rewrite. Everywhere else the same list is what it always was — and what it
 * costs, stated where the tests can see it: in a deck context there is no longer any way to
 * *look* at a printing in the pane without committing to it, only to hover it.
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
    expect(screen.queryByText("In deck")).not.toBeInTheDocument();
    // And no deck is read for a pane that has no deck behind it.
    expect(deckGet).not.toHaveBeenCalled();
  });

  /**
   * With a row behind it, every printing offers itself — except the one the deck already holds,
   * which says so instead. Two states in one column down the list, so the answer to "which one
   * is in my deck" is read rather than deduced from which row has no offer.
   *
   * The mark is the badge that replaced `DeckLine`'s sentence, and it is **text rather than
   * colour**: the row's other mark is the gold hairline for the printing the pane is showing,
   * which is a different fact entirely, and a second coloured edge would have collapsed the two.
   * The offer is the row's own name button, whose accessible name is where a reader who cannot
   * see the row finds out that pressing it rewrites a deck.
   */
  it("marks the printing the deck holds and offers every other one", async () => {
    cardDetail.mockResolvedValue(detail);
    cardPrintings.mockResolvedValue(page(SWAPPABLE));
    fromDeckRow();

    wrap("p1");

    expect(await screen.findByText("In deck")).toBeInTheDocument();
    // On the deck's own row, and on no other.
    expect(rowOf(screen.getByText("In deck"))).toHaveTextContent("ISD · 51");
    expect(screen.getAllByRole("button", { name: /^Use this printing/ })).toHaveLength(1);
    expect(rowOf(useIt())).toHaveTextContent("M10 · 146");
  });

  /**
   * And the row it marks is not an offer: pressing it would be a swap of the printing onto
   * itself, which is a write with nothing to do and a pane already showing what it would land
   * on. It is not a trip either — that row *is* where the reader is.
   */
  it("does nothing when the row the deck already holds is pressed", async () => {
    cardDetail.mockResolvedValue(detail);
    cardPrintings.mockResolvedValue(page(SWAPPABLE));
    fromDeckRow();

    wrap("p1");
    await userEvent.click(rowOf(await screen.findByText("In deck")));

    expect(deckSwapPrinting).not.toHaveBeenCalled();
    expect(useAppStore.getState().selectedCardId).toBe("p1");
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

    expect(deckSwapPrinting).toHaveBeenCalledWith(4, "p1", "p2", MAIN.categoryId, "live", null);
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

    expect(deckSwapPrinting).toHaveBeenCalledWith(4, "p1", "p2", MAIN.categoryId, "theory", null);
    // And the re-anchor keeps it: the pane is still showing a theory row afterwards, so a
    // second press addresses the same list rather than falling back to `live`.
    await waitFor(() => expect(useAppStore.getState().paneDeckContext?.variant).toBe("theory"));
  });

  /**
   * **A plain press on the row is a click, and the row is still the drag source.**
   *
   * The swap button is gone and the row is the press — the same row that carries the printing
   * off the list, which is spec §1's fourth drag source. So the two have to stay told apart in
   * both directions: a press that travels five pixels carries the card away, and one that does
   * not is the swap. What keeps a *control* inside the row out of it is its own `data-no-drag`
   * mark, because Chromium starts a drag from the nearest draggable **ancestor** of whatever
   * was pressed — without which a press on the quick-add would carry a printing off instead of
   * opening the popup, and the click would never be delivered at all.
   */
  it("reads a plain press on the row as a click, and still drags from it", async () => {
    cardDetail.mockResolvedValue(detail);
    cardPrintings.mockResolvedValue(page(SWAPPABLE));
    fromDeckRow();

    wrap("p1");
    const row = rowOf(await screen.findByRole("button", { name: /^Use this printing/ }));

    // The quick-add owns its own press: nothing is picked up from it.
    const refused = await startDrag(row, {
      pressOn: within(row).getByRole("button", { name: /^Add / }),
    });
    expect(refused.started).toBe(false);
    await refused.cancel();

    // The row itself still is a drag source — the guard is a control's press, not a row's.
    const held = await startDrag(row);
    expect(held.started).toBe(true);
    await held.cancel();
    expect(deckSwapPrinting).not.toHaveBeenCalled();

    // And a press that stayed still is the swap, which the pane then follows into.
    await userEvent.click(row);

    expect(deckSwapPrinting).toHaveBeenCalledWith(4, "p1", "p2", MAIN.categoryId, "live", null);
    await waitFor(() => expect(useAppStore.getState().selectedCardId).toBe("p2"));
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
    expect(rowOf(screen.getByText("In deck"))).toHaveTextContent("ISD · 51");

    // **And the sentence is not a dead end.** `DeckLine` stopped the click under its refusal,
    // because the row underneath meant *view this printing* and that is not what a reader
    // pressing "Use this printing" asked for. The row now means the same thing the refused
    // press meant, so a click that lands on the sentence is a **retry** — which, for a busy
    // database the reader has just read about, is exactly the next thing they want.
    await userEvent.click(refusal);

    expect(deckSwapPrinting).toHaveBeenCalledTimes(2);
  });

  /**
   * One press is one swap, however many times it is pressed — and the fence is now a paint plus
   * a guard in the handler rather than a button that switched itself off.
   *
   * It is not only about double-clicks: while a write is in flight **every** row that would
   * swap is out of reach, not just the pressed one, because they would all be sent the same
   * `from` printing — the one the write in flight is in the middle of moving. The second write
   * would be refused by the backend for a row that no longer exists, which is a true sentence
   * about a press the reader should never have been allowed to make.
   *
   * **`aria-disabled`, never the attribute** (`src/CLAUDE.md`), and here that rule pays for
   * itself rather than merely being obeyed: `DeckLine`'s button *was* `disabled`, so pressing
   * it dropped it out of the tab order mid-press and the browser blurred it to `<body>` with no
   * `relatedTarget` — the whole of that component's focus hand-back existed to repair what its
   * own attribute broke.
   */
  it("presses once, however many times it is pressed", async () => {
    cardDetail.mockResolvedValue(detail);
    cardPrintings.mockResolvedValue(
      page([...SWAPPABLE, printing({ id: "p3", setCode: "2ed", collectorNumber: "162" })]),
    );
    deckSwapPrinting.mockReturnValue(new Promise(() => {}));
    fromDeckRow();

    wrap("p1");
    await screen.findByText(/3 printings/);
    await userEvent.click(useIt());
    // The same control, still there and still reachable — which is the point of not disabling
    // it — so this is a second real press rather than one the DOM swallowed.
    await userEvent.click(swapping());

    expect(deckSwapPrinting).toHaveBeenCalledTimes(1);
    // It says what it is doing while it does it, and the name is the only place it can: the
    // row's visible text is the printing, so a screen reader hears the press landed here or
    // nowhere.
    expect(swapping()).toHaveAttribute("aria-disabled", "true");
    expect(swapping()).not.toBeDisabled();

    // And the row nobody pressed is out of reach too — greyed, and **refused**: an
    // `aria-disabled` control still delivers its press, so the paint would be a lie without the
    // handler behind it.
    const other = screen.getByRole("button", { name: "Use this printing (2ED 162) in Main deck" });
    expect(other).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(other);

    expect(deckSwapPrinting).toHaveBeenCalledTimes(1);
  });

  /**
   * **The caret, one step after a refusal, for the reader it stranded.**
   *
   * This used to be the common path and used to belong to the pressed button: it disabled
   * itself, the browser blurred it to `<body>` with no `relatedTarget`, the `onError` re-read
   * landed, `deckGone` turned true and every "Use this printing" button — including the one
   * holding the caret — was unmounted. A row that stays a row through all of that strands
   * nobody, so what is left is a **fallback** on the pane rather than a hand-back on a control:
   * anything that replaces the rows while a refusal is on screen (a printings refetch, a card
   * leaving `cards`) drops the caret in front of a sentence the reader can then only leave by
   * Tabbing from the top of the app. The pane is where that sentence lives, so the pane takes
   * the caret — and only out of `<body>`, because a reader who has moved on owns where they are.
   *
   * jsdom cannot produce the unmount that strands it, so the caret is walked off through the
   * DOM, which is where a real one ends up either way, and the guard is asserted on its own
   * terms: the refusal is on screen, the caret is nowhere, and the pane takes it.
   */
  it("takes the caret into the pane when a refusal leaves it on nothing", async () => {
    cardDetail.mockResolvedValue(detail);
    cardPrintings.mockResolvedValue(page(SWAPPABLE));
    // The commonest refusal there is: the deck was deleted from another view. The read that
    // follows the failure is what teaches the pane so — the first one still finds it.
    deckGet.mockResolvedValueOnce(DECK_DETAIL).mockResolvedValue(null);
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
    act(() => button.blur());
    expect(document.body).toHaveFocus();

    refuse("That deck is not there any more.");

    expect(await screen.findByRole("alert")).toHaveTextContent("That deck is not there any more.");
    await waitFor(() =>
      expect(screen.getByRole("complementary", { name: /card details/i })).toHaveFocus(),
    );
    // And the deck that is not there claims nothing: no mark, and no offers to rewrite it.
    expect(screen.queryByText("In deck")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Use this printing/ })).not.toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------------------------------ *
 * The card menu
 * ------------------------------------------------------------------------------------------ */

/**
 * A printing of the same card that the pane is **not** open on — the one fixture the whole of
 * this section turns on.
 *
 * A `Printing` carries a set, a collector number and a finish list and **no name and no oracle
 * id**: it is a printing *of the card the pane is showing*, so both of those come from that
 * `CardDetail`. A row adapter that read only the row would still draw a menu, and "Copy card
 * name" would copy `undefined` — which is why every case below right-clicks *this* row rather
 * than the one the pane is on.
 */
const FOURTH: Printing = printing({
  id: "p2",
  setCode: "4ed",
  setName: "Fourth Edition",
  collectorNumber: "209",
  releasedAt: "1995-04-01",
});

/** The row for a printing the pane is not showing — its own `<li>`, which is where the menu is. */
function rowFor(setCode: string, collectorNumber: string): HTMLElement {
  const button = screen.getByRole("button", { name: `Show ${setCode} · ${collectorNumber}` });
  const row = button.closest("li");
  if (row === null) throw new Error(`no row around ${setCode} ${collectorNumber}`);
  return row;
}

describe("the card menu", () => {
  beforeEach(() => {
    cardDetail.mockResolvedValue(detail);
    cardPrintings.mockResolvedValue(page([printing(), FOURTH]));
  });

  it("names the card the pane is open on, not the printing row", async () => {
    const user = userEvent.setup();
    wrapWithMenu("p1");
    await screen.findByRole("button", { name: "Show 4ED · 209" });

    rightClick(rowFor("4ED", "209"));
    await screen.findByRole("menu");
    await user.click(screen.getByRole("menuitem", { name: "Copy card name" }));

    // A `Printing` carries no name. This is the one adapter that has to read the `CardDetail`
    // too, and getting it wrong copies `undefined` with the menu still looking correct.
    await waitFor(() =>
      expect(vi.mocked(copyText)).toHaveBeenCalledWith("Delver of Secrets // Insectile Aberration"),
    );
    expect(vi.mocked(copyText)).not.toHaveBeenCalledWith(undefined);
  });

  it("links the printing that was right-clicked, not the one the pane is showing", async () => {
    const user = userEvent.setup();
    wrapWithMenu("p1");
    await screen.findByRole("button", { name: "Show 4ED · 209" });

    rightClick(rowFor("4ED", "209"));
    await screen.findByRole("menu");
    await user.click(screen.getByRole("menuitem", { name: "Open on" }));
    await user.click(await screen.findByRole("menuitem", { name: "Scryfall" }));

    // The row's set and collector number — the pane is open on `isd/51`, which is the answer a
    // row adapter that read the card for *everything* would have given.
    expect(vi.mocked(openExternal)).toHaveBeenCalledWith("https://scryfall.com/card/4ed/209");
  });

  /**
   * The other half of the same fact: the oracle id is the **card's**, and a `Printing` has none.
   * A row adapter that sent `null` would draw "View all printings" greyed out with the menu's
   * own sentence beside it — *this printing has left the card database* — over a card that is
   * perfectly healthy, and nothing about the menu would look wrong.
   */
  it("offers the printings row a live View all printings, from the card's oracle id", async () => {
    wrapWithMenu("p1");
    await screen.findByRole("button", { name: "Show 4ED · 209" });

    rightClick(rowFor("4ED", "209"));
    await screen.findByRole("menu");

    expect(screen.getByRole("menuitem", { name: "View all printings" })).not.toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });

  it("does not show a printing when the row is right-clicked", async () => {
    const user = userEvent.setup();
    wrapWithMenu("p1");
    await screen.findByRole("button", { name: "Show 4ED · 209" });

    rightClick(rowFor("4ED", "209"));
    await screen.findByRole("menu");
    // The pane has not moved onto the printing the reader was only asking about.
    expect(useAppStore.getState().selectedCardId).toBeNull();

    // …and the same row really does move it when it is *pressed*, which is what makes the
    // assertion above able to fail.
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Show 4ED · 209" }));
    expect(useAppStore.getState().selectedCardId).toBe("p2");
  });

  /**
   * **The caret comes back to the row the menu was opened on.**
   *
   * `menu()` hands `e.currentTarget` to the panel as the opener, and the panel calls
   * `opener?.focus()` on Escape and before every row it runs — so the opener has to be an
   * element that can *take* focus. This one is an `<li>`, and `focus()` on an `<li>` with no
   * `tabIndex` is a **no-op**: the caret would stay on the panel and land on `<body>` the moment
   * it unmounted, after which the next Tab restarts from the top of the app.
   *
   * It is the same rule the deck tile and the folder row are wired by three files away, where
   * the handler is on a `<button>` precisely because an `<li>` cannot serve. Here the row really
   * is the surface — a printing is pointed at as a whole row, not by its four-character set code
   * — so the `<li>` is made focusable instead of the menu being moved off it.
   */
  it("hands the caret back to the printings row when its menu is dismissed", async () => {
    const user = userEvent.setup();
    wrapWithMenu("p1");
    await screen.findByRole("button", { name: "Show 4ED · 209" });
    const row = rowFor("4ED", "209");

    rightClick(row);
    await screen.findByRole("menu");
    await user.keyboard("{Escape}");

    await waitFor(() => expect(document.activeElement).toBe(row));
  });

  it("opens the open card's own menu from a right-click on its art", async () => {
    const user = userEvent.setup();
    wrapWithMenu("p1");
    const art = await screen.findByAltText("Delver of Secrets");

    rightClick(art);
    await screen.findByRole("menu");
    await user.click(screen.getByRole("menuitem", { name: "Open on" }));
    await user.click(await screen.findByRole("menuitem", { name: "Scryfall" }));

    // The pane's own printing, `isd/51` — not the printing of whichever row happens to be first.
    expect(vi.mocked(openExternal)).toHaveBeenCalledWith("https://scryfall.com/card/isd/51");
  });

  /**
   * The keyboard's door to the same rows. The pane takes the caret as it opens, so Shift+F10
   * with nothing else focused is a press on the pane — and the card the pane is showing is what
   * it has to answer about.
   */
  it("opens the open card's menu on Shift+F10, with the caret on the pane", async () => {
    const user = userEvent.setup();
    wrapWithMenu("p1");
    await screen.findByAltText("Delver of Secrets");
    await waitFor(() =>
      expect(screen.getByRole("complementary", { name: /card details/i })).toHaveFocus(),
    );

    await user.keyboard("{Shift>}{F10}{/Shift}");

    expect(await screen.findByRole("menuitem", { name: "Copy card name" })).toBeInTheDocument();
  });

  it("opens a printings row's menu on Shift+F10, from the row's own handle", async () => {
    const user = userEvent.setup();
    wrapWithMenu("p1");
    const handle = await screen.findByRole("button", { name: "Show 4ED · 209" });

    act(() => handle.focus());
    await user.keyboard("{Shift>}{F10}{/Shift}");
    await screen.findByRole("menu");
    await user.click(screen.getByRole("menuitem", { name: "Open on" }));
    await user.click(await screen.findByRole("menuitem", { name: "Scryfall" }));

    // The row's printing, so the press really did open *that* row's menu rather than the pane's.
    expect(vi.mocked(openExternal)).toHaveBeenCalledWith("https://scryfall.com/card/4ed/209");
  });

  /**
   * **A refused add says so, in the pane.**
   *
   * The menu has nowhere to report it: `ctx.run` closes the panel before a row's handler runs,
   * so the write outlives the surface that started it and the *page* has to draw the sentence.
   * That makes this failure mode a silent one — the reader presses "Collection", nothing is
   * added, and nothing on screen says why — which is exactly what `CardMenuRefusal`'s own doc
   * warns about and exactly what no other case here would catch.
   *
   * Driven through the real `ipc.collectionAdd` rather than a spy on the callback, so what is
   * proved is the whole path: the menu's row, `useCardMenuDeps`' mutation, its `onError`, and
   * the banner this pane draws.
   */
  it("says so in the pane when a menu add is refused", async () => {
    const user = userEvent.setup();
    collectionAdd.mockRejectedValue(new Error("The card database is busy finishing a sync."));
    wrapWithMenu("p1");
    const art = await screen.findByAltText("Delver of Secrets");

    rightClick(art);
    await screen.findByRole("menu");
    await user.click(screen.getByRole("menuitem", { name: "Add to" }));
    // Two finishes on this printing, so the collection row is a submenu rather than a silent add.
    await user.click(await screen.findByRole("menuitem", { name: "Collection" }));
    await user.click(await screen.findByRole("menuitem", { name: "Nonfoil" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not add to your collection — The card database is busy finishing a sync.",
    );
  });

  /* ---------------------------------------------------------------------------------------- *
   * "View all printings" — one destination, and this pane no longer names it
   * ---------------------------------------------------------------------------------------- */

  /**
   * A deck is open behind the pane. `openDeckId` is the test, deliberately **not**
   * `paneDeckContext`: a card opened from the docked search panel carries no deck context and is
   * still inside the editor, where the old route would have closed the deck.
   *
   * `activeView` is moved off its default, and that is not scenery: the store starts on
   * `"search"`, so an assertion that the pane *did not navigate* is satisfied by the initial
   * state and proves nothing. Standing on `"decks"` is what makes both directions visible.
   */
  function insideTheEditor() {
    useAppStore.setState({ openDeckId: 4, selectedCardId: "p1", activeView: "decks" });
  }

  /** Down "View all printings", from whatever menu is open. */
  async function viewAllPrintings(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole("menuitem", { name: /View all printings/ }));
  }

  /**
   * **The whole of the change, asserted from the surface that used to need an exception.**
   *
   * The row had two destinations and both moved the reader: outside the deck editor
   * `requestAllPrintings` wrote `activeView` and cleared `openDeckId` *and* `selectedCardId` in
   * one `set`, so asking which printings a card had closed the deck it was being asked about;
   * inside the editor this pane overrode the dep to keep the answer in its own 384px column.
   * There is one destination now — a modal over whatever is on screen — so the pane hands over
   * the plain deps and the store write is the whole of the behaviour.
   */
  it("asks for the printings modal and moves nothing, from a printings row", async () => {
    const user = userEvent.setup();
    insideTheEditor();
    wrapWithMenu("p1");
    await screen.findByRole("button", { name: "Show 4ED · 209" });

    rightClick(rowFor("4ED", "209"));
    await screen.findByRole("menu");
    await viewAllPrintings(user);

    // The card's oracle id and the card's name, which is what "every printing of this card" is
    // asked by — and neither of which a `Printing` row carries.
    expect(useAppStore.getState().printingsRequest).toEqual({
      oracleId: "o1",
      name: "Delver of Secrets // Insectile Aberration",
      deck: null,
    });
    // Nothing else moved: the deck is still open, the view has not changed, and the pane is
    // still on the card it was on rather than on the row that was right-clicked.
    expect(useAppStore.getState().openDeckId).toBe(4);
    expect(useAppStore.getState().activeView).toBe("decks");
    expect(useAppStore.getState().selectedCardId).toBe("p1");
  });

  /**
   * **The greyed row is gone, and that is the point rather than a loosened assertion.**
   *
   * *"This pane is already showing them"* existed only because one of the two destinations could
   * be the surface you were standing on: `viewPrinting` would have set `selectedCardId` to the
   * value it already held and nothing at all would have happened. The modal is somewhere else,
   * with filters and a wall of art, so the row is a real offer on the pane's own card — and the
   * fence that remains is `printingsOracleId`, which only the modal sets.
   */
  it("offers the modal on the pane's own card, where the row used to be greyed", async () => {
    const user = userEvent.setup();
    insideTheEditor();
    wrapWithMenu("p1");
    const art = await screen.findByAltText("Delver of Secrets");

    rightClick(art);
    await screen.findByRole("menu");

    // A greyed row's accessible name includes its reason, so the regex is what tells "live" from
    // "missing" — an exact-name query would fail either way and read as the row being absent.
    const row = screen.getByRole("menuitem", { name: /View all printings/ });
    expect(row).not.toHaveAttribute("aria-disabled", "true");

    await user.click(row);

    expect(useAppStore.getState().printingsRequest).toEqual({
      oracleId: "o1",
      name: "Delver of Secrets // Insectile Aberration",
      deck: null,
    });
    // Still open, still on the same card, still on the deck the reader was building.
    expect(useAppStore.getState().selectedCardId).toBe("p1");
    expect(useAppStore.getState().openDeckId).toBe(4);
    expect(useAppStore.getState().activeView).toBe("decks");
  });

  /**
   * The other half of "moves nothing", with no deck open: the pane used to navigate here, and
   * that write closed the pane itself. Standing on `"decks"` so that a navigation would be a
   * change rather than the store's own default.
   */
  it("navigates nowhere and keeps the pane open when no deck is open", async () => {
    const user = userEvent.setup();
    useAppStore.setState({ activeView: "decks", selectedCardId: "p1" });
    wrapWithMenu("p1");
    const art = await screen.findByAltText("Delver of Secrets");
    expect(useAppStore.getState().openDeckId).toBeNull();

    rightClick(art);
    await screen.findByRole("menu");
    await viewAllPrintings(user);

    expect(useAppStore.getState().printingsRequest).toEqual({
      oracleId: "o1",
      name: "Delver of Secrets // Insectile Aberration",
      deck: null,
    });
    expect(useAppStore.getState().activeView).toBe("decks");
    // The write that used to send the reader to the Search wall closed the pane on the way.
    expect(useAppStore.getState().selectedCardId).toBe("p1");
  });

  /**
   * The row's own key handling is **composed with** the menu's, never replaced by it: the set
   * button is the row's keyboard handle, so a press that opened the menu and stopped the row
   * from being shown would be a menu bought with the affordance it was added beside.
   */
  it("still shows the printing on Enter after the menu key is wired to the same handle", async () => {
    const user = userEvent.setup();
    wrapWithMenu("p1");
    const handle = await screen.findByRole("button", { name: "Show 4ED · 209" });

    act(() => handle.focus());
    await user.keyboard("{Enter}");

    expect(useAppStore.getState().selectedCardId).toBe("p2");
  });
});
