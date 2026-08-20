import { describe, expect, it, vi } from "vitest";
import type { MenuAction, MenuItem } from "@/components/menu/types";
import { fromDeckCard } from "@/features/transfer/TransferCard";
import type { DeckCard, DeckCategory } from "@/lib/ipc";
import { buildCategoryMenu, type CategoryMenuDeps } from "./categoryMenu";
import { card } from "./validation/fixtures";

/** A pile, with the columns `deck_category_list` answers filled in as nothing much. `kind` and
 *  `name` are the two this file is actually about. */
function category(over: Partial<DeckCategory> & { id: number; name: string }): DeckCategory {
  return {
    deckId: 4,
    kind: "main",
    origin: "user",
    isActive: true,
    sortOrder: 0,
    cardCount: 0,
    totalPrice: null,
    cardCountAllVariants: 0,
    ...over,
  };
}

/** A pile the reader made: `main`, so every write in the menu is one the backend takes. */
const REMOVAL = category({ id: 11, name: "Removal", sortOrder: 3, cardCount: 2 });
/** One of the four the backend refuses to rename or delete — the refusal is on the **kind**. */
const COMMANDER_ZONE = category({ id: 1, name: "Commander", kind: "commander" });
/** The one seeded zone that arrives switched off, so the switch reads the other way round. */
const MAYBEBOARD = category({ id: 4, name: "Maybeboard", kind: "maybe", isActive: false });

const REMOVAL_CARDS: DeckCard[] = [
  card({ name: "Swords to Plowshares", categoryId: REMOVAL.id, categoryName: REMOVAL.name }),
  card({ name: "Path to Exile", categoryId: REMOVAL.id, categoryName: REMOVAL.name }),
];
/** A card in another pile. An export of Removal must not carry it. */
const RAMP_CARD = card({ name: "Sol Ring", categoryId: 12, categoryName: "Ramp" });
const DECK_CARDS: DeckCard[] = [...REMOVAL_CARDS, RAMP_CARD];

function deps(over: Partial<CategoryMenuDeps> = {}): CategoryMenuDeps {
  return {
    cards: DECK_CARDS,
    startRename: vi.fn(),
    openImport: vi.fn(),
    openExport: vi.fn(),
    setActive: vi.fn(),
    askClear: vi.fn(),
    askDelete: vi.fn(),
    ...over,
  };
}

/** Every row a reader sees, separators left out — they are drawn and never landed on. */
const labels = (items: MenuItem[]) =>
  items.flatMap((item) => (item.kind === "separator" ? [] : [item.label]));

const find = (items: MenuItem[], label: string) =>
  items.find((item) => item.kind !== "separator" && item.label === label)!;

/** Every row **including** the rules between them, by `id`. {@link labels} strips separators, so
 *  it is the one shape that cannot see one being dropped. */
const shape = (items: MenuItem[]) =>
  items.map((item) => (item.kind === "separator" ? `—${item.id}` : item.id));

