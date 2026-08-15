import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DeckFolder, DeckRow } from "@/lib/ipc";
import type { MenuAction, MenuItem, MenuLazy } from "@/components/menu/types";

/** The one command either menu can reach, and only from an expanded "Move to". Everything else
 *  a menu does arrives as a callback, which is what keeps these builders pure. */
const deckFolderList = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: { deckFolderList },
}));

import { buildDeckMenu, type DeckMenuDeps } from "./deckMenu";
import {
  buildFolderMenu,
  folderDestinations,
  folderDestinationRowId,
  FOLDER_DESTINATION_ATTR,
  type FolderMenuDeps,
} from "./folderMenu";

/** A deck at the top level. The eight columns the gallery's own fixture carries, because every
 *  real row carries all of them. */
const ATRAXA: DeckRow = {
  id: 4,
  name: "Atraxa Superfriends",
  formatKey: "commander",
  formatName: "Commander",
  description: null,
  coverCardId: null,
  coverArtist: null,
  coverKind: "card_art",
  isBuilt: false,
  archived: false,
  cardCount: 100,
  updatedAt: 1_800_000_000,
  folderId: null,
  notes: null,
  theoryEnabled: false,
  lastVariant: "live",
  lastGroupBy: "category",
  lastSortBy: "alphabetical",
  separateXGroup: false,
  defaultCategoryId: 0,
};

/** Three folders, one of them inside another: `Budget` is what `Commander` may not be moved
 *  into, and `Modern` is the destination that is legal from everywhere. */
const COMMANDER: DeckFolder = { id: 1, parentId: null, name: "Commander", sortOrder: 0 };
const BUDGET: DeckFolder = { id: 2, parentId: 1, name: "Budget", sortOrder: 0 };
const MODERN: DeckFolder = { id: 3, parentId: null, name: "Modern", sortOrder: 1 };
const FOLDERS: DeckFolder[] = [COMMANDER, BUDGET, MODERN];

function deps(over: Partial<DeckMenuDeps> = {}): DeckMenuDeps {
  return {
    setOpenDeckId: vi.fn(),
    startRename: vi.fn(),
    openSettings: vi.fn(),
    moveToFolder: vi.fn(),
    duplicate: vi.fn(),
    askDelete: vi.fn(),
    ...over,
  };
}

function folderDeps(over: Partial<FolderMenuDeps> = {}): FolderMenuDeps {
  return {
    newDeck: vi.fn(),
    newSubfolder: vi.fn(),
    startRename: vi.fn(),
    moveFolder: vi.fn(),
    askDelete: vi.fn(),
    ...over,
  };
}

/** Every row a reader sees, separators left out — they are drawn and never landed on. */
const labels = (items: MenuItem[]) =>
  items.flatMap((item) => (item.kind === "separator" ? [] : [item.label]));

const find = (items: MenuItem[], label: string) =>
  items.find((item) => item.kind !== "separator" && item.label === label)!;

/**
 * A `lazy` submenu's rows, mounted.
 *
 * The destinations are a component rather than data precisely because they are fetched on
 * expand, so the only way to read them is to render one — which is also the only way to prove
 * the fence, since a row that cannot be pressed is `aria-disabled` rather than absent.
 */
function expand(item: MenuLazy) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const onDone = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <item.Content onDone={onDone} />
    </QueryClientProvider>,
  );
  return { onDone };
}

/**
 * The folders a "Move to" offers but will not take, by id.
 *
 * A destination row says which folder it is in its **id** — these are the panel's own
 * `ActionRow`s, which carry `data-menu-row` and nothing a caller may add — so a row is matched
 * by composing that id rather than by reading an attribute this file spells for itself. The top
 * level has an id of its own (`destination-root`) and is not a folder, so it never matches.
 */
async function forbiddenFor(items: MenuItem[]): Promise<number[]> {
  expand(find(items, "Move to") as MenuLazy);
  await screen.findAllByRole("menuitem");
  const inert = screen
    .getAllByRole("menuitem")
    .filter((row) => row.getAttribute("aria-disabled") === "true")
    .map((row) => row.getAttribute(FOLDER_DESTINATION_ATTR));
  return FOLDERS.filter((folder) => inert.includes(folderDestinationRowId(folder.id))).map(
    (folder) => folder.id,
  );
}

beforeEach(() => {
  deckFolderList.mockReset().mockResolvedValue(FOLDERS);
});

