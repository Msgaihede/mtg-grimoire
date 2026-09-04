import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, expect, it, vi } from "vitest";
import type { CardDetail } from "@/lib/ipc";
import { MARKETPLACES, type MarketplaceId } from "@/lib/marketplace";
import { pricesAsOf } from "@/lib/prices";

const cardDetail = vi.fn();
const cardPrintings = vi.fn();
const cardMeldParts = vi.fn();
const cardHoldings = vi.fn();
const collectionList = vi.fn();
const wishlistList = vi.fn();
const collectionAdd = vi.fn();
const collectionSetQuantity = vi.fn();
const wishlistAdd = vi.fn();
const wishlistSetQuantity = vi.fn();
const collectionFolderList = vi.fn();
const wishlistFolderList = vi.fn();
const deckIdsPlaying = vi.fn();
const deckList = vi.fn();
const deckFolderList = vi.fn();
const deckGet = vi.fn();
const deckSetCardQuantity = vi.fn();
const deckCardSetLabel = vi.fn();
const deckLabelAll = vi.fn();
const deckLabelCreate = vi.fn();
const deckCategoryCreate = vi.fn();
const deckMoveCard = vi.fn();
const deckSwapPrinting = vi.fn();
const getMarketplace = vi.fn();
const marketplaceFeedStatus = vi.fn();

/**
 * The whole IPC surface this modal reaches, and it is a long list because the modal is the one
 * screen that answers every question about a card at once — what it is, what it costs, what the
 * reader holds, and which decks play it.
 *
 * Mocked rather than faked: `.storybook/fake` sits under `ipc.ts` and is the workbench's, and a
 * unit test that needed a whole database to assert a class name would be a test about the
 * database.
 */
vi.mock("@/lib/ipc", async (original) => ({
  ...(await original<typeof import("@/lib/ipc")>()),
  ipc: {
    cardDetail: (id: string, marketplace: MarketplaceId) => cardDetail(id, marketplace),
    cardPrintings: (oracleId: string, marketplace: MarketplaceId) =>
      cardPrintings(oracleId, marketplace),
    cardMeldParts: (id: string) => cardMeldParts(id),
    cardHoldings: (oracleId: string) => cardHoldings(oracleId),
    collectionList: (query: unknown) => collectionList(query),
    wishlistList: (query: unknown) => wishlistList(query),
    collectionAdd: (entry: unknown) => collectionAdd(entry),
    collectionSetQuantity: (id: number, quantity: number) => collectionSetQuantity(id, quantity),
    wishlistAdd: (wish: unknown) => wishlistAdd(wish),
    wishlistSetQuantity: (id: number, quantity: number) => wishlistSetQuantity(id, quantity),
    collectionFolderList: () => collectionFolderList(),
    wishlistFolderList: () => wishlistFolderList(),
    deckIdsPlaying: (keys: readonly string[]) => deckIdsPlaying(keys),
    deckList: () => deckList(),
    deckFolderList: () => deckFolderList(),
    deckGet: (id: number, variant: string, marketplace: MarketplaceId) =>
      deckGet(id, variant, marketplace),
    deckSetCardQuantity: (...args: unknown[]) => deckSetCardQuantity(...args),
    deckCardSetLabel: (...args: unknown[]) => deckCardSetLabel(...args),
    // **The list `deck_get` cannot answer.** `deckLabelList` only ever sees a label some card is
    // wearing, so the picker's own list is this one — see the modal's `labelOptions`.
    deckLabelAll: () => deckLabelAll(),
    deckLabelCreate: (...args: unknown[]) => deckLabelCreate(...args),
    deckCategoryCreate: (...args: unknown[]) => deckCategoryCreate(...args),
    deckMoveCard: (...args: unknown[]) => deckMoveCard(...args),
    // The Printing picker's write where a deck row is behind the modal — the same command
    // `AllPrintingsDialog`'s tiles press, borrowed through `useDeck`'s one definition of it.
    deckSwapPrinting: (...args: unknown[]) => deckSwapPrinting(...args),
    getMarketplace: () => getMarketplace(),
    marketplaceFeedStatus: () => marketplaceFeedStatus(),
  },
}));

import { CardDetailModal } from "./CardDetailModal";
import { LABEL_COLORS } from "@/features/decks/labelColors";
import { useAppStore } from "@/lib/store";

const detail: CardDetail = {
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
  illustrationId: "art-a",
  artist: "Christopher Rush",
  releasedAt: "1993-08-05",
  legalities: null,
  finishPrices: { nonfoil: 620, foil: null, etched: null },
  finishes: '["nonfoil"]',
  promoTypes: null,
  imageStatus: "highres_scan",
  faces: [],
  imageUris: null,
};

/**
 * The deck row a card can be opened out of — `PaneDeckContext`'s **six** fields. `DeckVariant` is
 * `"live" | "theory"` and `finish: DeckFinish` is required, which is what makes a four-field
 * fixture fail to compile rather than fail at runtime.
 */
const deckRow = {
  deckId: 1,
  categoryId: 2,
  categoryName: "Burn spells",
  cardId: "c1",
  variant: "live",
  finish: null,
} as const;

/** Just enough of a deck for the modal's four deck controls to have something to draw. */
function deckDetail() {
  return {
    deck: { id: 1, name: "Burn", archived: false, folderId: null },
    cards: [
      {
        id: 9,
        cardId: "c1",
        categoryId: 2,
        categoryName: "Burn spells",
        finish: null,
        quantity: 4,
        labelId: null,
      },
    ],
    categories: [
      { id: 2, name: "Burn spells" },
      { id: 3, name: "Lands" },
    ],
    labels: [{ id: 7, name: "Needs testing", color: "gold" }],
  };
}

function renderModal(cardId: string | null = "c1") {
  if (cardId !== null) useAppStore.getState().setSelectedCardId(cardId);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <CardDetailModal />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState());
  cardDetail.mockReset().mockResolvedValue(detail);
  cardPrintings.mockReset().mockResolvedValue({ items: [], total: 0 });
  // `[]` is the answer for 116 518 of the 116 590 live rows, and the command never rejects.
  cardMeldParts.mockReset().mockResolvedValue([]);
  // Three zeros is the honest answer about a card nobody holds, and `card_holdings` never
  // rejects — so this is what almost every test in this file wants behind the block.
  cardHoldings.mockReset().mockResolvedValue({ owned: 0, wished: 0, decks: 0 });
  collectionList.mockReset().mockResolvedValue({ items: [], total: 0 });
  wishlistList.mockReset().mockResolvedValue({ items: [], total: 0 });
  collectionAdd.mockReset().mockResolvedValue({ id: 1, quantity: 1 });
  collectionSetQuantity.mockReset().mockResolvedValue({ id: 1, quantity: 2 });
  wishlistAdd.mockReset().mockResolvedValue({ id: 1, quantity: 1 });
  wishlistSetQuantity.mockReset().mockResolvedValue({ id: 1, quantity: 2 });
  collectionFolderList.mockReset().mockResolvedValue([]);
  wishlistFolderList.mockReset().mockResolvedValue([]);
  deckIdsPlaying.mockReset().mockResolvedValue([]);
  deckList.mockReset().mockResolvedValue([]);
  deckFolderList.mockReset().mockResolvedValue([]);
  deckGet.mockReset().mockResolvedValue(null);
  deckSetCardQuantity.mockReset().mockResolvedValue({ quantity: 5, removed: false });
  deckCardSetLabel.mockReset().mockResolvedValue(undefined);
  deckLabelAll.mockReset().mockResolvedValue([]);
  deckLabelCreate.mockReset().mockResolvedValue({
    id: 8,
    name: "Cut candidate",
    color: "#d9b95c",
    cardCount: 0,
    deckCount: 0,
  });
  deckCategoryCreate.mockReset().mockResolvedValue({ id: 42, name: "Ramp" });
  deckMoveCard.mockReset().mockResolvedValue(42);
  // A plain swap: the pile held no row of the printing that was picked, so nothing folded.
  deckSwapPrinting.mockReset().mockResolvedValue({ folded: false, quantity: 4 });
  // Nobody has chosen one, which is what a fresh install reads.
  getMarketplace.mockReset().mockResolvedValue("tcgplayer");
  marketplaceFeedStatus.mockReset().mockResolvedValue([]);
});

