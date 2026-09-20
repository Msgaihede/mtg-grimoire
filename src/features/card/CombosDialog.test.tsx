import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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

/* ------------------------------------------------------------------ the environment ----------
 *
 * Two things jsdom does not have that this dialog reaches for. Neither is a detail: one of them
 * is the *only* way the rail asks for its next page, and the other throws rather than no-opping.
 */

/**
 * Every `IntersectionObserver` the rail has constructed, in construction order.
 *
 * **`src/test-setup.ts` installs a no-op stub for dnd-kit** — `observe(){}` and nothing else — so
 * the real observer never fires in jsdom and a paging test written against the shipped component
 * would sit for ever waiting for a page nothing asked for. This records instead: the callback, what
 * it was pointed at, and whether it is still connected, so a test can hand it an entry itself.
 *
 * **There is more than one, and which one is live matters.** The rail's effect is gated on
 * `hasNext && !fetching` and re-runs when either moves, so an observer is disconnected the moment
 * a fetch starts and a fresh one is built when it settles — which is deliberate (a rail the first
 * page did not fill goes on asking). {@link scrollRailToTheFoot} therefore fires the newest one
 * that is still connected and still watching something, never the first.
 */
type Watcher = {
  callback: IntersectionObserverCallback;
  targets: Element[];
  live: boolean;
  instance: IntersectionObserver;
};

const watchers: Watcher[] = [];

class RecordingIntersectionObserver {
  private readonly record: Watcher;

  constructor(callback: IntersectionObserverCallback) {
    this.record = {
      callback,
      targets: [],
      live: true,
      instance: this as unknown as IntersectionObserver,
    };
    watchers.push(this.record);
  }

  observe(target: Element) {
    this.record.targets.push(target);
  }

  unobserve(target: Element) {
    this.record.targets = this.record.targets.filter((el) => el !== target);
  }

  disconnect() {
    this.record.live = false;
    this.record.targets = [];
  }

  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}

/**
 * The sentinel comes into view — the whole of what replaced *Show more*.
 *
 * `isIntersecting` is the only field the callback reads, so the entry is that one fact and a cast
 * rather than a hand-built `IntersectionObserverEntry` nothing would look at. `act` because the
 * callback calls `fetchNextPage`, which is a state update originating outside React's own event
 * handling; the round trip after it is the caller's to await.
 */
async function scrollRailToTheFoot(): Promise<void> {
  const watcher = await waitFor(() => {
    const live = watchers.filter((w) => w.live && w.targets.length > 0);
    const newest = live[live.length - 1];
    if (newest === undefined) throw new Error("the rail is watching nothing");
    return newest;
  });
  act(() => {
    watcher.callback([{ isIntersecting: true } as IntersectionObserverEntry], watcher.instance);
  });
}

/**
 * The rail's keyboard handler scrolls the row it moved the caret to, and **jsdom leaves
 * `scrollIntoView` undefined on every element** — so the call is not a no-op here, it is a
 * `TypeError` thrown inside a keydown handler. `AnchoredPopup.test.tsx` installs one the same way
 * and deletes it afterwards, which is what keeps every other suite in the state the app is
 * actually written against.
 *
 * Where a row really lands is a live pass's to settle; what this file can see is that the caret
 * and the selection moved together.
 */
const scrollIntoView = vi.fn();

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
  watchers.length = 0;
  vi.stubGlobal("IntersectionObserver", RecordingIntersectionObserver);
  scrollIntoView.mockReset();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    writable: true,
    value: scrollIntoView,
  });
  // The dialog is driven by two store fields and nothing else, so the store is the fixture.
  useAppStore.setState(useAppStore.getInitialState());
});

