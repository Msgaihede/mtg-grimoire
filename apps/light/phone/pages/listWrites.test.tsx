import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("@grimoire/fake/core"));
vi.mock("@tauri-apps/api/event", () => import("@grimoire/fake/event"));
vi.mock("@tauri-apps/api/window", () => import("@grimoire/fake/window"));

import { registerCommands } from "@grimoire/fake/core";
import { printing } from "@grimoire/fake/fixtures";
import {
  ipc,
  type CollectionQuery,
  type CollectionRow,
  type WishlistQuery,
  type WishRow,
} from "@grimoire/ui/lib/ipc";
import { PhoneFace } from "../PhoneApp";
import { installLayout, renderPhone } from "../testing";

/** Long enough for a fake round trip and the reads that follow it. */
const SETTLE = { timeout: 3000 };

/** Tall enough that the virtualiser draws every shelf of the `starter` cabinet. */
const tallViewport = () =>
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, value: 6000 });

beforeEach(installLayout);
afterEach(installLayout);

/** The whole collection as the backend holds it now — every assertion reads the fake. */
async function copies(): Promise<CollectionRow[]> {
  return (await ipc.collectionList({ limit: 500, offset: 0 } as CollectionQuery)).items;
}
const copy = async (id: number) => (await copies()).find((row) => row.id === id);

async function wishes(): Promise<WishRow[]> {
  return (await ipc.wishlistList({ limit: 500, offset: 0 } as WishlistQuery)).items;
}
const wish = async (id: number) => (await wishes()).find((row) => row.id === id);

/** Open a tile's `⋯` and hand back its sheet. */
async function act(name: string): Promise<HTMLElement> {
  await userEvent.click(await screen.findByRole("button", { name: `Edit ${name}` }, SETTLE));
  return await screen.findByRole("dialog", undefined, SETTLE);
}

/**
 * The starter seed's collection, as these tests lean on it: at the root, Tarmogoyf FUT 153 is one
 * row of three (id 8), Urza's Saga one row of four (id 9), Lightning Bolt 2X2 117 one row of four
 * Near Mint (id 1), and the etched STA 105 Bolt two rows on one tile (ids 3 and 12). `Binder` is
 * folder 1; `Modern Goodstuff` (folder 4) is a deck's group holding Counterspell (id 4).
 */
