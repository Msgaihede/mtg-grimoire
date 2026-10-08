import { fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("../../../packages/fake/core"));
vi.mock("@tauri-apps/api/event", () => import("../../../packages/fake/event"));
vi.mock("@tauri-apps/api/window", () => import("../../../packages/fake/window"));

import { listeningScopes } from "../../../packages/fake/scope";
import { OVERLAID, PUSHED, placeHref } from "../routes";
import { PhoneFace } from "./PhoneApp";
import { installLayout, renderPhone } from "./testing";

beforeAll(installLayout);
afterEach(() => vi.restoreAllMocks());

const tabBar = () => screen.getByRole("navigation", { name: "Views" });

const tabs = () =>
  within(tabBar())
    .getAllByRole("link")
    .map((b) => b.textContent);

describe("the phone shell", () => {
  it("draws five tabs, in the rail's order", () => {
    renderPhone(<PhoneFace />);
    expect(tabs()).toEqual(["Search", "Decks", "Collection", "Wishlist", "Scanner"]);
  });

  it("opens on Search and says so in the title", () => {
    renderPhone(<PhoneFace />);
    expect(screen.getByRole("heading", { level: 1, name: "Search" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Search" })).toHaveAttribute("aria-current", "page");
  });

  it("moves on a tab press, and the URL follows", async () => {
    renderPhone(<PhoneFace />);
    await userEvent.click(screen.getByRole("link", { name: "Wishlist" }));

    expect(window.location.pathname).toBe("/wishlist");
    expect(screen.getByRole("heading", { level: 1, name: "Wishlist" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Wishlist" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Search" })).not.toHaveAttribute("aria-current");
  });

  it("opens on the URL's destination", () => {
    renderPhone(<PhoneFace />, { path: "/collection" });
    expect(screen.getByRole("heading", { level: 1, name: "Collection" })).toBeInTheDocument();
  });

  it("reaches Settings from the top bar, and lights no tab there", async () => {
    renderPhone(<PhoneFace />);
    await userEvent.click(screen.getByRole("link", { name: "Settings" }));

    expect(window.location.pathname).toBe("/settings");
    expect(screen.getByRole("heading", { level: 1, name: "Settings" })).toBeInTheDocument();
    for (const tab of within(tabBar()).getAllByRole("link")) {
      expect(tab).not.toHaveAttribute("aria-current");
    }
  });

  it("returns on Back", async () => {
    renderPhone(<PhoneFace />);
    await userEvent.click(screen.getByRole("link", { name: "Decks" }));
    expect(screen.getByRole("heading", { level: 1, name: "Decks" })).toBeInTheDocument();

    window.history.back();
    expect(await screen.findByRole("heading", { level: 1, name: "Search" })).toBeInTheDocument();
  });
});

describe("the shell's destinations are links", () => {
  it("points each tab, and the Settings control, at its own place's URL", () => {
    renderPhone(<PhoneFace />);
    const views = ["search", "decks", "collection", "wishlist", "scanner"] as const;
    expect(
      within(tabBar())
        .getAllByRole("link")
        .map((a) => a.getAttribute("href")),
    ).toEqual(views.map((view) => placeHref({ view, deckId: null, cardId: null })));
    expect(screen.getByRole("link", { name: "Settings" })).toHaveAttribute(
      "href",
      placeHref({ view: "settings", deckId: null, cardId: null }),
    );
  });

  it("follows a plain press without loading a document", () => {
    renderPhone(<PhoneFace />);
    // `fireEvent` answers false when the default was prevented, and the default of a press on a
    // link is the document load.
    expect(fireEvent.click(screen.getByRole("link", { name: "Decks" }))).toBe(false);
    expect(window.location.pathname).toBe("/decks");
    expect(screen.getByRole("heading", { level: 1, name: "Decks" })).toBeInTheDocument();
  });

  it("leaves a ctrl-press to the browser, which opens a tab of its own", () => {
    renderPhone(<PhoneFace />);
    const pushState = vi.spyOn(window.history, "pushState");
    // After React's own listener: reads what the link decided, then stands in for the browser.
    // jsdom follows an unprevented press on a link and reports "Not implemented: navigation".
    let prevented = true;
    window.addEventListener(
      "click",
      (event) => {
        prevented = event.defaultPrevented;
        event.preventDefault();
      },
      { once: true },
    );

    fireEvent.click(screen.getByRole("link", { name: "Decks" }), { ctrlKey: true });

    expect(prevented).toBe(false);
    expect(pushState).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe("/");
    expect(screen.getByRole("heading", { level: 1, name: "Search" })).toBeInTheDocument();
  });
});

/**
 * jsdom lays nothing out and reads no `env()`, so neither of these can be seen as a drawing here.
 * What can be pinned is the class that does it — `Dialog.test.tsx`'s way with its own clamp.
 */
describe("the shell at the screen's edges", () => {
  it("keeps the Settings control's focus ring inside the control", () => {
    // The control is flush to the viewport's top wherever the top inset is 0, and a ring standing
    // off it is drawn above the screen.
    renderPhone(<PhoneFace />);
    const settings = screen.getByRole("link", { name: "Settings" });
    expect(settings.classList.contains("focus-visible:-outline-offset-2")).toBe(true);
    expect(settings.classList.contains("focus-visible:outline-offset-2")).toBe(false);
  });

  it("bleeds the bars to the screen's edges and insets what is in them", () => {
    // Until 2026-10-03 the frame padded the two sides, so in landscape both bars stopped short of
    // the edge beside a cutout. Now no box around the bars is padded, and each insets its content.
    renderPhone(<PhoneFace />);
    const banner = screen.getByRole("banner");
    for (let box = banner.parentElement; box !== null; box = box.parentElement) {
      expect(box.className).not.toMatch(/\bp[lrx]-\[env\(safe-area/);
    }
    expect(banner.classList.contains("pt-[env(safe-area-inset-top)]")).toBe(true);
    const row = banner.firstElementChild as HTMLElement;
    expect(row.classList.contains("pl-[calc(1rem+env(safe-area-inset-left))]")).toBe(true);
    expect(row.classList.contains("pr-[calc(1rem+env(safe-area-inset-right))]")).toBe(true);
    for (const side of ["left", "right", "bottom"]) {
      expect(tabBar().className).toContain(`env(safe-area-inset-${side})`);
    }
    // The page between them keeps its side insets.
    const main = screen.getByRole("main");
    expect(main.classList.contains("pl-[env(safe-area-inset-left)]")).toBe(true);
    expect(main.classList.contains("pr-[env(safe-area-inset-right)]")).toBe(true);
  });

  it("turns the tab bar into a rail from 600px, by the width alone", () => {
    // jsdom applies no media query, so what is pinned is the one breakpoint, on both boxes that
    // change at it — and that nothing else picks the arrangement.
    renderPhone(<PhoneFace />);
    expect(tabBar().classList.contains("min-[600px]:flex-col")).toBe(true);
    expect(
      (tabBar().parentElement as HTMLElement).classList.contains("min-[600px]:flex-row-reverse"),
    ).toBe(true);
    // After the page in the document at every width, so the tab order never changes with it.
    expect(screen.getByRole("main").nextElementSibling).toBe(tabBar());
  });
});

describe("a card the desktop face had open", () => {
  it("is taken over as one of the router's own, so Back closes its sheet", async () => {
    // The desktop face writes a card onto the entry it opened it over and marks it; a resize then
    // drew this face. Left alone, ✕ closed the sheet and Back left the page beneath it.
    const card = placeHref({ view: "search", deckId: null, cardId: "nowhere" });
    renderPhone(<PhoneFace />, { path: card, state: OVERLAID });

    expect(window.location.pathname + window.location.search).toBe(card);
    expect(window.history.state).toEqual(PUSHED);

    const landed = new Promise((resolve) =>
      window.addEventListener("popstate", resolve, { once: true }),
    );
    window.history.back();
    await landed;
    expect(window.location.pathname + window.location.search).toBe(
      placeHref({ view: "search", deckId: null, cardId: null }),
    );
  });
});

// Last in the file on purpose: it is about every `renderPhone` that ran before it.
describe("the harness", () => {
  it("leaves no earlier test's world mounted", () => {
    renderPhone(<PhoneFace />);
    // One world: this test's. A world left mounted is offered every event a later test emits.
    expect(listeningScopes()).toHaveLength(1);
  });
});
