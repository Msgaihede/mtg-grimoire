import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/tooltip/TooltipProvider";
import type { ScannerTrayRow } from "@/lib/ipc";
import { pickOption } from "@/test-dropdown";

/**
 * The folder picker's one read. Two of the reader's drawers and a deck group — the group is there
 * so the picker's filter has something to leave out.
 */
const collectionFolderList = vi.hoisted(() =>
  vi.fn().mockResolvedValue([
    {
      id: 7,
      parentId: null,
      name: "Rares",
      kind: "user",
      deckId: null,
      sortOrder: 1,
      locked: false,
    },
    { id: 8, parentId: null, name: "Burn", kind: "deck", deckId: 3, sortOrder: 2, locked: false },
  ]),
);

/**
 * The tray's price read (issue #736) and the marketplace setting it is keyed on. Unpriced by
 * default — every printing answered with nothing — so a test about something else draws the em
 * dash and nothing it has to account for; the price tests below answer their own.
 */
const printingPrices = vi.hoisted(() => vi.fn().mockResolvedValue([]));
const getMarketplace = vi.hoisted(() => vi.fn().mockResolvedValue("tcgplayer"));
const marketplaceFeedStatus = vi.hoisted(() => vi.fn().mockResolvedValue([]));

vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: { collectionFolderList, printingPrices, getMarketplace, marketplaceFeedStatus },
}));

import { VERDICTS } from "../fixtures";
import { NO_FINISHED_ROWS, rowFromDecision } from "./tray";
import { addLabel, NEXT_DECISION_LABEL, TrayPanel, type TrayPanelProps } from "./TrayPanel";

const resolved = VERDICTS.exactResolved.decision!;
const ambiguous = VERDICTS.exactAmbiguous.decision!;

/** A resolved row with names this file controls, so an assertion can spell them — of a printing
 *  made in every finish, so a test about the controls is not one about the corpus. */
const base = rowFromDecision(
  { ...resolved, finishes: ["nonfoil", "foil", "etched"] },
  { finish: "nonfoil" },
  1,
  "base",
);
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

/**
 * The panel's props, **in the list layout** unless a test says otherwise — the cases written before
 * the grid existed are about the list, and keep proving it. {@link grid} is the other door.
 */
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
    layout: "list",
    onLayout: vi.fn(),
    onClearAll: vi.fn(),
    ...over,
  };
}

