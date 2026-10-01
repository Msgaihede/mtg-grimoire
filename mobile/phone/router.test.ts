import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { navigate, usePlace } from "./router";

beforeEach(() => window.history.replaceState(null, "", "/"));

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
