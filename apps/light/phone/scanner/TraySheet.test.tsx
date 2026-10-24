import { useRef, useState } from "react";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("@grimoire/fake/core"));
vi.mock("@tauri-apps/api/event", () => import("@grimoire/fake/event"));
vi.mock("@tauri-apps/api/window", () => import("@grimoire/fake/window"));

import { NEEDS_A_FINISH_ROW, TRAY_ROWS } from "@grimoire/ui/features/scanner/fixtures";
import { NEXT_DECISION_LABEL } from "@grimoire/ui/features/scanner/reader/tray";
import type { PrintingPrices, ScannerTrayRow } from "@grimoire/ui/lib/ipc";
import { renderPhone } from "../testing";
import { cardsNeedYou, TraySheet } from "./TraySheet";

const SETTLE = { timeout: 3000 };
const [BOLT, SAGA, TOMB, LOTUS] = TRAY_ROWS;
const RESOLVED = [SAGA, TOMB, LOTUS];

/** Urza's Saga at $50 and Ancient Tomb at $12.34 in foil; Black Lotus nobody quotes. */
const PRICES: PrintingPrices[] = [
  { cardId: SAGA.cardId, finishPrices: { nonfoil: 50, foil: null, etched: null } },
  { cardId: TOMB.cardId, finishPrices: { nonfoil: null, foil: 12.34, etched: null } },
];

/**
 * The sheet as the page mounts it, over rows a test can read back (the page's `tray.latest()`),
 * with a stand-in for the page's `TrayBar` in its slot and the peek's press to open it from.
 */
function mount(start: readonly ScannerTrayRow[]) {
  const onAddCard = vi.fn();
  const onActions = vi.fn();
  const held = { latest: [...start] };
  function Page() {
    const [open, setOpen] = useState(false);
    const [rows, setRows] = useState<readonly ScannerTrayRow[]>(start);
    const peek = useRef<HTMLButtonElement>(null);
    return (
      <>
        <button ref={peek} type="button" onClick={() => setOpen(true)}>
          Open the tray
        </button>
        <TraySheet
          open={open}
          onClose={() => setOpen(false)}
          onDismiss={() => {
            setOpen(false);
            peek.current?.focus();
          }}
          rows={rows}
          onRows={(change) => {
            held.latest = change(held.latest);
            setRows(held.latest);
          }}
          flashKey={null}
          onAddCard={onAddCard}
          onActions={onActions}
          bar={<p data-testid="bar">The folder and Add</p>}
        />
      </>
    );
  }
  renderPhone(<Page />, {
    commands: () => ({
      printing_prices: (args: { cardIds: string[] }) =>
        PRICES.filter((price) => args.cardIds.includes(price.cardId)),
    }),
  });
  return { onAddCard, onActions, held };
}

async function openSheet(name: string) {
  await userEvent.click(screen.getByRole("button", { name: "Open the tray" }));
  return screen.findByRole("dialog", { name });
}

