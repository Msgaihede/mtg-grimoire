/**
 * **The folder panel** — the strip of questions drawn under the path row when a folder layer is
 * open that has no heading to be typed on: `Move to folder…`, `Delete…` and `Clear…`.
 *
 * **Out of `WishlistPage` since issue #557**, verbatim: the strip's markup and the questions it can
 * hold, each with its argument. The page still owns *which* layer is open (`Panel`) and every write
 * behind an answer; this file draws the question and hands the answer back. The collection's twin
 * is `CollectionFolderPanel`.
 *
 * **Memoised, and everything the page hands it is held still** — the pending flags, the census, a
 * name lookup and callbacks built once — so a render of the page that changes none of them does
 * not draw the strip again.
 */
import { memo, useEffect, useRef, type ReactNode } from "react";
import { MoveToFolder } from "@/features/decks/MoveToFolder";
import { plural } from "@/lib/counts";
import { FOCUS } from "@/lib/focus";
import { folderDescendants, type FolderNode } from "@/lib/folderTree";
import type { WishlistFolder } from "@/lib/ipc";
import { cn } from "@/lib/utils";

/**
 * What the top of the cabinet is called, here and in the two lists this page hands it to.
 *
 * `WishlistBreadcrumb` spells its own copy of this word, because a breadcrumb that had to be
 * told what its own first segment is called would be a component that does not know what it is
 * drawing. This one is the *page's* copy, for the two places the page has to say it: the optimise
 * dialog's scope, and `MoveToFolder`'s top row — whose default is the deck
 * gallery's "All decks", which is the wrong sentence to show a reader filing a card they are
 * buying.
 *
 * **Exported from here since issue #557**, where `MoveToFolder` is drawn now; the page imports it
 * for the optimise dialog's scope and its own folder names. One spelling for both files.
 */
export const ROOT_LABEL = "Wishlist";

/** The members of the page's `Panel` that are drawn in this strip — naming and renaming are drawn
 *  on a heading. */
export type StripPanel =
  | { kind: "moveFolder"; folderId: number }
  | { kind: "deleteFolder"; folderId: number }
  | { kind: "clearFolder"; folderId: number };

