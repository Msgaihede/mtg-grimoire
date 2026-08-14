/**
 * What a pile offers on a right-click in the deck editor — the heading over a column of cards.
 *
 * **A pure builder whose dependencies are an argument**, exactly as `deckMenu`'s and
 * `cardMenu`'s are: the writes belong to `useDeckMeta`, the two dialogs belong to `DeckEditor`,
 * and every one of them arrives as a callback, so this file is testable with no provider, no
 * query client and no window.
 *
 * Two of the five rows are things the Categories dialog already does — rename, and the switch —
 * and the menu is where they stop being a round trip through a panel listing every pile in the
 * deck to change one. The other three are new or newly aimed:
 *
 * * **Export cards…** is this app's first export of any kind, over one pile. `ExportDialog`
 *   takes its cards as an argument and fetches nothing, which is precisely what lets a category
 *   hand it a subset of the deck.
 * * **Import cards…** opens the importer *aimed at this pile*: `buildImportPlan`'s trailing
 *   `forcedCategoryName`, so every line of the paste lands here whatever the filer would have
 *   said. The override is in the planner and not in the dialog — `plan.ts` makes every deck
 *   decision and the dialog makes none.
 * * **Delete…** asks rather than writes. {@link CategoryMenuDeps} carries no delete mutation at
 *   all, so this menu structurally cannot reach the irreversible write: a menu opens by
 *   accident, and deleting a pile takes its cards with it unless the reader says where they go.
 *
 * **Two rows are absent on the four predefined zones rather than greyed, and it is the backend
 * that decides which two.** `rename_category` and `delete_category` both refuse a category whose
 * `kind` is not `main` (Commander, Sideboard, Companion, Maybeboard), and an item that exists
 * only to be refused is worse than one that is not there — `CategoriesDialog` has drawn exactly
 * those two conditionally since it was written. **The switch is not one of them**:
 * `set_category_active` takes every kind, the command zone included, and switching the
 * Maybeboard back on is the single most likely thing anybody wants from its menu.
 */
import { FileInput, FileOutput, Pencil, Power, PowerOff, Trash2 } from "lucide-react";
import type { MenuItem } from "@/components/menu/types";
import type { DeckCard, DeckCategory } from "@/lib/ipc";

/**
 * What the export dialog is opened with: the pile, named, with its cards in hand.
 *
 * The **id** travels beside them because a host that keeps the deck loaded should re-read the
 * pile from its own live list rather than freeze this array — the deck is re-read after every
 * write, and an export drawn from a snapshot would quietly describe the deck as it was. The
 * cards are here for a host that has no such list.
 */
export interface CategoryExport {
  categoryId: number;
  /** The pile's name — `ExportDialog`'s `subject`, which titles it and names the file. */
  subject: string;
  /** This pile's cards, and no other pile's. A whole {@link DeckCard} satisfies `ExportCard`,
   *  so nothing is adapted on the way. */
  cards: readonly DeckCard[];
}

/** Everything the category menu does that is not the category. Built once per surface, not
 *  once per heading. */
export interface CategoryMenuDeps {
  /**
   * Every card in the list on screen — **unfiltered**, the deck's own rows rather than what the
   * toolbar's filter left. Exporting "Removal" means the pile, not the four of it a search box
   * happens to be showing.
   */
  cards: readonly DeckCard[];
  /** Open the heading's inline rename field. The whole category, because the field opens on the
   *  name the heading is showing. */
  startRename: (category: DeckCategory) => void;
  /** Open the importer with every line aimed at this pile — `buildImportPlan`'s trailing
   *  argument, threaded through `ImportDeckDialog`. */
  openImport: (request: { forcedCategoryName: string }) => void;
  openExport: (request: CategoryExport) => void;
  /**
   * `set_category_active`, and the value is the one being moved **to** rather than a toggle: the
   * row that drew "Deactivate" and the write it makes have to be the same statement, or a menu
   * built a moment before a change writes the opposite of what it says.
   */
  setActive: (category: DeckCategory, isActive: boolean) => void;
  /** The confirmation a delete owes — never `meta.deleteCategory`. See this file's doc. */
  askDelete: (category: DeckCategory) => void;
}

/**
 * Whether the backend will refuse to rename or delete this pile.
 *
 * **`kind` alone, which is what `deck_meta.rs` tests** — both refusals are a bare
 * `if kind != "main"`. `CardGroup.isPredefined` adds a name test on top of it, and is right to:
 * that one answers a *drawing* question about a pile a reader may have called "Sideboard"
 * themselves, and such a pile is `main` and theirs to rename. This one answers a *writing*
 * question, so it asks exactly what the write asks.
 */
function isPredefinedZone(category: DeckCategory): boolean {
  return category.kind !== "main";
}

/** The rows of a pile's right-click, in the order they are drawn. */
export function buildCategoryMenu(category: DeckCategory, deps: CategoryMenuDeps): MenuItem[] {
  const fixed = isPredefinedZone(category);
  const items: MenuItem[] = [];

  if (!fixed) {
    items.push({
      kind: "action",
      id: "rename",
      label: "Rename…",
      Icon: Pencil,
      onSelect: () => deps.startRename(category),
    });
  }

  items.push(
    {
      kind: "action",
      id: "import",
      label: "Import cards…",
      Icon: FileInput,
      onSelect: () => deps.openImport({ forcedCategoryName: category.name }),
    },
    {
      kind: "action",
      id: "export",
      label: "Export cards…",
      Icon: FileOutput,
      onSelect: () =>
        deps.openExport({
          categoryId: category.id,
          subject: category.name,
          cards: deps.cards.filter((card) => card.categoryId === category.id),
        }),
    },
    // The two below change what the deck *counts*, so they sit under a rule. Switching a pile
    // off takes its cards out of size, copy limits, legality and the allocator's claims in one
    // press — reversible, but not small.
    { kind: "separator", id: "before-writes" },
    {
      kind: "action",
      id: "active",
      label: category.isActive ? "Deactivate" : "Activate",
      Icon: category.isActive ? PowerOff : Power,
      onSelect: () => deps.setActive(category, !category.isActive),
    },
  );

  if (!fixed) {
    items.push({
      kind: "action",
      id: "delete",
      label: "Delete…",
      Icon: Trash2,
      onSelect: () => deps.askDelete(category),
    });
  }

  return items;
}