it("names the panel after the card, and puts the type line in the heading with it", async () => {
  renderModal("c1");

  // `Dialog` sets `aria-labelledby` to its own heading, so the modal is addressed by the card
  // rather than by a category word — which is what every `App.test.tsx` query becomes.
  const dialog = await screen.findByRole("dialog", { name: /lightning bolt/i });
  expect(dialog).toBeInTheDocument();
  // The type line is in the *heading* rather than in `Dialog`'s `subtitle`, which is what makes
  // it stack under the name below the fold and sit beside it above one. A subtitle is one
  // truncating line and could not.
  expect(dialog).toHaveAccessibleName(/instant/i);
});

it("hands the caret back to the opener when dismissed", async () => {
  // **Two different functions, and the difference is the caret.** Escape and the ✕ are the reader
  // saying "put me back"; a press on the scrim means they have already moved on, and pulling
  // focus to a tile they are no longer looking at is the app arguing with them. Wiring
  // `onDismiss` at the plain store clear passes every other assertion in this file and fails
  // this one — which is the failure that shipped once and was found by driving the window.
  const opener = document.createElement("button");
  document.body.append(opener);
  opener.focus();

  renderModal("c1");
  await screen.findByRole("dialog");

  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(opener).toHaveFocus();

  opener.remove();
});

it("hides the step chevrons when the walk holds no stop for the open card", async () => {
  // A card reached from a meld relation or a printing swap has no position in any list, and a
  // chevron that cannot say where it would go is worse than no chevron. Satisfied with
  // `flanks: undefined` — `StepChevron` renders `disabled` at the end of a walk by design, and
  // teaching one to vanish would delete that state from the printings modal too.
  useAppStore.setState({ cardWalk: { label: "Search results", stops: [] } });
  renderModal("c1");
  await screen.findByRole("dialog");

  expect(screen.queryByRole("button", { name: /previous/i })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /next/i })).not.toBeInTheDocument();
});

it("draws a chevron pair when the walk holds a stop for the open card", async () => {
  useAppStore.setState({
    cardWalk: {
      label: "Search results",
      stops: [
        { cardId: "c0", oracleId: "o0", name: "Ancestral Recall", deck: null },
        { cardId: "c1", oracleId: "o1", name: "Lightning Bolt", deck: null },
        { cardId: "c2", oracleId: "o2", name: "Black Lotus", deck: null },
      ],
    },
  });
  renderModal("c1");
  await screen.findByRole("dialog");

  // jsdom's `matchMedia` never matches, so the window reads as narrower than 900 and the pair is
  // drawn in the action row's corner rather than as `Dialog`'s flanks. Either way there are two
  // of them and each names the list it walks.
  expect(
    screen.getByRole("button", { name: /previous card in search results/i }),
  ).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /next card in search results/i })).toBeInTheDocument();
});

/** The three-stop walk both arrow tests below step along, with the open card in the middle. */
function walkOfThree() {
  useAppStore.setState({
    cardWalk: {
      label: "Search results",
      stops: [
        { cardId: "c0", oracleId: "o0", name: "Ancestral Recall", deck: null },
        { cardId: "c1", oracleId: "o1", name: "Lightning Bolt", deck: null },
        { cardId: "c2", oracleId: "o2", name: "Black Lotus", deck: null },
      ],
    },
  });
}

/**
 * **The arrows are the chevrons' keyboard twin**, and the reader asked for them by naming the
 * surface that already had them: *"exactly the same way as in the 'View all printings' modal"*.
 * So this is `AllPrintingsDialog`'s handler, on this panel, sharing one `ownsArrowKeys` — a
 * second copy of that exempt-control list would be two lists to keep in agreement, and a control
 * quietly falling off one of them is the whole failure it guards.
 */
it("steps to the next card on ArrowRight and the previous one on ArrowLeft", async () => {
  walkOfThree();
  renderModal("c1");
  await screen.findByRole("dialog");
  await screen.findByRole("button", { name: /next card in search results/i });

  // No `focus()` call: `Dialog` puts the caret on its panel when it opens, which is the entry
  // point a reader actually has. Focusing the panel by hand here would test a caret nobody can
  // reach and would pass over a handler wired to the wrong node.
  await userEvent.keyboard("{ArrowRight}");
  expect(useAppStore.getState().selectedCardId).toBe("c2");

  await userEvent.keyboard("{ArrowLeft}");
  expect(useAppStore.getState().selectedCardId).toBe("c1");
});

/**
 * **The half of "one card at a time" that jsdom can see.**
 *
 * The reader's requirement is that the card modal and the printings modal open together still
 * move one card per press. That is structural rather than guarded: both are siblings in `App`,
 * `Dialog` mounts no portal, and the handler is on the **panel** — so a press inside the other
 * dialog reaches neither this panel's DOM node nor its React parent, and whoever holds the caret
 * answers. Nothing in the modal asks whether the other one is open, because nothing in it can be
 * reached while it is.
 *
 * What a suite can pin is the property that makes that true: this is not a `window` listener. A
 * press outside the panel must do nothing — and a `window` handler, which is how this would most
 * naturally have been written and would have stepped twice, fails right here.
 */
it("does not step on an arrow press outside its panel", async () => {
  walkOfThree();
  renderModal("c1");
  await screen.findByRole("dialog");
  await screen.findByRole("button", { name: /next card in search results/i });

  fireEvent.keyDown(document.body, { key: "ArrowRight" });
  expect(useAppStore.getState().selectedCardId).toBe("c1");
});

/**
 * `<select>` is the case the exemption exists for — ArrowLeft on a focused one changes its value
 * in Chromium and in WebView2 with it — but the controls column has no `<select>`: it is
 * `Dropdown`s, whose two arrow-owning shapes are the trigger while its panel is open and
 * anything inside the panel. This modal has more of them than the printings dialog does (the
 * quantity stepper, the printing picker, the category and label pickers), so the exemption
 * matters more here than at the surface it was written for.
 */
