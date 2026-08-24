import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/tooltip/TooltipProvider";
import type { CollectionFolder, CollectionRow, DeckCategory } from "@/lib/ipc";

const collectionList = vi.hoisted(() => vi.fn());
const collectionToDeck = vi.hoisted(() => vi.fn());
const collectionFolderList = vi.hoisted(() => vi.fn());
// `useMarketplace` is the real hook — the marketplace is in the payload and in the key — so its
// two queries need answers or they sit rejected for the life of the file.
const getMarketplace = vi.hoisted(() => vi.fn());
const marketplaceFeedStatus = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: {
    collectionList,
    collectionToDeck,
    collectionFolderList,
    getMarketplace,
    marketplaceFeedStatus,
  },
}));

import { AUTO_CATEGORY } from "./autoCategory";
import { CollectionSearchTab } from "./CollectionSearchTab";

const DECK_ID = 4;

function category(over: Partial<DeckCategory> = {}): DeckCategory {
  return {
    id: 1,
    deckId: DECK_ID,
    name: "Main deck",
    kind: "main",
    origin: "user",
    isActive: true,
    sortOrder: 0,
    cardCount: 0,
    totalPrice: null,
    cardCountAllVariants: 0,
    ...over,
  };
}

const MAIN = category();
const SIDE = category({ id: 2, name: "Sideboard", kind: "side", sortOrder: 1 });
/** The pile `autoCategoryFor` names for an Instant with no oracle tags — the type-line floor. */
const INSTANTS = category({ id: 3, name: "Instant", kind: "main", sortOrder: 2 });

const THIS_GROUP: CollectionFolder = {
  id: 10,
  parentId: null,
  name: "Kenrith",
  kind: "deck",
  deckId: DECK_ID,
  sortOrder: 0,
};
const OTHER_GROUP: CollectionFolder = {
  id: 11,
  parentId: null,
  name: "Mono-Red Aggro",
  kind: "deck",
  deckId: 9,
  sortOrder: 0,
};
const BINDER: CollectionFolder = {
  id: 12,
  parentId: null,
  name: "Trade binder",
  kind: "user",
  deckId: null,
  sortOrder: 0,
};

function row(over: Partial<CollectionRow> = {}): CollectionRow {
  return {
    id: 1,
    cardId: "bolt",
    folderId: null,
    folderName: null,
    name: "Lightning Bolt",
    oracleId: "o-bolt",
    setCode: "lea",
    setName: "Limited Edition Alpha",
    collectorNumber: "161",
    lang: "en",
    rarity: "common",
    manaCost: "{R}",
    typeLine: "Instant",
    layout: "normal",
    finish: "nonfoil",
    condition: "NM",
    quantity: 3,
    tradelistQuantity: 0,
    unitPrice: 400.5,
    purchasePrice: null,
    purchaseCurrency: null,
    acquiredAt: null,
    acquisitionSource: null,
    serialNumber: null,
    altered: false,
    signed: false,
    proxy: false,
    misprint: false,
    grading: null,
    tags: "[]",
    notes: null,
    needsReview: null,
    updatedAt: 0,
    promoTypes: null,
    legalities: null,
    ...over,
  };
}

/** On the reader's desk, filed nowhere. */
const LOOSE = row();
/** The same printing in the reader's own drawer — still on the desk, so still a silent add. */
const FILED = row({ id: 2, folderId: BINDER.id, folderName: BINDER.name, quantity: 1 });
/** **The row the confirm exists for**: the copies are in another deck's group. */
const SPOKEN_FOR = row({
  id: 3,
  folderId: OTHER_GROUP.id,
  folderName: OTHER_GROUP.name,
  finish: "foil",
  quantity: 1,
});
/** Already in the deck this panel is docked beside — `collection_to_deck` refuses it in words. */
const ALREADY_HERE = row({ id: 4, folderId: THIS_GROUP.id, folderName: THIS_GROUP.name });
/**
 * A loose copy **recorded after** {@link SPOKEN_FOR}, so that only the desk-before-deck key can
 * pick it.
 *
 * The whole point of the id: `pickCopy` ranks on `(desk, proxy, entry id)`, and every other
 * fixture here has the desk copy at the lowest id — so a test built out of those would go on
 * passing with the desk key deleted, picked by the tie-break instead. Proved by deleting it:
 * `collectionTiles.test.ts` went red and this file did not.
 */
