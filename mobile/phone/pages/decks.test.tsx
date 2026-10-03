import type { ReactNode } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("../../../.storybook/fake/core"));
vi.mock("@tauri-apps/api/event", () => import("../../../.storybook/fake/event"));
vi.mock("@tauri-apps/api/window", () => import("../../../.storybook/fake/window"));

import { registerCommands } from "../../../.storybook/fake/core";
import { deckDetailKey } from "@/features/decks/deckQuery";
import { ipc, type DeckDetail } from "@/lib/ipc";
import { DEFAULT_MARKETPLACE } from "@/lib/marketplace";
import { PhoneFace } from "../PhoneApp";
import { installLayout, renderPhone } from "../testing";

beforeAll(installLayout);

/** Long enough for a fake round trip and the reads that follow it. */
const SETTLE = { timeout: 3000 };

/**
 * The starter seed's decks, as these tests lean on them. Deck 2 is a Commander deck with a
 * commander and a companion at the root. Deck 4 is filed two folders deep (`Constructed` ▸
 * `Commander`), keeps a plan and was last looked at on Theory, and carries the seed's two deck
 * notes and a to-do list. Deck 3 is archived at the root.
 */
const KENRITH = 2;
const TESTBED = 4;

const refused = () =>
  vi.fn(() => {
    throw new Error("database is locked");
  });

const tab = (name: string) =>
  within(screen.getByRole("navigation", { name: "Views" })).getByRole("link", { name });

/** Every labelled section on the page, in document order, by name — the piles and the rail. */
const regions = (): string[] =>
  screen.getAllByRole("region").map((region) => {
    const id = region.getAttribute("aria-labelledby");
    return id === null ? "" : (document.getElementById(id)?.textContent ?? "");
  });

describe("the deck gallery", () => {
  it("draws the decks at the top level as covers, each a link to its own page", async () => {
    renderPhone(<PhoneFace />, { path: "/decks" });
    const wall = await screen.findByRole("list", { name: "Your decks" }, SETTLE);
    const first = await waitFor(() => within(wall).getAllByRole("link")[0], SETTLE);
    // The name first and whole — the marks over the art are not inside the link — then the
    // colours, then the caption, with a space between each.
    expect(first).toHaveAccessibleName(/^Modern Goodstuff .*Modern · 60 cards$/);
    expect(first).toHaveAttribute("href", "/decks/1");
    // The filed deck is not on the top-level wall, and the archived one is not drawn until asked.
    expect(within(wall).queryByRole("link", { name: /^Rhystic Testbed/ })).toBeNull();
    expect(within(wall).queryByRole("link", { name: /^Old School/ })).toBeNull();
  });

  it("credits the illustrator of a cover in words on the picture", async () => {
    renderPhone(<PhoneFace />, { path: "/decks" });
    await screen.findByRole("list", { name: "Your decks" }, SETTLE);
    expect(await screen.findAllByText(/^Art by /, undefined, SETTLE)).not.toHaveLength(0);
  });

  it("draws the bracket reading on a Commander deck's cover, and none on a Modern one", async () => {
    renderPhone(<PhoneFace />, { path: "/decks" });
    const wall = await screen.findByRole("list", { name: "Your decks" }, SETTLE);
    const kenrith = (await within(wall).findByRole("link", { name: /^Kenrith Two-Drops/ }, SETTLE))
      .parentElement as HTMLElement;
    expect(
      await within(kenrith).findByText(/^Bracket ~?\d$/, undefined, SETTLE),
    ).toBeInTheDocument();
    const modern = within(wall).getByRole("link", { name: /^Modern Goodstuff/ })
      .parentElement as HTMLElement;
    expect(within(modern).queryByText(/^Bracket/)).toBeNull();
  });

  it("walks into a folder and back out by links, with the folder in the address", async () => {
    renderPhone(<PhoneFace />, { path: "/decks" });
    const folders = await screen.findByRole("list", { name: "Folders" }, SETTLE);
    const constructed = within(folders).getByRole("link", { name: /^Constructed/ });
    expect(constructed).toHaveAttribute("href", "/decks?folder=1");

    await userEvent.click(constructed);
    expect(window.location.search).toBe("?folder=1");
    expect(screen.getByRole("heading", { level: 2, name: "Constructed" })).toBeInTheDocument();
    await userEvent.click(
      within(screen.getByRole("list", { name: "Folders" })).getByRole("link", {
        name: /^Commander/,
      }),
    );

    expect(window.location.search).toBe("?folder=2");
    const wall = await screen.findByRole("list", { name: "Decks in Commander" }, SETTLE);
    expect(within(wall).getByRole("link", { name: /^Rhystic Testbed/ })).toHaveAttribute(
      "href",
      "/decks/4",
    );
    // One level up, not to the top: the way out of a drawer is its parent.
    expect(screen.getByRole("link", { name: "Up one folder" })).toHaveAttribute(
      "href",
      "/decks?folder=1",
    );
  });

  it("reads a folder the cabinet does not hold as the top level", async () => {
    renderPhone(<PhoneFace />, { path: "/decks?folder=999" });
    expect(await screen.findByRole("list", { name: "Your decks" }, SETTLE)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 2 })).toBeNull();
  });

  it("keeps the archived decks behind a disclosure", async () => {
    renderPhone(<PhoneFace />, { path: "/decks" });
    const disclosure = await screen.findByRole("button", { name: /^Archived/ }, SETTLE);
    expect(disclosure).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("list", { name: "Archived decks" })).toBeNull();

    await userEvent.click(disclosure);

    const archived = screen.getByRole("list", { name: "Archived decks" });
    expect(within(archived).getByRole("link", { name: /^Old School 93\/94/ })).toHaveAttribute(
      "href",
      "/decks/3",
    );
  });

  it("says so when the decks cannot be read", async () => {
    renderPhone(<PhoneFace />, { path: "/scanner" });
    registerCommands({ deck_list: refused() });

    await userEvent.click(tab("Decks"));

    expect(await screen.findByRole("alert")).toHaveTextContent("Your decks could not be read.");
  });

  it("says so, and offers nothing, when there are no decks", async () => {
    renderPhone(<PhoneFace />, { path: "/decks", fake: { seed: "empty" } });
    expect(await screen.findByText("No decks", undefined, SETTLE)).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Your decks" })).toBeNull();
  });
});