describe("buildDeckMenu", () => {
  it("offers open, rename, move, settings, duplicate and delete", () => {
    expect(labels(buildDeckMenu(ATRAXA, deps()))).toEqual([
      "Open deck",
      "Rename…",
      "Move to",
      "Deck settings…",
      "Duplicate",
      "Delete…",
    ]);
  });

  it("opens the deck", () => {
    const setOpenDeckId = vi.fn();
    (find(buildDeckMenu(ATRAXA, deps({ setOpenDeckId })), "Open deck") as MenuAction).onSelect();
    expect(setOpenDeckId).toHaveBeenCalledWith(ATRAXA.id);
  });

  it("opens the tile's own rename field, on the deck that was right-clicked", () => {
    const startRename = vi.fn();
    (find(buildDeckMenu(ATRAXA, deps({ startRename })), "Rename…") as MenuAction).onSelect();
    expect(startRename).toHaveBeenCalledWith(ATRAXA);
  });

  it("opens the settings dialog over the gallery, without opening the editor", () => {
    const openSettings = vi.fn();
    const setOpenDeckId = vi.fn();
    const menu = buildDeckMenu(ATRAXA, deps({ openSettings, setOpenDeckId }));
    (find(menu, "Deck settings…") as MenuAction).onSelect();
    expect(openSettings).toHaveBeenCalledWith(ATRAXA.id);
    expect(setOpenDeckId).not.toHaveBeenCalled();
  });

  it("duplicates the deck", () => {
    const duplicate = vi.fn();
    (find(buildDeckMenu(ATRAXA, deps({ duplicate })), "Duplicate") as MenuAction).onSelect();
    expect(duplicate).toHaveBeenCalledWith(ATRAXA.id);
  });

  /**
   * A menu opens by accident. It must not be one press from an irreversible write.
   *
   * The plan asserted that `decks.remove` was *not* called; this asserts something stronger,
   * because {@link DeckMenuDeps} carries no remove at all — the menu cannot reach the delete,
   * so there is no call site to get wrong later.
   */
  it("routes delete through the confirmation the tile already uses", () => {
    const askDelete = vi.fn();
    (find(buildDeckMenu(ATRAXA, deps({ askDelete })), "Delete…") as MenuAction).onSelect();
    expect(askDelete).toHaveBeenCalledWith(ATRAXA);
  });

  it("asks for the folder tree when the row is expanded, and never when the menu opens", async () => {
    const moveTo = find(buildDeckMenu(ATRAXA, deps()), "Move to") as MenuLazy;

    // The whole point of the `lazy` kind: a right-click on a tile costs no read.
    expect(moveTo.kind).toBe("lazy");
    expect(deckFolderList).not.toHaveBeenCalled();

    expand(moveTo);
    const row = await screen.findByRole("menuitem", { name: /^Modern/ });
    expect(deckFolderList).toHaveBeenCalled();

    // The two attributes the panel finds a row by. The caret reaches these rows through their
    // **role**, but the pointer's hover handler resolves a row through `ROW_ATTR` — and without
    // it a submenu opened by hover stays open while the pointer sweeps past to the row below,
    // which is a defect nothing else here would notice.
    expect(row).toHaveAttribute("data-menu-row", "destination-3");
    expect(row).toHaveAttribute("data-menu-row-button");
  });

  /**
   * **The menu and the tile's own Move popup must answer the same about one deck.**
   *
   * `DecksPage` hands `MoveToFolder` a `currentId` normalised through the folder list it really
   * has (`folderOf`), so a deck whose `folderId` names a folder that list has lost reads as being
   * at the root. Passed raw, this menu would mark nothing inert and offer a live
   * `deck_set_folder(id, null)` for a deck already at the root — a write that changes nothing and
   * bumps `updated_at`. `folderDestinations` normalises, so both surfaces agree.
   */
  it("marks the root as where it is now for a deck whose folder has left the list", async () => {
    const moveToFolder = vi.fn();
    const menu = buildDeckMenu({ ...ATRAXA, folderId: 99 }, deps({ moveToFolder }));
    expand(find(menu, "Move to") as MenuLazy);

    const root = await screen.findByRole("menuitem", { name: /^All decks/ });
    expect(root).toHaveAttribute("aria-disabled", "true");
    expect(root).toHaveTextContent("Here now");

    await userEvent.click(root);
    expect(moveToFolder).not.toHaveBeenCalled();
  });

  it("marks the folder the deck is already in as where it is now", async () => {
    const moveTo = find(
      buildDeckMenu({ ...ATRAXA, folderId: MODERN.id }, deps()),
      "Move to",
    ) as MenuLazy;
    expand(moveTo);

    // Offered and inert: moving something to where it already is writes nothing and bumps
    // `updated_at`.
    const here = await screen.findByRole("menuitem", { name: /^Modern/ });
    expect(here).toHaveAttribute("aria-disabled", "true");
    expect(here).toHaveTextContent("Here now");
    // Never the `disabled` attribute: a greyed row exists to be read.
    expect(here).not.toBeDisabled();
  });

  it("files the deck through deck_set_folder, top level included", async () => {
    const moveToFolder = vi.fn();
    const menu = buildDeckMenu({ ...ATRAXA, folderId: MODERN.id }, deps({ moveToFolder }));
    const { onDone } = expand(find(menu, "Move to") as MenuLazy);

    await userEvent.click(await screen.findByRole("menuitem", { name: /^Commander › Budget/ }));
    expect(moveToFolder).toHaveBeenCalledWith(ATRAXA.id, BUDGET.id);
    // **The menu closes on the pick, the way every other row does — through `ctx.run` and never
    // through `onDone`.** These are the panel's own rows now, so choosing one focuses the opener,
    // closes the menu and *then* writes; `onDone` is `ctx.close`, which hands focus nowhere, and
    // calling it as well would be a second close of something already gone. That is why nothing
    // is asserted about it here and why the hand-back is asserted where the opener lives —
    // `DecksPage.test.tsx`'s "hands the caret back to the row when the menu's Move to writes".
    // Rendered on its own, as here, a row's press is `NO_CASCADE.run`: the write and no close.
    expect(onDone).not.toHaveBeenCalled();

    // `null` is an offer with a meaning: `DeckPatch.folderId` writes `coalesce(?n, folder_id)`
    // and cannot express it, so this row is the only way back to the root.
    await userEvent.click(screen.getByRole("menuitem", { name: /^All decks/ }));
    expect(moveToFolder).toHaveBeenLastCalledWith(ATRAXA.id, null);
  });

  /** A refused read is said in words rather than drawn as an empty panel, which reads as a menu
   *  with nothing to offer. */
  it("says so when the folder list cannot be read", async () => {
    deckFolderList.mockRejectedValue(new Error("database is locked"));
    expand(find(buildDeckMenu(ATRAXA, deps()), "Move to") as MenuLazy);

    expect(await screen.findByText(/Could not read your folders/)).toBeInTheDocument();
    expect(screen.queryAllByRole("menuitem")).toHaveLength(0);
  });

  /** A reader who files nothing still gets the one destination that is not a folder — and it is
   *  the one they are already in, so it is offered inert. */
  it("offers the top level even when there are no folders at all", async () => {
    deckFolderList.mockResolvedValue([]);
    expand(find(buildDeckMenu(ATRAXA, deps()), "Move to") as MenuLazy);

    const rows = await screen.findAllByRole("menuitem");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent("All decks");
    expect(rows[0]).toHaveAttribute("aria-disabled", "true");
  });

  it("writes nothing when an inert destination is pressed", async () => {
    const moveToFolder = vi.fn();
    const menu = buildDeckMenu({ ...ATRAXA, folderId: MODERN.id }, deps({ moveToFolder }));
    const { onDone } = expand(find(menu, "Move to") as MenuLazy);

    await userEvent.click(await screen.findByRole("menuitem", { name: /^Modern/ }));

    expect(moveToFolder).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
  });
});

