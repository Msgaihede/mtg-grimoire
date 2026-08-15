import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ExportCard } from "./format";

const exportWriteFile = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: { exportWriteFile },
}));

const save = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/plugin-dialog", () => ({ save }));

const copyText = vi.hoisted(() => vi.fn());
vi.mock("@/lib/clipboard", () => ({ copyText }));

import { ipc } from "@/lib/ipc";
import { save as saveMock } from "@tauri-apps/plugin-dialog";
import { copyText as copyTextMock } from "@/lib/clipboard";
import { ExportDialog } from "./ExportDialog";

/**
 * One card, overridden per test.
 *
 * The three category defaults are what a single-pile export always looked like — the main deck,
 * switched on — so every assertion written before `ExportCard` widened still means what it did.
 * `format.test.ts` keeps the same builder for the same reason; the two are deliberately not
 * shared, because a fixture exported from either file would be a second thing to keep in step.
 */
const exportCard = (over: Partial<ExportCard> = {}): ExportCard => ({
  name: "Sol Ring",
  quantity: 1,
  setCode: "ltc",
  collectorNumber: "285",
  categoryName: "Main deck",
  categoryKind: "main",
  categoryActive: true,
  ...over,
});

const BOLT = exportCard({
  name: "Lightning Bolt",
  quantity: 2,
  setCode: "lea",
  collectorNumber: "161",
});

const noop = () => {};

beforeEach(() => {
  exportWriteFile.mockReset();
  exportWriteFile.mockResolvedValue(undefined);
  save.mockReset();
  save.mockResolvedValue(null);
  copyText.mockReset();
  copyText.mockResolvedValue(undefined);
});

