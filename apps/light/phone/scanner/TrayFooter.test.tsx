import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("../../../../packages/fake/core"));
vi.mock("@tauri-apps/api/event", () => import("../../../../packages/fake/event"));
vi.mock("@tauri-apps/api/window", () => import("../../../../packages/fake/window"));

import { NEEDS_A_FINISH_ROW, TRAY_ROWS } from "@/features/scanner/fixtures";
import type { CollectionFolder, ScannerTrayRow } from "@/lib/ipc";
import { renderPhone } from "../testing";
import { destinationName, TrayFooter, UNREAD_FOLDER } from "./TrayFooter";

const RESOLVED = TRAY_ROWS.filter((row) => row.choices.length === 0);

const folder = (over: Partial<CollectionFolder> & { id: number; name: string }): CollectionFolder => ({
  parentId: null,
  kind: "user",
  deckId: null,
  sortOrder: 0,
  locked: false,
  syncUid: `f${over.id}`,
  ...over,
});
const BINDER = folder({ id: 7, name: "Trade binder" });
const RARES = folder({ id: 8, name: "Rares", parentId: 7 });
const DECK_GROUP = folder({ id: 9, name: "Burn", kind: "deck", deckId: 4 });
const REMOVED = folder({ id: 10, name: "Recently removed", kind: "removed" });
const FOLDERS = [BINDER, RARES, DECK_GROUP, REMOVED];

function mount(over: Partial<Parameters<typeof TrayFooter>[0]> = {}) {
  const props = {
    rows: RESOLVED as readonly ScannerTrayRow[],
    folders: FOLDERS as readonly CollectionFolder[],
    foldersPending: false,
    folderId: null as number | null,
    onFolder: vi.fn(),
    onCommit: vi.fn(),
    committing: false,
    commitError: null as string | null,
    onCreateDeck: vi.fn(),
    onClearAll: vi.fn(),
    ...over,
  };
  renderPhone(<TrayFooter {...props} />);
  return props;
}