describe("the tray's sheet", () => {
  it("draws the bar in its slot, then the list, and only the list scrolls", async () => {
    mount(TRAY_ROWS);
    const sheet = await openSheet("Scanned cards, 6 copies");
    const bar = within(sheet).getByTestId("bar");
    const list = within(sheet).getByRole("region", { name: "Scanned cards" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(4);
    // The bar comes before the list…
    expect(bar.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // …and stays put over it: the one scroller holds the list and nothing else.
    const scroller = list.closest("[data-tray-sheet-list]") as HTMLElement;
    expect(scroller).toHaveClass("overflow-y-auto", "min-h-0", "flex-1");
    expect(scroller.contains(bar)).toBe(false);
    expect(scroller.contains(screen.getByRole("button", { name: NEXT_DECISION_LABEL }))).toBe(
      false,
    );
    // The list draws no heading of its own: the sheet's header is it.
    expect(within(sheet).queryByRole("heading", { name: /copies$/ })).toBeNull();
  });

  it("says what the tray is worth at its marketplace, and how many copies that leaves out", async () => {
    mount(RESOLVED);
    const sheet = await openSheet("Scanned cards, 5 copies");
    // Three Sagas at $50 and a foil Tomb at $12.34; the Lotus has no price.
    expect(
      await within(sheet).findByText(
        (_, el) =>
          el?.tagName === "P" && /^Worth [$€]162\.34 · 1 unpriced$/.test(el.textContent ?? ""),
        {},
        SETTLE,
      ),
    ).toBeInTheDocument();
  });

  it("says nothing of a worth while nothing is priced", async () => {
    mount([LOTUS]);
    const sheet = await openSheet("Scanned cards, 1 copy");
    expect(await within(sheet).findByText("1 unpriced", {}, SETTLE)).toBeInTheDocument();
    expect(within(sheet).queryByText(/Worth/)).toBeNull();
  });

  it("asks the page for a card and for the tray's actions, handing it each press", async () => {
    const { onAddCard, onActions } = mount(RESOLVED);
    const sheet = await openSheet("Scanned cards, 5 copies");
    const add = within(sheet).getByRole("button", { name: "Add card…" });
    await userEvent.click(add);
    expect(onAddCard).toHaveBeenCalledWith(add);
    const more = within(sheet).getByRole("button", { name: "Tray actions" });
    await userEvent.click(more);
    expect(onActions).toHaveBeenCalledWith(more);
  });

  it("says how many cards need the reader, and walks them with Next", async () => {
    mount([NEEDS_A_FINISH_ROW, SAGA, BOLT, TOMB]);
    const sheet = await openSheet("Scanned cards, 6 copies");
    expect(within(sheet).getByText("2 cards need you")).toBeInTheDocument();
    const next = within(sheet).getByRole("button", { name: NEXT_DECISION_LABEL });
    expect(next).toHaveTextContent(/^Next$/);
    await userEvent.click(next);
    expect(
      within(sheet).getByRole("button", { name: "Finish of Lightning Bolt — STA 105: Unknown" }),
    ).toHaveFocus();
    await userEvent.click(next);
    expect(within(sheet).getByRole("button", { name: "Lightning Bolt — 2X2 117" })).toHaveFocus();
  });

  it("draws no walk while nothing waits", async () => {
    mount(RESOLVED);
    const sheet = await openSheet("Scanned cards, 5 copies");
    expect(within(sheet).queryByRole("button", { name: NEXT_DECISION_LABEL })).toBeNull();
    expect(within(sheet).queryByText(/need you/)).toBeNull();
  });

  it("words the walk's line for one card and for many", () => {
    expect(cardsNeedYou(1)).toBe("1 card needs you");
    expect(cardsNeedYou(3)).toBe("3 cards need you");
  });

  it("hands the caret back to the peek on Escape", async () => {
    mount(RESOLVED);
    await openSheet("Scanned cards, 5 copies");
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByRole("button", { name: "Open the tray" })).toHaveFocus();
  });

  /**
   * A row's finish sheet opens **over** the tray's: Escape closes the one on top, the write lands
   * on the tray as it is, and the caret comes back to the press it left from — inside the sheet.
   */
  it("asks a row's finish over itself, and closes only that on Escape", async () => {
    const { held } = mount([NEEDS_A_FINISH_ROW, SAGA]);
    const sheet = await openSheet("Scanned cards, 4 copies");
    const finish = within(sheet).getByRole("button", {
      name: "Finish of Lightning Bolt — STA 105: Unknown",
    });
    await userEvent.click(finish);
    await screen.findByRole("dialog", { name: "Lightning Bolt" });
    await userEvent.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Lightning Bolt" })).toBeNull(),
    );
    expect(screen.getByRole("dialog", { name: "Scanned cards, 4 copies" })).toBeInTheDocument();
    expect(finish).toHaveFocus();

    await userEvent.click(finish);
    await userEvent.click(
      within(await screen.findByRole("dialog", { name: "Lightning Bolt" })).getByRole("button", {
        name: "Foil",
      }),
    );
    await waitFor(() =>
      expect(
        within(screen.getByRole("dialog", { name: "Scanned cards, 4 copies" })).getByRole(
          "button",
          { name: "Finish of Lightning Bolt — STA 105: Foil" },
        ),
      ).toHaveFocus(),
    );
    expect(held.latest[0].finish).toBe("foil");
  });
});
