import { act, createEvent, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import type { Place } from "../routes";
import { pageKey, PageStack, useSwipeBack } from "./PageStack";
import { navigate, switchTo, usePlace } from "./router";

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  window.dispatchEvent(new PopStateEvent("popstate"));
});

const gallery: Place = { view: "decks", deckId: null, cardId: null };
const deck = (deckId: number): Place => ({ view: "decks", deckId, cardId: null });

/** A page that names itself, and offers its way up to the gallery as a deck's does. */
function Page({ place }: { place: Place }) {
  useSwipeBack(place.deckId === null ? null : gallery);
  return <p>{place.deckId === null ? "The gallery" : `Deck ${place.deckId}`}</p>;
}

function Face() {
  const place = usePlace();
  return <PageStack place={place} render={(at) => <Page place={at} />} />;
}

/**
 * A touch at `x` on `el`, as `@use-gesture/react` reads one: the list of touches on the target, and
 * the event's own timestamp, which it measures speed by.
 */
function touch(el: Element, kind: "touchStart" | "touchMove" | "touchEnd", x: number, t: number) {
  const point = { identifier: 1, target: el, clientX: x, clientY: 300, pageX: x, pageY: 300 };
  const touches = kind === "touchEnd" ? [] : [point];
  const event = createEvent[kind](el, { touches, targetTouches: touches, changedTouches: [point] });
  // jsdom stamps an event with its own clock and ignores one given in the init.
  Object.defineProperty(event, "timeStamp", { value: t });
  fireEvent(el, event);
}

describe("the page stack", () => {
  it("keys a page by its place less its card, so a card opens over the page it is on", () => {
    expect(pageKey({ ...deck(5), cardId: "9" })).toBe(pageKey(deck(5)));
    expect(pageKey(deck(5))).not.toBe(pageKey(gallery));
    expect(pageKey({ ...gallery, folderId: 3 })).not.toBe(pageKey(gallery));
  });

  it("draws one page once a move has finished, whichever way it went", async () => {
    window.history.replaceState(null, "", "/decks");
    render(<Face />);
    act(() => navigate(deck(5)));
    await waitFor(() => expect(screen.queryByText("The gallery")).toBeNull());
    expect(screen.getByText("Deck 5")).toBeVisible();

    act(() => switchTo({ view: "collection", deckId: null, cardId: null }));
    await waitFor(() => expect(screen.queryByText("Deck 5")).toBeNull());
  });

  it("goes back to the page's way up when it is swiped right past the line", async () => {
    window.history.replaceState(null, "", "/decks");
    render(<Face />);
    act(() => navigate(deck(5)));
    await waitFor(() => expect(screen.queryByText("The gallery")).toBeNull());

    const page = screen.getByText("Deck 5");
    touch(page, "touchStart", 40, 1000);
    touch(page, "touchMove", 80, 1016);
    // The page beneath is drawn as soon as the swipe is the page's, and is no page to use yet.
    expect(screen.getByText("The gallery").closest("[aria-hidden]")).not.toBeNull();
    // jsdom's window is 1024px wide, and the line is 35% of it.
    touch(page, "touchMove", 600, 1100);
    touch(page, "touchMove", 600, 1300);
    touch(page, "touchEnd", 600, 1300);

    await waitFor(() => expect(window.location.pathname).toBe("/decks"));
    await waitFor(() => expect(screen.queryByText("Deck 5")).toBeNull());
    expect(screen.getByText("The gallery").closest("[aria-hidden]")).toBeNull();
  });

  it("puts the page back when the swipe is let go short of the line", async () => {
    window.history.replaceState(null, "", "/decks");
    render(<Face />);
    act(() => navigate(deck(5)));
    await waitFor(() => expect(screen.queryByText("The gallery")).toBeNull());

    const page = screen.getByText("Deck 5");
    touch(page, "touchStart", 40, 1000);
    touch(page, "touchMove", 60, 1016);
    touch(page, "touchMove", 80, 1200);
    touch(page, "touchEnd", 80, 1400);

    await waitFor(() => expect(screen.queryByText("The gallery")).toBeNull());
    expect(window.location.pathname).toBe("/decks/5");
  });

  it("offers no swipe on a page with no way up", async () => {
    window.history.replaceState(null, "", "/decks");
    render(<Face />);
    const page = screen.getByText("The gallery");
    touch(page, "touchStart", 40, 1000);
    touch(page, "touchMove", 300, 1016);
    touch(page, "touchEnd", 300, 1016);
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(window.location.pathname).toBe("/decks");
    expect(screen.getAllByText("The gallery")).toHaveLength(1);
  });
});
