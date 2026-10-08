import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("@grimoire/fake/core"));
vi.mock("@tauri-apps/api/event", () => import("@grimoire/fake/event"));
vi.mock("@tauri-apps/api/window", () => import("@grimoire/fake/window"));

import { registerCommands } from "@grimoire/fake/core";
import { MANAGED_EMPTY } from "@grimoire/ui/features/wishlist/managed";
import { ipc } from "@grimoire/ui/lib/ipc";
import { PhoneFace } from "../PhoneApp";
import { installLayout, renderPhone } from "../testing";

const SETTLE = { timeout: 3000 };

/** Every row of the `starter` wishlist drawn at once — `CollectionPage.test.tsx`'s reason. */
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

/** The cabinet, once its shelves are laid out. */
async function cabinet() {
  const wall = await screen.findByRole("region", { name: "Your wishlist" }, SETTLE);
  await within(wall).findByRole("heading", { name: "Not sorted" }, SETTLE);
  return wall;
}

const headings = (wall: HTMLElement) =>
  within(wall)
    .getAllByRole("heading")
    .map((h) => {
      const level = h.getAttribute("aria-level") ?? h.tagName.slice(1);
      return `${level}:${h.getAttribute("aria-label") ?? h.textContent?.trim()}`;
    });

/** The deck's managed folder, read as empty — the fake refuses every hand write to it, so the
 *  two reads that would show its wishes are narrowed instead. */
function emptyManagedFolder(folderId: number) {
  const counts = ipc.wishlistShelfCounts;
  const list = ipc.wishlistList;
  vi.spyOn(ipc, "wishlistShelfCounts").mockImplementation(async (query) =>
    (await counts(query)).filter((count) => count.folderId !== folderId),
  );
  vi.spyOn(ipc, "wishlistList").mockImplementation(async (query) => {
    const page = await list(query);
    return { ...page, items: page.items.filter((row) => row.folderId !== folderId) };
  });
}

afterEach(() => vi.restoreAllMocks());

