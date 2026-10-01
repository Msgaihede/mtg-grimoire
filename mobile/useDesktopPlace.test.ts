import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { useAppStore } from "@/lib/store";
import { placeHref } from "./routes";
import { useDesktopPlace } from "./useDesktopPlace";

const PRISTINE = useAppStore.getState();

/** A printing's id, as the store holds one. What it *is* does not matter here — only that it
 *  travels. */
const CARD = "0000579f-7b35-4ed3-b44c-db2a538066fe";

/** `/search`, with and without a card open over it — spelled by `placeHref`, the one place the
 *  query string's spelling is decided. */
const SEARCH = placeHref({ view: "search", deckId: null, cardId: null });
const searchWith = (cardId: string) => placeHref({ view: "search", deckId: null, cardId });

/** What the address bar says. */
const url = () => window.location.pathname + window.location.search;

/** Let the task end. A press is one task, and the adapter forgets it has pushed in a microtask. */
const endOfTask = () =>
  act(async () => {
    await Promise.resolve();
  });

beforeEach(() => {
  useAppStore.setState(PRISTINE, true);
  window.history.replaceState(null, "", "/");
});

afterEach(() => vi.restoreAllMocks());

describe("useDesktopPlace", () => {
  it("lands the store on the URL's view before anything is drawn", () => {
    window.history.replaceState(null, "", "/collection");
    renderHook(() => useDesktopPlace());
    expect(useAppStore.getState().activeView).toBe("collection");
  });

  it("opens the URL's deck", () => {
    window.history.replaceState(null, "", "/decks/12");
    renderHook(() => useDesktopPlace());
    expect(useAppStore.getState().activeView).toBe("decks");
    expect(useAppStore.getState().openDeckId).toBe(12);
  });

  it("lands on the URL's view even when the stored start view is outside the edition", () => {
    // `mobile:tauri` shares the desktop's `user.db`, whose stored start view may be `home`.
    // The seed counts as a press, so the shell's launch hydration is dropped rather than
    // moving the reader onto a page the light rail has no row for.
    renderHook(() => useDesktopPlace());
    expect(useAppStore.getState().activeView).toBe("search");

    act(() => useAppStore.getState().hydrateStartView("home"));
    expect(useAppStore.getState().activeView).toBe("search");
  });

  it("writes a press on the rail back to the URL", () => {
    renderHook(() => useDesktopPlace());
    act(() => useAppStore.getState().setActiveView("wishlist"));
    expect(window.location.pathname).toBe("/wishlist");
  });

  it("writes an opened deck back to the URL", () => {
    window.history.replaceState(null, "", "/decks");
    renderHook(() => useDesktopPlace());
    act(() => useAppStore.getState().setOpenDeckId(7));
    expect(window.location.pathname).toBe("/decks/7");
  });

  it("follows Back", () => {
    renderHook(() => useDesktopPlace());
    act(() => useAppStore.getState().setActiveView("wishlist"));

    act(() => {
      window.history.replaceState(null, "", "/search");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(useAppStore.getState().activeView).toBe("search");
  });

  it("follows Back onto the gallery without writing history, even with a deck parked", async () => {
    // Entering Decks hands back the deck that was open when the reader left — the store's own
    // rule — so following the URL onto the gallery takes two writes, and the first one is a
    // place the URL never named. Written back, it would bury the entry just gone back to.
    window.history.replaceState(null, "", "/decks/7");
    renderHook(() => useDesktopPlace());
    act(() => useAppStore.getState().setActiveView("wishlist"));
    expect(useAppStore.getState().parkedDeckId).toBe(7);
    // A `popstate` is a task of its own in a browser, so the press that got here is over — and
    // with it the adapter's memory of having pushed. Left out, an unguarded follow would only
    // *replace*, and a test watching for pushes alone would pass over it.
    await endOfTask();

    // A jump of more than one entry — the browser's Back menu — onto the gallery's own. The
    // browser moves the URL before it says so; spied on after, so this is not counted.
    window.history.replaceState(null, "", "/decks");
    const pushState = vi.spyOn(window.history, "pushState");
    const replaceState = vi.spyOn(window.history, "replaceState");
    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    expect(useAppStore.getState().activeView).toBe("decks");
    expect(useAppStore.getState().openDeckId).toBeNull();
    expect(pushState).not.toHaveBeenCalled();
    expect(replaceState).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe("/decks");
  });

  /**
   * The follow with the most writes in it: a view, then a deck that is not the parked one, then
   * a card — three, and two places between them the URL never named. **Both ways round**, because
   * what an unguarded follow does with those places depends on whether the adapter still
   * remembers pushing: forgotten, the first is pushed; remembered, all three are replaced. Either
   * is a history write on a Back, and neither may happen.
   */
  it.each([
    { when: "in a task of its own", yielded: true },
    { when: "in the task of the press before it", yielded: false },
  ])("follows Back onto a deck and a card without writing history, $when", async ({ yielded }) => {
    window.history.replaceState(null, "", "/decks/7");
    renderHook(() => useDesktopPlace());
    act(() => useAppStore.getState().setActiveView("search"));
    expect(useAppStore.getState().parkedDeckId).toBe(7);
    expect(url()).toBe(SEARCH);
    if (yielded) await endOfTask();

    const there = placeHref({ view: "decks", deckId: 3, cardId: "y" });
    window.history.replaceState(null, "", there);
    const pushState = vi.spyOn(window.history, "pushState");
    const replaceState = vi.spyOn(window.history, "replaceState");
    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    expect(useAppStore.getState().activeView).toBe("decks");
    expect(useAppStore.getState().openDeckId).toBe(3);
    expect(useAppStore.getState().selectedCardId).toBe("y");
    expect(pushState).not.toHaveBeenCalled();
    expect(replaceState).not.toHaveBeenCalled();
    expect(url()).toBe(there);
  });

  it("stops listening when the face goes", () => {
    const { unmount } = renderHook(() => useDesktopPlace());
    unmount();
    act(() => useAppStore.getState().setActiveView("wishlist"));
    expect(window.location.pathname).toBe("/");
  });

  describe("one press, one entry", () => {
    it("pushes, and does not replace, on a press on the rail", () => {
      // Replacing would write the same URL and pass every assertion about the address bar —
      // while taking Back away, since the entry the reader left would be gone.
      renderHook(() => useDesktopPlace());
      const pushState = vi.spyOn(window.history, "pushState");
      const replaceState = vi.spyOn(window.history, "replaceState");

      act(() => useAppStore.getState().setActiveView("wishlist"));

      expect(pushState).toHaveBeenCalledTimes(1);
      expect(pushState).toHaveBeenCalledWith(null, "", "/wishlist");
      expect(replaceState).not.toHaveBeenCalled();
    });

    it("pushes one entry for a press that takes two writes to land", async () => {
      window.history.replaceState(null, "", "/decks/7");
      renderHook(() => useDesktopPlace());
      act(() => useAppStore.getState().setActiveView("wishlist"));
      expect(useAppStore.getState().parkedDeckId).toBe(7);
      expect(url()).toBe("/wishlist");
      await endOfTask();

      const entries = window.history.length;
      const pushState = vi.spyOn(window.history, "pushState");
      act(() => {
        // The wishlist's own "open this deck" press, as `WishlistPage` writes it: the first line
        // lands on the deck that was parked, which the reader never asked for.
        useAppStore.getState().setActiveView("decks");
        useAppStore.getState().setOpenDeckId(9);
      });

      expect(pushState).toHaveBeenCalledTimes(1);
      expect(window.history.length).toBe(entries + 1);
      expect(url()).toBe("/decks/9");
    });

    it("still pushes an entry for each of two presses", async () => {
      renderHook(() => useDesktopPlace());
      const pushState = vi.spyOn(window.history, "pushState");

      act(() => useAppStore.getState().setActiveView("wishlist"));
      await endOfTask();
      act(() => useAppStore.getState().setActiveView("collection"));

      expect(pushState).toHaveBeenCalledTimes(2);
      expect(url()).toBe("/collection");
    });
  });

  describe("the open card", () => {
    it("opens the URL's card over the URL's view", () => {
      window.history.replaceState(null, "", searchWith(CARD));
      renderHook(() => useDesktopPlace());
      expect(useAppStore.getState().activeView).toBe("search");
      expect(useAppStore.getState().selectedCardId).toBe(CARD);
    });

    it("writes an opened card onto the entry it was opened over, and pushes nothing", () => {
      window.history.replaceState(null, "", SEARCH);
      renderHook(() => useDesktopPlace());
      const pushState = vi.spyOn(window.history, "pushState");
      const replaceState = vi.spyOn(window.history, "replaceState");

      act(() => useAppStore.getState().setSelectedCardId("x"));

      expect(replaceState).toHaveBeenCalledTimes(1);
      expect(replaceState).toHaveBeenCalledWith(null, "", searchWith("x"));
      expect(pushState).not.toHaveBeenCalled();
      expect(url()).toBe(searchWith("x"));
    });

    it("writes a closed card back off that entry, and pushes nothing", () => {
      window.history.replaceState(null, "", searchWith("x"));
      renderHook(() => useDesktopPlace());
      expect(useAppStore.getState().selectedCardId).toBe("x");
      const pushState = vi.spyOn(window.history, "pushState");
      const replaceState = vi.spyOn(window.history, "replaceState");

      act(() => useAppStore.getState().setSelectedCardId(null));

      expect(replaceState).toHaveBeenCalledTimes(1);
      expect(replaceState).toHaveBeenCalledWith(null, "", SEARCH);
      expect(pushState).not.toHaveBeenCalled();
      expect(url()).toBe(SEARCH);
    });

    it("lets the store finish telling everyone when the browser refuses a write", () => {
      // Browsers ration the History API, and stepping through cards with a held arrow key is a
      // write per step. A refusal thrown out of this adapter would come out of the store's own
      // `set` — and cut off every subscriber registered after it.
      window.history.replaceState(null, "", SEARCH);
      renderHook(() => useDesktopPlace());
      const heard = vi.fn();
      onTestFinished(useAppStore.subscribe(heard));
      const replaceState = vi.spyOn(window.history, "replaceState").mockImplementation(() => {
        throw new DOMException("Too many calls to the History API", "SecurityError");
      });

      expect(() => act(() => useAppStore.getState().setSelectedCardId("x"))).not.toThrow();

      expect(replaceState).toHaveBeenCalledTimes(1);
      expect(heard).toHaveBeenCalledTimes(1);
      expect(useAppStore.getState().selectedCardId).toBe("x");
      // One step stale, which is the whole cost...
      expect(url()).toBe(SEARCH);

      // ...and the next write the browser accepts puts it right.
      replaceState.mockRestore();
      act(() => useAppStore.getState().setSelectedCardId("z"));
      expect(url()).toBe(searchWith("z"));
    });

    it("follows Back onto an entry with a card open, writing nothing", () => {
      window.history.replaceState(null, "", SEARCH);
      renderHook(() => useDesktopPlace());
      expect(useAppStore.getState().selectedCardId).toBeNull();

      // The browser moves the URL before it says so. Spied on after, so this is not counted.
      window.history.replaceState(null, "", searchWith(CARD));
      const pushState = vi.spyOn(window.history, "pushState");
      const replaceState = vi.spyOn(window.history, "replaceState");
      act(() => {
        window.dispatchEvent(new PopStateEvent("popstate"));
      });

      expect(useAppStore.getState().selectedCardId).toBe(CARD);
      expect(pushState).not.toHaveBeenCalled();
      expect(replaceState).not.toHaveBeenCalled();
      expect(url()).toBe(searchWith(CARD));
    });

    it("follows Back onto an entry with no card, closing the one that was open", () => {
      window.history.replaceState(null, "", searchWith(CARD));
      renderHook(() => useDesktopPlace());
      expect(useAppStore.getState().selectedCardId).toBe(CARD);

      window.history.replaceState(null, "", SEARCH);
      const pushState = vi.spyOn(window.history, "pushState");
      const replaceState = vi.spyOn(window.history, "replaceState");
      act(() => {
        window.dispatchEvent(new PopStateEvent("popstate"));
      });

      expect(useAppStore.getState().selectedCardId).toBeNull();
      expect(pushState).not.toHaveBeenCalled();
      expect(replaceState).not.toHaveBeenCalled();
      expect(url()).toBe(SEARCH);
    });
  });
});
