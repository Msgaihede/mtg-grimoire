/**
 * **The folder panel** — the strip of questions drawn above the wall when a folder layer is open
 * that has no heading to be typed on: `Move to folder…`, `Delete…`, `Clear…` inside `Recently
 * removed`, and `Remove N cards from collection…` — and the drag's question about a set-aside drawer
 * (`LockedMoveConfirm`), which is drawn in the same column for the same reason.
 *
 * **Out of `CollectionPage` since issue #557**, verbatim: the strip's markup, the four confirmations
 * it can hold and the lock's question, each with its argument. The page still owns *which* layer is
 * open (`Panel`) and every write behind an answer; this file draws the question and hands the answer
 * back. The wishlist's twin is `WishFolderPanel`.
 *
 * **Memoised, and everything the page hands it is held still** — a pending flag, a name lookup, the
 * rows, and callbacks built once — so a render of the page that changes none of them (a keystroke
 * in the filter box, a write's re-read landing elsewhere) does not draw the strip again.
 */
import { memo, useEffect, useRef } from "react";
import { CONFIRM_CANCEL, CONFIRM_DESTRUCTIVE, useConfirmFocus } from "@/features/decks/metaRows";
import { MoveToFolder } from "@/features/decks/MoveToFolder";
import { plural } from "@/lib/counts";
import { FOCUS } from "@/lib/focus";
import { folderDescendants, type FolderNode } from "@/lib/folderTree";
import type { CollectionFolder, CollectionRow } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import type { LockedMove } from "./useCollectionDrops";

/**
 * What the top of the cabinet is called, in the two places this page has to say it —
 * `MoveToFolder`'s top row, and the sentence a new folder's field prints about where it will land.
 *
 * `CollectionBreadcrumb` spells its own copy of this word, because a breadcrumb that had to be
 * told what its own first segment is called would be a component that does not know what it is
 * drawing. `MoveToFolder` defaults to the deck gallery's "All decks", which is the wrong sentence
 * to show a reader filing a copy they own.
 *
 * **Exported from here since issue #557**, because three files say it now: the page, this panel's
 * `MoveToFolder` and lock question, and `useCollectionDrops`' picker sentence. One spelling, so the
 * three cannot drift into two words for one place.
 */
export const ROOT_LABEL = "Collection";

/** The members of the page's `Panel` that are drawn in this strip — the rest are drawn on a
 *  heading (`newFolder`, `renameFolder`) or are a `Dialog` of their own (`editCopy`). */
export type StripPanel =
  | { kind: "moveFolder"; folderId: number }
  | { kind: "deleteFolder"; folderId: number }
  | { kind: "clearRemoved" }
  | { kind: "removeCopies"; entryIds: readonly number[] };

