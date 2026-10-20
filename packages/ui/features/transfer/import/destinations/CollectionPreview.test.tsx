/**
 * The collection destination's preview, mounted directly — what is under test is what the step
 * **says** about a file before the reader commits, not the dialog's step machine.
 *
 * Facts that live here and nowhere else: a `Purchase price` cell the file filled and the parser
 * refused is **listed**, because the copy lands with no price and this list is the only place the
 * reader learns the cell was not empty; a `set` file's headline is the **dry run's** count and
 * never "N cards will be added" (issue #555); and a landed import leaves an undo offer behind for
 * the collection page to draw. `planCollectionImport`'s own test proves the plan carries each
 * line; this proves the line reaches the screen.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetBulkUndo, useBulkUndo } from "@/lib/bulkUndo";
import type { ImportCommitOutcome, ImportResolveRow } from "@/lib/ipc";
import { parseDecklist } from "../parse";

const collectionImportPreview = vi.hoisted(() => vi.fn());
const collectionImportCommit = vi.hoisted(() => vi.fn());
const collectionFolderList = vi.hoisted(() => vi.fn());
const collectionFolderCreate = vi.hoisted(() => vi.fn());
const deckCreate = vi.hoisted(() => vi.fn());
const deckImportCommit = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ipc")>();
  return {
    ...actual,
    ipc: {
      ...actual.ipc,
      collectionImportPreview,
      collectionImportCommit,
      collectionFolderList,
      collectionFolderCreate,
      deckCreate,
      deckImportCommit,
    },
  };
});

import { pickOption } from "@/test-dropdown";
import type { CollectionFolder } from "@/lib/ipc";
import { CollectionPreview } from "./CollectionPreview";

/**
 * A resolved row, with everything this preview does not read left out. **The card id is the
 * name's**, so two lines naming one card resolve to one printing and fold — which a per-index id
 * would never let happen — and every printing is English, which is what the corpus holds for a
 * line whose file named another language.
 */
const hit = (index: number, name: string): ImportResolveRow =>
  ({
    index,
    hintMissed: false,
    matched: {
      cardId: `c-${name}`,
      oracleId: `o-${name}`,
      name,
      setCode: "ltc",
      collectorNumber: "1",
      lang: "en",
    },
  }) as unknown as ImportResolveRow;

const outcome = (over: Partial<ImportCommitOutcome> = {}): ImportCommitOutcome => ({
  added: 0,
  updated: 0,
  removed: 0,
  copies: 0,
  leftInFolders: 0,
  undoId: null,
  ...over,
});

/**
 * Mount the step. `folders` is the folder list **already answered**, which is how the collection
 * page hands it over — its own wall read the same cache entry long before a preview mounted — and
 * `folderId` is the one the entry point named.
 */
function mount(
  csv: string,
  { folders = [], folderId }: { folders?: CollectionFolder[]; folderId?: number | null } = {},
) {
  const list = parseDecklist(csv);
  const onDone = vi.fn();
  const report = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["collection", "folders"], folders);
  // …and answers the same on the refetch a mount makes of a stale entry.
  collectionFolderList.mockResolvedValue(folders);
  render(
    <QueryClientProvider client={client}>
      <CollectionPreview
        list={list}
        resolved={list.lines.map((line, i) => hit(i, line.name))}
        tags={[]}
        onDone={onDone}
        report={report}
        onBack={vi.fn()}
        folderId={folderId}
      />
    </QueryClientProvider>,
  );
  return { onDone, report };
}

const folder = (over: Partial<CollectionFolder> & Pick<CollectionFolder, "id" | "name">) =>
  ({
    parentId: null,
    kind: "user",
    deckId: null,
    sortOrder: 0,
    locked: false,
    ...over,
  }) as CollectionFolder;
const BINDER = folder({ id: 1, name: "Trade binder" });
const FOILS = folder({ id: 2, name: "Foils", parentId: BINDER.id });
const SEALED = folder({ id: 3, name: "Sealed", sortOrder: 1 });
const DECK_GROUP = folder({ id: 4, name: "Burn", kind: "deck", deckId: 9 });
const FOLDERS = [BINDER, FOILS, SEALED, DECK_GROUP];

