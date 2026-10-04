import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { useAppStore } from "@/lib/store";
import { OVERLAID, PUSHED, placeHref } from "./routes";
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

  /**
   * A refused push is not a refused replace: the entry was never made, so the browser is still on
   * the place the reader left. Swallowed and forgotten, the next write — a card opened over the
   * new page — renamed *that* entry, and the page they had left was gone from Back's path.
   */
  describe("a push the browser refuses", () => {
    /** Refuse the next `pushState`, the way `how` says: one browser throws, another drops it. */
    function refusePush(how: "throws" | "drops") {
      return vi.spyOn(window.history, "pushState").mockImplementationOnce(() => {
        if (how === "throws") {
          throw new DOMException("Too many calls to the History API", "SecurityError");
        }
      });
    }

    it.each(["throws", "drops"] as const)(
      "makes the entry late, on the next write, when the push %s",
      async (how) => {
        window.history.replaceState(null, "", SEARCH);
        renderHook(() => useDesktopPlace());
        const heard = vi.fn();
        onTestFinished(useAppStore.subscribe(heard));
        const pushState = refusePush(how);
        const replaceState = vi.spyOn(window.history, "replaceState");

        expect(() => act(() => useAppStore.getState().setActiveView("wishlist"))).not.toThrow();
        // The store moved and everyone heard; the address is one step stale.
        expect(heard).toHaveBeenCalled();
        expect(useAppStore.getState().activeView).toBe("wishlist");
        expect(url()).toBe(SEARCH);
        await endOfTask();

        // A card opened over the new page is a replace by rule — and here it must not be, or it
        // would rename the Search entry the reader left.
        act(() => useAppStore.getState().setSelectedCardId(CARD));

        expect(replaceState).not.toHaveBeenCalled();
        expect(pushState).toHaveBeenCalledTimes(2);
        expect(pushState).toHaveBeenLastCalledWith(
          OVERLAID,
          "",
          placeHref({ view: "wishlist", deckId: null, cardId: CARD }),
        );
        // Search is still beneath it, where Back finds it.
        const landed = new Promise<void>((resolve) =>
          window.addEventListener("popstate", () => resolve(), { once: true }),
        );
        act(() => window.history.back());
        await act(() => landed);
        expect(url()).toBe(SEARCH);
        expect(useAppStore.getState().activeView).toBe("search");
      },
    );

    it("owes one entry, not one per write after it", async () => {
      window.history.replaceState(null, "", SEARCH);
      renderHook(() => useDesktopPlace());
      const pushState = refusePush("throws");
      act(() => useAppStore.getState().setActiveView("wishlist"));
      await endOfTask();
      act(() => useAppStore.getState().setSelectedCardId(CARD));
      await endOfTask();
      const replaceState = vi.spyOn(window.history, "replaceState");

      // The debt is paid: closing the card is the replace it always was.
      act(() => useAppStore.getState().setSelectedCardId(null));

      expect(pushState).toHaveBeenCalledTimes(2);
      expect(replaceState).toHaveBeenCalledTimes(1);
      expect(replaceState).toHaveBeenCalledWith(null, "", "/wishlist");
    });

    it("owes nothing once the reader is back on the place the URL still names", async () => {
      window.history.replaceState(null, "", SEARCH);
      renderHook(() => useDesktopPlace());
      const pushState = refusePush("drops");
      act(() => useAppStore.getState().setActiveView("wishlist"));
      await endOfTask();
      act(() => useAppStore.getState().setActiveView("search"));
      await endOfTask();
      const replaceState = vi.spyOn(window.history, "replaceState");

      // Back where the address says: a card here is written onto this entry, as ever.
      act(() => useAppStore.getState().setSelectedCardId(CARD));

      expect(pushState).toHaveBeenCalledTimes(1);
      expect(replaceState).toHaveBeenCalledWith(OVERLAID, "", searchWith(CARD));
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
      // Marked as an overlay, so a phone face handed this entry by a resize can tell it from a
      // card a reader arrived on by a link — see "across the floor" below.
      expect(replaceState).toHaveBeenCalledWith(OVERLAID, "", searchWith("x"));
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

  describe("refusing a view the light edition does not draw", () => {
    it("puts the store back on the URL's place, and writes no history", () => {
      // The collection's way into a shared binder is a `setActiveView("shared")`. The URL has no
      // word for that view: spelled, it was `/search` over a binder, and a reload landed there.
      window.history.replaceState(null, "", "/collection");
      renderHook(() => useDesktopPlace());
      const pushState = vi.spyOn(window.history, "pushState");
      const replaceState = vi.spyOn(window.history, "replaceState");

      act(() => useAppStore.getState().setActiveView("shared"));

      expect(useAppStore.getState().activeView).toBe("collection");
      expect(pushState).not.toHaveBeenCalled();
      expect(replaceState).not.toHaveBeenCalled();
      expect(url()).toBe("/collection");
    });

    it("keeps the deck and the card the URL names", () => {
      // `setActiveView` parks the open deck and closes the card on its way out; the way back has
      // to hand both back, or a refused press would still have cost the reader their place.
      const there = placeHref({ view: "decks", deckId: 7, cardId: CARD });
      window.history.replaceState(null, "", there);
      renderHook(() => useDesktopPlace());

      act(() => useAppStore.getState().setActiveView("home"));

      expect(useAppStore.getState().activeView).toBe("decks");
      expect(useAppStore.getState().openDeckId).toBe(7);
      expect(useAppStore.getState().selectedCardId).toBe(CARD);
      expect(url()).toBe(there);
    });
  });

  /**
   * The two faces' history meets on one entry whenever a resize crosses the floor with a card
   * open, and `routes.ts`'s marks are what each face leaves for the other.
   */
  describe("across the floor", () => {
    /** The next `popstate`. jsdom makes a traversal a task of its own, as a browser does. */
    const popped = (): Promise<void> =>
      new Promise((resolve) => window.addEventListener("popstate", () => resolve(), { once: true }));

    it("closes a card the phone face pushed by going back, not by a replace", async () => {
      // The phone face opened the card with a push over the page; a resize then drew this face.
      // A replace would leave two entries for one place, and the next Back would show nothing.
      window.history.replaceState(null, "", SEARCH);
      window.history.pushState(PUSHED, "", searchWith(CARD));
      renderHook(() => useDesktopPlace());
      expect(useAppStore.getState().selectedCardId).toBe(CARD);
      const entries = window.history.length;
      const pushState = vi.spyOn(window.history, "pushState");
      const replaceState = vi.spyOn(window.history, "replaceState");

      const landed = popped();
      act(() => useAppStore.getState().setSelectedCardId(null));
      await act(() => landed);

      expect(url()).toBe(SEARCH);
      expect(useAppStore.getState().selectedCardId).toBeNull();
      expect(pushState).not.toHaveBeenCalled();
      expect(replaceState).not.toHaveBeenCalled();
      // The card's entry is ahead of the reader now, for Forward — not beneath them for Back.
      expect(window.history.length).toBe(entries);
    });

    it("keeps the phone router's mark on a step from one card to another", () => {
      // What is beneath the entry is still the page, so a later close is still a Back.
      window.history.replaceState(null, "", SEARCH);
      window.history.pushState(PUSHED, "", searchWith(CARD));
      renderHook(() => useDesktopPlace());
      const replaceState = vi.spyOn(window.history, "replaceState");

      act(() => useAppStore.getState().setSelectedCardId("y"));

      expect(replaceState).toHaveBeenCalledWith(PUSHED, "", searchWith("y"));
    });

    it("closes a card on an entry nobody marked by a replace, as before", () => {
      // A link straight to a card: nothing of the app's is beneath it, so a Back would leave.
      window.history.replaceState(null, "", searchWith(CARD));
      renderHook(() => useDesktopPlace());
      const goBack = vi.spyOn(window.history, "back");
      const replaceState = vi.spyOn(window.history, "replaceState");

      act(() => useAppStore.getState().setSelectedCardId(null));

      expect(goBack).not.toHaveBeenCalled();
      expect(replaceState).toHaveBeenCalledWith(null, "", SEARCH);
    });

    it("drops its own overlay mark when the card it opened closes", () => {
      window.history.replaceState(null, "", SEARCH);
      renderHook(() => useDesktopPlace());
      act(() => useAppStore.getState().setSelectedCardId(CARD));
      expect(window.history.state).toEqual(OVERLAID);

      act(() => useAppStore.getState().setSelectedCardId(null));

      expect(url()).toBe(SEARCH);
      expect(window.history.state).toBeNull();
    });
  });
});
