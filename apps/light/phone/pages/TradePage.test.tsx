import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("@grimoire/fake/core"));
vi.mock("@tauri-apps/api/event", () => import("@grimoire/fake/event"));
vi.mock("@tauri-apps/api/window", () => import("@grimoire/fake/window"));

import type { CommandTable } from "@grimoire/fake/scope";
import {
  ipc,
  type CollectionFolder,
  type CollectionQuery,
  type CollectionRow,
  type Trade,
  type TradeLine,
  type TradeSummary,
} from "@grimoire/ui/lib/ipc";
import { PhoneFace } from "../PhoneApp";
import { installLayout, renderPhone } from "../testing";

/** Long enough for a fake round trip and the reads that follow it. */
const SETTLE = { timeout: 3000 };

beforeEach(installLayout);
afterEach(() => {
  installLayout();
  vi.restoreAllMocks();
});

const refused = () =>
  vi.fn(() => {
    throw new Error("database is locked");
  });

const TRADES = { seed: "trades" } as const;

/**
 * The `trades` seed, as these tests lean on it. Newest first: `Trade 5` (open, the design's own —
 * 64.39 against 87.09, so *You owe them $22.70*), `Trade 4` (open, 6.43 against 0.33),
 * `Store night swaps` (finished, even), `Trade 2` (finished, with an outcome) and `Trade 1`
 * (archived without finishing). Trade 5's lines are ids 17–24: on the reader's side Ragavan (17),
 * two etched Counterspells (18), a foil Swords to Plowshares (19) and two Boros Charms (20), every
 * one of them in the collection; on theirs a foil Lightning Bolt (21), Urza's Saga (22) and
 * Tarmogoyf (23) — both wished for — and two Sol Rings (24).
 */
const openTrade = (id = 5) => renderPhone(<PhoneFace />, { path: `/trade/${id}`, fake: TRADES });

/** The trade as the backend holds it now — every assertion about a write reads the fake. */
async function stored(id = 5): Promise<Trade> {
  const trade = await ipc.tradeGet(id);
  if (trade === null) throw new Error(`trade ${id} is gone`);
  return trade;
}
const storedLine = async (lineId: number): Promise<TradeLine | undefined> =>
  (await stored()).lines.find((line) => line.id === lineId);

/**
 * One more copy of the line's printing and finish in the collection. A press on `+` past the
 * copies the collection holds puts the extra copy on a line of its own (issue #935), so a test
 * about stepping one line gives the collection the copy it steps onto.
 */
async function ownOneMore(lineId: number): Promise<void> {
  const line = await storedLine(lineId);
  if (!line) throw new Error(`line ${lineId} is gone`);
  await ipc.collectionAdd({ cardId: line.cardId, finish: line.finish, quantity: 1 });
}

const side = (name: string) => screen.findByRole("region", { name }, SETTLE);
const balance = () => screen.getByRole("region", { name: "Balance" });
const sheetGone = () => waitFor(() => expect(screen.queryByRole("dialog")).toBeNull(), SETTLE);

/** Open a line's sheet by the card's name and code line, and hand the sheet back. */
async function edit(name: string, code: string): Promise<HTMLElement> {
  await userEvent.click(await screen.findByRole("button", { name: `Edit ${name}, ${code}` }, SETTLE));
  return await screen.findByRole("dialog", { name }, SETTLE);
}

describe("Trade, as a destination", () => {
  it("is a sixth tab, and lands on the list of trades", async () => {
    renderPhone(<PhoneFace />, { fake: TRADES });
    const tab = within(screen.getByRole("navigation", { name: "Views" })).getByRole("link", {
      name: "Trade",
    });
    expect(tab).toHaveAttribute("href", "/trade");

    await userEvent.click(tab);

    expect(window.location.pathname).toBe("/trade");
    expect(screen.getByRole("heading", { level: 1, name: "Trade" })).toBeInTheDocument();
    expect(tab).toHaveAttribute("aria-current", "page");
    expect(await screen.findByRole("button", { name: "New trade" }, SETTLE)).toBeInTheDocument();
  });

  it("keeps the tab lit on a trade's own page", async () => {
    openTrade();
    await screen.findByRole("heading", { level: 2, name: "Trade 5" }, SETTLE);
    expect(
      within(screen.getByRole("navigation", { name: "Views" })).getByRole("link", { name: "Trade" }),
    ).toHaveAttribute("aria-current", "page");
  });
});

describe("the trades list", () => {
  it("files every trade under Open or Archived and states each one's balance", async () => {
    renderPhone(<PhoneFace />, { path: "/trade", fake: TRADES });

    const open = await screen.findByRole("region", { name: "Open · 2" }, SETTLE);
    const archived = screen.getByRole("region", { name: "Archived · 3" });
    const rows = (section: HTMLElement) =>
      within(section)
        .getAllByRole("link")
        .map((row) => row.getAttribute("aria-label"));

    // Newest first, and the live balances in the present tense.
    expect(rows(open)).toEqual([
      "Trade 5. Opened 2 Oct · 6 for 5 cards. You owe $22.70",
      "Trade 4. Opened 28 Sep · 2 for 1 card. They owe you $6.10",
    ]);
    // A finished trade's balance is a record; one put away unfinished still owes.
    expect(rows(archived)).toEqual([
      "Store night swaps. Finished 19 Sep · 4 for 6 cards. Even trade",
      "Trade 2. Finished 6 Sep · 3 for 3 cards. They owed you $2.35",
      "Trade 1. Archived 23 Aug · not finished. You owe $3.75",
    ]);
  });

  it("draws each row as a link to the trade's own place", async () => {
    renderPhone(<PhoneFace />, { path: "/trade", fake: TRADES });
    const row = await screen.findByRole("link", { name: /^Trade 5\./ }, SETTLE);
    expect(row).toHaveAttribute("href", "/trade/5");
    // What the name spells is what the row draws.
    expect(row).toHaveTextContent("Trade 5");
    expect(row).toHaveTextContent("Opened 2 Oct · 6 for 5 cards");
    expect(row).toHaveTextContent("You owe $22.70");
  });

  it("says so where there are no trades, and still offers a new one", async () => {
    renderPhone(<PhoneFace />, { path: "/trade", fake: { seed: "starter" } });
    expect(await screen.findByText("No trades yet.", undefined, SETTLE)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New trade" })).toBeInTheDocument();
  });

  it("says the read failed rather than that there are none", async () => {
    renderPhone(<PhoneFace />, {
      path: "/trade",
      fake: TRADES,
      commands: () => ({ trade_list: refused() }),
    });
    expect(await screen.findByRole("alert", undefined, SETTLE)).toHaveTextContent(
      "Your trades could not be read.",
    );
    expect(screen.queryByText("No trades yet.")).toBeNull();
  });
});

describe("a trade in the URL", () => {
  it("opens from the list by a push, and Back returns to the list", async () => {
    renderPhone(<PhoneFace />, { path: "/trade", fake: TRADES });
    await userEvent.click(await screen.findByRole("link", { name: /^Trade 5\./ }, SETTLE));

    expect(window.location.pathname).toBe("/trade/5");
    expect(await screen.findByRole("heading", { level: 2, name: "Trade 5" }, SETTLE)).toBeInTheDocument();

    window.history.back();
    expect(await screen.findByRole("region", { name: "Open · 2" }, SETTLE)).toBeInTheDocument();
    expect(window.location.pathname).toBe("/trade");
  });

  it("opens on the trade a cold load names, with a link back to the list", async () => {
    openTrade(4);
    expect(await screen.findByRole("heading", { level: 2, name: "Trade 4" }, SETTLE)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "All trades" })).toHaveAttribute("href", "/trade");
  });

  it("says a trade that is not there is gone, and keeps the way back", async () => {
    openTrade(99);
    expect(await screen.findByText("That trade is gone.", undefined, SETTLE)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "All trades" })).toBeInTheDocument();
  });

  it("says the read failed rather than that the trade is gone", async () => {
    renderPhone(<PhoneFace />, {
      path: "/trade/5",
      fake: TRADES,
      commands: () => ({ trade_get: refused() }),
    });
    expect(await screen.findByRole("alert", undefined, SETTLE)).toHaveTextContent(
      "That trade could not be read.",
    );
  });
});

