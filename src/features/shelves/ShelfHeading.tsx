/**
 * One shelf's heading — the row above the cards filed directly in one folder. Spec §3.2.
 *
 * **It replaces the folder card and keeps that card's vocabulary rather than inventing one.** The
 * `⋯` is `CollectionFolderCard`'s trigger — named for its folder, `aria-haspopup="menu"` and no
 * `aria-expanded` — the drop marks are `dropMarks.ts`'s, the before/after line is `FolderDropLine`,
 * and a rename is `FolderNameField` with `useFolderFieldReturn` handing the caret back. What is new
 * is the arrangement: one 40px row rather than a 62px tile, because a heading sits over the cards it
 * names instead of in a band above them.
 *
 * **Dumb about the page, on purpose.** It formats no figure (`stat` arrives formatted), reads no
 * store and registers nothing itself: the drop target and the drag source arrive as callback refs
 * from `useShelfDrag.ts`, which the page calls. That keeps one component for two cabinets whose
 * payloads differ, and keeps every rule about *which* folder may take *what* on the page that owns
 * the tree.
 *
 * **The folder's name folds its shelf, and Open is a button at the row's right end** (issue #599).
 * Spec decision 6 had the name as the way *into* a folder, with no Open button; readers aimed at
 * the name to fold and were taken somewhere else, so the name now does what the chevron does —
 * hovering it lights the chevron, to say they are one control — and the way in is a ghost `→` at
 * the row's far right, after the `⋯`, so it stands in one column on every heading whatever else
 * that heading carries. **The lead segments still open their ancestors** — they are a path, not
 * this shelf, and each is underlined on hover as a link, where the name is not.
 *
 * **One thing it enforces whatever it is handed**: Add folder, Rename and the drag source exist only
 * on a reader's own folder (`kind === "folder"`), and Not sorted has no menu. A deck group with a
 * Rename button is a control that writes into a deck.
 *
 * **Indentation and rails are the grid's job, not this row's.** It fills the width its parent gives
 * it, so the page's row wrapper indents it by `shelf.indent`.
 */
import {
  Fragment,
  useCallback,
  type KeyboardEventHandler,
  type MouseEventHandler,
  type ReactElement,
} from "react";
import {
  ArrowRight,
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
  FolderPlus,
  Inbox,
  Layers,
  Lock,
  MoreHorizontal,
  Pencil,
} from "lucide-react";
import { CardImage } from "@/components/CardImage";
import { FolderDropLine } from "@/components/FolderDropLine";
import { FolderNameField, useFolderFieldReturn } from "@/components/FolderNameField";
import { Cards } from "@/components/icons";
import { useTooltip } from "@/components/tooltip/useTooltip";
import { DROP_EDGE, DROP_OVER } from "@/lib/dropMarks";
import { FOCUS } from "@/lib/focus";
import { cardImageUrl } from "@/lib/images";
import type { Shelf, ShelfKind } from "@/lib/shelves";
import { cn } from "@/lib/utils";
import { SHELF_CHEVRON, SHELF_ICON_BUTTON } from "./shelfButtons";
import { FOLD_PAUSED_LOOK } from "./ShelfToolbar";

/** Every mark a heading can wear during a drag — `useShelfDropTarget`'s answer, drawn here. */
export type ShelfDropMark = "none" | "armed" | "over" | "before" | "after" | "inside";

/**
 * How a page, a test or a live probe finds a heading's row — the value is the shelf's id, which is
 * what a scroll anchor needs to find the dragged heading again after the wall folds (spec §3.9).
 */
export const SHELF_HEADING_ATTR = "data-shelf-heading";

/** The most thumbnails a collapsed heading peeks at (spec §3.2: "three or four"). */
export const PEEK_LIMIT = 4;