const LOOSE_LATER = row({ id: 9, quantity: 1 });

/**
 * jsdom lays nothing out, so the virtualiser measures a scroll container of zero height and
 * renders an empty window — one number is the whole of what it is missing. `scrollTo` is the
 * other thing it reaches for that jsdom does not implement.
 *
 * **New to this file on 2026-08-24**, because the tab became a `CardGrid` rather than a plain
 * `<ul>`: a list needed no layout to draw its rows. `DeckSearchPanel.test.tsx` has carried the
 * same block for its own wall since it had one, word for word.
 *
 * Put back afterwards: these are patches to a *global* prototype, and a file that leaves one
 * behind is a file that decides how the next one measures the DOM.
 */
const patched: [string, PropertyDescriptor | undefined][] = [];

beforeAll(() => {
  for (const [name, descriptor] of [
    ["offsetHeight", { value: 600 }],
    ["scrollTo", { value: vi.fn() }],
  ] as const) {
    patched.push([name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)]);
    Object.defineProperty(HTMLElement.prototype, name, { configurable: true, ...descriptor });
  }
});

afterAll(() => {
  for (const [name, original] of patched.reverse()) {
    if (original) Object.defineProperty(HTMLElement.prototype, name, original);
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
  }
});

beforeEach(() => {
  collectionList.mockReset().mockResolvedValue({ items: [LOOSE], total: 1 });
  collectionToDeck
    .mockReset()
    // `deckCardId` is the `deck_cards` row the move landed on, which `collection_to_deck`
    // always answers — a mock that omitted it would encode a backend answer that cannot
    // happen.
    .mockResolvedValue({ entryId: 9, fromDeck: null, deckCardId: 41, quantity: 1 });
  collectionFolderList.mockReset().mockResolvedValue([THIS_GROUP, OTHER_GROUP, BINDER]);
  getMarketplace.mockReset().mockResolvedValue("tcgplayer");
  marketplaceFeedStatus.mockReset().mockResolvedValue([]);
});