describe("the tray's footer", () => {
  it("files the tray on Add, and says how many copies it will take", async () => {
    const props = mount();
    const add = screen.getByRole("button", { name: "Add 5 to collection" });
    expect(add).not.toHaveAttribute("aria-disabled");
    await userEvent.click(add);
    expect(props.onCommit).toHaveBeenCalledTimes(1);
  });

  it("says both halves when some cards still need a finish", () => {
    mount({ rows: [NEEDS_A_FINISH_ROW, ...RESOLVED] });
    expect(
      screen.getByRole("button", { name: "Add 5 to collection · 1 needs a finish" }),
    ).toBeInTheDocument();
  });

  it("stays drawn and says why, in words on the page, when there is nothing to add", async () => {
    const props = mount({ rows: [] });
    const add = screen.getByRole("button", { name: "Add 0 to collection" });
    expect(add).toHaveAttribute("aria-disabled", "true");
    expect(add).not.toBeDisabled();
    // On the page, not in a tooltip: a finger has no hover. And tied to the press, so it is
    // read with it rather than only by a reader who goes looking under it.
    expect(screen.getByText("Nothing scanned yet")).toBeVisible();
    expect(add).toHaveAccessibleDescription("Nothing scanned yet");
    await userEvent.click(add);
    expect(props.onCommit).not.toHaveBeenCalled();
  });

  it("says a printing has to be picked, and that a finish has to be", () => {
    mount({ rows: [...TRAY_ROWS] });
    expect(screen.getByText("Pick a printing for every card first")).toBeInTheDocument();
  });

  it("says a tray of nothing but unknown finishes needs one", () => {
    mount({ rows: [NEEDS_A_FINISH_ROW] });
    expect(screen.getByText("Pick a finish for at least one card first")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Add 0 to collection · 1 needs a finish" }),
    ).toHaveAttribute("aria-disabled", "true");
  });

  it("describes a press it can make by nothing", () => {
    mount();
    expect(screen.getByRole("button", { name: "Add 5 to collection" })).not.toHaveAttribute(
      "aria-describedby",
    );
  });

  it("holds its press and its reason while a commit is in flight", async () => {
    const props = mount({ committing: true });
    const add = screen.getByRole("button", { name: "Add 5 to collection" });
    expect(add).toHaveAttribute("aria-busy", "true");
    expect(add).toHaveAttribute("aria-disabled", "true");
    expect(add).not.toHaveAttribute("aria-describedby");
    await userEvent.click(add);
    expect(props.onCommit).not.toHaveBeenCalled();
  });

  it("puts a refused commit's own sentence above the press", () => {
    mount({ commitError: "The card database is busy finishing a sync. Try that again in a moment." });
    expect(screen.getByRole("alert")).toHaveTextContent("The card database is busy finishing a sync.");
  });

  it("names the destination, and the root by the collection's own word", () => {
    expect(destinationName(FOLDERS, null)).toBe("Collection");
    expect(destinationName(FOLDERS, BINDER.id)).toBe("Trade binder");
    // A folder the list does not hold has no name here — and is never called the Collection,
    // which is a place its cards may not be going.
    expect(destinationName(FOLDERS, 404)).toBeNull();
    expect(destinationName([], BINDER.id)).toBeNull();
  });

  it("does not print a destination it does not know, when the folder list would not load", () => {
    // The list errored: no folders, nothing pending, and a stored id the commit will send as it is.
    mount({ folderId: RARES.id, folders: [], foldersPending: false });
    expect(screen.getByRole("button", { name: `Folder: ${UNREAD_FOLDER}` })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Folder: Collection" })).toBeNull();
  });

  it("draws the chosen folder on its press, and nothing false while the list is still loading", () => {
    mount({ folderId: RARES.id });
    expect(screen.getByRole("button", { name: "Folder: Rares" })).toBeInTheDocument();
  });

  it("does not call a named folder the Collection before the list has answered", () => {
    mount({ folderId: RARES.id, folders: [], foldersPending: true });
    expect(screen.getByRole("button", { name: "Folder: …" })).toBeInTheDocument();
  });

  it("offers the root and the reader's own folders, nested, and nothing the app owns", async () => {
    const props = mount({ folderId: BINDER.id });
    await userEvent.click(screen.getByRole("button", { name: "Folder: Trade binder" }));
    const sheet = await screen.findByRole("dialog", { name: "Folder for scanned cards" });
    const choices = within(within(sheet).getByRole("list", { name: "Folders" })).getAllByRole("button");
    // A deck's group and Recently removed are not places the tray could ever land.
    expect(choices.map((c) => c.textContent)).toEqual(["Collection", "Trade binder", "Rares"]);
    expect(within(sheet).getByRole("button", { name: "Trade binder" })).toHaveAttribute(
      "aria-current",
      "true",
    );

    await userEvent.click(within(sheet).getByRole("button", { name: "Rares" }));
    expect(props.onFolder).toHaveBeenCalledWith(RARES.id);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // The caret is back on the press that opened the sheet, not on `body`.
    expect(screen.getByRole("button", { name: "Folder: Trade binder" })).toHaveFocus();
  });

  it("hands the caret back to the press that opened a sheet when it is dismissed", async () => {
    mount();
    const folder = screen.getByRole("button", { name: "Folder: Collection" });
    await userEvent.click(folder);
    await screen.findByRole("dialog", { name: "Folder for scanned cards" });
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(folder).toHaveFocus();

    const more = screen.getByRole("button", { name: "Tray actions" });
    await userEvent.click(more);
    await userEvent.click(
      within(await screen.findByRole("dialog", { name: "Scanned cards" })).getByRole("button", {
        name: "Close tray actions",
      }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(more).toHaveFocus();
  });

  it("picks the root as null", async () => {
    const props = mount({ folderId: BINDER.id });
    await userEvent.click(screen.getByRole("button", { name: "Folder: Trade binder" }));
    const sheet = await screen.findByRole("dialog", { name: "Folder for scanned cards" });
    await userEvent.click(within(sheet).getByRole("button", { name: "Collection" }));
    expect(props.onFolder).toHaveBeenCalledWith(null);
  });

  it("asks the page to make a deck and to clear, handing it the press the caret returns to", async () => {
    const props = mount();
    const more = screen.getByRole("button", { name: "Tray actions" });
    await userEvent.click(more);
    let sheet = await screen.findByRole("dialog", { name: "Scanned cards" });
    await userEvent.click(within(sheet).getByRole("button", { name: "Create deck…" }));
    expect(props.onCreateDeck).toHaveBeenCalledWith(more);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    await userEvent.click(more);
    sheet = await screen.findByRole("dialog", { name: "Scanned cards" });
    await userEvent.click(within(sheet).getByRole("button", { name: "Clear all…" }));
    expect(props.onClearAll).toHaveBeenCalledWith(more);
  });

  it("says why a deck cannot be made yet, in the row's own name", async () => {
    const props = mount({ rows: [NEEDS_A_FINISH_ROW, ...RESOLVED] });
    await userEvent.click(screen.getByRole("button", { name: "Tray actions" }));
    const sheet = await screen.findByRole("dialog", { name: "Scanned cards" });
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

  it("refuses both of the tray's other acts on an empty tray, each in words", async () => {
    const props = mount({ rows: [] });
    await userEvent.click(screen.getByRole("button", { name: "Tray actions" }));
    const sheet = await screen.findByRole("dialog", { name: "Scanned cards" });
    const clear = within(sheet).getByRole("button", { name: /^Clear all…\s*Nothing scanned yet$/ });
    await userEvent.click(clear);
    expect(props.onClearAll).not.toHaveBeenCalled();
    expect(
      within(sheet).getByRole("button", { name: /^Create deck…\s*Nothing scanned yet$/ }),
    ).toHaveAttribute("aria-disabled", "true");
  });
});
