import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("../../../.storybook/fake/core"));
vi.mock("@tauri-apps/api/event", () => import("../../../.storybook/fake/event"));
vi.mock("@tauri-apps/api/window", () => import("../../../.storybook/fake/window"));

import { registerCommands } from "../../../.storybook/fake/core";
import { ipc } from "@/lib/ipc";
import { PhoneFace } from "../PhoneApp";
import { installLayout, renderPhone } from "../testing";

beforeAll(installLayout);

/** Long enough for the search box's 300ms debounce and a fake round trip. */
const SETTLE = { timeout: 3000 };

/**
 * The starter seed's first search result, and the reason no test here cuts a card's name out of
 * a tile's label: the name has a comma of its own, and a label ends in whatever the tile had to
 * say — a printing, then a finish, then a count. Tiles are named whole, from the seed.
 */
const AGADEEM = {
  id: "67f4c93b-080c-4196-b095-6a120a221988",
  name: "Agadeem's Awakening // Agadeem, the Undercrypt",
  tile: "Agadeem's Awakening // Agadeem, the Undercrypt, ZNR 90",
};

/**
 * A read the backend refuses — the fake's own way of overriding one command for the world on
 * screen. A function per call, so a test can count how often it was asked.
 */
const refused = () =>
  vi.fn(() => {
    throw new Error("database is locked");
  });

const tab = (name: string) =>
  within(screen.getByRole("navigation", { name: "Views" })).getByRole("link", { name });

