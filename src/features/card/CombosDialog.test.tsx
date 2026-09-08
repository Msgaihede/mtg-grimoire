import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { openExternal } from "@/lib/externalLinks";
import type {
  CardCombo,
  CardCombosPage,
  CardCombosQuery,
  CardDetail,
  ComboPiece,
  ComboStatus,
} from "@/lib/ipc";
import type { MarketplaceId } from "@/lib/marketplace";

const cardDetail = vi.fn();
const combosForCard = vi.fn();
const combosStatus = vi.fn();
const getMarketplace = vi.fn();
const marketplaceFeedStatus = vi.fn();

/**
 * Every command this dialog's tree can reach, wrapped in an arrow apiece.
 *
 * The arrows are not decoration: `vi.mock` is hoisted above the `const`s above it and the mocked
 * module is pulled in by the component's own imports, so the factory is *evaluated* before those
 * bindings are initialised. Deferring the reference into a call that happens later is what makes
 * that legal — `OracleTagsDialog.test.tsx` mocks the same module the same way.
 */
vi.mock("@/lib/ipc", async (original) => ({
  ...(await original<typeof import("@/lib/ipc")>()),
  ipc: {
    cardDetail: (cardId: string, marketplace: MarketplaceId) => cardDetail(cardId, marketplace),
    combosForCard: (q: CardCombosQuery) => combosForCard(q),
    combosStatus: () => combosStatus(),
    getMarketplace: () => getMarketplace(),
    marketplaceFeedStatus: () => marketplaceFeedStatus(),
  },
}));

/**
 * The one call in this component that leaves the app, faked at the module that owns it — the shape
 * `CardModalRail.test.tsx` uses. `spellbookComboUrl` is the dialog's own and is deliberately *not*
 * faked, so the assertion below reads the real permalink rather than the test's idea of one.
 */
vi.mock("@/lib/externalLinks", async (original) => ({
  ...(await original<typeof import("@/lib/externalLinks")>()),
  openExternal: vi.fn(() => Promise.resolve()),
}));

import { CombosDialog } from "./CombosDialog";
import { useAppStore } from "@/lib/store";

/** A card the dialog can name itself after. Three fields are read — the id, the name in the
 *  subtitle and the oracle id every combo read is keyed on — and the rest are filled so the
 *  fixture is a real `CardDetail` rather than a cast. */
function card(over: Partial<CardDetail> = {}): CardDetail {
  return {
    id: "c1",
    oracleId: "o1",
    name: "Boros Reckoner",
    setCode: "gtc",
    setName: "Gatecrash",
    collectorNumber: "215",
    rarity: "rare",
    layout: "normal",
    lang: "en",
    manaCost: "{R/W}{R/W}{R/W}",
    cmc: 3,
    typeLine: "Creature — Minotaur Wizard",
    oracleText: "Whenever this creature is dealt damage, it deals that much damage to any target.",
    illustrationId: "art-1",
    artist: "Howard Lyon",
    releasedAt: "2013-02-01",
    legalities: null,
    finishPrices: { nonfoil: null, foil: null, etched: null },
    finishes: '["nonfoil","foil"]',
    promoTypes: null,
    imageStatus: "highres_scan",
    faces: [],
    ...over,
  };
}

/** A feed that has never been ingested — no rows, no stamp, `stale: true`. Every install's
 *  opening state, and the one the never-downloaded sentence is about. */
const NEVER_INGESTED: ComboStatus = {
  combos: 0,
  cards: 0,
  stamp: null,
  fetchedAt: null,
  checkedAt: null,
  stale: true,
};

/** The same row for a database that has the file. One real `fetchedAt` is all the dialog reads —
 *  and it is the field that is null on a database that has never ingested, which is why the
 *  fixture moves it rather than the counts. */
const INGESTED: ComboStatus = {
  combos: 107_016,
  cards: 7_330,
  stamp: "2026-09-08T03:12:44Z",
  fetchedAt: 1_800_000_000,
  checkedAt: 1_800_000_000,
  stale: false,
};

function piece(over: Partial<ComboPiece> = {}): ComboPiece {
  return {
    oracleId: "o1",
    name: "Boros Reckoner",
    quantity: 1,
    mustBeCommander: false,
    cardId: "c1",
    imageUris: null,
    owned: 1,
    ...over,
  };
}

function combo(over: Partial<CardCombo> = {}): CardCombo {
  const pieces = over.pieces ?? [
    piece(),
    piece({ oracleId: "o2", name: "Boros Charm", cardId: "c2" }),
  ];
  return {
    id: "3422-3587",
    bracketTag: "S",
    // **Derived from `pieces` rather than passed**, so a fixture cannot claim a card count its own
    // piece list disagrees with. A mock that encodes a state the backend cannot produce is a test
    // that passes over the defect it was written for.
    cardCount: pieces.length,
    templateCount: 0,
    identity: "RW",
    produces: "Infinite lifegain\nInfinite lifegain triggers",
    description: "",
    easyPrerequisites: "",
    notablePrerequisites: "",
    manaNeeded: "",
    popularity: 13_433,
    ...over,
    pieces,
  };
}

