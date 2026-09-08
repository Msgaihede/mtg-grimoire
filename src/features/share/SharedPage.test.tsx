/**
 * Somebody else's binder, inside the app.
 *
 * **The whole reason this view exists rather than a browser tab** is the two figures on every
 * row: what the reader already owns and what they already want. The web viewer draws the same
 * snapshot and can draw neither, because it has no database behind it.
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

const shareOpen = vi.hoisted(() => vi.fn());
const collectionList = vi.hoisted(() => vi.fn());
const wishlistList = vi.hoisted(() => vi.fn());
// The want list's two, and they are the whole of what this directory adds to the read list in
// `readOnly.test.ts` — one read of the reader's own cabinet, one write into their own wishlist.
const wishlistFolderList = vi.hoisted(() => vi.fn());
const wishlistAdd = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: { shareOpen, collectionList, wishlistList, wishlistFolderList, wishlistAdd },
}));

import { TooltipProvider } from "@/components/tooltip/TooltipProvider";
import type { CollectionRow, WishRow } from "@/lib/ipc";
import type { ShareCard, ShareSnapshot } from "@/lib/shareSnapshot";
import { useAppStore } from "@/lib/store";
import { NOTHING, SharedPage } from "./SharedPage";

const LINK = "https://share.example/s/testshareid00000";
const OTHER = "https://share.example/s/secondbinder000";

const card = (over: Partial<ShareCard> = {}): ShareCard => ({
  id: "bolt",
  n: "Lightning Bolt",
  s: "lea",
  cn: "161",
  f: "nonfoil",
  q: 1,
  fo: null,
  ...over,
});

const snapshot = (over: Partial<ShareSnapshot> = {}): ShareSnapshot => ({
  v: 1,
  id: "testshareid00000",
  title: "Trade binder",
  owner: "Giradeli",
  updatedAt: 1757308800,
  marketplace: "tcgplayer",
  currency: "USD",
  fields: ["condition", "lang", "value"],
  folders: [],
  cards: [card()],
  ...over,
});

const owned = (cardId: string, quantity: number): CollectionRow =>
  ({ cardId, quantity }) as unknown as CollectionRow;
const wished = (cardId: string | null, name: string, quantity: number): WishRow =>
  ({ cardId, name, quantity }) as unknown as WishRow;

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <SharedPage />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

/** The tile for one card, addressed by the name in its own list item. */
const tile = (name: string) =>
  within(screen.getByRole("listitem", { name: new RegExp(`^${name}`) }));

beforeEach(() => {
  vi.clearAllMocks();
  collectionList.mockResolvedValue({ items: [], total: 0 });
  wishlistList.mockResolvedValue({ items: [], total: 0 });
  shareOpen.mockResolvedValue(snapshot());
  wishlistFolderList.mockResolvedValue([
    { id: 7, parentId: null, name: "Trade targets", sortOrder: 0 },
  ]);
  wishlistAdd.mockResolvedValue({ id: 1, quantity: 1, removed: false });
  useAppStore.setState({ openedShares: [LINK] });
});