describe("a deck", () => {
  it("draws the commander first, then the companion, then the deck's piles, then the rail", async () => {
    renderPhone(<PhoneFace />, { path: `/decks/${KENRITH}` });
    expect(
      await screen.findByRole("heading", { level: 2, name: "Kenrith Two-Drops" }, SETTLE),
    ).toBeInTheDocument();
    await screen.findByRole("region", { name: "Check" }, SETTLE);

    // The command zones head the column, the deck's piles follow in its own order with the ones
    // played beside it last, and then the rail in the desktop's order down the page. Deck 2
    // keeps no notes, so the rail has no Notes section; it has a to-do list.
    expect(regions()).toEqual([
      "Commander",
      "Companion",
      "Main deck",
      "Sideboard",
      "Maybeboard",
      "Check",
      "Bracket",
      "Tokens",
      "Mana curve",
      "To-do lists",
    ]);

    const commander = screen.getByRole("region", { name: "Commander" });
    expect(
      within(commander).getByRole("button", { name: /^Kenrith, the Returned King/ }),
    ).toBeInTheDocument();
  });

  it("draws a switched-off pile after the deck, and the notes and to-do lists after the check", async () => {
    renderPhone(<PhoneFace />, { path: `/decks/${TESTBED}` });
    await screen.findByRole("region", { name: "Notes" }, SETTLE);
    await screen.findByRole("region", { name: "To-do lists" }, SETTLE);
    const names = regions();
    expect(names[0]).toBe("Commander");
    expect(names.indexOf("Cut list")).toBeLessThan(names.indexOf("Check"));
    expect(names.indexOf("Ramp")).toBeLessThan(names.indexOf("Sideboard"));
    expect(names.indexOf("Notes")).toBeGreaterThan(names.indexOf("Check"));
    expect(names.indexOf("To-do lists")).toBe(names.indexOf("Notes") + 1);

    // A deck note, read-only: its title and its prose, and no Edit.
    const notes = screen.getByRole("region", { name: "Notes" });
    expect(
      within(notes).getByText("The two game changers, and why there is no third"),
    ).toBeInTheDocument();
    expect(within(notes).queryByRole("button", { name: /^Edit/ })).toBeNull();
    // A to-do list's boxes are said, not offered.
    const todos = screen.getByRole("region", { name: "To-do lists" });
    expect(within(todos).queryByRole("checkbox")).toBeNull();
    expect(within(todos).getByText("Sleeve the deck").parentElement).toHaveTextContent(
      /^Done: Sleeve the deck$/,
    );
  });

  it("opens on the list the deck remembers, and reads the other one when switched", async () => {
    renderPhone(<PhoneFace />, { path: `/decks/${TESTBED}` });
    const lists = await screen.findByRole("group", { name: "Deck list" }, SETTLE);
    const theory = within(lists).getByRole("button", { name: "Theory" });
    const actual = within(lists).getByRole("button", { name: "Actual" });
    expect(theory).toHaveAttribute("aria-pressed", "true");
    // Urza's Saga is in the plan and not in the deck.
    expect(await screen.findByRole("button", { name: /^Urza's Saga/ }, SETTLE)).toBeInTheDocument();

    await userEvent.click(actual);

    expect(actual).toHaveAttribute("aria-pressed", "true");
    await waitFor(
      () => expect(screen.queryByRole("button", { name: /^Urza's Saga/ })).toBeNull(),
      SETTLE,
    );
    expect(
      await screen.findByRole("button", { name: /^Sol Ring, 2 copies/ }, SETTLE),
    ).toBeInTheDocument();
  });

  it("draws no switch on a deck that keeps one list", async () => {
    renderPhone(<PhoneFace />, { path: `/decks/${KENRITH}` });
    await screen.findByRole("heading", { level: 2, name: "Kenrith Two-Drops" }, SETTLE);
    expect(screen.queryByRole("group", { name: "Deck list" })).toBeNull();
  });

  it("reads the deck under the desktop editor's own key", async () => {
    let client: QueryClient | null = null;
    function Probe(): ReactNode {
      client = useQueryClient();
      return null;
    }
    renderPhone(
      <>
        <PhoneFace />
        <Probe />
      </>,
      { path: `/decks/${TESTBED}` },
    );
    await screen.findByRole("heading", { level: 2, name: "Rhystic Testbed" }, SETTLE);
    const cached = (client as QueryClient | null)?.getQueryData<DeckDetail>(
      deckDetailKey(TESTBED, "theory", DEFAULT_MARKETPLACE),
    );
    expect(cached?.deck.id).toBe(TESTBED);
  });

  it("opens a card from its row", async () => {
    renderPhone(<PhoneFace />, { path: `/decks/${TESTBED}` });
    const row = await screen.findByRole("button", { name: /^Rhystic Study/ }, SETTLE);
    await userEvent.click(row);
    expect(new URLSearchParams(window.location.search).get("card")).not.toBeNull();
    expect(window.location.pathname).toBe(`/decks/${TESTBED}`);
  });

  it("opens a card from its name in the check's findings", async () => {
    renderPhone(<PhoneFace />, { path: `/decks/${TESTBED}` });
    const check = await screen.findByRole("region", { name: "Check" }, SETTLE);
    await userEvent.click(within(check).getByRole("button", { name: "Black Lotus" }));
    expect(new URLSearchParams(window.location.search).get("card")).not.toBeNull();
  });

  it("goes back to the folder the deck is filed in", async () => {
    renderPhone(<PhoneFace />, { path: `/decks/${TESTBED}` });
    await screen.findByRole("heading", { level: 2, name: "Rhystic Testbed" }, SETTLE);
    expect(screen.getByRole("link", { name: "Back to decks" })).toHaveAttribute(
      "href",
      "/decks?folder=2",
    );
  });

  it("says so when the deck has no cards", async () => {
    renderPhone(<PhoneFace />, { path: "/scanner" });
    const made = await ipc.deckCreate({ name: "Empty shell", formatKey: "modern" });
    await userEvent.click(tab("Decks"));
    await userEvent.click(await screen.findByRole("link", { name: /^Empty shell/ }, SETTLE));
    expect(window.location.pathname).toBe(`/decks/${made.id}`);
    expect(
      await screen.findByText("No cards in this deck yet.", undefined, SETTLE),
    ).toBeInTheDocument();
  });

  it("draws no title until the deck has a name to put in it, and says it is gone", async () => {
    renderPhone(<PhoneFace />, { path: "/decks/999999" });
    expect(await screen.findByText("That deck is gone.", undefined, SETTLE)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    // An empty heading is a stop a screen reader lands on and hears nothing at.
    expect(screen.queryByRole("heading", { level: 2 })).toBeNull();

    await userEvent.click(screen.getByRole("link", { name: "Back to decks" }));

    expect(window.location.pathname).toBe("/decks");
    expect(await screen.findByRole("list", { name: "Your decks" }, SETTLE)).toBeInTheDocument();
  });

  it("says the deck could not be read when the read fails, not that the deck is gone", async () => {
    renderPhone(<PhoneFace />, { path: "/scanner" });
    registerCommands({ deck_get: refused() });
    await userEvent.click(tab("Decks"));
    const wall = await screen.findByRole("list", { name: "Your decks" }, SETTLE);

    await userEvent.click(await waitFor(() => within(wall).getAllByRole("link")[0], SETTLE));

    expect(await screen.findByRole("alert")).toHaveTextContent("That deck could not be read.");
    expect(screen.queryByText("That deck is gone.")).toBeNull();
  });
});