/**
 * A page whose census agrees with the rows in it.
 *
 * `total` is the card's whole match set, `matching` is what survives the filters, `byCardCount` is
 * a census of the unfiltered set, and `ownedTotal` is a subset of `total` — so a fixture is built
 * from the combos it holds rather than from three numbers typed in by hand. `matching > total` and
 * a bucket for a size with no combos are both states the backend cannot produce, and a test that
 * staged one would be asserting about a world that does not exist.
 */
function page(combos: CardCombo[], over: Partial<CardCombosPage> = {}): CardCombosPage {
  const sizes = new Map<number, number>();
  for (const c of combos) sizes.set(c.cardCount, (sizes.get(c.cardCount) ?? 0) + 1);
  const owned = combos.filter((c) => c.pieces.every((p) => p.owned >= p.quantity)).length;
  return {
    total: combos.length,
    matching: combos.length,
    ownedTotal: owned,
    byCardCount: [...sizes.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([cards, count]) => ({ cards, combos: count })),
    combos,
    ...over,
  };
}

/**
 * The command over a fixed list — **search first, then the chips, then the window**, which is the
 * contract rather than an arrangement this fixture chose.
 *
 * Getting the order wrong is the thing this exists to make unstageable. `total` is over everything;
 * `byCardCount` and `ownedTotal` are over what the **search** leaves standing; `matching` is over
 * that with the chips applied as well. A mock that censused before the search would encode a page
 * the backend cannot produce, and every chip assertion below would then be about a world that does
 * not exist — which is a test that passes over the defect it was written for.
 */
function answering(all: CardCombo[]) {
  const owns = (c: CardCombo) => c.pieces.every((p) => p.owned >= p.quantity);
  return (q: CardCombosQuery): Promise<CardCombosPage> => {
    // The command's own rule: a case-insensitive substring against **any** piece's name, the
    // asked-about card included. `null` and `""` are the same no-search, which is the half the
    // wrapper is supposed to make unreachable.
    const term = (q.search ?? "").toLowerCase();
    const searched = all.filter(
      (c) => term === "" || c.pieces.some((p) => p.name.toLowerCase().includes(term)),
    );
    const sizes = new Map<number, number>();
    for (const c of searched) sizes.set(c.cardCount, (sizes.get(c.cardCount) ?? 0) + 1);
    const matched = searched.filter(
      (c) => (q.cardCount === null || c.cardCount === q.cardCount) && (!q.ownedOnly || owns(c)),
    );
    return Promise.resolve({
      total: all.length,
      matching: matched.length,
      ownedTotal: searched.filter(owns).length,
      byCardCount: [...sizes.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([cards, combos]) => ({ cards, combos })),
      combos: matched.slice(q.offset, q.offset + q.limit),
    });
  };
}

/** The empty page a card with no combos gets — three zeros and no buckets, which is also exactly
 *  what a database with no combo table answers. Telling those apart is what the status read is
 *  for, and the two tests below are the two halves of it. */
const EMPTY: CardCombosPage = {
  total: 0,
  matching: 0,
  ownedTotal: 0,
  byCardCount: [],
  combos: [],
};

beforeEach(() => {
  cardDetail.mockReset().mockResolvedValue(card());
  combosForCard.mockReset().mockResolvedValue(page([combo()]));
  // The feed is *here* by default, so the never-downloaded test below has to stage its own world
  // rather than getting one from a lazy fixture. A default that already said "never ingested"
  // would make that test pass for the wrong reason.
  combosStatus.mockReset().mockResolvedValue(INGESTED);
  // Nobody has chosen a marketplace, which is what a fresh install reads.
  getMarketplace.mockReset().mockResolvedValue(null);
  marketplaceFeedStatus.mockReset().mockResolvedValue([]);
  vi.mocked(openExternal).mockClear();
  // The dialog is driven by two store fields and nothing else, so the store is the fixture.
  useAppStore.setState(useAppStore.getInitialState());
});

function wrap(ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return <QueryClientProvider client={client}>{ui}</QueryClientProvider>;
}

/**
 * The dialog with a card open under it and the overlay raised — the two store writes a press on
 * the card modal's `Combos` row makes, and nothing else.
 *
 * **The overlay is opened on every render but one**, and that one says so at its own site: every
 * read in the component is gated on the open flag, so a test that left it closed would assert
 * `not.toHaveBeenCalled()` about a dialog that was never asked anything.
 */
function renderWithCard(over: Partial<CardDetail> = {}) {
  cardDetail.mockResolvedValue(card(over));
  useAppStore.setState({ selectedCardId: "c1" });
  useAppStore.getState().openCardOverlay("combos");
  return render(wrap(<CombosDialog />));
}

