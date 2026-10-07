import { useState } from "react";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("../../../.storybook/fake/core"));
vi.mock("@tauri-apps/api/event", () => import("../../../.storybook/fake/event"));
vi.mock("@tauri-apps/api/window", () => import("../../../.storybook/fake/window"));

import { NEEDS_A_FINISH_ROW, TRAY_ROWS } from "@/features/scanner/fixtures";
import { NEXT_DECISION_LABEL } from "@/features/scanner/reader/tray";
import type { ScannerTrayRow } from "@/lib/ipc";
import { renderPhone } from "../testing";
import { Tray } from "./Tray";

const SETTLE = { timeout: 3000 };
const [BOLT, SAGA, TOMB, LOTUS] = TRAY_ROWS;

/**
 * The tray over rows a test can read back, as the page holds them: `latest` is the cache the
 * page's `tray.latest()` answers from, and an edit is applied to *that*, never to the rows the
 * tray was last drawn with.
 */
function mount(
  start: ScannerTrayRow[],
  {
    flashKey = null,
    drawnLate = false,
  }: {
    flashKey?: string | null;
    /**
     * Draw an edit a tick after it is made, as the page does: its rows come back through the
     * tray's cache, so the tray is drawn once with the sheet shut and the rows as they were, and
     * again with the edit in them.
     */
    drawnLate?: boolean;
  } = {},
) {
  const held: {
    latest: ScannerTrayRow[];
    /** The tray changed from outside the panel — a commit, a card landing. */
    set: (rows: ScannerTrayRow[]) => void;
  } = { latest: start, set: () => {} };
  function Held() {
    const [rows, setRows] = useState(start);
    held.set = (next) => {
      held.latest = next;
      setRows(next);
    };
    return (
      <Tray
        rows={rows}
        flashKey={flashKey}
        onRows={(change) => {
          held.latest = change(held.latest);
          const drawn = held.latest;
          if (drawnLate) setTimeout(() => setRows(drawn), 0);
          else setRows(drawn);
        }}
      />
    );
  }
  renderPhone(<Held />);
  return held;
}

const row = (name: RegExp | string) => {
  const found = screen.getAllByRole("listitem").find((li) => within(li).queryByText(name) !== null);
  if (found === undefined) throw new Error(`no tray row for ${String(name)}`);
  return found;
};

