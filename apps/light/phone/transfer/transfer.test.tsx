import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("../../../../packages/fake/core"));
vi.mock("@tauri-apps/api/event", () => import("../../../../packages/fake/event"));
vi.mock("@tauri-apps/api/window", () => import("../../../../packages/fake/window"));

/**
 * What the save dialog answered, for the one test that plays the host whose save is a dialog —
 * `null` everywhere else, which is the real `saveText` and so the browser's download.
 */
const dialogAnswer = vi.hoisted(() => ({ next: null as "saved" | "cancelled" | null }));
vi.mock("@/lib/core/files", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/core/files")>();
  return {
    ...real,
    saveText: (fileName: string, text: string) =>
      dialogAnswer.next === null
        ? real.saveText(fileName, text)
        : Promise.resolve(dialogAnswer.next),
  };
});

/**
 * What the last Copy put on the clipboard. The sheet copies through `@/lib/clipboard`, whose
 * host under this suite is the desktop's plugin — which the fake accepts and does not keep — so
 * the seam is stood in for, as the desktop dialog's suite stands in for it.
 */
const copied = vi.hoisted(() => ({ text: null as string | null }));
vi.mock("@/lib/clipboard", () => ({
  copyText: (text: string) => {
    copied.text = text;
    return Promise.resolve();
  },
}));

import { exportFileName } from "@/features/decks/deckExport";
import { formatExport, isActivePile } from "@/features/transfer/export/format";
import { defaultFields } from "@/features/transfer/fields";
import type { ExportFormat } from "@/features/transfer/formats";
import { fromCollectionRow, fromDeckCard } from "@/features/transfer/TransferCard";
import { resetBulkUndo } from "@/lib/bulkUndo";
import { ipc, type CollectionRow, type DeckCard } from "@/lib/ipc";
import { DEFAULT_MARKETPLACE } from "@/lib/marketplace";
import { PhoneFace } from "../PhoneApp";
import { installLayout, renderPhone } from "../testing";
import { CollectionTransfer } from "./CollectionTransfer";
import { usePhoneTransferPrefs } from "./prefs";

beforeAll(installLayout);
afterEach(() => {
  usePhoneTransferPrefs.setState(usePhoneTransferPrefs.getInitialState());
  resetBulkUndo();
});

/** Long enough for a fake round trip and the reads that follow it. */
const SETTLE = { timeout: 3000 };

/** The starter seed's Modern deck: four `2X2` Lightning Bolts in `Main deck`, one list. */
const MODERN = 1;

/** The deck as the backend holds it now — every write is asserted against the fake. */
async function deckRows(deckId = MODERN): Promise<DeckCard[]> {
  return (await ipc.deckGet(deckId, "live", DEFAULT_MARKETPLACE))?.cards ?? [];
}

/** The whole collection as the backend holds it, in the order the export's sweep reads it. */
async function collectionRows(): Promise<CollectionRow[]> {
  return (await ipc.collectionList({ marketplace: DEFAULT_MARKETPLACE, limit: 500, offset: 0 }))
    .items;
}

const held = (rows: readonly { name: string | null; quantity: number }[], name: string) =>
  rows.filter((row) => row.name === name).reduce((sum, row) => sum + row.quantity, 0);

/**
 * What the desktop's writer makes of the same cards with the same choice — `formatExport`, the
 * function the golden suite pins, never a string written out here. **Switched-off piles are left
 * out**, which is the desktop dialog's default (issue #390) and the one filter the starter deck
 * meets: its maybeboard holds two Ancient Tombs, and the sheet says so.
 */
const deckText = async (format: ExportFormat) =>
  formatExport(
    (await deckRows()).map(fromDeckCard).filter(isActivePile),
    format,
    defaultFields(format, "deck"),
  );

