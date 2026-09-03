import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { useMutation, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { FolderInput, Lock, LockOpen, Pencil, Trash2 } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { Dialog } from "@/components/Dialog";
import type { MenuItem } from "@/components/menu/types";
import { useContextMenu } from "@/components/menu/useContextMenu";
import { NewFolderCard } from "@/components/NewFolderCard";
import { OwnedBadge } from "@/components/OwnedBadge";
import { QuantityStepper } from "@/components/QuantityStepper";
import { buildCardMenu, type CardMenuDeps, type CardMenuTarget } from "@/features/card/cardMenu";
import { CardMenuRefusal } from "@/features/card/CardMenuRefusal";
import { listWalkStops, usePublishCardWalk } from "@/features/card/cardWalk";
import { useCardMenuDeps } from "@/features/card/useCardMenuDeps";
import { dragData } from "@/features/decks/dnd";
import { CONFIRM_CANCEL, CONFIRM_DESTRUCTIVE, useConfirmFocus } from "@/features/decks/metaRows";
import { MoveToFolder } from "@/features/decks/MoveToFolder";
import { CardGrid, PHONE_TILE_WIDTH, type GridCard } from "@/features/search/CardGrid";
import { FilterBar, type FilterLabels, type TrayCell } from "@/features/search/FilterBar";
import { ExportDialog } from "@/features/transfer/export/ExportDialog";
import { everythingLabel, scopeLabel, useExportScope } from "@/features/transfer/export/scope";
import { collectionDestination } from "@/features/transfer/import/destinations/CollectionPreview";
import { ImportExportPair } from "@/features/transfer/ImportExportPair";
import { ImportDialog } from "@/features/transfer/import/ImportDialog";
import { WishFolderCaption } from "@/features/wishlist/wishMarks";
import { CONDITION_LABEL, CONDITIONS } from "@/lib/conditions";
import { DROP_MARK_ROOM } from "@/lib/dropMarks";
import type { FolderDrag, FolderEdge } from "@/lib/folderDrag";
import { reorderedLevel } from "@/lib/folderOrder";
import { FINISHES, FINISH_LABEL, finishLabel, isFinish, type Finish } from "@/lib/finish";
import { FOCUS } from "@/lib/focus";
import {
  buildFolderTree,
  folderDescendants,
  folderLevel,
  lockedFolderIds,
  type FolderNode,
} from "@/lib/folderTree";
import {
  ipc,
  ipcError,
  type CollectionFolder,
  type CollectionPage as Page,
  type CollectionRow,
} from "@/lib/ipc";
import { statusLine } from "@/lib/motion";
import { formatPrice, pricesAsOf } from "@/lib/prices";
import { useAppStore } from "@/lib/store";
import { tileKeyOf } from "@/lib/tileKey";
import { useDismissOnEscape } from "@/lib/useDismissOnEscape";
import { useNarrowWindow } from "@/lib/useNarrowWindow";
import { cn } from "@/lib/utils";
import { writeFailure } from "@/lib/writes";
import { CollectionBreadcrumb } from "./CollectionBreadcrumb";
import {
  CollectionFolderCard,
  CollectionParentFolderCard,
  type CollectionFolderTotals,
} from "./CollectionFolderCard";
import { CollectionSummaryHeader } from "./CollectionSummary";
import { CollectionTable } from "./CollectionTable";
import {
  collectionTileDragData,
  type CollectionCopy,
  type CollectionDrop,
} from "./collectionDrag";
import { PickCopies, type CopyChoice } from "./PickCopies";
import { PinnedFolders, pinnedFolders } from "./PinnedFolders";
import { useCollection, type Collection } from "./useCollection";
import { useCollectionFolders, useSetCollectionFolder } from "./useCollectionFolders";

/**
 * What the top of the cabinet is called, in the two places this page has to say it —
 * `MoveToFolder`'s top row, and the sentence a new folder's field prints about where it will land.
 *
 * `CollectionBreadcrumb` spells its own copy of this word, because a breadcrumb that had to be
 * told what its own first segment is called would be a component that does not know what it is
 * drawing. `MoveToFolder` defaults to the deck gallery's "All decks", which is the wrong sentence
 * to show a reader filing a copy they own.
 */
const ROOT_LABEL = "Collection";

/**
 * The root as `reorderedLevel` has to address it — an id no folder has, because
 * `collection_folders.id` is an `INTEGER PRIMARY KEY` and therefore always positive.
 *
 * Only the **up** tile needs it, and only to satisfy an argument it does not use: an `inside`
 * landing reads `target` for one thing, the "dropped on itself" refusal, and a folder can never
 * be dropped on the root. The alternative is widening `reorderedLevel`'s `target` to
 * `number | null`, which would put a case in the shared arithmetic that only one caller has.
 * `DecksPage` and `WishlistPage` spell the same constant for the same reason.
 */
const ROOT_TARGET = 0;

/**
 * The one dismissible layer this page can have open — the union, and never four flags.
 *
 * `DecksPage`'s `Panel` states the argument in full and it holds here for the same cabinet: a
 * half-typed folder name beside a half-answered delete question is not a state this view draws,
 * and separate booleans can express it. One value is also one Escape rung, which is the whole of
 * what {@link useDismissOnEscape} has to order.
 *
 * **No id lives in here that is not read.** `deleteFolder` carries its folder because — unlike
 * the gallery's, which asks about the folder the reader is *standing in* — this question is always
 * asked about a folder **card**, one level down from where the reader is, and there is nothing
 * else on the page holding which one.
 */
type Panel =
  | { kind: "newFolder"; parentId: number | null }
  | { kind: "renameFolder"; folderId: number }
  | { kind: "moveFolder"; folderId: number }
  | { kind: "deleteFolder"; folderId: number }
  | null;

/**
 * A drag that would carry a copy across the edge of a drawer the reader has set aside — issue
 * #365, design §5 — held for as long as the question about it is on screen.
 *
 * **The drop and its destination, verbatim**, because the answer *replays the gesture*: `Move it`
 * hands both straight back to {@link CollectionPage.fileCard}, which is where a tile standing for
 * several rows still turns into the copy picker. Nothing here is a partial write waiting to be
 * finished; the gesture simply has not happened yet.
 *
 * **`out` and `into` are the locked *drawers*, by name, and either can be `null`** — a copy going
 * into a locked binder is leaving nothing, and one coming out of it is arriving nowhere set aside.
 * Both are the **outermost** locked ancestor rather than the folder the pointer is over, which is
 * what makes the sentence true for a sub-folder: dropped into `Trade binder / Foils`, the drawer
 * that is set aside is `Trade binder`, and naming `Foils` would leave the reader looking for a
 * lock on a card whose badge they were told is inherited.
 */
interface LockedMove {
  drop: CollectionDrop;
  to: number | null;
  card: string;
  /** The set-aside drawer the copy is leaving, or `null` when it is not leaving one. */
  out: string | null;
  /** The set-aside drawer it would land in, or `null` when it is not landing in one. */
  into: string | null;
}

/**
 * A folder the summary has no row for.
 *
 * **Not a defensive default — the ordinary answer for an empty folder.**
 * `collection_folder_summary` is a `GROUP BY` over `collection_entries`, so a folder holding
 * nothing emits no row at all, and a card fed a raw `Map.get` would render `undefined` figures
 * over exactly the drawer whose whole job on this screen is to be empty. `0 cards` is the honest
 * face of an empty drawer, and an empty drawer is where the next card goes.
 *
 * **It is the answer for a folder the summary skipped, and never for a summary that has not
 * answered yet.** The two are one `Map.get` miss apart and mean opposite things — see the
 * `summaryQuery.isPending` branch at the wall below, which is what keeps them apart.
 *
 * `value` is `null` rather than `0` for `formatPrice`'s reason and the backend's own: `$0.00` is a
 * price nobody quoted.
 */
const NO_CARDS: CollectionFolderTotals = { cards: 0, value: null };

/**
 * The trail from the root down to the folder the reader is standing in — **without the root**,
 * which the breadcrumb prepends itself because `null` is a destination rather than a folder.
 *
 * Walked up through `parentId` and then reversed, because that is the only direction the flat rows
 * can be read in. Two shapes of broken input are resolved rather than trusted, and both resolve
 * **towards the root**: a `parentId` naming a folder this list does not carry — one another
 * surface deleted between the two reads — ends the walk there, so the folder draws as though it
 * sat at the top level; and a cycle, which the backend refuses outright and which only corruption
 * could produce, terminates on the visited set. That is `buildFolderTree`'s own rule applied to
 * the other half of the tree, and it is the rule because the alternative strands the reader inside
 * a folder with no way back out.
 *
 * A `folderId` naming nothing at all answers the empty trail, which is the same rule seen from the
 * bottom — the reader reads as standing at the root, which is where the cards of a deleted folder
 * have just gone.
 */
function trailOf(
  folders: readonly CollectionFolder[],
  folderId: number | null,
): readonly CollectionFolder[] {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const trail: CollectionFolder[] = [];
  const seen = new Set<number>();
  let at = folderId;
  while (at !== null && !seen.has(at)) {
    seen.add(at);
    const folder = byId.get(at);
    if (folder === undefined) break;
    trail.unshift(folder);
    at = folder.parentId;
  }
  return trail;
}

/**
 * Every folder's numbers **with its sub-folders' added in**, indexed by folder id.
 *
 * `collection_folder_summary` answers *direct* counts — this folder's own copies, never the ones
 * nested under it — and says so at its own type, because SQL that walked the tree would be a
 * second implementation of the arithmetic `buildFolderTree` already does for `FolderNode.count`.
 * This is that arithmetic over the two fields: a folder card handed a raw lookup would draw
 * `0 cards` over a drawer holding twelve in two sub-folders, and the reader would only catch it by
 * opening the drawer.
 *
 * **A `null` value stays `null` all the way up, and only until something under it is priced.** The
 * backend answers `None` for a folder the marketplace could price nothing in, and a sub-tree in
 * which *nothing* is priced has to say the same thing rather than `$0.00` — but a drawer holding
 * one priced card and one unpriced one is worth what the priced one is worth. So a child's `null`
 * contributes nothing and a child's number lifts the parent out of `null`, which is exactly how
 * `sum()` treats a `NULL` one statement lower down.
 *
 * The whole tree in one pass rather than a sum per card, because a node's total is its children's
 * totals and a per-card recursion would recompute every level of the cabinet once per level.
 */
function subtotalsOf(
  nodes: readonly FolderNode<CollectionFolder>[],
  direct: ReadonlyMap<number, CollectionFolderTotals>,
): ReadonlyMap<number, CollectionFolderTotals> {
  const out = new Map<number, CollectionFolderTotals>();
  const visit = (node: FolderNode<CollectionFolder>): CollectionFolderTotals => {
    const own = direct.get(node.folder.id) ?? NO_CARDS;
    let cards = own.cards;
    let value = own.value;
    for (const child of node.children) {
      const under = visit(child);
      cards += under.cards;
      if (under.value !== null) value = (value ?? 0) + under.value;
    }
    const total = { cards, value };
    out.set(node.folder.id, total);
    return total;
  };
  for (const node of nodes) visit(node);
  return out;
}

/** One tile of the wall: a printing **in one finish**, and how many copies of it the collection
 *  holds. */
interface CollectionTile extends GridCard {
  /**
   * This tile's identity — `` `${cardId}:${finish}` ``, which is **not** the card's id.
   *
   * A foil and a played nonfoil of one printing are two tiles carrying one `id`, so the wall's
   * ring, its arrow walk and its picked set all key on this instead. See `CardGrid`'s
   * `GridCard.key`.
   */
  key: string;
  /** How many copies of this printing **in this finish** the collection holds, across every
   *  grade, language and folder — what `OwnedBadge` draws over the art. */
  copies: number;
  /**
   * The finish to mark the art with — the tile's own, since the finish is part of what makes two
   * tiles two.
   *
   * **`null` is a word this build cannot name and nothing else.** `collection_entries.finish` is
   * TEXT with a CHECK rather than an enum this side knows, so a row can arrive spelling something
   * `FINISHES` has never heard of; that marks the art with nothing rather than with a sheen no
   * stylesheet has. It is no longer "the copies behind this tile disagree" — grouping on the
   * finish is what removed that question, and every tile is one finish now.
   */
  finish: Finish | null;
  /**
   * What one copy of this printing, in **this** finish, costs at the marketplace the query named.
   *
   * Taken off the group's first row rather than reduced across them: every row in a group now
   * names the same printing *and* the same finish, so they all carry the same figure and picking
   * the first is not a choice between two answers. `null` is unpriced there, and it is never
   * filled in from another marketplace or another finish.
   */
  unitPrice: number | null;
  /** Carried for the right-click menu alone — nothing on the wall draws it. A menu add is
   *  filed by what the card *does*, exactly as a drag of the same card is. */
  typeLine: string | null;
  /** Also the menu's alone: which oracle card this is, so "View all printings" can reach it.
   *  `null` where the entries behind this tile are orphans. */
  oracleId: string | null;
  /**
   * The finishes the reader's own entries for this printing are in, as the JSON list
   * `CardMenuTarget.finishes` takes.
   *
   * **Not the finishes the printing exists in** — a collection row does not carry those — and
   * that difference is the point rather than a compromise. The tile sums entries, so it knows
   * exactly which finishes are behind the art in front of the reader — and since the finish
   * joined the grain that is **at most one**, so the menu records it without asking.
   *
   * **The empty list is the case worth warning about, and exactly one thing produces it**: a row
   * spelling a finish word `FINISHES` cannot name, which {@link ownedFinishes} drops rather than
   * pass on to the backend. A tile left saying nothing here falls to the menu's unknown-list rule
   * and silently records a **nonfoil** copy — the same shape of failure the whole finish rule
   * exists to prevent, arrived at from the one direction the rule cannot close. It is 0 live rows,
   * and it is written down because the `CHECK` on `collection_entries.finish` is the only thing
   * holding it there.
   *
   * (That warning was illustrated with "a reader who owns two foils and no nonfoil" until
   * 2026-08-26. The example was false and pre-dated the split: such a reader has always got
   * `["foil"]` out of {@link ownedFinishes} and a foil entry recorded. The warning was right; the
   * story attached to it was not.)
   *
   * The narrowing itself — `FINISHES` order, unrecognised words dropped — belongs to
   * {@link ownedFinishes} and is argued there rather than twice.
   */
  finishes: string;
  /**
   * Which folders the copies behind this tile are filed in — every distinct one, `null` for the
   * root, in the order the rows arrived.
   *
   * **A list rather than a folder, because a tile is a printing-and-a-finish and a filing is a
   * row.** The wall merges every entry for one object, and since v24 the folder is part of what
   * makes two rows two rows — so while the list is flattened one tile can perfectly well stand
   * for copies in a binder, in a deck's group and at the root at once. Naming the first of them
   * would be the app picking which copy the reader meant, which is exactly what {@link tileTarget}
   * refuses to do about `entryId` one function down.
   *
   * **The finish splits a tile and the folder deliberately does not**, which is the one asymmetry
   * worth stating here: a foil and a played nonfoil are two objects at two prices, where the same
   * copies in two drawers are one object seen from two places, and the table below the wall is
   * where a reader gets those apart.
   *
   * Ids and not names, so this stays pure over `rows` and the tile can be built without the folder
   * census: {@link filedIn} is where the words are chosen, at render, from the page's own map.
   */
  folders: readonly (number | null)[];
}

/**
 * The finish this tile is **marked** with — the tile's own word, with `nonfoil` mapped to nothing.
 *
 * **`nonfoil` is not a mark, and that is a rule with a shipped failure behind it.** `CardArt` gates
 * its whole top-right chip on `finish !== null` while `FinishMark` early-returns for a plain copy,
 * so handing the word straight through paints the `bg-bg/85` felt with nothing inside it — an
 * empty rectangle over the art, on most tiles of most collections. `soleFinish` maps it to `null`
 * and `DeckFinish` excludes it outright; this is that convention on the one wall whose rows can
 * actually carry the word.
 *
 * **It is a function rather than an expression written twice because two things read it now**: the
 * chip over the art, and the accessible name of the stepper drawn in the same corner of the same
 * tile. A tile that drew no sheen while its stepper announced "(Nonfoil)" would be one fact
 * answered two ways six pixels apart — the class of drift this file already fixed once for the
 * chip itself. Module scope so `CardGrid`'s `finish` slot can be handed it directly rather than a
 * fresh arrow per render, which is what that prop asks for.
 *
 * A `null` `tile.finish` is a word this build cannot name (see {@link CollectionTile.finish}) and
 * stays `null` here: marking the art with a sheen no stylesheet has, or announcing a word the
 * reader's own row spells and this build does not, are the same mistake.
 */
function finishMarkOf(tile: CollectionTile): Finish | null {
  return tile.finish === "nonfoil" ? null : tile.finish;
}

/**
 * What a flattened tile's caption says about where its copies are — the words, or nothing.
 *
 * One folder is that folder's name (`Collection` at the root, which is `folderNameOf`'s own word
 * for `null`). Two or more is a **count**, because there is no honest single name for a printing
 * the reader keeps in three places, and the alternative — naming one of them — is the caption
 * quietly claiming the other copies are somewhere they are not. `Filed in 2 folders` is the whole
 * sentence a reader gets on the wall, and the table beside it is drawn at the row grain, where
 * every copy names its own drawer.
 *
 * `null` draws nothing, which is {@link WishFolderCaption}'s own rule and the honest answer for a
 * drawer another window deleted between the entry read and the folder read.
 */
function filedIn(
  tile: CollectionTile,
  folderNameOf: (id: number | null) => string | null,
): string | null {
  if (tile.folders.length === 0) return null;
  if (tile.folders.length === 1) return folderNameOf(tile.folders[0]);
  return `${tile.folders.length} folders`;
}

/**
 * The caption a **flattened** wall draws: the printing, and the drawer its copies sit in.
 *
 * Built for that state and handed to `CardGrid` only there — unflattened the slot is left unset, so
 * the wall draws its own `SET · number` and this file does not spell it at all. Flattened, the
 * folder is the only way a reader sees where a copy is without opening it, which is the whole of
 * what Flatten promises and exactly why `WishlistGrid` captions its own tiles the same way.
 *
 * **{@link WishFolderCaption} is reused across the feature boundary rather than twinned**, and its
 * name is the only thing about it that is the wishlist's: it takes a folder name and draws a glyph,
 * a truncating word and a `Filed in …` tooltip, scaling on `var(--mark-scale)` like every other
 * mark drawn on a card. A local copy would be one fact rendered twice — two glyphs, two shades,
 * two sentences, none of it decided — which is the drift `wishMarks.tsx`'s own header exists to
 * prevent; and this app already imports the other way, `WishlistGrid` drawing the collection's
 * `REVEAL_ON_HOVER`.
 *
 * **The line must stay one line.** `CardGrid` positions its virtual rows from `CAPTION_HEIGHT`,
 * which is a *budget* rather than a minimum, so a caption that wrapped would be a wall whose rows
 * overlap by the difference. Hence the printing truncates and the mark is `shrink-0` beside it —
 * `WishlistGrid`'s arrangement, for its reason: at 170px a drawer the reader named is worth more
 * than the last few characters of a set code.
 *
 * A closure over the page's one answer rather than module scope, which costs nothing here:
 * `caption` is read on **render** rather than registered, unlike `dragRecord`/`tileRef` and the
 * three card-fact slots `CardGrid` asks to be held still.
 */
const captionFor =
  (folderNameOf: (folderId: number | null) => string | null) => (tile: CollectionTile) => (
    <span className="flex min-w-0 items-center gap-[calc(0.375rem*var(--mark-scale,1))]">
      {/* `CardGrid`'s own default text, restated because the slot is the whole of that line and
          there is nothing to append to — see the component's `caption`, which is the *text* and
          not the strip around it. */}
      <span className="min-w-0 truncate">
        {`${tile.setCode.toUpperCase()} · ${tile.collectorNumber}`}
      </span>
      <WishFolderCaption name={filedIn(tile, folderNameOf)} />
    </span>
  );

/**
 * The entries' finishes for one printing, in the app's own order, as stored JSON.
 *
 * `FINISHES` order (nonfoil, foil, etched) rather than the order the rows arrived in: it is
 * Scryfall's, it is what every finish picker in this app reads in, and a submenu whose two rows
 * swapped places depending on which entry the backend sorted first would be a picker that moves
 * under the pointer. Unrecognised words are dropped — `finish` is TEXT with a CHECK rather than
 * an enum this side knows — and a tile left with nothing falls to the menu's unknown-list rule,
 * which is the honest answer for an entry whose finish this build cannot name.
 *
 * Every entry counts, including one emptied to zero: the wall draws a tile for it, the table
 * keeps the row with its condition and its purchase story, and it is still a finish the reader
 * has recorded holding this printing in.
 *
 * **The set handed in is now at most a singleton, and that is what makes this function worth
 * keeping rather than what makes it redundant.** The finish joined the wall's grain on
 * 2026-08-26, so a tile merges one finish by construction and this answers one entry wherever the
 * word is one `FINISHES` knows — and the empty list for the unrecognised one the paragraph above
 * is about. One is exactly the answer the menu wants: `buildCardMenu` records a single-finish
 * list without asking, so a reader who owns two foils and no nonfoil gets a **foil** entry.
 *
 * The old two-element answer was the honest thing to say about a tile that merged two objects,
 * and the fix was to stop merging them. What survives here is the narrowing — `FINISHES` order,
 * unrecognised words dropped — which a raw `JSON.stringify([row.finish])` would throw away.
 * `CollectionTile.finishes` defers to this function for that rule rather than restating it, and
 * carries the one thing that is the *field's* business: what an empty list costs at the menu.
 */
function ownedFinishes(seen: ReadonlySet<string>): string {
  return JSON.stringify(FINISHES.filter((finish) => seen.has(finish)));
}

/**
 * The card a right-click on an **entry** is about.
 *
 * **A collection row is a finish** — it is one of the ten columns the row's identity is made
 * of — so the menu names it rather than asking. The `isFinish` guard is not ceremony:
 * `collection_entries.finish` is TEXT with a CHECK rather than an enum this side knows, so a
 * row can spell something this build has never heard of, and an unrecognised word must not
 * arrive at the backend as a finish.
 *
 * **`oracleId` travels straight through, with no fallback**, and that is what makes the menu's
 * one greyed row honest here. It comes off the same `LEFT JOIN` as `name` and `rarity`, so a
 * `null` means the entry's printing has left the corpus — 0 of 116 590 live rows have a null
 * `oracle_id` — which is exactly what "View all printings" says when it greys itself out. Every
 * healthy row gets a live item. (This adapter passed a hardcoded `null` until
 * `CollectionRow.oracleId` landed, which greyed the row on the reader's whole collection and
 * gave a true sentence about a card that was fine.)
 *
 * `finishes` is `null` because a collection row genuinely has no such list: it says which finish
 * the reader *holds*, never which ones the printing exists in. The wall's tile can do better —
 * see {@link tileTarget}.
 *
 * **`entryId` is what unlocks `Move to → folder`, and it is the one field only this adapter can
 * fill.** The menu offers that row where — and only where — the target names a row of
 * `collection_entries`, because moving a copy between drawers is `collection_set_folder(id, …)`
 * and there is nothing else to address it by. A right-click on a *tile* or on a search result is
 * about a card the reader may not own at all, so {@link tileTarget} deliberately leaves it out
 * rather than inventing one from the entries behind the art — a tile merges every entry for that
 * printing **in that finish**, across grades, languages and folders, and picking one of them to
 * move would be the app choosing which copy the reader meant.
 */
function rowTarget(row: CollectionRow): CardMenuTarget {
  return {
    cardId: row.cardId,
    entryId: row.id,
    // An orphaned entry has no name — `cards` does not know this printing any more — and the
    // set and number beside it are the entry's own columns, copied at write time for exactly
    // this. The same fallback the wall's tiles use.
    name: row.name ?? `${row.setCode.toUpperCase()} ${row.collectorNumber}`,
    setCode: row.setCode,
    collectorNumber: row.collectorNumber,
    oracleId: row.oracleId,
    finishes: null,
    finish: isFinish(row.finish) ? row.finish : undefined,
    typeLine: row.typeLine,
  };
}

/**
 * The card a right-click on a **tile** is about.
 *
 * Where {@link rowTarget} *names* a finish, this one offers a **list** — and since the finish
 * joined the wall's grain that list holds exactly one entry, so the two are now the same rule
 * arriving at the same answer by different roads: a row is one entry and therefore one finish,
 * and a tile merges only the entries that agree about their finish. So the tile hands over the
 * finishes its own entries are in ({@link ownedFinishes}) and the menu records that one without
 * asking, through the very same component the search wall uses.
 *
 * The list is the reader's *holdings* rather than the printing's catalogue, which is the only
 * honest list a collection row can produce and is also the better one here — an add from this
 * wall is a copy of something already in the binder.
 */
/**
 * A stored grade as the app spells it, or the raw column where it is not one of the five.
 *
 * **A loop rather than a cast**, which is the only way to narrow a `string` onto
 * `CONDITION_LABEL`'s keys without asserting something the column does not guarantee: the
 * database holds text, and a row written by an import or by an older build may carry a word this
 * build has never heard of. `lib/finish.ts` publishes an `isFinish` guard for its own column and
 * `lib/conditions.ts` publishes none, so the narrowing is done here rather than by widening that
 * module for one caller.
 */
function conditionLabel(raw: string): string {
  for (const condition of CONDITIONS) if (condition === raw) return CONDITION_LABEL[condition];
  return raw;
}

function tileTarget(tile: CollectionTile, entryIds: readonly number[] = []): CardMenuTarget {
  return {
    cardId: tile.id,
    // **The rows behind the art, where a table row names its one `entryId`.** This is what
    // unlocks `Move to` on a wall tile, and it is a *list* rather than a chosen id for the
    // reason the paragraph above gives: picking one of them would be the app deciding which
    // copy the reader meant. `moveItem` asks which when there is more than one.
    entryIds,
    name: tile.name,
    setCode: tile.setCode,
    collectorNumber: tile.collectorNumber,
    oracleId: tile.oracleId,
    finishes: tile.finishes,
    typeLine: tile.typeLine,
  };
}

/**
 * The collection: what it adds up to, what is in it, and the quantities editable in place.
 *
 * The aggregate header is the one composition this view adds to the app, and it is data —
 * so it is the mono face, unemphasised, with no colour and no chrome. Everything loud on
 * this screen is card art, exactly as it is in search.
 */
/**
 * What this surface calls its search box, and the `id` stem its labels bind through.
 *
 * **`Search your collection` and never the search page's `Search cards`**, which is `FilterLabels`'
 * whole reason: this box narrows the reader's own binder and that one narrows every printing
 * Scryfall has published, so one name over both would be the control lying about which list it is
 * over — and a `getByLabelText` could not tell the two apart.
 */
const COLLECTION_LABELS: FilterLabels = {
  idStem: "collection",
  search: "Search your collection",
};

/**
 * Which of `FilterBar`'s tray cells this page offers, in the order it draws them.
 *
 * The four the card search shares, then the three only a collection can ask: what the copy *is*,
 * what state it is in, and whether a sync left a question against it. The absences are each a fact
 * about the list rather than an omission — there is no **Owned** pair because every row here is a
 * copy the reader has, no **All printings** because these *are* their printings, and no **Decks**
 * because that cell is the deck editor's Collection tab and asks about one deck.
 */
const COLLECTION_TRAY: readonly TrayCell[] = [
  "set",
  "format",
  "rarity",
  "price",
  "finish",
  "condition",
  "needsReview",
];

export function CollectionPage() {
  const collection = useCollection();
  const { query, summary, rows, total, marketplace, folderId, flatten } = collection;
  const view = useAppStore((s) => s.collectionView);
  const selectedCardId = useAppStore((s) => s.selectedCardId);
  // What the wall below is sized by — see its `baseTileWidth`. A consumer of the app's one
  // viewport branch rather than a second one; the hook argues for itself at its own site.
  const narrowWindow = useNarrowWindow();
  /**
   * The wall's own opener, and the finish it last opened the pane as.
   *
   * **Not `setSelectedCardId`**, which is every other surface's and clears `paneFinish` in the
   * same write: a tile here is a printing *and* a finish, so a press has something to say that
   * the plain opener structurally cannot carry. The pane seeds its foil view from it — there is
   * no foil photograph to fetch, so what it turns on is `FoilOverlay` over the same picture.
   *
   * **This page holds no other opener, and that is a deletion rather than an omission.**
   * `setSelectedCardId` was read here for the wall's `onSelect` and for nothing else — the table
   * beside it opens no card, its rows offering a stepper, a removal and a menu — so leaving the
   * plain opener in scope would be a second way to open a card from this page that nothing
   * presses and that would silently drop the finish if anything ever did.
   */
  const openCardAsFinish = useAppStore((s) => s.openCardAsFinish);
  const paneFinish = useAppStore((s) => s.paneFinish);
  const queryClient = useQueryClient();
  const folders = useCollectionFolders();

  /**
   * Which folder layer is open, and what the caret goes back to when it closes.
   *
   * **The opener is a ref rather than a piece of `Panel`** for the reason `DecksPage` gives: the
   * three triggers here are all tiles of one wall — the `New folder` card, and for the other two
   * whichever folder card's `⋯` a reader happened to press — so capturing the element when the
   * layer opens is the only way one handler can serve a wall of them.
   */
  const [panel, setPanel] = useState<Panel>(null);
  const openerRef = useRef<HTMLElement | null>(null);

  /**
   * The export dialog, and the sweep that fills it — see `scope.ts`'s doc for why the sweep
   * exists at all rather than exporting the page already in memory.
   *
   * `useExportScope` runs on every render, `enabled` or not: `ExportDialog` is mounted
   * unconditionally below (the same shape `DeckEditor`'s is), so that closing it fades the
   * shell out instead of yanking it out of the tree — and that means this hook has to be
   * called every render too, `enabled: exporting` is what stops it from sweeping the whole
   * collection on every filter keystroke nobody asked to export.
   */
  const [exporting, setExporting] = useState(false);
  const exportScope = useExportScope("collection", collection.filters, exporting);

  /** The import dialog. One destination, so no radio group is drawn — a choice between one
   *  thing is not a choice. */
  const [importing, setImporting] = useState(false);

  /**
   * Rewrite one entry wherever the collection is cached.
   *
   * Every cached filter combination, not just the one on screen: the same row is in the
   * "everything" list and in the "foils only" list, and a stepper press that fixed one and
   * left the other would show two different numbers for one card one filter click apart.
   */
  const patchEntry = useCallback(
    (id: number, next: ((row: CollectionRow) => CollectionRow) | null) => {
      queryClient.setQueriesData<InfiniteData<Page>>(
        { queryKey: ["collection", "list"] },
        (data) => {
          if (!data || !data.pages.some((p) => p.items.some((r) => r.id === id))) return data;
          return {
            ...data,
            pages: data.pages.map((page) =>
              next === null
                ? {
                    items: page.items.filter((r) => r.id !== id),
                    // Every page carries the same count of the whole list, so every page's
                    // copy of it moves — otherwise the header the *first* page feeds would go
                    // on counting a row that is gone.
                    total: Math.max(0, page.total - 1),
                  }
                : { ...page, items: page.items.map((r) => (r.id === id ? next(r) : r)) },
            ),
          };
        },
      );
    },
    [queryClient],
  );

  /** Undo, for a write the backend refused. */
  const snapshot = useCallback(
    () => queryClient.getQueriesData<InfiniteData<Page>>({ queryKey: ["collection", "list"] }),
    [queryClient],
  );
  const restore = useCallback(
    (saved: ReturnType<typeof snapshot>) => {
      for (const [key, data] of saved) queryClient.setQueryData(key, data);
    },
    [queryClient],
  );

  /**
   * What every write here has in common: the header re-fetches, the search is marked stale,
   * and the list is *not* re-fetched — the row's own number has already been rewritten from
   * the answer, and re-reading a hundred rows because one of them changed by one is a round
   * trip nobody is waiting for. A wrong total, though, is a worse lie than a slow one.
   */
  const settle = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["collection", "summary"] });
    // And the folder subtotals, for the header's own reason one level down: `cards` is
    // `sum(quantity)` and `value` is `sum(quantity * unit_price)`, so a stepper press on a filed
    // row moves the card above it by exactly the amount it moved the header. This is the wishlist's
    // 2026-08-22 lesson stated in the collection's terms — a folder card went on saying
    // `2 wishes · $20.00` over a drawer holding one, because the argument that "the row's own
    // number is already the answer" is true about the *row* and false about everything counted
    // from it. **Neither repairs itself at the app's own `staleTime`** (`lib/query.ts`, 30s): this
    // query's observer is mounted for the life of the page, so marking it stale without a refetch
    // changes nothing.
    //
    // Named rather than folded into `["collection"]`, which would take the list with it — the
    // paragraph above is why the list is deliberately left alone here.
    void queryClient.invalidateQueries({ queryKey: ["collection", "folderSummary"] });
    // The wishlist counts this list: a wish's `ownedQuantity` is computed from
    // `collection_entries`, so a stepper press has just made every cached wish for that card
    // wrong. The same pair `AddToCollection` invalidates, for the same reason — a write here
    // is the same write it makes.
    void queryClient.invalidateQueries({ queryKey: ["wishlist"] });
    // And the search results, which draw `ownedQuantity` on every row now. Refetched rather
    // than merely marked — only *active* queries refetch, and while this view is on screen
    // the search is unmounted, so from here the cost is a stale mark and nothing else.
    void queryClient.invalidateQueries({ queryKey: ["cards", "search"] });
    // And every deck. Since schema v25 a deck owns what its own group physically holds, summed
    // per oracle id, so the row this stepper just changed *is* a deck's arithmetic if it is
    // filed in a deck group — and is spare for every theory list if it is not. Either way what
    // that deck says it owns, and the shortfall its "missing to wishlist" button would buy,
    // moved without the deck being touched at all. There is nothing left to recompute: the
    // number is read off the folder at read time rather than kept in a claim table.
    void queryClient.invalidateQueries({ queryKey: ["decks"] });
  }, [queryClient]);

  /**
   * What a refused write leaves behind, on either path.
   *
   * The whole view, not just the list: a refused write is usually a row something else
   * already removed (`GONE`), and a collection that has lost a row has also lost the copies,
   * the value and the unique count that row was part of — measured live, the header went on
   * counting a deleted entry until this reached past the table. The wishlist and the search
   * go with it for the same reason a success takes them: the copies that deletion took are
   * copies some wish counted as owned and some result row is badged with.
   */
  const settleFailure = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["collection"] });
    void queryClient.invalidateQueries({ queryKey: ["wishlist"] });
    void queryClient.invalidateQueries({ queryKey: ["cards", "search"] });
    void queryClient.invalidateQueries({ queryKey: ["decks"] });
  }, [queryClient]);

  const setQuantity = useMutation({
    mutationFn: ({ row, quantity }: { row: CollectionRow; quantity: number }) =>
      ipc.collectionSetQuantity(row.id, quantity),
    // Optimistic on the row's own number and nothing else. Without it, holding `+` sends
    // the same number three times — the box is controlled by the cache, so a second press
    // before the first answer would be computed from a stale value.
    onMutate: ({ row, quantity }) => {
      const saved = snapshot();
      patchEntry(row.id, (r) => ({ ...r, quantity }));
      return saved;
    },
    onError: (_error, _variables, saved) => {
      if (saved) restore(saved);
      settleFailure();
    },
    onSuccess: (change) => {
      // The answer, not the guess: the backend clamps and canonicalises, and this is the
      // number it actually stored — **or says the row is not there any more**.
      //
      // `removed` is not decoration. Since schema v24 `collection::set_quantity(id, 0)`
      // *deletes* the entry, and the stepper is `min={0}`, so one press on a single copy is a
      // delete. Read as "quantity 0" it left a ghost: the row stayed in the list, dimmed,
      // while `settle()` — which deliberately does not re-read the list — had already sent the
      // header off to count a collection the row is no longer in, so the two disagreed on
      // screen instantly, and the next `+` on the ghost answered GONE. `remove.onSuccess`
      // below is these same two lines, and this is the same write with a different gesture.
      patchEntry(change.id, change.removed ? null : (r) => ({ ...r, quantity: change.quantity }));
      settle();
    },
  });

  const remove = useMutation({
    mutationFn: (row: CollectionRow) => ipc.collectionRemove(row.id),
    // No optimistic half, so nothing to roll back: the row is dropped from the answer rather
    // than from the press, because a removal is one click and does not have to survive being
    // held down. The failure path is the stepper's, though — a refusal here means the same
    // thing it means there, and used to mean nothing at all.
    onError: settleFailure,
    onSuccess: (change) => {
      patchEntry(change.id, null);
      settle();
    },
  });

  /**
   * Filing a copy — the drag's write, and **the same mutation the row's own context menu makes it
   * through**, so a merge behaves the same whichever hand made the gesture.
   *
   * The command, the settle set and the reason none of it is optimistic all live on
   * {@link useSetCollectionFolder}; this page adds only its refusal surface, which is the banner
   * under the header that every other write here shares (`bannerFailure` below). The menu's copy
   * of this hook draws `CardMenuRefusal` instead, because a menu is already closing by the time
   * the answer arrives and has nothing left on screen to report to — that difference is the whole
   * of what the two callers do differently, and it is why the hook takes handlers rather than
   * owning one.
   *
   * This page's sentence was that there was one mutation while there were two of them. There is
   * one now.
   */
  const setFolder = useSetCollectionFolder();

  const onSetQuantity = useCallback(
    (row: CollectionRow, quantity: number) => setQuantity.mutate({ row, quantity }),
    [setQuantity],
  );
  const onRemove = useCallback((row: CollectionRow) => remove.mutate(row), [remove]);
  const onNeedNextPage = useCallback(() => {
    if (query.hasNextPage && !query.isFetchingNextPage && !query.isFetchNextPageError) {
      void query.fetchNextPage();
    }
  }, [query]);

  /**
   * The wall is a wall of *objects*, where the table is a list of entries: a printing held in
   * one finish across three grades, two languages and two drawers is one piece of art to look
   * at, so the tile carries the copies of all of them.
   *
   * **The finish is part of the key and condition, language and folder are not**, which is the
   * whole of this wall's grain. A foil and a played nonfoil are two objects at two prices sharing
   * only a set and a number — two pictures, and no single honest figure to draw under one of
   * them — where the same finish in two drawers is one object seen from two places, and the
   * table beside the wall is where a reader gets those apart. `foldCopies` in
   * `features/decks/collectionTiles.ts` folds the app's *other* collection wall on the same pair,
   * deliberately: two drawings of one collection that disagreed about what a tile **is** would be
   * exactly the drift the grain exists to remove.
   */
  const tiles = useMemo(() => {
    const copies = new Map<string, number>();
    // The same walk, answering the tile's second question: *which finishes* those copies are in.
    // A second pass would be a second definition of "the entries behind this object" — and the
    // answer is now always a one-element set, which is what {@link ownedFinishes} is for.
    const finishes = new Map<string, Set<string>>();
    // And its third, which only a flattened wall draws: *where* those copies are filed. A `Set`
    // because a printing held four times in one drawer is one folder, and insertion-ordered
    // because a tile in exactly one folder must name the folder its rows named.
    const filed = new Map<string, Set<number | null>>();
    for (const row of rows) {
      // **The raw `row.finish`, never the narrowed one.** For the three finishes the CHECK
      // constraint permits the two are identical; a row spelling something this build cannot
      // name keys as its own word and gets a tile of its own, rather than being folded in with
      // the plain copies it is not.
      //
      // What that costs such a tile is not merely its own ring. Pressing it calls
      // `openCardAsFinish(id, null)` — the narrowed finish is `null` — so `paneFinish` is `null`,
      // the composite spells `id:nonfoil`, and the ring lands on the **plain tile beside it**, or
      // on nothing where the reader holds no plain copy. Still strictly better than before the
      // split, where no tile of a printing was distinguishable from any other, and under the
      // CHECK constraint it describes 0 rows. See {@link tileKeyOf}, which carries this in full.
      const key = tileKeyOf(row.cardId, row.finish);
      copies.set(key, (copies.get(key) ?? 0) + row.quantity);
      const held = finishes.get(key) ?? new Set<string>();
      held.add(row.finish);
      finishes.set(key, held);
      const drawers = filed.get(key) ?? new Set<number | null>();
      drawers.add(row.folderId);
      filed.set(key, drawers);
    }
    const seen = new Set<string>();
    const out: CollectionTile[] = [];
    for (const row of rows) {
      const key = tileKeyOf(row.cardId, row.finish);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        key,
        // **The printing, which is what a press opens** — `CardGrid` keeps the two apart, and
        // this is the half `onSelect`, the art fetch and the caret note are all about.
        id: row.cardId,
        // A printing `cards` has forgotten still has the set and number the entry recorded,
        // and on a wall of art that is the whole of what identifies it.
        name: row.name ?? `${row.setCode.toUpperCase()} ${row.collectorNumber}`,
        setCode: row.setCode,
        collectorNumber: row.collectorNumber,
        rarity: row.rarity,
        // The picture a browser can reach, straight off the row. Ignored on the desktop, where
        // `cardArtSrc` prefers the local cache — see `GridCard.imageUris`, which is where that
        // branch is argued. Off the group's first row like `unitPrice` below, and for the same
        // reason: every row behind this tile names the same printing.
        imageUris: row.imageUris,
        copies: copies.get(key) ?? 0,
        // Narrowed against `FINISHES` rather than cast, for the reason the key above is *not*
        // narrowed: `finish` is TEXT with a CHECK rather than an enum this side knows, so a word
        // this build cannot name marks the art with nothing instead of with a sheen no stylesheet
        // has — and `openCardAsFinish` is handed the same narrowed value rather than the column.
        finish: isFinish(row.finish) ? row.finish : null,
        // Off the row rather than reduced across the group: every row behind this tile names the
        // same printing *and* the same finish, so they all carry the same figure and taking the
        // first is not a choice between two answers. Already per copy, per finish, at the
        // marketplace the query named — never the derived `price_usd`, which is a fallback chain
        // and would price a plain copy at foil rates.
        unitPrice: row.unitPrice,
        typeLine: row.typeLine,
        oracleId: row.oracleId,
        finishes: ownedFinishes(finishes.get(key) ?? new Set()),
        folders: [...(filed.get(key) ?? new Set<number | null>())],
      });
    }
    return out;
  }, [rows]);

  /**
   * The rows behind each piece of art — the other half of {@link tiles}, kept apart from it
   * because the wall draws one and the *drag* carries the other.
   *
   * A tile is a printing; the entries behind it are what a folder actually files, and they can
   * differ in finish, condition, language and — the term that makes this a question at all —
   * **folder**. So the drag hands a folder every one of them and the page decides what to do
   * with the several ({@link fileCard}), rather than the wall inventing a single id it does not
   * have.
   *
   * **Keyed by the tile — {@link tileKeyOf}, the very function {@link tiles} and the wall's ring
   * composite are built from — and this map was keyed by the *card* until 2026-08-26.** That was
   * correct for exactly as long as a tile was all of a printing's finishes: a menu or a drag
   * acting on every row of the printing was acting on everything the picture stood for. The
   * moment the finish joined the wall's grain it stopped being correct, and in the quietest
   * possible way: a foil tile's `Move to` reached the plain copies, while the badge in the corner
   * of that same tile counted one. A control acting on cardboard the reader is not pointing at,
   * with the tile itself saying otherwise, is precisely the silent wrongness the split exists to
   * remove — and *no test went red either way*, which is why it was worth fixing at once rather
   * than filing.
   *
   * **What is still a *list* rather than a single id is the point of the map.** One finish of one
   * printing is still several rows — they differ in grade, in language and, the term that makes
   * this a question at all, in **folder** — so a drag still hands a folder every one of them and
   * the reader still answers which ({@link fileCard}). The split narrowed *which* rows are behind
   * a picture; it did not turn the several into one.
   *
   * **Built from the loaded, filtered rows, which is exactly what the tile claims.** The tile's
   * copy count is summed from these same rows under the same key, so "what moves" and "what the
   * picture says it is" are one list by construction. A later page of the same printing is not in
   * it — and must not be: the reader is filing what is on screen.
   */
  const copiesByTile = useMemo(() => {
    const out = new Map<string, CollectionCopy[]>();
    for (const row of rows) {
      const key = tileKeyOf(row.cardId, row.finish);
      const held = out.get(key) ?? [];
      held.push({ entryId: row.id, folderId: row.folderId });
      out.set(key, held);
    }
    return out;
  }, [rows]);

  /**
   * What a wall tile carries when it is picked up — **two marks in one flat record**, which is
   * why this is `CardGrid`'s `dragRecord` and not its `dragPayload`.
   *
   * The card half is what a deck category and the sidebar's Decks entry have always taken from
   * the collection's *table* rows; the tile half is what a folder card and a breadcrumb segment
   * read. Neither reader can see the other's key, which is `collectionDrag.ts`'s whole argument.
   *
   * `null` for a printing with no loaded row — impossible while the tile is drawn from those very
   * rows, and answered rather than asserted, because `CardGrid` reads this once at attach and
   * again at `dragstart` and a `null` there is honestly "this cannot be picked up".
   *
   * Its identity moves only with {@link copiesByTile}, i.e. when the rows change — never on a
   * bare re-render, which is what `CardGrid`'s own note asks for: a fresh arrow every render
   * tears the registration down and rebuilds it on every scrolled row.
   */
  /** The rows behind one tile, as the ids a menu target carries. **`tile.key`, not `tile.id`** —
   *  a `Move to` from a foil tile must reach that tile's rows and no others. */
  const entryIdsOf = useCallback(
    (tile: CollectionTile) => (copiesByTile.get(tile.key) ?? []).map((copy) => copy.entryId),
    [copiesByTile],
  );

  const tileDrag = useCallback(
    (tile: CollectionTile): Record<string, unknown> | null => {
      // The tile's rows, by the tile's own key. **The two `cardId`s below stay `tile.id`**, and
      // the reason differs per half.
      //
      // The tile half's is what a folder card and a breadcrumb caption say the reader is filing
      // ("Move 2 copies of Lightning Bolt"), and the rows it travels with are already narrowed —
      // it is a label, not an address. It has no consumer that reads it as an address at all.
      //
      // **The card half's is a known limitation rather than a decision.** `deck_add_card` does
      // take a finish (`DeckFinish`), but `dragData`'s `{ kind: "card" }` payload has **no finish
      // slot** — only its `deckCard` sibling does — so a foil tile dropped onto a deck category
      // lands as a plain card. That predates the split and this task does not widen `dnd.ts` to
      // fix it; what the split changed is that the loss is now *avoidable*, because the tile
      // finally knows which finish the reader pointed at.
      const copies = copiesByTile.get(tile.key) ?? [];
      if (copies.length === 0) return null;
      return {
        ...dragData({
          kind: "card",
          cardId: tile.id,
          name: tile.name,
          typeLine: tile.typeLine,
        }),
        ...collectionTileDragData({ cardId: tile.id, name: tile.name, copies }),
      };
    },
    [copiesByTile],
  );

  /**
   * The question a drop asks when the tile it was given stands for more than one row, or `null`
   * while nothing is being asked — the destination travels with it, because the folder card that
   * took the drop is gone from the conversation by the time the reader answers.
   */
  const [picking, setPicking] = useState<{
    cardName: string;
    entryIds: readonly number[];
    folderId: number | null;
  } | null>(null);

  /**
   * The question a **drag** asks when it crosses the edge of a drawer the reader has set aside,
   * or `null` while nothing is being asked — issue #365, design §5.
   *
   * The whole drop travels with it rather than a card id, because the answer replays the gesture:
   * a tile standing for several rows still has to reach {@link fileCard}'s own picker afterwards,
   * and the folder card that took the drop is long gone from the conversation by then.
   *
   * **Only a drag raises one.** A drop target is a rectangle a pointer can land on by mistake and
   * this is the whole gesture the badge on the tile exists to slow down; the card menu's
   * `Add to → <folder>` and the row's `Move to folder…` both put the folder's name in the press
   * the reader made, so a confirmation there would ask them to agree with a sentence they had just
   * typed the answer to — which is `PinnedFolders`' rule one step further along.
   */
  const [crossing, setCrossing] = useState<LockedMove | null>(null);

  /**
   * The collection as a **walk**, so the printings modal's chevrons and arrow keys step along it.
   *
   * **Built from {@link tiles} rather than from `rows`, and that is the honest source of the
   * two.** A walk's stops are printings — the modal answers a foil entry and a played nonfoil of
   * one printing with the same wall and the same ring — so `listWalkStops` de-duplicates by card
   * id, which is what keeps the walk one stop per printing now that the wall draws two tiles for
   * one. Feeding it `rows` would land on the same list by the same de-duplication while losing
   * the fallback name an orphaned entry gets here, which is two definitions of one thing with
   * only one of them complete.
   *
   * The table is walked by the same list, and that is right rather than a compromise: the two
   * layouts are one collection in one order, and a press that meant something different
   * depending on which was on screen would be two answers to one question.
   */
  const walk = useMemo(
    () => listWalkStops(tiles, (tile) => ({ cardId: tile.id, oracleId: tile.oracleId, name: tile.name })),
    [tiles],
  );
  usePublishCardWalk("your collection", walk);

  // Once per session, on the first load that has rows: everything the user owns gets its
  // art cached in the background, so the collection browses without a network. Keys already
  // on disk are skipped by the query, which is what makes repeat calls cheap and the job
  // resumable across sessions.
  const warmed = useRef(false);
  useEffect(() => {
    if (warmed.current || rows.length === 0) return;
    warmed.current = true;
    void ipc.prewarmCollection().catch(() => {});
  }, [rows.length]);

  /**
   * The right-click menu, as one object for the whole page — the table's rows and the wall's
   * tiles are two drawings of one collection, and a menu whose writes differed between them
   * would be two answers to one question.
   *
   * "View all printings" is live on every healthy row and tile, and greyed only where the
   * entries behind it are orphans — `CollectionRow.oracleId` is what makes that distinction
   * reachable, and it is passed through untouched by both adapters above.
   */
  /**
   * The menu's half of the same question the drag asks — `Move to → <folder>` on a wall tile.
   *
   * **The same dialog, opened from the other door.** `collection-folders.md` records that these
   * two gestures have already drifted once, when the menu's settle set took `["decks"]` and the
   * drag's did not; a second implementation of "which copies?" is the same mistake one layer up,
   * so the row hands its ids here and this sets the very state a drop sets.
   *
   * The name is read off the first row rather than passed down: `moveItem` knows entry ids and
   * nothing about printings, and the list is the page's.
   */
  const pickCopies = useCallback(
    (entryIds: readonly number[], folderId: number | null) => {
      const first = rows.find((row) => row.id === entryIds[0]);
      setPicking({
        cardName: first?.name ?? "these copies",
        entryIds,
        folderId,
      });
    },
    [rows],
  );

  const { menu, menuKey, menuClick } = useContextMenu();
  const { deps: baseMenuDeps, error: menuFailure } = useCardMenuDeps();
  /**
   * The app-wide deps plus the one write only this page can offer.
   *
   * `pickCopies` is here rather than in `useCardMenuDeps` because it is a fact about *this
   * surface's targets*: a wall tile stands for several `collection_entries` rows, and no other
   * surface in the app draws a target that does. Every other page leaves it out and `moveItem`
   * files directly, exactly as it always has.
   */
  const menuDeps = useMemo<CardMenuDeps>(
    () => ({ ...baseMenuDeps, pickCopies }),
    [baseMenuDeps, pickCopies],
  );
  /** One row's handler. The item list is a **thunk** inside `menu`, so a list of a thousand
   *  pays for nothing until a reader actually right-clicks one of them. */
  const rowMenu = useCallback(
    (row: CollectionRow) => menu(() => buildCardMenu(rowTarget(row), menuDeps)),
    [menu, menuDeps],
  );
  /** The same menu on Shift+F10 and the ContextMenu key — wired everywhere its pointer twin is,
   *  because a menu only a mouse can open is a menu half this app's readers do not have. */
  const rowMenuKey = useCallback(
    (row: CollectionRow) => menuKey(() => buildCardMenu(rowTarget(row), menuDeps)),
    [menuKey, menuDeps],
  );
  const tileMenu = useCallback(
    (tile: CollectionTile, picked: readonly CollectionTile[] = []) =>
      menu(() =>
        buildCardMenu(tileTarget(tile, entryIdsOf(tile)), {
          ...menuDeps,
          picked: picked.map((one) => tileTarget(one, entryIdsOf(one))),
        }),
      ),
    [menu, menuDeps, entryIdsOf],
  );
  const tileMenuKey = useCallback(
    (tile: CollectionTile, picked: readonly CollectionTile[] = []) =>
      menuKey(() =>
        buildCardMenu(tileTarget(tile, entryIdsOf(tile)), {
          ...menuDeps,
          picked: picked.map((one) => tileTarget(one, entryIdsOf(one))),
        }),
      ),
    [menuKey, menuDeps, entryIdsOf],
  );

  /**
   * The reader's own cabinet — the folders they made and named, and nothing the app owns.
   *
   * `collection_folders.kind` is one of three: `user`, the `deck` folder that stands for a deck,
   * and the single `removed` one. Only the first is a drawer the reader arranged, so only the
   * first belongs in the nestable tree they drag between and rename. **The other two render as a
   * separate pinned flat section** — {@link PinnedFolders}, which carries the whole argument for
   * why it is locked and why neither kind takes a drop. Schema v25 creates them, so that section
   * is real from this PR on; it was drawn empty for one PR and rendered nothing at all, because
   * an empty heading is a promise about a feature that has not shipped.
   *
   * The filter is on the *tree's* input alone. {@link trailOf} and `folderNameOf` below read the
   * whole list, so a copy that sits in an app-owned folder is still named honestly by the table's
   * Folder column rather than reading as unfiled — and the breadcrumb can still walk a reader out
   * of a deck group they have opened.
   */
  const userFolders = useMemo(
    () => folders.folders.filter((folder) => folder.kind === "user"),
    [folders.folders],
  );

  /** The other two kinds, split and ordered for the pinned section. */
  const pinned = useMemo(() => pinnedFolders(folders.folders), [folders.folders]);

  /**
   * The figures one pinned entry draws.
   *
   * **The summary row directly, never {@link subtotalsOf}**: that map is built by walking the
   * reader's tree, and these folders are deliberately not in it. Nothing can nest under a deck
   * group or under `Recently removed` — no command writes a `parent_id` naming one — so the
   * direct count *is* the recursive count here, and there is nothing to add up.
   *
   * `isPending` is the same window the wall above draws an em dash across, and for the same
   * reason: a `Map.get` miss means "empty" once the summary has answered and "not counted yet"
   * before it has, and `0 cards` over a deck holding sixty is a wrong number rather than a
   * spinner.
   */
  const pinnedTotals = useCallback(
    (folder: CollectionFolder): CollectionFolderTotals | null =>
      folders.summaryQuery.isPending ? null : (folders.summary.get(folder.id) ?? NO_CARDS),
    [folders.summaryQuery.isPending, folders.summary],
  );

  /**
   * The cabinet, as a tree, and where the reader is standing in it.
   *
   * `buildFolderTree(userFolders, [])` with **no members**, which is the one thing about this call
   * that is not obvious: `FolderNode.count` would be the number of rows filed under a node, and
   * this page holds one level's rows rather than the whole list, so counting from them would
   * answer 0 for every folder that is not the one on screen. The counts come from
   * `collection_folder_summary` instead, summed up the tree by {@link subtotalsOf}. The tree is
   * still what says which folder is under which, and it is what applies the missing-parent rule
   * that {@link trailOf} applies from the other end.
   */
  const nodes = useMemo(() => buildFolderTree(userFolders, []), [userFolders]);
  const trail = useMemo(() => trailOf(folders.folders, folderId), [folders.folders, folderId]);
  const subtotals = useMemo(() => subtotalsOf(nodes, folders.summary), [nodes, folders.summary]);

  /**
   * The folders filed directly at the level being drawn — nothing deeper, because a card is a door
   * into one drawer rather than a picture of the cabinet.
   *
   * Read off the *tree* rather than filtered out of the flat rows, so a folder whose parent
   * another surface deleted surfaces here at the root instead of disappearing with the parent that
   * is gone — `buildFolderTree`'s rule, and the reason this is not a one-line `filter`.
   */
  const childFolders = useMemo(() => folderLevel(nodes, folderId), [nodes, folderId]);

  /**
   * The level **above** the one on screen — `null` at the root, and `null` again inside a deck
   * group or `Recently removed`, which are pinned at the top level and hold nothing but cards.
   *
   * Read off the {@link trail} rather than off the open folder's own `parentId`, and the two are
   * not always the same word: `trailOf` walks up through `parentId` and stops at a folder this
   * list does not carry, so a binder whose parent another surface deleted has a one-segment trail
   * and climbs to the root — which is exactly where `buildFolderTree` has drawn it. The tile and
   * the trail therefore lead to the same place by construction rather than by agreement.
   */
  const upFolderId = useMemo(
    () => (folderId === null ? null : (trail[trail.length - 2]?.id ?? null)),
    [folderId, trail],
  );

  /**
   * What to call a folder, for the two sentences the layers below build out of one.
   *
   * A `Map` and not a `find` per call: the strip names a folder three times over while it is open,
   * and the whole list is already in memory. `null` — a folder id this page cannot name — is what
   * every call site turns into its own fallback, which is the honest answer for a drawer another
   * window deleted between the two reads.
   *
   * The **table** does not go through here: `CollectionRow.folderName` is the backend's own join,
   * so a row names its drawer without this page having to hold both halves.
   */
  const folderNames = useMemo(
    () => new Map(folders.folders.map((folder) => [folder.id, folder.name])),
    [folders.folders],
  );
  const folderNameOf = useCallback(
    (id: number | null) => (id === null ? ROOT_LABEL : (folderNames.get(id) ?? null)),
    [folderNames],
  );

  /**
   * The drawers the reader has set aside — **every folder inside a locked one included**, because
   * the lock inherits down the tree (issue #365, design §3).
   *
   * `lockedFolderIds` is the single place that inheritance is computed on this side and no call
   * site here re-derives it: the badge on a folder card, the greyed Lock/Unlock row, the greyed
   * Delete and the drag confirmation are all four about the *effective* answer, and reading
   * `CollectionFolder.locked` at any of them would draw an unmarked drawer inside a locked one.
   *
   * **The whole census rather than {@link userFolders}**, which is not tidiness: a deck group and
   * `Recently removed` carry `locked = false` — the write refuses anything that is not
   * `kind = 'user'` in words — so including them costs nothing, and leaving them out would break
   * {@link lockRootOf}'s walk the day anything is nested under one.
   */
  const lockedIds = useMemo(() => lockedFolderIds(folders.folders), [folders.folders]);

  /** Every folder's parent, for {@link lockRootOf}'s walk. A `Map` for {@link folderNames}' reason:
   *  the walk runs once per end of every drag frame, and the whole list is already in memory. */
  const parentById = useMemo(
    () => new Map(folders.folders.map((folder) => [folder.id, folder.parentId])),
    [folders.folders],
  );

  /**
   * **Which drawer a folder is set aside *inside*** — the outermost locked ancestor-or-self, or
   * `null` for a folder that is not locked at all. The root is never locked, so `null` in is
   * `null` out.
   *
   * **This is what makes "a move inside the drawer is not a move across the boundary" computable**
   * (design §5), and a boolean cannot answer it: dragging a copy between two sub-folders of one
   * locked binder has both ends effectively locked and has crossed nothing, while dragging between
   * two *different* locked binders has both ends effectively locked and has crossed twice. Naming
   * the drawer rather than counting the locks tells those two apart in one comparison —
   * {@link crossesLockedBoundary} is that comparison, and it is the whole of the rule.
   *
   * **Outermost rather than nearest**, which is the half a "walk up to the first locked ancestor"
   * reading gets wrong: a locked binder holding a separately-locked sub-folder is still one
   * drawer, and stopping at the sub-folder would ask a reader to confirm a move within it.
   *
   * The `seen` set is `lockedFolderIds`' own guard for the same reason it has one: `move_folder`
   * refuses to write a cycle, only a hand-edited database could hold one, and a walk that hung the
   * window over it would be worse than the corruption.
   */
  const lockRootOf = useCallback(
    (id: number | null): number | null => {
      let at = id;
      let root: number | null = null;
      const seen = new Set<number>();
      while (at !== null && !seen.has(at)) {
        seen.add(at);
        if (lockedIds.has(at)) root = at;
        at = parentById.get(at) ?? null;
      }
      return root;
    },
    [lockedIds, parentById],
  );

  /**
   * Flatten closes whatever folder layer is open, and it does it by *deriving* rather than by
   * writing state from an effect.
   *
   * With the filing ignored the whole wall goes — `New folder`'s tile and every folder card's `⋯`
   * with it, since all of them are drawn *inside* it — so every trigger that could have opened one
   * of these is off screen. A rename field left standing over a flattened list would be a layer
   * with nothing on screen explaining what it is about. The derived value is what the whole page
   * reads, {@link panel} itself only what the setters write, so pressing Flatten and pressing it
   * back does not resurrect the layer. `WishlistPage`'s twin, verbatim.
   *
   * **The level clause arrived with the field moving into the tile.** A naming field is drawn
   * *by* `New folder`'s tile now, so a `newFolder` panel opened at one level and left open while
   * the reader walked into another would be a layer with no field on screen at all — invisible,
   * and still swallowing the Escape that should have walked them back out. Where the strip was
   * merely confusing about which level it meant, nothing is worse; so the panel goes with the
   * level it was opened for. Nothing else in the page can produce that state, because
   * {@link openNewFolder} always opens with the level the reader is standing in.
   */
  const openPanel =
    flatten || (panel?.kind === "newFolder" && panel.parentId !== folderId) ? null : panel;

  // Focus first, then close: the opener is still mounted at this point, and an element that
  // unmounts with the caret on it drops focus to `<body>` — after which the next Tab restarts from
  // the top of the app. This is the **keyboard** way out — Escape, and each panel's own Cancel.
  // `close` below is the click-away way and is deliberately a different function: CLAUDE.md's rule
  // is that an outside click does *not* hand the caret back, because the reader is already
  // somewhere else.
  const dismiss = useCallback(() => {
    openerRef.current?.focus();
    setPanel(null);
  }, []);
  const close = useCallback(() => setPanel(null), []);

  useDismissOnEscape({ layer: "inner", onDismiss: dismiss, enabled: openPanel !== null });

  /**
   * One level up — **the breadcrumb's own second-to-last segment, read rather than re-derived**.
   *
   * {@link trailOf} ends with the folder the reader is standing in, so the step before it is the
   * one the breadcrumb draws as the last *pressable* segment, and an empty step is the root. That
   * is `null`, which for this cabinet is the copies filed **nowhere** — `useCollection` sends
   * `rootOnly` for it, the wishlist's reading rather than the "every folder" this page opened on
   * until Flatten arrived. Either way the two ways out land in the same place by construction
   * rather than by two pieces of arithmetic that happen to agree.
   *
   * **A deck group and `Recently removed` need no branch here, and that is a fact about `trailOf`
   * rather than luck.** It is handed `folders.folders` — every kind — where the *tree* above it is
   * handed `userFolders`, so a reader standing in a pinned folder has a one-segment trail and this
   * answers the root. Schema v25 writes `parent_id` `NULL` on every pinned row and no command can
   * nest anything under one, so a one-segment trail is the only shape either can take.
   *
   * A `folderId` naming a folder this list no longer carries answers the root too — `trailOf`
   * resolves a broken parent *towards* the root for exactly the reason this reads it: the
   * alternative strands the reader inside a drawer with no way out.
   */
  const parentFolderId = trail.length >= 2 ? trail[trail.length - 2].id : null;

  /**
   * Escape walks the reader out of a drawer — the floor rung, and the same step the breadcrumb's
   * last pressable segment takes.
   *
   * **`enabled` on `folderId !== null` is what keeps the press from being swallowed at the root.**
   * A registered layer takes the press whether or not it has anywhere to go, and a `"navigation"`
   * rung that consumed Escape at the top of the cabinet would be a floor with nothing under it:
   * every press a reader made on this page would stop here and reach nothing else that might one
   * day want the last one.
   *
   * The filter box is what makes this safe to have at all rather than a courtesy laid over it —
   * `clearFieldOnEscape` in `FilterBar` — because Chromium empties an
   * `<input type="search">` on Escape by itself and does **not** mark the press handled, so
   * without it one press would clear the box *and* walk the reader up a level.
   *
   * **Flatten is deliberately not a rung of this, and that is a decision rather than an
   * oversight** — do not "fix" it by toggling the chip off here. `WishlistPage` states the
   * argument in full and it holds one cabinet over: Flatten is not a place the reader walked into,
   * it is the filing being ignored, so there is no level on screen to leave — the breadcrumb, the
   * wall and the pinned strip are all off. With it on, Escape does nothing at all here, **including
   * when a `folderId` is still set underneath**, because walking a level the reader cannot see
   * would silently move where un-flattening puts them back. The chip is one press away and says
   * which state it is in.
   */
  useDismissOnEscape({
    layer: "navigation",
    onDismiss: () => collection.openFolder(parentFolderId),
    enabled: !flatten && folderId !== null,
  });

  const open = useCallback((next: NonNullable<Panel>, opener: HTMLElement | null) => {
    openerRef.current = opener;
    setPanel(next);
  }, []);

  /**
   * `New folder`, the wall's own first tile — **inside the folder the reader is standing in**,
   * which at the root is the top level, and which is the whole of what it promises by going away
   * with the wall while the list is flattened.
   *
   * **`HTMLElement` rather than the `HTMLButtonElement` this took while it was wired to a
   * `<button>` here.** {@link NewFolderCard} owns the element now and hands it over as an
   * `HTMLElement`; under `strictFunctionTypes` a callback asking for the narrower type is not
   * assignable to that prop at all, and it never needed the narrower one — {@link open} takes an
   * `HTMLElement | null`, because all it does with the element is `focus()` it.
   *
   * `folders.create.reset()` for `DecksPage`'s reason: a refusal from the last attempt is not news
   * about this one.
   */
  const openNewFolder = useCallback(
    (opener: HTMLElement) => {
      folders.create.reset();
      open({ kind: "newFolder", parentId: folderId }, opener);
    },
    [folders.create, folderId, open],
  );

  /**
   * The field, answered — whichever of its two jobs it is doing.
   *
   * One callback because there is one field: which write a name becomes is a fact about the open
   * `Panel`, which this component owns, rather than something the field has to be told and then
   * hand back.
   *
   * **A new folder does not become the folder the reader is standing in**, the wishlist's call and
   * for its reason: the reader is looking at the cards they are about to file, and walking them
   * into the new empty drawer would take exactly those cards off screen and replace them with
   * `Nothing filed here yet.` The card they just made is right there to drag onto.
   */
  const nameFolder = useCallback(
    (name: string) => {
      if (panel?.kind === "newFolder") {
        folders.create.mutate({ parentId: panel.parentId, name }, { onSuccess: dismiss });
      } else if (panel?.kind === "renameFolder") {
        folders.rename.mutate({ id: panel.folderId, name }, { onSuccess: dismiss });
      }
    },
    [panel, folders.create, folders.rename, dismiss],
  );

  /**
   * One folder card's three doors into one menu — a right-click, a `ContextMenu` keypress, and the
   * `⋯` trigger's own plain click, which is what {@link useContextMenu.menuClick} exists for.
   *
   * The item list is a **thunk** inside each handle, so a level holding twelve drawers builds no
   * menu until a reader opens one of them.
   *
   * **The opener is captured here rather than by the card**, because the panel a row raises has to
   * hand the caret back to the control it was raised from and a `MenuAction.onSelect` is a bare
   * callback with no element behind it. `e.currentTarget` is read synchronously, which is the only
   * moment it is the element the handler is attached to.
   */
  const folderRowMenu = useCallback(
    (folder: CollectionFolder) => {
      // Whether the drawer is set aside, and whether that is the reader's press on *this* card or
      // a decision they made further up the tree. The two are different rows' answers: Lock/Unlock
      // is about this folder's own flag and is greyed by the ancestor, where Delete is about the
      // effective lock and is greyed by either.
      const inherited = !folder.locked && lockedIds.has(folder.id);
      const effectivelyLocked = folder.locked || inherited;
      /** The phrase a greyed row carries, which is a *phrase* rather than `FOLDER_IS_LOCKED`'s
       *  whole sentence: a menu row is as wide as its widest content, so one long reason sets the
       *  width of the entire panel. The two arms point at the two different things a reader would
       *  go and do next, which is the grammar {@link blockedReason}'s greyed rows already use. */
      const ancestorReason = "a folder above it is locked";
      const build = (): MenuItem[] => [
        {
          kind: "action",
          id: "rename",
          label: "Rename…",
          Icon: Pencil,
          onSelect: () => {
            folders.rename.reset();
            open({ kind: "renameFolder", folderId: folder.id }, openerRef.current);
          },
        },
        {
          kind: "action",
          id: "move",
          label: "Move to folder…",
          Icon: FolderInput,
          onSelect: () => {
            folders.move.reset();
            open({ kind: "moveFolder", folderId: folder.id }, openerRef.current);
          },
        },
        /**
         * **Set the drawer aside, or bring it back** — issue #365, and the one row here that is
         * neither a layer nor a field: it writes on the press, and what the reader watches change
         * is the badge on the card behind the menu.
         *
         * **It toggles the folder's *own* flag**, where every other consumer of the lock on this
         * page reads the effective one. That asymmetry is the feature rather than an
         * inconsistency: the reader locks a drawer and gets the drawer, including whatever they
         * have nested inside it — so there is one row per folder to press and no second copy of
         * the fact to disagree with the first.
         *
         * **Greyed, with its reason in the row's accessible name, when an ancestor is locked.**
         * Unlocking a child of a locked parent changes nothing a reader can see — the badge stays
         * and the copies stay out of the flattened list — and a row that reported success over an
         * unmoved badge is worse than a greyed one. `Rename…` and `Move to folder…` above stay
         * live in every state, deliberately: neither disturbs a card, so neither is what the lock
         * is about (design §4.4).
         *
         * Above the separator, with the other two live rows: the rule below it is *destructive*,
         * and locking is reversible in one press.
         */
        {
          kind: "action",
          id: "lock",
          label: folder.locked ? "Unlock folder" : "Lock folder",
          Icon: folder.locked ? LockOpen : Lock,
          disabled: inherited ? true : undefined,
          reason: inherited ? ancestorReason : undefined,
          onSelect: () => {
            folders.setLocked.reset();
            folders.setLocked.mutate({ id: folder.id, locked: !folder.locked });
          },
        },
        { kind: "separator", id: "before-delete" },
        /**
         * **Greyed on the *effective* lock**, which is `delete_folder`'s own fence said early:
         * deleting re-files every card in the sub-tree to the root, silently undoing exactly the
         * filing the lock was protecting, so the backend refuses it in words (`FOLDER_IS_LOCKED`)
         * for a folder inside a locked parent as surely as for the one the reader pressed Lock on.
         * **And the UI must not let the press happen**: `PinnedFolders`' own rule is that a control
         * whose only outcome is a sentence explaining that it does not work teaches the reader
         * nothing its absence would not have. That band answers it by omitting the menu; a locked
         * drawer keeps its menu, so this greys with its reason in the row's accessible name.
         */
        {
          kind: "action",
          id: "delete",
          label: "Delete…",
          Icon: Trash2,
          disabled: effectivelyLocked ? true : undefined,
          reason: effectivelyLocked
            ? inherited
              ? ancestorReason
              : "unlock it first"
            : undefined,
          onSelect: () => {
            folders.remove.reset();
            open({ kind: "deleteFolder", folderId: folder.id }, openerRef.current);
          },
        },
      ];
      const remember = (element: HTMLElement) => {
        openerRef.current = element;
      };
      return {
        onContextMenu: (e: ReactMouseEvent<HTMLButtonElement>) => {
          remember(e.currentTarget);
          menu(build)(e);
        },
        onKeyDown: (e: ReactKeyboardEvent<HTMLButtonElement>) => {
          remember(e.currentTarget);
          menuKey(build)(e);
        },
        onClick: (e: ReactMouseEvent<HTMLButtonElement>) => {
          remember(e.currentTarget);
          menuClick(build)(e);
        },
      };
    },
    [
      menu,
      menuKey,
      menuClick,
      open,
      lockedIds,
      folders.rename,
      folders.move,
      folders.remove,
      folders.setLocked,
    ],
  );

  /** The reader's own drawers and the app's deck groups, as sets, for the two fences in
   *  {@link canFile}. A `Set` because that question is asked once per target per drag frame. */
  const userFolderIds = useMemo(
    () => new Set(userFolders.map((folder) => folder.id)),
    [userFolders],
  );
  const deckGroupIds = useMemo(
    () => new Set(pinned.decks.map((folder) => folder.id)),
    [pinned.decks],
  );

  /**
   * **A place the reader themselves arranged: the root, or a drawer they made.** One predicate,
   * several questions, one answer.
   *
   * They are genuinely different questions — may a copy be dropped *into* this folder
   * ({@link canMoveCopy}), may a new folder be created *inside* it ({@link canMakeFolder}), may a
   * row filed *here* be stepped on the wall ({@link stepperByTile}) or in the table
   * ({@link quantityBlocked}) — and they share an answer because they share a backend rule:
   * `collection_folders.rs`'s `user_folder`, which every one of those writes calls and which
   * refuses a deck group and `Recently removed` in words. A spelling of it per call site is a call
   * site per edit to keep in step with that function, and this page has already watched two
   * gestures drift apart once (`collection-folders.md` records the `Move to` whose settle set took
   * `["decks"]` while the drag's did not). Grep this name rather than trusting a count written
   * here.
   *
   * **Written positively — `null` or `user` — and never as a blocklist of the two app-owned
   * kinds.** `collection_folders.kind` is three words today; a fourth added later defaults to
   * *fenced* under this spelling and to *permitted* under `!deckGroupIds.has(id)`, and a control
   * that quietly turns itself on for a kind nobody has thought about is the failure this shape
   * exists to prevent. It is also why `deckGroupIds` above is not the input: that set is
   * {@link canMoveCopy}'s *source* fence, which is a different question about the other end of a
   * drag, and it is deliberately narrower — `Recently removed` is not in it, because dragging back
   * out of the holding area is the whole of what #209 asked for.
   *
   * The root is a level too, and it is the one `null` names — hence the first arm rather than a
   * lookup that would fail for it.
   */
  const readersOwnLevel = useCallback(
    (id: number | null) => id === null || userFolderIds.has(id),
    [userFolderIds],
  );

  /**
   * Which `collection_entries` row a press on a tile's stepper writes to — **the wall's twin of
   * {@link copiesByTile}**, and absent where the wall draws no stepper at all.
   *
   * # Why it is not beside its twin
   *
   * {@link copiesByTile} sits with {@link tiles} because both are pure over `rows`. This one is
   * not: its fence is {@link readersOwnLevel}, which is built from the folder census read further
   * down the page, so it can only be stated after the cabinet is. Reading it up there would be a
   * temporal dead zone rather than a style choice.
   *
   * # The fence
   *
   * A stepper is drawn only where **every** row behind the art is at the root or in a drawer the
   * reader made. Not *any*: the number the control shows is the tile's **sum**, so a tile mixing a
   * copy in a binder with a copy in a deck's group would move a total that is partly untouchable —
   * the reader would press `−` on a 3 and watch it become a 2 while one of those three copies is
   * the deck's custody and `set_entry_folder`'s `ENTRY_IN_A_DECK` exists precisely to keep it
   * there. `canFile` takes the opposite rule for the opposite reason and says so at its own site:
   * a *drag* asks which copies may move and the reader answers, where a stepper is a number with
   * no question attached to it.
   *
   * **This is also why no page-level branch is needed for "the reader is standing inside a deck
   * group".** Unflattened, every row on that wall is in that folder, so every tile is fenced by
   * this rule alone; and flatten ships **on** (`useCollection.ts`), so the per-tile rule is the one
   * that actually does the work in the state a reader meets. A second gate on `folderId` would be
   * a fact this map already knows, stated again somewhere it could drift.
   *
   * **A filed tile is fenced until the census has answered**, which is the fail-*closed* direction
   * and is deliberate: `useCollectionFolderList` starts empty, and "empty" is a collection nobody
   * has filed as well as one that has not loaded — that hook says so at its own site. So a tile in
   * a drawer draws no stepper for the length of one query and then grows one, where the permissive
   * reading would draw a control over a deck's copies for exactly that window. The root needs no
   * census at all, which is most of the wall.
   *
   * # Which row, and what the floor is
   *
   * **The first row behind the art** — the same row {@link tiles} takes `id`, `name`, `unitPrice`
   * and `imageUris` from, so the tile's identity and the tile's writes address one entry rather
   * than two. "First" is the query's **current sort order** and is therefore not stable across a
   * re-sort: the same picture can address a different entry after the reader presses a column
   * header. That is the accepted cost of the decision rather than an oversight — the alternative
   * is a dialog per press (which is what a *drag* gets, because a drag is already a question), and
   * the copies behind one tile differ only in grade, language and drawer, none of which a wall of
   * art shows.
   *
   * `floor` is `tile.copies - row.quantity`: the copies this stepper **cannot reach**, because they
   * belong to the rows it does not address. **Taken off the tile's own sum and never re-summed
   * here** — the badge in the corner and the number in the stepper are the same figure, so a second
   * walk over `rows` would be a second definition of it, and the two disagreeing is a control whose
   * floor is wrong in a way nothing on screen explains.
   *
   * Two consequences fall out of those two numbers rather than being special-cased. On the
   * ordinary single-entry tile `floor` is **0**, so stepping to zero deletes the entry exactly as
   * the table's stepper does (`collection::set_quantity(id, 0)` deletes — see `setQuantity`'s
   * `onSuccess`). And on a tile of 3 copies made of an NM row of 2 and a Played row of 1, `floor`
   * is **1**: `−` walks 3 → 2 → 1 and then disables, the NM row is gone, the wall re-reads its
   * rows, the Played row becomes first, the floor recomputes to 0 and `−` walks that one out too.
   *
   * # The key
   *
   * {@link tileKeyOf}, the same function {@link tiles} and {@link copiesByTile} are built from —
   * **the printing *and* the finish**. Keying by card alone would point a foil tile's stepper at
   * the plain copies while the badge six pixels above it counted the foils, which is the exact
   * silent wrongness {@link copiesByTile} records having shipped for its own `Move to`.
   */
  const stepperByTile = useMemo(() => {
    const first = new Map<string, CollectionRow>();
    const fenced = new Set<string>();
    for (const row of rows) {
      const key = tileKeyOf(row.cardId, row.finish);
      if (!first.has(key)) first.set(key, row);
      if (!readersOwnLevel(row.folderId)) fenced.add(key);
    }
    const out = new Map<string, { row: CollectionRow; floor: number }>();
    for (const tile of tiles) {
      const row = first.get(tile.key);
      // `undefined` is unreachable while the tiles are built from these very rows, and it is
      // answered rather than asserted for {@link tileDrag}'s reason.
      if (row === undefined || fenced.has(tile.key)) continue;
      out.set(tile.key, { row, floor: tile.copies - row.quantity });
    }
    return out;
  }, [rows, tiles, readersOwnLevel]);

  /**
   * Why one **table row's** copies cannot be stepped where they sit, or `null` for a row that can
   * — `CollectionTable`'s `quantityBlocked`, and the other half of the wall's fence above.
   *
   * **One predicate, two drawings.** The table and the wall are the same list in two layouts, so a
   * row the wall will not let a reader step and a row the table will is not a difference a reader
   * can make any sense of — and it is a difference two independently-written fences arrive at the
   * first time either moves. {@link readersOwnLevel} is the whole of the test on both sides;
   * everything below it is *words*, which is the only thing the two surfaces legitimately differ
   * in. The wall says it by drawing nothing (there is no room on a 170px tile for a sentence, and
   * the strip it would sit in is revealed on hover), where a table row has a whole cell and can
   * afford to say what to do instead.
   *
   * **The grain is a row here and a tile there, and that is not a second rule.** A tile is fenced
   * when *any* row behind it is; a row is fenced when it is. The wall's is that same predicate
   * over the several rows one piece of art sums, which is why {@link stepperByTile} does the
   * folding and this does not.
   *
   * # Which sentence
   *
   * Two of the three arms name what the folder *is*, because the way out differs: copies in a
   * deck's group leave by being cut from the deck (`deck_to_collection`, which decrements
   * `deck_cards` in the same transaction), and copies in `Recently removed` leave by being filed
   * back. Both are the grammar {@link blockedReason} already uses for the picker's greyed rows —
   * where you are, then what to do — so this feature speaks with one voice about a refusal.
   *
   * **The third arm names no mechanism, on purpose.** It is reached by a fourth
   * `collection_folders.kind` — the reason the fence is written positively at all — and a fourth
   * kind wearing the deck sentence would tell the reader to cut a card from a deck that does not
   * exist. So it says only what is certainly true of anything that is not the reader's own filing:
   * the copies are somewhere they did not put them, and the way to change the count is to move
   * them somewhere they did.
   *
   * **It is also, for the length of one query, what a row in the reader's own binder gets**, and
   * that is the cost of the fence failing closed. `useCollectionFolderList` starts empty and
   * "empty" is a cabinet nobody has filed as well as one that has not loaded, so until it answers
   * every filed row is outside {@link readersOwnLevel} and reads a sentence that is wrong about a
   * drawer the reader made. Accepted over the alternative, which is a live stepper standing over a
   * deck's copies for the same window against a `collection::set_quantity` that has **no folder
   * fence of its own** — a briefly wrong sentence self-corrects and a written quantity does not.
   * The root needs no census, so this is only ever about filed rows.
   */
  const quantityBlocked = useCallback(
    (row: CollectionRow): string | null => {
      if (readersOwnLevel(row.folderId)) return null;
      if (row.folderId !== null && deckGroupIds.has(row.folderId)) {
        return `In ${row.folderName ?? "a deck"}. Cut the card from the deck to change how many you hold.`;
      }
      if (row.folderId === pinned.removed?.id) {
        return "In Recently removed. Move it back to your collection to change how many you hold.";
      }
      return `In ${row.folderName ?? "a folder you did not make"}. Move it into one of your own folders to change how many you hold.`;
    },
    [readersOwnLevel, deckGroupIds, pinned.removed],
  );

  /**
   * Where a copy in the air may be let go — asked per target, because the answer differs per
   * target: the folder a row is already filed in refuses it and draws no ring at all, rather than
   * a ring that would write nothing and bump `updated_at`. `dropWrite`'s rule about a card dropped
   * back in its own column, one screen over.
   *
   * **Both of the other two clauses are about the deck boundary, and the drag is the only gesture
   * that can reach it by accident.**
   *
   * *The destination must be the root or a folder the reader made.* That is not this page's rule
   * but `collection_folders::set_entry_folder`'s: it calls `user_folder` on the destination and
   * refuses a deck group or `Recently removed` in words. **No gesture on this page reaches it
   * today** and that is deliberate: `PinnedFolders` registers no drop target, and the only
   * breadcrumb segment that could name a pinned folder is the last one, which is never a target.
   * It is the fence rather than the affordance — the thing that keeps the invariant local the day
   * somebody makes a pinned entry droppable "because the ring looked missing". A mutation check
   * confirmed the reachability: removing this clause fails nothing, where removing either of the
   * other two fails exactly one test each.
   *
   * *The source must not be a deck group.* **`set_entry_folder` fences this end too**
   * (`ENTRY_IN_A_DECK`, a sibling of `FOLDER_NOT_YOURS` rather than a reuse of it — that one is
   * about the destination folder, this one about the row), so what this clause buys is the
   * refusal *before* the drop rather than a sentence after it. The reason both ends exist is
   * unchanged and is why neither may be dropped: the destination would be a perfectly legal user
   * folder, so an unfenced `collection_set_folder` would move the copy **out of the deck's
   * custody without touching `deck_cards`** — the mirror image of the bug the paragraph above
   * prevents, and worse, because the deck would go on listing a card whose copies have walked
   * off. Copies leave a deck through `deck_to_collection`, which decrements the list in the same
   * transaction. `Recently removed` is deliberately not in this set, at either end: dragging
   * *out* of the holding area is the whole of what #209 asked for.
   */
  const canMoveCopy = useCallback(
    (from: number | null, to: number | null) => {
      if (from === to) return false;
      // {@link readersOwnLevel}, which is this clause's own expression given a name so that
      // everything on this page asking `user_folder`'s question asks it once.
      if (!readersOwnLevel(to)) return false;
      return from === null || !deckGroupIds.has(from);
    },
    [readersOwnLevel, deckGroupIds],
  );
  /**
   * The same three clauses asked of whichever shape is in the air.
   *
   * **A tile is taken when *any* copy behind it could move, never only when all of them could.**
   * A printing a reader holds twice in one finish, one copy already in this drawer, is the
   * ordinary case — and a folder that refused the whole tile for it would strand the copy that
   * genuinely has somewhere to go. Which of them actually moves is {@link fileCard}'s question,
   * and where more than one row is behind the art the reader answers it rather than the page.
   *
   * (The example was "in two finishes" until 2026-08-26, when the finish joined the wall's grain
   * and stopped being a way one tile's rows can differ. The rule is unchanged — grade, language
   * and folder still split rows without splitting a tile.)
   */
  const canFile = useCallback(
    (drop: CollectionDrop, to: number | null) =>
      drop.kind === "entry"
        ? canMoveCopy(drop.entry.folderId, to)
        : drop.tile.copies.some((copy) => canMoveCopy(copy.folderId, to)),
    [canMoveCopy],
  );
  /**
   * The write, or the question about **which copy** that has to come before it — everything a drop
   * did before the lock existed, and what {@link fileCard} hands a confirmed one back to.
   *
   * A table row is one entry and files straight away — the gesture has already said everything
   * there is to say. A wall tile files straight away too **when it stands for a single row**,
   * which is the common case and the one where a dialog would be a press for a choice with one
   * answer. More than one row behind the art is the case the app cannot decide: the copies differ
   * in condition, language and folder, the reader can see none of that on a piece of card art,
   * and choosing for them is the one answer that is always wrong for somebody. (They can no
   * longer differ in **finish** — that is what makes them two pieces of art since 2026-08-26 —
   * which narrows this question without answering it.)
   *
   * **Split out rather than guarded inside, so the confirmed gesture is the same code as the
   * unconfirmed one.** A lock question that re-implemented the single-row shortcut would be a
   * second definition of "which entry does this drop write", and the two would disagree the first
   * time either moved — which is `useSetCollectionFolder`'s own history, one write down.
   */
  const commitFile = useCallback(
    (drop: CollectionDrop, to: number | null) => {
      if (drop.kind === "entry") {
        setFolder.mutate({ entryId: drop.entry.entryId, folderId: to });
        return;
      }
      const { copies, name } = drop.tile;
      if (copies.length === 1) {
        setFolder.mutate({ entryId: copies[0].entryId, folderId: to });
        return;
      }
      setPicking({ cardName: name, entryIds: copies.map((copy) => copy.entryId), folderId: to });
    },
    [setFolder],
  );

  /**
   * **Has this drop crossed the edge of a drawer the reader set aside** — the one comparison
   * design §5 rests on, and the reason {@link lockRootOf} names a folder rather than answering a
   * boolean.
   *
   * Two ends both *effectively* locked is not the question: two sub-folders of one locked binder
   * are both locked and the copy has not left the drawer, where two different locked binders are
   * both locked and it has left one and entered another. Comparing the drawers answers both, and
   * answers the ordinary cases for free — neither end locked is `null === null`, and exactly one
   * end locked is a difference by construction.
   */
  const crossesLock = useCallback(
    (from: number | null, to: number | null) => lockRootOf(from) !== lockRootOf(to),
    [lockRootOf],
  );

  /**
   * The write, or one of the two questions that can come before it.
   *
   * A table row is one entry and files straight away — the gesture has already said everything
   * there is to say. A wall tile files straight away too **when it stands for a single row**,
   * which is the common case and the one where a dialog would be a press for a choice with one
   * answer. More than one row behind the art is the case the app cannot decide: the copies differ
   * in condition, language and folder, the reader can see none of that on a piece of card art,
   * and choosing for them is the one answer that is always wrong for somebody. (They can no
   * longer differ in **finish** — that is what makes them two pieces of art since 2026-08-26 —
   * which narrows this question without answering it.) That half is {@link commitFile}.
   *
   * **The lock is the other question and it is asked first**, because it is about the gesture
   * rather than about which row the gesture is for: a reader who says *leave it there* never sees
   * the picker at all, and one who says *move it* is handed back to exactly the code path the drop
   * would have taken. Only the copies that could actually move are asked about — a tile whose one
   * movable copy is already in the destination is refused by {@link canFile} before this runs, and
   * a copy the destination would refuse is not part of what the reader is being warned about.
   *
   * **A drag only.** `Add to → <folder>` and `Move to folder…` reach {@link setFolder} through
   * their own handlers and are deliberately not routed through here.
   */
  const fileCard = useCallback(
    (drop: CollectionDrop, to: number | null) => {
      const sources =
        drop.kind === "entry"
          ? [drop.entry.folderId]
          : drop.tile.copies
              .filter((copy) => canMoveCopy(copy.folderId, to))
              .map((copy) => copy.folderId);
      const crossed = sources.filter((from) => crossesLock(from, to));
      if (crossed.length === 0) {
        commitFile(drop, to);
        return;
      }
      // The first crossing source's drawer, where a tile could in principle be carrying copies out
      // of two different locked binders at once. The sentence stays true of the one it names, and
      // naming both would be a clause for an arrangement nobody has: a printing filed in two
      // separately locked drawers *and* dragged somewhere neither of them is.
      const leaving = crossed.map((from) => lockRootOf(from)).find((id) => id !== null) ?? null;
      const arriving = lockRootOf(to);
      setCrossing({
        drop,
        to,
        card: drop.kind === "entry" ? drop.entry.name : drop.tile.name,
        out: leaving === null ? null : (folderNameOf(leaving) ?? "a folder you have set aside"),
        into: arriving === null ? null : (folderNameOf(arriving) ?? "a folder you have set aside"),
      });
    },
    [canMoveCopy, crossesLock, lockRootOf, folderNameOf, commitFile],
  );

  /**
   * Why one copy cannot go where the reader pointed, or `null` when it can — the sentence the
   * picker greys a row with.
   *
   * **Both refusals are the backend's, said early.** `collection_folders::set_entry_folder`
   * answers `ENTRY_IN_A_DECK` for a row sitting in a deck's group, and the wording here is that
   * sentence's job rather than a paraphrase of it: it names what to do instead, because there is
   * something to do. "Already there" is not a refusal the backend makes at all — it would write
   * the row back where it is and bump `updated_at` — and it is drawn because a row the reader
   * cannot usefully tick has to say why it is not ticked.
   */
  const blockedReason = useCallback(
    (row: CollectionRow, to: number | null): string | null => {
      if (row.folderId === to) return `Already in ${folderNameOf(to) ?? ROOT_LABEL}.`;
      if (row.folderId !== null && deckGroupIds.has(row.folderId)) {
        return `In ${row.folderName ?? "a deck"}. Cut the card from the deck to get it back.`;
      }
      return null;
    },
    [deckGroupIds, folderNameOf],
  );

  /** The rows the open question is about, drawn from the list rather than from the drag: the
   *  payload carries ids and folders, and a reader needs the finish, the grade and the count. */
  const pickChoices = useMemo<CopyChoice[]>(() => {
    if (picking === null) return [];
    const byId = new Map(rows.map((row) => [row.id, row]));
    return picking.entryIds.flatMap((entryId) => {
      const row = byId.get(entryId);
      // A row that has left the list under an open dialog — another surface removed it, or a
      // refetch dropped it. Left out rather than drawn as an unnamed line.
      if (row === undefined) return [];
      return [
        {
          entryId,
          finish: isFinish(row.finish) ? FINISH_LABEL[row.finish] : row.finish,
          condition: conditionLabel(row.condition),
          lang: row.lang,
          quantity: row.quantity,
          folderName: row.folderName,
          blocked: blockedReason(row, picking.folderId),
        },
      ];
    });
  }, [picking, rows, blockedReason]);

  const failure = query.isError ? ipcError(query.error) : null;
  // The *latest* write on the screen, not whichever is still holding an error: with `isError` on
  // both, a refused stepper press left "Could not change your collection" on screen while the
  // reader went on to remove the row successfully — an alert about something that had already been
  // dealt with. Seen live, and the rule is `lib/writes.ts`' now rather than three lines here.
  //
  // The folder writes are in the list because they are writes this screen makes, and they share
  // the banner because they share the sentence: everything here is a change to the reader's
  // collection.
  const bannerFailure = writeFailure([
    setQuantity,
    remove,
    setFolder,
    folders.create,
    folders.rename,
    folders.move,
    folders.reorder,
    folders.remove,
    folders.setLocked,
  ]);
  const empty = rows.length === 0;
  // The cabinet is drawn only where there is one. In a collection nobody has filed, a lone inert
  // "Collection" under a ribbon that already says Collection is the subheading this page's own
  // `sr-only` heading exists to avoid.
  //
  // **`|| folderId !== null` is what keeps a reader from being stranded**, and it arrived with the
  // pinned section: a reader who has made no folders of their own can still be *inside* one, by
  // pressing a deck group or `Recently removed`, and the breadcrumb is the only way back out.
  // Without this clause the trail was gated on a list that folder is deliberately not in, so
  // opening a deck group closed the door behind them.
  const hasFolders = userFolders.length > 0 || folderId !== null;
  /**
   * **Does this level hold drawers of its own** — the question {@link statusOf} asks, and the only
   * one this value answers. It stays the reader's own children: the refile wall drawn inside
   * `Recently removed` is not that level's content.
   *
   * `!flatten` for the wishlist's reason, and it is a correctness clause rather than tidiness: a
   * flattened list draws no folder cards at all, so "the cards below are the answer, leave them
   * alone" would silence the one line an empty flattened collection has to say. `New folder` is
   * not content either — a wall holding nothing but the tile that makes the first folder is still
   * a level with nothing in it.
   */
  const filed = !flatten && childFolders.length > 0;
  /** Standing in the holding area, which is the one level whose wall is not its own children. */
  const inRemoved = pinned.removed !== null && folderId === pinned.removed.id;
  /**
   * The folders drawn over the cards at this level.
   *
   * **Inside `Recently removed` it is the reader's own top level rather than nothing**, and that
   * substitution *is* #209's feature. Nothing nests under the holding area, so its own children
   * are always empty — and a reader standing in a pile of copies that just left a deck, with no
   * drop target on screen, can sort them back only through the row menu. The wall puts their
   * binders under the pointer, so the sort is the drag it should have been.
   *
   * Not done for a **deck group**, whose cards may not be dragged out at all ({@link canFile}): a
   * wall of drawers that every ring refuses would be an invitation to a gesture that does nothing.
   */
  const wall = inRemoved ? nodes : childFolders;

  /**
   * The level the wall is drawing: the parent every card on it is a child of, and that level's
   * ids in the order they are drawn.
   *
   * **Read off the wall rather than off the target card's own `parentId`, and the two are not
   * always the same word.** `buildFolderTree` draws a folder whose parent this list does not
   * carry at the **root** rather than dropping it, so an orphan's row still names a folder that
   * is gone — sending that as a destination would be a reorder into nothing. What is on screen is
   * the honest answer, and writing it down also files the orphan where the reader can already see
   * it: `collection_folder_reorder` writes `parent_id` from this argument for every id in the
   * list, which is that same paragraph read from the other end.
   *
   * `null` inside `Recently removed`, which is the one level whose wall is not its own children —
   * the substitution #209 asked for, and therefore the one place `folderId` is not the parent of
   * what is drawn.
   */
  const wallLevel = useMemo(
    () => ({ parentId: inRemoved ? null : folderId, ids: wall.map((one) => one.folder.id) }),
    [inRemoved, folderId, wall],
  );

  /**
   * What a folder let go on another folder means as a write — the destination level and that
   * level's whole new order — or `null` for a drop this page will not make.
   *
   * **One function for both halves of the gesture**, because a mark that promised a write the
   * drop then refused would be worse than no mark: `useFolderDropTarget` asks the question once
   * per target per frame to decide what to draw, and again at the drop because the two can be a
   * second apart and only the second one writes. Three of the four clauses below are refusals the
   * **backend** makes in words, said early enough to be a missing ring rather than a red banner.
   *
   * **Both ends must be a folder the reader made, and that clause is this cabinet's alone.**
   * `collection_folders.kind` is one of `user`, `deck` and `removed`, and
   * `collection_folders::reorder_folders` calls `user_folder` on the destination *and* on every
   * id it is handed — a deck's group or `Recently removed` at either end is `FOLDER_NOT_YOURS`.
   * `deck_folders` and `wishlist_folders` carry no such column, which is why the wishlist's twin
   * of this function has one clause fewer rather than having forgotten one. **No gesture on this
   * page reaches it today and that is deliberate**: `PinnedFolders` registers neither a drop
   * target nor a drag source, so a pinned entry can be neither picked up nor pointed at, and the
   * wall this guards is built from `userFolders`. It is the fence rather than the affordance —
   * {@link canMoveCopy}'s third clause, for the same reason and with the same warning attached:
   * it is what keeps the invariant local the day somebody makes a pinned entry draggable
   * "because the ring looked missing".
   *
   * **A folder may not land inside itself or inside anything it holds.** The backend refuses that
   * too, and the guard is not cosmetic: `collection_folders.parent_id` is `ON DELETE CASCADE`
   * **on itself**, so a cycle is a graph SQLite's recursive cascade would walk forever the day
   * the folder is deleted. It is asked of the **destination parent** rather than of the card
   * under the pointer, which is what covers all three landings at once — `inside` a descendant
   * and `before` one are the same cycle, since a descendant's own parent is the dragged folder or
   * something already under it. This one is unreachable from this page for a different reason
   * than the clause above: the wall draws exactly **one level**, so every card on it is a sibling
   * of every other and a descendant is never on screen beside its ancestor. The arrangement that
   * does put them there is a cabinet that already holds a cycle, which `buildFolderTree` draws at
   * the root as leaves and which only corruption produces.
   *
   * **And a drop that would reproduce the order already on screen is not a write.**
   * `reorderedLevel` is what says so; its `null` is a refusal rather than an error, because
   * dropping a folder back where it already sits is a gesture a reader makes by accident every
   * time they think better of one mid-drag, and a write for it would bump `updated_at` and
   * re-read the list to arrive at what is already drawn.
   */
  const folderPlacement = useCallback(
    (
      drag: FolderDrag,
      target: FolderNode<CollectionFolder>,
      edge: FolderEdge,
    ): { parentId: number | null; ids: number[] } | null => {
      // `inside` says which drawer and the target *is* it; `before`/`after` say where in the
      // level the target sits in, which is the level being drawn.
      const parentId = edge === "inside" ? target.folder.id : wallLevel.parentId;
      if (!userFolderIds.has(drag.folderId) || !userFolderIds.has(target.folder.id)) return null;
      if (parentId !== null && !userFolderIds.has(parentId)) return null;
      if (parentId !== null && parentId === drag.folderId) return null;
      if (parentId !== null && folderDescendants(userFolders, drag.folderId).has(parentId)) {
        return null;
      }
      const ids = reorderedLevel({
        // The target's own children for a nest — in the order the tree already draws them, so a
        // nest re-states the level it is joining rather than re-sorting it — and the level on
        // screen for the other two.
        siblings:
          edge === "inside" ? target.children.map((child) => child.folder.id) : wallLevel.ids,
        dragged: drag.folderId,
        target: target.folder.id,
        edge,
      });
      return ids === null ? null : { parentId, ids: [...ids] };
    },
    [userFolderIds, userFolders, wallLevel],
  );

  /**
   * The two halves of {@link folderPlacement}, bound per card by the wall below.
   *
   * **A folder is deliberately not droppable on the breadcrumb, where a copy is**, and the two
   * are not the same gesture wearing different payloads. `collection_set_folder` takes one
   * destination and that is the whole of the write, so a trail segment names a complete answer —
   * which is why `CollectionBreadcrumb` takes card drops at all: without somewhere to drop a copy
   * that moves it *up*, that gesture would only ever push copies deeper.
   * `collection_folder_reorder` takes a destination **and that level's whole order**, and the
   * order is what this gesture is for — a quarter of every folder card means "beside this one,
   * here" (`EDGE_ZONE`). A segment is one word with no order to point into, so the only thing a
   * drop on it could say is "last, in a level that is not on screen", and the folder would leave
   * the wall with nothing drawn saying where it went. The way back out is `Move to folder…`, on
   * the card's own `⋯`, which names every destination including the root — so unlike a copy, a
   * folder is not one gesture short of a route home. If this is revisited, the thing to change is
   * the *mark*, not the target: a segment would need to say "last" before it could honestly take
   * one.
   */
  const canPlaceFolder = useCallback(
    (drag: FolderDrag, target: FolderNode<CollectionFolder>, edge: FolderEdge) =>
      folderPlacement(drag, target, edge) !== null,
    [folderPlacement],
  );
  const placeFolder = useCallback(
    (drag: FolderDrag, target: FolderNode<CollectionFolder>, edge: FolderEdge) => {
      const plan = folderPlacement(drag, target, edge);
      // A `null` writes **nothing at all** — not a reorder of the level as it stands, which would
      // be a transaction to arrive at the list already on screen.
      if (plan !== null) folders.reorder.mutate(plan);
    },
    [folderPlacement, folders.reorder],
  );

  /**
   * The **up** tile's folder drop: a binder moved out of the level on screen and into the one
   * above it, last in that level.
   *
   * **Not a special case of {@link folderPlacement}, because that one is asked about a card on the
   * wall and this destination has no card.** The level above is the one the reader walked out of;
   * nothing on screen belongs to it, so there is no target row, no `before`/`after`, and no order
   * to point into — which is precisely the objection {@link canPlaceFolder} raises against letting
   * a breadcrumb segment take a folder. **What answers it here is that the tile says "last"
   * without having to draw it**: `inside` is the landing a reader already gets by dropping a
   * folder on another folder's middle, it already means "which drawer, and nothing about where in
   * it", and `reorderedLevel` already appends. The tile is one landing wide, so there is no second
   * position for the reader to have meant.
   *
   * The four refusals are {@link folderPlacement}'s own, asked of a destination rather than of a
   * card. **Both ends must be a folder the reader made** — this cabinet's alone, because
   * `collection_folders::reorder_folders` calls `user_folder` on the destination and on every id
   * it is handed. The destination is never anything else in practice (nothing nests inside a deck
   * group or `Recently removed`, so a trail's second-from-last segment is a user folder or the
   * root), which makes this the fence rather than the affordance — exactly as it is one function
   * up. **Already there**, **into itself or into what it holds**, and `reorderedLevel`'s own
   * `null` complete the set; the middle one is unreachable while the wall draws one level, and is
   * kept because `parent_id` cascades onto itself and a cycle is a graph SQLite would walk
   * forever.
   *
   * **Inside `Recently removed` the "already there" clause is the whole of the answer**, and that
   * is the one place it does real work: the wall there is not that level's children but the
   * reader's own top level ({@link wall}), so every folder card on it is *already* at the
   * destination this tile names, and each of them draws no ring rather than one that would shuffle
   * it to the end of the level it is in.
   */
  const upPlacement = useCallback(
    (drag: FolderDrag): { parentId: number | null; ids: number[] } | null => {
      if (folderId === null) return null;
      if (!userFolderIds.has(drag.folderId)) return null;
      if (upFolderId !== null && !userFolderIds.has(upFolderId)) return null;
      if (drag.parentId === upFolderId) return null;
      if (
        upFolderId !== null &&
        (upFolderId === drag.folderId ||
          folderDescendants(userFolders, drag.folderId).has(upFolderId))
      ) {
        return null;
      }
      const ids = reorderedLevel({
        // The destination level as the tree draws it, which is what makes the arriving folder
        // *last* rather than last among whatever the flat rows happen to name.
        siblings: folderLevel(nodes, upFolderId).map((one) => one.folder.id),
        dragged: drag.folderId,
        target: upFolderId ?? ROOT_TARGET,
        edge: "inside",
      });
      return ids === null ? null : { parentId: upFolderId, ids: [...ids] };
    },
    [folderId, upFolderId, nodes, userFolderIds, userFolders],
  );
  const canMoveFolderUp = useCallback(
    (drag: FolderDrag) => upPlacement(drag) !== null,
    [upPlacement],
  );
  const moveFolderUp = useCallback(
    (drag: FolderDrag) => {
      const plan = upPlacement(drag);
      if (plan !== null) folders.reorder.mutate(plan);
    },
    [upPlacement, folders.reorder],
  );

  /**
   * **Whether the cabinet is drawn at all — and it is drawn over an empty one on purpose.**
   *
   * Deliberately *not* {@link filed}, and deliberately not `wall.length > 0`, which is what gated
   * it while `+ New folder` sat in a row of its own. With the tile living **inside** the wall that
   * gate is a trap door: a reader who has filed nothing has no folder card to draw, therefore no
   * wall, therefore no way to make their first folder, and the cabinet could never be opened by
   * anyone who did not already have one.
   *
   * Flatten is the whole of what closes it, which is where the old `+ New folder` note went: a
   * flattened list has no current folder to make one inside, so the control that promises "here"
   * goes with the level it was promising about — one gate instead of that condition written twice.
   */
  const cabinet = !flatten;

  /**
   * Whether **this** level can hold a new folder — the tile's own gate, and a fence rather than an
   * affordance.
   *
   * `create_folder` calls `user_folder` on the parent and answers `FOLDER_NOT_YOURS` for a deck
   * group or `Recently removed` (`collection_folders.rs`), and {@link openNewFolder} always names
   * the level the reader is standing in. So a tile drawn inside either would be a press whose only
   * possible outcome is a sentence explaining that it does not work — `PinnedFolders`' argument for
   * having no `⋯` at all, one level out. **It matters most inside `Recently removed`**, where the
   * wall is *not* this level's children but the reader's own top level ({@link wall}): every card
   * in that wall is a real drop target and the tile beside them would be the one control that is
   * not, filing into an app-owned holding area.
   *
   * The root-is-a-level arm and the reason the test is written positively both live on
   * {@link readersOwnLevel} now, which is this line's own expression named once and read by the
   * drag's destination fence and the wall's stepper as well. It was spelled out here until the
   * stepper needed a third copy of it.
   */
  const canMakeFolder = readersOwnLevel(folderId);

  /**
   * What the export dialog's two sentences have to say about where the reader is standing.
   *
   * `folderId` is already in `collection.filters` and already in the sweep's key — as `rootOnly`
   * and `flatten` now are — so the export has always been *correct* and it is the words that would
   * not have been. Standing in `Trade binder` with nothing typed, the dialog would say `12 cards
   * matching your filters` and offer "Export everything, ignoring the filters", when the only thing
   * narrowing anything was the drawer neither sentence mentioned.
   *
   * **`narrows` is not "am I in a folder", and the sentence that used to stand here — that an
   * absent `folderId` is every folder, so the root narrows nothing — is false as of this PR.** The
   * root is `rootOnly: true` now, the copies filed *nowhere*, so a reader standing at the top of a
   * cabinet is looking at a sweep that leaves every drawer out. That is the wishlist's rule
   * verbatim, and this page reached it from the other direction.
   *
   * **The input is the whole census and not {@link hasFolders}**, which counts only the drawers the
   * reader made. Since v25 the app owns folders too — one per deck, and `Recently removed` — and a
   * copy filed in a deck's group is left out of the root just as surely as one in a binder, so a
   * predicate blind to them would drop the clause for exactly the reader whose cards are mostly in
   * decks. The remaining `folderId !== null` arm is for the level rather than the cabinet: standing
   * *in* a drawer narrows whatever the census says.
   *
   * It is off while the list is flattened, where the level on screen already is every folder, and
   * off for a database with no folders at all — a fixture, in practice, since v25 gives every real
   * one a holding area — where there is no cabinet to speak of and the clause would be about
   * nothing.
   *
   * **And unlike the wishlist, the escape hatch needs no second field.** `everythingFilters`
   * strips everything but `marketplace`, which here lands on `folderId` absent *and* `rootOnly`
   * absent — the widest answer the backend has. The wishlist has to say `flatten: true` a second
   * way because its own strip lands back on the root. The conclusion has not changed; the reason
   * has, and it used to be "there is only one field to strip".
   */
  const exportFiling = {
    folder: !flatten && folderId !== null ? folderNameOf(folderId) : null,
    narrows: !flatten && (folders.folders.length > 0 || folderId !== null),
  };
  const status = statusOf(collection, failure, {
    filed,
    inFolder: !flatten && folderId !== null,
  });

  return (
    <section className="flex h-full flex-col gap-4">
      {/* Not drawn: the ribbon's `h1` already names the view, and a second Cinzel
          "Collection" 18px under it would be a subheading repeating its own heading. The
          header below says what this view is far better than a title would. */}
      <h2 className="sr-only">Collection</h2>

      <CollectionSummaryHeader
        summary={summary.data}
        marketplace={marketplace}
        // The band's far end, where they used to sit beside the filter row — see `FigureRow`,
        // which is where the placement is argued. The names say *what* is moved, because both
        // dialogs carry a control called `Import` and two of those on one screen is a pair a
        // screen reader can only tell apart by position.
        actions={
          <ImportExportPair
            onImport={() => setImporting(true)}
            onExport={() => setExporting(true)}
            importLabel="Import cards"
            exportLabel="Export collection"
          />
        }
      />

      {/* The region is mounted for the life of the view and the banner is swapped into it: a
          live region that appears together with its own text announces nothing, because there
          was no change for a screen reader to notice — the same rule as the status line below
          and as the quick-add's report. `empty:-mt-4` gives back the flex gap it would
          otherwise hold open under the header while it is saying nothing at all. */}
      <div role="status" aria-label="Needs review" className="empty:-mt-4">
        {/* Only while there are flagged rows *and* the reader is not already looking at them —
            with the filter on, the list is the answer and the banner would be a second copy of
            the question.

            `!== true`, not `!`: the chip has three states, and `false` is "the rows nothing
            flagged". Under a falsy test that state would put the banner back on screen above
            a list showing precisely the rows nothing is wrong with, offering to show them. */}
        {collection.needsReview !== true && (summary.data?.needsReview ?? 0) > 0 && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-border bg-surface px-3 py-2 text-xs">
            <span className="min-w-0">
              <span className="mr-1 font-medium text-destructive">Needs review:</span>
              <span className="font-mono tabular-nums">{summary.data?.needsReview}</span>{" "}
              {summary.data?.needsReview === 1 ? "entry names" : "entries name"} a printing that
              changed or left the card database.
            </span>
            <button
              type="button"
              onClick={() => collection.setNeedsReview(true)}
              className={cn(
                "ml-auto shrink-0 rounded-md border border-accent px-2 py-1 text-accent",
                "transition-colors duration-150 hover:bg-accent hover:text-accent-foreground",
                FOCUS,
                "motion-reduce:transition-none",
              )}
            >
              Show them
            </button>
          </div>
        )}
      </div>

      {/* The same row the search and the Tags page draw, over this page's own hook — see
          `FilterBar`, whose prop is a structural `FilterSurface` that `useCollection` satisfies.
          What was a bespoke two-line row of fourteen controls is the shared four-on-the-bar plus a
          tray, so a reader who has learned that row once does not have to learn it again here. */}
      <FilterBar
        search={collection}
        labels={COLLECTION_LABELS}
        sortRows={collection.sortRows}
        tray={COLLECTION_TRAY}
        layoutFor="collection"
        // On, it ignores the filing entirely: no folder cards, no breadcrumb, no pinned strip and
        // no drill-down, and every copy in the list at once — each tile captioned with the drawer
        // it is filed in instead, which is the only way a reader sees where a copy is without
        // opening it. One press either way, since there is no third state to walk.
        flatten={{ pressed: collection.flatten, onToggle: collection.toggleFlatten }}
      />

      <div className="flex min-h-0 flex-1 flex-col gap-2">
        {/* **The fence is "not among the filters", and it was never "not on the bar" — which is
            the half of this note that changed when Flatten moved.** `resetAll` leaves both
            `folderId` and `flatten` alone (`useCollection` says so of each), so either one drawn
            as a *filter* would be the one control in that row Reset all could not undo. But the
            bar already has a home for controls that are not filters: past the second hairline,
            beside the sort and the grid-or-table pair, where every control says how the list is
            **drawn** rather than which rows are in it — and `FilterBar`'s own comment above
            `ViewToggle` says in as many words that nothing there is counted or cleared by Reset
            all. Flatten is exactly that kind of statement, so it rides the bar on the far side of
            the hairline and satisfies the fence rather than breaking it.

            **The breadcrumb does not follow it, and that is the surviving half.** Where the reader
            is standing is not a way of drawing the list — it is a *place*, one the folder cards
            below are the doors into — so the drill-down and the trail back out stay down here with
            the cabinet they are about. `+ New folder` left this row in the other direction: it is
            the wall's first tile now (`NewFolderCard`), which is where a reader already looks for
            drawers. So this row is the whole of what is left of the old one, and it is drawn
            wherever there is a cabinet to speak of — an empty flex row is chrome with nothing in
            it, but a *flattened* cabinet is not empty, it is being ignored, and the bar is what
            says so. Hence `hasFolders` alone and no `cabinet` term. */}
        {hasFolders && (
          <div className="min-w-0">
            <CollectionBreadcrumb
              // Root-most first and **without the root**, which the breadcrumb prepends itself:
              // `null` is a destination rather than a folder, and only that component knows what
              // it calls it.
              trail={trail}
              // **Not gated on `cabinet`, and it is the one piece of the cabinet that is not.**
              // The wall and the pinned strip go; this stays and says so, in the inert words the
              // component draws for the state — which is `WishlistBreadcrumb`'s own behaviour
              // under the same flag, and the reason the two pages read identically under one
              // control. See that component for why the argument for hiding it did not hold.
              flattened={flatten}
              onOpen={collection.openFolder}
              canDrop={canFile}
              onDropCard={fileCard}
            />
          </div>
        )}

        {/* **One strip for the two folder layers that are still layers, and it is not a placement
            decision so much as the only place there is.** Every other anchored layer in this app
            hangs off a `relative` wrapper around its own trigger; the trigger here is a folder
            card's `⋯`, and a card has nowhere to hang a panel and would clip it against the
            scroller it sits in. So the strip sits where the thing being moved or deleted is:
            directly above the row of cards, under the breadcrumb that says which level they are.

            **The other two moved out of it on 2026-09-03 and this box is what is left.** Naming a
            folder and renaming one are drawn *in the wall* now — `NewFolderCard` becomes the field
            it used to raise, and a folder card becomes the field its `⋯` used to raise — because
            in both cases the thing being named has a tile of its own on screen, and a second
            bordered box above the wall could only repeat what that tile already says. Moving and
            deleting have no such tile: the answer to "into which folder" is a list of the *other*
            folders, and the answer to "delete this?" is a sentence about what happens to the cards
            inside. Neither fits on a 62px card, and neither is a name typed on a line. */}
        {(openPanel?.kind === "moveFolder" || openPanel?.kind === "deleteFolder") && (
          <div className="w-full max-w-sm shrink-0 rounded-lg border border-border bg-surface p-2 text-xs">
            {openPanel.kind === "moveFolder" && (
              <MoveToFolder
                label={`Move ${folderNameOf(openPanel.folderId) ?? "folder"} into a folder`}
                nodes={nodes}
                currentId={userFolders.find((f) => f.id === openPanel.folderId)?.parentId ?? null}
                // The collection's own word for the top level. `MoveToFolder` defaults to the deck
                // gallery's, which is the surface it was written for.
                rootLabel={ROOT_LABEL}
                // A folder may not go inside itself or inside anything it holds. The backend
                // refuses it in words — `collection_folders.parent_id` cascades onto itself, so a
                // cycle is a graph SQLite would walk forever the day the folder is deleted — and
                // that refusal is a fence rather than the affordance.
                forbidden={
                  new Set([
                    openPanel.folderId,
                    ...folderDescendants(userFolders, openPanel.folderId),
                  ])
                }
                forbiddenReason="A folder cannot go inside itself, or inside anything it holds."
                // Drawn **into** the strip rather than as a popup of its own: the strip is the
                // layer, and a second box with its own shadow and its own z-index over it would be
                // a second Escape rung for one decision.
                inline
                pending={folders.move.isPending}
                onPick={(parentId) =>
                  folders.move.mutate({ id: openPanel.folderId, parentId }, { onSuccess: dismiss })
                }
                onClose={close}
              />
            )}

            {openPanel.kind === "deleteFolder" && (
              <DeleteFolderConfirm
                name={folderNameOf(openPanel.folderId) ?? "this folder"}
                pending={folders.remove.isPending}
                onConfirm={() => folders.remove.mutate(openPanel.folderId, { onSuccess: dismiss })}
                onCancel={dismiss}
                onClose={close}
              />
            )}
          </div>
        )}

        {/**
         * **The one gesture a lock slows down**, issue #365 and design §5 — a copy dragged into a
         * drawer the reader set aside, or out of one, asked about before it moves.
         *
         * **Above the wall rather than under the tile it was asked from**, which is the
         * `CollectionSearchTab` question's own placement and for its reason one surface over: the
         * grid virtualises, so a tile scrolled out from under an open question would unmount it
         * mid-answer — and a box drawn *into* the wall would reflow the row of drawers around the
         * card the reader is aiming at. It survives the position by naming the card and the drawer
         * in words, so the question never depended on remembering which tile the drag started on.
         *
         * **Not gated on {@link cabinet}.** The wall is off while the list is flattened and the
         * breadcrumb still takes copy drops, so a question that rode the cabinet would be a
         * confirmation the reader could raise and never see.
         *
         * `statusLine` and `overflow-hidden`, the failure banner's own grow-in: this column is a
         * stack of rows, so anything appearing in it pushes everything below it down together, and
         * a box with its own padding can never animate shorter than that padding.
         */}
        <AnimatePresence initial={false}>
          {crossing && (
            <motion.div {...statusLine} className="shrink-0 overflow-hidden">
              <LockedMoveConfirm
                move={crossing}
                onConfirm={() => {
                  commitFile(crossing.drop, crossing.to);
                  setCrossing(null);
                }}
                onCancel={() => setCrossing(null)}
              />
            </motion.div>
          )}
        </AnimatePresence>

        {/* The sentence the substitution above needs, and only where it is doing something: a wall
            of the reader's own binders drawn over a pile of copies that just left a deck is not
            self-explaining, and the gesture it is inviting is one a reader has no reason to guess
            at. Not drawn in a drawer of their own, where the wall is that drawer's contents — and
            not over an *empty* holding area, where it would be inviting a drag of nothing beside a
            line already saying there is nothing here.

            **And not while the list is flattened**, which is the clause Flatten added: `folderId`
            survives the press, so `inRemoved` stays true under a page that is no longer drawing
            the wall this sentence is about — a caption for a row of folder cards that is not on
            screen. It rides {@link cabinet} for exactly that reason rather than a fourth
            condition of its own. */}
        {cabinet && inRemoved && wall.length > 0 && !empty && (
          <p className="shrink-0 text-xs text-dim">
            Drag a card onto a folder to file it back into your collection.
          </p>
        )}

        {/* Drawn wherever the cabinet is *and* there is something to put in it — a folder card, or
            the tile that makes the first one. The two clauses are not the same: inside a deck
            group or `Recently removed` the tile is refused ({@link canMakeFolder}), so a deck
            group with no cards of its own would otherwise draw an empty bordered band. */}
        {cabinet && (wall.length > 0 || canMakeFolder) && (
          // **The scroller is what makes the cabinet a band rather than the page.** A reader with
          // twenty drawers must not lose the wall to them, so the row of cards is bounded and
          // scrolls inside itself.
          //
          // `DROP_MARK_ROOM` is what that costs — and since 2026-09-03 it is bought for `FOCUS`
          // alone. `overflow` clips at the padding box and the `FOCUS` outline stands 4px proud of
          // the border box, so a folder card flush against the content edge would lose half its
          // focus indicator: a WCAG 2.4.7 failure rather than a cosmetic one. **The drop mark is
          // no longer part of this.** It used to be `DROP_RING`, a box shadow painted *outside*
          // the border box and clipped the same way; it is now the card's own dashed edge going
          // gold (`DROP_EDGE`), which is inside the border box and cannot be clipped at all. The
          // padding does not change, because 6px was always `FOCUS`'s number rather than the
          // ring's. It goes on the box carrying the `overflow`; one level in is not
          // the same fix. `relative` for the rule beside it: a scroll container has to be the
          // containing block for its own absolutely positioned content, or an `sr-only` label
          // inside stretches the document. jsdom has no layout engine and can see none of this.
          <div className={cn("relative max-h-44 shrink-0 overflow-y-auto", DROP_MARK_ROOM)}>
            <ul
              aria-label="Folders"
              className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-2"
            >
              {/* **First, and shaped like the cards it makes.** A wall of drawers is where a
                  reader looks for the drawer they want, so it is also where they look for the one
                  that is not there yet — and it is the only thing in this `<ul>` on a collection
                  nobody has filed, which is what {@link cabinet} exists to allow.

                  **Not drawn where the level cannot hold one** — see {@link canMakeFolder}. That
                  is the collection's own clause and the wishlist has no equivalent: only this
                  cabinet has folders the app owns, and only this page substitutes one level's wall
                  for another's ({@link wall}), so `Recently removed` is the one place where every
                  other tile in the row is a live drop target and this one would not be.

                  It is handed {@link openNewFolder} directly rather than through an arrow: the
                  panel this raises has to give the caret back to the control it was raised from,
                  and `NewFolderCard` hands over its own button for exactly that. */}
              {/* **Before the tile that makes a folder, and only inside one.** The way *out* is
                  the first thing a reader looks for on a wall they have walked into, and the wall
                  is read leading edge first — so at the root, where there is nowhere to go up to,
                  nothing moves and `New folder` is still the first tile.

                  It is what issue #283 asked for: a folder card only ever takes a copy deeper, and
                  the only target that took one back out was a breadcrumb segment — one word of
                  `text-sm`, a target a fifth the height of the drawers beside it, in a bar the
                  pointer has already left. The trail stays exactly as it was; this is the same
                  destination at the size of the things it stands among.

                  **It rides the wall's own gate rather than adding a clause to it**, which is what
                  keeps it out of a deck group: there the wall is not drawn at all, because that
                  level has no children of its own and refuses a new folder — and a lone tile in an
                  otherwise empty band, whose ring refuses every card in the group
                  ({@link canFile}), is the invitation to a gesture that does nothing that
                  {@link wall} declines to make one paragraph up. The breadcrumb is still the way
                  out of one, as it always was. */}
              {folderId !== null && (
                <CollectionParentFolderCard
                  label={folderNameOf(upFolderId) ?? ROOT_LABEL}
                  onOpen={() => collection.openFolder(upFolderId)}
                  canDrop={(drop) => canFile(drop, upFolderId)}
                  onDropCard={(drop) => fileCard(drop, upFolderId)}
                  canDropFolder={canMoveFolderUp}
                  onDropFolder={moveFolderUp}
                />
              )}
              {canMakeFolder && (
                <NewFolderCard
                  onClick={openNewFolder}
                  // The tile *is* the naming field while this is on. `openPanel` rather than
                  // `panel`, so flattening the list and walking into another folder both close it
                  // — the derived value is what the whole page reads.
                  naming={openPanel?.kind === "newFolder"}
                  pending={folders.create.isPending}
                  onSubmit={nameFolder}
                  onCancel={dismiss}
                />
              )}
              {wall.map((node) => (
                <CollectionFolderCard
                  key={node.folder.id}
                  node={node}
                  // The recursive total, never the summary row: that one is direct per folder, and
                  // a folder holding two sub-folders of six cards each has none of its own.
                  //
                  // **`null` while the summary is still reading, and that is not the same fallback
                  // as `NO_CARDS`.** This wall is gated on the folder *list*, which is one flat
                  // `SELECT`; the figures come from a `GROUP BY` with a price expression behind
                  // it, and it answers later. Across that window a `Map.get` miss is
                  // indistinguishable from an empty drawer, so a drawer holding 240 copies would
                  // draw `0 cards` and then jump — a wrong number rather than a spinner.
                  // `isPending` is exactly the read that has never answered *for this
                  // marketplace*, which is the right span: switching marketplace is a new key, and
                  // the old currency's subtotals are not this one's to draw either.
                  summary={
                    folders.summaryQuery.isPending
                      ? null
                      : (subtotals.get(node.folder.id) ?? NO_CARDS)
                  }
                  currency={marketplace.currency}
                  // **The effective lock, never `node.folder.locked`.** A drawer inside a locked
                  // one is locked, so it wears the badge too — a mark that appeared only on the
                  // folder the reader pressed Lock on would make the inheritance invisible
                  // exactly where it matters, which is standing inside that drawer looking at
                  // what it took with it. {@link lockedIds} is the one place the tree is walked.
                  locked={lockedIds.has(node.folder.id)}
                  onOpen={() => collection.openFolder(node.folder.id)}
                  rowMenu={folderRowMenu(node.folder)}
                  // `Rename…` is answered on the card itself. One `openPanel` naming exactly one
                  // folder is what keeps a wall of twelve drawers to one open field.
                  rename={{
                    active:
                      openPanel?.kind === "renameFolder" &&
                      openPanel.folderId === node.folder.id,
                    pending: folders.rename.isPending,
                    onSubmit: nameFolder,
                    onCancel: dismiss,
                  }}
                  canDrop={(drag) => canFile(drag, node.folder.id)}
                  onDropCard={(drag) => fileCard(drag, node.folder.id)}
                  // The card asks about the folder in the air and where on itself it is; the
                  // page adds which card that is, because only the page holds the level and the
                  // tree the answer is worked out from.
                  canDropFolder={(drag, edge) => canPlaceFolder(drag, node, edge)}
                  onDropFolder={(drag, edge) => placeFolder(drag, node, edge)}
                />
              ))}
            </ul>
          </div>
        )}

        {/* **Under the reader's own cabinet, and drawn at every level — except the one that is not
            a level.** The wall above is what the reader arranged and is the thing they came to
            this page for; this is the app's own record of where the rest of their copies are, and
            it belongs beside that rather than above it. Drawn at every level because *pinned* is
            the word the spec uses and it is what makes `Recently removed` reachable from three
            drawers down — see the component for the whole of what pinned, flat and fixed cost, and
            for why its third word is no longer *locked*: that one belongs to the reader's own Lock
            press since issue #365, and means very nearly the opposite.

            **Flatten is the exception, and it is the one thing that could take this section away.**
            Flatten's promise is that the filing is off screen and every copy is in the list; a
            pinned strip surviving it would leave a row of doors into levels the list is
            deliberately ignoring, so a press would silently un-flatten by drilling in. Nothing is
            lost by the absence: the copies in every deck group and in the holding area are *in*
            the flattened list, each tile captioned with the drawer it sits in ({@link captionFor})
            and each table row naming it in the Folder column. What goes is the navigation, which
            is the whole of what Flatten is for. */}
        {cabinet && (
          <PinnedFolders
            decks={pinned.decks}
            removed={pinned.removed}
            totals={pinnedTotals}
            currency={marketplace.currency}
            openFolderId={folderId}
            onOpen={collection.openFolder}
          />
        )}

        {/* One live region, mounted for the life of the view: a region that appears together
            with its text announces nothing, because there was no change for a screen reader
            to notice. Empty — and therefore no taller than nothing — while the table below
            is answering for itself. */}
        <p
          role="status"
          className={cn(
            empty && status ? "py-16 text-center text-sm" : "text-xs",
            empty && failure ? "text-destructive" : "text-dim",
          )}
        >
          {status}
        </p>

        {/* A write that was refused, said where the writing happened. Not folded into the
            line above: that one describes the list, and this one describes something the
            reader just did to it.

            It grows into place instead of shoving the table down by its whole height. The
            animated element is the wrapper and carries only `overflow-hidden`, because
            `statusLine` takes `height` to 0 and a box with its own padding and border can
            never — under `box-sizing: border-box` — be shorter than the two of them. */}
        <AnimatePresence initial={false}>
          {bannerFailure && (
            <motion.div {...statusLine} className="overflow-hidden">
              <p
                role="alert"
                className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
              >
                Could not change your collection — {bannerFailure}
              </p>
            </motion.div>
          )}
        </AnimatePresence>

        {/* A write the right-click menu started and the backend refused, beside the banner
            above rather than folded into it: that one is about this list's own controls — a
            stepper press, a removal — and this one is about a card the reader filed somewhere
            from a menu that has already closed. */}
        <CardMenuRefusal error={menuFailure} />

        {!empty &&
          (view === "grid" ? (
            <CardGrid
              rows={tiles}
              label="Your collection"
              listKey={collection.queryKeyString}
              // **A phone gets a narrower card, so the binder is two columns rather than one.**
              // The same width the search wall takes and for the same arithmetic: 324px of wall
              // at 390, where 170 floors to one column. `PHONE_TILE_WIDTH` carries the
              // derivation, the 160 that looks like a fix and is not, and the decision that the
              // chin does not scale with it.
              baseTileWidth={narrowWindow ? PHONE_TILE_WIDTH : undefined}
              // This wall's own zoom, kept apart from the search's: the two views are the same
              // component over different rows, and a reader who peers at one printing's art in
              // search is not asking for a binder at 2× as well. `CardGrid`'s `zoomSection`
              // carries why it is required rather than defaulted.
              zoomSection="collection"
              // **The wall is a drag source now**, through `dragRecord` rather than
              // `dragPayload`: a tile's drag means two things at once — a card, for the deck
              // categories and the sidebar's Decks entry that have always taken one from this
              // page's *table*; and the several `collection_entries` rows the wall summed into
              // one piece of art, for a folder card and a breadcrumb segment. Two marks in one
              // flat record is what that slot carries, and the wishlist's tiles reached the
              // shape first. See {@link tileDrag}.
              dragRecord={tileDrag}
              // Ctrl and Shift build a set of tiles (issue #214).
              selectionScope="collection"
              // **The ring follows the *tile*, so `selectedId` is a composite.** Two tiles here
              // carry one card id, and the pane's `selectedCardId` alone would ring both of a
              // printing the reader opened one of. Built through {@link tileKeyOf} rather than
              // spelled out, because the tile's own key is built by the same function and two
              // spellings that drifted would be a wall where nothing rings at all.
              selectedId={
                selectedCardId === null ? null : tileKeyOf(selectedCardId, paneFinish)
              }
              // The finish travels with the press, so the pane opens showing the object the
              // reader pointed at rather than the plain one. The tile is the second argument
              // because a tile here is a printing *and* a finish — see `CardGrid`'s `onSelect`,
              // which the other six walls ignore.
              onSelect={(cardId, tile) => openCardAsFinish(cardId, tile.finish)}
              // The same arrow-key walk the search wall takes, on the same terms: both slots
              // above reach the store the card pane reads, so a press moves the pane rather than
              // only an outline. The two walls that are a *page* pass this and the two that are
              // a panel do not — `CardGrid`'s `arrowNav` is where that split is argued.
              //
              // **What the caret note is filed under is still the card**, not the tile key:
              // `CardGrid` hands `keepCaretForCard` the printing because `CardDetailPane` reads
              // the note back by the card it was opened on, so a note filed under `c1:foil`
              // would break this wall's walk after exactly one step.
              arrowNav
              onNeedNextPage={onNeedNextPage}
              // The same mark search draws, and only the mark: the corner and the felt
              // behind it are the wall's, so the two views cannot drift into two shades.
              // No `wishlisted` — this wall shows what is owned and has no opinion about
              // what is wanted. A tile at zero copies draws nothing, which is the badge's
              // own guard and the reason this view no longer has a badge of its own.
              badge={(tile) => <OwnedBadge owned={tile.copies} />}
              // What one copy of this printing **in this finish** costs. Already on the row and
              // priced at that entry's exact finish by `collection.rs`; the wall simply never
              // drew it. `formatPrice` and never a bare `Intl.NumberFormat`, and a `null` is the
              // em dash rather than a reason to borrow another marketplace's number.
              money={(tile) => formatPrice(tile.unitPrice, marketplace.currency)}
              // The sheen over the art and the glyph in the chin, which is the *other* half of
              // what tells a reader the two tiles of one printing apart.
              //
              // **`nonfoil` is mapped to `null`, and that is not a tidy-up** — {@link finishMarkOf}
              // is where that argument lives, and it is a named function rather than the inline
              // expression this slot held until the stepper below started announcing the same fact
              // in words.
              finish={finishMarkOf}
              // **Only while flattened**, which is the one state where a tile cannot be read off
              // the level it is drawn on: with the filing ignored there is no breadcrumb saying
              // which drawer these are, so the caption has to say it per tile. Unset otherwise, so
              // the wall draws its own `SET · number` and this page spells that text exactly once
              // — in {@link captionFor}, which is the flattened line and nothing else.
              caption={flatten ? captionFor(folderNameOf) : undefined}
              /* **The wall's own stepper** (issue #284), standing in the tile's right margin
                 (issue #348). Until it landed this view could maintain quantities in its *table*
                 alone, which made the wall the layout a reader looked at and the table the one
                 they worked in.

                 **It rode in the bottom strip for its first two days and does not any more.** The
                 report was that neither the style nor the location matched the deck builder's, and
                 neither did: the deck stack draws a 36px column up the card's right-hand side and
                 this drew a 20px bar tucked into the bottom corner. It is the same control over
                 the same kind of object, so it is one recipe now — {@link CardGrid}'s `column`
                 slot is the position and `size="card"` the size, both of them the deck stack's,
                 and the wishlist's wall took the identical change in the same commit. It still
                 costs the wall no height: the box is absolute, so `tileHeight` is unchanged by its
                 existence, which was the strip's property and is inherited rather than re-argued.

                 **Absent is a real answer, not a fallback**: {@link stepperByTile} draws nothing
                 for a tile whose copies the reader may not step, and that is the fence rather than
                 an affordance — every rule about it is at that map's own site. */
              column={(tile) => {
                const step = stepperByTile.get(tile.key);
                if (step === undefined) return null;
                // The mark the art is drawing, read through the same function the chip above it
                // takes — so a plain tile is announced "Copies of Black Lotus" and never
                // "(Nonfoil)", which is the wall's own rule stated in words instead of in a sheen.
                const mark = finishMarkOf(tile);
                return (
                  // **`data-no-drag` is load-bearing and must not be dropped.** `NOT_A_DRAG`
                  // (`dnd.ts`) is `"[data-no-drag], input, select, textarea"`, so the stepper's
                  // `<input>` is excluded by tag and its two `<button>`s are not — and the whole
                  // tile is a drag source. Without this mark a press on `−` plus five pixels of
                  // travel is a drag of the card, and the press is never delivered as a click.
                  // `cardDraggable` asks `closest()`, so one mark on the wrapper covers both
                  // buttons; `DeckCardControls` carries the identical mark for the identical
                  // reason.
                  <span data-no-drag="" className="flex">
                    <QuantityStepper
                      // The deck stack's column, verbatim — the 36px box, standing on end, over
                      // art. `xs` and `card` are the two sizes drawn on a card face and both
                      // follow the reader's zoom through `--control-scale`; this is the larger.
                      // Against a 170px tile whose art box is 238px (5:7) the column rests at
                      // 30.6 × ~98.6px — 18% of the width and 41% of the height, starting 24px
                      // down — where on the deck's own 210 × 293 card it is 15% and 34%. Both are
                      // constants across the zoom ladder rather than readings at 1×, because the
                      // tile, the art and the column are each linear in the same zoom.
                      size="card"
                      orientation="vertical"
                      // Drawn over an illustration, and inside a box that clips its own corners —
                      // the deck stepper's two reasons, unchanged one surface over.
                      tone="art"
                      focus="inset"
                      // **The tile's sum, never the addressed row's own number.** `OwnedBadge`
                      // draws that same figure in the tile's other corner, and two numbers on one
                      // piece of art disagreeing about how many copies it stands for is not a
                      // state this wall may show. (They were six pixels apart while this rode in
                      // the bottom strip; the column has moved and the rule has not, because what
                      // makes it one is the tile rather than the distance.)
                      value={tile.copies}
                      // The copies this control cannot reach — see {@link stepperByTile}, where
                      // the arithmetic and the two behaviours that fall out of it are worked
                      // through. `0` on the ordinary single-entry tile, so zero deletes the entry
                      // exactly as the table's stepper does.
                      min={step.floor}
                      // **Name the object, not the control** — and the object is a *printing in a
                      // finish*, which is the whole of this wall's grain, so the name has to carry
                      // both or it is not a name.
                      //
                      // **The set and number are not decoration here, and a live pass is what
                      // proved it.** Driven in the browser (2026-09-01, Storybook's
                      // `SteppingFromTheWall` at 170px), the seed put three Lightning Bolt tiles on
                      // one screen — 2X2 ×4, LEA ×1 and an etched STA — and with the printing left
                      // out the first two both announced `Copies of Lightning Bolt`. A collection
                      // holds several printings of one card as a matter of course, far more often
                      // than a wishlist does, so that is the ordinary case rather than a corner:
                      // two controls with one name, on a surface where the only other thing
                      // distinguishing them is a picture. jsdom cannot referee it — both names are
                      // *correct*, they are merely not *unique*, and no assertion about one tile
                      // can see the other.
                      //
                      // {@link wishLabel}'s grammar exactly — `Name (SET 123)`, with the finish
                      // folded into the same bracket — because the wishlist's wall stands one tab
                      // away and reached this conclusion first. The chin under the art already
                      // draws `SET · number`, so the name says what the tile shows.
                      //
                      // The finish rides it **only where the tile wears a mark**: a plain copy
                      // draws no chip ({@link finishMarkOf}), so announcing `(Nonfoil)` would be
                      // the wall's own rule contradicted in words six pixels from where it is
                      // being obeyed in pixels.
                      label={
                        `Copies of ${tile.name} ` +
                        `(${tile.setCode.toUpperCase()} ${tile.collectorNumber}` +
                        `${mark === null ? "" : `, ${finishLabel(mark)}`})`
                      }
                      // **A delta applied to the addressed row**, because the control shows a sum
                      // and the write moves one entry: the reader asked for one more copy of this
                      // *object*, and the row this tile addresses is where that copy goes.
                      onChange={(next) =>
                        onSetQuantity(step.row, step.row.quantity + (next - tile.copies))
                      }
                    />
                  </span>
                );
              }}
              // The whole tile is the target: the art, its badge and the caption.
              cardMenu={tileMenu}
              cardMenuKey={tileMenuKey}
            />
          ) : (
            <>
              <CollectionTable
                rows={rows}
                total={total}
                listKey={collection.queryKeyString}
                sort={collection.sort}
                onSort={collection.toggleSort}
                onNeedNextPage={onNeedNextPage}
                onSetQuantity={onSetQuantity}
                onRemove={onRemove}
                // **The same fence the wall draws, said in words** (issue #284). It is one
                // predicate on this page rather than one per layout, because the table and the
                // wall are two drawings of one list and a row editable in one of them and not the
                // other is a difference no reader can account for. See {@link quantityBlocked},
                // which carries the three sentences and why the third names no mechanism.
                quantityBlocked={quantityBlocked}
                rowMenu={rowMenu}
                rowMenuKey={rowMenuKey}
                marketplace={marketplace}
              />
              {/* The one thing about this table a reader cannot see: **the stepper is the
                  removal**. Since schema v24 a row taken to zero is deleted rather than kept
                  (`collection::set_quantity`), and the stepper is `min={0}` — so a mis-added
                  four-copy row is got rid of by holding Decrease down, and there is no other
                  control in the table that does it. Said once, under the table, at the end of
                  the line the stepper itself lives on — not per row, where forty copies of a
                  sentence about a rare action would be louder than the rows. */}
              <p className="text-right text-[0.7rem] text-dim">
                To remove an entry, set its copies to zero.
              </p>
            </>
          ))}

        {/* **Spec §5: a price is never shown without saying how old it is** — and, with five
            marketplaces in the picker, whose it is. `pricesAsOf` answers both, and names which of
            the two clocks this marketplace runs on: the card-data sync for the blob-backed pair,
            the last price-feed refresh for the two this app downloads itself.

            **The rule reaches this wall as of 2026-08-26**, when the tiles' chins started quoting
            what one copy costs; before that the grid drew no money at all and had nothing to date.

            **Said once, under the wall, rather than on every tile** — the argument the search
            page, the Tags page, the printings modal and the deck's docked panel all make, and the
            reason the chin's money slot is a plain string rather than a tooltip binding: forty
            tiles would be one sentence said forty times.

            **Grid only.** The table states it in the Value column's own header (`CollectionTable`'s
            `columnsFor`), so drawing it here as well would say it twice in one view. Drawn rather
            than hung on a `title`, for the reason the card pane and `TheoryDiffDialog` decided the
            same way: a hover is not a reader. */}
        {!empty && view === "grid" && (
          <p className="shrink-0 text-[0.7rem] text-dim">{pricesAsOf(marketplace)}</p>
        )}
      </div>

      {/* The question a drop or a `Move to` asks when the art stands for more than one row.
          A **centred modal** rather than an anchored panel, which is `src/CLAUDE.md`'s rule for a
          surface that is *consulted* — and here it is also the only shape both doors can use: a
          drop has no opener element to anchor to, and the menu's panel has already closed by the
          time a row's handler runs.

          Keyed on what is being asked, because `PickCopies` seeds its ticks **mount-only**: two
          drops in a row onto different folders are two questions, and a panel that kept the first
          one's ticks would answer the second with the wrong rows. */}
      <Dialog
        open={picking !== null}
        title="Which copies?"
        closeLabel="Close the copy picker"
        size="w-[30rem]"
        onDismiss={() => setPicking(null)}
        onClose={() => setPicking(null)}
      >
        {picking !== null && (
          <PickCopies
            key={`${picking.entryIds.join(",")}:${String(picking.folderId)}`}
            cardName={picking.cardName}
            destination={folderNameOf(picking.folderId) ?? ROOT_LABEL}
            copies={pickChoices}
            onConfirm={(entryIds) => {
              // One write per copy, the loop `cardMenu.tsx`'s multi-picked `Move to` already
              // makes: `collection_set_folder` addresses one row, and it **merges** rather than
              // failing when the destination already holds the same eleven-column grain — so two
              // copies of one printing landing in one drawer become one row with the quantities
              // summed, which is the same thing that happens when the reader does it by hand.
              for (const entryId of entryIds) {
                setFolder.mutate({ entryId, folderId: picking.folderId });
              }
              setPicking(null);
            }}
            onCancel={() => setPicking(null)}
          />
        )}
      </Dialog>

      {/* Mounted unconditionally, the same shape every other dialog in this app is — `Dialog`
          itself renders nothing while closed, and staying in the tree is what lets its scrim
          fade out instead of the whole thing vanishing the instant `exporting` flips back. */}
      <ExportDialog
        open={exporting}
        subject="your collection"
        surface="collection"
        cards={exportScope.cards}
        suggestedFileName="collection"
        onDismiss={() => setExporting(false)}
        onClose={() => setExporting(false)}
        scope={{
          label: scopeLabel(exportScope.total, exportScope.everything, exportFiling),
          everythingLabel: everythingLabel(exportFiling),
          loading: exportScope.loading,
          everything: exportScope.everything,
          onEverything: exportScope.setEverything,
        }}
      />

      {/* One destination — the collection itself — so no destination radios are drawn: a
          choice between one thing is not a choice. `onDone`'s message is discarded, the same
          precedent `DeckEditor` and `DecksPage` set for their own import dialogs: the numbers
          are already on screen, in the preview the reader just committed. */}
      <ImportDialog
        destinations={[collectionDestination]}
        open={importing}
        onDismiss={() => setImporting(false)}
        onClose={() => setImporting(false)}
        onDone={() => setImporting(false)}
      />
    </section>
  );
}