it("leaves the arrows to an open dropdown rather than stepping the walk", async () => {
  walkOfThree();
  renderModal("c1");
  await screen.findByRole("dialog");
  await screen.findByRole("button", { name: /next card in search results/i });

  // The shape `ownsArrowKeys` matches, built here rather than by driving a real dropdown open:
  // the predicate is about the *element under the caret*, and a test that opened a picker would
  // be asserting that picker's markup as much as this guard.
  const trigger = document.createElement("button");
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", "true");
  screen.getByRole("dialog").append(trigger);

  fireEvent.keyDown(trigger, { key: "ArrowRight", bubbles: true });
  expect(useAppStore.getState().selectedCardId).toBe("c1");

  trigger.remove();
});

/**
 * A modifier held means the press was aimed at the browser or at a shortcut, never at a chevron
 * — and at either end of the walk the matching stop is `null` and the press falls through
 * **without** a `preventDefault`, so the key does whatever it would have done. Both are the
 * absence of a claim rather than a swallowed press, which is why they are asserted together.
 */
it("ignores a modified arrow, and both ends of the walk", async () => {
  walkOfThree();
  renderModal("c1");
  await screen.findByRole("dialog");
  const panel = screen.getByRole("dialog");
  await screen.findByRole("button", { name: /next card in search results/i });

  const modified = fireEvent.keyDown(panel, { key: "ArrowRight", ctrlKey: true });
  expect(useAppStore.getState().selectedCardId).toBe("c1");
  expect(modified, "a modified press is left for whatever else wanted it").toBe(true);

  // Walk to the last stop, then press past it.
  await userEvent.keyboard("{ArrowRight}");
  expect(useAppStore.getState().selectedCardId).toBe("c2");
  const pastTheEnd = fireEvent.keyDown(panel, { key: "ArrowRight" });
  expect(useAppStore.getState().selectedCardId).toBe("c2");
  expect(pastTheEnd, "the end of the walk swallows nothing").toBe(true);
});

it("draws the grimoire counts twice, so exactly one is visible at every rung", async () => {
  // **All four artboards show the counts.** `CardModalRail` draws them `hidden` below
  // `@min-[1200px]/card`, so at the three narrower rungs they *move* rather than vanish — and the
  // inline copy is the other half. jsdom resolves no container query and both are in the DOM at
  // once, so the fold is asserted as a pair of complementary classes: the class **is** the
  // behaviour here, and without the second copy the counts disappear below 1200px with every
  // other test in this file still green.
  renderModal("c1");
  await screen.findByRole("dialog");

  // `findAll`, because the panel is on screen while the card is still a fetch away — the dialog
  // resolves before its body has a card to draw counts about.
  const headings = await screen.findAllByText(/in your grimoire/i);
  expect(headings).toHaveLength(2);

  const boxes = headings.map((h) => h.parentElement as HTMLElement);
  const wide = boxes.find((b) => b.classList.contains("@min-[1200px]/card:flex"));
  const narrow = boxes.find((b) => b.classList.contains("@min-[1200px]/card:hidden"));

  expect(wide).toBeDefined();
  expect(narrow).toBeDefined();
  // The rail's copy is hidden until the widest rung…
  expect(wide?.classList.contains("hidden")).toBe(true);
  // …and the inline copy is hidden from it, which is what makes the pair complementary rather
  // than two copies fighting.
  expect(narrow?.classList.contains("hidden")).toBe(false);
});

it("wires every control a card opened out of a deck draws", async () => {
  // **An unwired handler is silently inert** — the control draws, the reader presses it, and
  // nothing happens with nothing going red. `CardModalControls` takes its nine wiring props
  // optional with inert defaults so that its own test can exist without a deck in the tree, which
  // is exactly what makes a host that forgot one impossible to see from that file. This is the
  // test that sees it: the stepper and the label picker are the two that write, and each is
  // asserted against the command it has to reach.
  deckGet.mockResolvedValue(deckDetail());
  useAppStore.setState({ activeView: "decks" });
  useAppStore.getState().openCardFromDeck(deckRow);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <CardDetailModal />
    </QueryClientProvider>,
  );
  await screen.findByRole("dialog");

  // The stepper is bound to the deck row, and its name says *what* is being counted.
  const up = await screen.findByRole("button", { name: /increase copies of lightning bolt/i });
  await userEvent.click(up);
  await waitFor(() => expect(deckSetCardQuantity).toHaveBeenCalled());
  // deckId, cardId, categoryId, variant, finish, quantity — the row's whole grain plus the
  // absolute the stepper states.
  expect(deckSetCardQuantity).toHaveBeenCalledWith(1, "c1", 2, "live", null, 5);

  // The deck's coloured mark is a **label**, and `deckCardSetLabel` is its writer. It type-checked
  // as `tagId` for a whole wave, because the props are declared locally rather than off
  // `DeckCard` — so a host could have wired `labelId` into a prop named `tagId` with nothing
  // going red.
  expect(screen.getByRole("button", { name: /^category/i })).toBeInTheDocument();
  const label = screen.getByRole("button", { name: /^label/i });
  await userEvent.click(label);
  await userEvent.click(await screen.findByRole("option", { name: "Needs testing" }));
  await waitFor(() => expect(deckCardSetLabel).toHaveBeenCalled());
  expect(deckCardSetLabel).toHaveBeenCalledWith(1, "c1", 2, "live", null, 7);
});

it("seeds the foil view from the finish the surface that opened the card named", async () => {
  // **`CardModalArt` reads no store**, so the seed is this host's to supply: `openCardAsFinish` is
  // what a collection tile that *is* a foil calls, and without the prop the reader who pressed
  // their foil copy was shown the plain photograph of it. The toggle's visible words are its
  // accessible name, so a seeded one already says the way back.
  cardDetail.mockResolvedValue({ ...detail, finishes: '["nonfoil","foil"]' });
  useAppStore.getState().openCardAsFinish("c1", "foil");
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <CardDetailModal />
    </QueryClientProvider>,
  );

  const toggle = await screen.findByRole("button", { name: "View as nonfoil" });
  expect(toggle).toHaveAttribute("aria-pressed", "true");
});

it("asks for meld relations only for a meld card", async () => {
  // The gate is a saved round trip rather than a correctness guard — `card_meld_parts` answers
  // `[]` for every other layout and never rejects — but it is 116 518 cards a reader can open
  // without paying for the call, and an `enabled` that drifted to `true` would be invisible.
  renderModal("c1");
  await screen.findByRole("dialog");
  await waitFor(() => expect(cardPrintings).toHaveBeenCalled());

  expect(cardMeldParts).not.toHaveBeenCalled();
});

it("credits the illustrator of the face on screen, meld view included", async () => {
  // **A licensing requirement rather than a cosmetic one.** Scryfall's usage rules want the artist
  // identifiable wherever the art is shown, and the two halves of a meld are not always the same
  // illustrator — which is the whole reason `MeldRelation` carries an artist. While the melded
  // card's picture is up, the open card's illustrator is the wrong name under the right art.
  //
  // This is also the wiring test for the control itself: `ipc.cardMeldParts` had **zero callers
  // in the app** for a wave, so the query, the button and the credit are asserted in one pass.
  cardDetail.mockResolvedValue({
    ...detail,
    layout: "meld",
    name: "Bruna, the Fading Light",
    artist: "Christopher Rush",
  });
  cardMeldParts.mockResolvedValue([
    {
      id: "r1",
      name: "Brisela, Voice of Nightmares",
      component: "meld_result",
      artist: "Clint Cearley",
    },
  ]);
  renderModal("c1");
  await screen.findByRole("dialog");

  expect(await screen.findByText(/illustrated by christopher rush\./i)).toBeInTheDocument();

  const meld = await screen.findByRole("button", {
    name: "Meld — Brisela, Voice of Nightmares",
  });
  await userEvent.click(meld);

  expect(await screen.findByText(/illustrated by clint cearley\./i)).toBeInTheDocument();
  expect(screen.queryByText(/illustrated by christopher rush\./i)).not.toBeInTheDocument();
  // The frame is a picture of that card too — the alt text is what a screen reader announces.
  expect(screen.getByAltText("Brisela, Voice of Nightmares")).toBeInTheDocument();
});

