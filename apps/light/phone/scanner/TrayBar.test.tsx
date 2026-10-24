import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("@grimoire/fake/core"));
vi.mock("@tauri-apps/api/event", () => import("@grimoire/fake/event"));
vi.mock("@tauri-apps/api/window", () => import("@grimoire/fake/window"));

import { NEEDS_A_FINISH_ROW, TRAY_ROWS } from "@grimoire/ui/features/scanner/fixtures";
import type { CollectionFolder, ScannerTrayRow } from "@grimoire/ui/lib/ipc";
import { renderPhone } from "../testing";
import { destinationName, TrayBar, UNREAD_FOLDER } from "./TrayBar";

const RESOLVED = TRAY_ROWS.filter((row) => row.choices.length === 0);

const folder = (
  over: Partial<CollectionFolder> & { id: number; name: string },
): CollectionFolder => ({
  rules: [],
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

function mount(
  over: Partial<Parameters<typeof TrayBar>[0]> = {},
  options: Parameters<typeof renderPhone>[1] = {},
) {
  const props = {
    rows: RESOLVED as readonly ScannerTrayRow[],
    folders: FOLDERS as readonly CollectionFolder[],
    foldersPending: false,
    folderId: null as number | null,
    condition: "NM" as const,
    onFolder: vi.fn(),
    onCommit: vi.fn(),
    committing: false,
    commitError: null as string | null,
    ...over,
  };
  renderPhone(<TrayBar {...props} />, options);
  return props;
}

describe("the tray's bar", () => {
  it("files the tray on Add, drawn short and named the whole sentence", async () => {
    const props = mount();
    const add = screen.getByRole("button", { name: "Add 5 to collection" });
    // `Add 5` is what fits beside the folder; the name is what the press does.
    expect(add).toHaveTextContent(/^Add 5$/);
    expect(add).not.toHaveAttribute("aria-disabled");
    await userEvent.click(add);
    expect(props.onCommit).toHaveBeenCalledTimes(1);
  });

  it("names both halves when some cards still need a finish, and draws the count alone", () => {
    mount({ rows: [NEEDS_A_FINISH_ROW, ...RESOLVED] });
    const add = screen.getByRole("button", { name: "Add 5 to collection · 1 needs a finish" });
    expect(add).toHaveTextContent(/^Add 5$/);
  });

  it("draws no refusal line: the reason is the greyed press's description, and nothing else", async () => {
    const props = mount({ rows: [] });
    const add = screen.getByRole("button", { name: "Add 0 to collection" });
    expect(add).toHaveAttribute("aria-disabled", "true");
    expect(add).not.toBeDisabled();
    // Read with the press — never a tooltip, which a finger cannot open…
    expect(add).toHaveAccessibleDescription("Nothing scanned yet");
    // …and not drawn under it either: the one element holding the words is visually hidden.
    const words = screen.getAllByText("Nothing scanned yet");
    expect(words).toHaveLength(1);
    expect(words[0]).toHaveClass("sr-only");
    await userEvent.click(add);
    expect(props.onCommit).not.toHaveBeenCalled();
  });

  it("says a printing has to be picked, to a screen reader, on the press", () => {
    mount({ rows: [...TRAY_ROWS] });
    // The waiting row's copy counts among the six: it has a finish, only not a printing.
    expect(screen.getByRole("button", { name: "Add 6 to collection" })).toHaveAccessibleDescription(
      "Pick a printing for every card first",
    );
  });

  it("says a tray of nothing but unknown finishes needs one", () => {
    mount({ rows: [NEEDS_A_FINISH_ROW] });
    const add = screen.getByRole("button", { name: "Add 0 to collection · 1 needs a finish" });
    expect(add).toHaveAttribute("aria-disabled", "true");
    expect(add).toHaveAccessibleDescription("Pick a finish for at least one card first");
  });

  it("says the condition Add files as under the folder, and describes the press with it", () => {
    mount({ condition: "LP" });
    const press = screen.getByRole("button", { name: "Folder: Collection" });
    expect(within(press).getByText("Lightly played")).toBeInTheDocument();
    expect(press).toHaveAccessibleDescription("Condition: Lightly played");
  });

  it("says a condition nobody chose in the reader's words", () => {
    mount({ condition: "NONE" });
    expect(screen.getByRole("button", { name: "Folder: Collection" })).toHaveAccessibleDescription(
      "Condition: Not set",
    );
  });

  it("holds Add while an archive is out, without a reason — the archive is the press saying so", async () => {
    const props = mount({ archiving: true });
    const add = screen.getByRole("button", { name: "Add 5 to collection" });
    expect(add).toHaveAttribute("aria-disabled", "true");
    expect(add).not.toHaveAttribute("aria-describedby");
    await userEvent.click(add);
    expect(props.onCommit).not.toHaveBeenCalled();
  });

  it("draws none of the tray's other acts: they are the actions sheet's", () => {
    mount();
    expect(screen.queryByRole("button", { name: "Tray actions" })).toBeNull();
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
    mount({
      commitError: "The card database is busy finishing a sync. Try that again in a moment.",
    });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The card database is busy finishing a sync.",
    );
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
    const choices = within(within(sheet).getByRole("list", { name: "Folders" })).getAllByRole(
      "button",
    );
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

  it("hands the caret back to the folder's press when its sheet is dismissed", async () => {
    mount();
    const folder = screen.getByRole("button", { name: "Folder: Collection" });
    await userEvent.click(folder);
    await screen.findByRole("dialog", { name: "Folder for scanned cards" });
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(folder).toHaveFocus();
  });

  it("picks the root as null", async () => {
    const props = mount({ folderId: BINDER.id });
    await userEvent.click(screen.getByRole("button", { name: "Folder: Trade binder" }));
    const sheet = await screen.findByRole("dialog", { name: "Folder for scanned cards" });
    await userEvent.click(within(sheet).getByRole("button", { name: "Collection" }));
    expect(props.onFolder).toHaveBeenCalledWith(null);
  });

  /** Issue #1357: a new folder, made where the tray's destination is picked. */
  it("makes a new folder at the top level from the folder sheet, and picks it", async () => {
    const create = vi.fn();
    const props = mount(
      {},
      {
        commands: (own) => ({
          collection_folder_create: (args: { parentId: number | null; name: string }) => {
            create(args);
            return (own.collection_folder_create as (a: typeof args) => unknown)(args);
          },
        }),
      },
    );
    const press = screen.getByRole("button", { name: "Folder: Collection" });
    await userEvent.click(press);
    const sheet = await screen.findByRole("dialog", { name: "Folder for scanned cards" });
    await userEvent.click(within(sheet).getByRole("button", { name: "New folder…" }));

    const form = within(sheet).getByRole("form", { name: "New folder" });
    const name = within(form).getByRole("textbox", { name: "Name" });
    expect(name).toHaveFocus();
    // Held, in place, until there is a name.
    const submit = within(form).getByRole("button", { name: "Create folder" });
    expect(submit).toHaveAttribute("aria-disabled", "true");

    await userEvent.type(name, "Sealed");
    await userEvent.click(submit);
    await waitFor(() => expect(props.onFolder).toHaveBeenCalledTimes(1));
    expect(create).toHaveBeenCalledWith({ parentId: null, name: "Sealed" });
    expect(props.onFolder).toHaveBeenCalledWith(expect.any(Number));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(press).toHaveFocus();
  });

  it("says a refused new folder in the backend's words, on the page it was asked on", async () => {
    const props = mount(
      {},
      {
        commands: () => ({
          collection_folder_create: () => {
            throw new Error("The card database is busy. Try again.");
          },
        }),
      },
    );
    await userEvent.click(screen.getByRole("button", { name: "Folder: Collection" }));
    const sheet = await screen.findByRole("dialog", { name: "Folder for scanned cards" });
    await userEvent.click(within(sheet).getByRole("button", { name: "New folder…" }));
    const form = within(sheet).getByRole("form", { name: "New folder" });
    await userEvent.type(within(form).getByRole("textbox", { name: "Name" }), "Sealed{Enter}");
    expect(await within(form).findByRole("alert")).toHaveTextContent(
      "Couldn't create the folder — The card database is busy. Try again.",
    );
    expect(props.onFolder).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Folder for scanned cards" })).toBeInTheDocument();
  });

  it("goes back from a new folder's page to the folders", async () => {
    mount();
    await userEvent.click(screen.getByRole("button", { name: "Folder: Collection" }));
    const sheet = await screen.findByRole("dialog", { name: "Folder for scanned cards" });
    await userEvent.click(within(sheet).getByRole("button", { name: "New folder…" }));
    // The way back at the head of the page is named for it.
    await userEvent.click(within(sheet).getAllByRole("button", { name: "New folder…" })[0]);
    expect(within(sheet).queryByRole("form", { name: "New folder" })).toBeNull();
    expect(within(sheet).getByRole("list", { name: "Folders" })).toBeInTheDocument();
  });
});

describe("the tray's bar, filing somewhere that is not the collection", () => {
  const destination = { title: "Scanned for their side", name: "their side" };

  it("names its press with the destination, and files on it", async () => {
    const props = mount({ destination });
    expect(screen.queryByRole("button", { name: /to collection/ })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Add 5 to their side" }));
    expect(props.onCommit).toHaveBeenCalledTimes(1);
  });

  it("still says how many cards it leaves for want of a finish, and why it cannot go", () => {
    mount({ destination, rows: [NEEDS_A_FINISH_ROW] });
    const add = screen.getByRole("button", { name: "Add 0 to their side · 1 needs a finish" });
    expect(add).toHaveAttribute("aria-disabled", "true");
    expect(add).toHaveAccessibleDescription("Pick a finish for at least one card first");
  });

  it("draws no folder and no condition, and the destination's summary in their place", () => {
    const summary = vi.fn((rows: readonly ScannerTrayRow[]) => (
      <p>Scanned so far: {rows.length}</p>
    ));
    mount({ destination: { ...destination, summary } });
    expect(screen.queryByRole("button", { name: /^Folder:/ })).toBeNull();
    expect(screen.queryByText("Near mint")).toBeNull();
    expect(screen.getByText("Scanned so far: 3")).toBeInTheDocument();
    expect(summary).toHaveBeenLastCalledWith(RESOLVED);
  });
});
