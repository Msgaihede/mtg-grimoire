import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/tooltip/TooltipProvider";
import type { ScannerTrayRow } from "@/lib/ipc";

/**
 * The folder picker's one read. Two of the reader's drawers and a deck group — the group is there
 * so the picker's filter has something to leave out.
 */
const collectionFolderList = vi.hoisted(() =>
  vi.fn().mockResolvedValue([
    { id: 7, parentId: null, name: "Rares", kind: "user", deckId: null, sortOrder: 1, locked: false },
    { id: 8, parentId: null, name: "Burn", kind: "deck", deckId: 3, sortOrder: 2, locked: false },
  ]),
);

vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: { collectionFolderList },
}));

import { VERDICTS } from "../fixtures";
import { rowFromDecision } from "./tray";
import { TrayPanel, type TrayPanelProps } from "./TrayPanel";

const resolved = VERDICTS.exactResolved.decision!;
const ambiguous = VERDICTS.exactAmbiguous.decision!;

/** A resolved row with names this file controls, so an assertion can spell them. */
const base = rowFromDecision(resolved, { finish: "nonfoil" }, 1, "base");
const newer: ScannerTrayRow = {
  ...base,
  key: "newer",
  name: "Storm of Saruman",
  setCode: "ltr",
  collectorNumber: "72",
  addedAt: 2,
};
const older: ScannerTrayRow = {
  ...base,
  key: "older",
  name: "Honored Hierarch",
  setCode: "ori",
  collectorNumber: "17",
  addedAt: 1,
};

function props(over: Partial<TrayPanelProps> = {}): TrayPanelProps {
  return {
    rows: [newer, older],
    onRows: vi.fn(),
    folderId: null,
    onFolder: vi.fn(),
    onCommit: vi.fn(),
    committing: false,
    commitError: null,
    onMorePrintings: vi.fn(),
    flashKey: null,
    ...over,
  };
}

/** What the panel's first edit makes of `rows` — `onRows` is handed an updater, never an array. */
function edit(onRows: ReturnType<typeof vi.fn>, rows: ScannerTrayRow[]): ScannerTrayRow[] {
  const update = onRows.mock.calls[0]?.[0] as (rows: ScannerTrayRow[]) => ScannerTrayRow[];
  expect(typeof update).toBe("function");
  return update(rows);
}

/** Under the providers the page mounts above it: the folder list is a query, and the add's refusal
 *  is a tooltip that binds to nothing without its provider. */
function wrap(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider>{ui}</TooltipProvider>
    </QueryClientProvider>,
  );
}