describe("a shared collection, opened in the app", () => {
  it("names the owner in the header of a share it did not publish", async () => {
    mount();

    const heading = await screen.findByRole("heading", { level: 2 });
    // Both halves in one name, with a space between them: two `block` spans concatenate with no
    // separator at all, and `Giradeli’sTrade binder` is what a screen reader would then read.
    expect(heading).toHaveAccessibleName("Giradeli’s Trade binder");
    expect(await screen.findByText(/as of/)).toBeInTheDocument();
  });

  /**
   * ⚠️ **Asserted _during_ the sweep rather than past it, which is the only way to see it.**
   *
   * Every other cross-reference case here `waitFor`s until the figures land, and the window
   * before that is where the defect lived: `index` is `EMPTY_INDEX` until **both** sweeps
   * answer — up to a hundred round trips at the 50 000-card size `useOwnedIndex` is written
   * for — so a wall drawn against it says *You own 0 · You want 0* on every tile and the two
   * chips answer confidently backwards. `collectionList` is held open by hand to hold the app in
   * that state; nothing about the window is otherwise reachable from a test.
   */
  it("draws no figure, and narrows nothing, while the sweep is still running", async () => {
    let land!: (page: { items: CollectionRow[]; total: number }) => void;
    collectionList.mockReturnValue(
      new Promise<{ items: CollectionRow[]; total: number }>((resolve) => {
        land = resolve;
      }),
    );
    shareOpen.mockResolvedValue(
      snapshot({
        cards: [card({ id: "bolt", n: "Lightning Bolt" }), card({ id: "sol", n: "Sol Ring" })],
      }),
    );
    wishlistList.mockResolvedValue({ items: [wished("sol", "Sol Ring", 1)], total: 1 });
    mount();
    await screen.findByRole("listitem", { name: /^Lightning Bolt/ });

    // The binder draws; the reader's own figures do not, in any spelling.
    expect(screen.queryByText("You own 0")).not.toBeInTheDocument();
    expect(screen.queryByText(/^You want/)).not.toBeInTheDocument();
    expect(screen.getByText(/checking your collection and wishlist/i)).toBeInTheDocument();
    // …and the tile's accessible name does not carry the figures either, which is the half a
    // `queryByText` sweep would miss.
    expect(screen.getByRole("listitem", { name: /^Lightning Bolt/ })).toHaveAccessibleName(
      "Lightning Bolt",
    );

    // A chip pressed mid-sweep narrows nothing rather than emptying the binder against zeroes.
    await userEvent.click(screen.getByRole("button", { name: "On your wishlist" }));
    expect(screen.getAllByRole("listitem")).toHaveLength(2);

    land({ items: [owned("bolt", 2)], total: 1 });

    // And the moment the figures are real, the chip the reader pressed starts meaning something.
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(1));
    expect(screen.getByRole("listitem", { name: /^Sol Ring/ })).toBeInTheDocument();
    expect(screen.queryByText(/checking your collection and wishlist/i)).not.toBeInTheDocument();
  });

  it("cross-references every row against what the reader owns and wants", async () => {
    shareOpen.mockResolvedValue(
      snapshot({
        cards: [
          card({ id: "bolt", n: "Lightning Bolt", q: 4 }),
          card({ id: "sol", n: "Sol Ring", q: 1 }),
          card({ id: "tundra", n: "Tundra", q: 1 }),
        ],
      }),
    );
    collectionList.mockResolvedValue({
      items: [owned("bolt", 1), owned("bolt", 1), owned("sol", 3)],
      total: 3,
    });
    wishlistList.mockResolvedValue({
      // Pinned to a printing, and loose by name — both are ordinary shapes of a wishlist row.
      items: [wished("bolt", "Lightning Bolt", 3), wished(null, "tundra", 2)],
      total: 2,
    });
    mount();

    await waitFor(() => expect(tile("Lightning Bolt").getByText("You own 2")).toBeInTheDocument());
    expect(tile("Lightning Bolt").getByText("You want 3")).toBeInTheDocument();
    expect(tile("Sol Ring").getByText("You own 3")).toBeInTheDocument();
    // Owned but unwanted, and wanted but unowned: the two halves are independent.
    expect(tile("Sol Ring").getByText("You want 0")).toBeInTheDocument();
    expect(tile("Tundra").getByText("You own 0")).toBeInTheDocument();
    expect(tile("Tundra").getByText("You want 2")).toBeInTheDocument();
  });

  /**
   * The filter that makes a wall of somebody else's cards worth scrolling: what is in it that
   * the reader has been looking for.
   */
  it("narrows the wall to the cards the reader wants and does not own", async () => {
    shareOpen.mockResolvedValue(
      snapshot({
        cards: [card({ id: "bolt", n: "Lightning Bolt" }), card({ id: "sol", n: "Sol Ring" })],
      }),
    );
    collectionList.mockResolvedValue({ items: [owned("sol", 1)], total: 1 });
    wishlistList.mockResolvedValue({ items: [wished("sol", "Sol Ring", 1)], total: 1 });
    mount();

    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(2));
    await userEvent.click(screen.getByRole("button", { name: "You do not own it" }));

    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(screen.getByRole("listitem", { name: /^Lightning Bolt/ })).toBeInTheDocument();
  });

  /**
   * ⚠️ `fields` says which **question** the publisher answered, never that every card has an
   * answer. A viewer that reads `undefined` as a value renders it.
   */
  it("draws a missing condition or price as an em dash rather than a blank or a zero", async () => {
    shareOpen.mockResolvedValue(
      // Both columns advertised; the copy is ungraded and the marketplace quoted nothing.
      snapshot({ cards: [card({ c: undefined, p: undefined, l: "en" })] }),
    );
    mount();

    await screen.findByRole("listitem", { name: /^Lightning Bolt/ });
    // Two of them: the ungraded copy's condition, and the price the marketplace never quoted.
    // Never a blank — which reads as a layout fault — and never a zero, which would be this app
    // claiming a shop offered the card for nothing.
    expect(tile("Lightning Bolt").getAllByText(NOTHING)).toHaveLength(2);
  });

  it("narrows the wall to one drawer and counts what is in it", async () => {
    shareOpen.mockResolvedValue(
      snapshot({
        folders: [
          { uid: "binder", name: "Trade binder", parent: null },
          { uid: "duals", name: "Duals", parent: "binder" },
        ],
        cards: [
          card({ id: "bolt", n: "Lightning Bolt", fo: "binder" }),
          card({ id: "tundra", n: "Tundra", fo: "duals" }),
        ],
      }),
    );
    mount();

    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(2));
    await userEvent.selectOptions(screen.getByLabelText("Drawer"), "duals");

    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(screen.getByRole("listitem", { name: /^Tundra/ })).toBeInTheDocument();
  });

  /** A reader with nothing open is given the way in rather than an apology. */
  it("offers the paste box when no share has been opened", async () => {
    useAppStore.setState({ openedShares: [] });
    mount();

    expect(
      screen.getByRole("button", { name: "Open a shared collection" }),
    ).toBeInTheDocument();
    expect(shareOpen).not.toHaveBeenCalled();
  });

  /**
   * The crate's refusals are sentences, and they are drawn in the view's own chrome — a reader
   * who followed a link that has been withdrawn needs to be told which of their open binders is
   * gone, not handed a bare string.
   */
  it("draws a refused link as a sentence, with a way out", async () => {
    shareOpen.mockRejectedValue("That shared collection is no longer available.");
    mount();

    expect(
      await screen.findByText("That shared collection is no longer available."),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Close this collection" }));
    expect(useAppStore.getState().openedShares).toEqual([]);
  });

  /** Two links open at once is the ordinary case for a reader trading with two people. */
  it("switches between the binders that are open", async () => {
    shareOpen.mockImplementation((url: string) =>
      Promise.resolve(
        url === LINK ? snapshot() : snapshot({ owner: "Ashiok", title: "Spares", id: "second" }),
      ),
    );
    useAppStore.setState({ openedShares: [LINK, OTHER] });
    mount();

    expect(await screen.findByRole("heading", { level: 2 })).toHaveAccessibleName(
      "Giradeli’s Trade binder",
    );
    await userEvent.click(screen.getByRole("button", { name: "Ashiok’s Spares" }));

    await waitFor(() =>
      expect(screen.getByRole("heading", { level: 2 })).toHaveAccessibleName("Ashiok’s Spares"),
    );
    // The press is a re-open, so the binder the reader picked is the one at the head of the list.
    expect(useAppStore.getState().openedShares[0]).toBe(OTHER);
  });

  /**
   * The figures are unavailable rather than zero when the reader's own lists could not be read.
   * *You own 0* beside a card they own four of is what sends somebody into a trade with the
   * wrong list.
   */
  it("says the cross-reference is unavailable rather than reporting zeroes", async () => {
    collectionList.mockRejectedValue("the database is locked");
    mount();

    expect(await screen.findByText(/could not be read/i)).toBeInTheDocument();
    expect(screen.queryByText("You own 0")).not.toBeInTheDocument();
  });
});

