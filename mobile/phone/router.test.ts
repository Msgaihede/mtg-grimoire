import { createElement } from "react";
import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Place } from "../routes";
import { back, linkTo, navigate, usePlace } from "./router";

// `null` for the state as well as the path: an entry an earlier test pushed carries this router's
// mark, and a test must start on one that does not.
beforeEach(() => window.history.replaceState(null, "", "/"));
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
