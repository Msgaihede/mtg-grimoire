import { useRef, useState } from "react";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("@grimoire/fake/core"));
vi.mock("@tauri-apps/api/event", () => import("@grimoire/fake/event"));
vi.mock("@tauri-apps/api/window", () => import("@grimoire/fake/window"));

import { NEEDS_A_FINISH_ROW, TRAY_ROWS } from "@grimoire/ui/features/scanner/fixtures";
import type { ScannerTrayRow } from "@grimoire/ui/lib/ipc";
import { renderPhone } from "../testing";
import { TrayActionsSheet } from "./TrayActionsSheet";
import { ARCHIVING } from "./TrayBar";

const RESOLVED = TRAY_ROWS.filter((row) => row.choices.length === 0);

type Props = Parameters<typeof TrayActionsSheet>[0];

/**
 * The sheet as the page mounts it: a `⋯` the page owns opens it, `onDismiss` hands the caret back
 * to that press, and `onClose` only closes.
 */
function mount(over: Partial<Omit<Props, "open" | "onClose" | "onDismiss">> = {}) {
  const props = {
    rows: RESOLVED as readonly ScannerTrayRow[],
    committing: false,
    onCreateDeck: vi.fn(),
    onClearAll: vi.fn(),
    onArchive: vi.fn(),
    onHistory: vi.fn(),
    ...over,
  };
  function Page() {
    const [open, setOpen] = useState(false);
    const more = useRef<HTMLButtonElement>(null);
    return (
      <>
        <button ref={more} type="button" onClick={() => setOpen(true)}>
          Tray actions
        </button>
        <TrayActionsSheet
          open={open}
          onClose={() => setOpen(false)}
          onDismiss={() => {
            setOpen(false);
            more.current?.focus();
          }}
          {...props}
        />
      </>
    );
  }
  renderPhone(<Page />);
  return props;
}

/** Open the sheet from its press; answers the press and the sheet. */
async function openSheet() {
  const more = screen.getByRole("button", { name: "Tray actions" });
  await userEvent.click(more);
  return { more, sheet: await screen.findByRole("dialog", { name: "Scanned cards" }) };
}

const gone = () => waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

