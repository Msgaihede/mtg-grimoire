/**
 * What a deck offers on a right-click in the gallery.
 *
 * **A pure builder whose dependencies are an argument**, exactly as `cardMenu`'s is: the writes
 * belong to `useDecks` and the two layers belong to `DecksPage`, so every one of them arrives as
 * a callback and this file is testable without a provider, a query client or a window.
 *
 * Four of the eight rows are things the tile already does — open, move, duplicate, delete — and
 * the menu is where they stop being four icons that appear on hover. The other four are new:
 *
 * * **Rename** had no inline affordance at all. Renaming a deck meant opening the editor and
 *   typing into its settings dialog, which is a round trip for one word. The field it opens is
 *   `metaRows.tsx`'s `RenameField`, the one the folder rename already uses.
 * * **Deck settings** opens `DeckSettingsDialog` **over the gallery**, on the deck that was
 *   right-clicked, without opening the editor. `DeckSettingsForm` owns no mutation and imports
 *   no hook that reaches the backend, which is precisely what lets a third host draw it.
 *
 * * **Add tag / Remove tag** (issue #914) put the deck's own tags (`decks.tags`, issue #834 — not
 *   Scryfall tags and not card labels) one press away from the wall, where they are drawn. See
 *   {@link tagItems} for what each offers and why both are plain submenus.
 *
 * **Delete keeps the confirmation the tile asks**, and the type is what enforces it:
 * {@link DeckMenuDeps} carries no `remove`, so this menu structurally cannot reach the
 * irreversible write. A menu opens by accident; it must not be one press from deleting minutes
 * of work.
 */
import {
  BookOpen,
  Copy,
  FolderInput,
  Pencil,
  Plus,
  SlidersHorizontal,
  Tag,
  TagPlus,
  TagX,
  Trash2,
} from "lucide-react";
import type { MenuItem } from "@/components/menu/types";
import type { DeckRow } from "@/lib/ipc";
import { suggestTags, withTag, withoutTag, type TagInUse } from "./deckTags";
import { moveToFolderContent } from "./folderMenu";

/** Everything the deck menu does that is not the deck. Built once per surface, not per tile. */
export interface DeckMenuDeps {
  /** `useAppStore`'s own action, passed through — opening a deck is a navigation. */
  setOpenDeckId: (deckId: number) => void;
  /**
   * Open the tile's inline rename field.
   *
   * The whole deck rather than its id, because the field opens on the name the tile is showing
   * and the confirmation-shaped callbacks below take the row too.
   */
  startRename: (deck: DeckRow) => void;
  /**
   * Open `DeckSettingsDialog` over the gallery, on this deck.
   *
   * `"tags"` puts the caret in its Tags field — **Add tag → New tag…**, the one way from this menu
   * to a tag no deck wears yet. A menu has no box to type a word into (`ContextMenu` yields keys
   * to a field but no shipped panel draws one), and the settings field already has the
   * suggestions, the held list and the half-typed-word rule.
   */
  openSettings: (deckId: number, focus?: "tags") => void;
  /**
   * Every tag some deck in the gallery wears — `deckTags.ts`' `tagsInUse` over the `deck_list`
   * the wall already holds, so **Add tag** costs no read. The deck's own tags are taken out here,
   * not by the host.
   */
  tagsInUse: readonly TagInUse[];
  /**
   * `deck_update({ tags })` with the whole new list — `[]` clears. A tag write never sends one
   * tag, which is `DeckSettingsDialog`'s rule too.
   */
  setTags: (deckId: number, tags: string[]) => void;
  /**
   * `deck_set_folder`, where `null` is the top level.
   *
   * **Not a `DeckPatch`**: `folderId` is written `coalesce(?n, folder_id)`, so a `null` patch
   * reads as *leave it alone* and "Move to → All decks" would be a row that reports success and
   * does nothing.
   */
  moveToFolder: (deckId: number, folderId: number | null) => void;
  duplicate: (deckId: number) => void;
  /** The confirmation the tile already asks — never `decks.remove`. See this file's doc. */
  askDelete: (deck: DeckRow) => void;
}

