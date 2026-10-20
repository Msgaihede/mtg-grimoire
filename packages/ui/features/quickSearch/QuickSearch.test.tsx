import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The reads the quick search makes, and only those — spread over the real `ipc` so the mirror
 * stays intact (`DecksWidget.test.tsx`'s note on why).
 */
const deckList = vi.hoisted(() => vi.fn());
const deckFolderList = vi.hoisted(() => vi.fn());
const collectionFolderList = vi.hoisted(() => vi.fn());
const wishlistFolderList = vi.hoisted(() => vi.fn());
const collectionList = vi.hoisted(() => vi.fn());
const wishlistList = vi.hoisted(() => vi.fn());
const searchCards = vi.hoisted(() => vi.fn());
const recentCards = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ipc")>();
  return {
    ...actual,
    ipc: {
      ...actual.ipc,
      deckList,
      deckFolderList,
      collectionFolderList,
      wishlistFolderList,
      collectionList,
      wishlistList,
      searchCards,
      recentCards,
    },
  };
});

import type {
  CardSummary,
  CollectionFolder,
  CollectionRow,
  DeckFolder,
  DeckRow,
  RecentCard,
  WishRow,
  WishlistFolder,
} from "@/lib/ipc";
import { EditionContext, LIGHT_EDITION } from "@/lib/edition";
import { useAppStore } from "@/lib/store";
import { QUICK_SEARCH_LABEL, QuickSearch } from "./QuickSearch";

// Fixtures name the fields the panel reads; the rest of each row is irrelevant to it.
const deck = (over: Partial<DeckRow> & { id: number; name: string }) =>
  ({ formatName: "Commander", archived: false, folderId: null, ...over }) as DeckRow;
const copy = (over: Partial<CollectionRow> & { name: string }) =>
  ({
    id: 1,
    cardId: `card-${over.name}`,
    folderId: null,
    setCode: "lea",
    collectorNumber: "161",
    lang: "en",
    quantity: 1,
    ...over,
  }) as CollectionRow;
const wish = (over: Partial<WishRow> & { name: string }) =>
  ({
    id: 1,
    cardId: null,
    folderId: null,
    setCode: null,
    collectorNumber: null,
    lang: null,
    quantity: 1,
    ...over,
  }) as WishRow;
const card = (over: Partial<CardSummary> & { id: string; name: string }) =>
  ({ setCode: "m10", ...over }) as CardSummary;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function mount(ui: ReactNode = <QuickSearch />) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

const field = () => screen.getByRole("combobox", { name: QUICK_SEARCH_LABEL });
const headings = () =>
  within(screen.getByRole("listbox"))
    .queryAllByRole("group")
    .map((g) => g.getAttribute("aria-labelledby"))
    .map((id) => document.getElementById(id ?? "")?.textContent);

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState());
  deckList.mockResolvedValue([
    deck({ id: 1, name: "Mono Red Burn" }),
    deck({ id: 2, name: "Atraxa" }),
  ]);
  deckFolderList.mockResolvedValue([
    { id: 7, parentId: null, name: "Burn shelf", sortOrder: 0 },
  ] satisfies DeckFolder[]);
  collectionFolderList.mockResolvedValue([
    { id: 4, parentId: null, name: "Trade binder", kind: "user", deckId: null },
  ] as CollectionFolder[]);
  wishlistFolderList.mockResolvedValue([
    { id: 9, parentId: null, name: "Burn wants", managedDeckId: 1, managedTokens: false },
  ] as WishlistFolder[]);
  const bolt = (text?: string) => text?.includes("bolt") === true;
  collectionList.mockImplementation(({ text }: { text?: string }) =>
    Promise.resolve(
      text === undefined
        ? { items: [copy({ name: "Sol Ring", setCode: "cmm", collectorNumber: "1" })], total: 1 }
        : bolt(text)
          ? { items: [copy({ name: "Lightning Bolt", folderId: 4, quantity: 2 })], total: 1 }
          : { items: [], total: 0 },
    ),
  );
  wishlistList.mockImplementation(({ text }: { text?: string }) =>
    Promise.resolve({ items: bolt(text) ? [wish({ name: "Lightning Bolt" })] : [], total: 0 }),
  );
  searchCards.mockImplementation(({ text }: { text?: string }) =>
    Promise.resolve({
      items: bolt(text) ? [card({ id: "b", name: "Lightning Bolt" })] : [],
      total: 1,
      totalIsCapped: false,
    }),
  );
  recentCards.mockResolvedValue([
    { cardId: "r", name: "Rhystic Study", setCode: "pcy", viewedAt: 1 },
  ] satisfies RecentCard[]);
});