/** The radio's name is its label alone — `ModeRadios` makes the hint its description. */
const setRadio = () => screen.getByRole("radio", { name: "Set these quantities" });

const CAPTION = "1 line had an unreadable purchase price, and will be added without one";

beforeEach(() => {
  collectionImportPreview.mockReset().mockResolvedValue(outcome());
  collectionImportCommit.mockReset().mockResolvedValue(outcome({ added: 1 }));
  collectionFolderList.mockReset().mockResolvedValue([]);
  collectionFolderCreate.mockReset();
  resetBulkUndo();
});

describe("CollectionPreview", () => {
  /** An older build's `1.125` — refused as ambiguous — is named with its line and its words. */
  it("lists a purchase price it could not read, by line", () => {
    mount("Quantity,Name,Purchase price\n1,Sol Ring,4.25\n1,Lightning Bolt,1.125\n");

    expect(screen.getByText(CAPTION)).toBeInTheDocument();
    expect(screen.getByText(`line 3 · Lightning Bolt — "1.125"`)).toBeInTheDocument();
    expect(screen.getByText(/2 cards will be added/)).toBeInTheDocument();
  });

  /** The control: every cell reads, so there is nothing to list — the caption is the list's. */
  it("says nothing when every price reads", () => {
    mount("Quantity,Name,Purchase price\n1,Sol Ring,4.25\n1,Lightning Bolt,1.1250\n");

    expect(screen.queryByText(CAPTION)).toBeNull();
    expect(screen.queryByText(/could not read/)).toBeNull();
  });

  /** `add` needs no count — its sentence is the file's own total — so the dry run is never
   *  asked, which is also what keeps every other suite mounting this preview free of a mock. */
  it("asks for no dry run under add", () => {
    mount("1 Sol Ring\n");

    expect(screen.getByText("1 card will be added to your collection.")).toBeInTheDocument();
    expect(collectionImportPreview).not.toHaveBeenCalled();
  });
});

/**
 * **Issue #555: "N cards will be added" over a `set` was wrong about what the button does.** A
 * `set` lowers some quantities and deletes others, and before the backend counted filed copies it
 * doubled them — so the headline is the backend's own count of the same write, run dry.
 */