/**
 * **The drawer boundary, asked about before a drag crosses it** — issue #365, design §5.
 *
 * The issue asked for "possibly with a warning" and *which* presses get one is the design's
 * decision, made on one line: a confirmation is worth its interruption where the destination can
 * be hit by **accident**, and worth nothing where the reader has just named it. A drop target is a
 * rectangle a pointer can land on by mistake, so a drag confirms; the card menu's
 * `Add to → <folder>` and the row's `Move to folder…` both carry the folder's name in the press
 * the reader made, so neither does.
 *
 * **It is not a refusal and must never read as one.** The issue is explicit that moving cards in
 * and out of a locked drawer is always allowed, and there is no Rust fence behind this at all —
 * `set_entry_folder` refuses a `deck` source and a non-`user` destination, and a locked folder is
 * a `user` folder on both counts. So the affirmative is the plain one and the way out is the quiet
 * one, which is the opposite weighting from a delete.
 *
 * **Three sentences rather than one with a slot in it**, because the three gestures are genuinely
 * different: out of a set-aside drawer puts a copy back among the ones the app offers, into one
 * takes it off that list, and between two of them does both. A shared sentence with the verb
 * swapped would be the shape that gets one of the three subtly wrong.
 *
 * **This app's confirmations carry no `dialog` or `alertdialog` role at all**, so a test or a CDP
 * pass finds this one by its text — the note `CollectionSearchTab`'s cross-deck question carries,
 * and this is built on that question's own recipe. The caret goes into the **question** rather
 * than onto a button in it: the reader has not decided yet and a stray Enter must not decide for
 * them. `useConfirmFocus` is what pairs the effect with the `tabIndex` that makes it possible —
 * `focus()` on a node with no `tabIndex` is a silent no-op — and its `className` is replaced here
 * rather than extended, exactly as that tab replaces it, because `CONFIRM_BOX` rules a question
 * off *under a row* and this one stands on its own. `FOCUS` is put back by hand, which is the one
 * thing that replacement would otherwise drop.
 */