/**
 * The rows, in list order — the `<ul>`'s **own** children and not every `listitem` under it.
 *
 * `within(list).getAllByRole("listitem")` was enough while a row drew everything it had: the
 * combo's own `<li>` came first in document order and the piece and step items were nested behind
 * it. With the bodies collapsed the nested lists appear and disappear as rows are opened, so a
 * positional index into a flat list of every `listitem` on the panel would name a different element
 * depending on which rows happened to be expanded.
 */
function comboRows(list: HTMLElement): HTMLElement[] {
  return [...list.children] as HTMLElement[];
}

/** One row's header — the disclosure that *is* the row, and the first control in it. The body's
 *  Spellbook button is the other one and comes after it in document order. */
function header(row: HTMLElement): HTMLElement {
  return within(row).getAllByRole("button")[0] as HTMLElement;
}

/** The list, once it has arrived. */
async function combosList(): Promise<HTMLElement> {
  return await screen.findByRole("list", { name: "Combos" });
}

/** Every argument `combos_for_card` has been called with, in order. */
function calls(): CardCombosQuery[] {
  return combosForCard.mock.calls.map(([q]) => q as CardCombosQuery);
}

/** The calls a *search* produced — the initial unsearched read and the chips' reads are not
 *  among them, which is what lets the debounce be counted. */
function searchCalls(): CardCombosQuery[] {
  return calls().filter((q) => q.search !== null);
}

/** The search box, by its own name. Never a bare `Search`: the card modal is on screen behind this
 *  dialog and the app is full of boxes, and a `getByLabelText` cannot tell two of one name apart. */
function searchBox(): HTMLElement {
  return screen.getByLabelText("Search these combos");
}

it("asks nothing at all until the overlay is opened", async () => {
  // What lets `App` mount this beside the card modal unconditionally: a dialog nobody opened costs
  // no query. Only the overlay field differs from `renderWithCard`.
  //
  // Catches: dropping either `skipToken` — a `queryFn` that runs whatever `open` says.
  useAppStore.setState({ selectedCardId: "c1" });
  render(wrap(<CombosDialog />));

  await Promise.resolve();
  expect(cardDetail).not.toHaveBeenCalled();
  expect(combosForCard).not.toHaveBeenCalled();
  expect(combosStatus).not.toHaveBeenCalled();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("does not ask for combos for a printing with no oracle card", async () => {
  // Catches: dropping the `oracleId !== null` arm of the combo query's `queryFn`, which would
  // send `oracleId: ""` and ask the backend to confirm that zero is zero.
  renderWithCard({ oracleId: null });

  // Awaited rather than asserted straight after `render`: the combo read is downstream of the card
  // read, so a bare synchronous check would pass before the card had even resolved and would go on
  // passing with the guard deleted. Waiting for the sentence this state draws is what puts the
  // component past the point where it would have asked.
  expect(await screen.findByText(/not linked to an oracle card/i)).toBeInTheDocument();
  expect(combosForCard).not.toHaveBeenCalled();
});

it("says the combo list has never been downloaded rather than claiming the card is in none", async () => {
  // An empty page and a database with no combo table are the same three zeros, so the status row
  // is what makes either sentence sayable. This is the half that is about the reader's *database*.
  //
  // Catches: deleting the `combosStatus` read (or the `fetchedAt === null` test), which collapses
  // both worlds onto the "nothing on record" sentence — false on every first launch.
  combosForCard.mockResolvedValue(EMPTY);
  combosStatus.mockResolvedValue(NEVER_INGESTED);
  renderWithCard();

  expect(await screen.findByText(/has not been downloaded/i)).toBeInTheDocument();
  // Never this, on a database that has looked at nothing.
  expect(screen.queryByText(/none on record naming this card/i)).not.toBeInTheDocument();
});

it("says Spellbook has nothing on record when the list is here and answers none", async () => {
  // The other half of the split, and the reason the first sentence is not simply drawn for every
  // empty answer: with the feed ingested, "not downloaded" is the wrong claim in the same way an
  // empty box is.
  //
  // Catches: inverting the `fetchedAt === null` test — the two sentences swapped.
  combosForCard.mockResolvedValue(EMPTY);
  combosStatus.mockResolvedValue(INGESTED);
  renderWithCard();

  expect(await screen.findByText(/none on record naming this card/i)).toBeInTheDocument();
  expect(screen.queryByText(/has not been downloaded/i)).not.toBeInTheDocument();
});

/** The row with every optional field filled — the one the two accordion tests below open. */
const FULL = combo({
  easyPrerequisites: "Boros Reckoner is on the battlefield.",
  notablePrerequisites: "You have a way to deal damage to your own creature.",
  description: "Target Boros Reckoner with Boros Charm.\nDeal damage to Boros Reckoner.",
  manaNeeded: "{2}",
});

it("draws a row's pieces and its rating collapsed, and none of its body", async () => {
  // **The wall this dialog read as is what the accordion is for**: expanded, one row is the
  // pieces, the bracket line, produces, both prerequisite blocks, the numbered steps, the mana,
  // the template caveat and the Spellbook link — most of a screen, twenty-five to a page.
  //
  // Catches: rendering the body unconditionally, and — the failure that would look identical on
  // screen — hiding it with a class instead of not mounting it, since every `queryBy` below reads
  // the document rather than the pixels.
  combosForCard.mockResolvedValue(page([FULL]));
  renderWithCard();

  const rows = comboRows(await combosList());
  expect(rows).toHaveLength(1);
  const first = rows[0] as HTMLElement;

  // The header, closed, and it is a real disclosure rather than a `<summary>`.
  expect(header(first)).toHaveAttribute("aria-expanded", "false");
  // The pieces, each named by its own card — these stay in the header, because the whole reason to
  // filter on *I own every piece* is to find the combo you could build tonight and a reader
  // scanning the list has to see which pieces are missing without opening anything.
  expect(within(first).getByText("Boros Reckoner")).toBeInTheDocument();
  expect(within(first).getByText("Boros Charm")).toBeInTheDocument();
  // Spellbook's own letter and Spellbook's own words for it — one text node, so a screen reader
  // and this query read the same sentence. Also the header: *how strong is this* is the other half
  // of what a reader is scanning for.
  expect(within(first).getByText(/^S · Spicy — probably 3 or 4/)).toBeInTheDocument();

  // And nothing else. `Produces` is named explicitly because it is the field a large share of the
  // feed's rows have and the one most likely to be left in the header by mistake.
  expect(screen.queryByText("Produces")).not.toBeInTheDocument();
  expect(screen.queryByText("Infinite lifegain")).not.toBeInTheDocument();
  expect(screen.queryByText("Mana needed")).not.toBeInTheDocument();
  expect(screen.queryByRole("list", { name: "Steps" })).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "View on Commander Spellbook" }),
  ).not.toBeInTheDocument();
});