describe("buildFolderMenu", () => {
  it("offers the five things the tree's buttons already do", () => {
    expect(labels(buildFolderMenu(COMMANDER, folderDeps()))).toEqual([
      "New deck here",
      "New subfolder…",
      "Rename…",
      "Move to",
      "Delete…",
    ]);
  });

  it("makes a deck and a sub-folder in the folder that was right-clicked", () => {
    const newDeck = vi.fn();
    const newSubfolder = vi.fn();
    const menu = buildFolderMenu(COMMANDER, folderDeps({ newDeck, newSubfolder }));

    (find(menu, "New deck here") as MenuAction).onSelect();
    (find(menu, "New subfolder…") as MenuAction).onSelect();

    expect(newDeck).toHaveBeenCalledWith(COMMANDER.id);
    expect(newSubfolder).toHaveBeenCalledWith(COMMANDER.id);
  });

  it("opens the tree's own rename field, and the delete question rather than the delete", () => {
    const startRename = vi.fn();
    const askDelete = vi.fn();
    const menu = buildFolderMenu(COMMANDER, folderDeps({ startRename, askDelete }));

    (find(menu, "Rename…") as MenuAction).onSelect();
    (find(menu, "Delete…") as MenuAction).onSelect();

    expect(startRename).toHaveBeenCalledWith(COMMANDER.id);
    // The sentence a reader guesses wrong — the decks inside are kept, the folders inside are
    // not — is the whole point of the step, so the menu asks the question and never writes.
    expect(askDelete).toHaveBeenCalledWith(COMMANDER);
  });

  it("cannot move a folder into itself or its own descendants", async () => {
    const forbidden = await forbiddenFor(buildFolderMenu(COMMANDER, folderDeps()));

    expect(forbidden).toContain(COMMANDER.id);
    expect(forbidden).toContain(BUDGET.id);
    // The fence is itself and what it holds, and nothing else: a sibling is a legal destination.
    expect(forbidden).not.toContain(MODERN.id);
  });

  it("says why a destination cannot be taken, beside the destination", async () => {
    expand(find(buildFolderMenu(COMMANDER, folderDeps()), "Move to") as MenuLazy);
    await screen.findAllByRole("menuitem");

    const row = (id: number) =>
      screen
        .getAllByRole("menuitem")
        .find((r) => r.getAttribute(FOLDER_DESTINATION_ATTR) === folderDestinationRowId(id))!;

    // One sentence per row, rather than one under the list: `MenuAction.reason`'s shape, and
    // the two fences are different sentences.
    expect(row(COMMANDER.id)).toHaveTextContent("Cannot go inside itself");
    expect(row(BUDGET.id)).toHaveTextContent("Cannot go inside what it holds");
  });

  it("moves the folder, top level included", async () => {
    const moveFolder = vi.fn();
    const menu = buildFolderMenu(BUDGET, folderDeps({ moveFolder }));
    expand(find(menu, "Move to") as MenuLazy);

    await userEvent.click(await screen.findByRole("menuitem", { name: /^Modern/ }));
    expect(moveFolder).toHaveBeenCalledWith(BUDGET.id, MODERN.id);

    await userEvent.click(screen.getByRole("menuitem", { name: /^All decks/ }));
    expect(moveFolder).toHaveBeenLastCalledWith(BUDGET.id, null);
  });
});