function LockedMoveConfirm({
  move,
  onConfirm,
  onCancel,
}: {
  move: LockedMove;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { card, out, into } = move;
  const confirm = useConfirmFocus(
    out !== null && into !== null
      ? `Move ${card} from ${out} into ${into}`
      : out !== null
        ? `Move ${card} out of ${out}`
        : `Move ${card} into ${into ?? ROOT_LABEL}`,
  );

  return (
    <div
      {...confirm}
      className={cn(
        "rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5",
        FOCUS,
      )}
    >
      <p className="text-xs leading-relaxed text-destructive">
        {out !== null && into !== null
          ? `“${out}” and “${into}” are both locked. Moving “${card}” takes it out of one drawer you have set aside and into another.`
          : out !== null
            ? `“${out}” is locked. Moving “${card}” out puts that copy back among the ones this app offers you.`
            : `“${into}” is locked. Filing “${card}” there sets that copy aside.`}
      </p>

      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" onClick={onConfirm} className={CONFIRM_DESTRUCTIVE}>
          Move it
        </button>
        <button type="button" onClick={onCancel} className={CONFIRM_CANCEL}>
          Leave it there
        </button>
      </div>
    </div>
  );
}

/**
 * The question a reader will guess wrong, and the sentence that answers it.
 *
 * **Deleting a folder does not delete the cards in it.** `delete_folder` re-files the sub-tree by
 * hand before the row goes and `collection_entries.folder_id` is `ON DELETE SET NULL` behind it,
 * so the copies surface at the root — with their condition, their purchase price and their
 * acquisition story, still owned, still counted. `collection_folders.parent_id` is
 * `ON DELETE CASCADE` **on itself**, so the folders inside *do* go. The two cascades point
 * opposite ways and the confirmation says both, in that order: the reassuring half first, because
 * the fear is what stops the press.
 *
 * One sentence rather than the deck gallery's counted pair: a folder card's own face already says
 * how many copies are in the drawer, in the recursive number this page summed for it, so a
 * confirmation repeating it would be the same figure twice with two chances to disagree.
 */
function DeleteFolderConfirm({
  name,
  pending,
  onConfirm,
  onCancel,
  onClose,
}: {
  name: string;
  pending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  // The caret moves into the layer, as it does for every other one in the app, so Escape has
  // something to hand back and Tab reaches the two answers next.
  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  return (
    <div
      ref={panelRef}
      tabIndex={-1}
      role="group"
      aria-label={`Delete ${name}`}
      className={cn("rounded-md", FOCUS)}
      onBlur={(e) => {
        if (pending) return;
        if (!panelRef.current?.contains(e.relatedTarget)) onClose();
      }}
    >
      <p>Delete “{name}”?</p>
      <p className="mt-1 leading-relaxed text-dim">
        Its cards move back to your collection; folders inside it are deleted.
      </p>
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          onClick={onConfirm}
          disabled={pending}
          className={cn(
            "rounded-md border border-destructive px-2 py-1 text-destructive",
            "transition-colors duration-150 hover:bg-destructive hover:text-bg",
            "disabled:opacity-50 motion-reduce:transition-none",
            FOCUS,
          )}
        >
          Delete folder
        </button>
        <button
          type="button"
          onClick={onCancel}
          className={cn(
            "rounded-md border border-border px-2 py-1 text-dim",
            "transition-colors duration-150 hover:text-text motion-reduce:transition-none",
            FOCUS,
          )}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/**
 * The one line that says what the list area is currently showing, or nothing at all.
 *
 * **Where the reader is standing changes what an empty list means**, which is the whole of what
 * the third argument is for. An empty root is a collection nobody has added to and the sentence
 * names the two controls that fill it; an empty *folder* is a drawer the reader made and has not
 * filed anything in yet, and telling them how to add a card to a collection they already have is
 * answering a question they did not ask. And a level whose content is folder cards is not empty at
 * all — the cards are the content, so the line stays out of their way.
 */
function statusOf(
  collection: Collection,
  failure: string | null,
  { filed, inFolder }: { filed: boolean; inFolder: boolean },
): string {
  const { query, rows, activeCount } = collection;

  if (rows.length === 0) {
    if (failure) return failure;
    if (query.isPending) return "Reading your collection…";
    if (activeCount > 0) return "No cards in your collection match these filters.";
    // Drawers, and nothing loose beside them. The cards below are the answer to "what is here",
    // and a sentence over them would be the page contradicting itself.
    if (filed) return "";
    // Nothing filtered and nothing there: this is a statement about the collection, not
    // about the query. "No cards match" would blame the reader for a table nobody has put
    // anything in yet, and say nothing about how to — and the root's instruction would answer
    // the wrong question inside a folder they have just made.
    return inFolder
      ? "Nothing filed here yet."
      : "Nothing here yet. Add cards from search, or import a collection file.";
  }

  // With rows on screen the table captions itself and the header above counts it, so the
  // only thing left to say is that something is still on its way.
  if (query.isFetchingNextPage) return "Loading more…";
  if (query.isFetching) return "Updating…";
  return failure ?? "";
}