/**
 * The want list — spec decision 8, and the one write this whole directory makes.
 *
 * The dialog's own decisions (the folder list, the already-wanted figures, the fold) are
 * `AddToWishlist.test.tsx`'s. What is tested here is the **wall's** half: when a card can be
 * picked at all, what a pick does, and what the reader is told afterwards.
 */
describe("building a want list out of somebody else's binder", () => {
  /** The wall's tick for one card, once the cross-reference has answered. */
  const tick = (name: string) => screen.getByRole("checkbox", { name: `Pick ${name}` });

  /**
   * ⚠️ **The tick is gated on the same answer the figure line is, and that is the point.**
   * Until both of `useOwnedIndex`'s sweeps land the index is `EMPTY_INDEX`, so every card reads
   * *wanted 0* — and a want list built against it would offer to add cards the reader already
   * wants, silently, with the dialog's own already-wanted line saying nothing was there. So a
   * card cannot be picked before the figures are real, for exactly the reason a card cannot draw
   * one.
   */
  it("offers no tick until the cross-reference has answered", async () => {
    let land!: (page: { items: CollectionRow[]; total: number }) => void;
    collectionList.mockReturnValue(
      new Promise<{ items: CollectionRow[]; total: number }>((resolve) => {
        land = resolve;
      }),
    );
    mount();
    await screen.findByRole("listitem", { name: /^Lightning Bolt/ });

    expect(screen.queryByRole("checkbox")).toBeNull();

    land({ items: [], total: 0 });

    await waitFor(() => expect(tick("Lightning Bolt")).toBeInTheDocument());
  });

  /** The other absence, for the other reason: a sweep that was refused never becomes ready. */
  it("offers no tick when the reader's own lists could not be read", async () => {
    wishlistList.mockRejectedValue("the database is locked");
    mount();

    expect(await screen.findByText(/could not be read/i)).toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("sends the picked rows to a wishlist folder and says where they went", async () => {
    const user = userEvent.setup();
    shareOpen.mockResolvedValue(
      snapshot({
        cards: [card({ id: "bolt", n: "Lightning Bolt" }), card({ id: "sol", n: "Sol Ring" })],
      }),
    );
    mount();

    await waitFor(() => expect(tick("Lightning Bolt")).toBeInTheDocument());
    await user.click(tick("Lightning Bolt"));
    await user.click(tick("Sol Ring"));

    // The bar names the count rather than the cards, because the wall behind it is already
    // showing which two are ticked.
    expect(screen.getByText("2 picked")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Add to wishlist" }));

    await screen.findByRole("option", { name: "Trade targets" });
    await user.selectOptions(screen.getByLabelText("Add them to"), "7");
    await user.click(screen.getByRole("button", { name: "Add 2 cards" }));

    await waitFor(() => expect(wishlistAdd).toHaveBeenCalledTimes(2));
    expect(wishlistAdd).toHaveBeenCalledWith({ cardId: "bolt", quantity: 1, folderId: 7 });
    // Said in the view rather than left in a dialog that has closed over it — the verb the
    // button used, in the past tense, naming the destination the reader chose.
    expect(await screen.findByText("Added 2 cards to Trade targets.")).toBeInTheDocument();
    // And the picks are put down, because they have been acted on: a bar still reading
    // *2 picked* over a wall whose cards are now on the wishlist invites the same press twice.
    expect(screen.queryByText("2 picked")).toBeNull();
    expect(tick("Lightning Bolt")).not.toBeChecked();
  });

  /**
   * A pick is about a *card*, not about the row it was made on — and it survives the wall being
   * narrowed under it, which is the shape a reader produces by ticking as they scroll and then
   * pressing a chip.
   */
  it("keeps a pick that the reader has since filtered off the wall", async () => {
    const user = userEvent.setup();
    shareOpen.mockResolvedValue(
      snapshot({
        cards: [card({ id: "bolt", n: "Lightning Bolt" }), card({ id: "sol", n: "Sol Ring" })],
      }),
    );
    collectionList.mockResolvedValue({ items: [owned("bolt", 1)], total: 1 });
    mount();

    await waitFor(() => expect(tick("Lightning Bolt")).toBeInTheDocument());
    await user.click(tick("Lightning Bolt"));
    // *You do not own it* drops the very card that was ticked.
    await user.click(screen.getByRole("button", { name: "You do not own it" }));

    expect(screen.queryByRole("listitem", { name: /^Lightning Bolt/ })).toBeNull();
    expect(screen.getByText("1 picked")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Add to wishlist" }));

    expect(
      await screen.findByRole("listitem", { name: "Lightning Bolt" }),
    ).toBeInTheDocument();
  });

  /**
   * ⚠️ **A pick is about a *position* in one snapshot, so it may not outlive the snapshot.**
   *
   * `rows` keys each row by its index in the snapshot's own array — the only unique key this
   * document has, since two rows of a binder can agree on printing, finish, folder and grade and
   * still be two rows. Switching binders does not unmount anything: `Switcher` holds an observer
   * on every open link at `staleTime: Infinity`, so the target is warm and `isPending` is false on
   * the same render. Without a key on `<Binder>` the ticks survived and resolved against the
   * *new* binder's rows, and *Add to wishlist* wrote two cards from a collection the reader had
   * never looked at — no error, no cue, into their own wishlist.
   */
  it("drops the picks when the reader switches to another binder", async () => {
    const user = userEvent.setup();
    shareOpen.mockImplementation((url: string) =>
      Promise.resolve(
        url === LINK
          ? snapshot({ cards: [card({ id: "bolt", n: "Lightning Bolt" })] })
          : snapshot({
              owner: "Ashiok",
              title: "Spares",
              id: "second",
              cards: [card({ id: "tundra", n: "Tundra" })],
            }),
      ),
    );
    useAppStore.setState({ openedShares: [LINK, OTHER] });
    mount();

    await waitFor(() => expect(tick("Lightning Bolt")).toBeInTheDocument());
    await user.click(tick("Lightning Bolt"));
    expect(screen.getByText("1 picked")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Ashiok’s Spares" }));

    // The other binder draws…
    await waitFor(() =>
      expect(screen.getByRole("heading", { level: 2 })).toHaveAccessibleName("Ashiok’s Spares"),
    );
    // …with nothing picked, and the row that *is* there is not ticked. A bar reading `1 picked`
    // here would be one card of somebody else's binder, addressed by position.
    expect(screen.queryByText(/picked/)).toBeNull();
    expect(tick("Tundra")).not.toBeChecked();
  });

  it("puts the picks down when the reader clears them", async () => {
    const user = userEvent.setup();
    mount();

    await waitFor(() => expect(tick("Lightning Bolt")).toBeInTheDocument());
    await user.click(tick("Lightning Bolt"));
    await user.click(screen.getByRole("button", { name: "Clear picks" }));

    expect(screen.queryByText(/picked/)).toBeNull();
    expect(wishlistAdd).not.toHaveBeenCalled();
  });
});
