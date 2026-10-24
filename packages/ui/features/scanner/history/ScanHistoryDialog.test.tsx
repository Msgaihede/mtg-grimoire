import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/tooltip/TooltipProvider";
import type { ScanBatch, ScanBatchLine, ScanBatchSummary } from "@/lib/ipc";
import { useNotifications } from "@/lib/notifications";

const scanHistoryList = vi.hoisted(() => vi.fn<() => Promise<ScanBatchSummary[]>>());
const scanHistoryGet = vi.hoisted(() => vi.fn<(id: number) => Promise<ScanBatch | null>>());
const scanHistoryRename = vi.hoisted(() => vi.fn<(id: number, name: string) => Promise<void>>());
const scanHistoryDelete = vi.hoisted(() => vi.fn<(id: number) => Promise<void>>());

vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: { scanHistoryList, scanHistoryGet, scanHistoryRename, scanHistoryDelete },
}));

import { EMPTY_HISTORY } from "./historyWords";
import { ScanHistoryDialog } from "./ScanHistoryDialog";

/** 4 Oct 2026, 18:30 local — a fixed instant, so the list's date is one the suite can spell. */
const OCT_4 = new Date(2026, 9, 4, 18, 30).getTime() / 1000;
const SEP_26 = new Date(2026, 8, 26, 9, 5).getTime() / 1000;

const ARCHIVED: ScanBatchSummary = {
  id: 3,
  name: "Bob's binder",
  status: "archived",
  folderId: null,
  folderName: null,
  condition: "NM",
  lineCount: 2,
  copies: 3,
  coverCardId: "card-saga",
  createdAt: OCT_4,
};
const FILED: ScanBatchSummary = {
  id: 2,
  name: "Scan 2",
  status: "filed",
  folderId: 1,
  folderName: "Binder",
  condition: "NM",
  lineCount: 1,
  copies: 1,
  coverCardId: "card-bolt",
  createdAt: SEP_26,
};

function line(over: Partial<ScanBatchLine>): ScanBatchLine {
  return {
    id: 1,
    cardId: "card-saga",
    oracleId: "o-saga",
    name: "Urza's Saga",
    setCode: "mh2",
    setName: "Modern Horizons 2",
    collectorNumber: "259",
    rarity: "rare",
    layout: "saga",
    finish: "nonfoil",
    quantity: 2,
    finishes: ["nonfoil", "foil"],
    printingGone: false,
    ...over,
  };
}

const SEEDED: Record<number, ScanBatch> = {
  3: {
    summary: ARCHIVED,
    lines: [
      line({ id: 1 }),
      line({
        id: 2,
        cardId: "card-sphinx",
        name: "Consecrated Sphinx",
        setCode: "mp2",
        collectorNumber: "8",
        finish: "foil",
        quantity: 1,
      }),
    ],
  },
  2: {
    summary: FILED,
    lines: [
      line({
        id: 3,
        cardId: "card-bolt",
        name: "Lightning Bolt",
        setCode: "sta",
        collectorNumber: "105",
        finish: "etched",
        quantity: 1,
      }),
    ],
  },
};

/** What *Put back in tray* handed the page — the page's to land, so the dialog only hands it. */
const putBack = vi.fn<(batch: ScanBatch) => void>();

/** The dialog open, and its opener, as the page holds them. */
function Host() {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        History
      </button>
      <ScanHistoryDialog
        open={open}
        onPutBack={putBack}
        onDismiss={() => setOpen(false)}
        onClose={() => setOpen(false)}
      />
    </>
  );
}

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <Host />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

async function opened() {
  return screen.findByRole("dialog", { name: "Scan history" });
}

/**
 * The backend, per test: the seeded batches as a store the writes change, so a read that follows a
 * write answers what the write left — a rename's refetch says the new name, a delete's says gone.
 */
let stored: Record<number, ScanBatch> = {};
beforeEach(() => {
  stored = structuredClone(SEEDED);
  putBack.mockReset();
  scanHistoryList.mockReset().mockImplementation(async () =>
    Object.values(stored)
      .map((batch) => batch.summary)
      .sort((a, b) => b.createdAt - a.createdAt),
  );
  scanHistoryGet.mockReset().mockImplementation(async (id) => stored[id] ?? null);
  scanHistoryRename.mockReset().mockImplementation(async (id, name) => {
    const batch = stored[id];
    if (batch === undefined) throw "That scan is no longer in your history.";
    batch.summary.name = name === "" ? `Scan ${id}` : name;
  });
  scanHistoryDelete.mockReset().mockImplementation(async (id) => {
    delete stored[id];
  });
});

