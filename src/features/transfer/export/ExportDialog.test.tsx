import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { transferCard } from "../fixtures";
import type { TransferCard } from "../TransferCard";
import { EXPORT_FORMATS, EXPORT_FORMAT_LABEL } from "./format";

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
import { useAppStore } from "@/lib/store";
import { ExportDialog } from "./ExportDialog";

/**
 * One card, overridden per test.
 *
 * The three category defaults are what a single-pile export always looked like — the main deck,
 * switched on — so every assertion written before `TransferCard` existed still means what it
 * did. `format.test.ts` keeps the same builder for the same reason; the two are deliberately not
 * shared, because a fixture exported from either file would be a second thing to keep in step.
 */
const exportCard = (over: Partial<TransferCard> = {}): TransferCard =>
  transferCard({
    name: "Sol Ring",
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
  finish: null,
});

const noop = () => {};

/**
 * The props every test in this file starts from, `render`ed with `{...props}` and whatever a
 * given test overrides. `surface` is `"deck"` — every card here is shaped like a deck row
 * through `exportCard`'s own defaults (a category name, a kind, a switch) — so a test that wants
 * a different surface passes one of its own, cards included.
 */
const props = {
  open: true,
  subject: "Removal",
  cards: [BOLT] as readonly TransferCard[],
  suggestedFileName: "Removal",
  onDismiss: noop,
  onClose: noop,
  surface: "deck" as const,
};

/**
 * Open the preview, which starts shut.
 *
 * Every assertion about the *text* of an export goes through this rather than through a `<pre>`
 * that is merely hidden — the block is unmounted while the disclosure is shut, so a test that
 * skipped the press would be asserting a line no reader can see.
 */
async function showList(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(await screen.findByRole("button", { name: /Show decklist/ }));
}

beforeEach(() => {
  exportWriteFile.mockReset();
  exportWriteFile.mockResolvedValue(undefined);
  save.mockReset();
  save.mockResolvedValue(null);
  copyText.mockReset();
  copyText.mockResolvedValue(undefined);
  // The chosen format and fields now live in `useAppStore`'s `exportPrefs` rather than in this
  // component's own `useState`, so — unlike before — they survive from one test to the next
  // unless this file resets the store itself.
  useAppStore.setState(useAppStore.getInitialState());
});