export interface ShelfHeadingProps {
  shelf: Shelf;
  /** Already formatted by the page — `42 cards · $2,490.00`, or `3 of 42 cards` under a filter.
   *  `""` draws nothing (a folder still being named has no figures). */
  stat: string;
  /** Up to {@link PEEK_LIMIT}, drawn only while collapsed. */
  peek: readonly { cardId: string; name: string }[];
  /** The chevron and the folder's own name — both fold the shelf (issue #599). */
  onToggle: () => void;
  /** The Open button at the row's right end, and every lead segment. */
  onOpen: (folderId: number) => void;
  /** Absent ⇒ no Add folder button. Ignored on anything but a reader's own folder. */
  onAddFolder?: () => void;
  /** Absent ⇒ no Rename button. Ignored on anything but a reader's own folder. */
  onRename?: () => void;
  renaming?: {
    initial: string;
    onCommit: (name: string) => void;
    onCancel: () => void;
    /** The write is in flight — `FolderNameField` holds the field open and greys the tick. */
    pending?: boolean;
    /** `"create"` names a folder that does not exist yet (spec §3.8). Default `"rename"`. */
    mode?: "rename" | "create";
  };
  /** From `useContextMenu`; absent ⇒ no ⋯. Ignored on Not sorted. */
  menu?: {
    onContextMenu: MouseEventHandler;
    onKeyDown: KeyboardEventHandler;
    onClick: MouseEventHandler;
  };
  /** Card + folder drop target, wired by the page (`useShelfDropTarget().attach`). Must be a
   *  stable callback: a new identity re-registers the target. */
  dropRef?: (el: HTMLElement | null) => void;
  dropMark?: ShelfDropMark;
  /** Folder drag source (`useShelfDragSource`); absent ⇒ not draggable. Stable, as above. */
  dragRef?: (el: HTMLElement | null) => void;
  /**
   * Why folding is refused right now — `FOLD_PAUSED_REASON` while a filter is on (spec §3.4).
   * Set, the chevron is `aria-disabled` (never `disabled`: it keeps its tab stop, so the reason is
   * reachable by keyboard), carries the reason as its description and as its tooltip, and a press
   * calls nothing. Its name and `aria-expanded` go on saying what the shelf is. **The title folds
   * too, so it is refused the same way** — `aria-disabled` and the reason as its description —
   * but keeps its colour and its clipped-name tooltip: dimming every folder's name under every
   * filter would cost the wall its legibility to say what the chevron already says. Nothing else
   * on the row is about folding, so nothing else changes. Absent is the row exactly as before.
   */
  foldPaused?: string;
}

/** A callback ref as this row calls it: the element in, and whatever React 19 allows back out. */
type AttachElement = (element: HTMLElement | null) => unknown;

/**
 * The heading level for a shelf: one level per level of nesting, under the page's own `sr-only`
 * `h2` — reader's shelves from `h3`, app-owned ones from `h4` because they sit under a
 * `ShelfLabel` `h3` — and capped at `h6`, which is as deep as ARIA goes.
 */
export function headingLevel(shelf: Pick<Shelf, "group" | "depth">): number {
  return Math.min((shelf.group === "own" ? 3 : 4) + shelf.depth, 6);
}

/**
 * A shelf's glyph — spec §3.2 and `PinnedFolders`' pictures: `Layers` for a deck group or a managed
 * folder, `Inbox` for Recently removed, the app's own cards glyph for Not sorted, and a folder that
 * is open and gold while expanded, shut and dim while collapsed. Not sorted stays dim either way,
 * because gold is what a *folder* opening says.
 */
export function ShelfGlyph({
  kind,
  open,
  className,
}: {
  kind: ShelfKind;
  open: boolean;
  className?: string;
}): ReactElement {
  const Icon =
    kind === "unfiled"
      ? Cards
      : kind === "deck" || kind === "managed"
        ? Layers
        : kind === "removed"
          ? Inbox
          : open
            ? FolderOpen
            : Folder;
  return (
    <Icon
      aria-hidden="true"
      className={cn("flex-none", open && kind !== "unfiled" ? "text-accent" : "text-dim", className)}
    />
  );
}