afterEach(() => {
  // Back to what the rest of the suite runs in: the setup file's no-op observer, and no
  // `scrollIntoView` at all.
  vi.unstubAllGlobals();
  delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
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

/** The rail, once it has arrived. */
async function combosList(): Promise<HTMLElement> {
  return await screen.findByRole("list", { name: "Combos" });
}

/**
 * The rail's rows, in list order.
 *
 * Scoped to the rail's own `<ul>` and never to the panel, because the **pane** draws lists of its
 * own — `Prerequisites`, `Notable prerequisites`, `Steps` — and a flat sweep for every `listitem`
 * on screen would index into whichever combo happened to be selected.
 */
function comboRows(list: HTMLElement): HTMLElement[] {
  return within(list).getAllByRole("listitem");
}

/** One rail row's button — the whole row is one, and it is the thing `aria-current` marks. */
function rowButton(row: HTMLElement): HTMLElement {
  return within(row).getByRole("button");
}

/** The rail's buttons in list order, re-read from the DOM on every call so a selection that has
 *  just re-rendered is never asserted against a stale node. */
function rowButtons(list: HTMLElement): HTMLElement[] {
  return comboRows(list).map(rowButton);
}

/**
 * The line above the rail — the one place the size of the list is written since the chips lost
 * their counts.
 *
 * By level rather than by name: the dialog's own title is the `<h2>`, every block inside the pane
 * is an `<h4>`, and this is the only `<h3>` on the panel.
 */
function railHeading(): HTMLElement {
  return screen.getByRole("heading", { level: 3 });
}

/**
 * The detail pane — the column drawing the one selected combo.
 *
 * Found through the control only it has: the Spellbook link is the last thing in the pane and is
 * its own direct child. Scoping matters because **the rail draws the other pieces' names too**, so
 * a bare `getAllByText` on a card's name counts the rail's row alongside the pane's frame and its
 * caption, and then cannot say which of the three went missing.
 */
function pane(): HTMLElement {
  const link = screen.getByRole("button", { name: "View on Commander Spellbook" });
  return link.parentElement as HTMLElement;
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

/* ------------------------------------------------------------- the rail and the pane ---------
 *
 * The accordion is gone (2026-09-20, issue #481). Nothing presses a row *open*: the rail is a
 * scan list of one line per combo and the pane beside it draws one combo at full size, so every
 * case below is about which combo the pane is drawing and what it says about it.
 */

/** The row with every optional field filled — the one the pane is asked to draw in full. */
const FULL = combo({
  easyPrerequisites: "Boros Reckoner is on the battlefield.",
  notablePrerequisites: "You have a way to deal damage to your own creature.",
  description: "Target Boros Reckoner with Boros Charm.\nDeal damage to Boros Reckoner.",
  manaNeeded: "{2}",
});

/**
 * Three combos with three different `produces`, which is what makes "the pane moved" assertable.
 *
 * The pane draws one combo, so a fixture whose rows all say the same thing cannot tell a selection
 * that moved from one that did not. Their pieces differ too, so a search term can drop the middle
 * row and leave the other two: `charm` keeps **a** and **c**, `vigor` keeps **b**, `avacyn` keeps
 * **c** alone — and Avacyn is also the piece nobody owns, which keeps the owned census from moving
 * in step with the sizes.
 */
const THREE = [
  combo({ id: "a", produces: "Infinite lifegain" }),
  combo({
    id: "b",
    produces: "Infinite damage",
    pieces: [piece(), piece({ oracleId: "o5", name: "Vigor", cardId: "c5" })],
  }),
  combo({
    id: "c",
    produces: "Infinite mana",
    pieces: [
      piece(),
      piece({ oracleId: "o2", name: "Boros Charm", cardId: "c2" }),
      piece({ oracleId: "o3", name: "Avacyn, Angel of Hope", cardId: "c3", owned: 0 }),
    ],
  }),
];

it("opens with the first row selected and that row's combo in the pane", async () => {
  // **`selected` is derived rather than stored**, and `rows[0]` is the arm a reader who has pressed
  // nothing lands on. A dialog that opened on an empty pane would be the accordion again, one press
  // further in — which is the thing this redesign exists to remove.
  //
  // Catches: dropping the `?? rows[0]` arm (nothing selected, an empty pane), and marking the rail
  // with nothing at all — the pane can be right while the rail fails to say which row it is
  // drawing, and a reader scanning the list has no other way to tell.
  combosForCard.mockResolvedValue(page(THREE));
  renderWithCard();

  const list = await combosList();
  const buttons = rowButtons(list);
  expect(buttons[0]).toHaveAttribute("aria-current", "true");
  expect(buttons[1]).not.toHaveAttribute("aria-current");
  expect(buttons[2]).not.toHaveAttribute("aria-current");

  // And the pane is drawing *that* row, not merely something.
  expect(screen.getByText("Infinite lifegain")).toBeInTheDocument();
  expect(screen.queryByText("Infinite damage")).not.toBeInTheDocument();
});

it("moves the pane to the row that was pressed", async () => {
  // Catches: a row whose press does not reach `setPicked` (the pane stays on the first combo), and
  // a pane that appends rather than replaces — the second combo's `produces` arriving while the
  // first one's is still on screen.
  combosForCard.mockResolvedValue(page(THREE));
  const user = userEvent.setup();
  renderWithCard();

  const list = await combosList();
  await user.click(rowButton(comboRows(list)[1] as HTMLElement));

  expect(await screen.findByText("Infinite damage")).toBeInTheDocument();
  expect(screen.queryByText("Infinite lifegain")).not.toBeInTheDocument();
  const buttons = rowButtons(list);
  expect(buttons[1]).toHaveAttribute("aria-current", "true");
  expect(buttons[0]).not.toHaveAttribute("aria-current");
});

it("falls back to the first row of the new list when a search drops the picked one", async () => {
  // **The whole reason this surface needs no effect anywhere.** A search hands back a different
  // `rows`, and an id that is no longer in it falls through to `rows[0]` — which is what a reader
  // who has just narrowed the list means. The staging is the point: the picked row has to be a row
  // the new search *drops*, or the fallback arm is never reached.
  //
  // Catches: storing the selection instead of deriving it, which leaves `picked` naming a combo
  // that is not in the list — an empty pane over a rail with rows in it. A `useEffect` that
  // reconciled it afterwards would be one render late *and* a `setState` in an effect, which this
  // app refuses.
  combosForCard.mockImplementation(answering(THREE));
  const user = userEvent.setup({ delay: null });
  renderWithCard();

  const list = await combosList();
  await user.click(rowButton(comboRows(list)[1] as HTMLElement));
  expect(await screen.findByText("Infinite damage")).toBeInTheDocument();

  // Boros Charm is in **a** and **c** and in neither the picked row nor its pieces.
  await user.type(searchBox(), "charm");

  expect(await screen.findByText("Infinite lifegain")).toBeInTheDocument();
  expect(screen.queryByText("Infinite damage")).not.toBeInTheDocument();
  const narrowed = await combosList();
  expect(comboRows(narrowed)).toHaveLength(2);
  expect(rowButtons(narrowed)[0]).toHaveAttribute("aria-current", "true");
});

it("names a rail row in words rather than as one run-together token", async () => {
  // **A `gap` is not a word separator to the accessible-name computation.** Left to compute itself
  // this button would read `3–5Boros CharmSpicy2 cardsYou own every piece` — the range box, the
  // names, the size and the ownership mark run together, because the spaces on the row are flex
  // gaps. This repo has shipped exactly that failure once already, as `Missing2`.
  //
  // It also pins what the built name *says*, which changed with the redesign: the old one ended
  // `— S Spicy` because the letter was what the row drew. Nothing draws a letter now, so the
  // brackets are spelled out instead — `bracketSentence`, the same string the pane's pips carry.
  //
  // Catches: dropping the `aria-label` (silent — the button still works, and the name it computes
  // instead is still *findable*, just not by anything a reader would say); reinstating the bare
  // letter; and losing either half of `ownedSummary`, which is why two rows are asserted.
  combosForCard.mockResolvedValue(
    page([
      combo({ id: "owned-whole" }),
      combo({
        id: "short-one",
        bracketTag: "C",
        pieces: [
          piece(),
          piece({ oracleId: "o3", name: "Avacyn, Angel of Hope", cardId: "c3", owned: 0 }),
        ],
      }),
    ]),
  );
  renderWithCard();

  const buttons = rowButtons(await combosList());
  expect(buttons[0]).toHaveAccessibleName(
    "Boros Charm — Spicy. Legal in brackets 3, 4 and 5. 2 cards. You own every piece.",
  );
  expect(buttons[1]).toHaveAccessibleName(
    "Avacyn, Angel of Hope — Core. Legal in brackets 2, 3, 4 and 5. 2 cards. Missing 1.",
  );
});

it("says the brackets a combo is legal in once, and as a sentence", async () => {
  // **Five pips are a colour-and-number pair and may not be the only statement of the brackets.**
  // `role="img"` with the sentence as its label is what stops them being read as five separate
  // numbers, two of which would sound identical to the three that are filled.
  //
  // Catches: dropping the `role`/`aria-label` pair; deriving the list a second time instead of
  // reading `comboBrackets` (a `C` combo's floor is 2, so anything that mistook it for 3 fails on
  // the string); and drawing only the legal pips, which would keep the label right and leave the
  // row reading `2345` — the text-content assertion is the half that sees it.
  combosForCard.mockResolvedValue(page([combo({ bracketTag: "C" })]));
  renderWithCard();

  const pips = await screen.findByRole("img", { name: "Legal in brackets 2, 3, 4 and 5" });
  expect(pips).toHaveTextContent("12345");
});

it("says a banned combo is not legal instead of drawing five empty pips", async () => {
  // `B` is a **legality** finding rather than a power floor, so `comboBrackets` answers the empty
  // list and this surface has to say so in words. The live feed has never yet carried one, which is
  // exactly why it needs a test rather than a live pass.
  //
  // Catches: `comboBrackets`' `B` arm falling through to the `?? 1` default, which would draw all
  // five pips and call a banned combo legal everywhere; and a range box printing a bare en dash
  // with nothing either side of it.
  combosForCard.mockResolvedValue(page([combo({ bracketTag: "B" })]));
  renderWithCard();

  const list = await combosList();
  expect(screen.getByText("Not legal in Commander")).toBeInTheDocument();
  expect(screen.queryByRole("img", { name: /^Legal in bracket/ })).not.toBeInTheDocument();
  // The rail's own four-character version of the same answer.
  expect(within(list).getByText("Not legal")).toBeInTheDocument();
});

it("draws what a combo does, its prerequisites and its steps, with nothing collapsed", async () => {
  // The half of the issue the pane *is*: every field the feed filled, at full size, with no press
  // between the reader and any of it.
  //
  // Catches: deleting any one of the three `Section`s or the mana block — each assertion names a
  // different field. The `produces` line is asserted as **one** node on purpose: the pane joins the
  // feed's newline-separated features with `·`, so a build that drew them as separate lines would
  // still satisfy a per-feature query and fail this one.
  combosForCard.mockResolvedValue(page([FULL]));
  renderWithCard();
  await combosList();

  expect(screen.getByText("Infinite lifegain · Infinite lifegain triggers")).toBeInTheDocument();
  expect(screen.getByText(/Boros Reckoner is on the battlefield/)).toBeInTheDocument();
  expect(screen.getByText(/deal damage to your own creature/)).toBeInTheDocument();
  expect(screen.getByText("Mana needed")).toBeInTheDocument();
  // The steps, in order.
  const steps = screen.getByRole("list", { name: "Steps" });
  expect(within(steps).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
    "Target Boros Reckoner with Boros Charm.",
    "Deal damage to Boros Reckoner.",
  ]);
});

it("draws no heading for a field the feed left empty", async () => {
  // Four of the five optional blocks are `""` on a large share of the feed's rows, and a heading
  // with nothing under it reads as content that failed to load — on a surface whose other empty
  // states are carefully distinguished sentences.
  //
  // Catches: removing `Section`'s `lines.length === 0` guard — every heading would be drawn for
  // every combo whatever the feed sent.
  combosForCard.mockResolvedValue(page([combo()]));
  renderWithCard();
  await combosList();

  // The field this fixture *does* fill, so the four absences below are not vacuously green against
  // a pane that drew nothing at all.
  expect(screen.getByText("Infinite lifegain · Infinite lifegain triggers")).toBeInTheDocument();
  expect(screen.queryByText("Steps")).not.toBeInTheDocument();
  expect(screen.queryByText("Prerequisites")).not.toBeInTheDocument();
  expect(screen.queryByText("Notable prerequisites")).not.toBeInTheDocument();
  expect(screen.queryByText("Mana needed")).not.toBeInTheDocument();
});

/**
 * The flex row the prerequisites column and the steps column are laid out in.
 *
 * **Walked by `closest` and not by counting `parentElement`s**, which is a correction rather than
 * a preference: `ol` → `Section`'s own div → the column → the row is three hops, and a two-hop
 * version of this read the *column* instead. It made the no-prerequisites case pass for the wrong
 * reason — a column has one child either way — and only its pair went red. A test that passes over
 * the defect it was written for is the thing this repo keeps paying for.
 */
function prerequisiteRow(steps: HTMLElement): HTMLElement {
  const row = steps.closest('div[class*="gap-8"]');
  if (row === null) throw new Error("the pane's two-column row was not found");
  return row as HTMLElement;
}

/**
 * **The prerequisites *column* goes with its headings, which is `Section`'s rule one box out.**
 *
 * `Section` draws nothing for an empty field and that was not enough: the box around the two
 * prerequisite blocks still spent its `w-[300px]` and the row's 32px gap on nothing, and most of
 * the feed's rows fill neither field. Driven in the shipped window 2026-09-20 on Basalt Monolith's
 * first combo, `Steps` began at `left: 1161` against `produces` at 829 and was squeezed into
 * **274px** of a 606px content box, with 300px of blank beside it; with the column dropped the
 * same combo reads `Steps` at `left: 829`, **606px** wide.
 *
 * **jsdom lays nothing out, so the 300px is invisible here and the *structure* is what this pins**
 * — the app's standing answer for a layout rule a suite cannot measure. The row holds one child
 * where the feed filled no prerequisite and two where it filled one, which is the same statement
 * the pixels make.
 *
 * Catches: putting the column back unconditionally. Every heading assertion in the test above
 * stays green through that, because `Section` is still doing its own job correctly.
 */
it("drops the prerequisites column when the feed filled neither field", async () => {
  combosForCard.mockResolvedValue(page([combo({ description: "Do the thing." })]));
  renderWithCard();
  await combosList();

  expect(prerequisiteRow(screen.getByRole("list", { name: "Steps" })).children).toHaveLength(1);
});

it("keeps the prerequisites column when the feed filled one", async () => {
  // The other half, so the test above cannot be satisfied by a pane that draws no columns at all.
  combosForCard.mockResolvedValue(page([FULL]));
  renderWithCard();
  await combosList();

  const row = prerequisiteRow(screen.getByRole("list", { name: "Steps" }));
  expect(row.children).toHaveLength(2);
  expect(within(row.children[0] as HTMLElement).getByText("Prerequisites")).toBeInTheDocument();
});

it("says a combo also needs something no card list can name", async () => {
  // Catches: dropping the `templateCount > 0` block, which would leave a three-piece combo
  // reading as though the two cards drawn in the pane were the whole of it.
  combosForCard.mockResolvedValue(page([combo({ templateCount: 1 })]));
  renderWithCard();
  await combosList();

  expect(screen.getByText(/no card list can name/i)).toBeInTheDocument();
});

it("marks a piece the reader does not own, in words, in the pane and in the rail", async () => {
  // Never by colour alone — the app's rule wherever a status is coloured, and the surface where it
  // matters most, since the whole point of the owned filter is finding the combo you could build
  // tonight. The rail says it too, because that is the list a reader scans.
  //
  // Catches: replacing either note with a class-only treatment, or `owned || "—"`, which would hide
  // the zero this read exists to show.
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

  const list = await combosList();
  expect(screen.getByText("Not owned")).toBeInTheDocument();
  expect(screen.getByText("Owned")).toBeInTheDocument();
  expect(within(list).getByText("Missing 1")).toBeInTheDocument();
});

it("still names a piece the corpus has never synced, in the frame and in the caption", async () => {
  // A combo may name a card this database has no printing for. `CardArt` draws its named, empty
  // frame — this app's existing "no art" state — rather than an error or a blank.
  //
  // Catches: gating the whole piece on `cardId !== null`, or fetching a picture for a null id.
  //
  // **The name is expected *twice*, and asserting that is the point rather than a concession to a
  // query that failed.** `CardArt` prints the name inside the frame it draws when there is no
  // picture, and the pane prints it again as the piece's caption — the caption is the row's label,
  // and the name in the frame is what keeps a wall legible when the art never loads. So a
  // `getByText` fails on the *working* component, and a bare `getAllByText` with no count would go
  // on passing if the caption were deleted. Scoped to the pane because the **rail** draws that same
  // name a third time, as the row's headline.
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
  await combosList();

  expect(within(pane()).getAllByText("Kenrith, the Returned King")).toHaveLength(2);
  // The frame's own status word, which is what makes the empty frame a *statement* rather than a
  // picture that has not arrived yet — `CardArt` says "No card" for a null id and "No image" for a
  // printing whose art failed. Catches passing the oracle id through as a `cardId`.
  expect(within(pane()).getByText("No card")).toBeInTheDocument();
});

it("walks the rail with the arrow keys, and moves the selection with the caret", async () => {
  // **The handler is on the `<ul>` and never on the window** — `Dialog` owns Escape through its
  // capture rung, and a global listener here would be a second claim on a press this dialog has
  // already settled. So the press is driven from a row the reader *clicked*, and it reaches the
  // list by bubbling: `el.focus()` would test a caret nobody has, which is the failure this repo
  // shipped once on three surfaces at once.
  //
  // Catches: moving focus without moving `picked` (the caret and the pane drift apart and the next
  // press needs two); moving `picked` without moving focus (the second arrow comes from the row
  // that is no longer current); dropping `Home`/`End`; and losing the bounds guard, which would
  // wrap `ArrowUp` on the first row round to the last.
  combosForCard.mockResolvedValue(page(THREE));
  const user = userEvent.setup();
  renderWithCard();

  const list = await combosList();
  const at = (i: number) => rowButtons(list)[i] as HTMLElement;

  await user.click(at(0));
  expect(at(0)).toHaveFocus();

  await user.keyboard("{ArrowDown}");
  expect(at(1)).toHaveFocus();
  expect(at(1)).toHaveAttribute("aria-current", "true");
  expect(screen.getByText("Infinite damage")).toBeInTheDocument();

  await user.keyboard("{End}");
  expect(at(2)).toHaveFocus();
  expect(at(2)).toHaveAttribute("aria-current", "true");
  expect(screen.getByText("Infinite mana")).toBeInTheDocument();

  await user.keyboard("{ArrowUp}");
  expect(at(1)).toHaveFocus();
  expect(at(1)).toHaveAttribute("aria-current", "true");

  await user.keyboard("{Home}");
  expect(at(0)).toHaveFocus();
  expect(at(0)).toHaveAttribute("aria-current", "true");

  // The ends are ends. `ArrowUp` on the first row moves nothing rather than wrapping to the last —
  // the rail is a list a reader is walking down, not a carousel.
  await user.keyboard("{ArrowUp}");
  expect(at(0)).toHaveFocus();
  expect(at(0)).toHaveAttribute("aria-current", "true");
});

it("appends the next page when the rail's sentinel comes into view", async () => {
  // **Paging is scrolling, and *Show more* is gone.** The sentinel at the foot of the scroller is
  // the only thing that asks for the next page, so this drives the observer itself — the setup
  // file's stub is a no-op for dnd-kit's sake and would otherwise never fire.
  //
  // Catches: asking for offset 0 again (an infinite first page); a body that renders
  // `pages[pages.length - 1]` rather than flattening every page — the first page's rows would
  // vanish as the second landed; `PAGE_SIZE` drifting away from 50; and a heading that counted the
  // rows in hand instead of `matching`, which would open on `50 combos` rather than `60`.
  const rows = Array.from({ length: 60 }, (_, i) =>
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
  renderWithCard();

  const list = await combosList();
  await waitFor(() => expect(comboRows(list)).toHaveLength(50));
  // The count over the whole matching list rather than over the page in hand — which is why it does
  // not move below.
  expect(railHeading()).toHaveAccessibleName("60 combos");

  await scrollRailToTheFoot();

  await waitFor(() => expect(comboRows(list)).toHaveLength(60));
  expect(combosForCard).toHaveBeenLastCalledWith({
    oracleId: "o1",
    search: null,
    cardCount: null,
    ownedOnly: false,
    limit: 50,
    offset: 50,
  });
  // Appended, not swapped — the first page's first row and the second page's last are both here.
  expect(within(list).getByText("Partner 0")).toBeInTheDocument();
  expect(within(list).getByText("Partner 59")).toBeInTheDocument();
  expect(railHeading()).toHaveAccessibleName("60 combos");
  // Two reads and no more: the opening page and the one the sentinel asked for.
  expect(calls()).toHaveLength(2);
});

it("stops asking once the list has run out", async () => {
  // The other half of the sentinel's gate. `hasNext` is `nextComboOffset`'s answer — every row in
  // hand, so nothing left — and the effect is gated on it *before* the observer is built, so a
  // finished list watches nothing at all.
  //
  // Catches: gating inside the callback instead of in the effect, which leaves an observer on a
  // sentinel that is permanently in view — one `fetchNextPage` per scroll, for ever.
  combosForCard.mockResolvedValue(page(THREE));
  renderWithCard();
  await combosList();

  expect(watchers.filter((w) => w.live && w.targets.length > 0)).toHaveLength(0);
});

it("opens a combo on Commander Spellbook through the app's one external call", async () => {
  // `openExternal` is the app's single call that leaves it, and never a raw `window.open`, which
  // in a Tauri webview navigates the app's own window.
  //
  // Catches: an `<a href>` or a `window.open`, and a malformed permalink — the URL is asserted
  // whole rather than merely "something was opened".
  const user = userEvent.setup();
  renderWithCard();
  await combosList();

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

/* ------------------------------------------------------------------- the filter band ---------
 *
 * The chips and the box above the two columns. Both narrow in SQL and neither touches the page in
 * hand — which is not an optimisation but the only correct answer on a card in six thousand combos.
 */

it("narrows to a combo size at the backend when its chip is pressed", async () => {
  // **The argument is asserted, not the fact that a call happened.** A filter applied to the page
  // in hand would also re-render, and on a card with six thousand combos it would be narrowing
  // 0.8 % of the list while claiming to describe all of it.
  //
  // Catches: sending `bucket.combos` (the count) instead of `bucket.cards` (the size), filtering
  // client-side, forgetting to reset `offset` to 0 when the filter changes, and `PAGE_SIZE` drifting
  // away from 50.
  const two = combo({ id: "a", pieces: [piece(), piece({ oracleId: "o2", name: "Boros Charm" })] });
  const three = combo({
    id: "b",
    pieces: [
      piece(),
      piece({ oracleId: "o2", name: "Boros Charm" }),
      piece({ oracleId: "o3", name: "Avacyn, Angel of Hope" }),
    ],
  });
  combosForCard.mockResolvedValue(page([two, three]));
  const user = userEvent.setup();
  renderWithCard();

  await user.click(await screen.findByRole("button", { name: "3 cards" }));

  expect(combosForCard).toHaveBeenCalledWith({
    oracleId: "o1",
    search: null,
    cardCount: 3,
    ownedOnly: false,
    limit: 50,
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

  await user.click(await screen.findByRole("button", { name: "I own every piece" }));

  expect(combosForCard).toHaveBeenCalledWith({
    oracleId: "o1",
    search: null,
    cardCount: null,
    ownedOnly: true,
    limit: 50,
    offset: 0,
  });
});

it("says the filter left nothing rather than claiming the card is in no combos", async () => {
  // The fourth empty, and it must never borrow one of the other three: the filter band is still on
  // screen above it, and `total` says the card *is* in combos.
  //
  // Catches: testing `matching === 0` where the never-fetched split tests `total === 0`, which
  // would print "Spellbook has none on record" over a list the reader has just narrowed.
  combosForCard.mockResolvedValue(page([combo()], { matching: 0, combos: [] }));
  renderWithCard();

  expect(await screen.findByText(/no combo matches that filter/i)).toBeInTheDocument();
  expect(screen.queryByText(/none on record naming this card/i)).not.toBeInTheDocument();
  expect(screen.queryByText(/has not been downloaded/i)).not.toBeInTheDocument();
});

it("draws the filter's empty rather than a pane with nothing in it", async () => {
  // The `|| selected === null` half of the same branch, which is a page counting rows it did not
  // send. The backend does not produce one — but `Rail` is handed `selected.id`, so the arm is the
  // difference between a sentence and a `TypeError` in a render.
  //
  // Catches: deleting that arm, which nothing else in this file would see.
  combosForCard.mockResolvedValue(page([combo()], { matching: 2, combos: [] }));
  renderWithCard();

  expect(await screen.findByText(/no combo matches that filter/i)).toBeInTheDocument();
});

it("draws a size chip for every size the search leaves, and a count on none of them", async () => {
  // **The counts are gone and the census is not** (2026-09-20). A chip read `3 cards · 1 999` until
  // the redesign, which is five figures of arithmetic in the row a reader is looking past to find
  // the cards. The number it carried is drawn once, over the rail; what the census still decides is
  // which chips exist at all.
  //
  // Catches: putting a count back on a chip; and building the row from something other than the
  // **searched** census, which would leave a `2 cards` chip that can only ever empty the list.
  combosForCard.mockImplementation(answering(THREE));
  const user = userEvent.setup({ delay: null });
  renderWithCard();

  expect(await screen.findByRole("button", { name: "All" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "2 cards" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "3 cards" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "I own every piece" })).toBeInTheDocument();
  // Nothing in the band carries a figure any more — the separator the counts were joined with is
  // the cheapest thing to sweep for.
  expect(screen.queryByRole("button", { name: /·/ })).not.toBeInTheDocument();

  await user.type(searchBox(), "avacyn");

  // Only the three-card combo names Avacyn, so the two-card bucket has left the census.
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "2 cards" })).not.toBeInTheDocument(),
  );
  expect(screen.getByRole("button", { name: "All" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "3 cards" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "I own every piece" })).toBeInTheDocument();
});

it("counts the matching list over the rail, and says it in one text node", async () => {
  // **The one place a figure is drawn now.** `count` rather than `plural`, because this line reads
  // `6,044 combos` on the card it was written for — and one text node, because a `gap` is not a
  // word separator to the accessible-name computation.
  //
  // Catches: the singular arm (`1 combos`); `plural`'s bare number, which would print `6044`; and
  // splitting the figure off into an element of its own, which computes as `1combo`.
  combosForCard.mockImplementation(answering(THREE));
  const user = userEvent.setup({ delay: null });
  renderWithCard();

  await combosList();
  expect(railHeading()).toHaveAccessibleName("3 combos");

  await user.type(searchBox(), "vigor");

  await waitFor(() => expect(railHeading()).toHaveAccessibleName("1 combo"));
});

/* -------------------------------------------------------------------- the search box ---------
 *
 * Ashnod's Altar is in **6 044** combos on the real corpus, 50 to a page. Paging is not a way to
 * *find* anything, so the box is not a convenience: without it there is no way to ask "which of
 * these has Krark-Clan Ironworks in it", and no way for a reader to discover that there might be.
 */

it("sends the trimmed term, and opens the searched list at its top", async () => {
  // **`offset: 0` is the half worth staging rather than asserting from a fresh mount**, which is
  // why this pages the rail first: a search that inherited the pager's offset would open on the
  // second page of a list that has just become shorter than two, and the rows a reader typed a word
  // to find would be above the top of it.
  //
  // Catches: leaving `search` out of `cardCombosKey` (the key never changes, so nothing is asked at
  // all and the pages in hand — and their offset — survive); sending `asked` untrimmed, which opens
  // a second cache entry per trailing space; and any hand-rolled pager that kept its own offset
  // across a filter change.
  const rows = Array.from({ length: 60 }, (_, i) =>
    combo({
      id: `combo-${i}`,
      pieces: [piece(), piece({ oracleId: `o${i}`, name: `Partner ${i}`, cardId: `c${i}` })],
    }),
  );
  combosForCard.mockImplementation(answering(rows));
  const user = userEvent.setup({ delay: null });
  renderWithCard();

  const list = await combosList();
  await waitFor(() => expect(comboRows(list)).toHaveLength(50));
  await scrollRailToTheFoot();
  await waitFor(() => expect(comboRows(list)).toHaveLength(60));

  await user.type(searchBox(), "  boros  ");

  await waitFor(() => expect(searchCalls()).toHaveLength(1));
  expect(searchCalls()[0]).toEqual({
    oracleId: "o1",
    search: "boros",
    cardCount: null,
    ownedOnly: false,
    limit: 50,
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
    limit: 50,
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

it("keeps the size chip that is emptying the list, so there is a way back out", async () => {
  // The state a search-narrowed census makes reachable: a reader narrows to `3 cards`, then types
  // a term no three-card combo matches. The size is still in the query, so the list is empty — and
  // without this the chip doing the emptying would drop out of the row it is drawn from, leaving
  // *No combo matches that filter* over a band of controls none of which is on.
  //
  // Catches: building the chips from `byCardCount` alone. It is the case the rule "a bucket at
  // zero is dropped" was written before, and the pressed chip is its one exception — a control
  // that can only ever empty the list, at the moment it is the control that already has.
  combosForCard.mockImplementation(answering(THREE));
  const user = userEvent.setup({ delay: null });
  renderWithCard();

  await user.click(await screen.findByRole("button", { name: "3 cards" }));
  await waitFor(() => expect(railHeading()).toHaveAccessibleName("1 combo"));

  // Vigor is a piece of a two-card combo only, so the searched census has no three-card bucket.
  await user.type(searchBox(), "vigor");

  expect(await screen.findByText(/no combo matches that filter/i)).toBeInTheDocument();
  const stranding = screen.getByRole("button", { name: "3 cards" });
  expect(stranding).toHaveAttribute("aria-pressed", "true");

  // And pressing it again is the way out — back to All, over the term still in the box.
  await user.click(stranding);
  const list = await combosList();
  expect(railHeading()).toHaveAccessibleName("1 combo");
  expect(within(list).getByText("Vigor")).toBeInTheDocument();
});
