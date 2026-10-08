import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("../../../../packages/fake/core"));
vi.mock("@tauri-apps/api/event", () => import("../../../../packages/fake/event"));
vi.mock("@tauri-apps/api/window", () => import("../../../../packages/fake/window"));

import { registerCommands, type CommandHandler } from "../../../../packages/fake/core";
import { activeScope } from "../../../../packages/fake/scope";
import { ipc } from "@/lib/ipc";
import { PhoneFace } from "../PhoneApp";
import { installLayout, renderPhone } from "../testing";

beforeAll(installLayout);

/** Long enough for the search box's 300ms debounce and a fake round trip. */
const SETTLE = { timeout: 3000 };

const refused = () =>
  vi.fn(() => {
    throw new Error("database is locked");
  });

const tab = (name: string) =>
  within(screen.getByRole("navigation", { name: "Views" })).getByRole("link", { name });

/** The page's Filters control, whatever its count says. */
const filtersButton = () => screen.getByRole("button", { name: /^Filters/ });

/** The wall's tiles, by name — read fresh, since the wall redraws under every filter. */
const tiles = () =>
  within(screen.getByRole("list", { name: "Search results" }))
    .getAllByRole("button")
    .map((b) => b.getAttribute("aria-label") ?? "");

/** Search, with a wall drawn and the sheet open over it. Returns how many tiles it drew first. */
async function openSheet(): Promise<{ sheet: HTMLElement; before: number }> {
  renderPhone(<PhoneFace />, { path: "/search" });
  await screen.findByRole("list", { name: "Search results" });
  const before = await waitFor(() => {
    const n = tiles().length;
    expect(n).toBeGreaterThan(0);
    return n;
  }, SETTLE);
  await userEvent.click(filtersButton());
  return { sheet: await screen.findByRole("dialog", { name: "Filters" }), before };
}

