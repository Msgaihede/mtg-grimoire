import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "@/lib/store";
import { useDesktopPlace } from "./useDesktopPlace";

const PRISTINE = useAppStore.getState();

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

  it("follows Back onto the gallery without pushing, even with a deck parked", () => {
    // Entering Decks hands back the deck that was open when the reader left — the store's own
    // rule — so following the URL onto the gallery takes two writes, and the first one is a
    // place the URL never named. Written back, it would bury the entry just gone back to.
    window.history.replaceState(null, "", "/decks/7");
    renderHook(() => useDesktopPlace());
    act(() => useAppStore.getState().setActiveView("wishlist"));
    expect(useAppStore.getState().parkedDeckId).toBe(7);

    const pushState = vi.spyOn(window.history, "pushState");
    act(() => {
      // A jump of more than one entry — the browser's Back menu — onto the gallery's own.
      window.history.replaceState(null, "", "/decks");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    expect(useAppStore.getState().activeView).toBe("decks");
    expect(useAppStore.getState().openDeckId).toBeNull();
    expect(pushState).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe("/decks");
  });

  it("stops listening when the face goes", () => {
    const { unmount } = renderHook(() => useDesktopPlace());
    unmount();
    act(() => useAppStore.getState().setActiveView("wishlist"));
    expect(window.location.pathname).toBe("/");
  });
});
