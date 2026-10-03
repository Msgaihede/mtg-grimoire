import { Fragment, useId, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, ChevronDown, ChevronRight, Inbox } from "lucide-react";
import { headingLevel, PEEK_LIMIT, PeekThumb, ShelfGlyph } from "@/features/shelves/ShelfHeading";
import { FOCUS } from "@/lib/focus";
import type { Shelf } from "@/lib/shelves";
import { PRESS, PRESS_SOFT } from "@/lib/motion";
import { cn } from "@/lib/utils";

/**
 * The phone's shelf chrome: a heading, an empty shelf, and the path row above the wall.
 *
 * **Drawn for a thumb, not borrowed from the desktop.** `ShelfHeading` is a 40px row of 28px ghost
 * buttons, a drag source and a drop target; here the whole heading is one 48px press that folds
 * its shelf, and the only other control on it is the way in. Its vocabulary is the desktop's —
 * `ShelfGlyph`, the peek, `headingLevel`, the `›` of a path — so one cabinet reads as one cabinet
 * on both faces.
 */

/** A 44px icon control at the heading's right end — Open, and nothing else that would compete. */
const ICON_CONTROL = cn(
  "flex size-11 flex-none items-center justify-center rounded-md text-dim hover:text-text",
  PRESS,
  FOCUS,
);

export function PhoneShelfHeading({
  shelf,
  stat,
  peek,
  onToggle,
  foldPaused,
  onOpenFolder,
  aside,
}: {
  shelf: Shelf;
  /** Already formatted — `12 cards · $40.10`, `Locked · 3 cards`, `3 of 42 cards`. */
  stat: string;
  /** Up to `PEEK_LIMIT` card ids, drawn only while the shelf is shut. */
  peek: readonly { cardId: string }[];
  onToggle: () => void;
  /**
   * Why folding is refused right now — a filter is on, and collapse is suspended (spec §3.4).
   * Set, the press says so instead of folding; the heading still says what the shelf is.
   */
  foldPaused?: string;
  /** The way into the folder. Absent on Not sorted, which is not a folder. */
  onOpenFolder?: () => void;
  /** A link or a mark the page draws beside the way in — a deck group's way to its deck. */
  aside?: ReactNode;
}) {
  const statId = useId();
  const open = !shelf.collapsed;
  const refused = foldPaused !== undefined;
  return (
    <div className="flex h-full items-start">
      <div className="flex h-12 min-w-0 flex-1 items-center border-b border-border">
        <div
          role="heading"
          aria-level={headingLevel(shelf)}
          // Named as its button is: name-from-content would read the figures inside the button
          // into the heading's name, where they are the button's description.
          aria-label={shelf.name}
          className="flex h-full min-w-0 flex-1"
        >
          <button
            type="button"
            aria-expanded={open}
            // The shelf's own name. The path before it is the heading level's to say, and the
            // figures are the description — inside the button they would be read as its name.
            aria-label={shelf.name}
            aria-describedby={statId}
            onClick={refused ? undefined : onToggle}
            {...(refused ? { "aria-disabled": true as const, "aria-description": foldPaused } : {})}
            className={cn(
              "flex h-full min-w-0 flex-1 items-center gap-2 rounded-md pr-1 text-left",
              PRESS_SOFT,
              FOCUS,
            )}
          >
            {open ? (
              <ChevronDown aria-hidden className="size-5 flex-none text-dim" />
            ) : (
              <ChevronRight aria-hidden className="size-5 flex-none text-dim" />
            )}
            <ShelfGlyph kind={shelf.kind} open={open} className="size-4" />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="flex min-w-0 items-baseline gap-1 text-[0.9375rem] font-medium leading-5 text-text">
                {shelf.lead.map((name, i) => (
                  <Fragment key={shelf.leadIds[i]}>
                    {/* Ancestors give way before the name does. Words, not controls: on a phone
                        the path row above the wall is the way up, at a size a thumb can hit. */}
                    <span className="min-w-0 shrink-[4] truncate font-normal text-dim">{name}</span>{" "}
                    <span aria-hidden className="flex-none font-normal text-dim">
                      ›
                    </span>{" "}
                  </Fragment>
                ))}
                <span className="min-w-0 truncate">{shelf.name}</span>
              </span>
              <span id={statId} className="truncate text-xs leading-4 tabular-nums text-dim">
                {stat}
              </span>
            </span>
            {shelf.collapsed && peek.length > 0 && (
              <span aria-hidden className="flex flex-none items-center pl-0.5">
                {peek.slice(0, PEEK_LIMIT).map((card, i) => (
                  <PeekThumb key={`${i}:${card.cardId}`} cardId={card.cardId} first={i === 0} />
                ))}
              </span>
            )}
          </button>
        </div>
        {aside}
        {onOpenFolder && (
          <button
            type="button"
            aria-label={`Open ${shelf.name}`}
            onClick={onOpenFolder}
            className={ICON_CONTROL}
          >
            <ArrowRight aria-hidden className="size-5" />
          </button>
        )}
      </div>
    </div>
  );
}

/** An open shelf with nothing on it: the desktop's dashed drawer, at a phone's height, with the
 *  page's own sentence — a phone has no drag to invite. */
export function EmptyShelfBox({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-11 items-center gap-2 rounded-lg border border-dashed border-border px-3 text-[0.8125rem] text-dim">
      <Inbox aria-hidden className="size-4 flex-none" />
      <span className="min-w-0 truncate">{children}</span>
    </div>
  );
}

/**
 * Where the reader stands in a cabinet, and the way back out — drawn only inside a folder.
 *
 * **Buttons, not links**, and that is the router's grammar rather than a slip: the level a reader
 * stands on is not in the URL (`routes.ts` names a view, a deck and a card), so moving between
 * levels changes no address — and a control that changes no URL is a button. Back leaves the
 * view, not the folder.
 *
 * The `←` is the step up one level, at a thumb's size; the segments are the long way, and wrap
 * rather than scroll sideways.
 */
export function PathRow<F extends { id: number; name: string }>({
  root,
  trail,
  onOpen,
}: {
  /** The top of the cabinet — `Collection`, `Wishlist`. */
  root: string;
  /** Root-most first, ending with the folder being shown. Never empty: the row is not drawn at
   *  the root. */
  trail: readonly F[];
  onOpen: (folderId: number | null) => void;
}) {
  const up = trail.length > 1 ? trail[trail.length - 2] : null;
  const segments = [
    { id: null as number | null, name: root },
    ...trail.map((f) => ({ id: f.id as number | null, name: f.name })),
  ];
  return (
    <nav
      aria-label={`${root} folders`}
      className="flex items-center gap-1 border-b border-border py-1"
    >
      <button
        type="button"
        aria-label={`Up to ${up === null ? root : up.name}`}
        onClick={() => onOpen(up === null ? null : up.id)}
        className={cn(ICON_CONTROL, "-ml-2")}
      >
        <ArrowLeft aria-hidden className="size-5" />
      </button>
      <ol className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1 text-sm">
        {segments.map((segment, i) => {
          const last = i === segments.length - 1;
          return (
            <li key={segment.id ?? "root"} className="flex min-w-0 items-center gap-1">
              {i > 0 && (
                <span aria-hidden className="flex-none text-dim">
                  ›
                </span>
              )}
              {last ? (
                <span aria-current="page" className="truncate py-2 font-medium text-text">
                  {segment.name}
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => onOpen(segment.id)}
                  className={cn("min-w-0 truncate rounded-sm py-2 text-dim hover:text-text", FOCUS)}
                >
                  {segment.name}
                </button>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