describe("Wishlist", () => {
  it("draws the cabinet's shelves in order, a deck's list under Managed by decks", async () => {
    tallViewport();
    renderPhone(<PhoneFace />, { path: "/wishlist" });
    const wall = await cabinet();
    expect(headings(wall)).toEqual([
      "2:Your wishlist",
      "3:Not sorted",
      "3:Ordered",
      "4:Backordered",
      "3:Someday",
      "3:Managed by decks",
      "4:Rhystic Testbed",
    ]);
  });

  it("states the wishlist's figures above the shelves", async () => {
    renderPhone(<PhoneFace />, { path: "/wishlist" });
    const wall = await cabinet();
    // Every wish the cabinet covers, the deck's own list included.
    expect(await within(wall).findByText("13", undefined, SETTLE)).toBeInTheDocument();
    expect(within(wall).getByText("Total cost (USD)")).toBeInTheDocument();
  });

  it("draws one tile per wish, named for what the wish asks for", async () => {
    renderPhone(<PhoneFace />, { path: "/wishlist" });
    const wall = await cabinet();
    const unsorted = await within(wall).findByRole("list", { name: "Not sorted" }, SETTLE);
    expect(
      await within(unsorted).findByRole("button", { name: "Sol Ring, any printing" }, SETTLE),
    ).toBeInTheDocument();
    expect(
      within(unsorted).getByRole("button", { name: "Ragavan, Nimble Pilferer, MH2 138, Foil" }),
    ).toBeInTheDocument();
  });

  it("marks a card the reader wishes for again elsewhere, beside its printing", async () => {
    renderPhone(<PhoneFace />, { path: "/wishlist" });
    const wall = await cabinet();
    const unsorted = await within(wall).findByRole("list", { name: "Not sorted" }, SETTLE);
    await within(unsorted).findByRole("button", { name: "Sol Ring, any printing" }, SETTLE);
    // Three of the five loose wishes have a second row in a folder; Ragavan and Jace do not.
    expect(
      within(unsorted).getAllByRole("img", { name: "Also on your wishlist 1 more time" }),
    ).toHaveLength(3);
  });

  it("opens a shut deck's list on a press, and stores the fold", async () => {
    tallViewport();
    renderPhone(<PhoneFace />, { path: "/wishlist" });
    const wall = await cabinet();
    const heading = within(wall).getByRole("button", { name: "Rhystic Testbed" });
    expect(heading).toHaveAttribute("aria-expanded", "false");

    await userEvent.click(heading);

    const shelf = await within(wall).findByRole("list", { name: "Rhystic Testbed" }, SETTLE);
    expect(
      await within(shelf).findByRole("button", { name: "Black Lotus, LEA 232" }, SETTLE),
    ).toBeInTheDocument();
    // Stored as the desktop stores it (step 3.5b), off the managed list's shut default.
    await waitFor(async () => expect((await ipc.shelfFolds()).wishlist).toEqual({ "4": false }));
  });

  it("links a deck's list to its deck from the heading", async () => {
    tallViewport();
    renderPhone(<PhoneFace />, { path: "/wishlist" });
    const wall = await cabinet();
    expect(
      within(wall).getByRole("link", { name: "Open the deck Rhystic Testbed" }),
    ).toHaveAttribute("href", "/decks/4");
    // The reader's own folders are no deck's.
    expect(within(wall).queryByRole("link", { name: /Ordered/ })).toBeNull();
  });

  it("says whose list it is from inside, with a link to the deck", async () => {
    tallViewport();
    renderPhone(<PhoneFace />, { path: "/wishlist" });
    const wall = await cabinet();

    await userEvent.click(within(wall).getByRole("button", { name: "Open Rhystic Testbed" }));

    expect(
      await screen.findByText(/Managed by the deck “Rhystic Testbed”/, undefined, SETTLE),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open deck" })).toHaveAttribute("href", "/decks/4");
    // A URL change is a link, never a button that writes one.
    expect(screen.queryByRole("button", { name: "Open deck" })).toBeNull();
    const path = screen.getByRole("navigation", { name: "Wishlist folders" });
    expect(within(path).getByText("Rhystic Testbed")).toHaveAttribute("aria-current", "page");
  });

  it("says why a deck's list is empty, in the words of the view it follows", async () => {
    tallViewport();
    emptyManagedFolder(4);
    renderPhone(<PhoneFace />, { path: "/wishlist" });
    const wall = await cabinet();

    await userEvent.click(within(wall).getByRole("button", { name: "Rhystic Testbed" }));

    // Deck 4 follows `Missing`.
    expect(
      await within(wall).findByText(MANAGED_EMPTY.missing, undefined, SETTLE),
    ).toBeInTheDocument();
  });

  it("goes into a folder and back out by the path row", async () => {
    renderPhone(<PhoneFace />, { path: "/wishlist" });
    const wall = await cabinet();

    await userEvent.click(within(wall).getByRole("button", { name: "Open Ordered" }));

    const path = await screen.findByRole("navigation", { name: "Wishlist folders" }, SETTLE);
    const inside = screen.getByRole("region", { name: "Your wishlist" });
    expect(
      await within(inside).findByRole("heading", { name: "Backordered" }, SETTLE),
    ).toBeInTheDocument();
    expect(within(inside).queryByRole("heading", { name: "Not sorted" })).toBeNull();

    await userEvent.click(within(path).getByRole("button", { name: "Up to Wishlist" }));

    expect(
      await within(await cabinet()).findByRole("heading", { name: "Ordered" }),
    ).toBeInTheDocument();
  });

  it("draws a wish whose card is gone as a tile that is no control", async () => {
    renderPhone(<PhoneFace />, { path: "/wishlist", fake: { seed: "needsReview" } });
    const wall = await cabinet();
    const unsorted = await within(wall).findByRole("list", { name: "Not sorted" }, SETTLE);
    await within(unsorted).findByRole("button", { name: "Sol Ring, any printing" }, SETTLE);

    // Drawn — under the name it stored — and not a button: there is no printing to open.
    expect(within(unsorted).getAllByText("Orcish Bowmasters").length).toBeGreaterThan(0);
    expect(within(unsorted).queryByRole("button", { name: /^Orcish Bowmasters/ })).toBeNull();
  });

  it("narrows the cabinet through the Filters sheet, offering the wishlist's own cells", async () => {
    renderPhone(<PhoneFace />, { path: "/wishlist" });
    const wall = await cabinet();
    await within(wall).findByRole("list", { name: "Not sorted" }, SETTLE);

    await userEvent.click(screen.getByRole("button", { name: "Filters" }));
    const sheet = await screen.findByRole("dialog", { name: "Filters" });
    expect(within(sheet).getByRole("heading", { name: "Needs review" })).toBeInTheDocument();
    // A wish asks none of these: no price band on its wire, no copy's finish or grade.
    for (const absent of ["Price (USD)", "Finish", "Condition", "Owned", "Printings"]) {
      expect(within(sheet).queryByRole("heading", { name: absent })).toBeNull();
    }

    await userEvent.click(
      within(within(sheet).getByRole("group", { name: "Rarity" })).getByRole("button", {
        name: /Mythic/,
      }),
    );
    await userEvent.click(within(sheet).getByRole("button", { name: /^Show / }));

    expect(screen.getByRole("button", { name: "Filters — 1 active" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Remove filter — Rarity/ })).toBeInTheDocument();
    await waitFor(
      () =>
        expect(within(wall).queryByRole("button", { name: "Sol Ring, any printing" })).toBeNull(),
      SETTLE,
    );
  });

  it("searches the wishlist from its own box", async () => {
    renderPhone(<PhoneFace />, { path: "/wishlist" });
    const wall = await cabinet();
    await within(wall).findByRole("button", { name: "Sol Ring, any printing" }, SETTLE);

    await userEvent.type(
      screen.getByRole("searchbox", { name: "Search your wishlist" }),
      "ragavan",
    );

    await waitFor(
      () =>
        expect(within(wall).queryByRole("button", { name: "Sol Ring, any printing" })).toBeNull(),
      SETTLE,
    );
    expect(
      within(wall).getByRole("button", { name: "Ragavan, Nimble Pilferer, MH2 138, Foil" }),
    ).toBeInTheDocument();
  });

  it("says so when the wishlist is empty", async () => {
    renderPhone(<PhoneFace />, { path: "/wishlist", fake: { seed: "empty" } });
    expect(
      await screen.findByText("Nothing on your wishlist yet.", undefined, SETTLE),
    ).toBeInTheDocument();
  });

  it("says so when the wishlist cannot be read", async () => {
    renderPhone(<PhoneFace />, { path: "/scanner" });
    registerCommands({ wishlist_list: refused() });

    await userEvent.click(tab("Wishlist"));

    expect(await screen.findByRole("alert", undefined, SETTLE)).toHaveTextContent(
      "Your wishlist could not be read.",
    );
  });

  it("says so when the shelves cannot be counted", async () => {
    renderPhone(<PhoneFace />, { path: "/scanner" });
    registerCommands({ wishlist_shelf_counts: refused() });

    await userEvent.click(tab("Wishlist"));

    await waitFor(
      () =>
        expect(screen.getByRole("alert")).toHaveTextContent(
          "Your wishlist's shelves could not be read.",
        ),
      SETTLE,
    );
    expect(screen.queryByText("Nothing on your wishlist yet.")).toBeNull();
  });
});
