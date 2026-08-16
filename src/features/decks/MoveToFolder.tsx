/**
 * One export, {@link MoveToFolder}, and the one thing about it that is a fact about the *file*
 * rather than about the component.
 *
 * **It reads `folders.ts` and never `FolderTree.tsx`.** This is a popup anchored to a tile,
 * not a sidebar: what it needs is the flattening and the indent, and importing the tree
 * component to get them would put the whole sidebar — and the deck-drag registrations behind it
 * — into `folderMenu`'s import graph, which is the cycle that split this file out.
 */
import { useEffect, useRef } from "react";
import { Folder, Layers } from "lucide-react";
import { FOCUS } from "@/lib/focus";
import { LAYER } from "@/lib/layers";
import { cn } from "@/lib/utils";
import { flattenFolders, indent, type FolderNode } from "./folders";

const NOTHING_FORBIDDEN: ReadonlySet<number> = new Set();

/**
 * The destination list a deck or a folder is moved with — **the keyboard's half of the drag.**
 *
 * A drag-only affordance is half a feature, and this is the other half: the same two writes
 * (`deck_set_folder`, `deck_folder_move`) reached with the caret. `null` is the top level and
 * is an offer with a meaning rather than an omission — `DeckPatch` writes every column with
 * `coalesce(?n, column)`, so there is no patch that un-files a deck and this list is the only
 * way back to the root.
 */
export function MoveToFolder({
  label,
  nodes,
  currentId,
  forbidden = NOTHING_FORBIDDEN,
  forbiddenReason = null,
  pending,
  onPick,
  onClose,
}: {
  /** The dialog's accessible name — "Move Burn to a folder". */
  label: string;
  nodes: readonly FolderNode[];
  /** Where it already is: offered, inert. Moving something where it already is writes nothing
   *  and bumps `updated_at` — `dropWrite`'s rule about a card dropped back in its own column. */
  currentId: number | null;
  /** Folders it may not go into — itself and its descendants, for a folder move. */
  forbidden?: ReadonlySet<number>;
  /** Why those are inert. Said once under the list rather than on each of them. */
  forbiddenReason?: string | null;
  pending: boolean;
  onPick: (folderId: number | null) => void;
  /** Focus left the layer on its own. Closes and hands nothing back. */
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const flat = flattenFolders(nodes);

  // The caret moves into the layer, as it does for every other one in the app, so Escape has
  // something to hand back and Tab reaches the destinations next.
  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  const destination = (id: number | null, name: string, depth: number) => {
    const inert = id === currentId || (id !== null && forbidden.has(id));
    return (
      <li key={id ?? "root"}>
        <button
          type="button"
          disabled={inert || pending}
          onClick={() => onPick(id)}
          style={indent(depth)}
          className={cn(
            "flex w-full items-center gap-2 truncate rounded-md py-1.5 pr-2 text-left text-xs",
            "transition-colors duration-150 motion-reduce:transition-none",
            "hover:bg-surface hover:text-text disabled:opacity-40 disabled:hover:bg-transparent",
            inert ? "text-dim" : "text-text",
            FOCUS,
          )}
        >
          {id === null ? (
            <Layers className="size-3.5 flex-none" aria-hidden="true" />
          ) : (
            <Folder className="size-3.5 flex-none" aria-hidden="true" />
          )}
          <span className="min-w-0 flex-1 truncate">{name}</span>
          {id === currentId && <span className="flex-none text-[0.7rem] text-dim">Here now</span>}
        </button>
      </li>
    );
  };

  return (
    <div
      ref={panelRef}
      tabIndex={-1}
      role="dialog"
      aria-label={label}
      // A press in here is a press on a control, never the start of a drag of the tile this
      // panel is anchored inside.
      data-no-drag=""
      // Anchored to its trigger and pinned to the trigger's **right** edge, not portalled:
      // the shipped CSP is `style-src 'self'` and every overlay primitive in reach injects a
      // runtime <style>, and nothing clips these popups — one opening leftward from a tile at
      // the end of a row scrolls the whole app sideways.
      className={cn(
        "absolute right-0 top-8 w-56 rounded-lg border border-border bg-surface p-1 shadow-lg",
        LAYER.popup,
        FOCUS,
      )}
      onBlur={(e) => {
        if (pending) return;
        if (!panelRef.current?.contains(e.relatedTarget)) onClose();
      }}
    >
      <ul className="max-h-56 overflow-y-auto">
        {destination(null, "All decks", 0)}
        {flat.map((node) => destination(node.folder.id, node.folder.name, node.depth + 1))}
      </ul>
      {forbiddenReason && (
        <p className="border-t border-border px-2 pb-1 pt-1.5 text-[0.7rem] leading-relaxed text-dim">
          {forbiddenReason}
        </p>
      )}
    </div>
  );
}
