/**
 * One export, {@link MoveToFolder}, and the one thing about it that is a fact about the *file*
 * rather than about the component.
 *
 * **It reads `folders.ts` and never `FolderTree.tsx`.** What it needs is the flattening and
 * the indent, and importing the tree component to get them would put the whole sidebar — and the
 * deck-drag registrations behind it — into `folderMenu`'s import graph, which is the cycle that
 * split this file out.
 *
 * **Two features share it now, and two of its props exist only because of that**: the deck
 * gallery, where it is a popup anchored to a tile, and the wishlist's edit panel, where it is a
 * list inside a panel that is already open. {@link MoveToFolder.inline} and
 * {@link MoveToFolder.rootLabel} are where those two differ, and each says at its own site why
 * the difference could not be left to the caller.
 */
import { useEffect, useRef } from "react";
import { Folder, Layers } from "lucide-react";
import { FOCUS } from "@/lib/focus";
import { LAYER } from "@/lib/layers";
import { cn } from "@/lib/utils";
import { flattenFolders, indent, type FolderNode } from "./folders";

const NOTHING_FORBIDDEN: ReadonlySet<number> = new Set();

/**
 * The destination list a deck, a folder or a wish is moved with — **the keyboard's half of the
 * drag.**
 *
 * A drag-only affordance is half a feature, and this is the other half: the same writes
 * (`deck_set_folder`, `deck_folder_move`, `wishlist_set_folder`) reached with the caret. `null`
 * is the top level and is an offer with a meaning rather than an omission — `DeckPatch` writes
 * every column with `coalesce(?n, column)`, so there is no patch that un-files a deck and this
 * list is the only way back to the root.
 */
export function MoveToFolder({
  label,
  nodes,
  currentId,
  rootLabel = "All decks",
  inline = false,
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
  /**
   * What the top-level row is called. Defaults to the deck gallery's own word, because that is
   * the surface this list was written for; the wishlist passes `"Wishlist"`.
   *
   * **A prop rather than a constant, because the top level is a different _thing_ in each
   * tree.** `null` here is not "no folder" — it is a real destination with a name the reader
   * already knows from somewhere else in the app, and the two names disagree: a deck's root is
   * the gallery, a wish's is the list itself. Told "All decks" while filing a card they are
   * buying, a reader is being told they are moving it into the deck gallery.
   */
  rootLabel?: string;
  /**
   * Draw the list **inside** whatever is already open instead of as a popup of its own.
   *
   * `false` — the default, and every deck-side call site — is the popup: pinned to its
   * trigger's right edge, its own width, its own box, its own layer. `true` is
   * `EditWish.tsx`'s panel, where the reader pressed `Move to folder…` and this list *replaced*
   * that panel's body: it is not a second layer, and drawing it as one would give one decision
   * two Escape rungs on a ladder ordered by registration.
   *
   * **A named mode rather than a `className` escape, because the properties involved stand or
   * fall together.** `absolute right-0 top-8`, `w-56`, the border, the background, the shadow and
   * the z-index are one statement — "I am a popup" — and no caller wants some of it: a list that
   * kept the anchor and lost the shadow is not a state anything is asking for. The alternative
   * shipped for a day, and it is why this is a prop: the wishlist panel un-styled this root from
   * the outside with `[&>[role=dialog]]:…` overrides, which made one feature depend on another's
   * internal DOM and would have handed the layer back, silently, the day this element gained a
   * wrapper — with nothing going red, because jsdom has no layout engine to notice.
   *
   * What it deliberately does **not** change is the role, the focus-on-mount or `onClose`: a
   * caller that draws this inline still has a list the caret moves into, and what "focus left
   * it" should mean there is that caller's question (`EditWish.tsx` answers it with nothing,
   * because the layer focus left is its own panel).
   */
  inline?: boolean;
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
      // the end of a row scrolls the whole app sideways. `inline` is the other mode and the box
      // is the whole of the difference: no anchor, no width of its own, no chrome, no layer —
      // it has been drawn into one that is already open. The padding stays either way, because
      // it is what insets a row's hover from the edge it is drawn against.
      className={cn(
        inline
          ? "w-full p-1"
          : "absolute right-0 top-8 w-56 rounded-lg border border-border bg-surface p-1 shadow-lg",
        !inline && LAYER.popup,
        FOCUS,
      )}
      onBlur={(e) => {
        if (pending) return;
        if (!panelRef.current?.contains(e.relatedTarget)) onClose();
      }}
    >
      <ul className="max-h-56 overflow-y-auto">
        {destination(null, rootLabel, 0)}
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