describe("ExportDialog", () => {
  it("previews the plain format by default", async () => {
    render(
      <ExportDialog
        open
        subject="Removal"
        cards={[BOLT]}
        suggestedFileName="Removal"
        onDismiss={noop}
        onClose={noop}
      />,
    );
    expect(await screen.findByText("2 Lightning Bolt")).toBeInTheDocument();
  });

  it("redraws the preview when the format changes", async () => {
    const user = userEvent.setup();
    render(
      <ExportDialog
        open
        subject="Removal"
        cards={[BOLT]}
        suggestedFileName="Removal"
        onDismiss={noop}
        onClose={noop}
      />,
    );
    await user.click(await screen.findByRole("radio", { name: "Moxfield" }));
    // Moxfield writes its section heading even for a single section — the vocabulary is fixed, so
    // `Deck` is a fact about where these cards are and not a separator a one-pile file can drop.
    // `findByText` normalizes the newline between the two, which is why this reads as one line.
    expect(await screen.findByText("Deck 2 Lightning Bolt (LEA) 161")).toBeInTheDocument();
  });

  it("offers all six formats", async () => {
    render(
      <ExportDialog
        open
        subject="Removal"
        cards={[BOLT]}
        suggestedFileName="Removal"
        onDismiss={noop}
        onClose={noop}
      />,
    );
    // The row maps `EXPORT_FORMATS`, so this counts the array rather than a list drawn by hand —
    // a seventh writer reaches the reader without an edit here, and this is what says so.
    expect(await screen.findAllByRole("radio")).toHaveLength(6);
    expect(screen.getByRole("radio", { name: "Archidekt" })).toBeInTheDocument();
  });

  it("says how many cards a format leaves out, and stops saying it when one does not", async () => {
    const user = userEvent.setup();
    render(
      <ExportDialog
        open
        subject="Atraxa"
        cards={[
          exportCard({ name: "Sol Ring", categoryName: "Ramp" }),
          exportCard({
            name: "Forest",
            quantity: 6,
            categoryName: "Cuts",
            categoryActive: false,
          }),
        ]}
        suggestedFileName="Atraxa"
        onDismiss={noop}
        onClose={noop}
      />,
    );
    // Copies, not rows: six basic lands on one row are six cards missing from the file.
    await user.click(await screen.findByRole("radio", { name: "Arena" }));
    expect(screen.getByText(/6 cards in switched-off piles are not written/)).toBeInTheDocument();

    // Moxfield has a maybeboard, so it writes that pile and leaves nothing out. The sentence is
    // about the format on screen, so it has to go with it.
    await user.click(screen.getByRole("radio", { name: "Moxfield" }));
    expect(screen.queryByText(/not written in this format/)).not.toBeInTheDocument();
  });

  it("says it in the singular for one card", async () => {
    const user = userEvent.setup();
    render(
      <ExportDialog
        open
        subject="Atraxa"
        cards={[
          exportCard({ name: "Sol Ring", categoryName: "Ramp" }),
          exportCard({ name: "Mox Amber", categoryName: "Cuts", categoryActive: false }),
        ]}
        suggestedFileName="Atraxa"
        onDismiss={noop}
        onClose={noop}
      />,
    );
    await user.click(await screen.findByRole("radio", { name: "MTGO" }));
    expect(
      screen.getByText("1 card in a switched-off pile is not written in this format."),
    ).toBeInTheDocument();
  });

  it("copies the text of the format that is showing", async () => {
    const user = userEvent.setup();
    const copy = vi.mocked(copyTextMock);
    render(
      <ExportDialog
        open
        subject="Removal"
        cards={[BOLT]}
        suggestedFileName="Removal"
        onDismiss={noop}
        onClose={noop}
      />,
    );
    await user.click(await screen.findByRole("radio", { name: "CSV" }));
    await user.click(screen.getByRole("button", { name: /Copy/ }));
    expect(copy).toHaveBeenCalledWith(
      "Quantity,Name,Set,Collector number,Category\n2,Lightning Bolt,lea,161,Main deck\n",
    );
  });

  it("clears the Copied status when the format changes, since it would misrepresent what's on the clipboard", async () => {
    const user = userEvent.setup();
    render(
      <ExportDialog
        open
        subject="Removal"
        cards={[BOLT]}
        suggestedFileName="Removal"
        onDismiss={noop}
        onClose={noop}
      />,
    );
    await user.click(screen.getByRole("button", { name: /Copy/ }));
    expect(await screen.findByRole("status")).toHaveTextContent("Copied.");

    // The preview redraws for CSV; the clipboard still holds the Plain-text copy. The status
    // line has to go with it, or it sits beside text it is no longer telling the truth about.
    await user.click(await screen.findByRole("radio", { name: "CSV" }));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("reports a clipboard failure rather than swallowing it", async () => {
    const user = userEvent.setup();
    vi.mocked(copyTextMock).mockRejectedValueOnce(new Error("clipboard access denied"));
    render(
      <ExportDialog
        open
        subject="Removal"
        cards={[BOLT]}
        suggestedFileName="Removal"
        onDismiss={noop}
        onClose={noop}
      />,
    );
    await user.click(screen.getByRole("button", { name: /Copy/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/clipboard access denied/);
    // No false "Copied." beside the refusal.
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("writes the file Rust was told to write, at the path the picker answered", async () => {
    const user = userEvent.setup();
    vi.mocked(saveMock).mockResolvedValue("D:\\decks\\Removal.txt");
    render(
      <ExportDialog
        open
        subject="Removal"
        cards={[BOLT]}
        suggestedFileName="Removal"
        onDismiss={noop}
        onClose={noop}
      />,
    );
    await user.click(screen.getByRole("button", { name: /Save as/ }));
    expect(vi.mocked(ipc.exportWriteFile)).toHaveBeenCalledWith(
      "D:\\decks\\Removal.txt",
      "2 Lightning Bolt\n",
    );
  });

  it("writes nothing when the picker is cancelled", async () => {
    const user = userEvent.setup();
    // The picker answers null on cancel. Writing to "null" is the bug this pins.
    vi.mocked(saveMock).mockResolvedValue(null);
    render(
      <ExportDialog
        open
        subject="Removal"
        cards={[BOLT]}
        suggestedFileName="Removal"
        onDismiss={noop}
        onClose={noop}
      />,
    );
    await user.click(screen.getByRole("button", { name: /Save as/ }));
    expect(vi.mocked(ipc.exportWriteFile)).not.toHaveBeenCalled();
  });

  it("reports a refused write rather than closing on it", async () => {
    const user = userEvent.setup();
    vi.mocked(saveMock).mockResolvedValue("D:\\decks\\Removal.txt");
    vi.mocked(ipc.exportWriteFile).mockRejectedValue("could not write: access denied");
    const onDismiss = vi.fn();
    render(
      <ExportDialog
        open
        subject="Removal"
        cards={[BOLT]}
        suggestedFileName="Removal"
        onDismiss={onDismiss}
        onClose={noop}
      />,
    );
    await user.click(screen.getByRole("button", { name: /Save as/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/access denied/);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("mounts nothing while closed", () => {
    render(
      <ExportDialog
        open={false}
        subject="Removal"
        cards={[BOLT]}
        suggestedFileName="Removal"
        onDismiss={noop}
        onClose={noop}
      />,
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