describe("an open trade", () => {
  it("draws both sides, both totals and who owes whom", async () => {
    openTrade();
    const mine = await side("You give");
    const theirs = await side("They give");

    expect(within(mine).getByText("6 cards")).toBeInTheDocument();
    expect(within(theirs).getByText("5 cards")).toBeInTheDocument();
    const counterspell = within(mine).getByRole("button", {
      name: "Edit Counterspell, MH2 267 · Etched",
    });
    expect(counterspell).toHaveTextContent("2 × $3.25");
    expect(counterspell).toHaveTextContent("$6.50");
    // At 100% there is one price to a line.
    expect(counterspell).not.toHaveTextContent("at 100%");
    expect(within(theirs).getAllByRole("listitem")).toHaveLength(4);

    expect(balance()).toHaveTextContent("$64.39");
    expect(balance()).toHaveTextContent("$87.09");
    expect(balance()).toHaveTextContent("You owe them");
    expect(balance()).toHaveTextContent("$22.70");
    expect(within(balance()).getByRole("button", { name: "Finish trade" })).toBeInTheDocument();
  });

  it("is two columns at every width, asked of nothing", async () => {
    // jsdom lays nothing out, so what is pinned is the class: two columns unconditionally, and no
    // container on the way up for the sheets' fixed scrims to be positioned against.
    openTrade();
    const mine = await side("You give");
    const columns = mine.parentElement as HTMLElement;
    expect(columns.classList.contains("grid-cols-2")).toBe(true);
    // One bounded row, so each column scrolls on its own instead of stretching the page.
    expect(columns.classList.contains("grid-rows-[minmax(0,1fr)]")).toBe(true);
    expect(mine.lastElementChild?.classList.contains("overflow-y-auto")).toBe(true);
    for (let box: HTMLElement | null = columns; box !== null; box = box.parentElement) {
      expect(box.className).not.toMatch(/@container/);
    }
  });

  it("archives without touching the collection, and reopens", async () => {
    openTrade();
    await userEvent.click(await screen.findByRole("button", { name: "Archive" }, SETTLE));

    expect(
      await screen.findByText(/^Archived without finishing, so nothing here can be edited\./, undefined, SETTLE),
    ).toBeInTheDocument();
    expect((await stored()).status).toBe("archived");
    // Not finished: the cards never changed hands, so the columns keep the present tense.
    expect(screen.getByRole("region", { name: "You give" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Reopen" }));
    expect(await screen.findByRole("button", { name: "Finish trade" }, SETTLE)).toBeInTheDocument();
    expect((await stored()).status).toBe("open");
  });

  it("says a refused write in words on the page", async () => {
    renderPhone(<PhoneFace />, {
      path: "/trade/5",
      fake: TRADES,
      commands: () => ({ trade_archive: refused() }),
    });
    await userEvent.click(await screen.findByRole("button", { name: "Archive" }, SETTLE));
    expect(await screen.findByRole("alert", undefined, SETTLE)).toHaveTextContent(
      "database is locked",
    );
    // Still open: nothing was written.
    expect(screen.getByRole("button", { name: "Finish trade" })).toBeInTheDocument();
  });
});

describe("a side's percentage", () => {
  it("writes once, on Done, and then draws both prices", async () => {
    const setRate = vi.spyOn(ipc, "tradeSetRate");
    openTrade();
    await userEvent.click(
      await screen.findByRole("button", { name: "Price for their cards: 100%" }, SETTLE),
    );
    const sheet = await screen.findByRole("dialog", { name: "Price their cards at" }, SETTLE);
    const slider = within(sheet).getByRole("slider", { name: "Percent of market price" });
    expect(slider).toHaveAttribute("min", "50");
    expect(slider).toHaveAttribute("max", "150");
    expect(slider).toHaveAttribute("step", "5");

    // A drag is many values; the figures follow the thumb and nothing is written.
    for (const value of ["95", "90", "80"]) fireEvent.change(slider, { target: { value } });
    expect(within(sheet).getByText("80%")).toBeInTheDocument();
    expect(within(sheet).getByText("Their side at 80%")).toBeInTheDocument();
    expect(sheet).toHaveTextContent("$87.09");
    expect(sheet).toHaveTextContent("$69.67");
    expect(setRate).not.toHaveBeenCalled();

    await userEvent.click(within(sheet).getByRole("button", { name: "Done" }));

    await waitFor(() => expect(setRate).toHaveBeenCalledTimes(1));
    expect(setRate).toHaveBeenCalledWith(5, "theirs", 80);
    await sheetGone();
    await waitFor(async () => expect((await stored()).rateTheirs).toBe(80));

    // Their side is rated: each line and the total carry the full figure beside the adjusted one.
    const theirs = await side("They give");
    const bolt = await within(theirs).findByRole(
      "button",
      { name: "Edit Lightning Bolt, STA 105 · Foil" },
      SETTLE,
    );
    await waitFor(() => expect(bolt).toHaveTextContent("1 × $19.08"));
    expect(bolt).toHaveTextContent("$23.85 at 100%");
    expect(balance()).toHaveTextContent("$69.67");
    expect(balance()).toHaveTextContent("$87.09 at 100%");
    expect(balance()).toHaveTextContent("$5.28");
    expect(
      within(theirs).getByRole("button", { name: "Price for their cards: 80%" }),
    ).toBeInTheDocument();
    // The reader's own side is still at market price, and says nothing about 100%.
    const mine = screen.getByRole("region", { name: "You give" });
    expect(mine).not.toHaveTextContent("at 100%");
    // Leaving the sheet did not write the same value a second time.
    expect(setRate).toHaveBeenCalledTimes(1);
  });

  it("writes when the reader lets go of the slider, and not again on Done", async () => {
    const setRate = vi.spyOn(ipc, "tradeSetRate");
    openTrade();
    await userEvent.click(
      await screen.findByRole("button", { name: "Price for your cards: 100%" }, SETTLE),
    );
    const sheet = await screen.findByRole("dialog", { name: "Price your cards at" }, SETTLE);
    const slider = within(sheet).getByRole("slider");

    fireEvent.change(slider, { target: { value: "120" } });
    expect(setRate).not.toHaveBeenCalled();
    fireEvent.pointerUp(slider);
    await waitFor(() => expect(setRate).toHaveBeenCalledTimes(1));
    expect(setRate).toHaveBeenCalledWith(5, "mine", 120);

    await userEvent.click(within(sheet).getByRole("button", { name: "Done" }));
    await sheetGone();
    expect(setRate).toHaveBeenCalledTimes(1);
  });
});

describe("a line's sheet", () => {
  it("steps the copies, and the page's figures follow", async () => {
    openTrade();
    await ownOneMore(18);
    const sheet = await edit("Counterspell", "MH2 267 · Etched");
    expect(sheet).toHaveTextContent("Your side · from your collection");

    await userEvent.click(within(sheet).getByRole("button", { name: "One more Counterspell" }));

    await waitFor(async () => expect((await storedLine(18))?.quantity).toBe(3));
    expect(await within(sheet).findByLabelText("Copies")).toHaveTextContent("3");
    await userEvent.click(within(sheet).getByRole("button", { name: "Close card" }));
    await sheetGone();
    const line = screen.getByRole("button", { name: "Edit Counterspell, MH2 267 · Etched" });
    await waitFor(() => expect(line).toHaveTextContent("3 × $3.25"));
    expect(balance()).toHaveTextContent("$67.64");
  });

  /**
   * Issue #935: the collection holds two of these, so a third is a card the reader does not have
   * — a line of its own, without *from your collection*, and the same money on the side.
   */
  it("puts a copy stepped past the collection on a line of its own", async () => {
    openTrade();
    const sheet = await edit("Counterspell", "MH2 267 · Etched");
    expect(sheet).toHaveTextContent("Your side · from your collection · 2 owned");

    await userEvent.click(within(sheet).getByRole("button", { name: "One more Counterspell" }));

    await waitFor(async () =>
      expect((await stored()).lines.filter((l) => l.name === "Counterspell")).toHaveLength(2),
    );
    expect((await storedLine(18))?.quantity).toBe(2);
    const past = (await stored()).lines.find((l) => l.name === "Counterspell" && l.id !== 18);
    expect(past).toMatchObject({ side: "mine", quantity: 1, source: "search" });
    await userEvent.click(within(sheet).getByRole("button", { name: "Close card" }));
    await sheetGone();

    const lines = await screen.findAllByRole(
      "button",
      { name: "Edit Counterspell, MH2 267 · Etched" },
      SETTLE,
    );
    expect(lines).toHaveLength(2);
    expect(balance()).toHaveTextContent("$67.64");
  });

  it("removes the line where the stepper goes below one copy", async () => {
    openTrade();
    const sheet = await edit("Ragavan, Nimble Pilferer", "MH2 138 · Nonfoil");

    await userEvent.click(
      within(sheet).getByRole("button", { name: "Remove Ragavan, Nimble Pilferer" }),
    );

    await waitFor(async () => expect(await storedLine(17)).toBeUndefined());
    await sheetGone();
    expect(screen.queryByRole("button", { name: /^Edit Ragavan/ })).toBeNull();
    await waitFor(() => expect(balance()).toHaveTextContent("$22.20"));
  });

  it("changes the finish to one the printing comes in, at that finish's price", async () => {
    openTrade();
    const sheet = await edit("Counterspell", "MH2 267 · Etched");
    const finishes = within(sheet).getByRole("group", { name: "Finish of Counterspell" });
    expect(
      within(finishes)
        .getAllByRole("button")
        .map((chip) => `${chip.textContent}${chip.getAttribute("aria-pressed") === "true" ? " ✓" : ""}`),
    ).toEqual(["Nonfoil $2.95", "Foil $3.19", "Etched $3.25 ✓"]);

    await userEvent.click(within(finishes).getByRole("button", { name: "Foil $3.19" }));

    await waitFor(async () => expect((await storedLine(18))?.finish).toBe("foil"));
    await userEvent.click(within(sheet).getByRole("button", { name: "Close card" }));
    await sheetGone();
    const line = await screen.findByRole(
      "button",
      { name: "Edit Counterspell, MH2 267 · Foil" },
      SETTLE,
    );
    expect(line).toHaveTextContent("2 × $3.19");
  });

  it("moves a line to the other side", async () => {
    openTrade();
    const sheet = await edit("Boros Charm", "GTC 148 · Nonfoil");

    await userEvent.click(within(sheet).getByRole("button", { name: "Move to their side" }));

    await waitFor(async () => expect((await storedLine(20))?.side).toBe("theirs"));
    await sheetGone();
    const theirs = await side("They give");
    expect(
      await within(theirs).findByRole("button", { name: "Edit Boros Charm, GTC 148 · Nonfoil" }, SETTLE),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole("region", { name: "You give" })).queryByRole("button", {
        name: /^Edit Boros Charm/,
      }),
    ).toBeNull();
  });

  it("removes a line from the trade", async () => {
    openTrade();
    const sheet = await edit("Sol Ring", "C21 263 · Nonfoil");
    expect(sheet).toHaveTextContent("Their side");

    await userEvent.click(within(sheet).getByRole("button", { name: "Remove from trade" }));

    await waitFor(async () => expect(await storedLine(24)).toBeUndefined());
    await sheetGone();
    expect(screen.queryByRole("button", { name: /^Edit Sol Ring/ })).toBeNull();
  });

  it("offers every printing of the card, and swaps the line to the one pressed", async () => {
    openTrade();
    const sheet = await edit("Lightning Bolt", "STA 105 · Foil");
    expect(sheet).toHaveTextContent("Their side");

    await userEvent.click(within(sheet).getByRole("button", { name: /^Printing/ }));
    const printings = await within(sheet).findByRole("list", { name: "Printings" }, SETTLE);
    const other = within(printings)
      .getAllByRole("button")
      .find((row) => row.getAttribute("aria-current") !== "true");
    if (other === undefined) throw new Error("the seed has only one Lightning Bolt printing");
    expect(other.getAttribute("aria-label")).toMatch(/^Use /);

    await userEvent.click(other);

    // A new printing, and the sheet is back on its first page.
    await waitFor(async () =>
      expect((await storedLine(21))?.cardId).not.toBe("b14fae63-2e82-49c1-8e62-d84a65f27479"),
    );
    expect(await within(sheet).findByRole("button", { name: "Move to your side" })).toBeInTheDocument();
  });

  it("marks a card the reader has wished for", async () => {
    openTrade();
    const sheet = await edit("Urza's Saga", "MH2 259 · Nonfoil");
    expect(sheet).toHaveTextContent("Their side · on your wishlist");
  });
});

describe("adding cards", () => {
  it("opens your side on your collection, and adds a copy per press", async () => {
    openTrade();
    await userEvent.click(
      await screen.findByRole("button", { name: "Add cards to your side" }, SETTLE),
    );
    const sheet = await screen.findByRole("dialog", { name: "Add cards" }, SETTLE);
    expect(sheet).toHaveTextContent("To your side of the trade");
    expect(within(sheet).getByRole("button", { name: "Collection" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(within(sheet).getByRole("button", { name: "All cards" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(sheet).toHaveTextContent("Your side: $64.39");

    await userEvent.type(
      within(sheet).getByRole("searchbox", { name: "Search your collection" }),
      "boros charm",
    );
    const add = await within(sheet).findByRole(
      "button",
      { name: "Add Boros Charm, GTC 148 · Nonfoil" },
      SETTLE,
    );
    const row = add.closest("li") as HTMLElement;
    expect(row).toHaveTextContent("$5.84");
    expect(row).toHaveTextContent("3 owned · 2 in this trade");

    await userEvent.click(add);

    // Folded into the line the side already had, not a second one.
    await waitFor(async () => expect((await storedLine(20))?.quantity).toBe(3));
    await waitFor(() => expect(row).toHaveTextContent("3 owned · 3 in this trade"));
    await waitFor(() => expect(sheet).toHaveTextContent("Your side: $70.23"));

    await userEvent.click(within(sheet).getByRole("button", { name: "Done" }));
    await sheetGone();
    expect(screen.getByRole("button", { name: "Edit Boros Charm, GTC 148 · Nonfoil" })).toHaveTextContent(
      "3 × $5.84",
    );
  });

  it("searches every card for their side, with no collection to pick from", async () => {
    openTrade();
    await userEvent.click(
      await screen.findByRole("button", { name: "Add cards to their side" }, SETTLE),
    );
    const sheet = await screen.findByRole("dialog", { name: "Add cards" }, SETTLE);
    expect(sheet).toHaveTextContent("To their side of the trade");
    expect(within(sheet).queryByRole("button", { name: "Collection" })).toBeNull();
    expect(within(sheet).getByRole("searchbox", { name: "Search all cards" })).toBeInTheDocument();
    expect(within(sheet).getByRole("button", { name: "Scan cards onto their side" })).toBeInTheDocument();
    expect(sheet).toHaveTextContent("Their side: $87.09");
  });

  it("gives way to the scanner, pointed at the side it was adding to", async () => {
    openTrade();
    const opener = await screen.findByRole("button", { name: "Add cards to their side" }, SETTLE);
    await userEvent.click(opener);
    const sheet = await screen.findByRole("dialog", { name: "Add cards" }, SETTLE);

    await userEvent.click(within(sheet).getByRole("button", { name: "Scan cards onto their side" }));

    // One sheet at a time: the scanner takes the add sheet's place.
    const scanner = await screen.findByRole("dialog", { name: "Scan cards" }, SETTLE);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add cards" })).toBeNull(), SETTLE);
    expect(scanner).toHaveTextContent("their side");

    await userEvent.click(within(scanner).getByRole("button", { name: "Close the scanner" }));
    await sheetGone();
    // The caret's way back is the press that started it all.
    expect(opener).toHaveFocus();
  });
});

describe("Finish trade", () => {
  const questions = (sheet: HTMLElement) =>
    within(sheet)
      .getAllByRole("checkbox")
      .map((box) => (box as HTMLInputElement).checked);

  it("opens on the defaults, says what each would move, and finishes with them", async () => {
    const finish = vi.spyOn(ipc, "tradeFinish");
    openTrade();
    await userEvent.click(await screen.findByRole("button", { name: "Finish trade" }, SETTLE));
    const sheet = await screen.findByRole("dialog", { name: "Finish trade" }, SETTLE);
    expect(sheet).toHaveTextContent("Trade 5 · opened 2 Oct 2026");
    expect(sheet).toHaveTextContent("$64.39");
    expect(sheet).toHaveTextContent("$87.09");
    expect(sheet).toHaveTextContent("$22.70");

    // Three that tidy up after a trade are on; wishing the given cards back is not.
    expect(questions(sheet)).toEqual([true, true, true, false]);
    expect(
      within(sheet).getByRole("checkbox", {
        name: "Take the cards you gave out of your collection",
      }),
    ).toHaveAccessibleDescription("6 cards. All of them are in your collection.");
    expect(
      within(sheet).getByRole("checkbox", {
        name: "Add the cards you received to your collection",
      }),
    ).toHaveAccessibleDescription("5 cards, in the printing and finish shown in the trade.");
    expect(
      within(sheet).getByRole("checkbox", {
        name: "Take the cards you received off your wishlist",
      }),
    ).toHaveAccessibleDescription("2 of them are on it: Urza's Saga, Tarmogoyf.");
    expect(within(sheet).getByRole("button", { name: "File under: Collection" })).toBeInTheDocument();

    await userEvent.click(within(sheet).getByRole("button", { name: "Finish trade" }));

    await waitFor(() => expect(finish).toHaveBeenCalledTimes(1));
    expect(finish).toHaveBeenCalledWith(5, {
      removeGiven: true,
      addReceived: true,
      folderId: null,
      unwishReceived: true,
      wishGiven: false,
    });
    await sheetGone();
    // The page stays, as the finished trade, and says what the finish did.
    expect(
      await screen.findByText(
        "Finished and archived, so nothing here can be edited. Finishing it took 6 cards out of your collection, added 5 cards to your collection and took 2 cards off your wishlist.",
        undefined,
        SETTLE,
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "You gave" })).toBeInTheDocument();
    expect(balance()).toHaveTextContent("You owed them");
    expect((await stored()).status).toBe("finished");

    // Reopened, the same page's sheet starts over from this trade's defaults — all off now —
    // and not from the four answers the finish above was sent with.
    await userEvent.click(screen.getByRole("button", { name: "Reopen" }));
    await userEvent.click(await screen.findByRole("button", { name: "Finish trade" }, SETTLE));
    const again = await screen.findByRole("dialog", { name: "Finish trade" }, SETTLE);
    expect(questions(again)).toEqual([false, false, false, false]);
  });

  it("files received cards under the folder picked in the sheet", async () => {
    const finish = vi.spyOn(ipc, "tradeFinish");
    openTrade();
    await userEvent.click(await screen.findByRole("button", { name: "Finish trade" }, SETTLE));
    const sheet = await screen.findByRole("dialog", { name: "Finish trade" }, SETTLE);

    await userEvent.click(within(sheet).getByRole("button", { name: "File under: Collection" }));
    const folders = await within(sheet).findByRole("list", { name: "Folders" }, SETTLE);
    await userEvent.click(await within(folders).findByRole("button", { name: /^Binder/ }, SETTLE));

    // Back on the questions, with the folder named on its press and nothing forgotten.
    expect(
      await within(sheet).findByRole("button", { name: "File under: Binder" }),
    ).toBeInTheDocument();
    expect(questions(sheet)).toEqual([true, true, true, false]);

    await userEvent.click(within(sheet).getByRole("button", { name: "Finish trade" }));
    await waitFor(() => expect(finish).toHaveBeenCalledTimes(1));
    expect(finish.mock.calls[0]?.[1]).toMatchObject({ addReceived: true, folderId: 1 });

    // The finish closed the sheet from outside, and what was picked in it went with it: reopened,
    // the trade's sheet starts from this trade's defaults — all off now, and no folder.
    await sheetGone();
    await userEvent.click(await screen.findByRole("button", { name: "Reopen" }, SETTLE));
    await userEvent.click(await screen.findByRole("button", { name: "Finish trade" }, SETTLE));
    const again = await screen.findByRole("dialog", { name: "Finish trade" }, SETTLE);
    expect(questions(again)).toEqual([false, false, false, false]);
    expect(within(again).getByRole("button", { name: "File under: Collection" })).toBeInTheDocument();
  });

  it("opens with everything off on a trade that was finished before", async () => {
    openTrade(2);
    // Finished once already: reopening it undoes nothing the first finish did.
    await userEvent.click(await screen.findByRole("button", { name: "Reopen" }, SETTLE));
    await userEvent.click(await screen.findByRole("button", { name: "Finish trade" }, SETTLE));
    const sheet = await screen.findByRole("dialog", { name: "Finish trade" }, SETTLE);

    expect((await stored(2)).finishedBefore).toBe(true);
    expect(questions(sheet)).toEqual([false, false, false, false]);
    expect(sheet).toHaveTextContent("This trade was finished once already");
    // A folder for cards that are not being added is a choice about nothing.
    expect(within(sheet).getByRole("button", { name: "File under: Collection" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });

  it("forgets what was ticked when the sheet is left", async () => {
    openTrade();
    await userEvent.click(await screen.findByRole("button", { name: "Finish trade" }, SETTLE));
    let sheet = await screen.findByRole("dialog", { name: "Finish trade" }, SETTLE);
    await userEvent.click(
      within(sheet).getByRole("checkbox", { name: "Put the cards you gave on your wishlist" }),
    );
    expect(questions(sheet)).toEqual([true, true, true, true]);

    await userEvent.click(within(sheet).getByRole("button", { name: "Cancel" }));
    await sheetGone();
    expect((await stored()).status).toBe("open");

    await userEvent.click(screen.getByRole("button", { name: "Finish trade" }));
    sheet = await screen.findByRole("dialog", { name: "Finish trade" }, SETTLE);
    expect(questions(sheet)).toEqual([true, true, true, false]);
  });
});

describe("a closed trade", () => {
  it("is a record: nothing to add, nothing to open, Reopen and Duplicate in place of the rest", async () => {
    openTrade(2);
    const mine = await side("You gave");
    const theirs = await side("They gave");

    expect(
      screen.getByText(
        "Finished and archived, so nothing here can be edited. Finishing it took 3 cards out of your collection, added 3 cards to your collection and took 1 card off your wishlist.",
      ),
    ).toBeInTheDocument();
    // The lines are drawn, and none of them is a press.
    expect(within(mine).getAllByRole("listitem")).toHaveLength(2);
    expect(within(theirs).getAllByRole("listitem")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: /^Edit / })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Add cards/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Price for/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Archive" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Finish trade" })).toBeNull();
    expect(screen.getByRole("button", { name: "Reopen" })).toBeInTheDocument();
    expect(within(balance()).getByRole("button", { name: "Duplicate" })).toBeInTheDocument();

    // The prices it closed with, and the balance as a record: 7.18 against 4.83.
    expect(balance()).toHaveTextContent("$7.18");
    expect(balance()).toHaveTextContent("$4.83");
    expect(balance()).toHaveTextContent("They owed you");
    expect(balance()).toHaveTextContent("$2.35");
  });

  it("says an archived trade was never finished, and that it still owes", async () => {
    openTrade(1);
    expect(
      await screen.findByText(/^Archived without finishing, so nothing here can be edited\./, undefined, SETTLE),
    ).toBeInTheDocument();
    expect(balance()).toHaveTextContent("You owe them");
    expect(balance()).toHaveTextContent("$3.75");
    expect(screen.queryByRole("button", { name: /^Edit / })).toBeNull();
  });

  it("duplicates into a new open trade and goes to it", async () => {
    openTrade(2);
    await userEvent.click(await screen.findByRole("button", { name: "Duplicate" }, SETTLE));

    expect(
      await screen.findByRole("heading", { level: 2, name: "Trade 2 copy" }, SETTLE),
    ).toBeInTheDocument();
    expect(window.location.pathname).toBe("/trade/6");
    expect(await screen.findByRole("button", { name: "Finish trade" }, SETTLE)).toBeInTheDocument();
    expect((await stored(6)).status).toBe("open");
  });
});

/**
 * A copy that sits in a deck is offered and can be traded, and a finish takes it out of the deck.
 * So every surface that shows one draws it in the destructive colour, names the deck, and never
 * mixes it in with the copies that cost the reader nothing but the card.
 *
 * **Over facts these tests set themselves**, laid on the seed's trades as each is read: which of
 * the seed's lines happens to have a copy in a deck is the fake's to change, and none of these
 * should care.
 */
describe("the copies a deck is holding", () => {
  type Facts = Partial<Pick<TradeLine, "owned" | "ownedInDecks" | "deckNames" | "source">>;

  /**
   * One trade with no line in any deck but the ones named here, by the card's name — or, handed
   * a function, with every line's facts as it answers.
   */
  const held =
    (
      lines: Record<string, Facts> | ((line: TradeLine) => Facts),
      over: Partial<Trade> = {},
      id = 5,
    ) =>
    (own: CommandTable): CommandTable => ({
      trade_get: (args: never) => {
        const trade = own.trade_get(args) as Trade | null;
        if (trade === null || trade.id !== id) return trade;
        return {
          ...trade,
          ...over,
          lines: trade.lines.map((line) => ({
            ...line,
            ownedInDecks: 0,
            deckNames: [],
            ...(typeof lines === "function" ? lines(line) : lines[line.name]),
          })),
        };
      },
    });

  const deckMark = (within_: HTMLElement) =>
    within_.querySelector<HTMLElement>('[data-mark="deck"]');

  it("says so in red under the stepper as a step reaches into a deck, and on the line behind", async () => {
    renderPhone(<PhoneFace />, {
      path: "/trade/5",
      fake: TRADES,
      commands: held({
        Counterspell: { owned: 2, ownedInDecks: 1, deckNames: ["Serah"] },
        // Theirs: the facts arrive on their lines too, and nothing is ever taken for one.
        "Sol Ring": { ownedInDecks: 1, deckNames: ["Azula"] },
      }),
    });
    // The facts above are laid over the trade; the copy a step reaches is the collection's own.
    await ownOneMore(18);
    const sheet = await edit("Counterspell", "MH2 267 · Etched");

    // Two copies, and two are held outside every deck: the gold words, and an empty line in red.
    expect(sheet).toHaveTextContent("Your side · from your collection · 3 owned");
    expect(deckMark(sheet)).toBeEmptyDOMElement();

    await userEvent.click(within(sheet).getByRole("button", { name: "One more Counterspell" }));

    await waitFor(() => expect(deckMark(sheet)).toHaveTextContent("1 from your deck Serah"), SETTLE);
    expect(deckMark(sheet)?.classList.contains("text-destructive")).toBe(true);
    // A live region that was there before its words: the line arriving is what is announced.
    expect(deckMark(sheet)).toHaveAttribute("role", "status");
    // Never both: a line that reaches into a deck does not also say the gold words.
    expect(sheet).not.toHaveTextContent("from your collection");

    await userEvent.click(within(sheet).getByRole("button", { name: "One fewer Counterspell" }));
    await waitFor(() => expect(deckMark(sheet)).toBeEmptyDOMElement(), SETTLE);
    expect(sheet).toHaveTextContent("Your side · from your collection · 3 owned");

    await userEvent.click(within(sheet).getByRole("button", { name: "One more Counterspell" }));
    await waitFor(() => expect(deckMark(sheet)).not.toBeEmptyDOMElement(), SETTLE);
    await userEvent.click(within(sheet).getByRole("button", { name: "Close card" }));
    await sheetGone();

    // The line on the page says it too, in the same words and colour, and it is read with the
    // press — before the figures.
    const line = screen.getByRole("button", { name: "Edit Counterspell, MH2 267 · Etched" });
    await waitFor(() => expect(deckMark(line)).toHaveTextContent("1 from your deck Serah"), SETTLE);
    expect(deckMark(line)?.classList.contains("text-destructive")).toBe(true);
    expect(line).toHaveAccessibleDescription(/^1 from your deck Serah 3 × \$3\.25/);

    // A line that reaches into no deck wears no such mark, and neither does a card on their side.
    expect(deckMark(screen.getByRole("button", { name: /^Edit Boros Charm/ }))).toBeNull();
    const theirs = screen.getByRole("button", { name: "Edit Sol Ring, C21 263 · Nonfoil" });
    expect(deckMark(theirs)).toBeNull();
    expect(theirs).not.toHaveTextContent("from your deck");
  });

  it("says nothing of a deck on their card's own sheet", async () => {
    renderPhone(<PhoneFace />, {
      path: "/trade/5",
      fake: TRADES,
      commands: held({ "Sol Ring": { ownedInDecks: 2, deckNames: ["Azula"] } }),
    });
    const sheet = await edit("Sol Ring", "C21 263 · Nonfoil");

    expect(sheet).toHaveTextContent("Their side");
    expect(deckMark(sheet)).toBeEmptyDOMElement();
    expect(sheet).not.toHaveTextContent("Azula");
  });

  /** The collection, answering the read that names the deck groups apart from the other. */
  const cabinet = (outside: Partial<CollectionRow>[], inDecks: Partial<CollectionRow>[]) => {
    const copy = (over: Partial<CollectionRow>, id: number) =>
      ({
        id,
        folderId: null,
        folderName: null,
        oracleId: `oracle-${over.cardId}`,
        setCode: "c21",
        collectorNumber: "263",
        rarity: "uncommon",
        finish: "nonfoil",
        condition: "NM",
        quantity: 1,
        unitPrice: 1.12,
        proxy: false,
        ...over,
      }) as CollectionRow;
    const folder = (id: number, name: string, kind: string): CollectionFolder => ({
      rules: [],
      id,
      parentId: null,
      name,
      kind,
      deckId: kind === "deck" ? id : null,
      sortOrder: id,
      locked: false,
      syncUid: null,
    });
    return (): CommandTable => ({
      collection_folder_list: () => [
        folder(7, "Binder", "user"),
        folder(11, "Serah", "deck"),
        folder(12, "Azula", "deck"),
        folder(10, "Recently removed", "removed"),
      ],
      collection_list: ((args: { query: CollectionQuery }) => {
        const rows = args.query.shelves === undefined ? outside : inDecks;
        const items = rows.map((row, i) => copy(row, i + 1));
        return { items, total: items.length };
      }) as never,
    });
  };

  const addSheet = async () => {
    await userEvent.click(
      await screen.findByRole("button", { name: "Add cards to your side" }, SETTLE),
    );
    return await screen.findByRole("dialog", { name: "Add cards" }, SETTLE);
  };

  it("offers them in a section of their own, under the others and in the destructive colour", async () => {
    const add = vi.spyOn(ipc, "tradeAddLines").mockResolvedValue(undefined);
    const ring = { cardId: "ring", name: "Sol Ring" };
    renderPhone(<PhoneFace />, {
      path: "/trade/5",
      fake: TRADES,
      commands: cabinet(
        [{ ...ring, folderId: 7, folderName: "Binder", quantity: 2 }],
        [
          { ...ring, folderId: 11, folderName: "Serah" },
          { ...ring, folderId: 12, folderName: "Azula", quantity: 2 },
          // The holding area is not a deck, whatever an answer says: never offered.
          { cardId: "vault", name: "Sol Vault", folderId: 10, folderName: "Recently removed" },
        ],
      ),
    });
    const sheet = await addSheet();

    await userEvent.type(within(sheet).getByRole("searchbox", { name: "Search your collection" }), "sol");
    const decks = await within(sheet).findByRole("list", { name: "In your decks" }, SETTLE);
    const ordinary = within(sheet).getByRole("list", { name: "Cards in your collection" });

    // Two lists, never one: the copies outside a deck first, the decks' own after them.
    expect(ordinary.compareDocumentPosition(decks) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(ordinary).getAllByRole("listitem")).toHaveLength(1);
    expect(within(ordinary).getByRole("listitem")).toHaveTextContent("2 owned");
    const [inSerah, inAzula] = within(decks).getAllByRole("listitem");
    expect(within(decks).getAllByRole("listitem")).toHaveLength(2);
    expect(sheet).not.toHaveTextContent("Sol Vault");

    // The section is headed and warned about in words, both in the destructive colour.
    const section = within(sheet).getByRole("region", { name: "In your decks" });
    expect(section).toContainElement(decks);
    expect(section).not.toContainElement(ordinary);
    expect(section).toHaveAccessibleDescription(
      "A finished trade takes these out of their decks, once your copies outside any deck have run out.",
    );
    const heading = within(section).getByRole("heading", { name: "In your decks" });
    expect(heading.parentElement?.classList.contains("text-destructive")).toBe(true);

    // Each row names its deck and draws its words in that colour; an ordinary row does not.
    expect(inSerah).toHaveTextContent("1 in Serah");
    expect(inAzula).toHaveTextContent("2 in Azula");
    expect(inSerah).not.toHaveTextContent("owned");
    for (const words of ["Sol Ring", "C21 263 · Nonfoil", "1 in Serah"]) {
      expect(within(inSerah).getByText(words).classList.contains("text-destructive")).toBe(true);
    }
    const plain = within(ordinary).getByRole("listitem");
    for (const words of ["Sol Ring", "C21 263 · Nonfoil", "2 owned"]) {
      expect(within(plain).getByText(words).classList.contains("text-destructive")).toBe(false);
    }
    expect(sheet).toHaveTextContent("1 match in your collection, 2 in your decks.");

    // The deck rides in the press's name: one printing in two decks is two presses.
    const press = within(decks).getByRole("button", {
      name: "Add Sol Ring, C21 263 · Nonfoil, from your deck Azula",
    });
    expect(press.classList.contains("text-destructive")).toBe(true);
    expect(
      within(ordinary)
        .getByRole("button", { name: "Add Sol Ring, C21 263 · Nonfoil" })
        .classList.contains("text-destructive"),
    ).toBe(false);

    await userEvent.click(press);

    // A line like any other: where its copies come from is the line's own facts to say.
    expect(add).toHaveBeenCalledExactlyOnceWith(5, "mine", [
      { cardId: "ring", finish: "nonfoil", quantity: 1, source: "collection" },
    ]);
  });

  /**
   * What the owner hit: three Sol Rings, every one of them sleeved, and a search from a trade
   * that answered *nothing in your collection matches*.
   */
  it("finds a card whose every copy is in a deck, and never says nothing matches over it", async () => {
    renderPhone(<PhoneFace />, {
      path: "/trade/5",
      fake: TRADES,
      commands: cabinet([], [{ cardId: "ring", name: "Sol Ring", folderId: 11 }]),
    });
    const sheet = await addSheet();

    await userEvent.type(within(sheet).getByRole("searchbox", { name: "Search your collection" }), "sol");
    const decks = await within(sheet).findByRole("list", { name: "In your decks" }, SETTLE);

    expect(within(decks).getByRole("listitem")).toHaveTextContent("1 in Serah");
    expect(within(sheet).queryByRole("list", { name: "Cards in your collection" })).toBeNull();
    await waitFor(() => expect(sheet).toHaveTextContent("1 match, in your decks only."), SETTLE);
    expect(sheet).not.toHaveTextContent("Nothing in your collection matches");
    // The way out to every card is still offered.
    expect(within(sheet).getByRole("button", { name: "Search all cards for “sol”" })).toBeInTheDocument();
  });

  it("warns in the finish sheet, in red and as part of the question, and not where no deck is touched", async () => {
    renderPhone(<PhoneFace />, {
      path: "/trade/5",
      fake: TRADES,
      commands: held({
        // Two asked for, one held outside a deck: the second comes out of Serah.
        Counterspell: { owned: 1, ownedInDecks: 1, deckNames: ["Serah"] },
        "Sol Ring": { ownedInDecks: 1, deckNames: ["Azula"] },
      }),
    });
    await userEvent.click(await screen.findByRole("button", { name: "Finish trade" }, SETTLE));
    const sheet = await screen.findByRole("dialog", { name: "Finish trade" }, SETTLE);
    const remove = within(sheet).getByRole("checkbox", {
      name: "Take the cards you gave out of your collection",
    });
    const note = "1 of them comes out of a deck: Serah. That deck will be short of it.";

    expect(remove).toHaveAccessibleDescription(`6 cards. All of them are in your collection. ${note}`);
    const warning = within(sheet).getByText(note);
    expect(warning.parentElement?.classList.contains("text-destructive")).toBe(true);
    // Under the question it belongs to, and above the next one.
    const next = within(sheet).getByRole("checkbox", {
      name: "Add the cards you received to your collection",
    });
    expect(remove.compareDocumentPosition(warning) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(warning.compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Their card in a deck of the reader's is no part of it.
    expect(sheet).not.toHaveTextContent("Azula");
  });

  it("draws no deck line in the finish sheet where no given card comes out of one", async () => {
    renderPhone(<PhoneFace />, {
      path: "/trade/5",
      fake: TRADES,
      // A deck holds another Counterspell, and the line does not reach for it.
      commands: held({ Counterspell: { owned: 2, ownedInDecks: 1, deckNames: ["Serah"] } }),
    });
    await userEvent.click(await screen.findByRole("button", { name: "Finish trade" }, SETTLE));
    const sheet = await screen.findByRole("dialog", { name: "Finish trade" }, SETTLE);

    expect(
      within(sheet).getByRole("checkbox", {
        name: "Take the cards you gave out of your collection",
      }),
    ).toHaveAccessibleDescription("6 cards. All of them are in your collection.");
    expect(sheet).not.toHaveTextContent("out of a deck");
    expect(sheet).not.toHaveTextContent("Serah");
  });

  /**
   * A line's facts are live on a closed trade, so there they say what *another* finish would
   * take. What this one took is the banner's to say; no line is marked as about to.
   */
  it("says in a finished trade's note what came out of decks, and marks none of its lines", async () => {
    renderPhone(<PhoneFace />, {
      path: "/trade/2",
      fake: TRADES,
      commands: held(
        // Every line still has a copy in a deck, and none outside one.
        () => ({ owned: 0, ownedInDecks: 1, deckNames: ["Serah"] }),
        {
          outcome: {
            removedFromCollection: 3,
            removedFromDecks: 1,
            addedToCollection: 3,
            removedFromWishlist: 1,
            addedToWishlist: 0,
          },
        },
        2,
      ),
    });
    const mine = await side("You gave");

    expect(
      screen.getByText(
        "Finished and archived, so nothing here can be edited. Finishing it took 3 cards out of your collection (1 from a deck), added 3 cards to your collection and took 1 card off your wishlist.",
      ),
    ).toBeInTheDocument();
    expect(deckMark(mine)).toBeNull();
    expect(mine).not.toHaveTextContent("from your deck");
  });
});

describe("New trade", () => {
  it("creates an unnamed trade at the reader's marketplace and opens it", async () => {
    const create = vi.spyOn(ipc, "tradeCreate");
    renderPhone(<PhoneFace />, { path: "/trade", fake: TRADES });
    await userEvent.click(await screen.findByRole("button", { name: "New trade" }, SETTLE));
    const sheet = await screen.findByRole("dialog", { name: "New trade" }, SETTLE);
    expect(sheet).toHaveTextContent("It opens empty. Cards go on once it is open.");
    // The likeliest name, as a placeholder — never typed in for the reader.
    const name = within(sheet).getByRole("textbox", { name: "Name" });
    expect(name).toHaveValue("");
    expect(name).toHaveAttribute("placeholder", "Trade 6");
    expect(within(sheet).getByRole("button", { name: "Prices from" })).toHaveTextContent("TCGplayer");

    await userEvent.click(within(sheet).getByRole("button", { name: "Create trade" }));

    await waitFor(() => expect(create).toHaveBeenCalledWith({ marketplace: "tcgplayer" }));
    expect(await screen.findByRole("heading", { level: 2, name: "Trade 6" }, SETTLE)).toBeInTheDocument();
    expect(window.location.pathname).toBe("/trade/6");
    // Empty, and each side says so.
    expect(await screen.findAllByText("Nothing on this side yet.")).toHaveLength(2);
    expect(balance()).toHaveTextContent("Nobody owes anything");
  });

  it("takes a typed name and another marketplace", async () => {
    const create = vi.spyOn(ipc, "tradeCreate");
    renderPhone(<PhoneFace />, { path: "/trade", fake: TRADES });
    await userEvent.click(await screen.findByRole("button", { name: "New trade" }, SETTLE));
    const sheet = await screen.findByRole("dialog", { name: "New trade" }, SETTLE);

    await userEvent.type(within(sheet).getByRole("textbox", { name: "Name" }), "  Friday swaps ");
    await userEvent.click(within(sheet).getByRole("button", { name: "Prices from" }));
    await userEvent.click(await screen.findByRole("option", { name: /Cardmarket/ }));
    await userEvent.click(within(sheet).getByRole("button", { name: "Create trade" }));

    await waitFor(() =>
      expect(create).toHaveBeenCalledWith({ marketplace: "cardmarket", name: "Friday swaps" }),
    );
    expect(
      await screen.findByRole("heading", { level: 2, name: "Friday swaps" }, SETTLE),
    ).toBeInTheDocument();
    // The trade's own currency, whatever the reader's marketplace is.
    expect(balance()).toHaveTextContent("€0.00");
  });

  it("leaves the reader on the list when it is cancelled", async () => {
    const create = vi.spyOn(ipc, "tradeCreate");
    renderPhone(<PhoneFace />, { path: "/trade", fake: TRADES });
    const opener = await screen.findByRole("button", { name: "New trade" }, SETTLE);
    await userEvent.click(opener);
    const sheet = await screen.findByRole("dialog", { name: "New trade" }, SETTLE);

    await userEvent.click(within(sheet).getByRole("button", { name: "Cancel" }));

    await sheetGone();
    expect(create).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe("/trade");
    expect(opener).toHaveFocus();
  });
});

describe("a trade's other actions", () => {
  const more = async (): Promise<HTMLElement> => {
    await userEvent.click(await screen.findByRole("button", { name: "More actions" }, SETTLE));
    return await screen.findByRole("dialog", undefined, SETTLE);
  };

  it("renames an open trade", async () => {
    openTrade();
    const sheet = await more();
    await userEvent.click(within(sheet).getByRole("button", { name: "Rename" }));
    const name = await within(sheet).findByRole("textbox", { name: "Name" });
    expect(name).toHaveValue("Trade 5");

    await userEvent.clear(name);
    await userEvent.type(name, "Friday swaps");
    await userEvent.click(within(sheet).getByRole("button", { name: "Rename trade" }));

    await waitFor(async () => expect((await stored()).name).toBe("Friday swaps"));
    expect(
      await screen.findByRole("heading", { level: 2, name: "Friday swaps" }, SETTLE),
    ).toBeInTheDocument();
  });

  it("refuses a rename on a closed trade, in words on the row", async () => {
    openTrade(2);
    const sheet = await more();
    const rename = within(sheet).getByRole("button", { name: /^Rename/ });
    expect(rename).toHaveAttribute("aria-disabled", "true");
    expect(rename).toHaveTextContent("Reopen the trade to rename it.");
    // Duplicate and Delete are still offered on a record.
    expect(within(sheet).getByRole("button", { name: "Duplicate" })).toBeInTheDocument();
    expect(within(sheet).getByRole("button", { name: "Delete…" })).toBeInTheDocument();
  });

  it("asks before deleting, and lands on the list without the trade", async () => {
    const remove = vi.spyOn(ipc, "tradeDelete");
    openTrade(4);
    const sheet = await more();
    await userEvent.click(within(sheet).getByRole("button", { name: "Delete…" }));

    // A question first: nothing is deleted by the row's own press.
    const question = await screen.findByRole("dialog", { name: "Delete this trade" }, SETTLE);
    expect(remove).not.toHaveBeenCalled();
    expect(question).toHaveTextContent("Trade 4 and every card on it will be deleted.");

    await userEvent.click(within(question).getByRole("button", { name: "Delete trade" }));

    await waitFor(() => expect(remove).toHaveBeenCalledWith(4));
    expect(await screen.findByRole("region", { name: "Open · 1" }, SETTLE)).toBeInTheDocument();
    expect(window.location.pathname).toBe("/trade");
    expect(screen.queryByRole("link", { name: /^Trade 4\./ })).toBeNull();
  });
});

/**
 * `trades.id` is a plain `INTEGER PRIMARY KEY`, and the fake's is the same `max + 1`: the newest
 * trade's number is handed out again once that trade is deleted. What the cache last heard about
 * that number is then about a trade that is gone.
 */
describe("an id that is handed out again", () => {
  /** Whether the page ever said the trade is gone, however briefly, while `during` ran. */
  async function saidGone(during: () => Promise<void>): Promise<boolean> {
    let said = false;
    const look = () => {
      if (screen.queryByText("That trade is gone.") !== null) said = true;
    };
    const watch = new MutationObserver(look);
    watch.observe(document.body, { childList: true, subtree: true, characterData: true });
    try {
      await during();
    } finally {
      look();
      watch.disconnect();
    }
    return said;
  }

  it("opens the trade made after the newest was deleted, and never calls it gone", async () => {
    openTrade(5);
    await userEvent.click(await screen.findByRole("button", { name: "More actions" }, SETTLE));
    const sheet = await screen.findByRole("dialog", undefined, SETTLE);
    await userEvent.click(within(sheet).getByRole("button", { name: "Delete…" }));
    const question = await screen.findByRole("dialog", { name: "Delete this trade" }, SETTLE);
    await userEvent.click(within(question).getByRole("button", { name: "Delete trade" }));
    await screen.findByRole("region", { name: "Open · 1" }, SETTLE);

    const gone = await saidGone(async () => {
      await userEvent.click(screen.getByRole("button", { name: "New trade" }));
      const fresh = await screen.findByRole("dialog", { name: "New trade" }, SETTLE);
      await userEvent.click(within(fresh).getByRole("button", { name: "Create trade" }));
      // The deleted trade's own number, and an empty trade under it.
      await waitFor(() => expect(window.location.pathname).toBe("/trade/5"), SETTLE);
      expect(
        await screen.findAllByText("Nothing on this side yet.", undefined, SETTLE),
      ).toHaveLength(2);
    });

    expect(gone).toBe(false);
    expect(screen.getByRole("heading", { level: 2, name: "Trade 5" })).toBeInTheDocument();
    expect(balance()).toHaveTextContent("Nobody owes anything");
  });

  it("waits for the read in the air before saying a trade is gone", async () => {
    openTrade(6);
    expect(await screen.findByText("That trade is gone.", undefined, SETTLE)).toBeInTheDocument();
    // Made behind this page's back — another window, the other face — so nothing told the cache,
    // which still holds "no such trade" under the number.
    expect(await ipc.tradeCreate({ marketplace: "tcgplayer" })).toBe(6);
    await userEvent.click(screen.getByRole("link", { name: "All trades" }));

    const gone = await saidGone(async () => {
      await userEvent.click(await screen.findByRole("link", { name: /^Trade 6\./ }, SETTLE));
      expect(
        await screen.findByRole("heading", { level: 2, name: "Trade 6" }, SETTLE),
      ).toBeInTheDocument();
    });

    expect(gone).toBe(false);
  });
});

describe("a press that lands twice", () => {
  it("makes one copy however many times Duplicate is pressed", async () => {
    const duplicate = vi.spyOn(ipc, "tradeDuplicate");
    openTrade(2);
    const button = await screen.findByRole("button", { name: "Duplicate" }, SETTLE);

    // Back to back, with no time for the first to answer: a thumb landing twice.
    fireEvent.click(button);
    fireEvent.click(button);

    expect(
      await screen.findByRole("heading", { level: 2, name: "Trade 2 copy" }, SETTLE),
    ).toBeInTheDocument();
    expect(duplicate).toHaveBeenCalledTimes(1);
    expect(await ipc.tradeList()).toHaveLength(6);
  });

  it("archives once, and says nothing about a trade that is no longer open", async () => {
    const archive = vi.spyOn(ipc, "tradeArchive");
    openTrade();
    const button = await screen.findByRole("button", { name: "Archive" }, SETTLE);

    fireEvent.click(button);
    fireEvent.click(button);

    expect(
      await screen.findByText(/^Archived without finishing/, undefined, SETTLE),
    ).toBeInTheDocument();
    expect(archive).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  /**
   * The gap a guard on the write alone leaves open: the write has answered, the read that follows
   * it has not, and the page still draws the open trade with its Archive button.
   */
  it("holds the press until the page has caught up with the write, not only until it answers", async () => {
    let held = false;
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    renderPhone(<PhoneFace />, {
      path: "/trade/5",
      fake: TRADES,
      commands: (own) => ({
        trade_get: async (args: never) => {
          if (held) await gate;
          return own.trade_get(args);
        },
      }),
    });
    const archive = vi.spyOn(ipc, "tradeArchive");
    const button = await screen.findByRole("button", { name: "Archive" }, SETTLE);

    held = true;
    fireEvent.click(button);
    await waitFor(() => expect(archive).toHaveBeenCalledTimes(1));
    await archive.mock.results[0]?.value;
    await waitFor(async () =>
      expect((await ipc.tradeList()).find((trade) => trade.id === 5)?.status).toBe("archived"),
    );
    // Stored as archived, drawn as open: the read is still out.
    const still = screen.getByRole("button", { name: "Archive" });
    expect(still).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(still);

    release();
    expect(
      await screen.findByText(/^Archived without finishing/, undefined, SETTLE),
    ).toBeInTheDocument();
    expect(archive).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alert")).toBeNull();
    // And the hold was about that one press: what stands in Archive's place can be pressed.
    expect(screen.getByRole("button", { name: "Reopen" })).not.toHaveAttribute("aria-disabled");
  });

  it("lets go of a press the backend refused, so it can be made again", async () => {
    let refuse = true;
    renderPhone(<PhoneFace />, {
      path: "/trade/5",
      fake: TRADES,
      commands: (own) => ({
        trade_archive: (args: never) => {
          if (refuse) throw new Error("database is locked");
          return own.trade_archive(args);
        },
      }),
    });
    const button = await screen.findByRole("button", { name: "Archive" }, SETTLE);
    await userEvent.click(button);
    expect(await screen.findByRole("alert", undefined, SETTLE)).toHaveTextContent(
      "database is locked",
    );

    refuse = false;
    await userEvent.click(screen.getByRole("button", { name: "Archive" }));
    expect(
      await screen.findByText(/^Archived without finishing/, undefined, SETTLE),
    ).toBeInTheDocument();
  });
});

describe("where the caret goes when a sheet's own press leaves the page", () => {
  const name = (text: string) => screen.getByRole("heading", { level: 2, name: text });

  it("lands on the trade's name after a finish, whose button becomes Duplicate", async () => {
    openTrade();
    await userEvent.click(await screen.findByRole("button", { name: "Finish trade" }, SETTLE));
    const sheet = await screen.findByRole("dialog", { name: "Finish trade" }, SETTLE);

    await userEvent.click(within(sheet).getByRole("button", { name: "Finish trade" }));

    await sheetGone();
    await screen.findByText(/^Finished and archived/, undefined, SETTLE);
    // Still there once the page has redrawn as the finished trade — not on `<body>`.
    expect(name("Trade 5")).toHaveFocus();
  });

  it("lands on the trade's name when the line a sheet is open on leaves the trade", async () => {
    openTrade();
    const sheet = await edit("Counterspell", "MH2 267 · Etched");
    const more = within(sheet).getByRole("button", { name: "One more Counterspell" });
    // The other face removes the line; this one finds out on its next write, which is refused.
    await ipc.tradeRemoveLine(18);

    await userEvent.click(more);

    await sheetGone();
    expect(screen.queryByRole("button", { name: /^Edit Counterspell/ })).toBeNull();
    await waitFor(() => expect(name("Trade 5")).toHaveFocus());
  });

  it("lands on the trade's name when a line is removed, or moved, from its own sheet", async () => {
    openTrade();
    let sheet = await edit("Sol Ring", "C21 263 · Nonfoil");
    await userEvent.click(within(sheet).getByRole("button", { name: "Remove from trade" }));
    await sheetGone();
    await waitFor(() => expect(name("Trade 5")).toHaveFocus());

    sheet = await edit("Boros Charm", "GTC 148 · Nonfoil");
    expect(name("Trade 5")).not.toHaveFocus();
    await userEvent.click(within(sheet).getByRole("button", { name: "Move to their side" }));
    await sheetGone();
    await waitFor(() => expect(name("Trade 5")).toHaveFocus());
  });
});

describe("cards with no price", () => {
  /** The seed's Trade 5 with nothing on the reader's side priced, and their side at 80%. */
  const holes = (own: CommandTable): CommandTable => ({
    trade_get: (args: never) => {
      const trade = own.trade_get(args) as Trade | null;
      if (trade === null || trade.id !== 5) return trade;
      return {
        ...trade,
        rateTheirs: 80,
        lines: trade.lines.map((line) =>
          line.side === "mine" ? { ...line, unitPrice: null } : line,
        ),
      };
    },
    trade_list: (args: never) =>
      (own.trade_list(args) as TradeSummary[]).map((trade) =>
        trade.id !== 5
          ? trade
          : {
              ...trade,
              rateTheirs: 80,
              lines: trade.lines.map((line) =>
                line.side === "mine" ? { ...line, unitPrice: null } : line,
              ),
            },
      ),
  });

  it("says on a trade's row that its balance leaves cards out", async () => {
    renderPhone(<PhoneFace />, { path: "/trade", fake: TRADES, commands: holes });

    const row = await screen.findByRole("link", { name: /^Trade 5\./ }, SETTLE);
    // Nothing of theirs is set against anything of the reader's: 69.67 owed, over four lines.
    expect(row).toHaveAttribute(
      "aria-label",
      "Trade 5. Opened 2 Oct · 6 for 5 cards. You owe $69.67. 4 without a price",
    );
    expect(row).toHaveTextContent("4 without a price");
    // A trade whose every line has a price says nothing of the kind.
    expect(screen.getByRole("link", { name: /^Trade 4\./ })).not.toHaveTextContent(
      "without a price",
    );
  });

  it("says in the summary a finish is confirmed against what the totals leave out", async () => {
    renderPhone(<PhoneFace />, { path: "/trade/5", fake: TRADES, commands: holes });
    await userEvent.click(await screen.findByRole("button", { name: "Finish trade" }, SETTLE));
    const sheet = await screen.findByRole("dialog", { name: "Finish trade" }, SETTLE);

    expect(sheet).toHaveTextContent("You give$0.006 cards4 without a price");
    // A rated side: the full figure beside the adjusted one, as in the page's foot behind.
    expect(sheet).toHaveTextContent("They give$69.67$87.09 at 100%5 cards");
  });
});

describe("whose prices a new trade can use", () => {
  const CK = "Switch the app to Card Kingdom in Settings to trade in its prices.";
  const MP = "Switch the app to Mana Pool in Settings to trade in its prices.";
  const newTrade = async (): Promise<HTMLElement> => {
    await userEvent.click(await screen.findByRole("button", { name: "New trade" }, SETTLE));
    return await screen.findByRole("dialog", { name: "New trade" }, SETTLE);
  };
  const reasons = (sheet: HTMLElement) =>
    within(within(sheet).getByRole("list", { name: "Not offered" }))
      .getAllByRole("listitem")
      .map((item) => item.textContent);
  const options = () =>
    screen
      .getAllByRole("option")
      .map((row) => `${row.textContent}${row.getAttribute("aria-disabled") === "true" ? " ✗" : ""}`);

  it("offers neither feed while the app quotes something else, and says why in words", async () => {
    const create = vi.spyOn(ipc, "tradeCreate");
    renderPhone(<PhoneFace />, { path: "/trade", fake: TRADES });
    const sheet = await newTrade();

    // On the page, under the picker: a finger opens no tooltip.
    expect(reasons(sheet)).toEqual([CK, MP]);
    await userEvent.click(within(sheet).getByRole("button", { name: "Prices from" }));
    expect(options()).toEqual([
      "TCGplayerUSD",
      "CardmarketEUR",
      "Card KingdomUSD ✗",
      "Mana PoolUSD ✗",
    ]);

    // A press on one is refused, and the trade is made in the app's own marketplace.
    await userEvent.click(screen.getByRole("option", { name: /Card Kingdom/ }));
    await userEvent.keyboard("{Escape}");
    expect(within(sheet).getByRole("button", { name: "Prices from" })).toHaveTextContent(
      "TCGplayer",
    );
    await userEvent.click(within(sheet).getByRole("button", { name: "Create trade" }));
    await waitFor(() => expect(create).toHaveBeenCalledWith({ marketplace: "tcgplayer" }));
  });

  it("offers a feed while the app is set to it, and opens on it", async () => {
    const create = vi.spyOn(ipc, "tradeCreate");
    renderPhone(<PhoneFace />, {
      path: "/trade",
      fake: TRADES,
      commands: () => ({ get_marketplace: () => "cardkingdom" }),
    });
    const sheet = await newTrade();

    await waitFor(() =>
      expect(within(sheet).getByRole("button", { name: "Prices from" })).toHaveTextContent(
        "Card Kingdom",
      ),
    );
    expect(reasons(sheet)).toEqual([MP]);
    await userEvent.click(within(sheet).getByRole("button", { name: "Create trade" }));
    await waitFor(() => expect(create).toHaveBeenCalledWith({ marketplace: "cardkingdom" }));
  });
});
