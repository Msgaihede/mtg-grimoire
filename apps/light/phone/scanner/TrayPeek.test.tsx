import { useState } from "react";
import { act, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("@grimoire/fake/core"));
vi.mock("@tauri-apps/api/event", () => import("@grimoire/fake/event"));
vi.mock("@tauri-apps/api/window", () => import("@grimoire/fake/window"));

import { NEEDS_A_FINISH_ROW, TRAY_ROWS } from "@grimoire/ui/features/scanner/fixtures";
import type { ScannerTrayRow } from "@grimoire/ui/lib/ipc";
import { renderPhone } from "../testing";
import { PEEK_ROWS, TrayPeek } from "./TrayPeek";

const [BOLT, SAGA, TOMB, LOTUS] = TRAY_ROWS;
const RESOLVED = [SAGA, TOMB, LOTUS];

function mount(rows: readonly ScannerTrayRow[], flashKey: string | null = null) {
  const onOpen = vi.fn();
  renderPhone(<TrayPeek rows={rows} flashKey={flashKey} onOpen={onOpen} />);
  return { onOpen };
}

/** The strip's tiles, in the order they are drawn, by the row each one is. */
const tiles = () =>
  Array.from(document.querySelectorAll<HTMLElement>("[data-tray-peek]")).map(
    (tile) => tile.dataset.trayPeek,
  );
const tile = (row: ScannerTrayRow) =>
  document.querySelector<HTMLElement>(`[data-tray-peek="${row.key}"]`) as HTMLElement;

describe("the tray's peek", () => {
  it("lists the newest rows first — the tray's own order", () => {
    mount([NEEDS_A_FINISH_ROW, ...TRAY_ROWS]);
    expect(tiles()).toEqual([NEEDS_A_FINISH_ROW, BOLT, SAGA, TOMB, LOTUS].map((row) => row.key));
  });

  it("draws no more than a glance of a long tray: the newest, the rest left to the sheet", () => {
    const many = Array.from({ length: PEEK_ROWS + 5 }, (_, i) => ({
      ...SAGA,
      key: `row-${i}`,
      addedAt: SAGA.addedAt - i,
    }));
    mount(many);
    expect(tiles()).toEqual(many.slice(0, PEEK_ROWS).map((row) => row.key));
  });

  it("shows the gold need-you chip while cards wait on a printing or a finish, and names it", () => {
    mount([NEEDS_A_FINISH_ROW, ...TRAY_ROWS]);
    // One waiting on a printing, one on a finish — and seven copies in all.
    expect(screen.getByText("2 need you")).toHaveClass("text-accent");
    expect(
      screen.getByRole("button", { name: "Scanned cards, 7 copies, 2 need you" }),
    ).toHaveAttribute("aria-haspopup", "dialog");
  });

  it("says one needs you in the singular", () => {
    mount([BOLT, SAGA]);
    expect(screen.getByText("1 needs you")).toBeInTheDocument();
  });

  it("draws no chip when nothing waits", () => {
    mount(RESOLVED);
    expect(screen.queryByText(/need/)).toBeNull();
    expect(screen.getByRole("button", { name: "Scanned cards, 5 copies" })).toBeInTheDocument();
  });

  it("draws a card waiting on a printing as a Pick tile, an unknown finish as Finish?, and copies as a count", () => {
    mount([NEEDS_A_FINISH_ROW, ...TRAY_ROWS]);
    expect(tile(BOLT)).toHaveTextContent(/^Pick$/);
    expect(tile(BOLT)).toHaveClass("border-dashed");
    expect(tile(BOLT).querySelector("img")).toBeNull();

    expect(tile(NEEDS_A_FINISH_ROW)).toHaveTextContent("Finish?");
    expect(tile(NEEDS_A_FINISH_ROW)).toHaveClass("border-dashed");
    expect(tile(NEEDS_A_FINISH_ROW).querySelector("img")).not.toBeNull();

    // Three copies of Urza's Saga say so; a single copy carries no count.
    expect(tile(SAGA)).toHaveTextContent(/^3$/);
    expect(tile(TOMB)).toHaveTextContent(/^$/);
    expect(tile(TOMB)).not.toHaveClass("border-dashed");
  });

  it("opens the sheet from the line, handing the page the press", async () => {
    const { onOpen } = mount(RESOLVED);
    const press = screen.getByRole("button", { name: "Scanned cards, 5 copies" });
    await userEvent.click(press);
    expect(onOpen).toHaveBeenCalledWith(press);
  });

  it("opens the sheet from a press on the strip too, and keeps the strip out of the reading order", async () => {
    const { onOpen } = mount(RESOLVED);
    const strip = document.querySelector("[data-tray-peek-strip]") as HTMLElement;
    // A picture of the tray: the sheet is where its rows are read.
    expect(strip).toHaveAttribute("aria-hidden", "true");
    await userEvent.click(tile(TOMB));
    expect(onOpen).toHaveBeenCalledWith(
      screen.getByRole("button", { name: "Scanned cards, 5 copies" }),
    );
  });

  it("washes the row the page marks, and no other", () => {
    mount(RESOLVED, TOMB.key);
    expect(tile(TOMB).querySelector("[data-tray-flash]")).not.toBeNull();
    expect(tile(SAGA).querySelector("[data-tray-flash]")).toBeNull();
  });

  it("says where scanned cards will appear while there are none", () => {
    mount([]);
    expect(screen.getByText("Cards you scan appear here.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Scanned cards, 0 copies" })).toBeInTheDocument();
    expect(tiles()).toEqual([]);
  });

  it("slides the strip back to its first tile when a card lands, and only then", () => {
    const scrollTo = vi.fn();
    // The rows as the page holds them, changed from outside the peek — a card landing.
    const held: { set: (rows: readonly ScannerTrayRow[]) => void } = { set: () => {} };
    function Held() {
      const [rows, setRows] = useState<readonly ScannerTrayRow[]>(RESOLVED);
      held.set = setRows;
      return <TrayPeek rows={rows} flashKey={null} onOpen={() => {}} />;
    }
    renderPhone(<Held />);
    const strip = document.querySelector("[data-tray-peek-strip]") as HTMLElement;
    strip.scrollTo = scrollTo;
    // An edit is no landing.
    act(() => held.set([{ ...SAGA, quantity: 4 }, TOMB, LOTUS]));
    expect(scrollTo).not.toHaveBeenCalled();
    act(() =>
      held.set([{ ...BOLT, addedAt: SAGA.addedAt + 1 }, { ...SAGA, quantity: 4 }, TOMB, LOTUS]),
    );
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo.mock.calls[0][0]).toMatchObject({ left: 0 });
  });
});
