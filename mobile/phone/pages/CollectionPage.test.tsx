import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("../../../.storybook/fake/core"));
vi.mock("@tauri-apps/api/event", () => import("../../../.storybook/fake/event"));
vi.mock("@tauri-apps/api/window", () => import("../../../.storybook/fake/window"));

import { registerCommands } from "../../../.storybook/fake/core";
import { ipc } from "@/lib/ipc";
import { PhoneFace } from "../PhoneApp";
import { installLayout, renderPhone } from "../testing";

/** Long enough for a fake round trip and the census, the counts and the first page behind it. */
const SETTLE = { timeout: 3000 };

/**
 * A scroller tall enough that the virtualiser draws every row of the `starter` cabinet — so a test
 * about the order of the shelves sees all of them. `installLayout`'s 600px is put back after each
 * test, which is what the paging test below needs: a wall with rows below the fold.
 */
const tallViewport = () =>
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, value: 6000 });

beforeEach(installLayout);
afterEach(installLayout);

const refused = () =>
  vi.fn(() => {
    throw new Error("database is locked");
  });

const tab = (name: string) =>
  within(screen.getByRole("navigation", { name: "Views" })).getByRole("link", { name });

/** The cabinet, once its shelves are laid out — Not sorted's heading is the first thing drawn. */
async function cabinet() {
  const wall = await screen.findByRole("region", { name: "Your collection" }, SETTLE);
  await within(wall).findByRole("heading", { name: "Not sorted" }, SETTLE);
  return wall;
}

/** Every heading on the wall, as `level:name` — the level a screen reader announces and the name
 *  it reads, so the order and the nesting are asserted together. */
const headings = (wall: HTMLElement) =>
  within(wall)
    .getAllByRole("heading")
    .map((h) => {
      const level = h.getAttribute("aria-level") ?? h.tagName.slice(1);
      return `${level}:${h.getAttribute("aria-label") ?? h.textContent?.trim()}`;
    });