it("names the combo a header opens, in words rather than as one run-together token", async () => {
  // **A `gap` is not a word separator to the accessible-name computation.** Left to compute itself
  // this button would read `Boros ReckonerOwnedBoros CharmOwnedS · Spicy…` — every caption and
  // ownership mark in the pieces run together, which is the `Missing2` failure this repo has
  // already shipped once.
  //
  // Catches: dropping the `aria-label`, which is silent — the button still opens the row, and the
  // name it computes instead is still *findable*, just not by anything a reader would say.
  combosForCard.mockResolvedValue(page([FULL]));
  renderWithCard();

  expect(
    await screen.findByRole("button", { name: "Boros Reckoner + Boros Charm — S Spicy" }),
  ).toBeInTheDocument();
});

it("draws what a combo does, its prerequisites and its steps once its header is pressed", async () => {
  // Catches: deleting any one of the four `Section`s, the mana block, or the `{open && …}` gate
  // itself — each assertion below names a different field of the body.
  combosForCard.mockResolvedValue(page([FULL]));
  const user = userEvent.setup();
  renderWithCard();

  const first = comboRows(await combosList())[0] as HTMLElement;
  await user.click(header(first));

  expect(header(first)).toHaveAttribute("aria-expanded", "true");
  // What it does, split off the feed's newline-joined string.
  expect(within(first).getByText("Infinite lifegain")).toBeInTheDocument();
  expect(within(first).getByText("Infinite lifegain triggers")).toBeInTheDocument();
  // Both prerequisite kinds, under their own headings.
  expect(within(first).getByText(/Boros Reckoner is on the battlefield/)).toBeInTheDocument();
  expect(within(first).getByText(/deal damage to your own creature/)).toBeInTheDocument();
  expect(within(first).getByText("Mana needed")).toBeInTheDocument();
  // The steps, in order.
  const steps = within(first).getByRole("list", { name: "Steps" });
  expect(within(steps).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
    "Target Boros Reckoner with Boros Charm.",
    "Deal damage to Boros Reckoner.",
  ]);
});

it("opens one row without opening the others", async () => {
  // **A row's expansion is per row.** Lifted to one flag in `Body` the dialog would draw the same
  // wall it drew before, one press further in.
  //
  // Catches: a single `open` in `Body` (or a `Set` written back with `=`), which is exactly the
  // shape a "expand all" refactor reaches for — and which nothing on screen names, because the
  // first row looks right.
  const second = combo({ id: "second", produces: "Infinite damage" });
  combosForCard.mockResolvedValue(page([FULL, second]));
  const user = userEvent.setup();
  renderWithCard();

  const rows = comboRows(await combosList());
  await user.click(header(rows[0] as HTMLElement));

  expect(header(rows[0] as HTMLElement)).toHaveAttribute("aria-expanded", "true");
  expect(header(rows[1] as HTMLElement)).toHaveAttribute("aria-expanded", "false");
  expect(within(rows[0] as HTMLElement).getByText("Infinite lifegain")).toBeInTheDocument();
  // The second row's own `produces` is a different string on purpose: asserting the *absence* of
  // the first row's text inside the second would pass against a component that drew nothing.
  expect(within(rows[1] as HTMLElement).queryByText("Infinite damage")).not.toBeInTheDocument();
});