describe("folderDestinations", () => {
  /**
   * The top level first, then every folder as the path a reader would say out loud —
   * `folderPaths`' spelling, which is the settings dialog's Folder select's too. A menu row has
   * no indent to nest with, and a flat list of bare names would show two "Budget" with nothing
   * to tell them apart.
   */
  it("offers the top level and every folder, as paths", () => {
    expect(folderDestinations(FOLDERS, { currentId: null, moving: null })).toEqual([
      { folderId: null, name: "All decks", inert: "Here now" },
      { folderId: COMMANDER.id, name: "Commander", inert: null },
      { folderId: BUDGET.id, name: "Commander › Budget", inert: null },
      { folderId: MODERN.id, name: "Modern", inert: null },
    ]);
  });

  /** Each inert row says its own reason, which is `MenuAction.reason`'s shape: a sentence
   *  beside the row rather than one under the list. */
  it("says which fence a destination is behind", () => {
    const inert = Object.fromEntries(
      folderDestinations(FOLDERS, { currentId: COMMANDER.parentId, moving: COMMANDER.id }).map(
        (d) => [d.name, d.inert],
      ),
    );

    expect(inert).toEqual({
      "All decks": "Here now",
      Commander: "Cannot go inside itself",
      "Commander › Budget": "Cannot go inside what it holds",
      Modern: null,
    });
  });

  /**
   * A `folderId` naming a folder this list does not carry resolves at the **root**, so the root
   * is what reads "Here now" — the rule `buildFolderTree` applies to a child with a missing
   * parent, and the one `DecksPage`'s `folderOf` applies before it hands the tile's own
   * `MoveToFolder` a `currentId`.
   *
   * **This is the case where a menu and the popup one press away could disagree about one deck.**
   * Read raw, the menu would mark nothing and offer a live `deck_set_folder(id, null)` for a deck
   * that is already at the root: the no-op write that bumps `updated_at` and changes nothing,
   * which is what `Here now` exists to prevent. Normalised inside `folderDestinations` rather
   * than at the call site, so no third caller can miss it.
   */
  it("marks the root as where it is now when the deck's folder has left the list", () => {
    const destinations = folderDestinations(FOLDERS, { currentId: 99, moving: null });

    expect(destinations.filter((d) => d.inert !== null)).toEqual([
      { folderId: null, name: "All decks", inert: "Here now" },
    ]);
  });
});