it("dates the prices it draws, in the footer beside the credit", async () => {
  // **Spec §5: a price is never shown without saying how old it is** — and, with five
  // marketplaces in the picker, whose. This lived under `CardModalArt`'s price cells until
  // 2026-09-03 and is a footnote of the panel now; the obligation did not move with it, so this
  // is that file's assertion in its new home rather than a new test.
  //
  // Through `pricesAsOf` rather than the sentence typed out here, so it pins the function — and
  // with it the right clock, the card-data sync for the blob-backed pair rather than a feed
  // refresh — instead of a copy of its words. **Once**, because the whole point of the move is
  // that one panel says it one time: `CardModalArt.test.tsx`'s negative half guards the other
  // end.
  renderModal("c1");
  await screen.findByRole("dialog");

  const asOf = await screen.findByText(pricesAsOf(MARKETPLACES.tcgplayer));
  expect(screen.getAllByText(pricesAsOf(MARKETPLACES.tcgplayer))).toHaveLength(1);
  // Beside the credit rather than anywhere in the panel: the two are one block, credit above.
  const footnotes = asOf.parentElement as HTMLElement;
  expect(within(footnotes).getByText(/card images © wizards of the coast/i)).toBeInTheDocument();
});

it("says nothing about the age of prices it is not drawing", async () => {
  // `CardModalArt` draws one cell per finish and **no cells at all** for a printing whose
  // `finishes` is empty — nothing is known about how it is sold, which is not the claim that it
  // is free. That arm was this column's and travelled with the sentence: a footer dating prices
  // that are not on screen is a caption about nothing, and it is the half of a moved condition
  // that is easiest to leave behind.
  cardDetail.mockResolvedValue({ ...detail, finishes: null });
  renderModal("c1");
  await screen.findByRole("dialog");

  // The credit is still drawn — this is a card with no known finishes, not a card with no art —
  // so the footnote block being present is what makes the missing line an assertion.
  expect(await screen.findByText(/card images © wizards of the coast/i)).toBeInTheDocument();
  expect(screen.queryByText(pricesAsOf(MARKETPLACES.tcgplayer))).not.toBeInTheDocument();
});

/**
 * **The other half of the same condition, and it did not exist until the printings list did.**
 *
 * The sentence used to be gated on the open card's own `finishes`, because the art column's
 * price cells were the only prices on the panel. The list below the controls prices every *other*
 * printing, so a card with no known finishes of its own now draws a column of figures with the
 * old gate saying nothing about them. The test above is what makes this one an assertion rather
 * than a pair of coincidences: same card, same null `finishes`, and the only difference is
 * whether the list has rows.
 */
it("dates the list's prices for a card that has no finishes of its own", async () => {
  cardDetail.mockResolvedValue({ ...detail, finishes: null });
  cardPrintings.mockResolvedValue(printings);
  renderModal("c1");
  await screen.findByRole("dialog");

  expect(await screen.findByText(pricesAsOf(MARKETPLACES.tcgplayer))).toBeInTheDocument();
});

it("keeps both footnotes in the action row rather than under it", async () => {
  // **The reader's instruction, and the only part of it a suite can hold.** The two sentences
  // are the footer's left corner and the chevrons and buttons its right — one row — so the
  // footnotes may not add a rung of height beneath the buttons, which is height taken off the
  // picture on a panel whose whole job is to show one.
  //
  // **jsdom has no layout engine**, so this asserts *structure* and one class rather than a
  // measurement: the footnote block is a flex item of the same wrapping row the buttons are in,
  // and its next sibling is the group that holds them. Moving the block back out — under the row
  // as the `<p className="mt-2">` this replaced — leaves it with no next sibling and reparents it
  // onto the footer's padded box, so both halves of this go red. The pixels were read in the
  // running window.
  renderModal("c1");
  await screen.findByRole("dialog");

  const credit = await screen.findByText(/card images © wizards of the coast/i);
  const footnotes = credit.parentElement as HTMLElement;
  const actions = footnotes.nextElementSibling as HTMLElement | null;

  expect(actions).not.toBeNull();
  expect(actions).toContainElement(screen.getByRole("button", { name: "Add to collection" }));
  expect(actions).toContainElement(screen.getByRole("button", { name: "Add to wishlist" }));
  // The shared parent is the row itself and not the footer's box around it — `flex-wrap` is what
  // tells those two apart, and it is also the thing that lets the phone rung stack them instead
  // of crushing the buttons.
  const row = footnotes.parentElement as HTMLElement;
  expect(row.classList.contains("flex")).toBe(true);
  expect(row.classList.contains("flex-wrap")).toBe(true);
});

/**
 * What both copies of the **In your grimoire** block state for one word.
 *
 * Two of them at every rung by construction — the rail's and the inline one, complementary
 * container queries — so an assertion that read only the first would pass while the copy a reader
 * actually sees said something else. The `<dt>`'s next element is its `<dd>`: the two are siblings
 * in a `<dl>` rather than nested, which is also why a bare `getByText` on the number could not
 * say which figure it had found.
 */
function figures(label: string): string[] {
  return screen
    .getAllByRole("heading", { name: /in your grimoire/i })
    .map((heading) => heading.parentElement as HTMLElement)
    .map((box) => within(box).getByText(label).nextElementSibling?.textContent ?? "");
}

it("draws the grimoire figures from one read, and asks for no list to do it", async () => {
  // **The reason this task existed.** The block used to cost `collection_list`, `wishlist_list`
  // and `deck_ids_playing` on every card open — three round trips answering two pages of rows so
  // that the webview could sum a `quantity` column and take the size of a set. `card_holdings`
  // answers all three numbers, at the oracle grain, in one. The three `not.toHaveBeenCalled`
  // lines are the fence: a re-added list read costs a round trip and shows on no screen.
  cardHoldings.mockResolvedValue({ owned: 3, wished: 1, decks: 2 });
  renderModal("c1");
  await screen.findByRole("dialog");

  await waitFor(() => expect(figures("Owned")).toEqual(["3", "3"]));
  expect(figures("Wished")).toEqual(["1", "1"]);
  expect(figures("In decks")).toEqual(["2", "2"]);
  // The oracle id and never the printing — a reader who owns the Alpha Bolt and opens the 2X2 one
  // owns *Lightning Bolt*.
  expect(cardHoldings).toHaveBeenCalledWith("o1");

  expect(collectionList).not.toHaveBeenCalled();
  expect(wishlistList).not.toHaveBeenCalled();
  expect(deckIdsPlaying).not.toHaveBeenCalled();
});