export const WishFolderPanel = memo(function WishFolderPanel({
  panel,
  nodes,
  census,
  directWishes,
  summaryAnswered,
  folderNameOf,
  movePending,
  deletePending,
  clearPending,
  onMoveFolder,
  onDeleteFolder,
  onDeleteFolderWithWishes,
  onClearFolder,
  onCancel,
  onClose,
}: {
  /** The question on screen. */
  panel: StripPanel;
  /** The reader's drawers only — a deck's managed folder takes no sub-folder. */
  nodes: readonly FolderNode<WishlistFolder>[];
  /** Every folder, flat — where a folder's parent, descendants and children are read. */
  census: readonly WishlistFolder[];
  /** The folder summary's rows, direct per folder — `useWishlistFolders`' `summary`. */
  directWishes: ReadonlyMap<number, { wishes: number }>;
  /** Whether that summary has answered — a missing row means "none" only once it has. */
  summaryAnswered: boolean;
  /** What to call a folder — the page's lookup. */
  folderNameOf: (id: number | null) => string | null;
  movePending: boolean;
  /** Either delete in flight. */
  deletePending: boolean;
  clearPending: boolean;
  /** `Move to folder…`, answered — the folder and where it goes. */
  onMoveFolder: (folderId: number, parentId: number | null) => void;
  /** `Delete folder`, confirmed. */
  onDeleteFolder: (folderId: number) => void;
  /** `Delete folder and cards`, confirmed. */
  onDeleteFolderWithWishes: (folderId: number) => void;
  /** `Clear folder`, confirmed. */
  onClearFolder: (folderId: number) => void;
  /** The keyboard way out — Escape and Cancel, which hand the caret back (`dismiss`). */
  onCancel: () => void;
  /** The click-away way out, which does not (`close`). */
  onClose: () => void;
}) {
  return (
    <>
      {/* **One strip for the folder layers that are still layers, and it is not a placement
          decision so much as the only place there is.** Every other anchored layer in this app
          hangs off a `relative` wrapper around its own trigger; the trigger here is a heading's
          `⋯`, and a heading has nowhere to hang a panel — one that hosted one would also clip it
          against the scroller below. So the strip sits directly beneath the path row (spec
          §3.5).

          **Naming a folder and renaming one are drawn *in the wall*** — on the new folder's own
          heading, or on the heading being renamed — because in both cases the thing being named
          has a heading of its own on screen, and a second bordered box above the wall could only
          repeat what that heading already says. Moving and deleting have no such place: the
          answer to "into which folder" is a list of the *other* folders, and the answer to
          "delete this?" is a sentence about what happens to the wishes inside. Neither fits on a
          40px heading, and neither is a name typed on a line. Clearing joined them on the second
          argument: "clear this?" is a sentence about which wishes go. */}
      <div className="w-full max-w-sm shrink-0 rounded-lg border border-border bg-surface p-2 text-xs">
        {panel.kind === "moveFolder" && (
          <MoveToFolder
            label={`Move ${folderNameOf(panel.folderId) ?? "folder"} into a folder`}
            // The reader's drawers only: a deck's managed folder takes no sub-folder.
            nodes={nodes}
            currentId={census.find((f) => f.id === panel.folderId)?.parentId ?? null}
            // The wishlist's own word for the top level. `MoveToFolder` defaults to the deck
            // gallery's, which is the surface it was written for.
            rootLabel={ROOT_LABEL}
            // A folder may not go inside itself or inside anything it holds. The backend
            // refuses it in words — `wishlist_folders.parent_id` cascades onto itself, so a
            // cycle is a graph SQLite would walk forever the day the folder is deleted — and
            // that refusal is a fence rather than the affordance.
            forbidden={new Set([panel.folderId, ...folderDescendants(census, panel.folderId)])}
            forbiddenReason="A folder cannot go inside itself, or inside anything it holds."
            // Drawn **into** the strip rather than as a popup of its own: the strip is the
            // layer, and a second box with its own shadow and its own z-index over it would
            // be a second Escape rung for one decision.
            inline
            pending={movePending}
            onPick={(parentId) => onMoveFolder(panel.folderId, parentId)}
            onClose={onClose}
          />
        )}

        {panel.kind === "deleteFolder" && (
          <DeleteFolderConfirm
            name={folderNameOf(panel.folderId) ?? "this folder"}
            // Either answer in flight holds both buttons: a second press while the first is
            // on its way would be a different write racing it to the same folder.
            pending={deletePending}
            onConfirm={() => onDeleteFolder(panel.folderId)}
            onConfirmWithWishes={() => onDeleteFolderWithWishes(panel.folderId)}
            onCancel={onCancel}
            onClose={onClose}
          />
        )}

        {panel.kind === "clearFolder" && (
          <ClearFolderConfirm
            name={folderNameOf(panel.folderId) ?? "this folder"}
            // Direct, the summary's own grain and exactly what a clear takes — and `null`
            // until the summary has answered, rather than a `0` it has not said.
            wishes={summaryAnswered ? (directWishes.get(panel.folderId)?.wishes ?? 0) : null}
            hasChildren={census.some((f) => f.parentId === panel.folderId)}
            pending={clearPending}
            onConfirm={() => onClearFolder(panel.folderId)}
            onCancel={onCancel}
            onClose={onClose}
          />
        )}
      </div>
    </>
  );
});

/** A destructive answer in a folder question — outlined in the destructive colour, filled on
 *  hover, and dimmed while a write is in flight. */
const DESTRUCTIVE_ANSWER = cn(
  "rounded-md border border-destructive px-2 py-1 text-destructive",
  "transition-colors duration-150 hover:bg-destructive hover:text-bg",
  "disabled:opacity-50 motion-reduce:transition-none",
  FOCUS,
);

/** The way out of a folder question, which is never disabled — backing out is always possible. */
const CANCEL_ANSWER = cn(
  "rounded-md border border-border px-2 py-1 text-dim",
  "transition-colors duration-150 hover:text-text motion-reduce:transition-none",
  FOCUS,
);

/**
 * What every destructive question about a folder shares: the layer, the question, the
 * sentence under it, and `Cancel` after whatever answers the caller draws.
 *
 * **One shell because the two questions are one layer**, and a focus or blur rule that reached one
 * of them and not the other would be the strip behaving two ways for one reason no reader could
 * name. The caret moves into the layer as it does for every other one in the app, so Escape has
 * something to hand back and Tab reaches the answers next; a click away closes it without taking
 * the caret back (`close`, not `dismiss` — the reader is already somewhere else), **except while
 * a write is in flight**, so the press that is on its way is not stranded with nothing on screen
 * saying so.
 *
 * The answer row wraps: the strip is `max-w-sm` and never wider, and three buttons are a row of
 * fixed-width controls that has to survive the narrowest box it is drawn in.
 */