describe("QuickSearch", () => {
  it("opens on the recent things, in the issue's group order, before anything is typed", async () => {
    mount();
    await userEvent.click(field());
    expect(await screen.findByRole("option", { name: /Rhystic Study/ })).toBeVisible();
    expect(screen.getByRole("option", { name: /Mono Red Burn/ })).toBeVisible();
    expect(screen.getByRole("option", { name: /Sol Ring/ })).toBeVisible();
    expect(headings()).toEqual(["Decks", "Collection", "All cards"]);
    expect(field()).toHaveAttribute("aria-expanded", "true");
    expect(collectionList).toHaveBeenCalledWith(
      expect.objectContaining({ sort: [{ key: "added", dir: "desc" }] }),
    );
  });

  it("reads nothing until the reader opens it", () => {
    mount();
    expect(deckList).not.toHaveBeenCalled();
    expect(collectionList).not.toHaveBeenCalled();
    expect(searchCards).not.toHaveBeenCalled();
  });

  it("groups what typing finds: decks, collection, wishlist, all cards, settings", async () => {
    mount();
    await userEvent.type(field(), "bolt");
    await screen.findByRole("option", { name: /Search all cards for “bolt”/ });
    expect(headings()).toEqual(["Collection", "Wishlist", "All cards"]);
    await userEvent.clear(field());
    await userEvent.type(field(), "burn");
    await waitFor(() => expect(headings()).toEqual(["Decks", "Wishlist", "All cards"]));
    expect(screen.getByRole("option", { name: /Burn shelf/ })).toBeVisible();
    expect(screen.getByRole("option", { name: /Burn wants/ })).toBeVisible();
  });

  it("never draws the corpus before the collection has answered the same text", async () => {
    const slow = deferred<{ items: CollectionRow[]; total: number }>();
    collectionList.mockImplementation(({ text }: { text?: string }) =>
      text ? slow.promise : Promise.resolve({ items: [], total: 0 }),
    );
    mount();
    await userEvent.type(field(), "bolt");
    await waitFor(() => expect(searchCards).toHaveBeenCalled());
    await waitFor(() => expect(headings()).toContain("Wishlist"));
    expect(headings()).not.toContain("All cards");
    await act(async () => slow.resolve({ items: [copy({ name: "Lightning Bolt" })], total: 1 }));
    await waitFor(() => expect(headings()).toEqual(["Collection", "Wishlist", "All cards"]));
  });

  it("opens the lit deck on Enter, walking the rows with the arrows", async () => {
    mount();
    await userEvent.type(field(), "a");
    await screen.findByRole("option", { name: /Atraxa/ });
    await waitFor(() =>
      expect(screen.getAllByRole("option")[0]).toHaveAttribute("aria-selected", "true"),
    );
    const first = screen.getAllByRole("option")[0];
    expect(first).toHaveTextContent("Atraxa");
    await userEvent.keyboard("{ArrowDown}{ArrowUp}{Enter}");
    expect(useAppStore.getState().activeView).toBe("decks");
    expect(useAppStore.getState().openDeckId).toBe(2);
    expect(field()).toHaveValue("");
    expect(field()).toHaveAttribute("aria-expanded", "false");
  });

  it("holds an Enter pressed straight after typing until the typed text has answered", async () => {
    // Issue #1166: the empty box's newest copy (Sol Ring) is still the first row when the reader
    // types and presses Enter inside the debounce — it must not be the card that opens.
    mount();
    await userEvent.click(field());
    await screen.findByRole("option", { name: /Sol Ring/ });
    await userEvent.type(field(), "bolt{Enter}");
    expect(useAppStore.getState().pendingReveal).toBeNull();
    await waitFor(() =>
      expect(useAppStore.getState().pendingReveal).toEqual({
        scope: "collection",
        folderId: 4,
        query: '!"Lightning Bolt" e:lea cn:161 lang:en',
      }),
    );
    expect(field()).toHaveValue("");
    expect(field()).toHaveAttribute("aria-expanded", "false");
  });

  it("reveals a collection card in the folder it is filed in", async () => {
    mount();
    await userEvent.type(field(), "bolt");
    const option = await screen.findByRole("option", { name: /Lightning Bolt.*Trade binder/ });
    await userEvent.click(option);
    const state = useAppStore.getState();
    expect(state.activeView).toBe("collection");
    expect(state.pendingReveal).toEqual({
      scope: "collection",
      folderId: 4,
      query: '!"Lightning Bolt" e:lea cn:161 lang:en',
    });
  });

  it("opens a folder, a deck folder, a search and a settings panel", async () => {
    mount();
    await userEvent.type(field(), "trade");
    await userEvent.click(await screen.findByRole("option", { name: /Trade binder/ }));
    expect(useAppStore.getState().pendingFolder).toEqual({ scope: "collection", id: 4 });

    await userEvent.type(field(), "burn shelf");
    await userEvent.click(await screen.findByRole("option", { name: /Burn shelf/ }));
    expect(useAppStore.getState().activeView).toBe("decks");
    expect(useAppStore.getState().pendingDeckFolder).toBe(7);

    await userEvent.type(field(), "bolt");
    await userEvent.click(await screen.findByRole("option", { name: /Lightning Bolt.*M10/ }));
    expect(useAppStore.getState().activeView).toBe("search");
    expect(useAppStore.getState().pendingSearchText).toBe('!"Lightning Bolt"');

    await userEvent.type(field(), "currency");
    await userEvent.click(await screen.findByRole("option", { name: /Prices/ }));
    expect(useAppStore.getState().activeView).toBe("settings");
    expect(useAppStore.getState().pendingSettingsPanel).toBe("prices");
  });

  it("offers only the settings panels the edition draws", async () => {
    mount(
      <EditionContext.Provider value={LIGHT_EDITION}>
        <QuickSearch />
      </EditionContext.Provider>,
    );
    await userEvent.type(field(), "startup");
    await screen.findByRole("option", { name: /Search all cards for “startup”/ });
    expect(screen.queryByRole("option", { name: /Start page/ })).toBeNull();
  });

  it("takes the caret on Ctrl+K and gives it back on Escape", async () => {
    mount(
      <>
        <button type="button">Elsewhere</button>
        <QuickSearch />
      </>,
    );
    const elsewhere = screen.getByRole("button", { name: "Elsewhere" });
    elsewhere.focus();
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(field()).toHaveFocus();
    expect(field()).toHaveAttribute("aria-expanded", "true");
    await userEvent.keyboard("x{Escape}");
    expect(elsewhere).toHaveFocus();
    expect(field()).toHaveValue("");
    expect(field()).toHaveAttribute("aria-expanded", "false");
  });

  it("leaves Ctrl+K to an open modal", () => {
    mount(
      <>
        <div aria-modal="true" role="dialog" />
        <QuickSearch />
      </>,
    );
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(field()).not.toHaveFocus();
  });
});
