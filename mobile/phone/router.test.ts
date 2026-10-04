import { createElement } from "react";
import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OVERLAID, PUSHED, type Place } from "../routes";
import { adoptOverlay, back, BACK_WAIT_MS, linkTo, navigate, usePlace } from "./router";

// `null` for the state as well as the path: an entry an earlier test pushed carries this router's
// mark, and a test must start on one that does not.
beforeEach(() => {
  window.history.replaceState(null, "", "/");
  // A place the router was left holding by a refused write ends with a traversal, as does a Back
  // it is still waiting on.
  window.dispatchEvent(new PopStateEvent("popstate"));
});
afterEach(() => vi.restoreAllMocks());

const url = (): string => window.location.pathname + window.location.search;

/** The next `popstate`. jsdom makes a traversal a task of its own, as a browser does. */
const popped = (): Promise<void> =>
  new Promise((resolve) => window.addEventListener("popstate", () => resolve(), { once: true }));

describe("the phone router", () => {
  it("answers where the URL says the reader is", () => {
    window.history.replaceState(null, "", "/decks/4");
    const { result } = renderHook(() => usePlace());
    expect(result.current).toEqual({ view: "decks", deckId: 4, cardId: null });
  });

  it("moves on navigate, and puts an entry in the history", () => {
    const { result } = renderHook(() => usePlace());
    const before = window.history.length;

    act(() => navigate({ view: "wishlist", deckId: null, cardId: null }));

    expect(result.current.view).toBe("wishlist");
    expect(window.location.pathname).toBe("/wishlist");
    expect(window.history.length).toBe(before + 1);
  });

  it("replaces rather than pushes when asked", () => {
    const { result } = renderHook(() => usePlace());
    const before = window.history.length;

    act(() => navigate({ view: "decks", deckId: null, cardId: null }, { replace: true }));

    expect(result.current.view).toBe("decks");
    expect(window.history.length).toBe(before);
  });

  it("does nothing for the place it is already on", () => {
    window.history.replaceState(null, "", "/search");
    renderHook(() => usePlace());
    const before = window.history.length;
    act(() => navigate({ view: "search", deckId: null, cardId: null }));
    expect(window.history.length).toBe(before);
  });

  it("does nothing for that place when the URL spells it another way", () => {
    // `/` is the start view without naming it, and it is where a cold start lands. A press on
    // the tab that is already lit must not push `/search` over it: Back would then undo nothing.
    renderHook(() => usePlace());
    const before = window.history.length;
    act(() => navigate({ view: "search", deckId: null, cardId: null }));
    expect(window.history.length).toBe(before);
    expect(window.location.pathname).toBe("/");
  });

  it("follows Back", () => {
    const { result } = renderHook(() => usePlace());
    act(() => navigate({ view: "collection", deckId: null, cardId: null }));

    act(() => {
      window.history.replaceState(null, "", "/search");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(result.current.view).toBe("search");
  });

  it("hands back one object while the URL holds still", () => {
    const { result, rerender } = renderHook(() => usePlace());
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });
});

describe("back", () => {
  const collection: Place = { view: "collection", deckId: null, cardId: null };
  const card: Place = { ...collection, cardId: "abc" };

  it("undoes the push that opened a place, and adds no entry of its own", async () => {
    window.history.replaceState(null, "", "/collection");
    navigate(card);
    expect(url()).toBe("/collection?card=abc");
    // A Back never shortens the history — the entry it left is still there to go Forward to — so
    // what a close must not do is lengthen it.
    const opened = window.history.length;
    const pushState = vi.spyOn(window.history, "pushState");
    const replaceState = vi.spyOn(window.history, "replaceState");

    const landed = popped();
    back(collection);
    await landed;

    expect(url()).toBe("/collection");
    // A traversal, not a rename: the card's entry is off the path the reader walks back along.
    expect(pushState).not.toHaveBeenCalled();
    expect(replaceState).not.toHaveBeenCalled();
    expect(window.history.length).toBe(opened);
  });

  it("replaces, and makes no Back, on an entry this router did not push", () => {
    // A deep link: nothing of this router's is beneath it, so a Back would leave the app.
    window.history.replaceState(null, "", "/collection?card=abc");
    const before = window.history.length;
    const goBack = vi.spyOn(window.history, "back");
    const replaceState = vi.spyOn(window.history, "replaceState");

    back(collection);

    expect(goBack).not.toHaveBeenCalled();
    expect(replaceState).toHaveBeenCalledTimes(1);
    expect(url()).toBe("/collection");
    expect(window.history.length).toBe(before);
  });

  it("leaves nothing for the next Back to reopen", async () => {
    window.history.replaceState(null, "", "/decks");
    navigate(collection);
    navigate(card);

    const closed = popped();
    back(collection);
    await closed;
    expect(url()).toBe("/collection");

    const left = popped();
    window.history.back();
    await left;
    // Not `/collection?card=abc`: closing by a push left the card one Back beneath the page.
    expect(url()).toBe("/decks");
  });

  it("goes back once when asked twice before the first has landed", async () => {
    // A traversal is a task of its own, so a second press on the ✕ can arrive while the entry is
    // still the marked one. Two Backs would take the reader off the page the card was over.
    window.history.replaceState(null, "", "/decks");
    navigate(collection);
    navigate(card);
    const goBack = vi.spyOn(window.history, "back");

    const landed = popped();
    back(collection);
    back(collection);
    await landed;

    expect(goBack).toHaveBeenCalledTimes(1);
    expect(url()).toBe("/collection");
  });

  it("does nothing for the place the reader is already on", () => {
    // The ✕ of a sheet that is fading out is still pressable, and by then the card has closed.
    window.history.replaceState(null, "", "/decks");
    navigate(collection);
    const goBack = vi.spyOn(window.history, "back");
    const replaceState = vi.spyOn(window.history, "replaceState");

    back(collection);

    expect(goBack).not.toHaveBeenCalled();
    expect(replaceState).not.toHaveBeenCalled();
    expect(url()).toBe("/collection");
  });

  it("keeps an entry's mark when the entry is replaced", () => {
    window.history.replaceState(null, "", "/decks");
    navigate(collection);
    navigate({ view: "wishlist", deckId: null, cardId: null }, { replace: true });
    // Stubbed, so no traversal is left pending for the next test to trip over.
    const goBack = vi.spyOn(window.history, "back").mockImplementation(() => undefined);

    back({ view: "decks", deckId: null, cardId: null });

    // Still an entry with one of this router's beneath it, whatever it now names.
    expect(goBack).toHaveBeenCalledTimes(1);
    // The stub made no traversal, so nothing told the router its Back had landed. Say so.
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
});

/**
 * A card the desktop face had open when a resize drew this face. The desktop face writes a card
 * onto the entry it was opened over and marks it `OVERLAID`; this face's card is a push.
 */
describe("adoptOverlay", () => {
  const collection: Place = { view: "collection", deckId: null, cardId: null };

  it("splits the desktop face's card into the page and a push over it", async () => {
    window.history.replaceState(OVERLAID, "", "/collection?card=abc");
    const pushState = vi.spyOn(window.history, "pushState");

    adoptOverlay();

    // The address bar has not moved, and the entry is now one this router pushed...
    expect(url()).toBe("/collection?card=abc");
    expect(window.history.state).toEqual(PUSHED);
    expect(pushState).toHaveBeenCalledTimes(1);

    // ...so the ✕ is a Back, and lands on the page — which is also where Android's back gesture,
    // a Back the router did not ask for, now lands instead of leaving it.
    const landed = popped();
    back(collection);
    await landed;
    expect(url()).toBe("/collection");
  });

  it("does it once, however often it is asked", () => {
    window.history.replaceState(OVERLAID, "", "/collection?card=abc");
    // Counted by the spy rather than by `history.length`, which a push past an earlier test's
    // Forward entry does not lengthen.
    const pushState = vi.spyOn(window.history, "pushState");

    adoptOverlay();
    adoptOverlay();

    expect(pushState).toHaveBeenCalledTimes(1);
  });

  it("leaves a card nobody marked alone", () => {
    // A link straight to a card: nothing of the app's is beneath it, and `back` replaces there.
    window.history.replaceState(null, "", "/collection?card=abc");
    const pushState = vi.spyOn(window.history, "pushState");
    const replaceState = vi.spyOn(window.history, "replaceState");

    adoptOverlay();

    expect(pushState).not.toHaveBeenCalled();
    expect(replaceState).not.toHaveBeenCalled();
  });

  it("puts the entry back when the browser refuses the push", () => {
    window.history.replaceState(OVERLAID, "", "/collection?card=abc");
    vi.spyOn(window.history, "pushState").mockImplementation(() => {
      throw new DOMException("Too many calls to the History API", "SecurityError");
    });

    adoptOverlay();

    expect(url()).toBe("/collection?card=abc");
    expect(window.history.state).toEqual(OVERLAID);
  });
});

describe("linkTo", () => {
  const decks: Place = { view: "decks", deckId: null, cardId: null };

  /**
   * Press a link to Decks, and answer whether the link's own handler prevented the default.
   *
   * The listener on `window` runs after React's, reads the answer, and then prevents the default
   * itself: jsdom follows an unprevented click on a link and reports "Not implemented:
   * navigation", which is the document load a real browser would make.
   */
  function press(init: MouseEventInit = {}): boolean {
    render(createElement("a", linkTo(decks), "Decks"));
    let prevented = false;
    window.addEventListener(
      "click",
      (event) => {
        prevented = event.defaultPrevented;
        event.preventDefault();
      },
      { once: true },
    );
    fireEvent.click(screen.getByRole("link", { name: "Decks" }), init);
    return prevented;
  }

  it("points the link at the place's own URL", () => {
    render(createElement("a", linkTo({ view: "decks", deckId: 12, cardId: null }), "A deck"));
    expect(screen.getByRole("link", { name: "A deck" })).toHaveAttribute("href", "/decks/12");
  });

  it("navigates on a plain press, and keeps the browser from loading a document", () => {
    const before = window.history.length;
    expect(press()).toBe(true);
    expect(url()).toBe("/decks");
    expect(window.history.length).toBe(before + 1);
  });

  it("replaces the entry on a plain press when asked to, and keeps its mark", () => {
    // The card sheet's printings: a step to another printing is not a Back step.
    window.history.replaceState({ pushed: true }, "", "/search?card=a");
    const before = window.history.length;
    const other: Place = { view: "search", deckId: null, cardId: "b" };
    render(createElement("a", linkTo(other, { replace: true }), "Other printing"));

    fireEvent.click(screen.getByRole("link", { name: "Other printing" }));

    expect(url()).toBe("/search?card=b");
    expect(window.history.length).toBe(before);
    expect(window.history.state).toEqual({ pushed: true });
  });

  it.each(["ctrlKey", "metaKey", "shiftKey", "altKey"] as const)(
    "leaves a press with %s held to the browser",
    (modifier) => {
      const pushState = vi.spyOn(window.history, "pushState");
      expect(press({ [modifier]: true })).toBe(false);
      expect(pushState).not.toHaveBeenCalled();
      expect(url()).toBe("/");
    },
  );

  it("leaves a press of any button but the primary one to the browser", () => {
    const pushState = vi.spyOn(window.history, "pushState");
    expect(press({ button: 1 })).toBe(false);
    expect(pushState).not.toHaveBeenCalled();
    expect(url()).toBe("/");
  });

  it("leaves a press something else already handled alone", () => {
    const pushState = vi.spyOn(window.history, "pushState");
    // Capture, so it runs before the link's own handler.
    window.addEventListener("click", (event) => event.preventDefault(), {
      capture: true,
      once: true,
    });
    press();
    expect(pushState).not.toHaveBeenCalled();
    expect(url()).toBe("/");
  });
});

/**
 * A browser rations the History API: past some rate a write throws (a `SecurityError`) or is
 * dropped without a word. Either way the address does not move, and the reader pressed something.
 */
describe("a history write the browser refuses", () => {
  const collection: Place = { view: "collection", deckId: null, cardId: null };
  const card: Place = { ...collection, cardId: "abc" };

  /** Refuse the next call of `verb`, the way `how` says. */
  function refuse(verb: "pushState" | "replaceState", how: "throws" | "drops") {
    return vi.spyOn(window.history, verb).mockImplementationOnce(() => {
      if (how === "throws") {
        throw new DOMException("Too many calls to the History API", "SecurityError");
      }
    });
  }

  it.each(["throws", "drops"] as const)(
    "still moves the reader and tells every listener when a push %s",
    (how) => {
      window.history.replaceState(null, "", "/collection");
      const { result } = renderHook(() => usePlace());
      const before = window.history.length;
      refuse("pushState", how);

      expect(() => act(() => navigate(card))).not.toThrow();

      // The page draws the card; the browser has no entry for it and its address did not move.
      expect(result.current).toEqual(card);
      expect(url()).toBe("/collection");
      expect(window.history.length).toBe(before);
    },
  );

  it("closes a card it could not push without a Back, which would leave the page", () => {
    // The page itself is one of this router's pushes, so its entry carries the mark — and the
    // card over it has no entry at all. A Back here would walk the reader off the page.
    window.history.replaceState(null, "", "/decks");
    navigate(collection);
    const { result } = renderHook(() => usePlace());
    refuse("pushState", "throws");
    act(() => navigate(card));
    const goBack = vi.spyOn(window.history, "back");
    const replaceState = vi.spyOn(window.history, "replaceState");

    act(() => back(collection));

    expect(result.current).toEqual(collection);
    expect(goBack).not.toHaveBeenCalled();
    // Forgotten, not renamed: the entry the browser is on already names the page.
    expect(replaceState).not.toHaveBeenCalled();
    expect(url()).toBe("/collection");
  });

  it("writes the next place the browser accepts, and is in step with it again", () => {
    window.history.replaceState(null, "", "/collection");
    const { result } = renderHook(() => usePlace());
    const pushState = refuse("pushState", "drops");
    act(() => navigate(card));

    act(() => navigate({ view: "decks", deckId: null, cardId: null }));

    expect(result.current.view).toBe("decks");
    expect(url()).toBe("/decks");
    // The dropped push and this one: one entry, over the page the card was never written onto.
    expect(pushState).toHaveBeenCalledTimes(2);
    expect(pushState).toHaveBeenLastCalledWith(PUSHED, "", "/decks");
  });

  it("pays a held page its entry before a card is pushed over it", async () => {
    // The page's push was refused and the card's is taken. Pushed alone, the marked card would
    // sit on the page the reader had *left* — and ✕, which goes back to what the mark promises
    // is beneath, would land them there instead of on the page they were looking at.
    const deck: Place = { view: "decks", deckId: 7, cardId: null };
    window.history.replaceState(null, "", "/collection");
    const { result } = renderHook(() => usePlace());
    const pushState = refuse("pushState", "throws");
    act(() => navigate(deck));
    expect(url()).toBe("/collection");

    act(() => navigate({ ...deck, cardId: "abc" }));

    // The refused push, then the page, then the card over it.
    expect(pushState.mock.calls.map(([, , to]) => to)).toEqual([
      "/decks/7",
      "/decks/7",
      "/decks/7?card=abc",
    ]);
    expect(window.history.state).toEqual(PUSHED);

    const closed = popped();
    act(() => back(deck));
    await act(() => closed);
    expect(url()).toBe("/decks/7");
    expect(result.current).toEqual(deck);

    // And the page the reader came from is still one more Back away.
    const left = popped();
    act(() => window.history.back());
    await act(() => left);
    expect(url()).toBe("/collection");
  });

  it("holds the card too when the browser still will not take its page", () => {
    const deck: Place = { view: "decks", deckId: 7, cardId: null };
    window.history.replaceState(null, "", "/collection");
    const { result } = renderHook(() => usePlace());
    const pushState = vi.spyOn(window.history, "pushState").mockImplementation(() => undefined);
    act(() => navigate(deck));

    act(() => navigate({ ...deck, cardId: "abc" }));

    // The card is on screen, and no marked card was written over a page that is not its own.
    expect(result.current).toEqual({ ...deck, cardId: "abc" });
    expect(pushState.mock.calls.map(([, , to]) => to)).toEqual(["/decks/7", "/decks/7"]);
    expect(url()).toBe("/collection");

    // Closing it forgets the card and leaves the page held: still no Back to make.
    const goBack = vi.spyOn(window.history, "back");
    act(() => back(deck));
    expect(result.current).toEqual(deck);
    expect(goBack).not.toHaveBeenCalled();
  });

  it("drops a hold when the address moves by a write that was not this router's", () => {
    // The desktop face writes history too. After a resize across the floor and back, a place
    // held from before must not be drawn over an address that has moved on.
    window.history.replaceState(null, "", "/collection");
    const { result, rerender } = renderHook(() => usePlace());
    refuse("pushState", "drops");
    act(() => navigate(card));
    expect(result.current.cardId).toBe("abc");

    window.history.replaceState(null, "", "/wishlist");
    rerender();

    expect(result.current).toEqual({ view: "wishlist", deckId: null, cardId: null });
  });

  it("keeps a step to another printing off the entry beneath a card it could not push", () => {
    window.history.replaceState(null, "", "/collection");
    const { result } = renderHook(() => usePlace());
    refuse("pushState", "throws");
    act(() => navigate(card));
    const replaceState = vi.spyOn(window.history, "replaceState");

    act(() => navigate({ ...collection, cardId: "def" }, { replace: true }));

    // A replace would have renamed the page's own entry to a card with nothing beneath it.
    expect(result.current.cardId).toBe("def");
    expect(replaceState).not.toHaveBeenCalled();
    expect(url()).toBe("/collection");
  });

  it("follows a Back the reader makes, wherever it was holding them", () => {
    window.history.replaceState(null, "", "/collection");
    const { result } = renderHook(() => usePlace());
    refuse("pushState", "throws");
    act(() => navigate(card));
    expect(result.current.cardId).toBe("abc");

    // The browser moved: where it landed is where the reader is.
    act(() => {
      window.history.replaceState(null, "", "/search");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    expect(result.current).toEqual({ view: "search", deckId: null, cardId: null });
  });

  it("closes by a real Back when only a step between printings was refused", async () => {
    window.history.replaceState(null, "", "/collection");
    navigate(card);
    refuse("replaceState", "throws");
    navigate({ ...collection, cardId: "def" }, { replace: true });
    expect(url()).toBe("/collection?card=abc");

    // The browser's entry is still a pushed card over this page, so the close is still a Back.
    const landed = popped();
    back(collection);
    await landed;
    expect(url()).toBe("/collection");
  });
});

describe("a Back the browser never makes", () => {
  const collection: Place = { view: "collection", deckId: null, cardId: null };
  const card: Place = { ...collection, cardId: "abc" };

  afterEach(() => vi.useRealTimers());

  it("closes the sheet by renaming the entry once the wait is up", () => {
    window.history.replaceState(null, "", "/collection");
    navigate(card);
    const { result } = renderHook(() => usePlace());
    vi.useFakeTimers();
    const goBack = vi.spyOn(window.history, "back").mockImplementation(() => undefined);

    act(() => back(collection));
    // Still waiting: a working Back lands well inside this.
    act(() => void vi.advanceTimersByTime(BACK_WAIT_MS - 1));
    expect(result.current.cardId).toBe("abc");

    act(() => void vi.advanceTimersByTime(1));

    expect(goBack).toHaveBeenCalledTimes(1);
    expect(result.current).toEqual(collection);
    expect(url()).toBe("/collection");
  });

  it("is not left latched: the next close works", () => {
    // The one release used to be a `popstate`, so a dropped Back left every later ✕ inert.
    window.history.replaceState(null, "", "/collection");
    navigate(card);
    vi.useFakeTimers();
    const goBack = vi.spyOn(window.history, "back").mockImplementation(() => undefined);
    back(collection);
    vi.advanceTimersByTime(BACK_WAIT_MS);
    expect(url()).toBe("/collection");

    navigate({ ...collection, cardId: "def" });
    back(collection);

    expect(goBack).toHaveBeenCalledTimes(2);
    // And that one's own wait is run out, so nothing is left pending for the next test.
    vi.advanceTimersByTime(BACK_WAIT_MS);
  });

  it("leaves a Back that did land alone when the wait runs out", async () => {
    window.history.replaceState(null, "", "/decks");
    navigate(collection);
    navigate(card);
    const replaceState = vi.spyOn(window.history, "replaceState");

    const landed = popped();
    back(collection);
    await landed;
    await new Promise((resolve) => setTimeout(resolve, BACK_WAIT_MS + 50));

    expect(replaceState).not.toHaveBeenCalled();
    expect(url()).toBe("/collection");
  });

  it("renames the entry at once when the browser throws on the Back itself", () => {
    window.history.replaceState(null, "", "/collection");
    navigate(card);
    vi.spyOn(window.history, "back").mockImplementation(() => {
      throw new DOMException("The operation is insecure.", "SecurityError");
    });

    expect(() => back(collection)).not.toThrow();

    expect(url()).toBe("/collection");
  });
});