describe("TrayPanel", () => {
  it("draws the rows newest first, each with its name and printing", () => {
    wrap(<TrayPanel {...props()} />);
    const tray = screen.getByRole("region", { name: "Scanned cards" });
    const items = within(tray).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("Storm of Saruman");
    expect(items[0]).toHaveTextContent("LTR 72");
    expect(items[1]).toHaveTextContent("Honored Hierarch");
    expect(items[1]).toHaveTextContent("ORI 17");
  });

  it("draws each row as a whole card, never the art crop", () => {
    const { container } = wrap(<TrayPanel {...props({ rows: [newer] })} />);
    const images = Array.from(container.querySelectorAll("img"));
    expect(images).toHaveLength(1);
    expect(images[0].getAttribute("src")).toContain("/thumb/");
    expect(images[0].getAttribute("src")).not.toContain("/art/");
    expect(images[0].className).toContain("object-contain");
  });

  it("names the heading with its count in words", () => {
    wrap(<TrayPanel {...props({ rows: [{ ...newer, quantity: 3 }, older] })} />);
    expect(screen.getByRole("heading", { name: "Scanned cards, 4 copies" })).toBeInTheDocument();
  });

  it("steps a row's quantity up through the reducer", async () => {
    const user = userEvent.setup();
    const onRows = vi.fn();
    wrap(<TrayPanel {...props({ onRows })} />);
    await user.click(screen.getByRole("button", { name: "Increase Quantity of Storm of Saruman — LTR 72" }));
    expect(onRows).toHaveBeenCalledTimes(1);
    const next = edit(onRows, [newer, older]);
    expect(next.find((r) => r.key === "newer")?.quantity).toBe(2);
    expect(next.find((r) => r.key === "older")?.quantity).toBe(1);
  });

  it("asks for a pick on an ambiguous row, and a press settles it on that printing", async () => {
    const user = userEvent.setup();
    const onRows = vi.fn();
    const waiting = rowFromDecision(ambiguous, { finish: "nonfoil" }, 3, "waiting");
    wrap(<TrayPanel {...props({ rows: [waiting], onRows })} />);
    expect(screen.getByText("Pick a printing")).toBeInTheDocument();
    // A row waiting on a question offers no stepper for the card it might not be.
    expect(screen.queryByRole("button", { name: /^Increase Quantity of/ })).not.toBeInTheDocument();

    const choice = waiting.choices[2];
    await user.click(
      screen.getByRole("button", {
        name: `${choice.name} — ${choice.setCode.toUpperCase()} ${choice.collectorNumber}`,
      }),
    );
    const next = edit(onRows, [waiting]);
    expect(next[0].cardId).toBe(choice.cardId);
    expect(next[0].choices).toEqual([]);
  });

  it("refuses the add while a row is unresolved, and says why", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    const waiting = rowFromDecision(ambiguous, { finish: "nonfoil" }, 3, "waiting");
    wrap(<TrayPanel {...props({ rows: [waiting, newer], onCommit })} />);
    const add = screen.getByRole("button", { name: "Add 2 to collection" });
    expect(add).toHaveAttribute("aria-disabled", "true");
    expect(add).not.toBeDisabled();
    await user.click(add);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("refuses the add on an empty tray, which says where cards will appear", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    wrap(<TrayPanel {...props({ rows: [], onCommit })} />);
    expect(screen.getByText("Cards you scan appear here.")).toBeInTheDocument();
    const add = screen.getByRole("button", { name: "Add 0 to collection" });
    expect(add).toHaveAttribute("aria-disabled", "true");
    await user.click(add);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("commits a tray whose every row is resolved", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    wrap(<TrayPanel {...props({ onCommit })} />);
    const add = screen.getByRole("button", { name: "Add 2 to collection" });
    expect(add).not.toHaveAttribute("aria-disabled");
    await user.click(add);
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it("does not commit twice while a commit is in flight", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    wrap(<TrayPanel {...props({ onCommit, committing: true })} />);
    const add = screen.getByRole("button", { name: "Add 2 to collection" });
    expect(add).toHaveAttribute("aria-busy", "true");
    await user.click(add);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("announces a refused commit as an alert", () => {
    wrap(<TrayPanel {...props({ commitError: "The database is busy — try again in a moment." })} />);
    expect(screen.getByRole("alert")).toHaveTextContent("The database is busy — try again in a moment.");
  });

  it("offers more printings only for a card with an oracle id", async () => {
    const user = userEvent.setup();
    const onMorePrintings = vi.fn();
    const orphan: ScannerTrayRow = { ...older, oracleId: null };
    wrap(<TrayPanel {...props({ rows: [{ ...newer, oracleId: "o-storm" }, orphan], onMorePrintings })} />);
    await user.click(screen.getByRole("button", { name: "More printings of Storm of Saruman — LTR 72" }));
    expect(onMorePrintings).toHaveBeenCalledWith(expect.objectContaining({ key: "newer" }));
    expect(
      screen.queryByRole("button", { name: "More printings of Honored Hierarch — ORI 17" }),
    ).not.toBeInTheDocument();
  });

  it("removes a row", async () => {
    const user = userEvent.setup();
    const onRows = vi.fn();
    wrap(<TrayPanel {...props({ onRows })} />);
    await user.click(screen.getByRole("button", { name: "Remove Honored Hierarch — ORI 17" }));
    expect(edit(onRows, [newer, older]).map((r) => r.key)).toEqual(["newer"]);
  });

  /**
   * **An edit is applied to the tray as it is, not as this render drew it.** The pump writes a card
   * between two renders; a stepper pressed in that gap used to write the tray back from `rows`, and
   * the card just scanned went with it.
   */
  it("applies an edit to rows newer than the render it was pressed on", async () => {
    const user = userEvent.setup();
    const onRows = vi.fn();
    wrap(<TrayPanel {...props({ onRows })} />);
    const justScanned: ScannerTrayRow = { ...base, key: "just-scanned", name: "Lightning Bolt", addedAt: 3 };

    await user.click(screen.getByRole("button", { name: "Remove Honored Hierarch — ORI 17" }));
    expect(edit(onRows, [justScanned, newer, older]).map((r) => r.key)).toEqual(["just-scanned", "newer"]);

    onRows.mockClear();
    await user.click(screen.getByRole("button", { name: "Increase Quantity of Storm of Saruman — LTR 72" }));
    expect(edit(onRows, [justScanned, newer, older]).map((r) => [r.key, r.quantity])).toEqual([
      ["just-scanned", 1],
      ["newer", 2],
      ["older", 1],
    ]);
  });

  it("files into the reader's own folders and never a deck's group", async () => {
    const user = userEvent.setup();
    const onFolder = vi.fn();
    wrap(<TrayPanel {...props({ onFolder })} />);
    await user.click(screen.getByRole("button", { name: "Folder: Collection" }));
    const list = await screen.findByRole("group", { name: "File the scanned cards in a folder" });
    expect(await within(list).findByRole("button", { name: "Rares" })).toBeInTheDocument();
    expect(within(list).queryByRole("button", { name: "Burn" })).not.toBeInTheDocument();
    await user.click(within(list).getByRole("button", { name: "Rares" }));
    expect(onFolder).toHaveBeenCalledWith(7);
  });

  it("flashes only the row it is told to", () => {
    const { container } = wrap(<TrayPanel {...props({ flashKey: "older" })} />);
    const flashes = container.querySelectorAll("[data-tray-flash]");
    expect(flashes).toHaveLength(1);
    expect(flashes[0].closest("li")).toHaveTextContent("Honored Hierarch");
  });
});