describe("a collection tile's actions", () => {
  it("steps a copy's count, through the desktop's own write", async () => {
    renderPhone(<PhoneFace />, { path: "/collection" });
    const sheet = await act("Tarmogoyf, FUT 153");
    expect(within(sheet).getByRole("heading", { name: "Tarmogoyf" })).toBeInTheDocument();

    await userEvent.click(within(sheet).getByRole("button", { name: "One more Tarmogoyf" }));

    await waitFor(async () => expect((await copy(8))?.quantity).toBe(4));
    expect(await within(sheet).findByLabelText("Copies")).toHaveTextContent("4");
  });

  it("removes a copy, and puts it back on Undo", async () => {
    renderPhone(<PhoneFace />, { path: "/collection" });
    const sheet = await act("Urza's Saga, MH2 259");

    await userEvent.click(within(sheet).getByRole("button", { name: "Remove from collection" }));

    await waitFor(async () => expect(await copy(9)).toBeUndefined());
    // The sheet has closed; the page's line says what went, and offers the desktop's undo.
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const line = await screen.findByText(
      "Removed 4 × Urza's Saga from your collection.",
      undefined,
      SETTLE,
    );
    expect(line).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Undo — put back Urza's Saga" }));

    await waitFor(async () =>
      expect(
        (await copies()).find((row) => row.name === "Urza's Saga" && row.folderId === null)
          ?.quantity,
      ).toBe(4),
    );
  });

  it("removes the last copy from the stepper too — the same write, offered back", async () => {
    renderPhone(<PhoneFace />, { path: "/collection" });
    // A one-copy row at the root: the Japanese etched Bolt, one of its tile's two rows.
    const tile = await act("Lightning Bolt, STA 105, Etched");
    await userEvent.click(within(tile).getByRole("button", { name: /^1× Near mint/ }));
    await userEvent.click(within(tile).getByRole("button", { name: "Remove Lightning Bolt" }));

    await waitFor(async () => expect(await copy(3)).toBeUndefined());
    expect(await copy(12)).toBeDefined();
    expect(
      await screen.findByRole("button", { name: "Undo — put back Lightning Bolt" }, SETTLE),
    ).toBeInTheDocument();
  });

  it("asks which copy when a tile stands for several rows, and writes to that one alone", async () => {
    renderPhone(<PhoneFace />, { path: "/collection" });
    const sheet = await act("Lightning Bolt, STA 105, Etched");
    const listed = within(sheet).getByRole("list", { name: "Copies on this tile" });
    expect(within(listed).getAllByRole("button")).toHaveLength(2);

    await userEvent.click(within(listed).getByRole("button", { name: /^1× Not set/ }));
    await userEvent.click(within(sheet).getByRole("button", { name: /^Condition/ }));
    await userEvent.click(within(sheet).getByRole("button", { name: "Lightly played" }));

    await waitFor(async () => expect((await copy(12))?.condition).toBe("LP"));
    // The other row on the tile is untouched.
    expect((await copy(3))?.condition).toBe("NM");
  });

  it("changes a copy's condition and its finish", async () => {
    renderPhone(<PhoneFace />, { path: "/collection" });
    const sheet = await act("Lightning Bolt, 2X2 117");

    await userEvent.click(within(sheet).getByRole("button", { name: /^Condition/ }));
    const grades = within(sheet).getByRole("list", { name: "Conditions" });
    expect(within(grades).getByRole("button", { name: "Near mint" })).toHaveAttribute(
      "aria-current",
      "true",
    );
    await userEvent.click(within(grades).getByRole("button", { name: "Moderately played" }));
    await waitFor(async () => expect((await copy(1))?.condition).toBe("MP"));

    await userEvent.click(await within(sheet).findByRole("button", { name: /^Finish/ }, SETTLE));
    await userEvent.click(await within(sheet).findByRole("button", { name: "Foil" }, SETTLE));

    await waitFor(async () => expect((await copy(1))?.finish).toBe("foil"));
    // The sheet followed the copy onto its new tile.
    expect(await within(sheet).findByText(/Foil · Collection/, undefined, SETTLE)).toBeInTheDocument();
  });

  it("moves a copy to a folder", async () => {
    renderPhone(<PhoneFace />, { path: "/collection" });
    const sheet = await act("Tarmogoyf, FUT 153");

    await userEvent.click(within(sheet).getByRole("button", { name: /^Move to/ }));
    const destinations = within(sheet).getByRole("list", { name: "Folders" });
    // The reader's own drawers, nested, and the one set aside marked — never a deck's group.
    expect(within(destinations).queryByRole("button", { name: /Modern Goodstuff/ })).toBeNull();
    expect(within(destinations).getByText("set aside")).toBeInTheDocument();
    await userEvent.click(within(destinations).getByRole("button", { name: "Binder" }));

    await waitFor(async () => expect((await copy(8))?.folderId).toBe(1));
    expect(await screen.findByText("Moved Tarmogoyf to Binder.", undefined, SETTLE)).toBeInTheDocument();
  });

  it("says a refused move in the backend's words, and moves nothing", async () => {
    renderPhone(<PhoneFace />, { path: "/collection" });
    const sheet = await act("Tarmogoyf, FUT 153");
    registerCommands({
      collection_set_folder: () => {
        throw new Error("That folder is not there any more.");
      },
    });

    await userEvent.click(within(sheet).getByRole("button", { name: /^Move to/ }));
    await userEvent.click(within(sheet).getByRole("button", { name: "Binder" }));

    expect(
      await within(sheet).findByText("That folder is not there any more.", undefined, SETTLE),
    ).toBeInTheDocument();
    expect((await copy(8))?.folderId).toBeNull();
  });

  it("fences a deck's copies as the desktop does, and the backend refuses moving them out", async () => {
    tallViewport();
    renderPhone(<PhoneFace />, { path: "/collection" });
    const wall = await screen.findByRole("region", { name: "Your collection" }, SETTLE);
    await userEvent.click(await within(wall).findByRole("button", { name: "Modern Goodstuff" }, SETTLE));
    const sheet = await act("Counterspell, MH2 267");

    // No stepper over a deck's custody — the desktop's sentence instead — and no removal.
    expect(within(sheet).queryByRole("button", { name: /One more Counterspell/ })).toBeNull();
    expect(
      within(sheet).getAllByText(/In Modern Goodstuff\. Remove it from the deck to change the quantity\./)
        .length,
    ).toBeGreaterThan(0);
    expect(within(sheet).getByRole("button", { name: /^Remove from collection/ })).toHaveAttribute(
      "aria-disabled",
      "true",
    );

    await userEvent.click(within(sheet).getByRole("button", { name: /^Move to/ }));
    await userEvent.click(within(sheet).getByRole("button", { name: "Binder" }));

    expect(
      await within(sheet).findByText(/Those copies are in a deck/, undefined, SETTLE),
    ).toBeInTheDocument();
    expect((await copy(4))?.folderId).toBe(4);
  });

  it("still opens the card on a press of the picture", async () => {
    renderPhone(<PhoneFace />, { path: "/collection" });
    await userEvent.click(
      await screen.findByRole("button", { name: "Tarmogoyf, FUT 153, 3 copies" }, SETTLE),
    );
    expect(await screen.findByRole("dialog", { name: "Tarmogoyf" }, SETTLE)).toBeInTheDocument();
    expect(window.location.search).toMatch(/card=/);
  });
});

