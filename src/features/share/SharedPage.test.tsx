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
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: { shareOpen, collectionList, wishlistList },
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