/** Object URLs, which jsdom has none of, and the anchor press that hands one to the browser. */
function catchDownloads(): { name: string; blob: Blob }[] {
  const caught: { name: string; blob: Blob }[] = [];
  const blobs = new Map<string, Blob>();
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: (blob: Blob) => {
      const url = `blob:${blobs.size}`;
      blobs.set(url, blob);
      return url;
    },
  });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: () => undefined });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    const blob = blobs.get(this.getAttribute("href") ?? "");
    if (blob !== undefined) caught.push({ name: this.download, blob });
  });
  return caught;
}

describe("a deck's import, on the phone", () => {
  it("pastes a decklist, previews it, and imports it into the deck on screen", async () => {
    const user = userEvent.setup();
    renderPhone(<PhoneFace />, { path: `/decks/${MODERN}` });
    const before = held(await deckRows(), "Counterspell");

    await user.click(
      await screen.findByRole("button", { name: "Import cards into this deck" }, SETTLE),
    );
    const sheet = await screen.findByRole("dialog", { name: /Import a decklist/ }, SETTLE);
    await user.type(
      within(sheet).getByRole("textbox", { name: "Paste a decklist" }),
      "2 Counterspell",
    );
    expect(within(sheet).getByText("1 line · 2 cards")).toBeInTheDocument();
    await user.click(within(sheet).getByRole("button", { name: "Preview" }));

    // The second step is the desktop's own deck preview: Merge, the piles, Import.
    await user.click(await within(sheet).findByRole("button", { name: "Import" }, SETTLE));

    await waitFor(
      async () => expect(held(await deckRows(), "Counterspell")).toBe(before + 2),
      SETTLE,
    );
    expect(held(await deckRows(), "Lightning Bolt")).toBe(4);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull(), SETTLE);
    // The preview's own sentence, in the page's receipt line.
    expect(await screen.findByText("2 cards imported.", undefined, SETTLE)).toBeInTheDocument();
  });

  it("reads a file picked through the input into the box, and says when it guessed the encoding", async () => {
    const user = userEvent.setup();
    renderPhone(<PhoneFace />, { path: `/decks/${MODERN}` });
    await user.click(
      await screen.findByRole("button", { name: "Import cards into this deck" }, SETTLE),
    );
    const sheet = await screen.findByRole("dialog", { name: /Import a decklist/ }, SETTLE);
    const box = within(sheet).getByRole("textbox", { name: "Paste a decklist" });

    await user.upload(
      within(sheet).getByLabelText("Decklist file"),
      new File(["1 Sol Ring\n3 Counterspell\n"], "list.txt", { type: "text/plain" }),
    );
    await waitFor(() => expect(box).toHaveValue("1 Sol Ring\n3 Counterspell\n"), SETTLE);
    expect(within(sheet).getByText("2 lines · 4 cards")).toBeInTheDocument();
    expect(within(sheet).queryByText(/read as Windows-1252/)).toBeNull();

    // A Western European spreadsheet's bytes: `Æ` as 0xC6, which is not UTF-8.
    const legacy = new Uint8Array([
      0x31, 0x20, 0xc6, 0x74, 0x68, 0x65, 0x72, 0x20, 0x56, 0x69, 0x61, 0x6c,
    ]);
    await user.upload(
      within(sheet).getByLabelText("Decklist file"),
      new File([legacy], "legacy.txt", { type: "text/plain" }),
    );
    await waitFor(() => expect(box).toHaveValue("1 Æther Vial"), SETTLE);
    expect(within(sheet).getByText(/read as Windows-1252/)).toBeInTheDocument();
    // The reader's own edit makes it their text, and the note about the file goes.
    await user.type(box, "!");
    expect(within(sheet).queryByText(/read as Windows-1252/)).toBeNull();
  });
});