export const CollectionFolderPanel = memo(function CollectionFolderPanel({
  panel,
  nodes,
  userFolders,
  rows,
  removedCards,
  folderNameOf,
  movePending,
  removePending,
  clearPending,
  removeManyPending,
  onMoveFolder,
  onDeleteFolder,
  onClearRemoved,
  onRemoveCopies,
  onCancel,
  onClose,
}: {
  /** The question on screen. */
  panel: StripPanel;
  /** The reader's tree, which `MoveToFolder` offers as destinations. */
  nodes: readonly FolderNode<CollectionFolder>[];
  /** The reader's own drawers — where a moved folder's current parent is read. */
  userFolders: readonly CollectionFolder[];
  /** The rows on screen, which `removeCopies` states its numbers from. */
  rows: readonly CollectionRow[];
  /** The copies in `Recently removed`, or `null` before the summary has answered. */
  removedCards: number | null;
  /** What to call a folder — the page's lookup. */
  folderNameOf: (id: number | null) => string | null;
  movePending: boolean;
  removePending: boolean;
  clearPending: boolean;
  removeManyPending: boolean;
  /** `Move to folder…`, answered — the folder and where it goes. */
  onMoveFolder: (folderId: number, parentId: number | null) => void;
  /** `Delete…`, confirmed. */
  onDeleteFolder: (folderId: number) => void;
  /** `Clear…`, confirmed. */
  onClearRemoved: () => void;
  /** `Remove N cards…`, confirmed — the entries the menu reached. */
  onRemoveCopies: (entryIds: readonly number[]) => void;
  /** The keyboard way out — Escape and Cancel, which hand the caret back (`dismiss`). */
  onCancel: () => void;
  /** The click-away way out, which does not (`close`). */
  onClose: () => void;
}) {
  return (
    <>
      {/* **One strip for the two folder layers that are still layers, and it is not a placement
          decision so much as the only place there is.** Every other anchored layer in this app
          hangs off a `relative` wrapper around its own trigger; the trigger here is a heading's
          `⋯`, and a heading in a virtualised wall has nowhere to hang a panel. So the strip sits
          where the thing being moved or deleted is: directly above the wall, under the path row
          that says which level it is.

          **Naming and renaming are drawn on the heading itself**; moving and deleting have no
          line of their own to be typed on — the answer to "into which folder" is a list of the
          *other* folders, and the answer to "delete this?" is a sentence about what happens to
          the cards inside. */}
      <div className="w-full max-w-sm shrink-0 rounded-lg border border-border bg-surface p-2 text-xs">
        {panel.kind === "moveFolder" && (
          <MoveToFolder
            label={`Move ${folderNameOf(panel.folderId) ?? "folder"} into a folder`}
            nodes={nodes}
            currentId={userFolders.find((f) => f.id === panel.folderId)?.parentId ?? null}
            // The collection's own word for the top level. `MoveToFolder` defaults to the deck
            // gallery's, which is the surface it was written for.
            rootLabel={ROOT_LABEL}
            // A folder may not go inside itself or inside anything it holds. The backend
            // refuses it in words — `collection_folders.parent_id` cascades onto itself, so a
            // cycle is a graph SQLite would walk forever the day the folder is deleted — and
            // that refusal is a fence rather than the affordance.
            forbidden={new Set([panel.folderId, ...folderDescendants(userFolders, panel.folderId)])}
            forbiddenReason="A folder cannot go inside itself, or inside anything it holds."
            // Drawn **into** the strip rather than as a popup of its own: the strip is the
            // layer, and a second box with its own shadow and its own z-index over it would be
            // a second Escape rung for one decision.
            inline
            pending={movePending}
            onPick={(parentId) => onMoveFolder(panel.folderId, parentId)}
            onClose={onClose}
          />
        )}

        {panel.kind === "deleteFolder" && (
          <DeleteFolderConfirm
            name={folderNameOf(panel.folderId) ?? "this folder"}
            pending={removePending}
            onConfirm={() => onDeleteFolder(panel.folderId)}
            onCancel={onCancel}
            onClose={onClose}
          />
        )}

        {/* The wishlist's `Clear…` (issue #471) one cabinet over, and in this strip for its
            reason: "clear this?" is a sentence about which cards go, and it fits on no tile.
            A refusal leaves the question open and the banner under the header says why —
            the folder delete's behaviour, since the two share that banner. */}
        {panel.kind === "clearRemoved" && (
          <ClearRemovedConfirm
            cards={removedCards}
            pending={clearPending}
            onConfirm={onClearRemoved}
            onCancel={onCancel}
            onClose={onClose}
          />
        )}

        {/* `Remove N cards from collection…` (issue #555) — the card menu's press over more
            than one entry, asked here for `Clear…`'s reason: "remove these?" is a sentence
            about which cards go, and the menu that raised it has already closed. A refusal
            leaves the question open and the banner under the header says why. */}
        {panel.kind === "removeCopies" && (
          <RemoveCopiesConfirm
            {...removalFacts(rows, panel.entryIds)}
            pending={removeManyPending}
            onConfirm={() => onRemoveCopies(panel.entryIds)}
            onCancel={onCancel}
            onClose={onClose}
          />
        )}
      </div>
    </>
  );
});

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
export function LockedMoveConfirm({
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
      className={cn("rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5", FOCUS)}
    >
      <p className="text-xs leading-relaxed text-destructive">
        {out !== null && into !== null
          ? `“${out}” and “${into}” are both locked. Move “${card}” anyway?`
          : out !== null
            ? `“${out}” is locked. Moving “${card}” out makes it available to your decks again.`
            : `“${into}” is locked. Cards filed there aren't used by your decks.`}
      </p>

      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" onClick={onConfirm} className={CONFIRM_DESTRUCTIVE}>
          Move it
        </button>
        <button type="button" onClick={onCancel} className={CONFIRM_CANCEL}>
          Cancel
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
 * One sentence rather than the deck gallery's counted pair: the folder's heading already says how
 * many copies are in the drawer, in the recursive number this page summed for it, so a
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
      // No `FOCUS`: a landing pad, not a control — the `tabIndex` above is there only so the
      // caret has somewhere to go when the confirmation opens, and neither Tab nor an arrow
      // reaches this box. Its two buttons keep theirs. `packages/ui/lib/focus.ts` has the rule.
      className={cn("rounded-md")}
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
 * Emptying `Recently removed` — issue #506, and the one question on this page whose answer takes
 * copies out of the collection rather than moving them around inside it.
 *
 * **It states its number, where {@link DeleteFolderConfirm} does not**, and the difference is the
 * one the wishlist's `ClearFolderConfirm` draws: a delete moves the cards somewhere the reader can
 * still find them, so the figure on the folder's heading is reassurance enough, but a clear *ends*
 * them, and a reader deciding whether to lose forty cards should read "40" in the sentence they
 * are answering. `cards` is `null` before the summary has answered, and the sentence then says
 * which cards without guessing how many.
 *
 * **"This cannot be undone" is literally true and so it is said**: `collection_removed_clear`
 * deletes the rows, and the holding area is the only place a copy goes on its way *out* — there
 * is no second holding area behind it.
 *
 * `DeleteFolderConfirm`'s landing pad, blur rule and buttons verbatim, so the two questions this
 * strip can ask behave identically under the caret.
 */
function ClearRemovedConfirm({
  cards,
  pending,
  onConfirm,
  onCancel,
  onClose,
}: {
  /** The copies filed in `Recently removed`, or `null` before the summary has answered. */
  cards: number | null;
  pending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  const which =
    cards === null
      ? "every card in Recently removed"
      : cards === 1
        ? "the 1 card in Recently removed"
        : `all ${cards.toLocaleString("en")} cards in Recently removed`;

  return (
    <div
      ref={panelRef}
      tabIndex={-1}
      role="group"
      aria-label="Clear Recently removed"
      // No `FOCUS`, {@link DeleteFolderConfirm}'s reason: a landing pad, not a control.
      className={cn("rounded-md")}
      onBlur={(e) => {
        if (pending) return;
        if (!panelRef.current?.contains(e.relatedTarget)) onClose();
      }}
    >
      <p>Remove {which} from your collection?</p>
      <p className="mt-1 leading-relaxed text-dim">This cannot be undone.</p>
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
          Clear Recently removed
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
 * What {@link RemoveCopiesConfirm} says about the rows it is asking about, read off the list the
 * menu was built from: how many entries, how many copies they hold, and the card's name when they
 * are all one card.
 *
 * **`copies` is `null` when a row is not in the list**, rather than a sum short by that row — a
 * refetch or another window can take a row out from under an open question, and a number that
 * quietly undercounts is worse than a sentence that does not state one. The entry count is the
 * ids', which is what the menu row said and what the write is sent.
 */
function removalFacts(
  rows: readonly CollectionRow[],
  entryIds: readonly number[],
): { entries: number; copies: number | null; name: string | null } {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const found = entryIds.flatMap((id) => {
    const row = byId.get(id);
    return row === undefined ? [] : [row];
  });
  const whole = found.length === entryIds.length;
  const names = new Set(found.map((row) => row.name));
  return {
    entries: entryIds.length,
    copies: whole ? found.reduce((sum, row) => sum + row.quantity, 0) : null,
    name: whole && names.size === 1 ? (found[0]?.name ?? null) : null,
  };
}

/**
 * `Remove N cards from collection…`, asked — issue #555, and the one question on this page a
 * **card menu** raises.
 *
 * **Asked only over more than one entry.** One entry is the copy the reader pointed at and the
 * press is the write; several is a tile standing for more rows than its art shows, or a picked
 * set, which is a press whose reach the reader cannot see from where they made it — the case a
 * confirmation is worth its interruption for (`LockedMoveConfirm`'s test, *can this be hit by
 * accident*, answered yes).
 *
 * **It states its numbers, {@link ClearRemovedConfirm}'s rule**: the entries in the sentence —
 * the unit the menu row counted in, so the question agrees with the row that raised it — and the
 * copies under it, which is what a reader thinks of as leaving the binder.
 *
 * **"You can undo this" is literally true and so it is said**, where the clear beside it says the
 * opposite: `collection_remove_many` answers a ticket, and the notice under the header offers it
 * back until a newer bulk write replaces it.
 *
 * **Weighted as a delete**: the plain affirmative is the destructive one and carries the count,
 * the way out is quiet. `ClearRemovedConfirm`'s landing pad, blur rule and buttons verbatim, so
 * every question this strip can ask behaves identically under the caret.
 */
function RemoveCopiesConfirm({
  entries,
  copies,
  name,
  pending,
  onConfirm,
  onCancel,
  onClose,
}: {
  /** How many `collection_entries` rows the press reaches — the menu row's own count. */
  entries: number;
  /** The copies those rows hold, or `null` when the list no longer carries every one of them. */
  copies: number | null;
  /** The card, when every row is one card — a wall tile's grades and languages. */
  name: string | null;
  pending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  const cards = plural(entries, "card");
  const held =
    copies === null
      ? null
      : `${plural(copies, "copy", "copies")}${name === null ? " in all" : ` of ${name}`}.`;

  return (
    <div
      ref={panelRef}
      tabIndex={-1}
      role="group"
      aria-label={`Remove ${cards} from your collection`}
      // No `FOCUS`, {@link DeleteFolderConfirm}'s reason: a landing pad, not a control.
      className={cn("rounded-md")}
      onBlur={(e) => {
        if (pending) return;
        if (!panelRef.current?.contains(e.relatedTarget)) onClose();
      }}
    >
      <p>Remove {cards} from your collection?</p>
      <p className="mt-1 leading-relaxed text-dim">
        {held === null ? "" : `${held} `}You can undo this.
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
          Remove {cards}
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