describe("ScanHistoryDialog", () => {
  it("says which presses fill an empty history", async () => {
    stored = {};
    mount();
    expect(await within(await opened()).findByText(EMPTY_HISTORY)).toBeInTheDocument();
    expect(scanHistoryGet).not.toHaveBeenCalled();
  });

  it("lists every batch newest first, each with its day, its count and where it went", async () => {
    mount();
    const dialog = await opened();
    const scans = await within(dialog).findByRole("navigation", { name: "Scans" });
    const entries = await within(scans).findAllByRole("button");
    expect(entries).toHaveLength(2);
    expect(entries[0]).toHaveTextContent("Bob's binder");
    expect(entries[0]).toHaveTextContent("4 Oct 2026, 18:30 · 3 cards");
    expect(entries[0]).toHaveTextContent("Archived");
    expect(entries[1]).toHaveTextContent("26 Sep 2026, 09:05 · 1 card");
    expect(entries[1]).toHaveTextContent("Added to “Binder”");
  });

  it("opens on the newest batch, its lines read-only with their printing, finish and count", async () => {
    mount();
    const dialog = await opened();
    const cards = await within(dialog).findByRole("list", { name: "Cards in Bob's binder" });
    const rows = within(cards).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("Urza's Saga");
    expect(rows[0]).toHaveTextContent("MH2 259");
    expect(rows[0]).toHaveTextContent("×2");
    expect(rows[1]).toHaveTextContent("Consecrated Sphinx");
    // A record, not a draft: nothing on a line can be changed.
    expect(within(cards).queryByRole("button")).toBeNull();
    expect(within(cards).queryByRole("spinbutton")).toBeNull();
    expect(
      within(within(dialog).getByRole("navigation", { name: "Scans" })).getAllByRole("button")[0],
    ).toHaveAttribute("aria-current", "true");
  });

  it("hands the batch it draws to the page on Put back in tray (issue #1374)", async () => {
    const user = userEvent.setup();
    mount();
    const dialog = await opened();
    await user.click(await within(dialog).findByRole("button", { name: /^Scan 2/ }));
    await within(dialog).findByRole("list", { name: "Cards in Scan 2" });
    await user.click(within(dialog).getByRole("button", { name: "Put back in tray" }));
    expect(putBack).toHaveBeenCalledTimes(1);
    expect(putBack.mock.calls[0]?.[0]).toEqual(stored[2]);
    // The record is not touched: nothing renamed, nothing deleted.
    expect(scanHistoryRename).not.toHaveBeenCalled();
    expect(scanHistoryDelete).not.toHaveBeenCalled();
  });

  it("shows another batch on a press", async () => {
    const user = userEvent.setup();
    mount();
    const dialog = await opened();
    await user.click(await within(dialog).findByRole("button", { name: /^Scan 2/ }));
    const cards = await within(dialog).findByRole("list", { name: "Cards in Scan 2" });
    expect(within(cards).getByText("Lightning Bolt")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: /^Scan 2/ })).toHaveAttribute(
      "aria-current",
      "true",
    );
  });

  it("renames in place: Enter writes the name and the list says it at once", async () => {
    const user = userEvent.setup();
    mount();
    const dialog = await opened();
    await user.click(await within(dialog).findByRole("button", { name: "Rename scan" }));
    const field = within(dialog).getByRole("textbox", { name: "Scan name" });
    expect(field).toHaveFocus();
    await user.clear(field);
    await user.type(field, "  Friday pile {Enter}");
    expect(scanHistoryRename).toHaveBeenCalledExactlyOnceWith(3, "Friday pile");
    expect(await within(dialog).findByRole("heading", { name: "Friday pile" })).toBeInTheDocument();
    // The pencil is back, and the caret on it.
    await waitFor(() =>
      expect(within(dialog).getByRole("button", { name: "Rename scan" })).toHaveFocus(),
    );
  });

  it("writes a blank name, which the backend takes as Scan N back", async () => {
    const user = userEvent.setup();
    mount();
    const dialog = await opened();
    await user.click(await within(dialog).findByRole("button", { name: "Rename scan" }));
    const field = within(dialog).getByRole("textbox", { name: "Scan name" });
    expect(field).toHaveAttribute("placeholder", "Scan 3");
    await user.clear(field);
    await user.type(field, "{Enter}");
    expect(scanHistoryRename).toHaveBeenCalledExactlyOnceWith(3, "");
  });

  it("gives up a rename on Escape, and the dialog stays open", async () => {
    const user = userEvent.setup();
    mount();
    const dialog = await opened();
    await user.click(await within(dialog).findByRole("button", { name: "Rename scan" }));
    await user.type(within(dialog).getByRole("textbox", { name: "Scan name" }), "x{Escape}");
    expect(scanHistoryRename).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Scan history" })).toBeInTheDocument();
  });

  it("says a refused rename under the name", async () => {
    scanHistoryRename.mockRejectedValueOnce("That scan is no longer in your history.");
    const user = userEvent.setup();
    mount();
    const dialog = await opened();
    await user.click(await within(dialog).findByRole("button", { name: "Rename scan" }));
    await user.type(within(dialog).getByRole("textbox", { name: "Scan name" }), "!{Enter}");
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "Couldn't rename the scan — That scan is no longer in your history.",
    );
  });

  it("asks before deleting, says the collection is not touched, and a cancel deletes nothing", async () => {
    const user = userEvent.setup();
    mount();
    const dialog = await opened();
    const remove = await within(dialog).findByRole("button", { name: "Delete…" });
    await user.click(remove);
    const question = await screen.findByRole("dialog", { name: "Delete this scan?" });
    expect(question).toHaveTextContent(
      "“Bob's binder” will be removed from your scan history. Your collection is not affected.",
    );
    // Over the history, not inside its panel: a transformed panel would clip a `fixed` scrim.
    expect(dialog.contains(question)).toBe(false);

    await user.click(within(question).getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Delete this scan?" })).toBeNull(),
    );
    expect(scanHistoryDelete).not.toHaveBeenCalled();
    expect(remove).toHaveFocus();
  });

  it("says a filed batch's cards stay in the collection", async () => {
    const user = userEvent.setup();
    mount();
    const dialog = await opened();
    await user.click(await within(dialog).findByRole("button", { name: /^Scan 2/ }));
    await within(dialog).findByRole("list", { name: "Cards in Scan 2" });
    await user.click(within(dialog).getByRole("button", { name: "Delete…" }));
    expect(await screen.findByRole("dialog", { name: "Delete this scan?" })).toHaveTextContent(
      "The cards it added stay in your collection.",
    );
  });

  it("deletes on Confirm, says so once, and moves on to a batch that is there", async () => {
    const user = userEvent.setup();
    mount();
    const dialog = await opened();
    await user.click(await within(dialog).findByRole("button", { name: "Delete…" }));
    const question = await screen.findByRole("dialog", { name: "Delete this scan?" });
    await user.click(within(question).getByRole("button", { name: "Delete scan" }));

    expect(scanHistoryDelete).toHaveBeenCalledExactlyOnceWith(3);
    expect(
      await within(dialog).findByRole("list", { name: "Cards in Scan 2" }),
    ).toBeInTheDocument();
    expect(within(dialog).queryByText("Bob's binder")).toBeNull();
    await waitFor(() => expect(useNotifications.getState().notices).toHaveLength(1));
    expect(useNotifications.getState().notices[0]).toMatchObject({
      title: "Deleted “Bob's binder” from scan history",
      tone: "success",
    });
  });

  it("treats a batch whose read answers null as gone, and draws the next one the list holds", async () => {
    const user = userEvent.setup();
    mount();
    const dialog = await opened();
    await within(dialog).findByRole("list", { name: "Cards in Bob's binder" });
    // Deleted in another window: the list has not caught up, the batch's own read has.
    scanHistoryGet.mockImplementation(async (id) => (id === 2 ? null : (stored[id] ?? null)));
    await user.click(within(dialog).getByRole("button", { name: /^Scan 2/ }));
    expect(
      await within(dialog).findByRole("list", { name: "Cards in Bob's binder" }),
    ).toBeInTheDocument();
    expect(
      within(within(dialog).getByRole("navigation", { name: "Scans" })).getAllByRole("button")[0],
    ).toHaveAttribute("aria-current", "true");
  });

  it("closes on Escape", async () => {
    const user = userEvent.setup();
    mount();
    await opened();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});