function tab({
  categories = [MAIN, SIDE, INSTANTS] as DeckCategory[],
  deckId = DECK_ID,
  targetCategoryId = MAIN.id,
} = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <CollectionSearchTab
          categories={categories}
          deckId={deckId}
          targetCategoryId={targetCategoryId}
          defaultFormat={null}
        />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

/** What the last `collection_list` was asked with. */
const lastQuery = () => collectionList.mock.calls[collectionList.mock.calls.length - 1][0];

describe("CollectionSearchTab", () => {
  /**
   * **One tile per printing, whatever the copies behind it are** — the fold this wall replaced a
   * list of text rows with.
   *
   * Three rows of one card here: loose on the desk, in a drawer, and a foil in another deck's
   * group. A list drew three lines; the wall draws one piece of art with `×5` over it, because
   * three drawings of one illustration read as a rendering fault rather than as three choices.
   * Which of the three a press moves is {@link pickCopy}'s answer and is asserted below.
   */
  it("folds every copy of a printing into one tile", async () => {
    collectionList.mockResolvedValue({ items: [LOOSE, FILED, SPOKEN_FOR], total: 3 });
    tab();

    // One Add button is one tile: `CardGrid` draws exactly one `action` per row it is handed.
    const adds = await screen.findAllByRole("button", { name: /^Add Lightning Bolt/ });
    expect(adds).toHaveLength(1);
    // The copies of all three rows, summed — 3 loose + 1 filed + 1 foil.
    expect(await screen.findByText("5 in your collection")).toBeInTheDocument();
  });

  /**
   * **The safety property, kept across the fold — and the reason the fold is allowed at all.**
   *
   * The tile has a copy in Mono-Red Aggro behind it. Adding it must not ask about that deck and
   * must not take its card, because the reader has a copy of their own sitting loose: a
   * confirmation raised where none was needed teaches readers to dismiss confirmations.
   * `pickCopy` ranks the desk before a deck, so the write names {@link LOOSE_LATER}.
   *
   * **{@link LOOSE_LATER} rather than {@link LOOSE}, and the id is the whole reason** — see that
   * fixture. With the loose copy at the lowest id this test passes with the desk-before-deck key
   * deleted, on the tie-break.
   */
  it("takes a free copy rather than one another deck is holding", async () => {
    collectionList.mockResolvedValue({ items: [SPOKEN_FOR, LOOSE_LATER], total: 2 });
    tab();

    await userEvent.click(await screen.findByRole("button", { name: /^Add Lightning Bolt/ }));

    await waitFor(() =>
      expect(collectionToDeck).toHaveBeenCalledWith(LOOSE_LATER.id, DECK_ID, { id: MAIN.id }, 1),
    );
    expect(screen.queryByRole("group", { name: /^Move / })).not.toBeInTheDocument();
  });

  /**
   * **Where the copy is filed reaches the button's name**, which is where the list's own "filed
   * in" line went. The root says nothing — most copies are there and four words on every control
   * to say "nowhere in particular" is noise — so this asserts the two places that are worth a
   * word: a drawer the reader made, and a deck that is about to lose a card.
   */
  it("names the drawer a copy is coming out of", async () => {
    collectionList.mockResolvedValue({ items: [FILED], total: 1 });
    tab();

    expect(
      await screen.findByRole("button", { name: /Add Lightning Bolt .* — in Trade binder$/ }),
    ).toBeInTheDocument();
  });

  /** And the root is silent, which is the other half of the same rule. */
  it("says nothing about a copy filed at the root", async () => {
    tab();

    expect(
      await screen.findByRole("button", { name: "Add Lightning Bolt (LEA 161, Nonfoil, Near mint) to Main deck" }),
    ).toBeInTheDocument();
  });

  /**
   * The toggle, in both directions, asserted on the **payload** — the state and the control's
   * `aria-pressed` can both be right while the field never reaches the wire, and nothing in this
   * app has ever sent it.
   */
  it("opens on the free copies and shows every copy on a press", async () => {
    tab();
    await waitFor(() => expect(collectionList).toHaveBeenCalled());
    expect(lastQuery().allocation).toBe("unallocated");
    const toggle = screen.getByRole("button", { name: /^Not in a deck/ });
    expect(toggle).toHaveAttribute("aria-pressed", "true");

    await userEvent.click(toggle);

    await waitFor(() => expect(lastQuery().allocation).toBe("all"));
    expect(screen.getByRole("button", { name: /^Not in a deck/ })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  /**
   * A copy on the desk moves on one press — no question, because nothing the reader is not
   * looking at changes. The deck comes off the categories' own `deckId`, which is the only place
   * this panel is told which deck it is docked beside.
   */
  it("adds a copy from the desk with no confirmation", async () => {
    tab();

    await userEvent.click(await screen.findByRole("button", { name: /^Add Lightning Bolt/ }));

    await waitFor(() =>
      expect(collectionToDeck).toHaveBeenCalledWith(LOOSE.id, DECK_ID, { id: MAIN.id }, 1),
    );
    // The confirmation is a `role="group"` box (`useConfirmFocus`) and never a `dialog`, so this
    // is what "no question was asked" looks like. Queried by the role rather than by a sentence:
    // a text query for words the question does not use passes whatever the component does.
    expect(screen.queryByRole("group", { name: /^Move / })).not.toBeInTheDocument();
  });

  /**
   * **The one thing this PR must not get wrong.** With every copy shown, a row in another deck's
   * group is on screen — and adding it takes the card out of *that* deck's list as well as its
   * group. The side effect lands where the reader is not looking, so it is asked first and the
   * question names the deck.
   *
   * Nothing is written until they answer: the assertion is the absence of the call, not the
   * presence of the question.
   *
   * This app's confirmations carry **no** `dialog` or `alertdialog` role, so the question is found
   * by its text.
   */
  it("asks before taking a copy out of another deck, and names that deck", async () => {
    collectionList.mockResolvedValue({ items: [SPOKEN_FOR], total: 1 });
    tab();

    await userEvent.click(await screen.findByRole("button", { name: /^Add Lightning Bolt/ }));

    // Found by its **text**, and scoped to the question: this app's confirmations carry no
    // `dialog` or `alertdialog` role, and the row behind it names the same deck in its own
    // "where this copy is filed" line — so an unscoped text query would match both and prove
    // nothing about the question.
    const question = await screen.findByRole("group", { name: /Move Lightning Bolt/ });
    expect(within(question).getByText(/Mono-Red Aggro/)).toBeInTheDocument();
    expect(collectionToDeck).not.toHaveBeenCalled();
  });

  /** Answering yes is what writes, and the write is the same one the desk path makes. */
  it("writes once the reader confirms", async () => {
    collectionList.mockResolvedValue({ items: [SPOKEN_FOR], total: 1 });
    tab();
    await userEvent.click(await screen.findByRole("button", { name: /^Add Lightning Bolt/ }));

    await userEvent.click(screen.getByRole("button", { name: "Move it here" }));

    await waitFor(() =>
      expect(collectionToDeck).toHaveBeenCalledWith(SPOKEN_FOR.id, DECK_ID, { id: MAIN.id }, 1),
    );
  });

  /** And answering no writes nothing and puts the question away. */
  it("writes nothing when the reader declines", async () => {
    collectionList.mockResolvedValue({ items: [SPOKEN_FOR], total: 1 });
    tab();
    await userEvent.click(await screen.findByRole("button", { name: /^Add Lightning Bolt/ }));

    await userEvent.click(screen.getByRole("button", { name: "Leave it there" }));

    expect(collectionToDeck).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Move it here" })).not.toBeInTheDocument();
  });

  /**
   * **`MoveOutcome.fromDeck` carries the name after the fact as well as before it**, so the
   * confirmation and the result say the same thing. The deck it came out of is the one thing
   * about this press the reader cannot see for themselves — they are looking at this deck.
   */
  it("says which deck the copies came out of", async () => {
    collectionList.mockResolvedValue({ items: [SPOKEN_FOR], total: 1 });
    collectionToDeck.mockResolvedValue({
      entryId: 9,
      fromDeck: "Mono-Red Aggro",
      deckCardId: 41,
      quantity: 1,
    });
    tab();
    await userEvent.click(await screen.findByRole("button", { name: /^Add Lightning Bolt/ }));
    await userEvent.click(screen.getByRole("button", { name: "Move it here" }));

    expect(await screen.findByText(/Took 1 copy from Mono-Red Aggro/)).toBeInTheDocument();
  });

  /**
   * A copy this deck already holds cannot move — `collection_alloc::ALREADY_HERE` refuses it —
   * so the button says so instead of pressing and finding out. **`aria-disabled` rather than
   * `disabled`**, so the row keeps its tab stop and the reason is reachable from the keyboard,
   * and the reason is in the accessible **name** because a greyed control whose name is unchanged
   * reads as a control that broke.
   */
  it("refuses a copy the deck already holds, in words", async () => {
    collectionList.mockResolvedValue({ items: [ALREADY_HERE], total: 1 });
    tab();

    const button = await screen.findByRole("button", { name: /already in this deck/ });
    expect(button).toHaveAttribute("aria-disabled", "true");

    await userEvent.click(button);

    expect(collectionToDeck).not.toHaveBeenCalled();
  });

  /**
   * **Under `Auto` the pile is per card, and the button names it before the press** — the same
   * promise `OpenPanel`'s Add button makes, kept by the same rule (`autoCategoryFor`) over the
   * one fact a collection row carries: its type line. An Instant with no oracle tags files by
   * type, which is the documented floor rather than an error.
   */
  it("files an Auto add by what the card is, and names the pile", async () => {
    tab({ targetCategoryId: AUTO_CATEGORY });

    const button = await screen.findByRole("button", { name: /to Instant$/ });
    await userEvent.click(button);

    await waitFor(() =>
      expect(collectionToDeck).toHaveBeenCalledWith(LOOSE.id, DECK_ID, { id: INSTANTS.id }, 1),
    );
  });

  /**
   * **A pile the rule names that this deck has not got is a pile `collection_to_deck` cannot
   * make**, because that command takes a category **id** where `deck_add_card` takes a name and
   * finds-or-creates. So the fallback is the deck's own main pile, and — the half that matters —
   * the button says which pile that is, so the reader is never told one thing and given another.
   */
  it("falls back to the deck's main pile when the rule names one it has not got", async () => {
    tab({ categories: [MAIN, SIDE], targetCategoryId: AUTO_CATEGORY });

    await userEvent.click(await screen.findByRole("button", { name: /to Main deck$/ }));

    await waitFor(() =>
      expect(collectionToDeck).toHaveBeenCalledWith(LOOSE.id, DECK_ID, { id: MAIN.id }, 1),
    );
  });

  /**
   * **An id the deck's `categories` does not carry reads as `AUTO_CATEGORY`** — this folder's
   * `CLAUDE.md`, and a *read* rather than a repairing write: `deck_category_delete` puts the deck
   * row back to `0` itself, so what is left is the one commit where the row and the list disagree.
   *
   * The button is what proves it went through the rule rather than to the first pile: the deck has
   * an `Instant` pile and the card is an Instant, so a naive `categories[0]` fallback would land in
   * **Main deck** and say so.
   */
  it("reads a stale default category as Auto", async () => {
    tab({ targetCategoryId: 404 });

    await userEvent.click(await screen.findByRole("button", { name: /to Instant$/ }));

    await waitFor(() =>
      expect(collectionToDeck).toHaveBeenCalledWith(LOOSE.id, DECK_ID, { id: INSTANTS.id }, 1),
    );
  });

  /** A refused write is said where the press was made, rather than leaving a row that did not
   *  move and no reason why. */
  it("reports a refused move", async () => {
    collectionToDeck.mockRejectedValue(new Error("That row is gone"));
    tab();

    await userEvent.click(await screen.findByRole("button", { name: /^Add Lightning Bolt/ }));

    expect(await screen.findByRole("alert")).toHaveTextContent("That row is gone");
  });

  /**
   * **The deck is a prop, not something read off the piles.**
   *
   * This component inferred it from `categories[0].deckId` for a day, which is true of every deck
   * the editor can open — `deck_create` seeds four piles in the deck's own transaction — and is
   * still an inference from a list that is a *different* fact. Here the piles say another deck,
   * which nothing in the app can produce and is exactly what separates the two answers: the write
   * has to go to the deck this tab was told it is docked beside.
   */
  it("moves the copy into the deck it was given, not the one its piles name", async () => {
    tab({ categories: [category({ deckId: 99 }), SIDE, INSTANTS], deckId: DECK_ID });

    await userEvent.click(await screen.findByRole("button", { name: /^Add Lightning Bolt/ }));

    await waitFor(() =>
      expect(collectionToDeck).toHaveBeenCalledWith(LOOSE.id, DECK_ID, { id: MAIN.id }, 1),
    );
  });

  /**
   * **A row that does not carry the facts a printing is named by is drawn, not fatal.**
   *
   * The four the label is built from — set, collector number, finish, condition — are the
   * *entry's* own columns, denormalised at write time precisely so that a copy whose printing has
   * left `cards` still says which piece of cardboard it is. So this is the orphan case taken one
   * step further than the database can go: it is what a caller with a partial row does, and until
   * 2026-08-23 it took the whole editor down with it, because `row.setCode.toUpperCase()` threw
   * during render and this is the tab the panel opens on.
   *
   * The collection page draws an orphan rather than crashing on one (`CollectionTable`'s `—`),
   * and this list now agrees: what is missing is left out, and what is there is still said.
   */
  it("draws a copy that is missing the facts a printing carries", async () => {
    // Everything `collection_list` joins from `cards` is gone, and so are the entry's own
    // columns — the shape a stub or a future DTO change produces. **Its own `cardId`**, because
    // the wall folds on that field: sharing one with the row below would make these two copies of
    // a printing rather than the two independent tiles this is about.
    const bare = { id: 7, cardId: "ghost", folderId: null } as unknown as CollectionRow;
    // And one that carries half of them, which is what says the facts are assembled rather than
    // dropped together: the printing is still named, the finish and the grade simply are not.
    const half = {
      ...row({ id: 8 }),
      finish: undefined,
      condition: undefined,
    } as unknown as CollectionRow;
    collectionList.mockResolvedValue({ items: [bare, half], total: 2 });

    tab();

    // Both tiles are there, named the way an unnamed card is named, and each press still says
    // where it would land — nothing about a copy is invented to fill the gaps, and the
    // parenthesis is dropped whole rather than drawn empty.
    //
    // The tile's **own** button, which `CardGrid` names after the card and nothing else: on a wall
    // the name is an accessible name rather than a line of text, so `getByText` would be asking
    // the list this replaced a question the wall does not answer.
    expect(await screen.findByRole("button", { name: "Unknown card" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Add Unknown card to Main deck" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Add Lightning Bolt (LEA 161) to Main deck" }),
    ).toBeInTheDocument();
  });

  /** An empty binder says so rather than drawing nothing — a blank column reads as a control
   *  that is still loading. */
  it("says when nothing matches", async () => {
    collectionList.mockResolvedValue({ items: [], total: 0 });
    tab();

    // The region is mounted from the first paint — that is the point of it — so it is found
    // immediately and carries "Reading your collection…". The wait is for the *answer*.
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/No copies/));
  });
});