describe("CollectionPreview under set", () => {
  it("draws the dry run's count, not the file's total", async () => {
    const user = userEvent.setup();
    collectionImportPreview.mockResolvedValue(
      outcome({ added: 5, updated: 20, removed: 2, copies: 12 }),
    );
    mount("Quantity,Name\n4,Sol Ring\n2,Lightning Bolt\n");

    await user.click(setRadio());

    expect(
      await screen.findByText(
        "Updates quantities for 2 cards: 5 new, 20 changed, 2 removed — 12 more copies than now.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/will be added/)).toBeNull();
    expect(collectionImportPreview).toHaveBeenCalledWith(
      [
        expect.objectContaining({ cardId: "c-Sol Ring", quantity: 4 }),
        expect.objectContaining({ cardId: "c-Lightning Bolt", quantity: 2 }),
      ],
      "set",
      // Not sorted: the root, which is what a step handed no folder opens on.
      null,
    );
  });

  /** A lower number is `fewer`, never `-3 more`; the copies a folder keeps are said beside it. */
  it("says fewer copies, and what folders keep", async () => {
    const user = userEvent.setup();
    collectionImportPreview.mockResolvedValue(
      outcome({ updated: 1, copies: -3, leftInFolders: 7 }),
    );
    mount("1 Sol Ring\n");

    await user.click(setRadio());

    expect(
      await screen.findByText(
        "Updates quantities for 1 card: 1 changed — 3 fewer copies than now.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText("7 copies in folders exceed the file's count and will stay."),
    ).toBeInTheDocument();
  });

  it("says in words when every number already matches", async () => {
    const user = userEvent.setup();
    mount("1 Sol Ring\n");

    await user.click(setRadio());

    expect(
      await screen.findByText(
        "Updates quantities for 1 card: all quantities already match. Nothing to change.",
      ),
    ).toBeInTheDocument();
    // Nothing is filed beyond the file's number, so there is nothing to say about folders.
    expect(screen.queryByText(/exceeds? the file's count/)).toBeNull();
  });

  it("draws a neutral sentence while the dry run is counting", async () => {
    const user = userEvent.setup();
    collectionImportPreview.mockReturnValue(new Promise(() => {}));
    mount("1 Sol Ring\n");

    await user.click(setRadio());

    expect(screen.getByText("Previewing changes…")).toBeInTheDocument();
  });

  /** A refused count is a courtesy failing, not the import failing: the reader still presses
   *  Import, and the write carries its own refusal if it has one. */
  it("says a refused count and still lets the reader import", async () => {
    const user = userEvent.setup();
    collectionImportPreview.mockRejectedValue("The card database is busy finishing a sync.");
    const { onDone } = mount("1 Sol Ring\n");

    await user.click(setRadio());

    expect(
      await screen.findByText(
        "Couldn't preview changes — The card database is busy finishing a sync.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Updates quantities for 1 card.")).toBeInTheDocument();

    const importButton = screen.getByRole("button", { name: "Import" });
    expect(importButton).toBeEnabled();
    await user.click(importButton);
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(collectionImportCommit).toHaveBeenCalledWith(expect.any(Array), "set", null);
  });

  /** On the radio itself, as its description — the sentence a reader hears after the name. */
  it("says the file's number is the total, folders included", () => {
    mount("1 Sol Ring\n");

    expect(setRadio()).toHaveAccessibleDescription(
      "Replaces your quantities with the file's, including copies in folders.",
    );
  });
});

describe("CollectionPreview's own warnings", () => {
  it("lists a language the corpus had no printing in, and one it could not read", () => {
    mount("Quantity,Name,Language\n1,Lightning Bolt,Japanese\n1,Sol Ring,Klingon\n");

    expect(
      screen.getByText(
        "1 line asked for a language with no printing, and will be added in an available language",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText("line 2 · Lightning Bolt — the file says Japanese; added as English"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("1 line had an unknown language and was matched without it"),
    ).toBeInTheDocument();
    expect(screen.getByText(`line 3 · Sol Ring — "Klingon"`)).toBeInTheDocument();
  });

  it("lists every line it merged into an earlier one", () => {
    mount("Quantity,Name\n1,Lightning Bolt\n1,Sol Ring\n2,Lightning Bolt\n");

    expect(
      screen.getByText("1 line duplicated an earlier line and was merged into it"),
    ).toBeInTheDocument();
    expect(screen.getByText("line 4 → line 2 · Lightning Bolt")).toBeInTheDocument();
    // The merge is a count the reader can check against the file: three lines, four copies.
    expect(screen.getByText("4 cards will be added to your collection.")).toBeInTheDocument();
  });

  it("lists a merged price in another currency, and a tradelist that is not a whole number", () => {
    mount(
      "Quantity,Name,Purchase price,Purchase currency,Tradelist quantity\n" +
        "1,Lightning Bolt,4,USD,1\n1,Lightning Bolt,3,EUR,\n1,Sol Ring,,,2.5\n",
    );

    expect(
      screen.getByText(
        "1 merged line had a price in a different currency, and that price was dropped",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(`line 3 → line 2 · Lightning Bolt — "3" in EUR, kept in USD`),
    ).toBeInTheDocument();
    expect(
      screen.getByText("1 line had an invalid tradelist quantity, and will be added without one"),
    ).toBeInTheDocument();
    expect(screen.getByText(`line 4 · Sol Ring — "2.5"`)).toBeInTheDocument();
  });
});

/**
 * **A landed import can be taken back, and this preview is where the ticket is handed over** —
 * `offerUndo` publishes it and the collection page draws it. The label is already pluralised and
 * names the act, because `add` and `set` are two different things to undo.
 */
describe("CollectionPreview's undo offer", () => {
  it("offers to undo an add, in words that say what it imported", async () => {
    const user = userEvent.setup();
    collectionImportCommit.mockResolvedValue(outcome({ added: 2, copies: 3, undoId: 41 }));
    const { onDone } = mount("Quantity,Name\n2,Sol Ring\n1,Lightning Bolt\n");

    await user.click(screen.getByRole("button", { name: "Import" }));

    await waitFor(() => expect(onDone).toHaveBeenCalledWith("2 added, 0 updated."));
    expect(useBulkUndo.getState().offers.collection).toEqual({
      id: 41,
      scope: "collection",
      label: "Imported 3 cards into your collection.",
    });
  });

  it("offers to undo a set, and says a set removed what it removed", async () => {
    const user = userEvent.setup();
    collectionImportCommit.mockResolvedValue(
      outcome({ updated: 1, removed: 1, copies: -2, undoId: 42 }),
    );
    const { onDone } = mount("Quantity,Name\n2,Sol Ring\n1,Lightning Bolt\n");

    await user.click(setRadio());
    await user.click(screen.getByRole("button", { name: "Import" }));

    await waitFor(() => expect(onDone).toHaveBeenCalledWith("0 added, 1 updated, 1 removed."));
    expect(useBulkUndo.getState().offers.collection).toEqual({
      id: 42,
      scope: "collection",
      label: "Set quantities from a file of 2 cards.",
    });
  });

  /** `null` is what an outcome answers when nothing changed; there is nothing to take back. */
  it("offers nothing when the write changed nothing", async () => {
    const user = userEvent.setup();
    const { onDone } = mount("1 Sol Ring\n");

    await user.click(screen.getByRole("button", { name: "Import" }));

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(useBulkUndo.getState().offers.collection).toBeNull();
  });
});

/**
 * **Which folder the file lands in** (issue #872). The step opens on the folder its entry point
 * named — the drawer the reader stands in, or the one whose menu they pressed — and on Not sorted
 * otherwise; it offers every drawer the reader made and a new one; and the press sends that
 * folder to `collection_import_commit`, which files the whole file into it.
 */
describe("CollectionPreview's Import into", () => {
  const trigger = () => screen.getByRole("button", { name: "Import into" });

  it("opens on Not sorted and files at the root when no folder was named", async () => {
    const user = userEvent.setup();
    mount("1 Sol Ring\n", { folders: FOLDERS });

    expect(trigger()).toHaveTextContent("Not sorted");
    expect(screen.getByText("1 card will be added to your collection.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Import" }));

    await waitFor(() => expect(collectionImportCommit).toHaveBeenCalled());
    expect(collectionImportCommit.mock.calls[0]?.[2]).toBeNull();
  });

  it("opens on the folder it was handed, and files the import there", async () => {
    const user = userEvent.setup();
    collectionImportCommit.mockResolvedValue(outcome({ added: 1, undoId: 7 }));
    mount("2 Sol Ring\n", { folders: FOLDERS, folderId: FOILS.id });

    expect(trigger()).toHaveTextContent("Trade binder / Foils");
    expect(screen.getByText("2 cards will be added to Foils.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Import" }));

    await waitFor(() => expect(collectionImportCommit).toHaveBeenCalled());
    expect(collectionImportCommit.mock.calls[0]?.[1]).toBe("add");
    expect(collectionImportCommit.mock.calls[0]?.[2]).toBe(FOILS.id);
    expect(useBulkUndo.getState().offers.collection?.label).toBe("Imported 2 cards into Foils.");
  });

  /** A deck's group is no place for a file to land, so an entry point naming one opens on the
   *  root rather than on a value the selector cannot offer. */
  it("offers the reader's own drawers by path, in the wall's order, and nothing the app owns", async () => {
    const user = userEvent.setup();
    mount("1 Sol Ring\n", { folders: FOLDERS, folderId: DECK_GROUP.id });

    expect(trigger()).toHaveTextContent("Not sorted");
    await user.click(trigger());
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
      "Not sorted",
      "Trade binder",
      "Trade binder / Foils",
      "Sealed",
      "New folder…",
    ]);
  });

  it("files into a folder picked in the step", async () => {
    const user = userEvent.setup();
    const { report } = mount("1 Sol Ring\n", { folders: FOLDERS });

    await pickOption(user, "Import into", "Sealed");
    expect(screen.getByText("1 card will be added to Sealed.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Import" }));

    await waitFor(() => expect(collectionImportCommit).toHaveBeenCalled());
    expect(collectionImportCommit.mock.calls[0]?.[2]).toBe(SEALED.id);
    // The toast names the folder, quoted, with the copies.
    await waitFor(() =>
      expect(report).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ title: "Imported 1 card into “Sealed”", tone: "success" }),
      ),
    );
  });

  /** Under `set` the dry run is asked about the same folder the press will write, and the radio's
   *  hint stops promising the root's rule — a folder's `set` counts nothing filed elsewhere. */
  it("asks the dry run about the chosen folder, and says what a folder's set does", async () => {
    const user = userEvent.setup();
    mount("1 Sol Ring\n", { folders: FOLDERS, folderId: BINDER.id });

    expect(setRadio()).toHaveAccessibleDescription(
      "Replaces the quantities in this folder with the file's. Copies elsewhere stay.",
    );
    await user.click(setRadio());

    await waitFor(() => expect(collectionImportPreview).toHaveBeenCalled());
    expect(collectionImportPreview.mock.calls[0]?.[1]).toBe("set");
    expect(collectionImportPreview.mock.calls[0]?.[2]).toBe(BINDER.id);
  });

  it("makes a new folder at the top level and files into it", async () => {
    const user = userEvent.setup();
    collectionFolderCreate.mockResolvedValue(folder({ id: 11, name: "Box 3" }));
    mount("1 Sol Ring\n", { folders: FOLDERS, folderId: BINDER.id });

    await pickOption(user, "Import into", "New folder…");
    // A folder with no name is not a folder yet.
    expect(screen.getByRole("button", { name: "Import" })).toBeDisabled();
    expect(screen.getByText("1 card will be added to a new folder.")).toBeInTheDocument();
    await user.type(screen.getByRole("textbox", { name: "New folder name" }), " Box 3 ");
    expect(screen.getByText("1 card will be added to a new folder, Box 3.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Import" }));

    await waitFor(() => expect(collectionImportCommit).toHaveBeenCalled());
    expect(collectionFolderCreate).toHaveBeenCalledWith(null, "Box 3");
    expect(collectionImportCommit.mock.calls[0]?.[2]).toBe(11);
  });

  /** The folder landed and the import was refused: pressing again files into that folder rather
   *  than making a second one beside it. */
  it("makes the new folder once across a refused import and a retry", async () => {
    const user = userEvent.setup();
    collectionFolderCreate.mockResolvedValue(folder({ id: 11, name: "Box 3" }));
    collectionImportCommit
      .mockRejectedValueOnce("The database is busy.")
      .mockResolvedValue(outcome({ added: 1 }));
    const { onDone } = mount("1 Sol Ring\n", { folders: FOLDERS });

    await pickOption(user, "Import into", "New folder…");
    await user.type(screen.getByRole("textbox", { name: "New folder name" }), "Box 3");
    await user.click(screen.getByRole("button", { name: "Import" }));
    expect(await screen.findByText(/The database is busy/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Import" }));

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(collectionFolderCreate).toHaveBeenCalledTimes(1);
    expect(collectionImportCommit.mock.calls.map((call) => call[2])).toEqual([11, 11]);
  });
});

/** A ManaBox export's two binder columns over two rows — a binder and a deck (issue #873). */
const MANABOX = [
  "Binder Name,Binder Type,Name,Quantity",
  "Value Binder,binder,Sol Ring,2",
  "Selvala,deck,Lightning Bolt,1",
  "",
].join("\n");

/** The group `deck_create` makes for deck 7 — the one {@link deckCreate} answers below. */
const SELVALA_GROUP = folder({ id: 40, name: "Selvala", kind: "deck", deckId: 7 });

describe("CollectionPreview, over a file that names its binders", () => {
  beforeEach(() => {
    collectionFolderCreate.mockImplementation((parentId: number | null, name: string) =>
      Promise.resolve(folder({ id: 50, name, parentId })),
    );
    deckCreate.mockReset().mockResolvedValue({ id: 7, name: "Selvala" });
    deckImportCommit
      .mockReset()
      .mockResolvedValue({ added: 1, removed: 0, categoriesCreated: 1, labelsCreated: 0 });
  });

  it("offers to sort it, ticked, and lists where each binder goes", () => {
    mount(MANABOX, { folders: FOLDERS });

    expect(
      screen.getByRole("checkbox", { name: "Sort into folders and decks by binder" }),
    ).toBeChecked();
    expect(screen.getByText(/It has 1 folder and 1 deck\./)).toBeInTheDocument();
    const list = screen.getByRole("list", { name: "Where each binder goes" });
    expect(list).toHaveTextContent("Value Binder");
    expect(list).toHaveTextContent("folder · 2 cards");
    expect(list).toHaveTextContent("new deck · 1 card");
    // The binders say where every card goes, so there is no one destination and no mode.
    expect(screen.queryByText("Import into")).toBeNull();
    expect(screen.queryByRole("radio", { name: "Set these quantities" })).toBeNull();
  });

  it("files each binder on Import and reports what it made", async () => {
    const user = userEvent.setup();
    const { onDone } = mount(MANABOX, { folders: [SELVALA_GROUP] });

    await user.click(screen.getByRole("button", { name: "Import" }));

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(collectionFolderCreate).toHaveBeenCalledWith(null, "Value Binder");
    expect(deckCreate).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Selvala", formatKey: "unspecified" }),
    );
    expect(collectionImportCommit.mock.calls.map((call) => call[2])).toEqual([50, 40]);
    expect(onDone).toHaveBeenCalledWith("3 cards imported into 1 folder (1 new) and 1 new deck.");
    // One ticket per binder, so none is offered for the press as a whole.
    expect(useBulkUndo.getState().offers.collection).toBeNull();
  });

  it("says the whole press in one notice", async () => {
    const user = userEvent.setup();
    const { onDone, report } = mount(MANABOX, { folders: [SELVALA_GROUP] });

    await user.click(screen.getByRole("button", { name: "Import" }));

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(report).toHaveBeenCalledExactlyOnceWith({
      title: "Imported 3 cards into your collection",
      body: "3 cards imported into 1 folder (1 new) and 1 new deck.",
      tone: "success",
    });
  });

  it("says a press that stopped part-way as a warning with what landed", async () => {
    const user = userEvent.setup();
    deckImportCommit.mockReset().mockRejectedValue("database is locked");
    const { onDone, report } = mount(MANABOX, { folders: [SELVALA_GROUP] });

    await user.click(screen.getByRole("button", { name: "Import" }));

    await waitFor(() => expect(report).toHaveBeenCalledTimes(1));
    expect(report).toHaveBeenCalledWith({
      title: "Imported 2 of 3 cards into your collection",
      body: "Stopped at “Selvala”: database is locked. Already imported: “Value Binder”.",
      tone: "warning",
    });
    expect(onDone).not.toHaveBeenCalled();
  });

  /** Issue #1173: the retry finishes the file — no second copy of `Value Binder`'s cards, and no
   *  second `Selvala` deck. */
  it("imports each binder once across a refused press and a retry", async () => {
    const user = userEvent.setup();
    collectionImportCommit
      .mockResolvedValueOnce(outcome({ added: 1 }))
      .mockRejectedValueOnce("database is locked")
      .mockResolvedValue(outcome({ added: 1 }));
    const { onDone, report } = mount(MANABOX, { folders: [SELVALA_GROUP] });

    await user.click(screen.getByRole("button", { name: "Import" }));
    await waitFor(() => expect(report).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole("button", { name: "Import" }));

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(collectionFolderCreate).toHaveBeenCalledTimes(1);
    expect(deckCreate).toHaveBeenCalledTimes(1);
    expect(collectionImportCommit.mock.calls.map((call) => call[2])).toEqual([50, 40, 40]);
    expect(onDone).toHaveBeenCalledWith("3 cards imported into 1 folder (1 new) and 1 new deck.");
  });

  it("is the plain collection step again once unticked", async () => {
    const user = userEvent.setup();
    const { onDone } = mount(MANABOX, { folders: FOLDERS });

    await user.click(
      screen.getByRole("checkbox", { name: "Sort into folders and decks by binder" }),
    );
    expect(setRadio()).toBeInTheDocument();
    expect(screen.getByText("Import into")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Import" }));

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(collectionImportCommit).toHaveBeenCalledTimes(1);
    expect(collectionImportCommit.mock.calls[0][2]).toBeNull();
    expect(deckCreate).not.toHaveBeenCalled();
  });

  it("never offers the sort for a file that names no binder", () => {
    mount("Quantity,Name\n1,Sol Ring\n");
    expect(screen.queryByRole("checkbox", { name: /by binder/ })).toBeNull();
  });
});
