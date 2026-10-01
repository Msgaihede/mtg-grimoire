import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("../../../.storybook/fake/core"));
vi.mock("@tauri-apps/api/event", () => import("../../../.storybook/fake/event"));
vi.mock("@tauri-apps/api/window", () => import("../../../.storybook/fake/window"));

import { PhoneFace } from "../PhoneApp";
import { installLayout, renderPhone } from "../testing";

beforeAll(installLayout);

/** Long enough for the search box's 300ms debounce and a fake round trip. */
const SETTLE = { timeout: 3000 };

/**
 * The card a tile is named for: its label less the printing, which is the last `, ` on it.
 *
 * Not the first — the starter seed's first search result is `Agadeem's Awakening // Agadeem, the
 * Undercrypt`, and a name cut at its own comma is a heading no sheet draws.
 */
function cardNameOf(tile: HTMLElement): string {
  const label = tile.getAttribute("aria-label") ?? "";
  return label.slice(0, label.lastIndexOf(", "));
}

describe("Search", () => {
  it("draws a wall of cards before anything is typed", async () => {
    renderPhone(<PhoneFace />, { path: "/search" });
    const wall = await screen.findByRole("list", { name: "Search results" });
    await waitFor(() => expect(within(wall).getAllByRole("button").length).toBeGreaterThan(0), SETTLE);
  });

  it("narrows the wall to what was typed", async () => {
    renderPhone(<PhoneFace />, { path: "/search" });
    const wall = await screen.findByRole("list", { name: "Search results" });
    const names = () =>
      within(wall).getAllByRole("button").map((b) => b.getAttribute("aria-label") ?? "");
    const before = await waitFor(() => names().length, SETTLE);

    await userEvent.type(screen.getByRole("searchbox", { name: "Search cards" }), "lightning bolt");

    // Fewer tiles than the unfiltered wall drew, and the card that was typed among them. Not
    // "every tile is Lightning Bolt": the fake's text search is a substring over more than names.
    await waitFor(() => {
      expect(names().length).toBeLessThan(before);
      expect(names().some((name) => /^Lightning Bolt, /.test(name))).toBe(true);
    }, SETTLE);
  });

  it("says so when nothing matches, and offers no wall", async () => {
    renderPhone(<PhoneFace />, { path: "/search" });
    await userEvent.type(screen.getByRole("searchbox", { name: "Search cards" }), "zzzqqqxxx");
    expect(await screen.findByText("No cards match.", undefined, SETTLE)).toBeInTheDocument();
  });

  it("opens a card over the wall, and Back closes it", async () => {
    renderPhone(<PhoneFace />, { path: "/search" });
    const wall = await screen.findByRole("list", { name: "Search results" });
    const first = await waitFor(() => within(wall).getAllByRole("button")[0], SETTLE);
    const name = cardNameOf(first);

    await userEvent.click(first);

    expect(window.location.search).toMatch(/^\?card=/);
    const sheet = await screen.findByRole("dialog");
    expect(await within(sheet).findByRole("heading", { name })).toBeInTheDocument();

    window.history.back();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(window.location.search).toBe("");
  });

  it("closes the card from the sheet's own button, and leaves no Back that reopens it", async () => {
    // Search by way of Decks, so there is a page beneath it for a Back to land on.
    renderPhone(<PhoneFace />, { path: "/decks" });
    await userEvent.click(screen.getByRole("link", { name: "Search" }));
    const wall = await screen.findByRole("list", { name: "Search results" });
    await userEvent.click(await waitFor(() => within(wall).getAllByRole("button")[0], SETTLE));
    const sheet = await screen.findByRole("dialog");
    const opened = window.history.length;

    await userEvent.click(within(sheet).getByRole("button", { name: "Close card" }));

    // The close is a Back, and a traversal is a task of its own — in jsdom as in a browser.
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(window.location.pathname + window.location.search).toBe("/search");
    // It adds no entry. A second push here is what left the card one Back beneath the page.
    expect(window.history.length).toBe(opened);

    const left = new Promise<void>((resolve) =>
      window.addEventListener("popstate", () => resolve(), { once: true }),
    );
    window.history.back();
    await left;

    // The page beneath Search, not the card again.
    expect(window.location.pathname + window.location.search).toBe("/decks");
    expect(await screen.findByRole("heading", { level: 1, name: "Decks" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("the card sheet", () => {
  it("says so when the card cannot be read", async () => {
    renderPhone(<PhoneFace />, { path: "/search?card=no-such-card" });
    const sheet = await screen.findByRole("dialog");
    expect(await within(sheet).findByRole("alert")).toBeInTheDocument();
  });
});

describe("Decks", () => {
  it("lists the reader's decks", async () => {
    renderPhone(<PhoneFace />, { path: "/decks" });
    const list = await screen.findByRole("list", { name: "Your decks" });
    await waitFor(() => expect(within(list).getAllByRole("button").length).toBeGreaterThan(0), SETTLE);
    // The whole computed name, never its two halves apart: a name and a caption with nothing
    // between them read as `Modern GoodstuffModern · 60 cards`, and each half is still found.
    expect(within(list).getAllByRole("button")[0]).toHaveAccessibleName(
      /^Modern Goodstuff Modern · \d+ cards$/,
    );
  });

  it("opens a deck as a wall of its cards, with the deck's name as the title", async () => {
    renderPhone(<PhoneFace />, { path: "/decks" });
    const list = await screen.findByRole("list", { name: "Your decks" });
    const first = await waitFor(() => within(list).getAllByRole("button")[0], SETTLE);
    const name = first.firstElementChild?.textContent ?? "";
    // An empty name would be matched by the heading the page draws before the deck has answered.
    expect(name).not.toBe("");

    await userEvent.click(first);

    expect(window.location.pathname).toMatch(/^\/decks\/\d+$/);
    const wall = await screen.findByRole("list", { name: "Cards in this deck" }, SETTLE);
    await waitFor(() => expect(within(wall).getAllByRole("button").length).toBeGreaterThan(0), SETTLE);
    expect(screen.getByRole("heading", { level: 2, name })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Back to decks" })).toBeInTheDocument();
  });

  it("says so when the deck is gone", async () => {
    renderPhone(<PhoneFace />, { path: "/decks/999999" });
    expect(await screen.findByText("That deck is gone.", undefined, SETTLE)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Back to decks" }));
    expect(window.location.pathname).toBe("/decks");
  });

  it("says so, and offers nothing, when there are no decks", async () => {
    renderPhone(<PhoneFace />, { path: "/decks", fake: { seed: "empty" } });
    expect(await screen.findByText("No decks", undefined, SETTLE)).toBeInTheDocument();
  });
});

describe("Collection", () => {
  it("draws the reader's cards", async () => {
    renderPhone(<PhoneFace />, { path: "/collection" });
    const wall = await screen.findByRole("list", { name: "Your collection" });
    await waitFor(() => expect(within(wall).getAllByRole("button").length).toBeGreaterThan(0), SETTLE);
  });

  it("says so when the collection is empty", async () => {
    renderPhone(<PhoneFace />, { path: "/collection", fake: { seed: "empty" } });
    expect(await screen.findByText("Nothing in your collection yet.", undefined, SETTLE)).toBeInTheDocument();
  });
});

describe("Wishlist", () => {
  it("draws the reader's wishes", async () => {
    renderPhone(<PhoneFace />, { path: "/wishlist" });
    const wall = await screen.findByRole("list", { name: "Your wishlist" });
    await waitFor(() => expect(within(wall).getAllByRole("button").length).toBeGreaterThan(0), SETTLE);
  });

  it("says so when the wishlist is empty", async () => {
    renderPhone(<PhoneFace />, { path: "/wishlist", fake: { seed: "empty" } });
    expect(await screen.findByText("Nothing on your wishlist yet.", undefined, SETTLE)).toBeInTheDocument();
  });
});

describe("Scanner and Settings", () => {
  it("says what is coming, and opens no camera", () => {
    renderPhone(<PhoneFace />, { path: "/scanner" });
    expect(screen.getByText(/The scanner arrives in a later phase/)).toBeInTheDocument();
  });

  it("names the edition", () => {
    renderPhone(<PhoneFace />, { path: "/settings" });
    expect(screen.getByText(/light edition/i)).toBeInTheDocument();
  });
});