/** The same props in the grid layout — the page's default. */
function grid(over: Partial<TrayPanelProps> = {}): TrayPanelProps {
  return props({ layout: "grid", ...over });
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
  it("opens deck creation with the button as its focus return target", async () => {
    const onCreateDeck = vi.fn();
    wrap(<TrayPanel {...props({ onCreateDeck })} />);
    const button = screen.getByRole("button", { name: "Create deck…" });
    await userEvent.click(button);
    expect(onCreateDeck).toHaveBeenCalledWith(button);
  });

  it.each(["empty", "printing", "finish", "committing"])(
    "refuses deck creation while %s needs attention",
    async (state) => {
      const onCreateDeck = vi.fn();
      const rows =
        state === "empty"
          ? []
          : state === "printing"
            ? [rowFromDecision(ambiguous, { finish: "nonfoil" }, 1, "waiting")]
            : state === "finish"
              ? [{ ...base, finish: "unknown" as const }]
              : [base];
      wrap(<TrayPanel {...props({ rows, onCreateDeck, committing: state === "committing" })} />);
      const button = screen.getByRole("button", { name: "Create deck…" });
      expect(button).toHaveAttribute("aria-disabled", "true");
      await userEvent.click(button);
      expect(onCreateDeck).not.toHaveBeenCalled();
    },
  );

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
    await user.click(
      screen.getByRole("button", { name: "Increase Quantity of Storm of Saruman — LTR 72" }),
    );
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

  it("offers the walk to the next decision only while a card is waiting on one", () => {
    const { unmount } = wrap(<TrayPanel {...props()} />);
    expect(screen.queryByRole("button", { name: NEXT_DECISION_LABEL })).not.toBeInTheDocument();
    unmount();
    wrap(<TrayPanel {...props({ rows: [newer, { ...older, finish: "unknown" }] })} />);
    expect(screen.getByRole("button", { name: NEXT_DECISION_LABEL })).toBeInTheDocument();
  });

  /**
   * **Each press lands on the next question — a printing to pick, then a finish — and wraps**, with
   * the caret on the control that answers it. Settled rows are walked past.
   */
  it("walks the caret through each card needing a decision, in the tray's order, and wraps", async () => {
    const user = userEvent.setup();
    const waiting = rowFromDecision(ambiguous, { finish: "nonfoil" }, 3, "waiting");
    const unknown: ScannerTrayRow = { ...older, finish: "unknown" };
    wrap(<TrayPanel {...props({ rows: [waiting, newer, unknown] })} />);
    const next = screen.getByRole("button", { name: NEXT_DECISION_LABEL });
    const first = waiting.choices[0];

    await user.click(next);
    expect(document.activeElement).toBe(
      screen.getByRole("button", {
        name: `${first.name} — ${first.setCode.toUpperCase()} ${first.collectorNumber}`,
      }),
    );
    await user.click(next);
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Finish of Honored Hierarch — ORI 17" }),
    );
    // Past the last question, round to the first again.
    await user.click(next);
    expect(document.activeElement).toBe(
      screen.getByRole("button", {
        name: `${first.name} — ${first.setCode.toUpperCase()} ${first.collectorNumber}`,
      }),
    );
  });

  /** Only the tray's own scroller moves — never the page around it — and the row is centred. */
  it("scrolls the tray's own list to the row it lands on", async () => {
    const user = userEvent.setup();
    const scrollTo = vi.fn();
    const original = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTo");
    Element.prototype.scrollTo = scrollTo as unknown as typeof Element.prototype.scrollTo;
    try {
      wrap(<TrayPanel {...props({ rows: [newer, { ...older, finish: "unknown" }] })} />);
      await user.click(screen.getByRole("button", { name: NEXT_DECISION_LABEL }));
      expect(scrollTo).toHaveBeenCalledTimes(1);
      expect(scrollTo.mock.contexts[0]).toBe(screen.getAllByRole("list")[0]);
    } finally {
      if (original) Object.defineProperty(Element.prototype, "scrollTo", original);
      else delete (Element.prototype as { scrollTo?: unknown }).scrollTo;
    }
  });

  /**
   * **The label says what Add leaves behind** — copies, like the heading's count, and the second
   * half only while there is one.
   */
  it("words the add with the copies it files and the ones that need a finish", () => {
    expect(addLabel(8, 0)).toBe("Add 8 to collection");
    expect(addLabel(8, 2)).toBe("Add 8 to collection · 2 need a finish");
    expect(addLabel(3, 1)).toBe("Add 3 to collection · 1 needs a finish");
    expect(addLabel(0, 4)).toBe("Add 0 to collection · 4 need a finish");
  });

  it("adds the known-finish rows and counts the Unknown one out, on one button", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    const unknown: ScannerTrayRow = { ...older, finish: "unknown", quantity: 2 };
    wrap(<TrayPanel {...props({ rows: [{ ...newer, quantity: 3 }, unknown], onCommit })} />);
    // The heading still counts the whole tray; the button counts it out.
    expect(screen.getByRole("heading", { name: "Scanned cards, 5 copies" })).toBeInTheDocument();
    const add = screen.getByRole("button", { name: "Add 3 to collection · 2 need a finish" });
    expect(add).not.toHaveAttribute("aria-disabled");
    await user.click(add);
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it("refuses the add when every row needs a finish, and says why", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    wrap(<TrayPanel {...props({ rows: [{ ...newer, finish: "unknown" }], onCommit })} />);
    const add = screen.getByRole("button", { name: "Add 0 to collection · 1 needs a finish" });
    expect(add).toHaveAttribute("aria-disabled", "true");
    expect(add).not.toBeDisabled();
    await user.hover(add);
    expect(await screen.findByRole("tooltip", undefined, { timeout: 2000 })).toHaveTextContent(
      NO_FINISHED_ROWS,
    );
    await user.click(add);
    expect(onCommit).not.toHaveBeenCalled();
  });

  /**
   * **Unknown is a finish control's value like the other three**, drawn in the accent the tray asks
   * its questions in, and a pick hands the reducer a finish; the list also offers Unknown, last, so
   * a reader can hold a card back on purpose.
   */
  it("draws an Unknown finish as a question and lets the reader answer it", async () => {
    const user = userEvent.setup();
    const onRows = vi.fn();
    const unknown: ScannerTrayRow = { ...newer, finish: "unknown" };
    wrap(<TrayPanel {...props({ rows: [unknown, older], onRows })} />);
    const finish = screen.getByRole("button", { name: "Finish of Storm of Saruman — LTR 72" });
    expect(finish).toHaveTextContent("Unknown");
    expect(finish.classList.contains("border-accent")).toBe(true);
    const known = screen.getByRole("button", { name: "Finish of Honored Hierarch — ORI 17" });
    expect(known).toHaveTextContent("Nonfoil");
    expect(known.classList.contains("border-accent")).toBe(false);

    await user.click(finish);
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Nonfoil",
      "Foil",
      "Etched",
      "Unknown",
    ]);
    await user.click(screen.getByRole("option", { name: "Foil" }));
    expect(edit(onRows, [unknown, older]).map((r) => [r.key, r.finish])).toEqual([
      ["newer", "foil"],
      ["older", "nonfoil"],
    ]);
  });

  /** A foil-only printing offers no Nonfoil, in either layout (issue #982). */
  it.each(["list", "grid"] as const)(
    "offers only the finishes the row's printing exists in (%s)",
    async (layout) => {
      const user = userEvent.setup();
      const foilOnly: ScannerTrayRow = { ...newer, finish: "foil", finishes: ["foil"] };
      const rows = [foilOnly, older];
      wrap(<TrayPanel {...(layout === "grid" ? grid({ rows }) : props({ rows }))} />);
      await user.click(screen.getByRole("button", { name: "Finish of Storm of Saruman — LTR 72" }));
      expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["Foil", "Unknown"]);
    },
  );

  it("draws an Unknown finish as a question in the grid too — the page's default layout", async () => {
    // The grid's tile arrived on main beside the Unknown state and was merged without it: the
    // menu offered Unknown through the shared options, and nothing marked a tile that held it.
    const user = userEvent.setup();
    const onRows = vi.fn();
    const unknown: ScannerTrayRow = { ...newer, finish: "unknown" };
    wrap(<TrayPanel {...grid({ rows: [unknown, older], onRows })} />);
    const finish = screen.getByRole("button", { name: "Finish of Storm of Saruman — LTR 72" });
    expect(finish).toHaveTextContent("Unknown");
    expect(finish.classList.contains("border-accent")).toBe(true);
    const known = screen.getByRole("button", { name: "Finish of Honored Hierarch — ORI 17" });
    expect(known.classList.contains("border-accent")).toBe(false);
    await user.click(finish);
    await user.click(screen.getByRole("option", { name: "Foil" }));
    expect(edit(onRows, [unknown, older]).map((r) => [r.key, r.finish])).toEqual([
      ["newer", "foil"],
      ["older", "nonfoil"],
    ]);
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
    wrap(
      <TrayPanel {...props({ commitError: "The database is busy — try again in a moment." })} />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The database is busy — try again in a moment.",
    );
  });

  it("offers more printings only for a card with an oracle id", async () => {
    const user = userEvent.setup();
    const onMorePrintings = vi.fn();
    const orphan: ScannerTrayRow = { ...older, oracleId: null };
    wrap(
      <TrayPanel
        {...props({ rows: [{ ...newer, oracleId: "o-storm" }, orphan], onMorePrintings })}
      />,
    );
    await user.click(
      screen.getByRole("button", { name: "More printings of Storm of Saruman — LTR 72" }),
    );
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
   * *Clear all…* is a request the page answers with a question (issue #738) — the panel writes no
   * rows for it, and hands up the button so the caret can come back to it.
   */
  it("asks the page to clear the tray, and clears nothing itself", async () => {
    const user = userEvent.setup();
    const onRows = vi.fn();
    const onClearAll = vi.fn();
    wrap(<TrayPanel {...props({ onRows, onClearAll })} />);
    const clear = screen.getByRole("button", { name: "Clear all…" });
    expect(clear).not.toHaveAttribute("aria-disabled");
    await user.click(clear);
    expect(onClearAll).toHaveBeenCalledExactlyOnceWith(clear);
    expect(onRows).not.toHaveBeenCalled();
  });

  it("offers Clear all… in the grid too, and on a tray still waiting on a pick", async () => {
    const user = userEvent.setup();
    const onClearAll = vi.fn();
    const waiting = rowFromDecision(ambiguous, { finish: "nonfoil" }, 3, "waiting");
    wrap(<TrayPanel {...grid({ rows: [waiting, newer], onClearAll })} />);
    await user.click(screen.getByRole("button", { name: "Clear all…" }));
    expect(onClearAll).toHaveBeenCalledTimes(1);
  });

  it("refuses Clear all… on an empty tray, drawn rather than hidden", async () => {
    const user = userEvent.setup();
    const onClearAll = vi.fn();
    wrap(<TrayPanel {...props({ rows: [], onClearAll })} />);
    const clear = screen.getByRole("button", { name: "Clear all…" });
    expect(clear).toHaveAttribute("aria-disabled", "true");
    await user.click(clear);
    expect(onClearAll).not.toHaveBeenCalled();
  });

  it("refuses Clear all… while a commit is filing these rows", async () => {
    const user = userEvent.setup();
    const onClearAll = vi.fn();
    wrap(<TrayPanel {...props({ committing: true, onClearAll })} />);
    const clear = screen.getByRole("button", { name: "Clear all…" });
    expect(clear).toHaveAttribute("aria-disabled", "true");
    await user.click(clear);
    expect(onClearAll).not.toHaveBeenCalled();
  });

  /**
   * *Archive* (issue #989) sits beside *Clear all…* and on its rules: a press is the page's to
   * act on, greyed and never hidden on an empty tray or while either press is in flight.
   */
  it("asks the page to archive the tray, and writes no rows itself", async () => {
    const user = userEvent.setup();
    const onRows = vi.fn();
    const onArchive = vi.fn();
    wrap(<TrayPanel {...props({ onRows, onArchive })} />);
    const archive = screen.getByRole("button", { name: "Archive" });
    expect(archive).not.toHaveAttribute("aria-disabled");
    await user.click(archive);
    expect(onArchive).toHaveBeenCalledTimes(1);
    expect(onRows).not.toHaveBeenCalled();
  });

  it("offers Archive on a tray still waiting on a pick — the press says why it stops", async () => {
    const user = userEvent.setup();
    const onArchive = vi.fn();
    const waiting = rowFromDecision(ambiguous, { finish: "nonfoil" }, 3, "waiting");
    wrap(<TrayPanel {...grid({ rows: [waiting, newer], onArchive })} />);
    await user.click(screen.getByRole("button", { name: "Archive" }));
    expect(onArchive).toHaveBeenCalledTimes(1);
  });

  it("refuses Archive on an empty tray and while either press is in flight, drawn rather than hidden", async () => {
    const user = userEvent.setup();
    const onArchive = vi.fn();
    const onCommit = vi.fn();
    const empty = wrap(<TrayPanel {...props({ rows: [], onArchive })} />);
    expect(screen.getByRole("button", { name: "Archive" })).toHaveAttribute("aria-disabled", "true");
    empty.unmount();

    const filing = wrap(<TrayPanel {...props({ committing: true, onArchive })} />);
    await user.click(screen.getByRole("button", { name: "Archive" }));
    filing.unmount();

    wrap(<TrayPanel {...props({ archiving: true, onArchive, onCommit })} />);
    const archive = screen.getByRole("button", { name: "Archive" });
    expect(archive).toHaveAttribute("aria-busy", "true");
    await user.click(archive);
    // Add and Clear all are held too: the archive is putting these very rows away.
    await user.click(screen.getByRole("button", { name: /^Add \d+ to collection/ }));
    expect(screen.getByRole("button", { name: "Clear all…" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(onArchive).not.toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("draws no Archive when the page offers none", () => {
    wrap(<TrayPanel {...props()} />);
    expect(screen.queryByRole("button", { name: "Archive" })).not.toBeInTheDocument();
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
    const justScanned: ScannerTrayRow = {
      ...base,
      key: "just-scanned",
      name: "Lightning Bolt",
      addedAt: 3,
    };

    await user.click(screen.getByRole("button", { name: "Remove Honored Hierarch — ORI 17" }));
    expect(edit(onRows, [justScanned, newer, older]).map((r) => r.key)).toEqual([
      "just-scanned",
      "newer",
    ]);

    onRows.mockClear();
    await user.click(
      screen.getByRole("button", { name: "Increase Quantity of Storm of Saruman — LTR 72" }),
    );
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
    const list = await screen.findByRole("group", { name: "Folder for scanned cards" });
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

describe("TrayPanel's prices", () => {
  /** Two printings this file can price apart — the shared fixture gives both rows one id. */
  const storm = { ...newer, cardId: "storm", finish: "foil" as const };
  const hierarch = { ...older, cardId: "hierarch", finish: "nonfoil" as const };
  const quoted = [
    { cardId: "storm", finishPrices: { nonfoil: 0.25, foil: 3.5, etched: null } },
    { cardId: "hierarch", finishPrices: { nonfoil: null, foil: 1, etched: null } },
  ];

  it("quotes each row's own finish once, and asks for every printing in one read", async () => {
    printingPrices.mockResolvedValueOnce(quoted);
    wrap(<TrayPanel {...props({ rows: [storm, hierarch, { ...storm, key: "again" }] })} />);
    const items = within(screen.getByRole("region", { name: "Scanned cards" })).getAllByRole(
      "listitem",
    );
    // The foil row reads its foil figure, never the cheaper nonfoil one.
    expect(await within(items[0]).findByText("$3.50")).toBeInTheDocument();
    expect(printingPrices).toHaveBeenLastCalledWith(["hierarch", "storm"], "tcgplayer");
    // A nonfoil row the marketplace has no nonfoil figure for is unpriced — not its foil price.
    expect(within(items[1]).getByText("Not priced at TCGplayer")).toBeInTheDocument();
    expect(within(items[1]).queryByText("$1.00")).not.toBeInTheDocument();
  });

  it("prices a tile under its card, beside the printing", async () => {
    printingPrices.mockResolvedValueOnce(quoted);
    wrap(<TrayPanel {...grid({ rows: [storm] })} />);
    const tile = screen.getAllByRole("listitem")[0];
    expect(await within(tile).findByText("$3.50")).toBeInTheDocument();
    expect(tile).toHaveTextContent("LTR 72");
  });

  it("prices an Unknown finish along the printing's cheapest finish first", async () => {
    printingPrices.mockResolvedValueOnce(quoted);
    wrap(<TrayPanel {...props({ rows: [{ ...storm, finish: "unknown" }] })} />);
    expect(await screen.findByText("$0.25")).toBeInTheDocument();
  });

  it("asks nothing for a row still waiting on a pick, and draws it no price", async () => {
    const waiting = rowFromDecision(ambiguous, { finish: "nonfoil" }, 3, "waiting");
    printingPrices.mockClear();
    wrap(<TrayPanel {...props({ rows: [waiting] })} />);
    await screen.findByText("Pick a printing");
    expect(printingPrices).not.toHaveBeenCalled();
    expect(screen.queryByText(/^Not priced at/)).not.toBeInTheDocument();
  });
});

describe("TrayPanel's grid", () => {
  /** The tray's tiles, found inside the region so nothing else on the page can be counted. */
  function tiles(): HTMLElement[] {
    return within(screen.getByRole("region", { name: "Scanned cards" })).getAllByRole("listitem");
  }

  it("draws a tile per card, newest first, each card a press named for the printings it opens", () => {
    wrap(<TrayPanel {...grid()} />);
    const items = tiles();
    expect(items).toHaveLength(2);
    expect(
      within(items[0]).getByRole("button", { name: "More printings of Storm of Saruman — LTR 72" }),
    ).toBeInTheDocument();
    expect(items[0]).toHaveTextContent("LTR 72");
    expect(
      within(items[1]).getByRole("button", { name: "More printings of Honored Hierarch — ORI 17" }),
    ).toBeInTheDocument();
    expect(items[1]).toHaveTextContent("ORI 17");
  });

  it("draws each tile as a whole card, at a size larger than the row's thumbnail", () => {
    const { container } = wrap(<TrayPanel {...grid({ rows: [newer] })} />);
    const images = Array.from(container.querySelectorAll("img"));
    expect(images).toHaveLength(1);
    expect(images[0].getAttribute("src")).toContain("/grid/");
    expect(images[0].getAttribute("src")).not.toContain("/art/");
  });

  it("opens more printings from the card, with the tile's own row", async () => {
    const user = userEvent.setup();
    const onMorePrintings = vi.fn();
    wrap(<TrayPanel {...grid({ onMorePrintings })} />);
    await user.click(
      screen.getByRole("button", { name: "More printings of Honored Hierarch — ORI 17" }),
    );
    expect(onMorePrintings).toHaveBeenCalledTimes(1);
    expect(onMorePrintings).toHaveBeenCalledWith(expect.objectContaining({ key: "older" }));
  });

  it("draws no card to press for a row with no oracle id, and keeps the rest of its tile", () => {
    const orphan: ScannerTrayRow = { ...older, oracleId: null };
    wrap(<TrayPanel {...grid({ rows: [newer, orphan] })} />);
    const items = tiles();
    expect(
      within(items[1]).queryByRole("button", { name: /^More printings of/ }),
    ).not.toBeInTheDocument();
    expect(
      within(items[1]).getByRole("button", { name: "Remove Honored Hierarch — ORI 17" }),
    ).toBeInTheDocument();
    expect(
      within(items[1]).getByRole("button", {
        name: "Increase Quantity of Honored Hierarch — ORI 17",
      }),
    ).toBeInTheDocument();
  });

  it("marks a foil copy and a count of more than one on the card, and neither on a single plain one", () => {
    wrap(<TrayPanel {...grid({ rows: [{ ...newer, finish: "foil", quantity: 3 }, older] })} />);
    const items = tiles();
    // `CardArt`'s own chip, which is what says the finish on every wall.
    expect(items[0].querySelector("[data-card-marks]")).not.toBeNull();
    expect(items[1].querySelector("[data-card-marks]")).toBeNull();
    // The count tag draws the bare number; a single copy draws none.
    expect(within(items[0]).getByText("3")).toBeInTheDocument();
    expect(within(items[1]).queryByText("1")).not.toBeInTheDocument();
  });

  it("says which layout is drawn, and asks for the other one", async () => {
    const user = userEvent.setup();
    const onLayout = vi.fn();
    wrap(<TrayPanel {...grid({ onLayout })} />);
    const toggle = screen.getByRole("group", { name: "Tray layout" });
    const gridButton = within(toggle).getByRole("button", { name: "Grid" });
    const listButton = within(toggle).getByRole("button", { name: "List" });
    expect(gridButton).toHaveAttribute("aria-pressed", "true");
    expect(listButton).toHaveAttribute("aria-pressed", "false");

    await user.click(listButton);
    expect(onLayout).toHaveBeenCalledWith("list");
    // The layout already drawn is a press that asks for nothing, so it writes nothing.
    await user.click(gridButton);
    expect(onLayout).toHaveBeenCalledTimes(1);
  });

  it("offers the same toggle in the list, pressed the other way", async () => {
    const user = userEvent.setup();
    const onLayout = vi.fn();
    wrap(<TrayPanel {...props({ onLayout })} />);
    const toggle = screen.getByRole("group", { name: "Tray layout" });
    expect(within(toggle).getByRole("button", { name: "List" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await user.click(within(toggle).getByRole("button", { name: "Grid" }));
    expect(onLayout).toHaveBeenCalledWith("grid");
  });

  it("offers the toggle on an empty tray, under the sentence saying where cards will appear", () => {
    wrap(<TrayPanel {...grid({ rows: [] })} />);
    expect(screen.getByText("Cards you scan appear here.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Grid" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Add 0 to collection" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });

  /**
   * A tile's controls are the row's, down to the reducer call: each edit is a function of the rows
   * as they are when the page applies it, so a card the pump added after this render survives.
   */
  it("steps, refinishes and removes a tile through the reducer, against the latest rows", async () => {
    const user = userEvent.setup();
    const onRows = vi.fn();
    wrap(<TrayPanel {...grid({ onRows })} />);
    const justScanned: ScannerTrayRow = {
      ...base,
      key: "just-scanned",
      name: "Lightning Bolt",
      addedAt: 3,
    };

    await user.click(
      screen.getByRole("button", { name: "Increase Quantity of Storm of Saruman — LTR 72" }),
    );
    expect(edit(onRows, [justScanned, newer, older]).map((r) => [r.key, r.quantity])).toEqual([
      ["just-scanned", 1],
      ["newer", 2],
      ["older", 1],
    ]);

    onRows.mockClear();
    await pickOption(user, "Finish of Storm of Saruman — LTR 72", "Foil");
    expect(edit(onRows, [justScanned, newer, older]).map((r) => [r.key, r.finish])).toEqual([
      ["just-scanned", "nonfoil"],
      ["newer", "foil"],
      ["older", "nonfoil"],
    ]);

    onRows.mockClear();
    await user.click(screen.getByRole("button", { name: "Remove Honored Hierarch — ORI 17" }));
    expect(edit(onRows, [justScanned, newer, older]).map((r) => r.key)).toEqual([
      "just-scanned",
      "newer",
    ]);
  });

  it("asks for a pick on a waiting tile — its candidates the whole question — and a press settles it", async () => {
    const user = userEvent.setup();
    const onRows = vi.fn();
    const waiting = rowFromDecision(ambiguous, { finish: "nonfoil" }, 3, "waiting");
    wrap(<TrayPanel {...grid({ rows: [waiting, newer], onRows })} />);

    const choices = screen.getByRole("group", { name: `Printings of ${waiting.name}` });
    expect(within(choices).getAllByRole("button")).toHaveLength(waiting.choices.length);
    const tile = choices.closest("li")!;
    expect(within(tile).getByText("Pick a printing")).toBeInTheDocument();
    // Nothing on a waiting tile acts on a card it might not be.
    expect(
      within(tile).queryByRole("button", { name: /^Increase Quantity of/ }),
    ).not.toBeInTheDocument();
    expect(within(tile).queryByRole("button", { name: /^Finish of/ })).not.toBeInTheDocument();
    expect(
      within(tile).queryByRole("button", { name: /^More printings of/ }),
    ).not.toBeInTheDocument();

    const choice = waiting.choices[1];
    await user.click(
      within(choices).getByRole("button", {
        name: `${choice.name} — ${choice.setCode.toUpperCase()} ${choice.collectorNumber}`,
      }),
    );
    const next = edit(onRows, [waiting, newer]);
    expect(next[0].cardId).toBe(choice.cardId);
    expect(next[0].choices).toEqual([]);
    expect(next[1]).toBe(newer);
  });

  it("walks the caret through the grid's questions too — a waiting tile's candidates, then a finish", async () => {
    const user = userEvent.setup();
    const waiting = rowFromDecision(ambiguous, { finish: "nonfoil" }, 3, "waiting");
    const unknown: ScannerTrayRow = { ...older, finish: "unknown" };
    wrap(<TrayPanel {...grid({ rows: [newer, waiting, unknown] })} />);
    const next = screen.getByRole("button", { name: NEXT_DECISION_LABEL });
    await user.click(next);
    expect(document.activeElement).toBe(
      within(screen.getByRole("group", { name: `Printings of ${waiting.name}` })).getAllByRole(
        "button",
      )[0],
    );
    await user.click(next);
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Finish of Honored Hierarch — ORI 17" }),
    );
  });

  it("removes a waiting tile by the card's name", async () => {
    const user = userEvent.setup();
    const onRows = vi.fn();
    const waiting = rowFromDecision(ambiguous, { finish: "nonfoil" }, 3, "waiting");
    wrap(<TrayPanel {...grid({ rows: [waiting, newer], onRows })} />);
    await user.click(screen.getByRole("button", { name: `Remove ${waiting.name}` }));
    expect(edit(onRows, [waiting, newer]).map((r) => r.key)).toEqual(["newer"]);
  });

  /**
   * Issue #1004: a waiting tile spans every column the grid has, and every tile's remove is the
   * first press in it — its top-right corner, before the card or the candidates under it.
   */
  it("lays a waiting tile across the whole grid, with each tile's remove ahead of its card", () => {
    const waiting = rowFromDecision(ambiguous, { finish: "nonfoil" }, 3, "waiting");
    wrap(<TrayPanel {...grid({ rows: [waiting, newer] })} />);
    const [question, tile] = screen.getAllByRole("listitem");
    expect(question).toHaveClass("col-span-full");
    expect(within(question).getAllByRole("button")[0]).toHaveAccessibleName(
      `Remove ${waiting.name}`,
    );
    expect(within(tile).getAllByRole("button")[0]).toHaveAccessibleName(
      "Remove Storm of Saruman — LTR 72",
    );
  });

  it("flashes only the tile it is told to", () => {
    const { container } = wrap(<TrayPanel {...grid({ flashKey: "older" })} />);
    const flashes = container.querySelectorAll("[data-tray-flash]");
    expect(flashes).toHaveLength(1);
    expect(flashes[0].closest("li")).toHaveTextContent("Honored Hierarch");
  });
});

describe("TrayPanel filing somewhere that is not the collection", () => {
  const destination = { title: "Scanned for their side", name: "their side" };

  it("heads the tray and names its press with the destination's words", async () => {
    const onCommit = vi.fn();
    wrap(<TrayPanel {...props({ destination, onCommit })} />);
    expect(screen.getByRole("region", { name: "Scanned for their side" })).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Scanned for their side, 2 copies" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /to collection/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Add 2 to their side" }));
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it("still says how many cards it leaves for want of a finish", () => {
    const unknown: ScannerTrayRow = { ...older, finish: "unknown" };
    wrap(<TrayPanel {...props({ destination, rows: [newer, unknown] })} />);
    expect(
      screen.getByRole("button", { name: "Add 1 to their side · 1 needs a finish" }),
    ).toBeInTheDocument();
  });

  it("keeps both of Add's refusals", async () => {
    const onCommit = vi.fn();
    const waiting = rowFromDecision(ambiguous, { finish: "nonfoil" }, 3, "waiting");
    const { unmount } = wrap(
      <TrayPanel {...props({ destination, onCommit, rows: [waiting, newer] })} />,
    );
    const unpicked = screen.getByRole("button", { name: "Add 2 to their side" });
    expect(unpicked).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(unpicked);
    unmount();
    wrap(
      <TrayPanel
        {...props({ destination, onCommit, rows: [{ ...older, finish: "unknown" }] })}
      />,
    );
    const unfinished = screen.getByRole("button", {
      name: "Add 0 to their side · 1 needs a finish",
    });
    expect(unfinished).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(unfinished);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("draws no Archive — the scan history is the Scanner view's own", () => {
    wrap(<TrayPanel {...props({ destination, onArchive: vi.fn() })} />);
    expect(screen.queryByRole("button", { name: "Archive" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clear all…" })).toBeInTheDocument();
  });

  it("draws no folder to file into, and asks for no folder list", async () => {
    collectionFolderList.mockClear();
    wrap(<TrayPanel {...props({ destination })} />);
    // The price read has answered, so the folder read would have gone out by now too.
    await screen.findAllByText("Not priced at TCGplayer");
    expect(screen.queryByRole("button", { name: /^Folder:/ })).not.toBeInTheDocument();
    expect(collectionFolderList).not.toHaveBeenCalled();
    // The page leaves the deck's press out with it.
    expect(screen.queryByRole("button", { name: "Create deck…" })).not.toBeInTheDocument();
  });

  it("draws the destination's summary where the folder stood, handed the rows on screen", () => {
    const summary = vi.fn((rows: readonly ScannerTrayRow[]) => (
      <p>Scanned so far: {rows.length} rows</p>
    ));
    wrap(<TrayPanel {...props({ destination: { ...destination, summary } })} />);
    const footer = screen.getByRole("button", { name: "Add 2 to their side" }).closest("footer");
    expect(footer).toHaveTextContent("Scanned so far: 2 rows");
    expect(summary).toHaveBeenLastCalledWith([newer, older]);
  });

  it("prices the rows at the destination's marketplace, not the reader's", async () => {
    printingPrices.mockClear();
    printingPrices.mockResolvedValueOnce([
      { cardId: newer.cardId, finishPrices: { nonfoil: 2.5, foil: null, etched: null } },
    ]);
    wrap(
      <TrayPanel
        {...props({ rows: [newer], destination: { ...destination, marketplace: "cardmarket" } })}
      />,
    );
    // Cardmarket quotes in euros, and the figure is written as one.
    expect(await screen.findByText(/2[.,]50/)).toHaveTextContent("€");
    expect(printingPrices).toHaveBeenLastCalledWith([newer.cardId], "cardmarket");
  });

  it("says its notice under the heading, and nothing where there is none", () => {
    const { unmount } = wrap(
      <TrayPanel {...props({ destination, notice: "3 cards were already in the tray." })} />,
    );
    expect(screen.getByRole("note")).toHaveTextContent("3 cards were already in the tray.");
    unmount();
    wrap(<TrayPanel {...props({ destination, notice: null })} />);
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
  });
});