it("keeps the collection rows on the collection surface, where the stepper writes to one", async () => {
  // **The judgement call this task turned on.** The figures moved to `card_holdings`, but
  // `collection_set_quantity` is addressed by a **row id** — so deleting the list read along with
  // the count it used to feed would leave the collection surface's stepper drawing a number it
  // could not move: the control draws, the reader presses it, nothing happens, nothing goes red.
  collectionList.mockResolvedValue({ items: [{ id: 42, cardId: "c1", quantity: 2 }], total: 1 });
  useAppStore.setState({ activeView: "collection" });
  renderModal("c1");
  await screen.findByRole("dialog");

  await waitFor(() =>
    expect(collectionList).toHaveBeenCalledWith({ oracleId: "o1", limit: 200, offset: 0 }),
  );
  // …and the *other* list is still not asked for. The gate is per surface, not "keep both".
  expect(wishlistList).not.toHaveBeenCalled();

  const up = await screen.findByRole("button", {
    name: /increase copies of lightning bolt you own/i,
  });
  await userEvent.click(up);
  await waitFor(() => expect(collectionSetQuantity).toHaveBeenCalledWith(42, 3));
});

it("keeps the wishlist rows on the wishlist surface, where its own stepper writes to one", async () => {
  wishlistList.mockResolvedValue({ items: [{ id: 7, cardId: "c1", quantity: 1 }], total: 1 });
  useAppStore.setState({ activeView: "wishlist" });
  renderModal("c1");
  await screen.findByRole("dialog");

  await waitFor(() =>
    expect(wishlistList).toHaveBeenCalledWith({ oracleId: "o1", limit: 200, offset: 0 }),
  );
  expect(collectionList).not.toHaveBeenCalled();

  const up = await screen.findByRole("button", {
    name: /increase copies of lightning bolt on your wishlist/i,
  });
  await userEvent.click(up);
  await waitFor(() => expect(wishlistSetQuantity).toHaveBeenCalledWith(7, 2));
});

it("re-reads the figures after a write it has no callback to hang off", async () => {
  // **The cost of one read replacing three, paid back.** The old block was three queries, one
  // under each of `["collection"]`, `["wishlist"]` and `["decks"]`, so every writer in the app
  // refreshed it through the invalidation vocabulary it already used. One query can be under only
  // one of those roots — and `Add to wishlist` here goes through `CardMenuDeps`, whose `mutate`
  // returns `void`, so there is nothing to chain an invalidation onto either. The falling edge of
  // `useIsMutating` is what catches it; without that the figure goes on saying what it said
  // before the press, which is the failure `query.ts`'s 30 s `staleTime` makes look deliberate.
  renderModal("c1");
  await screen.findByRole("dialog");
  await waitFor(() => expect(cardHoldings).toHaveBeenCalledTimes(1));
  expect(figures("Wished")).toEqual(["0", "0"]);

  cardHoldings.mockResolvedValue({ owned: 0, wished: 1, decks: 0 });
  await userEvent.click(screen.getByRole("button", { name: "Add to wishlist" }));
  await waitFor(() => expect(wishlistAdd).toHaveBeenCalled());

  await waitFor(() => expect(figures("Wished")).toEqual(["1", "1"]));
});

/**
 * **The panel's size rungs are all one variant family, and a named breakpoint among them breaks
 * every rung above it — silently, and only in a browser.**
 *
 * Measured in the shipped window on 2026-09-03: with `sm:` spelling the 640 rung, the panel drew
 * **764px at a 2560px viewport**, and the 900 and 1200 rungs never applied at any width. Tailwind
 * v4 emits arbitrary `min-[…]` variants as one group, sorted ascending, and named breakpoints as
 * a **later** group — so at a wide viewport every rung matched and the last one in source order
 * won, which was `sm:`. Positions in the emitted sheet: `(width >= 900px)` at 84141,
 * `(width >= 1200px)` at 84306, and `width: 47.75rem` at **84628**, after both.
 *
 * **No rendering assertion here can catch it**, which is why this one is about the *source*:
 * jsdom has no layout engine and no cascade, so a test asserting these classes are present passes
 * either way — all four were present and one of them always won. `twMerge` is not the culprit
 * either; it kept all four, and CSS then picked the wrong one.
 *
 * So the invariant is the only testable half: one family, every rung. It is stated as "no named
 * breakpoint sizes this panel" rather than "use `min-[…]`", because the defect is the *mixture* —
 * an all-`sm:`/`lg:` string would be wrong for other reasons but would not be this bug.
 */
it("sizes the panel with one variant family, never a named breakpoint", async () => {
  renderModal("c1");
  const panel = await screen.findByRole("dialog");

  // `min-` as well as the bare utility since 2026-09-03: the heights are `min-h-[…]` floors now,
  // and a sweep that only looked at `h-` would have stopped watching three of the four rungs the
  // moment they changed shape. `max-` is deliberately not swept — `max-h-full`/`max-w-full` are
  // `Dialog`'s own and carry no variant.
  const sized = [...panel.classList].filter((c) => /(^|:)min-(w|h)-|(^|:)(w|h)-/.test(c));
  // Sanity, so the filter below is looking at something: every rung is on this element.
  expect(sized.length).toBeGreaterThanOrEqual(6);

  expect(sized.filter((c) => /^(sm|md|lg|xl|2xl):/.test(c))).toEqual([]);
});

/**
 * **The rule between the options and the content is drawn at exactly the rung where the rail is a
 * column, and the pairing is the whole assertion.**
 *
 * At `@min-[900px]/card` the rail is the grid's third column, standing beside the controls with a
 * gutter between them — a vertical rule there separates two things. Below that rung the rail is
 * `row-start-2`, *under* those controls and in the same column, where a left border would be a
 * line with nothing on either side of it. So the border and the `col-start-3` that earns it have
 * to move together, and this test fails if either is given a rung of its own.
 *
 * **jsdom resolves no container query**, so what is checked is the variant on the class rather
 * than a rendered pixel — the same reason the panel's own rung test is written that way. The
 * border was measured in the shipped window instead: `1px solid oklch(0.3 0.01 270)` at 1400,
 * and `0px` at 820 and 390.
 */
it("draws the rail's divider only at the rung where the rail is a column", async () => {
  renderModal("c1");
  const panel = await screen.findByRole("dialog");
  // **The panel mounts before the card arrives, and the whole body grid is behind `card !== null`
  // — so a rung assertion made on the panel alone is made against an empty box.** `findByRole`
  // above resolves the moment `Dialog` renders, which is several commits early; waiting for a
  // rail entry is waiting for the column this test is about to exist at all.
  await screen.findByRole("button", { name: "Legality" });

  // Found by walking `classList` rather than with `querySelector`, because the class this is
  // about contains `[`, `]`, `/` and `:` — every one of which is CSS syntax, so an attribute
  // selector carrying it has to be escaped to be a *selector* rather than a parse error. The
  // first spelling of this test matched nothing and read as a missing element.
  const rail = [...panel.querySelectorAll("div")].find((d) =>
    d.classList.contains("@min-[900px]/card:col-start-3"),
  );
  expect(rail).toBeDefined();

  const classes = [...(rail as HTMLElement).classList];
  expect(classes).toContain("@min-[900px]/card:border-l");
  // The gutter's own width, so the rule sits midway rather than against the first word.
  expect(classes).toContain("@min-[900px]/card:pl-5");
  // The half that would go wrong quietly: an unprefixed `border-l` draws the line on a phone,
  // down the side of a rail that is one more block in a single scroller.
  expect(classes).not.toContain("border-l");
});