/**
 * **Add tag** and **Remove tag** (issue #914): the deck's own tags, without opening anything.
 *
 * * **Add tag** offers the tags other decks wear and this one does not, in `tagsInUse`' order —
 *   the commonest act is tagging a second deck with a word already used on a first, which is the
 *   same argument `DeckTagsField` makes for opening its list before a key is pressed. Under a
 *   rule, **New tag…** opens Deck settings with the caret in the Tags field.
 * * **Remove tag** offers the tags this deck wears, in the deck's own order. A deck with none
 *   draws the row greyed rather than leaving it out, so the menu keeps one shape from tile to
 *   tile and the reader can read that removing is possible here.
 *
 * **Both are `submenu`, not `lazy`**: every row is in hand when the menu is built — the deck row
 * and the wall's own `deck_list` — so there is nothing to fetch on expand.
 *
 * **Each list is built on the row the tile was drawn from**, which is what the wall is showing.
 * A tag write invalidates `["decks"]` and the wall re-reads long before a second right-click, so
 * unlike the settings field — where two tags can be typed inside one round trip — there is no
 * held list here to build the next press on.
 */
function tagItems(deck: DeckRow, deps: DeckMenuDeps): MenuItem[] {
  const offers = suggestTags(deps.tagsInUse, deck.tags, "").flatMap((offer, index): MenuItem[] => {
    const next = withTag(deck.tags, offer.tag);
    // `suggestTags` already left out what the deck wears, so this is a fence rather than a
    // branch: a row that wrote the same list back would be a `deck_update` that changes nothing
    // and bumps `updated_at`.
    if (next === null) return [];
    return [
      {
        kind: "action",
        id: `add-tag-${index}`,
        label: offer.tag,
        Icon: Tag,
        onSelect: () => deps.setTags(deck.id, next),
      },
    ];
  });
  const add: MenuItem = {
    kind: "submenu",
    id: "add-tag",
    label: "Add tag",
    Icon: TagPlus,
    items: [
      ...offers,
      // The line between putting a tag on and typing one — the label menu's arrangement: above
      // it a press is the write, below it the menu closes and a dialog opens.
      ...(offers.length > 0 ? [{ kind: "separator", id: "before-new-tag" } as const] : []),
      {
        kind: "action",
        id: "new-tag",
        label: "New tag…",
        Icon: Plus,
        onSelect: () => deps.openSettings(deck.id, "tags"),
      },
    ],
  };
  const remove: MenuItem =
    deck.tags.length === 0
      ? {
          kind: "action",
          id: "remove-tag",
          label: "Remove tag",
          Icon: TagX,
          disabled: true,
          onSelect: () => {},
        }
      : {
          kind: "submenu",
          id: "remove-tag",
          label: "Remove tag",
          Icon: TagX,
          // By index rather than by spelling: Rust never stores a repeat, but a peer's row could
          // carry one, and an id is unique within one level or the caret loses its place.
          items: deck.tags.map((tag, index): MenuItem => ({
            kind: "action",
            id: `remove-tag-${index}`,
            label: tag,
            Icon: Tag,
            onSelect: () => deps.setTags(deck.id, withoutTag(deck.tags, tag)),
          })),
        };
  return [add, remove];
}

/** The six rows of §5, in the order the spec draws them, and the two tag rows of issue #914
 *  between filing the deck and its settings. */
export function buildDeckMenu(deck: DeckRow, deps: DeckMenuDeps): MenuItem[] {
  return [
    {
      kind: "action",
      id: "open",
      label: "Open deck",
      Icon: BookOpen,
      onSelect: () => deps.setOpenDeckId(deck.id),
    },
    { kind: "separator", id: "after-open" },
    {
      kind: "action",
      id: "rename",
      label: "Rename…",
      Icon: Pencil,
      onSelect: () => deps.startRename(deck),
    },
    {
      // **`lazy`, so a right-click costs no read.** The folder list is asked for when the row is
      // expanded and never when the menu opens — the same `useDeckFolders` the gallery already
      // has mounted, so by then the answer is usually in the cache and the row draws at once.
      // `moveToFolderContent` is the folder menu's too: one destination list, one fence, one
      // look.
      kind: "lazy",
      id: "move",
      label: "Move to",
      Icon: FolderInput,
      Content: moveToFolderContent({
        currentId: deck.folderId,
        // A deck cannot contain a folder, so nothing is forbidden to it: the only inert row is
        // the folder it is already in.
        moving: null,
        onPick: (folderId) => deps.moveToFolder(deck.id, folderId),
      }),
    },
    ...tagItems(deck, deps),
    {
      kind: "action",
      id: "settings",
      label: "Deck settings…",
      Icon: SlidersHorizontal,
      onSelect: () => deps.openSettings(deck.id),
    },
    { kind: "separator", id: "before-writes" },
    {
      kind: "action",
      id: "duplicate",
      label: "Duplicate",
      Icon: Copy,
      onSelect: () => deps.duplicate(deck.id),
    },
    {
      kind: "action",
      id: "delete",
      label: "Delete…",
      Icon: Trash2,
      onSelect: () => deps.askDelete(deck),
    },
  ];
}