describe("the phone's review tray", () => {
  it("says where scanned cards will appear, and counts none", () => {
    mount([]);
    expect(screen.getByText("Cards you scan appear here.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Scanned cards, 0 copies" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Scanned cards" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: NEXT_DECISION_LABEL })).toBeNull();
  });

  it("draws the rows in the order it is handed them, newest first, and counts copies", () => {
    mount([...TRAY_ROWS]);
    const names = screen
      .getAllByRole("listitem")
      .map((li) => li.querySelector("span.text-sm")?.textContent);
    expect(names).toEqual(["Lightning Bolt", "Urza's Saga", "Ancient Tomb", "Black Lotus"]);
    // Six copies in four rows: the count is copies.
    expect(screen.getByRole("heading", { name: "Scanned cards, 6 copies" })).toBeInTheDocument();
    expect(screen.getByText("1 card to pick")).toBeInTheDocument();
  });

  it("steps a quantity on the tray as it is, not as it was drawn", async () => {
    const held = mount([SAGA, TOMB]);
    // A card the pump landed since this tray was drawn.
    held.latest = [NEEDS_A_FINISH_ROW, ...held.latest];
    await userEvent.click(screen.getByRole("button", { name: "One more Urza's Saga — MH2 259" }));
    expect(held.latest.map((r) => [r.name, r.quantity])).toEqual([
      ["Lightning Bolt", 1],
      ["Urza's Saga", 4],
      ["Ancient Tomb", 1],
    ]);
    await userEvent.click(screen.getByRole("button", { name: "One fewer Urza's Saga — MH2 259" }));
    expect(held.latest[1].quantity).toBe(3);
  });

  it("stops the stepper at one copy, without leaving the tab order", async () => {
    const held = mount([TOMB]);
    const fewer = screen.getByRole("button", { name: "One fewer Ancient Tomb — TMP 315" });
    expect(fewer).toHaveAttribute("aria-disabled", "true");
    expect(fewer).not.toBeDisabled();
    await userEvent.click(fewer);
    expect(held.latest).toEqual([TOMB]);
    expect(within(row("Ancient Tomb")).getByRole("status")).toHaveTextContent("1");
  });

  it("removes the row its × names", async () => {
    const held = mount([SAGA, TOMB, LOTUS]);
    await userEvent.click(screen.getByRole("button", { name: "Remove Ancient Tomb — TMP 315" }));
    expect(held.latest).toEqual([SAGA, LOTUS]);
    await waitFor(() => expect(screen.queryByText("Ancient Tomb")).toBeNull());
  });

  it("opens a row's finish as a sheet of the four answers, and writes the one pressed", async () => {
    const held = mount([SAGA, TOMB]);
    await userEvent.click(
      screen.getByRole("button", { name: "Finish of Ancient Tomb — TMP 315: Foil" }),
    );
    const sheet = await screen.findByRole("dialog", { name: "Ancient Tomb" });
    const choices = within(within(sheet).getByRole("list", { name: "Finishes" })).getAllByRole("button");
    expect(choices.map((c) => c.textContent)).toEqual([
      "Nonfoil",
      "Foil",
      "Etched",
      "UnknownStays in the tray when you add the rest.",
    ]);
    // The one it is in is marked and is not a press.
    expect(within(sheet).getByRole("button", { name: "Foil" })).toHaveAttribute("aria-current", "true");

    await userEvent.click(within(sheet).getByRole("button", { name: "Etched" }));
    expect(held.latest[1]).toEqual({ ...TOMB, finish: "etched" });
    expect(held.latest[0]).toBe(SAGA);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(
      screen.getByRole("button", { name: "Finish of Ancient Tomb — TMP 315: Etched" }),
    ).toBeInTheDocument();
  });

  it("hands the caret back to the finish it changed, and to the press a dismissed sheet opened from", async () => {
    mount([SAGA, TOMB]);
    const opener = screen.getByRole("button", { name: "Finish of Ancient Tomb — TMP 315: Foil" });
    await userEvent.click(opener);
    await userEvent.click(
      within(await screen.findByRole("dialog", { name: "Ancient Tomb" })).getByRole("button", {
        name: "Etched",
      }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // Not on `body`: the row's finish, which now reads what was chosen.
    expect(
      screen.getByRole("button", { name: "Finish of Ancient Tomb — TMP 315: Etched" }),
    ).toHaveFocus();

    const printing = screen.getByRole("button", { name: "More printings of Urza's Saga — MH2 259" });
    await userEvent.click(printing);
    await screen.findByRole("dialog", { name: "Urza's Saga" });
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(printing).toHaveFocus();
  });

  /**
   * The press that opens the printings of a row still waiting on a pick is *More printings…*,
   * under its candidates. Choosing a printing settles the row — and the row is redrawn a tick
   * after the sheet shuts, so for that tick the press is still on the page: connected, and about
   * to go. A caret put back on it lands on `body` a moment later.
   */
  it("finds the press again on the row as it is redrawn, when the one that opened the sheet has gone", async () => {
    const held = mount([BOLT, SAGA], { drawnLate: true });
    const doomed = screen.getByRole("button", { name: "More printings of Lightning Bolt" });
    await userEvent.click(doomed);
    const sheet = await screen.findByRole("dialog", { name: "Lightning Bolt" });
    const list = await within(sheet).findByRole("list", { name: "Printings" }, SETTLE);
    const sld = within(list)
      .getAllByRole("button")
      .find((p) => /SLD · 1638/.test(p.getAttribute("aria-label") ?? ""));
    if (sld === undefined) throw new Error("the fake's Bolt printings lost SLD 1638");
    await userEvent.click(sld);

    const settled = await screen.findByRole("button", {
      name: "More printings of Lightning Bolt — SLD 1638",
    });
    expect(held.latest[0]).toMatchObject({ setCode: "sld", choices: [] });
    expect(doomed).not.toBeInTheDocument();
    await waitFor(() => expect(settled).toHaveFocus());
    expect(document.body).not.toHaveFocus();
  });

  it("leaves the caret where the reader put it when a sheet is closed by its scrim", async () => {
    mount([SAGA, TOMB]);
    const opener = screen.getByRole("button", { name: "Finish of Ancient Tomb — TMP 315: Foil" });
    await userEvent.click(opener);
    const sheet = await screen.findByRole("dialog", { name: "Ancient Tomb" });
    // The scrim is the dialog's backdrop: a press on it, outside the panel.
    const scrim = sheet.closest(".fixed");
    if (scrim === null) throw new Error("the sheet has no scrim");
    fireEvent.mouseDown(scrim);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(opener).not.toHaveFocus();
  });

  it("shuts a row's sheet when the row leaves the tray under it", async () => {
    const held = mount([SAGA, TOMB]);
    await userEvent.click(
      screen.getByRole("button", { name: "Finish of Ancient Tomb — TMP 315: Foil" }),
    );
    await screen.findByRole("dialog", { name: "Ancient Tomb" });
    // A commit took the row while its finish was being chosen.
    act(() => held.set([SAGA]));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.queryByText("Ancient Tomb")).toBeNull();
    expect(held.latest).toEqual([SAGA]);
  });

  it("asks for an unknown finish in gold, and only that one", () => {
    mount([NEEDS_A_FINISH_ROW, SAGA]);
    const unknown = screen.getByRole("button", { name: "Finish of Lightning Bolt — STA 105: Unknown" });
    const known = screen.getByRole("button", { name: "Finish of Urza's Saga — MH2 259: Nonfoil" });
    expect(unknown.classList.contains("border-accent")).toBe(true);
    expect(known.classList.contains("border-accent")).toBe(false);
  });

  it("draws a row waiting on a pick as its candidates, and no finish or stepper", async () => {
    const held = mount([BOLT, SAGA]);
    const waiting = row("Pick a printing");
    const candidates = within(within(waiting).getByRole("group", { name: "Printings of Lightning Bolt" }))
      .getAllByRole("button")
      .map((b) => b.getAttribute("aria-label"));
    expect(candidates).toEqual([
      "Lightning Bolt — 2X2 117",
      "Lightning Bolt — STA 105",
      "Lightning Bolt — SLD 1638",
    ]);
    expect(within(waiting).queryByRole("button", { name: /^Finish of/ })).toBeNull();
    expect(within(waiting).queryByRole("button", { name: /^One more/ })).toBeNull();
    // The way out stays, named for the card alone: a waiting row has no printing yet.
    expect(within(waiting).getByRole("button", { name: "Remove Lightning Bolt" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Lightning Bolt — STA 105" }));
    expect(held.latest[0]).toMatchObject({
      key: BOLT.key,
      cardId: BOLT.choices[1].cardId,
      setCode: "sta",
      collectorNumber: "105",
      choices: [],
    });
    expect(
      await screen.findByRole("button", { name: "Finish of Lightning Bolt — STA 105: Nonfoil" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("1 card to pick")).toBeNull();
  });

  it("opens every printing of a card as a sheet, and hands the one pressed back to the tray", async () => {
    const held = mount([SAGA, BOLT]);
    // From the waiting row: a card that is none of its three candidates.
    await userEvent.click(screen.getByRole("button", { name: "More printings of Lightning Bolt" }));
    const sheet = await screen.findByRole("dialog", { name: "Lightning Bolt" });
    const list = await within(sheet).findByRole("list", { name: "Printings" }, SETTLE);
    const printings = within(list).getAllByRole("button");
    expect(printings.length).toBeGreaterThanOrEqual(3);
    // Nothing is current on a row that has not been answered: it wears its first candidate.
    expect(printings.every((p) => p.getAttribute("aria-current") === null)).toBe(true);

    const sld = printings.find((p) => /SLD · 1638/.test(p.getAttribute("aria-label") ?? ""));
    if (sld === undefined) throw new Error("the fake's Bolt printings lost SLD 1638");
    expect(sld.getAttribute("aria-label")).toMatch(/^Use /);
    await userEvent.click(sld);

    expect(held.latest[1]).toMatchObject({
      key: BOLT.key,
      cardId: "4f43c378-9e6a-4ece-9c24-5dc08c977746",
      setCode: "sld",
      collectorNumber: "1638",
      choices: [],
      quantity: BOLT.quantity,
    });
    expect(held.latest[0]).toBe(SAGA);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("marks the printing a settled row is, in its printings sheet", async () => {
    mount([SAGA]);
    await userEvent.click(
      screen.getByRole("button", { name: "More printings of Urza's Saga — MH2 259" }),
    );
    const sheet = await screen.findByRole("dialog", { name: "Urza's Saga" });
    const list = await within(sheet).findByRole("list", { name: "Printings" }, SETTLE);
    const current = within(list)
      .getAllByRole("button")
      .filter((p) => p.getAttribute("aria-current") === "true");
    expect(current).toHaveLength(1);
    expect(current[0].getAttribute("aria-label")).toMatch(/MH2 · 259/);
  });

  it("settles an unknown finish from a printing sold one way, and from no other", async () => {
    // A row the scanner could not read the finish of: Lightning Bolt, STA 105.
    const held = mount([NEEDS_A_FINISH_ROW]);
    const pick = async (code: RegExp) => {
      await userEvent.click(screen.getByRole("button", { name: /^More printings of Lightning Bolt/ }));
      const sheet = await screen.findByRole("dialog", { name: "Lightning Bolt" });
      const list = await within(sheet).findByRole("list", { name: "Printings" }, SETTLE);
      const printing = within(list)
        .getAllByRole("button")
        .find((p) => code.test(p.getAttribute("aria-label") ?? ""));
      if (printing === undefined) throw new Error(`the fake's Bolt printings lost ${String(code)}`);
      await userEvent.click(printing);
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    };

    // 2X2 117 is sold two ways: the question stays the reader's.
    await pick(/2X2 · 117/);
    expect(held.latest[0]).toMatchObject({ setCode: "2x2", finish: "unknown" });
    // SLD 1638 is sold one way: the printing has answered it.
    await pick(/SLD · 1638/);
    expect(held.latest[0]).toMatchObject({ setCode: "sld", finish: "nonfoil" });
  });

  it("offers no printings for a card with no oracle id, and says its printing in type", () => {
    mount([{ ...TOMB, oracleId: null }]);
    expect(screen.queryByRole("button", { name: /^More printings of/ })).toBeNull();
    expect(within(row("Ancient Tomb")).getByText("TMP 315")).toBeInTheDocument();
  });

  it("walks the cards that still need a decision, landing on the question", async () => {
    mount([NEEDS_A_FINISH_ROW, SAGA, BOLT, TOMB]);
    const next = screen.getByRole("button", { name: NEXT_DECISION_LABEL });
    await userEvent.click(next);
    expect(
      screen.getByRole("button", { name: "Finish of Lightning Bolt — STA 105: Unknown" }),
    ).toHaveFocus();
    await userEvent.click(next);
    expect(screen.getByRole("button", { name: "Lightning Bolt — 2X2 117" })).toHaveFocus();
    // Round to the top again past the last.
    await userEvent.click(next);
    expect(
      screen.getByRole("button", { name: "Finish of Lightning Bolt — STA 105: Unknown" }),
    ).toHaveFocus();
  });

  it("washes the row the page marks, and no other", () => {
    mount([SAGA, TOMB], { flashKey: TOMB.key });
    expect(row("Ancient Tomb").querySelector("[data-tray-flash]")).not.toBeNull();
    expect(row("Urza's Saga").querySelector("[data-tray-flash]")).toBeNull();
  });

  it("prices one copy at the reader's marketplace, and nothing for a row still waiting", async () => {
    mount([BOLT, SAGA]);
    // The fake quotes Urza's Saga; the figure is one copy's, whatever the row's count.
    expect(await within(row("Urza's Saga")).findByText(/^[$€]\d/, {}, SETTLE)).toBeInTheDocument();
    expect(within(row("Pick a printing")).queryByText(/^[$€]\d/)).toBeNull();
  });
});