/**
 * **The main area is two columns at the widest rung and one stack below it** — everything that
 * writes to the card on the left, the printings list on the right.
 *
 * jsdom resolves no container query and every box is 0, so this pins the classes and the widths
 * are settled in the window. Measured at a 1240px panel; at 1100, 950, 820, 600 and 390 the two
 * share a left edge with the controls above the list.
 *
 * **The scroller moving down a level is the half worth pinning.** As one column this box scrolled
 * everything together, so going looking down Forest's 865 printings took the quantity stepper and
 * the pickers off the screen with it — controls are about the card, not about the list. Measured
 * after the change: the printings column scrolled 4000px and `View all printings` did not move
 * from y=102.
 */
it("splits the main area into list and controls at the widest rung only", async () => {
  renderModal("c1");
  const panel = await screen.findByRole("dialog");
  await screen.findByRole("button", { name: "Legality" });

  // `classList` rather than a selector, for the reason the divider test above spells out.
  const middle = [...panel.querySelectorAll("div")].find((d) =>
    d.classList.contains("@min-[1200px]/card:grid-cols-[15rem_minmax(0,1fr)]"),
  );
  expect(middle, "the middle column declares no two-column track").toBeDefined();
  const middleClasses = [...(middle as HTMLElement).classList];

  // The row track and the released overflow are what hand the scrolling to the children: an
  // implicit `auto` row sizes to its content, so each child would have all the room it asked for
  // and never scroll — and a parent still carrying `overflow-y-auto` would scroll them together.
  expect(middleClasses).toContain("@min-[1200px]/card:grid-rows-[minmax(0,1fr)]");
  expect(middleClasses).toContain("@min-[1200px]/card:overflow-y-visible");
  // Below the rung it is the stack it always was, and the scroller is this box.
  expect(middleClasses).toContain("@min-[640px]/card:overflow-y-auto");
  expect(middleClasses).toContain("flex-col");

  const child = (n: string) =>
    [...(middle as HTMLElement).children].find((c) =>
      c.classList.contains(`@min-[1200px]/card:${n}`),
    );

  // **Left is the controls and right is the list**, which is the whole of what was asked for.
  // Named on each side rather than counted: the columns shipped the other way round for one
  // commit, and a test that only checked there were two of them passed on both.
  const controls = child("col-start-1");
  const list = child("col-start-2");
  expect(list, "no column-1 child").toBeDefined();
  expect(controls, "no column-2 child").toBeDefined();
  expect(list).toContainElement(screen.getByRole("heading", { name: "Printings" }));
  expect(controls).toContainElement(
    screen.getByRole("button", { name: /^View all printings/ }),
  );

  // The controls column scrolls itself.
  const controlsClasses = [...(controls as HTMLElement).classList];
  expect(controlsClasses).toContain("@min-[1200px]/card:overflow-y-auto");
  expect(controlsClasses).toContain("@min-[1200px]/card:min-h-0");

  // **The list column does not — the list inside it does**, which is the whole of what keeps
  // the heading, the sort control and the count line on screen while the rows move. A scroller
  // out here takes them with it, and that is exactly the shape this had first.
  const listClasses = [...(list as HTMLElement).classList];
  expect(listClasses).toContain("@min-[1200px]/card:min-h-0");
  expect(listClasses, "the list column must not scroll; its body does").not.toContain(
    "@min-[1200px]/card:overflow-y-auto",
  );

  // Neither claims any scrolling below the rung, where the main column is the one scroller.
  for (const box of [list, controls]) {
    expect(
      [...(box as HTMLElement).classList],
      "a child that scrolls at every rung is a second scroller in the phone's single one",
    ).not.toContain("overflow-y-auto");
  }

  // **The head is outside the body**, named piece by piece rather than by counting children:
  // each of the three is a thing a reader three hundred rows down would otherwise have lost.
  const heading = screen.getByRole("heading", { name: "Printings" });
  const section = heading.closest("section");
  const body = section?.querySelector(".overflow-y-auto");
  expect(body, "the printings section draws no scroller of its own").toBeTruthy();
  expect(body).not.toContainElement(heading);
  expect(body).not.toContainElement(screen.getByRole("button", { name: /group printings by/i }));
  expect(body).not.toContainElement(screen.getByText(/\bprintings?\b/i, { selector: "p" }));
  // And it is the box that carries the one gold scrollbar in the app.
  expect([...(body as HTMLElement).classList]).toContain("scrollbar-accent");
});

/**
 * **The panel asks for a floor and lets the content decide the rest — issue "the card scrolls".**
 *
 * Measured live at 2560×1392 before the change: a fixed `h-[50rem]` sat the panel at y=296 with
 * ~590px of window unused, while the art column needed 666px against the 614px it had — 52px of
 * overflow, drawn as a scrollbar down the picture a reader opened the card to look at.
 *
 * **jsdom has no layout engine, so nothing here can go red for the geometry** — the same standing
 * carve-out `Dialog.test.tsx` works under. What is testable is the shape of the rule, and it has
 * three parts that only work together:
 *
 * * a `min-h` floor rather than a fixed `h`, so a tall window is usable at all;
 * * `min(…, 100%)` around every floor, because CSS resolves `min-height` **after** `max-height` —
 *   a bare floor beats `Dialog`'s `max-h-full` and puts the action row off the bottom of a short
 *   window, which is the failure `src/CLAUDE.md` makes a rule of;
 * * `flex-auto` on the two boxes the height is now driven by, since `flex-1` is `flex-basis: 0%`
 *   and contributes **nothing** to an auto-height column — with `flex-1` the panel sits at its
 *   floor at every window size and the whole change is inert.
 */