describe("a deck's export, on the phone", () => {
  afterEach(() => vi.restoreAllMocks());

  it("copies the text the desktop writer makes, and follows a change of format", async () => {
    const user = userEvent.setup();
    renderPhone(<PhoneFace />, { path: `/decks/${MODERN}` });
    await user.click(await screen.findByRole("button", { name: "Export this deck" }, SETTLE));
    const sheet = await screen.findByRole("dialog", { name: /^Export "/ }, SETTLE);

    // Plain text is what a deck opens on — the desktop's own default.
    expect(within(sheet).getByRole("radio", { name: "Plain text" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(
      within(sheet).getByText("2 cards in inactive categories are left out."),
    ).toBeInTheDocument();
    await user.click(within(sheet).getByRole("button", { name: "Copy" }));
    expect(await within(sheet).findByText("Copied.", undefined, SETTLE)).toBeInTheDocument();
    expect(copied.text).toBe(await deckText("plain"));

    await user.click(within(sheet).getByRole("radio", { name: "Moxfield" }));
    // A change to the text takes the claim about the clipboard down.
    expect(within(sheet).queryByText("Copied.")).toBeNull();
    await user.click(within(sheet).getByRole("button", { name: "Copy" }));
    await within(sheet).findByText("Copied.", undefined, SETTLE);
    expect(copied.text).toBe(await deckText("moxfield"));
    // The choice is remembered per surface, for the session.
    expect(usePhoneTransferPrefs.getState().exportPrefs.deck.format).toBe("moxfield");
    expect(usePhoneTransferPrefs.getState().exportPrefs.collection.format).toBe("csv");
  });

  it("saves the same text as a file named after the deck — a download in a browser", async () => {
    const caught = catchDownloads();
    const user = userEvent.setup();
    renderPhone(<PhoneFace />, { path: `/decks/${MODERN}` });
    await user.click(await screen.findByRole("button", { name: "Export this deck" }, SETTLE));
    const sheet = await screen.findByRole("dialog", { name: /^Export "/ }, SETTLE);

    await user.click(within(sheet).getByRole("button", { name: "Save file" }));

    const deck = await ipc.deckGet(MODERN, "live", DEFAULT_MARKETPLACE);
    const name = `${exportFileName(deck?.deck.name ?? "", "")}.txt`;
    expect(caught.map((c) => c.name)).toEqual([name]);
    expect(await caught[0]?.blob.text()).toBe(await deckText("plain"));
    expect(within(sheet).getByRole("status")).toHaveTextContent(`Downloading ${name}.`);
  });

  // The first phone run, 2026-10-04: the button read `Download` over the system's save dialog.
  // One label for both hosts; the line under it says what the host actually did.
  it("says Saved when the save dialog wrote a file, and nothing when it was cancelled", async () => {
    const user = userEvent.setup();
    renderPhone(<PhoneFace />, { path: `/decks/${MODERN}` });
    await user.click(await screen.findByRole("button", { name: "Export this deck" }, SETTLE));
    const sheet = await screen.findByRole("dialog", { name: /^Export "/ }, SETTLE);
    const deck = await ipc.deckGet(MODERN, "live", DEFAULT_MARKETPLACE);
    const name = `${exportFileName(deck?.deck.name ?? "", "")}.txt`;

    try {
      dialogAnswer.next = "saved";
      await user.click(within(sheet).getByRole("button", { name: "Save file" }));
      await waitFor(() =>
        expect(within(sheet).getByRole("status")).toHaveTextContent(`Saved ${name}.`),
      );

      dialogAnswer.next = "cancelled";
      await user.click(within(sheet).getByRole("button", { name: "Save file" }));
      // A dialog dismissed is nothing to report — and the last save's claim does not stand over it.
      await waitFor(() => expect(within(sheet).getByRole("status")).toBeEmptyDOMElement());
      expect(within(sheet).queryByRole("alert")).toBeNull();
    } finally {
      dialogAnswer.next = null;
    }
  });
});

describe("CollectionTransfer", () => {
  afterEach(() => vi.restoreAllMocks());

  it("imports a pasted list into the collection, and offers the desktop's undo for it", async () => {
    const user = userEvent.setup();
    renderPhone(<CollectionTransfer />);
    const before = held(await collectionRows(), "Counterspell");

    await user.click(screen.getByRole("button", { name: "Import cards into your collection" }));
    const sheet = await screen.findByRole("dialog", { name: /Import a decklist/ }, SETTLE);
    await user.type(
      within(sheet).getByRole("textbox", { name: "Paste a decklist" }),
      "3 Counterspell",
    );
    await user.click(within(sheet).getByRole("button", { name: "Preview" }));
    // The collection's own step: Add these copies, the condition and finish fallbacks, Import.
    expect(
      await within(sheet).findByRole("radio", { name: /Add these copies/ }, SETTLE),
    ).toBeChecked();
    await user.click(within(sheet).getByRole("button", { name: "Import" }));

    await waitFor(
      async () => expect(held(await collectionRows(), "Counterspell")).toBe(before + 3),
      SETTLE,
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull(), SETTLE);
    const notice = screen.getByRole("status", { name: "Undo" });
    expect(
      await within(notice).findByText("Imported 3 cards into your collection.", undefined, SETTLE),
    ).toBeInTheDocument();

    await user.click(within(notice).getByRole("button", { name: /^Undo/ }));
    await waitFor(
      async () => expect(held(await collectionRows(), "Counterspell")).toBe(before),
      SETTLE,
    );
  });

  it("exports the whole collection as the desktop's CSV, once the sweep has answered", async () => {
    const user = userEvent.setup();
    const caught = catchDownloads();
    renderPhone(<CollectionTransfer />);
    const rows = await collectionRows();
    const expected = formatExport(
      rows.map(fromCollectionRow),
      "csv",
      defaultFields("csv", "collection"),
    );

    await user.click(screen.getByRole("button", { name: "Export your collection" }));
    const sheet = await screen.findByRole("dialog", { name: 'Export "your collection"' }, SETTLE);
    // The sweep's own count line, drawn once it has answered — the whole collection, so no
    // "matching your filters" and no box to widen what is already everything.
    expect(
      await within(sheet).findByText(`${rows.length} cards in your collection`, undefined, SETTLE),
    ).toBeInTheDocument();
    expect(within(sheet).queryByRole("checkbox", { name: /Export everything/ })).toBeNull();
    expect(within(sheet).getByRole("radio", { name: "CSV" })).toHaveAttribute(
      "aria-checked",
      "true",
    );

    await user.click(within(sheet).getByRole("button", { name: "Copy" }));
    await within(sheet).findByText("Copied.", undefined, SETTLE);
    expect(copied.text).toBe(expected);

    await user.click(within(sheet).getByRole("button", { name: "Save file" }));
    expect(caught.map((c) => c.name)).toEqual(["collection.csv"]);
    expect(await caught[0]?.blob.text()).toBe(expected);
  });

  it("sweeps what the host's filters cover, and offers to widen it", async () => {
    const user = userEvent.setup();
    const filters = { marketplace: DEFAULT_MARKETPLACE, text: "Lightning Bolt" };
    renderPhone(<CollectionTransfer filters={filters} />);
    const rows = (await ipc.collectionList({ ...filters, limit: 500, offset: 0 })).items;
    expect(rows.length).toBeGreaterThan(0);

    await user.click(screen.getByRole("button", { name: "Export your collection" }));
    const sheet = await screen.findByRole("dialog", { name: 'Export "your collection"' }, SETTLE);
    expect(
      await within(sheet).findByText(
        `${rows.length} ${rows.length === 1 ? "card" : "cards"} matching your filters`,
        undefined,
        SETTLE,
      ),
    ).toBeInTheDocument();
    expect(
      within(sheet).getByRole("checkbox", { name: "Export everything, ignoring the filters" }),
    ).not.toBeChecked();

    await user.click(within(sheet).getByRole("button", { name: "Copy" }));
    await within(sheet).findByText("Copied.", undefined, SETTLE);
    expect(copied.text).toBe(
      formatExport(rows.map(fromCollectionRow), "csv", defaultFields("csv", "collection")),
    );
  });
});
