import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, expect, it, vi } from "vitest";
import type { CardDetail } from "@/lib/ipc";
import type { MarketplaceId } from "@/lib/marketplace";

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
  expect(screen.getByRole("button", { name: /deck category/i })).toBeInTheDocument();
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
  expect(classes).toContain("min-[640px]:min-h-[min(52.5rem,100%)]");
  expect(classes).toContain("min-[900px]:min-h-[min(47.5rem,100%)]");
  expect(classes).toContain("min-[1200px]:min-h-[min(50rem,100%)]");

  // The other half. Both boxes, because the panel's height is the sum of what they report — the
  // body wrapper and the column grid inside it, which are this panel's only two `min-h-0`
  // flexible children. Awaited on the card, since the grid is not drawn until there is one.
  await screen.findByRole("button", { name: /view all printings/i });
  expect(panel.querySelectorAll(".min-h-0.flex-auto").length).toBe(2);
  expect(panel.querySelectorAll(".min-h-0.flex-1").length).toBe(0);
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

  await userEvent.click(screen.getByRole("button", { name: /deck category/i }));
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