it("floors the panel's height instead of fixing it, and clamps every floor to the window", async () => {
  renderModal("c1");
  const panel = await screen.findByRole("dialog");
  const classes = [...panel.classList];

  // Full-bleed on a phone, and content-driven from the 640 rung up.
  expect(classes).toContain("h-full");
  expect(classes).toContain("min-[640px]:h-auto");
  // No rung fixes a height any more; all three are floors.
  expect(classes.filter((c) => /^min-\[\d+px\]:h-\[/.test(c))).toEqual([]);
  expect(classes).toContain("min-[640px]:min-h-[min(52.5rem,80vh,825px)]");
  expect(classes).toContain("min-[900px]:min-h-[min(47.5rem,80vh,825px)]");
  expect(classes).toContain("min-[1200px]:min-h-[min(50rem,80vh,825px)]");

  // **The ceiling, and the reason every floor above carries its two terms.** `min-height` beats
  // `max-height`, so a floor left at a bare `52.5rem` — 840px, 15px over the cap — would win and
  // the ceiling would be a suggestion. Asserted as "no floor names a rem alone" rather than by
  // listing the three again, so a fourth rung added later cannot quietly opt out.
  expect(classes).toContain("min-[640px]:max-h-[min(825px,80vh)]");
  expect(classes.filter((c) => /min-h-\[min\([\d.]+rem,100%\)\]/.test(c))).toEqual([]);
  // Never on the phone, where the panel is full-bleed and a ceiling would put the glass back.
  expect(classes).not.toContain("max-h-[min(825px,80vh)]");

  // The other half. Both boxes, because the panel's height is the sum of what they report — the
  // body wrapper and the column grid inside it, which are this panel's only two `min-h-0`
  // flexible children. Awaited on the card, since the grid is not drawn until there is one.
  await screen.findByRole("button", { name: /view all printings/i });
  expect(panel.querySelectorAll(".min-h-0.flex-auto").length).toBe(2);

  // **`flex-1` is still banned on the height chain and is now allowed off it.** A zero
  // flex-basis reports none of its content, so a box the panel's height is *measured through*
  // must be `flex-auto` — that is what these two are. The printings list's body is the opposite
  // case: it sits inside a column that already has a definite height and its whole job is to
  // take what is left and scroll, which is what `flex-1` means. So the rule is where the class
  // is, not whether it appears.
  for (const box of panel.querySelectorAll(".min-h-0.flex-1")) {
    expect(
      box.closest("section")?.querySelector("h3")?.textContent,
      "a `min-h-0 flex-1` box outside the printings list is on the panel's height chain",
    ).toBe("Printings");
  }
});

/**
 * **A different printing of a card is the same entry in the list it was opened from.**
 *
 * Picking one out of `AllPrintingsDialog` writes a `selectedCardId` the walk has never heard of —
 * the wall published the printing *it* drew — so a lookup by `cardId` alone answered `-1`, both
 * chevrons vanished, and the modal had lost its place in the list behind the scrim. Measured in
 * the shipped window on 2026-09-03: `indexOfSelected: -1`, zero chevrons rendered.
 *
 * The chevrons are asserted by *stepping* rather than by being present, because presence alone
 * would pass on a fix that found the wrong stop: an oracle-only match would land on the first
 * printing of the card on a wall searched with `collapse: false`, which is why the real one tries
 * the exact printing first.
 */
it("keeps its place in the list when another printing of the same card is opened", async () => {
  // The Beta printing of the same oracle card — a card id no stop carries.
  cardDetail.mockImplementation((id: string) =>
    Promise.resolve(
      id === "c1b" ? { ...detail, id: "c1b", setCode: "leb", setName: "Limited Edition Beta" } : detail,
    ),
  );
  useAppStore.setState({
    cardWalk: {
      label: "Search results",
      stops: [
        { cardId: "c0", oracleId: "o0", name: "Ancestral Recall", deck: null },
        { cardId: "c1", oracleId: "o1", name: "Lightning Bolt", deck: null },
        { cardId: "c2", oracleId: "o2", name: "Black Lotus", deck: null },
      ],
    },
  });
  renderModal("c1");
  await screen.findByRole("dialog");
  await screen.findByRole("button", { name: /next card in search results/i });

  // Exactly what `AllPrintingsDialog` writes on a pick — `setSelectedCardId`, which is also why
  // the `Printing ▾` picker beside it never showed this: `viewPrinting` keeps the deck context,
  // and a card opened out of a deck is found through `sameDeckSlot` instead.
  act(() => {
    useAppStore.getState().setSelectedCardId("c1b");
  });

  const next = await screen.findByRole("button", { name: /next card in search results/i });
  await userEvent.click(next);
  // Still stop 1 of 3, so the step lands on stop 2 rather than on nothing.
  expect(useAppStore.getState().selectedCardId).toBe("c2");
});

/** A card opened out of the deck row above, which is the only surface that draws the two
 *  pickers — `scope.deckControls`, resolved from `paneDeckContext`. */
async function renderFromDeck() {
  deckGet.mockResolvedValue(deckDetail());
  useAppStore.setState({ activeView: "decks" });
  useAppStore.getState().openCardFromDeck(deckRow);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <CardDetailModal />
    </QueryClientProvider>,
  );
  await screen.findByRole("dialog");
  // The panel is on screen while the card is still a fetch away, and the controls column is not
  // drawn until there is a card — so the dialog alone is not far enough to press anything.
  await screen.findByRole("button", { name: /view all printings/i });
}

it("offers every label the reader has, not only the ones this deck's list wears", async () => {
  // **The bug, stated as its cause.** The picker was built from `deck.labels`, which comes off
  // `deck_get` — and `ipc.ts` says outright at `deckLabelList` that it *cannot* answer a label
  // nothing is wearing. So the label a reader made and has not used in this deck yet was missing
  // from the one control they would use to apply it, which reads as "my labels are gone".
  deckLabelAll.mockResolvedValue([
    { id: 7, name: "Needs testing", color: "#d9b95c", cardCount: 4, deckCount: 1 },
    { id: 8, name: "Cut candidate", color: "#d3202a", cardCount: 0, deckCount: 0 },
  ]);
  await renderFromDeck();

  await userEvent.click(screen.getByRole("button", { name: "Label" }));

  // **The order is the assertion as much as the membership is.** Both commands answer
  // most-used-first, which `features/decks/CLAUDE.md` names as one of this app's two exemptions
  // from the alphabetical option-list rule — an order that *is* the information. In-use first,
  // then the rest, and no label in both halves.
  // `waitFor` rather than `findAllBy`: the popup opens with whatever has landed, and a query that
  // resolved on the first render would be asserting about a list that is still two reads short.
  await waitFor(() =>
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      "No label",
      "Needs testing",
      "Cut candidate",
      "Create new…",
    ]),
  );

  // And it writes: a label offered but not wired would be the silently inert control this file's
  // deck test already exists to catch.
  await userEvent.click(screen.getByRole("option", { name: "Cut candidate" }));
  await waitFor(() => expect(deckCardSetLabel).toHaveBeenCalledWith(1, "c1", 2, "live", null, 8));
});

it("asks for the app-wide label list only where the pickers are drawn", async () => {
  // A card opened off a wall has no deck behind it and nothing to do with a label, so it must
  // not pay for the read — `scope.deckControls` is the same fact the pickers are drawn on.
  renderModal("c1");
  await screen.findByRole("dialog");
  await waitFor(() => expect(cardPrintings).toHaveBeenCalled());

  expect(deckLabelAll).not.toHaveBeenCalled();
});

it("makes a category from the picker and files the card into it", async () => {
  await renderFromDeck();

  await userEvent.click(screen.getByRole("button", { name: /^category/i }));
  // The typed text is both the filter and the name — one field, two jobs, which is
  // `AddLabelDialog`'s grammar. Nothing in this deck matches it, and the create row is still
  // there: it is the last row of the list at every query rather than one that appears when a
  // search fails.
  await userEvent.type(screen.getByRole("combobox"), "Ramp");
  await userEvent.click(screen.getByRole("option", { name: /^create/i }));

  // …and it travels, so the reader is not asked for the same word twice.
  expect(await screen.findByLabelText("New category")).toHaveValue("Ramp");

  await userEvent.click(screen.getByRole("button", { name: /^Create/ }));
  await waitFor(() => expect(deckCategoryCreate).toHaveBeenCalledWith(1, "Ramp"));
  // deckId, cardId, from, to, toName, variant, finish — the new pile is the destination of the
  // very same move a pick would have made, which is the whole point of creating one from here.
  await waitFor(() =>
    expect(deckMoveCard).toHaveBeenCalledWith(1, "c1", 2, 42, null, "live", null),
  );
});