/**
 * The starter seed's wishlist: wish 4 is four Counterspells pinned to MH2 267, wish 2 a Sol Ring
 * for any printing, both at the root; `Rhystic Testbed` (folder 4) is a deck's managed list.
 */
describe("a wish's actions", () => {
  it("steps a wish's count", async () => {
    renderPhone(<PhoneFace />, { path: "/wishlist" });
    const sheet = await act("Counterspell, MH2 267");

    await userEvent.click(within(sheet).getByRole("button", { name: "One more Counterspell" }));

    await waitFor(async () => expect((await wish(4))?.quantity).toBe(5));
  });

  it("pins a wish for any printing to one printing, and back", async () => {
    renderPhone(<PhoneFace />, { path: "/wishlist" });
    const sheet = await act("Sol Ring, any printing");

    await userEvent.click(within(sheet).getByRole("button", { name: /^Printing/ }));
    const printings = within(sheet).getByRole("list", { name: "Printings" });
    expect(within(printings).getByRole("button", { name: /^Any printing/ })).toHaveAttribute(
      "aria-current",
      "true",
    );
    const pins = await within(printings).findAllByRole("button", { name: /^Wish for / }, SETTLE);
    await userEvent.click(pins[0]);

    await waitFor(async () => expect((await wish(2))?.cardId).not.toBeNull());

    await userEvent.click(await within(sheet).findByRole("button", { name: /^Printing/ }, SETTLE));
    await userEvent.click(within(sheet).getByRole("button", { name: "Any printing" }));
    await waitFor(async () =>
      expect((await wishes()).find((row) => row.name === "Sol Ring" && row.folderId === null)?.cardId)
        .toBeNull(),
    );
  });

  it("removes a wish, with no undo — the desktop offers none", async () => {
    renderPhone(<PhoneFace />, { path: "/wishlist" });
    const sheet = await act("Sol Ring, any printing");

    await userEvent.click(within(sheet).getByRole("button", { name: "Remove from wishlist" }));

    await waitFor(async () => expect(await wish(2)).toBeUndefined());
    expect(
      await screen.findByText("Removed Sol Ring from your wishlist.", undefined, SETTLE),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Undo/ })).toBeNull();
  });

  it("offers no edit on a wish a deck manages", async () => {
    tallViewport();
    renderPhone(<PhoneFace />, { path: "/wishlist" });
    const wall = await screen.findByRole("region", { name: "Your wishlist" }, SETTLE);
    await userEvent.click(await within(wall).findByRole("button", { name: "Rhystic Testbed" }, SETTLE));
    const shelf = await within(wall).findByRole("list", { name: "Rhystic Testbed" }, SETTLE);
    await within(shelf).findByRole("button", { name: "Black Lotus, LEA 232" }, SETTLE);

    expect(within(shelf).queryAllByRole("button", { name: /^Edit / })).toHaveLength(0);
    // …while a wish the reader filed has one.
    expect(screen.getByRole("button", { name: "Edit Sol Ring, any printing" })).toBeInTheDocument();
  });
});