describe("buildCategoryMenu", () => {
  it("offers rename, import, export, the switch, the clear and delete for a reader's pile", () => {
    expect(labels(buildCategoryMenu(REMOVAL, deps()))).toEqual([
      "Rename…",
      "Import cards…",
      "Export cards…",
      "Deactivate",
      "Clear stack…",
      "Delete…",
    ]);
  });

  /**
   * **The rule sits above the two rows that change what the deck counts**, and its position is
   * the whole reason it is there: switching a pile off takes its cards out of size, copy limits,
   * legality and the allocator's claims, and deleting one takes the cards themselves. Nothing
   * else in this file can see it — `labels` strips separators, exactly as the panel's caret does
   * — so removing it would fail no other assertion here.
   */
  it("puts a rule above the rows that change what the deck counts", () => {
    expect(shape(buildCategoryMenu(REMOVAL, deps()))).toEqual([
      "rename",
      "import",
      "export",
      "—before-writes",
      "active",
      "clear",
      "delete",
    ]);
    // And on a zone whose two absent rows sit either side of it, the rule is still between the
    // reads and the writes rather than left dangling at an end.
    expect(shape(buildCategoryMenu(COMMANDER_ZONE, deps()))).toEqual([
      "import",
      "export",
      "—before-writes",
      "active",
      "clear",
    ]);
  });

  /**
   * The three writes escalate: switching a pile off is reversible in one press, clearing it takes
   * its cards out of the list on screen, and deleting it takes the pile and both lists' cards.
   * A reader who slips one row lands on the smaller destruction, never the larger.
   */
  it("orders the destructive rows from reversible to irreversible", () => {
    const rows = labels(buildCategoryMenu(REMOVAL, deps()));

    expect(rows.indexOf("Deactivate")).toBeLessThan(rows.indexOf("Clear stack…"));
    expect(rows.indexOf("Clear stack…")).toBeLessThan(rows.indexOf("Delete…"));
  });

  it("says Activate for a switched-off pile", () => {
    expect(labels(buildCategoryMenu({ ...REMOVAL, isActive: false }, deps()))).toContain(
      "Activate",
    );
  });

  /**
   * **`rename_category` and `delete_category` both refuse a kind that is not `main`**, so both
   * rows are absent on the four predefined zones rather than greyed: an item that exists only to
   * be refused is worse than one that is not there.
   *
   * The switch is a different answer, and it is the backend's rather than this menu's:
   * `set_category_active` takes **every** kind, the command zone included, and
   * `CategoriesDialog` has always drawn its toggle on all four rows. So it stays.
   */
  it("leaves rename and delete off the four predefined zones, and keeps the switch", () => {
    const items = labels(buildCategoryMenu(COMMANDER_ZONE, deps()));

    expect(items).not.toContain("Rename…");
    expect(items).not.toContain("Delete…");
    expect(items).toEqual(["Import cards…", "Export cards…", "Deactivate", "Clear stack…"]);
  });

  /**
   * **The clear is not one of the two the kind takes away**, and the difference is which question
   * is being asked: rename and delete are absent because `deck_meta.rs` refuses a `kind` that is
   * not `main`, and nothing refuses a clear. Emptying the Sideboard between two rounds is one of
   * the more obvious things to want from a heading's menu.
   */
  it("offers the clear on a predefined zone, which rename and delete are absent from", () => {
    const zone = { ...COMMANDER_ZONE, cardCount: 1 };
    const askClear = vi.fn();

    (find(buildCategoryMenu(zone, deps({ askClear })), "Clear stack…") as MenuAction).onSelect();

    expect(askClear).toHaveBeenCalledWith(zone);
  });

  /** The Maybeboard is seeded inactive, so the one thing a reader wants from its menu is the
   *  way back on — and it is a predefined zone, which is why it is worth its own case. */
  it("offers Activate on the seeded Maybeboard", () => {
    expect(labels(buildCategoryMenu(MAYBEBOARD, deps()))).toEqual([
      "Import cards…",
      "Export cards…",
      "Activate",
      "Clear stack…",
    ]);
  });

  it("hands the category's own cards to the export dialog", () => {
    const openExport = vi.fn();

    (
      find(buildCategoryMenu(REMOVAL, deps({ openExport })), "Export cards…") as MenuAction
    ).onSelect();

    expect(openExport).toHaveBeenCalledWith(
      expect.objectContaining({ subject: "Removal", cards: REMOVAL_CARDS.map(fromDeckCard) }),
    );
  });

  /** The whole pile and only the pile: a card filed elsewhere is not part of this export, and
   *  the id travels with it so the host can re-read the pile rather than hold a snapshot. */
  it("carries the category's id and nothing from another pile", () => {
    const openExport = vi.fn();

    (
      find(buildCategoryMenu(REMOVAL, deps({ openExport })), "Export cards…") as MenuAction
    ).onSelect();

    expect(openExport).toHaveBeenCalledWith({
      categoryId: REMOVAL.id,
      subject: "Removal",
      cards: REMOVAL_CARDS.map(fromDeckCard),
    });
  });

  it("opens the importer aimed at this pile", () => {
    const openImport = vi.fn();

    (
      find(buildCategoryMenu(REMOVAL, deps({ openImport })), "Import cards…") as MenuAction
    ).onSelect();

    expect(openImport).toHaveBeenCalledWith({ forcedCategoryName: "Removal" });
  });

  it("opens the rename field on the category that was right-clicked", () => {
    const startRename = vi.fn();

    (find(buildCategoryMenu(REMOVAL, deps({ startRename })), "Rename…") as MenuAction).onSelect();

    expect(startRename).toHaveBeenCalledWith(REMOVAL);
  });

  /** The switch sends the value it is moving **to**, never a toggle: the row that drew "Deactivate"
   *  and the write it makes have to be the same statement, or a stale menu writes the wrong one. */
  it("switches the pile the way the row it drew says", () => {
    const setActive = vi.fn();

    (find(buildCategoryMenu(REMOVAL, deps({ setActive })), "Deactivate") as MenuAction).onSelect();
    expect(setActive).toHaveBeenLastCalledWith(REMOVAL, false);

    const off = { ...REMOVAL, isActive: false };
    (find(buildCategoryMenu(off, deps({ setActive })), "Activate") as MenuAction).onSelect();
    expect(setActive).toHaveBeenLastCalledWith(off, true);
  });

  /**
   * A menu opens by accident, and deleting a pile takes its cards with it unless the reader says
   * where they go. {@link CategoryMenuDeps} carries no delete write at all, so this menu is
   * structurally incapable of reaching one — the same fence `buildDeckMenu` puts around a deck.
   */
  it("routes delete through a confirmation and can reach no delete write", () => {
    const askDelete = vi.fn();

    (find(buildCategoryMenu(REMOVAL, deps({ askDelete })), "Delete…") as MenuAction).onSelect();

    expect(askDelete).toHaveBeenCalledWith(REMOVAL);
  });

  /** The same fence around the clear, and for the same reason: {@link CategoryMenuDeps} carries
   *  no clear write, so the menu cannot empty a pile without the reader passing through the
   *  question. */
  it("routes the clear through a confirmation and can reach no clear write", () => {
    const askClear = vi.fn();

    (find(buildCategoryMenu(REMOVAL, deps({ askClear })), "Clear stack…") as MenuAction).onSelect();

    expect(askClear).toHaveBeenCalledWith(REMOVAL);
  });

  /**
   * **An empty pile keeps the row and greys it**, where a refused write would have had the row
   * dropped. The two are different statements: a dropped row is one the backend will not take,
   * and this one is a row that would write nothing — so it stays where the reader last found it,
   * with `aria-disabled` rather than `disabled` so it is still readable and still in the tab
   * order.
   *
   * `cardCount` is the number consulted and never `cardCountAllVariants`, which is the reverse of
   * what the delete confirmation quotes: a clear is scoped to the list on screen, so a pile
   * holding nothing here and three copies in the theory list is a pile with nothing to clear.
   */
  it("greys the clear on a pile that is empty in the variant on screen", () => {
    const askClear = vi.fn();
    const emptyHere = { ...REMOVAL, cardCount: 0, cardCountAllVariants: 3 };
    const row = find(buildCategoryMenu(emptyHere, deps({ askClear })), "Clear stack…") as MenuAction;

    expect(row.disabled).toBe(true);
    expect(row.reason).toBe("already empty");

    row.onSelect();
    expect(askClear).not.toHaveBeenCalled();
  });
});
