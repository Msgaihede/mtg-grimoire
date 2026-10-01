import { fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("../../.storybook/fake/core"));
vi.mock("@tauri-apps/api/event", () => import("../../.storybook/fake/event"));
vi.mock("@tauri-apps/api/window", () => import("../../.storybook/fake/window"));

import { listeningScopes } from "../../.storybook/fake/scope";
import { placeHref } from "../routes";
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

  it("pads the frame by all four safe-area insets", () => {
    renderPhone(<PhoneFace />);
    const frame = tabBar().parentElement as HTMLElement;
    expect(frame.classList.contains("pl-[env(safe-area-inset-left)]")).toBe(true);
    expect(frame.classList.contains("pr-[env(safe-area-inset-right)]")).toBe(true);
    expect(screen.getByRole("banner").classList.contains("pt-[env(safe-area-inset-top)]")).toBe(true);
    expect(tabBar().classList.contains("pb-[env(safe-area-inset-bottom)]")).toBe(true);
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