it("makes a label with a colour from the app's own palette, and puts it on the card", async () => {
  // `deck_labels.color` is NOT NULL and `deck_label_create` refuses a name with no colour rather
  // than inventing one — so the picker is not decoration, and the hex it writes comes from
  // `labelColors.ts` rather than from anything typed into this feature.
  await renderFromDeck();

  await userEvent.click(screen.getByRole("button", { name: "Label" }));
  await userEvent.type(screen.getByRole("combobox"), "Cut");
  await userEvent.click(screen.getByRole("option", { name: /^create/i }));

  expect(await screen.findByLabelText("New label")).toHaveValue("Cut");

  await userEvent.click(screen.getByRole("button", { name: "Choose label colour" }));
  const ember = LABEL_COLORS.find((c) => c.label === "Ember");
  await userEvent.click(await screen.findByRole("button", { name: "Ember" }));

  await userEvent.click(screen.getByRole("button", { name: /^Create/ }));
  await waitFor(() => expect(deckLabelCreate).toHaveBeenCalledWith(1, "Cut", ember?.hex));
  // The created label is then worn, which is the second half of one act — `mutateAsync` and an
  // explicit chain, because a `mutate`-scoped callback is dropped when its observer unmounts.
  await waitFor(() => expect(deckCardSetLabel).toHaveBeenCalledWith(1, "c1", 2, "live", null, 8));
});

/**
 * The two printings the list offers in the tests below — the open card's own and one other,
 * which is the smallest list on which a pick can mean anything.
 *
 * **Every field of `Printing` is spelled out, and that is not ceremony.** This was four keys per
 * row while the control was a combobox, which read only `id`, `setName`, `setCode` and
 * `collectorNumber`. `CardModalPrintings` draws the whole row, and the first thing it did with
 * the short fixture was throw out of `LangBadge`: `lang` was `undefined`, `undefined !== "en"`
 * is true, and `languageName` calls `.toLowerCase()` on it. That is a **fixture** fault rather
 * than a product one — `lang` is `String` in the crate (`card.rs`) and `string` in `ipc.ts`, so
 * no real row can be missing it — but a partial object behind a cast is exactly how a suite comes
 * to encode a state the app cannot be in, and the fix is the row, not a guard for an impossible
 * value.
 */
const printings = {
  items: [
    {
      id: "c1",
      setCode: "lea",
      setName: "Limited Edition Alpha",
      collectorNumber: "161",
      releasedAt: "1993-08-05",
      rarity: "rare",
      illustrationId: null,
      artist: "Christopher Rush",
      lang: "en",
      finishes: "nonfoil",
      finishPrices: { nonfoil: 620, foil: null, etched: null },
      promo: false,
      promoTypes: null,
      fullArt: false,
    },
    {
      id: "c2",
      setCode: "leb",
      setName: "Limited Edition Beta",
      collectorNumber: "161",
      releasedAt: "1993-10-04",
      rarity: "rare",
      illustrationId: null,
      artist: "Christopher Rush",
      lang: "en",
      finishes: "nonfoil",
      finishPrices: { nonfoil: 410, foil: null, etched: null },
      promo: false,
      promoTypes: null,
      fullArt: false,
    },
  ],
  total: 2,
};

/**
 * Press the Beta row in the printings list.
 *
 * **The control moved and its meaning did not**, which is the whole point of leaving these three
 * tests pointed at the same `pickPrinting`: the combobox in the controls column became a list in
 * the main content area on 2026-09-03, and a press on a row is still a *swap* behind a deck row
 * and a *browse* without one. If that ever stops being true these three go red, which is what
 * they are for.
 *
 * Two names rather than one, because the row says what the press will do: from a deck row it
 * names the pile it will rewrite, and from a wall it only offers to show the printing.
 */
async function pickBeta() {
  await userEvent.click(
    await screen.findByRole("button", {
      name: /^(Use this printing \(LEB 161\) in |Show LEB · 161)/,
    }),
  );
}

it("swaps the deck's printing when one is picked out of the printings list", async () => {
  // **The picker used to browse**, which left `paneDeckContext.cardId` on the printing the deck
  // still played while the panel drew another one — half of what a reader reports as the modal
  // going out of sync. It is the swap now, and it is `useDeck.swapPrinting`: the same command
  // `AllPrintingsDialog`'s tiles press, so the two doors into one act cannot come to disagree.
  cardPrintings.mockResolvedValue(printings);
  await renderFromDeck();

  await pickBeta();

  // deckId, from, to, categoryId, variant, finish — the row's whole address, with the finish
  // carried across rather than cleared: the reader is choosing a printing, not an object.
  await waitFor(() => expect(deckSwapPrinting).toHaveBeenCalledWith(1, "c1", "c2", 2, "live", null));
  // And the modal follows the row, which is the half a swap that only wrote would leave broken:
  // the re-anchor lives on the mutation (`useDeck`'s `reanchorPane`), so this is the same write
  // the printings wall gets for free.
  await waitFor(() =>
    expect(useAppStore.getState().paneDeckContext).toEqual({ ...deckRow, cardId: "c2" }),
  );
  expect(useAppStore.getState().selectedCardId).toBe("c2");
});

it("browses instead of swapping where there is no deck row to write to", async () => {
  // **Only where there is a deck row.** On the search, collection, wishlist and tags walls there
  // is nothing to rewrite, so the pick stays `viewPrinting` — which moves the open card and
  // deliberately leaves the (already empty) deck context alone.
  cardPrintings.mockResolvedValue(printings);
  renderModal("c1");
  await screen.findByRole("button", { name: /view all printings/i });

  await pickBeta();

  await waitFor(() => expect(useAppStore.getState().selectedCardId).toBe("c2"));
  expect(deckSwapPrinting).not.toHaveBeenCalled();
  expect(useAppStore.getState().paneDeckContext).toBeNull();
});

it("says a refused swap rather than swallowing it", async () => {
  // Every write this file makes reports in words; this one has to do it through a `mutate`-scoped
  // callback, because the mutation is `useDeck`'s single definition and a sentence written onto
  // it would appear on the editor's own surfaces too.
  cardPrintings.mockResolvedValue(printings);
  deckSwapPrinting.mockRejectedValue(new Error("deck is gone"));
  await renderFromDeck();

  await pickBeta();

  expect(await screen.findByRole("alert")).toHaveTextContent(/could not use that printing/i);
});

it("follows the card into the pile a category pick filed it in", async () => {
  // **The reported case.** The write landed and the context did not move, so the picker went on
  // reading the pile the card had left. Both halves are asserted, because a fix that moved only
  // the id would leave the modal's `4× in …` line naming the old pile — a category is a row the
  // reader named, so nothing downstream can translate the id back into a word.
  await renderFromDeck();

  await userEvent.click(screen.getByRole("button", { name: /^category/i }));
  await userEvent.click(await screen.findByRole("option", { name: "Lands" }));

  await waitFor(() => expect(deckMoveCard).toHaveBeenCalledWith(1, "c1", 2, 3, null, "live", null));
  await waitFor(() =>
    expect(useAppStore.getState().paneDeckContext).toEqual({
      ...deckRow,
      categoryId: 3,
      categoryName: "Lands",
    }),
  );
});