describe("Collection", () => {
  it("draws the cabinet's shelves in the desktop's order, the deck groups under Decks", async () => {
    tallViewport();
    renderPhone(<PhoneFace />, { path: "/collection" });
    const wall = await cabinet();

    expect(headings(wall)).toEqual([
      "2:Your collection",
      "3:Not sorted",
      "3:Binder",
      "4:Trade binder",
      "3:Someday",
      "3:Decks",
      "4:Kenrith Two-Drops",
      "4:Modern Goodstuff",
      "4:Old School 93/94",
      "4:Rhystic Testbed",
      "4:Recently removed",
    ]);
  });

  it("states the collection's figures above the shelves", async () => {
    renderPhone(<PhoneFace />, { path: "/collection" });
    const wall = await cabinet();
    // Every copy the cabinet covers, a deck's own included — not only the open shelves'.
    expect(await within(wall).findByText("21", undefined, SETTLE)).toBeInTheDocument();
    expect(within(wall).getByText("Value (USD)")).toBeInTheDocument();
  });

  it("folds two grades of one printing into one tile, counting both", async () => {
    renderPhone(<PhoneFace />, { path: "/collection" });
    const wall = await cabinet();
    const unsorted = await within(wall).findByRole("list", { name: "Not sorted" }, SETTLE);
    expect(
      within(unsorted).getAllByRole("button", {
        name: "Lightning Bolt, STA 105, Etched, 2 copies",
      }),
    ).toHaveLength(1);
    expect(
      within(unsorted).getByRole("button", { name: "Lightning Bolt, 2X2 117, 4 copies" }),
    ).toBeInTheDocument();
  });

  it("says where each card stands in its shelf, not in the wall's rows", async () => {
    renderPhone(<PhoneFace />, { path: "/collection" });
    const wall = await cabinet();
    const unsorted = await within(wall).findByRole("list", { name: "Not sorted" }, SETTLE);
    const items = await within(unsorted).findAllByRole("listitem");
    // Four tiles on two rows of two: each says four, and its own place among them.
    expect(items.map((item) => item.getAttribute("aria-setsize"))).toEqual(["4", "4", "4", "4"]);
    expect(items.map((item) => item.getAttribute("aria-posinset"))).toEqual(["1", "2", "3", "4"]);
  });

  it("opens a shut shelf on a press of its heading, and draws its cards there", async () => {
    tallViewport();
    const writes = vi.fn();
    renderPhone(<PhoneFace />, { path: "/collection" });
    registerCommands({ set_shelf_folds: writes });
    const wall = await cabinet();
    const heading = within(wall).getByRole("button", { name: "Modern Goodstuff" });
    expect(heading).toHaveAttribute("aria-expanded", "false");
    expect(within(wall).queryByRole("list", { name: "Modern Goodstuff" })).toBeNull();

    await userEvent.click(heading);

    const shelf = await within(wall).findByRole("list", { name: "Modern Goodstuff" }, SETTLE);
    expect(
      await within(shelf).findByRole("button", { name: "Counterspell, MH2 267, 2 copies" }, SETTLE),
    ).toBeInTheDocument();
    expect(within(wall).getByRole("button", { name: "Modern Goodstuff" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    // The phone folds in place and stores nothing: the desktop's folds are the reader's.
    expect(writes).not.toHaveBeenCalled();
  });

  it("shuts an open shelf on a press, and its cards go", async () => {
    renderPhone(<PhoneFace />, { path: "/collection" });
    const wall = await cabinet();
    await within(wall).findByRole("list", { name: "Not sorted" }, SETTLE);

    await userEvent.click(within(wall).getByRole("button", { name: "Not sorted" }));

    await waitFor(() =>
      expect(within(wall).queryByRole("list", { name: "Not sorted" })).toBeNull(),
    );
    expect(within(wall).getByRole("button", { name: "Not sorted" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("goes into a folder and back out by the path row", async () => {
    renderPhone(<PhoneFace />, { path: "/collection" });
    const wall = await cabinet();
    expect(screen.queryByRole("navigation", { name: "Collection folders" })).toBeNull();

    await userEvent.click(within(wall).getByRole("button", { name: "Open Binder" }));

    const path = await screen.findByRole("navigation", { name: "Collection folders" }, SETTLE);
    expect(within(path).getByText("Binder")).toHaveAttribute("aria-current", "page");
    // The folder's own cards head the level with no heading — the path row names them — and its
    // sub-folder is a shelf beneath them. Not sorted is not in this folder.
    const inside = screen.getByRole("region", { name: "Your collection" });
    expect(
      await within(inside).findByRole("button", { name: "Lightning Bolt, LEA 161" }, SETTLE),
    ).toBeInTheDocument();
    expect(within(inside).getByRole("heading", { name: "Trade binder" })).toBeInTheDocument();
    expect(within(inside).queryByRole("heading", { name: "Not sorted" })).toBeNull();
    // A level is not a place in the URL; Back leaves the view, not the folder.
    expect(window.location.pathname).toBe("/collection");

    await userEvent.click(within(path).getByRole("button", { name: "Up to Collection" }));

    expect(
      await within(await cabinet()).findByRole("heading", { name: "Binder" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Collection folders" })).toBeNull();
  });

  it("goes into a deck's own group, which starts shut at the root", async () => {
    tallViewport();
    renderPhone(<PhoneFace />, { path: "/collection" });
    const wall = await cabinet();

    await userEvent.click(within(wall).getByRole("button", { name: "Open Modern Goodstuff" }));

    const inside = await screen.findByRole("list", { name: "Modern Goodstuff" }, SETTLE);
    expect(
      await within(inside).findByRole("button", { name: /^Ragavan, Nimble Pilferer, MH2 138/ }),
    ).toBeInTheDocument();
  });

  it("links a deck's group to its deck", async () => {
    tallViewport();
    renderPhone(<PhoneFace />, { path: "/collection" });
    const wall = await cabinet();
    const link = within(wall).getByRole("link", { name: "Open the deck Modern Goodstuff" });
    expect(link).toHaveAttribute("href", "/decks/1");
    // Recently removed is the app's but is no deck's, and a reader's folder is neither.
    expect(within(wall).queryByRole("link", { name: /Recently removed/ })).toBeNull();
    expect(within(wall).queryByRole("link", { name: /Binder/ })).toBeNull();
  });

  it("marks a drawer the reader set aside, and draws an empty one as a box", async () => {
    tallViewport();
    renderPhone(<PhoneFace />, { path: "/collection" });
    const wall = await cabinet();
    const someday = within(wall).getByRole("button", { name: "Someday" });
    expect(someday).toHaveAccessibleDescription("Locked · 0 cards");
    expect(within(wall).getByText("Empty.")).toBeInTheDocument();
  });

  it("asks for the next page as the reader nears the frames not yet loaded", async () => {
    const list = vi.spyOn(ipc, "collectionList");
    renderPhone(<PhoneFace />, { path: "/collection", fake: { seed: "large" } });
    const wall = await cabinet();
    await within(wall).findByRole("list", { name: "Not sorted" }, SETTLE);
    expect(list.mock.calls.map(([q]) => q.offset)).toEqual([0]);

    // The shelf is as tall as its count says, so its far end is there to scroll to before a
    // second page exists — and reaching it is what asks for one.
    fireEvent.scroll(wall, { target: { scrollTop: 1_000_000 } });

    await waitFor(() => expect(list.mock.calls.map(([q]) => q.offset)).toContain(100), SETTLE);
    list.mockRestore();
  });

  it("narrows the cabinet through the Filters sheet, offering the collection's own cells", async () => {
    renderPhone(<PhoneFace />, { path: "/collection" });
    const wall = await cabinet();
    await within(wall).findByRole("list", { name: "Not sorted" }, SETTLE);

    await userEvent.click(screen.getByRole("button", { name: "Filters" }));
    const sheet = await screen.findByRole("dialog", { name: "Filters" });
    // The copy's own questions are here; the card search's that a binder cannot ask are not.
    expect(within(sheet).getByRole("group", { name: "Condition" })).toBeInTheDocument();
    expect(within(sheet).getByRole("heading", { name: "Needs review" })).toBeInTheDocument();
    expect(within(sheet).getByRole("heading", { name: "Price (USD)" })).toBeInTheDocument();
    expect(within(sheet).queryByRole("heading", { name: "Owned" })).toBeNull();
    expect(within(sheet).queryByRole("heading", { name: "Printings" })).toBeNull();

    await userEvent.click(
      within(within(sheet).getByRole("group", { name: "Finish" })).getByRole("button", {
        name: "Etched",
      }),
    );
    await userEvent.click(within(sheet).getByRole("button", { name: /^Show / }));

    // One kind on: the badge says so, the line states it, and the wall holds the etched copies.
    expect(screen.getByRole("button", { name: "Filters — 1 active" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Remove filter — Finish/ })).toBeInTheDocument();
    await waitFor(
      () =>
        expect(
          within(wall).queryByRole("button", { name: "Lightning Bolt, 2X2 117, 4 copies" }),
        ).toBeNull(),
      SETTLE,
    );
    expect(
      within(wall).getByRole("button", { name: "Lightning Bolt, STA 105, Etched, 2 copies" }),
    ).toBeInTheDocument();
  });

  it("searches the collection from its own box", async () => {
    renderPhone(<PhoneFace />, { path: "/collection" });
    const wall = await cabinet();

    await userEvent.type(
      screen.getByRole("searchbox", { name: "Search your collection" }),
      "tarmogoyf",
    );

    await waitFor(
      () =>
        expect(within(wall).queryByRole("button", { name: /^Lightning Bolt, 2X2 117/ })).toBeNull(),
      SETTLE,
    );
    expect(within(wall).getByRole("button", { name: /^Tarmogoyf, FUT 153/ })).toBeInTheDocument();
  });

  it("says a refused next page at the end of the wall, and Try again asks for it again", async () => {
    renderPhone(<PhoneFace />, { path: "/collection", fake: { seed: "large" } });
    const wall = await cabinet();
    await within(wall).findByRole("list", { name: "Not sorted" }, SETTLE);
    const real = ipc.collectionList;
    let refusing = true;
    const list = vi.spyOn(ipc, "collectionList").mockImplementation(async (query) => {
      if (refusing) throw new Error("database is locked");
      return real(query);
    });

    fireEvent.scroll(wall, { target: { scrollTop: 1_000_000 } });

    const retry = await screen.findByRole("button", { name: "Try again" }, SETTLE);
    expect(screen.getByText("The next cards could not be read.")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    const asked = list.mock.calls.length;

    refusing = false;
    await userEvent.click(retry);

    await waitFor(
      () => expect(screen.queryByRole("button", { name: "Try again" })).toBeNull(),
      SETTLE,
    );
    expect(list.mock.calls.length).toBeGreaterThan(asked);
    list.mockRestore();
  });

  it("says so when the collection is empty", async () => {
    renderPhone(<PhoneFace />, { path: "/collection", fake: { seed: "empty" } });
    expect(
      await screen.findByText("Nothing in your collection yet.", undefined, SETTLE),
    ).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Your collection" })).toBeNull();
  });

  it("says so when the collection cannot be read", async () => {
    renderPhone(<PhoneFace />, { path: "/scanner" });
    registerCommands({ collection_list: refused() });

    await userEvent.click(tab("Collection"));

    expect(await screen.findByRole("alert", undefined, SETTLE)).toHaveTextContent(
      "Your collection could not be read.",
    );
  });

  it("says so when the shelves cannot be counted, rather than drawing a wall that never comes", async () => {
    renderPhone(<PhoneFace />, { path: "/scanner" });
    registerCommands({ collection_shelf_counts: refused() });

    await userEvent.click(tab("Collection"));

    expect(await screen.findByRole("alert", undefined, SETTLE)).toHaveTextContent(
      "Your collection's shelves could not be read.",
    );
    expect(screen.queryByText("Nothing in your collection yet.")).toBeNull();
  });
});