describe("the Filters button", () => {
  it("says how many filters are on, in its name and on its badge", async () => {
    const { sheet } = await openSheet();
    // `Red` and not `Red — 12 printings`: the facet count is in the name once it has answered.
    await userEvent.click(within(sheet).getByRole("button", { name: /^Red\b/ }));
    await userEvent.click(within(sheet).getByRole("button", { name: /^Mythic\b/ }));
    await userEvent.click(within(sheet).getByRole("button", { name: /^(Show|No cards)/ }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const button = filtersButton();
    // The whole name: the badge is hidden from a screen reader, so the name is the count's only
    // way there.
    expect(button).toHaveAccessibleName("Filters — 2 active");
    expect(within(button).getByText("2")).toHaveAttribute("aria-hidden", "true");
  });

  it("draws no badge while nothing is on", async () => {
    renderPhone(<PhoneFace />, { path: "/search" });
    expect(filtersButton()).toHaveAccessibleName("Filters");
    expect(within(filtersButton()).queryByText(/\d/)).toBeNull();
  });

  // The first phone run, 2026-10-04: a typed query lit the button `Filters — 1 active` over a
  // sheet with nothing chosen in it. The box is beside the button, not in the sheet.
  it("does not count the query in the box, which is not in the sheet", async () => {
    renderPhone(<PhoneFace />, { path: "/search" });
    const box = screen.getByRole("searchbox", { name: "Search cards" });
    await userEvent.type(box, "bolt");

    expect(filtersButton()).toHaveAccessibleName("Filters");
    expect(within(filtersButton()).queryByText(/\d/)).toBeNull();
    await userEvent.click(filtersButton());
    const sheet = await screen.findByRole("dialog", { name: "Filters" });
    expect(within(sheet).getByRole("button", { name: /^Reset all/ })).toHaveAccessibleName(
      "Reset all — 0 filters active",
    );
  });
});

describe("the filters sheet", () => {
  it("narrows the wall behind it as a chip is pressed, and its button says by how much", async () => {
    const { sheet, before } = await openSheet();

    await userEvent.click(within(sheet).getByRole("button", { name: /^Mythic\b/ }));

    // Live: the wall under the scrim answers the press without the sheet being closed.
    await waitFor(() => expect(tiles().length).toBeLessThan(before), SETTLE);
    expect(within(sheet).getByRole("button", { name: /^Mythic\b/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    const shown = tiles().length;
    expect(within(sheet).getByRole("button", { name: /^Show / })).toHaveTextContent(
      new RegExp(`^Show ${shown} cards?$`),
    );
  });

  it("narrows by colour, and Reset all puts every filter back", async () => {
    const { sheet, before } = await openSheet();
    await userEvent.click(within(sheet).getByRole("button", { name: /^Blue\b/ }));
    await userEvent.click(within(sheet).getByRole("button", { name: /^Instant\b/ }));
    await waitFor(() => expect(tiles().length).toBeLessThan(before), SETTLE);

    await userEvent.click(within(sheet).getByRole("button", { name: /^Reset all — 2 filters/ }));

    await waitFor(() => expect(tiles().length).toBe(before), SETTLE);
    expect(within(sheet).getByRole("button", { name: /^Blue\b/ })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    // At zero it stays drawn, greyed — a control that came and went would move the footer.
    expect(within(sheet).getByRole("button", { name: /^Reset all — 0 filters/ })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });

  it("resets what the sheet holds and leaves the query in the box beside it", async () => {
    renderPhone(<PhoneFace />, { path: "/search" });
    const box = screen.getByRole("searchbox", { name: "Search cards" });
    await userEvent.type(box, "bolt");
    await userEvent.click(filtersButton());
    const sheet = await screen.findByRole("dialog", { name: "Filters" });
    await userEvent.click(within(sheet).getByRole("button", { name: /^Red\b/ }));

    // One kind in the sheet, and the word in the box is not a second.
    await userEvent.click(within(sheet).getByRole("button", { name: /^Reset all — 1 filter / }));

    expect(within(sheet).getByRole("button", { name: /^Red\b/ })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(within(sheet).getByRole("button", { name: /^Reset all — 0 filters/ })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(box).toHaveValue("bolt");
  });

  it("is not a place: opening it writes no history, and Escape hands the caret back", async () => {
    renderPhone(<PhoneFace />, { path: "/search" });
    const length = window.history.length;

    await userEvent.click(filtersButton());
    await screen.findByRole("dialog", { name: "Filters" });
    expect(window.location.pathname + window.location.search).toBe("/search");
    expect(window.history.length).toBe(length);

    await userEvent.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(filtersButton()).toHaveFocus();
    expect(window.history.length).toBe(length);
  });

  it("offers Any card, because this search narrows to playable cards under every other row", async () => {
    const { sheet } = await openSheet();
    await userEvent.click(within(sheet).getByRole("button", { name: "Format" }));
    expect(await screen.findByRole("option", { name: /Any card/ })).toBeInTheDocument();
  });
});

describe("the stated filters", () => {
  it("draw nothing over an unfiltered search", async () => {
    renderPhone(<PhoneFace />, { path: "/search" });
    await screen.findByRole("list", { name: "Search results" });
    expect(screen.queryByRole("button", { name: /^Remove filter/ })).toBeNull();
  });

  it("state each kind as a chip whose ✕ clears that kind alone", async () => {
    const { sheet, before } = await openSheet();
    await userEvent.click(within(sheet).getByRole("button", { name: /^Red\b/ }));
    await userEvent.click(within(sheet).getByRole("button", { name: /^Green\b/ }));
    await userEvent.click(within(sheet).getByRole("button", { name: /^Rare\b/ }));
    await userEvent.click(within(sheet).getByRole("button", { name: "Close filters" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(tiles().length).toBeLessThan(before), SETTLE);

    // Two colours are one kind and one chip, which is one off the badge when it goes.
    await userEvent.click(
      screen.getByRole("button", { name: "Remove filter — Color: Red, Green" }),
    );

    expect(screen.queryByRole("button", { name: /^Remove filter — Color/ })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Remove filter — Rarity: Rare" }),
    ).toBeInTheDocument();
    expect(filtersButton()).toHaveAccessibleName("Filters — 1 active");
  });
});

describe("a refused next page", () => {
  it("says so at the end of the wall, and Try again asks for it again", async () => {
    // `large` is the one seed whose search runs past a page.
    renderPhone(<PhoneFace />, { path: "/search", fake: { seed: "large" } });
    const wall = await screen.findByRole("list", { name: "Search results" });
    await waitFor(
      () => expect(within(wall).getAllByRole("button").length).toBeGreaterThan(0),
      SETTLE,
    );
    const scroller = wall.parentElement as HTMLElement;

    // The fake's own handler, wrapped: refused while `refusing`, answered once it is not.
    const real = activeScope().commands.search_cards as CommandHandler;
    let refusing = true;
    const search = vi.fn((args: unknown) => {
      if (refusing) throw new Error("database is locked");
      return (real as (a: unknown) => unknown)(args);
    });
    registerCommands({ search_cards: search });

    fireEvent.scroll(scroller, { target: { scrollTop: 1_000_000 } });

    const retry = await screen.findByRole("button", { name: "Try again" }, SETTLE);
    expect(screen.getByText("The next cards could not be read.")).toBeInTheDocument();
    // An answer about the page after the wall, not about the wall: no alert, and the cards stay.
    expect(screen.queryByRole("alert")).toBeNull();
    expect(within(wall).getAllByRole("button").length).toBeGreaterThan(0);
    const asked = search.mock.calls.length;

    refusing = false;
    await userEvent.click(retry);

    await waitFor(
      () => expect(screen.queryByRole("button", { name: "Try again" })).toBeNull(),
      SETTLE,
    );
    expect(search.mock.calls.length).toBeGreaterThan(asked);
    expect(screen.queryByText("The next cards could not be read.")).toBeNull();
  });
});

describe("a figure that cannot be read over an empty wall", () => {
  it("is said on the collection, under shelves that still say what they hold", async () => {
    renderPhone(<PhoneFace />, { path: "/scanner" });
    // Everything off the open shelves, so only the deck groups — shut — hold anything. Since the
    // cabinet (step 3.2) the shelf counts say that, and the figure alone is what is missing.
    await ipc.collectionRemoveMany([1, 2, 3, 6, 8, 9, 10, 11, 12]);
    registerCommands({ collection_summary: refused() });

    await userEvent.click(tab("Collection"));

    expect(await screen.findByRole("alert", undefined, SETTLE)).toHaveTextContent(
      "Your collection's figures could not be read.",
    );
    expect(screen.getByRole("heading", { name: "Not sorted" })).toBeInTheDocument();
    expect(screen.queryByText("Nothing in your collection yet.")).toBeNull();
  });

  it("is said on the wishlist, where the shelf counts are the figure", async () => {
    renderPhone(<PhoneFace />, { path: "/scanner" });
    for (const id of [1, 2, 3, 4, 5, 6, 7, 8]) await ipc.wishlistRemove(id);
    registerCommands({ wishlist_shelf_counts: refused() });

    await userEvent.click(tab("Wishlist"));

    // The cabinet (step 3.3) is laid out from those counts, so without them it says so rather
    // than drawing shelves it cannot size.
    expect(await screen.findByRole("alert", undefined, SETTLE)).toHaveTextContent(
      "Your wishlist's shelves could not be read.",
    );
    expect(screen.queryByText("Nothing on your wishlist yet.")).toBeNull();
  });
});