describe("Search", () => {
  it("draws a wall of cards before anything is typed", async () => {
    renderPhone(<PhoneFace />, { path: "/search" });
    const wall = await screen.findByRole("list", { name: "Search results" });
    expect(await within(wall).findByRole("button", { name: AGADEEM.tile }, SETTLE)).toBeInTheDocument();
    // One the reader owns a single copy of: one copy is not a count worth saying.
    expect(within(wall).getByRole("button", { name: "Black Lotus, LEA 232" })).toBeInTheDocument();
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
    expect(screen.queryByRole("list", { name: "Search results" })).toBeNull();
  });

  it("says so when the search cannot be read at all", async () => {
    // From a page that asks nothing, so the refusal is in place before the first search is made.
    renderPhone(<PhoneFace />, { path: "/scanner" });
    registerCommands({ search_cards: refused() });

    await userEvent.click(tab("Search"));

    expect(await screen.findByRole("alert")).toHaveTextContent("The search could not be read.");
    expect(screen.queryByRole("list", { name: "Search results" })).toBeNull();
    // The box stays: the way out of a search that failed is another search.
    expect(screen.getByRole("searchbox", { name: "Search cards" })).toBeInTheDocument();
  });

  it("keeps the cards it has when a later page cannot be read, and does not ask again", async () => {
    // `large` is the one seed whose search runs past a page.
    renderPhone(<PhoneFace />, { path: "/search", fake: { seed: "large" } });
    const wall = await screen.findByRole("list", { name: "Search results" });
    await waitFor(() => expect(within(wall).getAllByRole("button").length).toBeGreaterThan(0), SETTLE);
    const scroller = wall.parentElement as HTMLElement;
    const search = refused();
    registerCommands({ search_cards: search });

    // To the end of what is loaded, which is where a wall asks for the next page.
    fireEvent.scroll(scroller, { target: { scrollTop: 1_000_000 } });
    await waitFor(() => expect(search).toHaveBeenCalledTimes(1), SETTLE);

    // The refusal is an answer about that page, not about the fifty cards already here.
    await waitFor(() => expect(within(wall).getAllByRole("button").length).toBeGreaterThan(0));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(wall).toBeInTheDocument();

    // Away from the end and back: the wall asks its page for more again, and a page that has
    // been refused once does not turn that into a request every time the reader scrolls.
    fireEvent.scroll(scroller, { target: { scrollTop: 0 } });
    await within(wall).findByRole("button", { name: AGADEEM.tile });
    fireEvent.scroll(scroller, { target: { scrollTop: 1_000_000 } });
    await waitFor(() => expect(within(wall).queryByRole("button", { name: AGADEEM.tile })).toBeNull());
    expect(search).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("opens a card over the wall, and Back closes it", async () => {
    renderPhone(<PhoneFace />, { path: "/search" });
    const wall = await screen.findByRole("list", { name: "Search results" });

    await userEvent.click(await within(wall).findByRole("button", { name: AGADEEM.tile }, SETTLE));

    expect(window.location.search).toMatch(/^\?card=/);
    const sheet = await screen.findByRole("dialog");
    expect(await within(sheet).findByRole("heading", { name: AGADEEM.name })).toBeInTheDocument();

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

  it("prints every face of a card that has two: its name, its cost and its words", async () => {
    // A modal double-faced card carries no rules text of its own; all of it is on its faces.
    renderPhone(<PhoneFace />, { path: `/search?card=${AGADEEM.id}` });
    const sheet = await screen.findByRole("dialog");

    expect(await within(sheet).findByText("Agadeem's Awakening")).toBeInTheDocument();
    expect(within(sheet).getByText("Agadeem, the Undercrypt")).toBeInTheDocument();
    expect(
      within(sheet).getByText(/Return from your graveyard to the battlefield any number of target/),
    ).toBeInTheDocument();
    expect(within(sheet).getByText(/As this land enters, you may pay 3 life/)).toBeInTheDocument();
    // The symbols, as a screen reader hears them. The front face costs `{X}{B}{B}{B}` and the
    // back costs nothing — so one X; and three B in that cost plus the one in the back face's
    // `{T}: Add {B}`, which is rules text drawn with its symbols rather than its braces.
    const said = (token: string) => within(sheet).getAllByText(token, { selector: ".sr-only" });
    expect(said("X")).toHaveLength(1);
    expect(said("B")).toHaveLength(4);
    expect(said("T")).toHaveLength(1);
    expect(within(sheet).queryByText(/\{T\}/)).toBeNull();
  });

  it("prints a one-faced card's words once, with no face name over them", async () => {
    renderPhone(<PhoneFace />, { path: "/search" });
    const wall = await screen.findByRole("list", { name: "Search results" });
    await userEvent.click(await within(wall).findByRole("button", { name: "Black Lotus, LEA 232" }, SETTLE));
    const sheet = await screen.findByRole("dialog");

    expect(await within(sheet).findByRole("heading", { name: "Black Lotus" })).toBeInTheDocument();
    expect(within(sheet).getByText(/Sacrifice/)).toBeInTheDocument();
    // The heading has said the name; a second "Black Lotus" in the body would read as a face.
    expect(within(sheet).getAllByText("Black Lotus")).toHaveLength(1);
  });
});

// Decks — the gallery and a deck — are `decks.test.tsx`'s.

describe("Wishlist", () => {
  it("draws the wishes on the reader's open shelves", async () => {
    renderPhone(<PhoneFace />, { path: "/wishlist" });
    const wall = await screen.findByRole("list", { name: "Your wishlist" });
    expect(await within(wall).findByRole("button", { name: "Sol Ring, any printing" }, SETTLE)).toBeInTheDocument();
    // The finish a wish asks for is part of what it is called.
    expect(
      within(wall).getByRole("button", { name: "Ragavan, Nimble Pilferer, MH2 138, Foil" }),
    ).toBeInTheDocument();
    // One printing wished for at the root and again in a folder: two wishes, one name.
    expect(within(wall).getAllByRole("button", { name: "Rhystic Study, PCY 45" })).toHaveLength(2);
  });

  it("says so when the wishlist is empty", async () => {
    renderPhone(<PhoneFace />, { path: "/wishlist", fake: { seed: "empty" } });
    expect(await screen.findByText("Nothing on your wishlist yet.", undefined, SETTLE)).toBeInTheDocument();
  });

  it("does not call a wishlist empty when every wish is on a folded shelf", async () => {
    renderPhone(<PhoneFace />, { path: "/scanner" });
    // The eight wishes the reader filed themselves. What is left is the five a deck manages,
    // in that deck's own folder — a shelf that starts shut.
    for (const id of [1, 2, 3, 4, 5, 6, 7, 8]) await ipc.wishlistRemove(id);

    await userEvent.click(tab("Wishlist"));

    expect(await screen.findByText(/on folded shelves/, undefined, SETTLE)).toBeInTheDocument();
    expect(screen.queryByText("Nothing on your wishlist yet.")).toBeNull();
  });

  it("says so when the wishlist cannot be read", async () => {
    renderPhone(<PhoneFace />, { path: "/scanner" });
    registerCommands({ wishlist_list: refused() });

    await userEvent.click(tab("Wishlist"));

    expect(await screen.findByRole("alert", undefined, SETTLE)).toHaveTextContent(
      "Your wishlist could not be read.",
    );
  });
});

// Settings has a suite of its own since step 3.7 — `SettingsPage.test.tsx`.
describe("Scanner", () => {
  it("says what is coming, and opens no camera", () => {
    renderPhone(<PhoneFace />, { path: "/scanner" });
    expect(screen.getByText(/The scanner arrives in a later phase/)).toBeInTheDocument();
  });
});