it("draws no heading for a field the feed left empty", async () => {
  // Four of the five optional sections are `""` on a large share of the feed's rows, and a heading
  // with nothing under it reads as content that failed to load.
  //
  // Catches: removing `Section`'s `lines.length === 0` guard — every heading would be drawn for
  // every combo whatever the feed sent.
  combosForCard.mockResolvedValue(page([combo()]));
  const user = userEvent.setup();
  renderWithCard();

  const first = comboRows(await combosList())[0] as HTMLElement;
  await user.click(header(first));

  // The one section this fixture *does* fill, so the assertion is not vacuously green against a
  // row that never opened at all.
  expect(screen.getByText("Produces")).toBeInTheDocument();
  expect(screen.queryByText("Steps")).not.toBeInTheDocument();
  expect(screen.queryByText("Prerequisites")).not.toBeInTheDocument();
  expect(screen.queryByText("Notable prerequisites")).not.toBeInTheDocument();
  expect(screen.queryByText("Mana needed")).not.toBeInTheDocument();
});

it("says a combo also needs something no card list can name", async () => {
  // Catches: dropping the `templateCount > 0` block, which would leave a three-piece combo
  // reading as though the two cards named were the whole of it.
  combosForCard.mockResolvedValue(page([combo({ templateCount: 1 })]));
  const user = userEvent.setup();
  renderWithCard();

  const first = comboRows(await combosList())[0] as HTMLElement;
  await user.click(header(first));

  expect(screen.getByText(/no card list can name/i)).toBeInTheDocument();
});

it("marks a piece the reader does not own, in words", async () => {
  // Never by colour alone — the app's rule wherever a status is coloured, and the surface where it
  // matters most, since the whole point of the owned filter is finding the combo you could build
  // tonight.
  //
  // Catches: replacing the owned note with a class-only treatment, or `owned || "—"`, which would
  // hide the zero this read exists to show.
  combosForCard.mockResolvedValue(
    page([
      combo({
        pieces: [
          piece({ owned: 2 }),
          piece({ oracleId: "o3", name: "Avacyn, Angel of Hope", cardId: "c3", owned: 0 }),
        ],
      }),
    ]),
  );
  renderWithCard();

  expect(await screen.findByText("Not owned")).toBeInTheDocument();
  expect(screen.getByText("Owned")).toBeInTheDocument();
});

it("still names a piece the corpus has never synced, in the frame and in the caption", async () => {
  // A combo may name a card this database has no printing for. `CardArt` draws its named, empty
  // frame — this app's existing "no art" state — rather than an error or a blank.
  //
  // Catches: gating the whole piece on `cardId !== null`, or fetching a picture for a null id.
  //
  // **The name is expected *twice*, and asserting that is the point rather than a concession to
  // a query that failed.** `CardArt` prints the name inside the frame it draws when there is no
  // picture, and this dialog prints it again as the piece's caption — which is exactly what
  // `DeckTokensPanel` does with the same component, for the reason stated there: the caption is
  // the row's label, and the name in the frame is what keeps a wall legible when the art never
  // loads. A `getByText` here therefore fails on the *working* component, and softening it to
  // `getAllByText` without pinning the count would go on passing if the caption were deleted —
  // which is the half this test exists to protect.
  combosForCard.mockResolvedValue(
    page([
      combo({
        pieces: [
          piece(),
          piece({ oracleId: "o9", name: "Kenrith, the Returned King", cardId: null }),
        ],
      }),
    ]),
  );
  renderWithCard();

  expect(await screen.findAllByText("Kenrith, the Returned King")).toHaveLength(2);
  // The frame's own status word, which is what makes the empty frame a *statement* rather than a
  // picture that has not arrived yet — `CardArt` says "No card" for a null id and "No image" for
  // a printing whose art failed. Catches passing the oracle id through as a `cardId`.
  expect(screen.getByText("No card")).toBeInTheDocument();
});

it("narrows to a combo size at the backend when its chip is pressed", async () => {
  // **The argument is asserted, not the fact that a call happened.** A filter applied to the page
  // in hand would also re-render, and on a card with six thousand combos it would be narrowing
  // 0.4 % of the list while claiming to describe all of it.
  //
  // Catches: sending `bucket.combos` (the count) instead of `bucket.cards` (the size), filtering
  // client-side, or forgetting to reset `offset` to 0 when the filter changes.
  const two = combo({ id: "a", pieces: [piece(), piece({ oracleId: "o2", name: "Boros Charm" })] });
  const three = combo({
    id: "b",
    pieces: [piece(), piece({ oracleId: "o2", name: "Boros Charm" }), piece({ oracleId: "o3", name: "Avacyn, Angel of Hope" })],
  });
  combosForCard.mockResolvedValue(page([two, three]));
  const user = userEvent.setup();
  renderWithCard();

  await user.click(await screen.findByRole("button", { name: "3 cards · 1" }));

  expect(combosForCard).toHaveBeenCalledWith({
    oracleId: "o1",
    search: null,
    cardCount: 3,
    ownedOnly: false,
    limit: 25,
    offset: 0,
  });
});