describe("the card sheet's adds", () => {
  const bolt = printing("2x2", "117");
  const boltCopies = async () =>
    (await copies()).filter((row) => row.cardId === bolt.id && row.folderId === null);
  const held = async () => (await boltCopies()).reduce((sum, row) => sum + row.quantity, 0);

  it("adds one copy to the collection's root, and takes it back on Undo", async () => {
    renderPhone(<PhoneFace />, { path: `/search?card=${bolt.id}` });
    const sheet = await screen.findByRole("dialog", { name: "Lightning Bolt" }, SETTLE);
    const before = await held();

    await userEvent.click(within(sheet).getByRole("button", { name: "Add to collection" }));

    await waitFor(async () => expect(await held()).toBe(before + 1));
    expect(
      await within(sheet).findByText(/Added 1 × Lightning Bolt.* to your collection\./, undefined, SETTLE),
    ).toBeInTheDocument();

    await userEvent.click(
      within(sheet).getByRole("button", { name: "Undo — take back the copy of Lightning Bolt" }),
    );
    await waitFor(async () => expect(await held()).toBe(before));
  });

  it("adds in the finish chosen, where the printing is sold in several", async () => {
    renderPhone(<PhoneFace />, { path: `/search?card=${bolt.id}` });
    const sheet = await screen.findByRole("dialog", { name: "Lightning Bolt" }, SETTLE);
    const finishes = within(sheet).getByRole("radiogroup", { name: "Finish to add" });

    await userEvent.click(within(finishes).getByRole("radio", { name: "Foil" }));
    await userEvent.click(within(sheet).getByRole("button", { name: "Add to collection" }));

    await waitFor(async () =>
      expect((await boltCopies()).some((row) => row.finish === "foil")).toBe(true),
    );
  });

  it("adds a wish for this printing, and one for any printing", async () => {
    renderPhone(<PhoneFace />, { path: `/search?card=${bolt.id}` });
    const sheet = await screen.findByRole("dialog", { name: "Lightning Bolt" }, SETTLE);

    await userEvent.click(within(sheet).getByRole("button", { name: "Add to wishlist" }));
    await waitFor(async () =>
      expect((await wishes()).some((row) => row.cardId === bolt.id)).toBe(true),
    );

    await userEvent.click(
      within(sheet).getByRole("button", { name: "Add to wishlist, any printing" }),
    );
    await waitFor(async () =>
      expect(
        (await wishes()).some((row) => row.name === "Lightning Bolt" && row.cardId === null),
      ).toBe(true),
    );
    expect(
      await within(sheet).findByText("Added Lightning Bolt (any printing) to your wishlist.", undefined, SETTLE),
    ).toBeInTheDocument();
  });
});

/**
 * The sheet's **In your grimoire** line, read off the sheet. It is one read under a key no
 * writer names (`cardHoldingsKey`) and is kept for 30 s, so until 2026-10-04 it said `Owned 0`
 * straight after the sheet's own *Added 1 × Sol Ring to your collection.* — and said it again
 * when the sheet was closed and opened. Each test here would pass a second read in half a
 * minute; none waits that long.
 */
describe("the card sheet's figures", () => {
  const bolt = printing("2x2", "117");
  /** One figure of the line, once the read has answered. */
  const figure = async (sheet: HTMLElement, label: string): Promise<number> => {
    const term = await within(sheet).findByText(label, { selector: "dt" }, SETTLE);
    return Number(term.nextElementSibling?.textContent);
  };
  const reads = async (sheet: HTMLElement, label: string, value: number) =>
    waitFor(async () => expect(await figure(sheet, label)).toBe(value), SETTLE);

  it("move on the sheet's own adds, without a reload", async () => {
    renderPhone(<PhoneFace />, { path: `/search?card=${bolt.id}` });
    const sheet = await screen.findByRole("dialog", { name: "Lightning Bolt" }, SETTLE);
    const owned = await figure(sheet, "Owned");
    const wished = await figure(sheet, "Wished");

    await userEvent.click(within(sheet).getByRole("button", { name: "Add to collection" }));
    await reads(sheet, "Owned", owned + 1);

    await userEvent.click(within(sheet).getByRole("button", { name: "Add to wishlist" }));
    await reads(sheet, "Wished", wished + 1);
    // And the first figure was not put back by the second write's read.
    expect(await figure(sheet, "Owned")).toBe(owned + 1);

    // The add's own Undo is a write like any other.
    await userEvent.click(
      within(sheet).getByRole("button", { name: "Undo — take back the copy of Lightning Bolt" }),
    );
    await reads(sheet, "Owned", owned);
  });

  it("have moved when the sheet is opened again after a copy went on the page behind it", async () => {
    renderPhone(<PhoneFace />, { path: "/collection" });
    const open = async () => {
      await userEvent.click(
        await screen.findByRole("button", { name: /^Tarmogoyf, FUT 153, \d+ cop/ }, SETTLE),
      );
      return screen.findByRole("dialog", { name: "Tarmogoyf" }, SETTLE);
    };

    // Opened once, so the figure is in the cache — and closed: the write below is made with no
    // card open at all.
    const owned = await figure(await open(), "Owned");
    expect(owned).toBeGreaterThanOrEqual(3);
    await userEvent.click(screen.getByRole("button", { name: "Close card" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    const actions = await act("Tarmogoyf, FUT 153");
    await userEvent.click(within(actions).getByRole("button", { name: "One fewer Tarmogoyf" }));
    await waitFor(async () => expect((await copy(8))?.quantity).toBe(2));
    await userEvent.click(within(actions).getByRole("button", { name: "Close copy actions" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    await reads(await open(), "Owned", owned - 1);
  });
});