describe("the tray's actions", () => {
  it("asks the page to make a deck and to clear, closing itself first", async () => {
    const props = mount();
    let { sheet } = await openSheet();
    await userEvent.click(within(sheet).getByRole("button", { name: "Create deck…" }));
    expect(props.onCreateDeck).toHaveBeenCalledTimes(1);
    await gone();

    ({ sheet } = await openSheet());
    await userEvent.click(within(sheet).getByRole("button", { name: "Clear all…" }));
    expect(props.onClearAll).toHaveBeenCalledTimes(1);
    await gone();
  });

  it("hands the caret back to the press that opened it on its ✕ and on Escape", async () => {
    mount();
    const { more, sheet } = await openSheet();
    await userEvent.click(within(sheet).getByRole("button", { name: "Close tray actions" }));
    await gone();
    expect(more).toHaveFocus();

    await openSheet();
    await userEvent.keyboard("{Escape}");
    await gone();
    expect(more).toHaveFocus();
  });

  it("says why a deck cannot be made yet, in the row's own name", async () => {
    const props = mount({ rows: [NEEDS_A_FINISH_ROW, ...RESOLVED] });
    const { sheet } = await openSheet();
    // A greyed row's name includes its reason.
    const deck = within(sheet).getByRole("button", {
      name: /^Create deck…\s*Choose a finish for every card first$/,
    });
    expect(deck).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(deck);
    expect(props.onCreateDeck).not.toHaveBeenCalled();
    // A card waiting on a finish can still be thrown away.
    expect(within(sheet).getByRole("button", { name: "Clear all…" })).not.toHaveAttribute(
      "aria-disabled",
    );
  });

  it("refuses the tray's acts on an empty tray, each in words", async () => {
    const props = mount({ rows: [] });
    const { sheet } = await openSheet();
    const clear = within(sheet).getByRole("button", { name: /^Clear all…\s*Nothing scanned yet$/ });
    await userEvent.click(clear);
    expect(props.onClearAll).not.toHaveBeenCalled();
    expect(
      within(sheet).getByRole("button", { name: /^Create deck…\s*Nothing scanned yet$/ }),
    ).toHaveAttribute("aria-disabled", "true");
    const archive = within(sheet).getByRole("button", { name: /^Archive\s*Nothing scanned yet$/ });
    expect(archive).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(archive);
    expect(props.onArchive).not.toHaveBeenCalled();
  });

  /** Archive (issue #989): the desktop tray's press, as a row of the sheet. */
  it("archives, closing the sheet and handing the caret back to the ⋯", async () => {
    const props = mount();
    const { more, sheet } = await openSheet();
    await userEvent.click(within(sheet).getByRole("button", { name: "Archive" }));
    expect(props.onArchive).toHaveBeenCalledTimes(1);
    await gone();
    expect(more).toHaveFocus();
  });

  it("leaves a card waiting on a printing to the press, which says the plan's sentence", async () => {
    // Clear all's terms, not Add's: the press goes, and `useTrayCommit` refuses it in words.
    mount({ rows: [...TRAY_ROWS] });
    const { sheet } = await openSheet();
    expect(within(sheet).getByRole("button", { name: "Archive" })).not.toHaveAttribute(
      "aria-disabled",
    );
  });

  it("holds every act while an archive is out, saying where the cards are going", async () => {
    mount({ archiving: true });
    const { sheet } = await openSheet();
    for (const label of ["Archive", "Create deck…", "Clear all…"]) {
      expect(
        within(sheet).getByRole("button", { name: new RegExp(`^${label}\\s*${ARCHIVING}$`) }),
      ).toHaveAttribute("aria-disabled", "true");
    }
  });

  it("holds every act while an Add is out, saying where the cards are going", async () => {
    const props = mount({ committing: true });
    const { sheet } = await openSheet();
    for (const label of ["Archive", "Create deck…", "Clear all…"]) {
      expect(
        within(sheet).getByRole("button", {
          name: new RegExp(`^${label}\\s*Adding to your collection…$`),
        }),
      ).toHaveAttribute("aria-disabled", "true");
    }
    await userEvent.click(within(sheet).getByRole("button", { name: /^Clear all…/ }));
    expect(props.onClearAll).not.toHaveBeenCalled();
  });

  it("opens the scan history, whatever the tray holds", async () => {
    const props = mount({ rows: [], archiving: true });
    const { sheet } = await openSheet();
    // Never refused: an empty tray is the usual moment to look back.
    await userEvent.click(within(sheet).getByRole("button", { name: "Scan history" }));
    expect(props.onHistory).toHaveBeenCalledTimes(1);
    await gone();
  });

  it("offers Add card… first only where the page hands it in, closing itself first", async () => {
    const onAddCard = vi.fn();
    mount({ onAddCard });
    const { sheet } = await openSheet();
    const rows = within(sheet).getAllByRole("button").filter((b) => b.closest("li"));
    expect(rows[0]).toHaveAccessibleName(/^Add card…/);
    await userEvent.click(rows[0]);
    expect(onAddCard).toHaveBeenCalledTimes(1);
    await gone();
  });

  it("draws no Add card… where the page hands it none — upright, the tray sheet has its own", async () => {
    mount();
    const { sheet } = await openSheet();
    expect(within(sheet).queryByRole("button", { name: /Add card/ })).toBeNull();
  });

  it("draws neither Archive nor the history where the page hands it neither", async () => {
    mount({ onArchive: undefined, onHistory: undefined });
    const { sheet } = await openSheet();
    expect(within(sheet).queryByRole("button", { name: /Archive/ })).toBeNull();
    expect(within(sheet).queryByRole("button", { name: /Scan history/ })).toBeNull();
  });
});

describe("the tray's actions, filing somewhere that is not the collection", () => {
  const destination = { title: "Scanned for their side", name: "their side" };

  it("offers Clear all… alone", async () => {
    const props = mount({ destination });
    const { sheet } = await openSheet();
    expect(within(sheet).queryByRole("button", { name: /Create deck/ })).toBeNull();
    // The archive and its history are the Scanner tab's record, whatever the page hands in.
    expect(within(sheet).queryByRole("button", { name: /Archive/ })).toBeNull();
    expect(within(sheet).queryByRole("button", { name: /Scan history/ })).toBeNull();
    await userEvent.click(within(sheet).getByRole("button", { name: "Clear all…" }));
    expect(props.onClearAll).toHaveBeenCalledTimes(1);
    expect(props.onCreateDeck).not.toHaveBeenCalled();
  });

  it("says where the cards are going while the write is out", async () => {
    mount({ destination, committing: true });
    const { sheet } = await openSheet();
    expect(
      within(sheet).getByRole("button", { name: /^Clear all…\s*Adding to their side…$/ }),
    ).toHaveAttribute("aria-disabled", "true");
  });
});