describe("ExportDialog", () => {
  it("previews the plain format by default", async () => {
    const user = userEvent.setup();
    render(
      <ExportDialog {...props} />,
    );
    await showList(user);
    expect(await screen.findByText("2 Lightning Bolt")).toBeInTheDocument();
  });

  it("opens with the decklist shut, and draws none of it until it is asked for", async () => {
    const user = userEvent.setup();
    render(
      <ExportDialog {...props} />,
    );
    // Shut is **unmounted**, not hidden: a `<pre>` still holding the text would let every
    // assertion below pass over a preview no reader can see.
    const toggle = await screen.findByRole("button", { name: /Show decklist/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(document.querySelector("pre")).toBeNull();
    expect(screen.queryByText("2 Lightning Bolt")).not.toBeInTheDocument();
    // The count is what a shut preview still owes the reader — one line here, said in the
    // singular.
    expect(toggle).toHaveTextContent("Show decklist (1 line)");

    await user.click(toggle);
    expect(await screen.findByText("2 Lightning Bolt")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Hide decklist/ })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it("counts the lines of the file rather than the cards in the pile", async () => {
    render(
      <ExportDialog {...props} />,
    );
    // Moxfield writes a `Deck` heading over the one card, so the file is two lines and the pile
    // is one — and the trailing newline every export ends with is not a third.
    await userEvent.setup().click(await screen.findByRole("radio", { name: "Moxfield" }));
    expect(screen.getByRole("button", { name: /decklist/ })).toHaveTextContent(
      "Show decklist (2 lines)",
    );
  });

  it("redraws the preview when the format changes", async () => {
    const user = userEvent.setup();
    render(
      <ExportDialog {...props} />,
    );
    await showList(user);
    await user.click(await screen.findByRole("radio", { name: "Moxfield" }));
    // Moxfield writes its section heading even for a single section — the vocabulary is fixed, so
    // `Deck` is a fact about where these cards are and not a separator a one-pile file can drop.
    // `findByText` normalizes the newline between the two, which is why this reads as one line.
    expect(await screen.findByText("Deck 2 Lightning Bolt (LEA) 161")).toBeInTheDocument();
  });

  it("offers every format format.ts writes, in that file's own order", async () => {
    render(
      <ExportDialog {...props} />,
    );
    // The row maps `EXPORT_FORMATS`, so this reads the array rather than a list drawn by hand —
    // an eighth writer reaches the reader without an edit here. Compared against the array
    // itself rather than a count, which is a number that rots the moment a writer is added.
    const labels = (await screen.findAllByRole("radio")).map((radio) => radio.textContent);
    expect(labels).toEqual(EXPORT_FORMATS.map((format) => EXPORT_FORMAT_LABEL[format]));
    expect(labels).toContain("TCGplayer");
  });

  it("says how many cards a format leaves out, and stops saying it when one does not", async () => {
    const user = userEvent.setup();
    render(
      <ExportDialog
        {...props}
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
        {...props}
        subject="Atraxa"
        cards={[
          exportCard({ name: "Sol Ring", categoryName: "Ramp" }),
          exportCard({ name: "Mox Amber", categoryName: "Cuts", categoryActive: false }),
        ]}
        suggestedFileName="Atraxa"
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
      <ExportDialog {...props} />,
    );
    await user.click(await screen.findByRole("radio", { name: "CSV" }));
    await user.click(screen.getByRole("button", { name: /Copy/ }));
    expect(copy).toHaveBeenCalledWith(
      "Quantity,Name,Set,Collector number,Category,Finish\n2,Lightning Bolt,lea,161,Main deck,\n",
    );
  });

  it("clears the Copied status when the format changes, since it would misrepresent what's on the clipboard", async () => {
    const user = userEvent.setup();
    render(
      <ExportDialog {...props} />,
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
      <ExportDialog {...props} />,
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
      <ExportDialog {...props} />,
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
      <ExportDialog {...props} />,
    );
    await user.click(screen.getByRole("button", { name: /Save as/ }));
    expect(vi.mocked(ipc.exportWriteFile)).not.toHaveBeenCalled();
  });

  it("reports a refused write rather than closing on it", async () => {
    const user = userEvent.setup();
    vi.mocked(saveMock).mockResolvedValue("D:\\decks\\Removal.txt");
    vi.mocked(ipc.exportWriteFile).mockRejectedValue("could not write: access denied");
    const onDismiss = vi.fn();
    render(<ExportDialog {...props} onDismiss={onDismiss} />);
    await user.click(screen.getByRole("button", { name: /Save as/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/access denied/);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("mounts nothing while closed", () => {
    render(<ExportDialog {...props} open={false} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("offers only the fields this format and this surface share", async () => {
    const user = userEvent.setup();
    render(<ExportDialog {...props} surface="wishlist" />);
    await user.click(screen.getByRole("radio", { name: "Archidekt" }));
    // A wishlist has no piles, so the format's bracket has nothing to put in it.
    expect(screen.queryByRole("checkbox", { name: "Category" })).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Collector number" })).toBeInTheDocument();
  });

  it("redraws the preview when a field is switched off", async () => {
    const user = userEvent.setup();
    // `exportCard()`'s own defaults are Sol Ring, LTC, 285 — the base `props.cards` is `[BOLT]`
    // (Lightning Bolt) instead, which the exact-string CSV and plain-text assertions above pin,
    // so this test names the card its own assertions are about.
    render(<ExportDialog {...props} cards={[exportCard()]} surface="deck" />);
    await user.click(screen.getByRole("radio", { name: "Moxfield" }));
    await user.click(screen.getByRole("button", { name: /Show decklist/ }));
    expect(screen.getByText(/Sol Ring \(LTC\) 285/)).toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: "Set code" }));
    expect(screen.queryByText(/\(LTC\)/)).not.toBeInTheDocument();
  });

  it("clears the Copied claim when a field moves, not only when the format does", async () => {
    // The clipboard still holds the old text; the sentence beside it would stop being true.
    const user = userEvent.setup();
    render(<ExportDialog {...props} surface="deck" />);
    await user.click(screen.getByRole("button", { name: "Copy" }));
    expect(await screen.findByText("Copied.")).toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: "Finish" }));
    expect(screen.queryByText("Copied.")).not.toBeInTheDocument();
  });
});