function FolderQuestion({
  label,
  question,
  explanation,
  pending,
  onCancel,
  onClose,
  children,
}: {
  label: string;
  question: string;
  explanation: string;
  pending: boolean;
  onCancel: () => void;
  onClose: () => void;
  /** The destructive answers, in the order they are offered. */
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  return (
    <div
      ref={panelRef}
      tabIndex={-1}
      role="group"
      aria-label={label}
      className={cn("rounded-md", FOCUS)}
      onBlur={(e) => {
        if (pending) return;
        if (!panelRef.current?.contains(e.relatedTarget)) onClose();
      }}
    >
      <p>{question}</p>
      <p className="mt-1 leading-relaxed text-dim">{explanation}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        {children}
        <button type="button" onClick={onCancel} className={CANCEL_ANSWER}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/**
 * The question a reader will guess wrong, and the sentence that answers it — which now has two
 * answers.
 *
 * **Deleting a folder does not have to delete the wishes in it.** `Delete folder` sets
 * `wishlist_entries.folder_id` to `NULL`, so they surface at the root — filed nowhere and otherwise
 * exactly as they were, still on the shopping list, still counted. `Delete folder and wishes`
 * takes them too, every wish anywhere in the sub-tree (issue #471). `wishlist_folders.parent_id`
 * is `ON DELETE CASCADE` **on itself**, so the folders inside go on either press. The sentence
 * says all of it in one breath, the reassuring half first, because the fear is what stops the
 * press — and the second button sits *after* the first so the answer that loses nothing is still
 * the one a reader meets first.
 *
 * One sentence rather than the deck gallery's counted pair, because the two lists are counted
 * differently: a folder's own heading already says how many wishes are in the drawer, in the
 * recursive number this page summed for it, so a confirmation repeating it would be the same
 * figure twice with two chances to disagree. That recursive number is also exactly what the
 * second button takes, so it needs no restating either.
 */
function DeleteFolderConfirm({
  name,
  pending,
  onConfirm,
  onConfirmWithWishes,
  onCancel,
  onClose,
}: {
  name: string;
  /** Either delete in flight — both buttons are held while one is on its way. */
  pending: boolean;
  onConfirm: () => void;
  onConfirmWithWishes: () => void;
  onCancel: () => void;
  onClose: () => void;
}) {
  return (
    <FolderQuestion
      label={`Delete ${name}`}
      question={`Delete “${name}”?`}
      explanation={
        "Its cards can go back to your wishlist or be deleted. Subfolders are always deleted."
      }
      pending={pending}
      onCancel={onCancel}
      onClose={onClose}
    >
      <button type="button" onClick={onConfirm} disabled={pending} className={DESTRUCTIVE_ANSWER}>
        Delete folder
      </button>
      <button
        type="button"
        onClick={onConfirmWithWishes}
        disabled={pending}
        className={DESTRUCTIVE_ANSWER}
      >
        Delete folder and cards
      </button>
    </FolderQuestion>
  );
}

/**
 * Emptying a folder, and keeping it — the wishes filed **directly** in it go, and nothing else.
 *
 * **Unlike {@link DeleteFolderConfirm}, this one states its number**, and the argument there is
 * the reason here, read the other way. The heading carries the *recursive* total, and this
 * press takes only the direct wishes — so on a drawer with sub-folders the two numbers differ,
 * and the number this press will actually take is new information a reader cannot get from the
 * heading. `wishes` is `null` while the summary has not answered, and the sentence then says which
 * wishes without guessing how many.
 *
 * **The sub-folders are named only where there are some.** They keep their wishes — a clear is
 * the level on screen, not the tree under it — and saying so over a drawer that holds no drawers
 * would be answering a question nobody could have asked.
 */
function ClearFolderConfirm({
  name,
  wishes,
  hasChildren,
  pending,
  onConfirm,
  onCancel,
  onClose,
}: {
  name: string;
  /** The wishes filed directly in the folder, or `null` before the summary has answered. */
  wishes: number | null;
  hasChildren: boolean;
  pending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  onClose: () => void;
}) {
  const direct =
    wishes === null
      ? "Cards in this folder are removed from your wishlist."
      : wishes === 0
        ? // Reachable only when the summary answered after the question opened, since the menu
          // row greys at zero — but an honest sentence costs one line and "Its 0 cards will be
          // removed" is not one.
          "This folder has no cards of its own."
        : `Its ${plural(wishes, "card")} will be removed from your wishlist.`;

  return (
    <FolderQuestion
      label={`Clear ${name}`}
      question={`Clear “${name}”?`}
      explanation={hasChildren ? `${direct} Subfolders aren't affected.` : direct}
      pending={pending}
      onCancel={onCancel}
      onClose={onClose}
    >
      <button type="button" onClick={onConfirm} disabled={pending} className={DESTRUCTIVE_ANSWER}>
        Clear folder
      </button>
    </FolderQuestion>
  );
}
