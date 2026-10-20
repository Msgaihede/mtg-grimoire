import { useState } from "react";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Dialog } from "@grimoire/ui/components/Dialog";
import { DialogHostContext } from "@grimoire/ui/lib/dialogHost";
import { navigate } from "./router";
import { claimBack, isSheetEntry, resetSheetHistory, sheetHistoryIdle } from "./sheetHistory";

const HOST = { claimBack, swipeToClose: true };

beforeEach(() => {
  resetSheetHistory();
  window.history.replaceState(null, "", "/");
  window.history.pushState(null, "", "/decks");
});
afterEach(() => sheetHistoryIdle());

const url = (): string => window.location.pathname + window.location.search;
const popped = (): Promise<void> =>
  new Promise((resolve) => window.addEventListener("popstate", () => resolve(), { once: true }));

/** A page with two sheets: the second opened from a row of the first, which closes as it does. */
function Page({ onNavigate }: { onNavigate?: () => void }) {
  const [open, setOpen] = useState<"none" | "first" | "second">("none");
  return (
    <DialogHostContext.Provider value={HOST}>
      <button type="button" onClick={() => setOpen("first")}>
        Open
      </button>
      <Dialog
        open={open === "first"}
        title="First"
        closeLabel="Close first"
        size="w-full"
        onDismiss={() => setOpen("none")}
        onClose={() => setOpen("none")}
      >
        <button type="button" onClick={() => setOpen("second")}>
          Next
        </button>
        <button
          type="button"
          onClick={() => {
            setOpen("none");
            onNavigate?.();
          }}
        >
          Go
        </button>
      </Dialog>
      <Dialog
        open={open === "second"}
        title="Second"
        closeLabel="Close second"
        size="w-full"
        onDismiss={() => setOpen("none")}
        onClose={() => setOpen("none")}
      >
        <p>Second sheet</p>
      </Dialog>
    </DialogHostContext.Provider>
  );
}

describe("a sheet on the phone face", () => {
  it("is one entry at the address the reader is on, and Back closes it", async () => {
    render(<Page />);
    const length = window.history.length;
    await userEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(screen.getByRole("dialog", { name: "First" })).toBeInTheDocument();
    expect(window.history.length).toBe(length + 1);
    expect(isSheetEntry(window.history.state)).toBe(true);
    expect(url()).toBe("/decks");

    const back = popped();
    act(() => window.history.back());
    await back;
    expect(screen.queryByRole("dialog", { name: "First" })).toBeNull();
    expect(url()).toBe("/decks");
    expect(isSheetEntry(window.history.state)).toBe(false);
  });

  it("takes its entry back out when the ✕ closes it, so the next Back leaves the page", async () => {
    render(<Page />);
    await userEvent.click(screen.getByRole("button", { name: "Open" }));
    const out = popped();
    await userEvent.click(screen.getByRole("button", { name: "Close first" }));
    await out;
    expect(isSheetEntry(window.history.state)).toBe(false);

    const left = popped();
    window.history.back();
    await left;
    expect(url()).toBe("/");
  });

  it("hands its entry to a sheet opened from one of its rows rather than stacking a second", async () => {
    render(<Page />);
    await userEvent.click(screen.getByRole("button", { name: "Open" }));
    const length = window.history.length;
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("dialog", { name: "Second" })).toBeInTheDocument();
    await sheetHistoryIdle();
    expect(window.history.length).toBe(length);
    expect(isSheetEntry(window.history.state)).toBe(true);

    const back = popped();
    act(() => window.history.back());
    await back;
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(url()).toBe("/decks");
  });

  it("gives up its entry to a navigation made from inside it, so Back skips the closed sheet", async () => {
    render(
      <Page onNavigate={() => navigate({ view: "collection", deckId: null, cardId: null })} />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Open" }));
    const landed = popped();
    await userEvent.click(screen.getByRole("button", { name: "Go" }));
    await landed;
    await sheetHistoryIdle();
    expect(url()).toBe("/collection");
    expect(isSheetEntry(window.history.state)).toBe(false);

    const back = popped();
    window.history.back();
    await back;
    // The page the sheet was over, and not a step that reopens nothing.
    expect(url()).toBe("/decks");
    expect(isSheetEntry(window.history.state)).toBe(false);
  });

  it("keeps a Back step while it refuses Back, so the next Back asks it again (issue #1158)", async () => {
    let refusing = true;
    let asked = 0;
    function Busy() {
      const [open, setOpen] = useState(false);
      const dismiss = () => {
        asked++;
        if (!refusing) setOpen(false);
      };
      return (
        <DialogHostContext.Provider value={HOST}>
          <button type="button" onClick={() => setOpen(true)}>
            Open
          </button>
          <Dialog
            open={open}
            title="Busy"
            closeLabel="Close"
            size="w-full"
            onDismiss={dismiss}
            onClose={dismiss}
          >
            <p>Adding</p>
          </Dialog>
        </DialogHostContext.Provider>
      );
    }
    render(<Busy />);
    await userEvent.click(screen.getByRole("button", { name: "Open" }));

    const refused = popped();
    act(() => window.history.back());
    await refused;
    expect(asked).toBe(1);
    expect(screen.getByRole("dialog", { name: "Busy" })).toBeInTheDocument();
    expect(isSheetEntry(window.history.state)).toBe(true);
    expect(url()).toBe("/decks");

    refusing = false;
    const closed = popped();
    act(() => window.history.back());
    await closed;
    expect(asked).toBe(2);
    expect(screen.queryByRole("dialog", { name: "Busy" })).toBeNull();
    // The page the dialog was over, not the one before it.
    expect(url()).toBe("/decks");
    expect(isSheetEntry(window.history.state)).toBe(false);
  });

  it("claims nothing where no host lends Back — the desktop face's dialogs", async () => {
    const length = window.history.length;
    function Bare() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Open
          </button>
          <Dialog
            open={open}
            title="Bare"
            closeLabel="Close"
            size="w-full"
            onDismiss={() => setOpen(false)}
            onClose={() => setOpen(false)}
          >
            <p>Body</p>
          </Dialog>
        </>
      );
    }
    render(<Bare />);
    await userEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(window.history.length).toBe(length);
  });
});