it("sends the owned filter to the backend when the toggle is pressed", async () => {
  // Catches: filtering the page in hand on `pieces.every(owned)`, or wiring the toggle to
  // `cardCount`.
  const owned = combo({ id: "a" });
  const notOwned = combo({
    id: "b",
    pieces: [piece(), piece({ oracleId: "o3", name: "Avacyn, Angel of Hope", owned: 0 })],
  });
  combosForCard.mockResolvedValue(page([owned, notOwned]));
  const user = userEvent.setup();
  renderWithCard();

  await user.click(await screen.findByRole("button", { name: "I own every piece · 1" }));

  expect(combosForCard).toHaveBeenCalledWith({
    oracleId: "o1",
    search: null,
    cardCount: null,
    ownedOnly: true,
    limit: 25,
    offset: 0,
  });
});

it("says the filter left nothing rather than claiming the card is in no combos", async () => {
  // The fourth empty, and it must never borrow one of the other three: the chips are still on
  // screen above it, each carrying the count that says the card *is* in combos.
  //
  // Catches: testing `matching === 0` where the never-fetched split tests `total === 0`, which
  // would print "Spellbook has none on record" over a list the reader has just narrowed.
  combosForCard.mockResolvedValue(page([combo()], { matching: 0, combos: [] }));
  renderWithCard();

  expect(await screen.findByText(/no combo matches that filter/i)).toBeInTheDocument();
  expect(screen.queryByText(/none on record naming this card/i)).not.toBeInTheDocument();
  expect(screen.queryByText(/has not been downloaded/i)).not.toBeInTheDocument();
});