/** A path segment: a button that reads as words until hovered. */
const SEGMENT = cn("min-w-0 truncate rounded-sm underline-offset-[3px] hover:underline", FOCUS);

/**
 * The folder's own name, which folds its shelf: words, never underlined — an underline is what the
 * lead segments beside it wear, and they are links. What it wears on hover is the chevron's own
 * hover, drawn on the chevron ({@link CHEVRON_LIT_BY_TITLE}), so the reader sees which control the
 * name is.
 */
const TITLE = cn("min-w-0 truncate rounded-sm text-text", FOCUS);

/** Marks the name, so the row can light its chevron while the name is hovered. */
const TITLE_ATTR = "data-shelf-title";

/**
 * The chevron's hover, drawn while the pointer is on the **name** — spelt out whole, because
 * Tailwind emits a rule only for a class it finds written in source. Not drawn while folding is
 * paused, where `FOLD_PAUSED_LOOK` holds the chevron still under its own pointer too.
 */
const CHEVRON_LIT_BY_TITLE =
  "group-has-[[data-shelf-title]:hover]/shelf:bg-surface group-has-[[data-shelf-title]:hover]/shelf:text-text";

export function ShelfHeading({
  shelf,
  stat,
  peek,
  onToggle,
  onOpen,
  onAddFolder,
  onRename,
  renaming,
  menu,
  dropRef,
  dropMark = "none",
  dragRef,
  foldPaused,
}: ShelfHeadingProps): ReactElement {
  const tip = useTooltip();
  const foldRefused = Boolean(foldPaused);
  const toggle = foldRefused ? undefined : onToggle;
  const own = shelf.kind === "folder";
  const unfiled = shelf.kind === "unfiled";
  const addFolder = own ? onAddFolder : undefined;
  const rename = own ? onRename : undefined;
  const manage = unfiled ? undefined : menu;
  const dragSource = own ? dragRef : undefined;
  const creating = renaming?.mode === "create";
  const open = !shelf.collapsed;
  const edge = dropMark === "before" || dropMark === "after" ? dropMark : null;

  // The caret's way back when a rename closes: to the control the field replaced — Rename when
  // there is one, else the ⋯ (a rename opened from the menu), else the name. The page's dismiss
  // would focus a detached node; `useFolderFieldReturn` is the fix and only the host can aim it.
  const caretReturn = useFolderFieldReturn<HTMLButtonElement>(renaming !== undefined && !creating);
  const caretHome = rename ? "rename" : manage ? "manage" : "title";

  // One element, two registrations: the drop target and the drag source are both the row, so the
  // two refs are merged. React 19 runs a callback ref's returned cleanup instead of calling it with
  // `null`, so each ref gets whichever of the two it asked for.
  const attachRow = useCallback(
    (element: HTMLDivElement | null) => {
      const attached = [dropRef, dragSource];
      const releases = attached.map((attach) =>
        attach === undefined ? undefined : (attach as AttachElement)(element),
      );
      return () => {
        attached.forEach((attach, i) => {
          const release = releases[i];
          if (typeof release === "function") (release as () => void)();
          else attach?.(null);
        });
      };
    },
    [dropRef, dragSource],
  );

  return (
    <div
      ref={attachRow}
      {...{ [SHELF_HEADING_ATTR]: shelf.id }}
      // A right-click anywhere on the row opens the menu, and the menu hands the caret back to the
      // element its handler sits on — so the row has to be able to take focus. `-1`, never `0`: a
      // tab stop per shelf would double every heading in the tab order.
      tabIndex={manage ? -1 : undefined}
      onContextMenu={manage?.onContextMenu}
      className={cn(
        // `border-transparent` so the row owns an edge all day and a drag recolours it rather than
        // adding one — `DROP_EDGE`'s rule for a target that has an edge.
        "group/shelf relative flex h-10 w-full min-w-0 items-center gap-2 rounded-lg border border-transparent px-1",
        (dropMark === "armed" || edge !== null) && DROP_EDGE,
        (dropMark === "over" || dropMark === "inside") && cn("border-accent", DROP_OVER),
      )}
    >
      {creating ? (
        // Nothing to collapse yet — the space is kept so the name sits where it will live.
        <span aria-hidden="true" className="size-8 flex-none" />
      ) : (
        <button
          type="button"
          aria-expanded={open}
          aria-label={`${open ? "Collapse" : "Expand"} ${shelf.name}`}
          data-no-drag=""
          onClick={toggle}
          className={cn(SHELF_CHEVRON, foldRefused ? FOLD_PAUSED_LOOK : CHEVRON_LIT_BY_TITLE)}
          // Refused in the open while a filter is on — `ShelfToolbar`'s Expand all and Collapse
          // all wear the same three things. `aria-description` rather than the tooltip's own
          // `aria-describedby`, which is wired only while the panel is open.
          {...(foldRefused
            ? {
                "aria-disabled": true as const,
                "aria-description": foldPaused,
                ...tip(foldPaused, { describes: false }),
              }
            : {})}
        >
          {open ? (
            <ChevronDown className="size-5" aria-hidden="true" />
          ) : (
            <ChevronRight className="size-5" aria-hidden="true" />
          )}
        </button>
      )}

      {/* The field carries a glyph of its own, so the row's steps aside while it is open. */}
      {renaming === undefined && <ShelfGlyph kind={shelf.kind} open={open} className="size-4" />}

      <div
        role={renaming === undefined ? "heading" : undefined}
        aria-level={renaming === undefined ? headingLevel(shelf) : undefined}
        className={cn(
          "flex min-w-0 gap-1.5 whitespace-nowrap font-medium text-text",
          renaming === undefined ? "items-baseline" : "items-center",
          shelf.depth === 0 ? "text-base" : "text-[0.9375rem]",
        )}
      >
        {shelf.lead.map((name, i) => {
          const id = shelf.leadIds[i];
          return (
            <Fragment key={id}>
              <button
                type="button"
                onClick={() => onOpen(id)}
                // Ancestors give way before the name does: a heading that ran out of room must still
                // say which folder it is.
                className={cn(SEGMENT, "shrink-[4] font-normal text-dim hover:text-text")}
                {...tip(name, { whenClipped: true })}
              >
                {name}
              </button>{" "}
              <span aria-hidden="true" className="flex-none font-normal text-dim">
                ›
              </span>{" "}
            </Fragment>
          );
        })}
        {renaming !== undefined ? (
          // The rename shape for both jobs — the create shape carries the tile wall's 62px floor —
          // and at heading size: a 36px frame in this row's 38px content box, with ✓ / ✕ centred
          // on it against the field's own form rather than hung from its top (live pass §10, where
          // the tile size stood 1px proud of the row and put the pair 3px above its centre line).
          <div className="min-w-0 flex-[0_1_16rem]">
            <FolderNameField
              mode="rename"
              size="heading"
              label={creating ? "Folder name" : `Rename ${shelf.name}`}
              initial={renaming.initial}
              submitLabel={creating ? "Create folder" : "Rename folder"}
              pending={renaming.pending ?? false}
              onSubmit={renaming.onCommit}
              onCancel={renaming.onCancel}
            />
          </div>
        ) : unfiled ? (
          <span className="min-w-0 truncate">{shelf.name}</span>
        ) : (
          <button
            ref={caretHome === "title" ? caretReturn : undefined}
            type="button"
            {...{ [TITLE_ATTR]: "" }}
            aria-expanded={open}
            onClick={toggle}
            onKeyDown={manage?.onKeyDown}
            className={TITLE}
            // Refused with the chevron, and in the chevron's words — but the clipped-name tooltip
            // stays, since the name is still what this button shows.
            {...(foldRefused
              ? { "aria-disabled": true as const, "aria-description": foldPaused }
              : {})}
            {...tip(shelf.name, { whenClipped: true })}
          >
            {shelf.name}
          </button>
        )}
      </div>

      {own && shelf.locked && (
        <span role="img" aria-label="Locked" className="flex flex-none text-dim">
          <Lock className="size-3.5" aria-hidden="true" />
        </span>
      )}
      {shelf.kind === "managed" && (
        <span
          className="flex-none rounded-full border border-border px-1.5 text-[0.6875rem] leading-4 text-dim"
          {...tip("Updates automatically with its deck")}
        >
          Managed
        </span>
      )}
      {stat !== "" && (
        <span
          className="min-w-0 shrink-[2] truncate whitespace-nowrap text-xs tabular-nums text-dim"
          {...tip(stat, { whenClipped: true })}
        >
          {stat}
        </span>
      )}
      {shelf.collapsed && peek.length > 0 && (
        <span aria-hidden="true" data-shelf-peek="" className="flex flex-none items-center pl-0.5">
          {peek.slice(0, PEEK_LIMIT).map((card, i) => (
            <PeekThumb key={`${i}:${card.cardId}`} cardId={card.cardId} first={i === 0} />
          ))}
        </span>
      )}
      <span aria-hidden="true" className="h-px min-w-6 flex-1 bg-border" />

      {renaming === undefined && addFolder && (
        <button
          type="button"
          aria-label={`Add folder in ${shelf.name}`}
          data-no-drag=""
          onClick={addFolder}
          className={SHELF_ICON_BUTTON}
          {...tip("Add folder", { describes: false })}
        >
          <FolderPlus className="size-4" aria-hidden="true" />
        </button>
      )}
      {renaming === undefined && rename && (
        <button
          ref={caretHome === "rename" ? caretReturn : undefined}
          type="button"
          aria-label={`Rename ${shelf.name}`}
          data-no-drag=""
          onClick={rename}
          className={SHELF_ICON_BUTTON}
          {...tip("Rename", { describes: false })}
        >
          <Pencil className="size-4" aria-hidden="true" />
        </button>
      )}
      {renaming === undefined && manage && (
        // `aria-haspopup` and no `aria-expanded` — the open state is `ContextMenuProvider`'s, and a
        // static `false` would be wrong for exactly as long as the menu is up.
        <button
          ref={caretHome === "manage" ? caretReturn : undefined}
          type="button"
          aria-label={`Manage ${shelf.name}`}
          aria-haspopup="menu"
          data-no-drag=""
          onClick={manage.onClick}
          onKeyDown={manage.onKeyDown}
          className={SHELF_ICON_BUTTON}
        >
          <MoreHorizontal className="size-4" aria-hidden="true" />
        </button>
      )}
      {renaming === undefined && !unfiled && (
        // The way into the folder (issue #599) — last, so it is one column on every heading: a
        // deck group carries no Add folder, Rename or ⋯, and its → still lines up with a binder's.
        <button
          type="button"
          aria-label={`Open ${shelf.name}`}
          data-no-drag=""
          onClick={() => onOpen(shelf.id)}
          className={SHELF_ICON_BUTTON}
          {...tip("Open folder", { describes: false })}
        >
          <ArrowRight className="size-4" aria-hidden="true" />
        </button>
      )}

      <FolderDropLine edge={edge} axis="vertical" />
    </div>
  );
}

/**
 * One peek thumbnail: 22×31 of the whole card, the canvas's size. `thumb` because it is the smallest
 * variant that is a whole card, and a whole card carries its printed artist credit — an `art` crop
 * here would owe one.
 */
function PeekThumb({ cardId, first }: { cardId: string; first: boolean }): ReactElement {
  const box = cn(
    "h-[31px] w-[22px] flex-none rounded-[2px] bg-surface shadow-[0_0_0_1.5px_var(--color-bg)]",
    !first && "-ml-[9px]",
  );
  return (
    <CardImage src={cardImageUrl(cardId, 0, "thumb")} alt="" className={cn(box, "object-cover")} />
  );
}