it("appends the next page rather than replacing the one in hand", async () => {
  // Catches: `Show more` asking for offset 0 again (an infinite first page), and a body that
  // renders `pages[pages.length - 1]` instead of flattening every page.
  const rows = Array.from({ length: 30 }, (_, i) =>
    combo({
      id: `combo-${i}`,
      pieces: [piece(), piece({ oracleId: `o${i}`, name: `Partner ${i}`, cardId: `c${i}` })],
    }),
  );
  combosForCard.mockImplementation((q: CardCombosQuery) =>
    Promise.resolve(
      page(rows, { matching: rows.length, combos: rows.slice(q.offset, q.offset + q.limit) }),
    ),
  );
  const user = userEvent.setup();
  renderWithCard();

  expect(await screen.findByText("Showing 25 of 30")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Show more" }));

  expect(await screen.findByText("Showing 30 of 30")).toBeInTheDocument();
  expect(combosForCard).toHaveBeenLastCalledWith({
    oracleId: "o1",
    search: null,
    cardCount: null,
    ownedOnly: false,
    limit: 25,
    offset: 25,
  });
  // The first page is still there — appended, not swapped.
  expect(screen.getByText("Partner 0")).toBeInTheDocument();
  expect(screen.getByText("Partner 29")).toBeInTheDocument();
  // And the button is gone, because there is nothing left to ask for.
  expect(screen.queryByRole("button", { name: "Show more" })).not.toBeInTheDocument();
});

it("opens a combo on Commander Spellbook through the app's one external call", async () => {
  // `openExternal` is the app's single call that leaves it, and never a raw `window.open`, which
  // in a Tauri webview navigates the app's own window.
  //
  // Catches: an `<a href>` or a `window.open`, and a malformed permalink — the URL is asserted
  // whole rather than merely "something was opened".
  //
  // **The link is in the body, and that is the accordion's constraint agreeing with its own**: a
  // control nested inside the header's disclosure button would be invalid markup and a press on it
  // would also toggle the row it left.
  const user = userEvent.setup();
  renderWithCard();

  const first = comboRows(await combosList())[0] as HTMLElement;
  await user.click(header(first));
  await user.click(screen.getByRole("button", { name: "View on Commander Spellbook" }));

  expect(vi.mocked(openExternal)).toHaveBeenCalledExactlyOnceWith(
    "https://commanderspellbook.com/combo/3422-3587/",
  );
});

it("says where the combos came from, and does not blame the card sync for their age", async () => {
  // Spellbook's file is a separate bulk download on a weekly interval of its own, so a caption
  // borrowing `pricesAsOf`'s "as of the last card-data sync" would name the wrong clock — the
  // thing the root CLAUDE.md asks in bold not to blur.
  //
  // Catches: rewording the caption to name the card sync, and moving it inside the scroller (the
  // second is what the story checks; this pins the sentence).
  renderWithCard();
  await combosList();

  expect(screen.getByText(/as of the last combo refresh/i)).toBeInTheDocument();
  expect(screen.queryByText(/card-data sync/i)).not.toBeInTheDocument();
});

it("names the panel after the card it is about", async () => {
  // A reader who opened three overlays in a row can tell which card this one is about without
  // closing it.
  //
  // **The empty page is what makes this test mean anything**: with combos on screen the card's
  // name is also a piece's, so the assertion would pass against a dialog that had never been
  // given a subtitle at all.
  //
  // Catches: dropping the `subtitle` prop, which is silent — the dialog still opens.
  combosForCard.mockResolvedValue(EMPTY);
  renderWithCard();

  await screen.findByText(/none on record naming this card/i);
  expect(screen.getByText("Boros Reckoner")).toBeInTheDocument();
});

/* -------------------------------------------------------------------- the search box ---------
 *
 * Ashnod's Altar is in **6 044** combos on the real corpus, 25 to a page. Paging is not a way to
 * *find* anything, so the box is not a convenience: without it there is no way to ask "which of
 * these has Krark-Clan Ironworks in it", and no way for a reader to discover that there might be.
 */

/** Two two-card combos and one three-card one, the third naming a card the other two do not — so a
 *  term can narrow the *census* rather than only the rows, which is what the chip tests below are
 *  about. Avacyn is also the piece nobody owns, which keeps `ownedTotal` from moving in step with
 *  the sizes and makes each assertion about its own number. */
const THREE = [
  combo({ id: "a" }),
  combo({ id: "b", pieces: [piece(), piece({ oracleId: "o5", name: "Vigor", cardId: "c5" })] }),
  combo({
    id: "c",
    pieces: [
      piece(),
      piece({ oracleId: "o2", name: "Boros Charm", cardId: "c2" }),
      piece({ oracleId: "o3", name: "Avacyn, Angel of Hope", cardId: "c3", owned: 0 }),
    ],
  }),
];

it("sends the trimmed term, and opens the searched list at its top", async () => {
  // **`offset: 0` is the half worth staging rather than asserting from a fresh mount**, which is
  // why this presses *Show more* first: a search that inherited the pager's offset would open on
  // page 2 of a list that has just become shorter than two pages, and the rows a reader typed a
  // word to find would be above the top of it.
  //
  // Catches: leaving `search` out of `cardCombosKey` (the key never changes, so nothing is asked
  // at all and the pages in hand — and their offset — survive); sending `asked` untrimmed, which
  // opens a second cache entry per trailing space; and any hand-rolled pager that kept its own
  // offset across a filter change.
  const rows = Array.from({ length: 30 }, (_, i) =>
    combo({
      id: `combo-${i}`,
      pieces: [piece(), piece({ oracleId: `o${i}`, name: `Partner ${i}`, cardId: `c${i}` })],
    }),
  );
  combosForCard.mockImplementation(answering(rows));
  const user = userEvent.setup({ delay: null });
  renderWithCard();

  expect(await screen.findByText("Showing 25 of 30")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Show more" }));
  await screen.findByText("Showing 30 of 30");

  await user.type(searchBox(), "  boros  ");

  await waitFor(() => expect(searchCalls()).toHaveLength(1));
  expect(searchCalls()[0]).toEqual({
    oracleId: "o1",
    search: "boros",
    cardCount: null,
    ownedOnly: false,
    limit: 25,
    offset: 0,
  });
});

it("asks with null for an empty box rather than with an empty string", async () => {
  // `null` and `""` mean the same thing to the command, which is exactly why only one of them may
  // ever travel: two spellings of *no search* are two query keys that have to answer identically
  // for ever, and the second is a cache entry nothing else in the app will ever hit.
  //
  // Catches: `search: asked.trim()` without the collapse to `null`.
  //
  // **The first call is where that mutation is visible, which is why it is asserted rather than
  // the round trip back to empty.** `cardCombosKey` normalises `""` to `null` itself, so a
  // component sending the empty string would key *identically* to one sending `null` and the
  // emptied box would answer from cache without a call at all — the wire would never show it. The
  // opening read has no cache to hide behind. The clear is still driven afterwards, and the sweep
  // over every call is what says the empty string never travelled at any point.
  combosForCard.mockImplementation(answering([combo()]));
  const user = userEvent.setup({ delay: null });
  renderWithCard();
  await combosList();

  expect(calls()[0]).toEqual({
    oracleId: "o1",
    search: null,
    cardCount: null,
    ownedOnly: false,
    limit: 25,
    offset: 0,
  });

  // A term that empties the list and then a clear that brings it back, so the sweep below runs
  // **after** the debounce has fired rather than racing it: the rows returning is the proof that
  // the emptied box reached the query, whether the answer came off the wire or out of the cache.
  await user.type(searchBox(), "krark");
  await screen.findByText(/no combo matches that filter/i);
  await user.clear(searchBox());
  await combosList();

  expect(calls().filter((q) => q.search === "")).toEqual([]);
});

it("asks once for a word rather than once per keystroke", async () => {
  // Four letters is four renders and four query keys without the debounce, and on a card in six
  // thousand combos that is four full reads for a word the reader had not finished typing.
  //
  // Catches: dropping the `setTimeout` and keying the query on `text` directly — the last call
  // still carries the whole word, so only the *count* can see it.
  //
  // Real timers on purpose: `userEvent` inside `vi.useFakeTimers` hangs on its own scheduler and
  // takes every later test in the file with it. `delay: null` is what keeps the four keystrokes
  // inside one debounce window without one.
  combosForCard.mockImplementation(answering([combo()]));
  const user = userEvent.setup({ delay: null });
  renderWithCard();
  await combosList();

  await user.type(searchBox(), "boro");

  // The whole word has arrived — asserted before the count, so a debounce that had been deleted
  // fails on the *number* of calls rather than by timing out on a term that never came.
  await waitFor(() => {
    const made = searchCalls();
    expect(made[made.length - 1]?.search).toBe("boro");
  });
  expect(searchCalls()).toHaveLength(1);
});

it("says the filter left nothing when a term matches no combo", async () => {
  // **A search that matches nothing is the filter's empty, not a fifth sentence** — and above all
  // not one of the two that are claims about the card or the database. `total` is over the
  // unfiltered set and a term does not move it, which is what keeps this branch reachable.
  //
  // Catches: a bespoke "no combo matches that search" sentence, and — the one that would be a
  // false statement rather than a duplicated one — testing `total` after the search rather than
  // `matching`, which would print *Spellbook has none on record* over a card in three combos.
  combosForCard.mockImplementation(answering([combo()]));
  const user = userEvent.setup({ delay: null });
  renderWithCard();
  await combosList();

  await user.type(searchBox(), "krark-clan");

  expect(await screen.findByText(/no combo matches that filter/i)).toBeInTheDocument();
  expect(screen.queryByText(/none on record naming this card/i)).not.toBeInTheDocument();
  expect(screen.queryByText(/has not been downloaded/i)).not.toBeInTheDocument();
  // And the box that emptied the list is still on screen holding the term that did it, which is
  // the whole of the way back.
  expect(searchBox()).toHaveValue("krark-clan");
});

it("moves the chip counts with the search and not with a chip press", async () => {
  // **The search changes the subject; the chips are facets of it.** So the counts follow what is
  // typed and stand still when a chip is pressed — a chip that recounted itself the moment it was
  // used would be a control that changed its mind about what it was counting.
  //
  // Catches: the `All` chip reading `page.total` (the *unfiltered* census) instead of the sum of
  // `byCardCount` — after a search it would claim a wider set than the union of the chips beside
  // it, which is the one arithmetic a reader can check at a glance.
  combosForCard.mockImplementation(answering(THREE));
  const user = userEvent.setup({ delay: null });
  renderWithCard();

  expect(await screen.findByRole("button", { name: "All · 3" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "2 cards · 2" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "3 cards · 1" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "I own every piece · 2" })).toBeInTheDocument();

  await user.type(searchBox(), "avacyn");

  // Only the three-card combo names Avacyn, so every count is now over that one row — including
  // the owned one, which drops to zero because Avacyn is the piece nobody has.
  expect(await screen.findByRole("button", { name: "All · 1" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /^2 cards/ })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "3 cards · 1" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "I own every piece · 0" })).toBeInTheDocument();

  // And pressing a chip narrows the list without touching any of them.
  await user.click(screen.getByRole("button", { name: "3 cards · 1" }));

  await screen.findByText("Showing 1 of 1");
  expect(screen.getByRole("button", { name: "All · 1" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "3 cards · 1" })).toBeInTheDocument();
});

it("keeps the size chip that is emptying the list, so there is a way back out", async () => {
  // The state a search-narrowed census makes reachable: a reader narrows to `3 cards`, then types
  // a term no three-card combo matches. The size is still in the query, so the list is empty — and
  // without this the chip doing the emptying would drop out of the row it is drawn from, leaving
  // *No combo matches that filter* over a row of controls none of which is on.
  //
  // Catches: building the chips from `byCardCount` alone. It is the case the rule "a bucket at
  // zero is dropped" was written before, and the pressed chip is its one exception — a control
  // that can only ever empty the list, at the moment it is the control that already has.
  combosForCard.mockImplementation(answering(THREE));
  const user = userEvent.setup({ delay: null });
  renderWithCard();

  await user.click(await screen.findByRole("button", { name: "3 cards · 1" }));
  await screen.findByText("Showing 1 of 1");

  // Vigor is a piece of a two-card combo only, so the searched census has no three-card bucket.
  await user.type(searchBox(), "vigor");

  expect(await screen.findByText(/no combo matches that filter/i)).toBeInTheDocument();
  const stranding = screen.getByRole("button", { name: "3 cards · 0" });
  expect(stranding).toHaveAttribute("aria-pressed", "true");

  // And pressing it again is the way out — back to All, over the term still in the box.
  await user.click(stranding);
  expect(await screen.findByText("Showing 1 of 1")).toBeInTheDocument();
  expect(screen.getByText("Vigor")).toBeInTheDocument();
});
