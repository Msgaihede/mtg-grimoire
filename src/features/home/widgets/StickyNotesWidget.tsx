/**
 * The reader's own prose on the home page — a board of tinted tiles, or one note at full size
 * with the rest of the stack behind it.
 *
 * **A body, not a card.** `WidgetCard` draws the title row, the chip and the tray; this draws
 * what is under them, sized to the box it was handed.
 *
 * ## Two layouts, and why the board is the default
 *
 * `Board` is a grid of tiles — every note at once, each a press that opens the editor. `Pad` is
 * one note drawn whole, which reads better on a small card and worse on a large one, and is
 * therefore the option rather than the default. Which one a card draws is the registry's `layout`
 * pick, read through `pickOf` like every other setting; **which note the Pad is showing is
 * `useState` and is never stored**, because it is a transient and `home_layout` is a document
 * that syncs.
 *
 * ## The geometry is pixels, and zero is a real answer
 *
 * Columns come from the body's measured **width** rather than from the footprint in cells
 * ({@link tileColumns}): eight columns of a narrow pane and eight of a wide one are different
 * numbers of pixels, and a tile is a thing with a width. Rows come from `fit.fitCount`, which is
 * whole rows — **and a card with room for no tile draws none rather than one it clips**. That is
 * why `fitCount` is called and not `linesFit`: the latter floors at one, which is the right answer
 * for a list that must say *something* and the wrong one for a wall of tiles, where the half-drawn
 * first tile reads as a broken card.
 *
 * Everything the tiles are then laid out at is derived once, in {@link boardGeometry}, so a test
 * can ask what a footprint draws without rendering anything. The figures in {@link tileScale} were
 * read off the artboards (`Sizes` and `SizesBoard` on the design canvas) at the three footprints
 * they draw: 2×2, 4×2 and 6×3.
 *
 * ## Reading a note loads no editor
 *
 * Both layouts draw bodies through `parseNoteBody` — `noteMarkdown.ts`' closed reader — and the
 * editor arrives only when a note is opened, behind `StickyNoteDialog`'s own `lazy` boundary. A
 * catalogue still therefore costs nothing: it opens nothing, so the dialog is never rendered and
 * the 141.5 kB chunk behind it is never asked for.
 *
 * ⚠️ **The block renderer here is this file's own, and that is deliberate.** Three renderers of
 * that AST already exist (`DeckNotesPanel`, `NotesOverlay`, `ReleaseNotes`) and sharing was
 * refused each time because they draw at different type scales; a note on a home-page card is a
 * fourth scale, and it changes again between tiers. What is *not* optional is
 * `whitespace-pre-line`: the `Inline` union has no break member, so a hard break travels as a
 * `"\n"` **inside a text run**, and a renderer without that rule draws a line boundary the reader
 * typed as a space.
 *
 * ⚠️ **Secondary text on a note is `--color-note-dim` and never `text-dim`.** The page's dim ink
 * measures about 4.3:1 against these L 26% fills, under the 4.5:1 floor — a contrast bug no test
 * in this repo can catch. `text-dim` stays correct on the card's own background, which is why the
 * footer under the board still uses it.
 *
 * ⚠️ **A note's colour is set inline from a custom property and never as a Tailwind class.** An
 * interpolated class emits no rule at all rather than failing, and Tailwind would never see
 * `bg-note-${colour}` in the first place. {@link FACE} and {@link EDGE} spell the ten values out
 * whole so a colour cannot be built out of pieces at a call site either.
 */
import { useCallback, useMemo, useState, type CSSProperties, type ReactElement } from "react";
import { ChevronLeft, ChevronRight, Files, Plus } from "lucide-react";
import { parseNoteBody, type Block, type Inline } from "@/features/decks/noteMarkdown";
import { plural } from "@/lib/counts";
import { openExternal } from "@/lib/externalLinks";
import { FOCUS, FOCUS_INSET } from "@/lib/focus";
import { ipcError, type StickyNote, type StickyNotePatch } from "@/lib/ipc";
import { PRESS, PRESS_SOFT } from "@/lib/motion";
import { ago } from "@/lib/relativeTime";
import { cn } from "@/lib/utils";
import type { Tier, WidgetFit } from "../fit";
import { StickyNoteDialog } from "../StickyNoteDialog";
import {
  NOTE_COLORS,
  noteColor,
  notePreview,
  orderedNotes,
  stickyTitle,
  type NoteColor,
} from "../stickyNotes";
import { useStickyNotes } from "../useStickyNotes";
import { WidgetMessage } from "../WidgetParts";
import type { WidgetBodyProps } from "../widgetProps";
import { pickOf, toggleOn } from "../widgetSettings";

/* ----------------------------------------------------------------- the colours --------- */

/**
 * A note's fill, by colour word. **Written out whole, one property per row.**
 *
 * A `var(--color-note-${colour})` template would work — an inline style is not scanned by
 * anything — but it would also make a sixth colour a runtime `transparent` rather than a compile
 * error, and it would put the one spelling of these names somewhere a grep for the token cannot
 * find. `noteColor` narrows a stored word to one of the five before it ever reaches this table.
 */
const FACE: Record<NoteColor, string> = {
  amber: "var(--color-note-amber)",
  jade: "var(--color-note-jade)",
  azure: "var(--color-note-azure)",
  rose: "var(--color-note-rose)",
  slate: "var(--color-note-slate)",
};

/** The 3px edge across a note's top, and the mark beside a name in the Pad's index. */
const EDGE: Record<NoteColor, string> = {
  amber: "var(--color-note-amber-strip)",
  jade: "var(--color-note-jade-strip)",
  azure: "var(--color-note-azure-strip)",
  rose: "var(--color-note-rose-strip)",
  slate: "var(--color-note-slate-strip)",
};

/** Secondary ink **on** a note — never `text-dim`, which is under the contrast floor here. */
const NOTE_DIM = "var(--color-note-dim)";

/** What colour a note made from this widget starts as. The dialog's swatches change it. */
const NEW_NOTE_COLOR: NoteColor = NOTE_COLORS[0];

/* ----------------------------------------------------------------- the sentences ------- */

const PENDING = "Reading your notes…";
/** The heading over an empty board. */
export const EMPTY_TITLE = "No notes yet";
/** The one dim sentence under it — the artboard's, and it says what a note is *for* rather than
 *  what the reader should press, because the press is right underneath it. */
export const EMPTY_BLURB =
  "Somewhere to keep a trade, a rules call, or the list you meant to bring.";

/* ----------------------------------------------------------------- the fixed rows ------ */

/**
 * The footer under the board: how many notes there are, and the New note press.
 *
 * **Reserved whether or not the press is drawn.** A still draws the count and no button, and if
 * the reservation moved with it, switching a card to a catalogue preview would re-cut the rows
 * it is a picture of.
 */
export const FOOTER_PX = 20;

/** The pager under the Pad at tier 0–1 — `‹ 2 / 7 ›` and the New note press. */
const PAGER_PX = 24;

/** The rail of names over the Pad at tier 2. */
const RAIL_PX = 26;

/** One name in the Pad's vertical index at tier 3, and the New note press under it. */
const RAIL_ROW_PX = 30;
const RAIL_NEW_PX = 22;

/** The index column's width at tier 3 — the artboard's, capped so it can never take more than a
 *  third of a card somebody has dragged narrow. */
const INDEX_PX = 176;

/** The coloured edge across the top of every note, in both layouts. */
const STRIP_PX = 3;

/* ----------------------------------------------------------------- the geometry -------- */

/**
 * How many columns of tiles a body this wide holds: **two at 2×2, three at 4×3, four at 6×3.**
 *
 * `clamp(2, floor(width / 115), 4)`. Two is the floor because one column of tiles is a list drawn
 * as squares, and four is the ceiling because a fifth column at any width this app is used at
 * leaves a tile too narrow to hold a name.
 *
 * ⚠️ **The artboard's 4×2 panel draws four columns and this answers three**, which is the one
 * disagreement with the design and it is a deliberate one: the spec names 4×3 as the three-column
 * size and 115px is what makes that true, and the plan records that only a live pass settles which
 * of the two a 4×2 wants. Change the divisor rather than special-casing a footprint.
 */
export function tileColumns(bodyWidthPx: number): number {
  return Math.max(2, Math.min(4, Math.floor(bodyWidthPx / 115)));
}

/** The type and spacing one board tile is drawn at. See {@link tileScale}. */
export interface TileScale {
  padTop: number;
  padX: number;
  padBottom: number;
  radius: number;
  nameSize: number;
  nameLine: number;
  bodySize: number;
  /** The preview's line box, in pixels — the artboards' `font-size × line-height`, resolved here
   *  so the row budget and the drawn text cannot disagree about a fractional line. */
  bodyLine: number;
  /** Between the name and the preview. */
  gap: number;
  /** The edited line at the foot of a tile, when `dates` is on. */
  datePx: number;
  /** The pinned mark's diameter. */
  dot: number;
  /** The height a row aims at, before the leftover is spread over the rows that fit. */
  target: number;
}

/**
 * Two scales, and the tier is what picks between them.
 *
 * The artboards draw three — 2×2, 4×2 and 6×3 — and the middle two differ by half a point of
 * type, which is not a decision anybody made about a card. So there is the **small** scale a
 * two-cell tile needs and the one every other footprint uses, and the thing that really changes
 * with the box is how many preview lines a tile affords, which {@link boardGeometry} computes
 * from the row it ended up with rather than from the tier.
 *
 * ⚠️ Tier 0 is unreachable through the registry — `min` is `[3, 2]`, which is the one thing that
 * makes a 2×2 notes card impossible — but a stored layout written by another build can still
 * carry one, and a board that had no answer for it would draw 12px type in a 96px tile.
 */
export function tileScale(tier: Tier): TileScale {
  return tier === 0
    ? {
        padTop: 9,
        padX: 8,
        padBottom: 7,
        radius: 8,
        nameSize: 10.5,
        nameLine: 14,
        bodySize: 9.5,
        bodyLine: 13.3,
        gap: 4,
        datePx: 13,
        dot: 5,
        target: 66,
      }
    : {
        padTop: 12,
        padX: 11,
        padBottom: 9,
        radius: 10,
        nameSize: 12,
        nameLine: 16,
        bodySize: 11,
        bodyLine: 15.95,
        gap: 5,
        datePx: 14,
        dot: 6,
        target: 122,
      };
}

/** What a board of this footprint draws, in pixels and counts. */
export interface BoardGeometry {
  columns: number;
  /** Whole rows only. **Zero is a real answer.** */
  rows: number;
  /** A row's drawn height: the rows that fit, spread across the height they fit in. */
  rowHeight: number;
  /** How many preview lines a tile of that height affords. Zero draws no preview at all. */
  lines: number;
  /** `columns × rows` — how many notes the board shows. */
  tiles: number;
}

/**
 * The board's arithmetic, in one place and with no DOM in it.
 *
 * The row count is `fit.fitCount` against {@link TileScale.target}; the drawn row is then the
 * height those rows actually have, so the board fills its card rather than leaving a band of
 * empty under the last row. The preview's line count falls out of *that* height, which is what
 * makes a 4×2 card — one tall row — draw six lines where a 6×3 draws five.
 *
 * `reserved` is the footer plus one gap, and the gap is `fit.rowGap` throughout this body:
 * `fitCount` does its arithmetic with that number, so using any other between the tiles would
 * make the count it answers a count of rows that do not fit.
 */
export function boardGeometry(fit: WidgetFit, dates: boolean): BoardGeometry {
  const scale = tileScale(fit.tier);
  const columns = tileColumns(fit.bodyWidthPx);
  const reserved = FOOTER_PX + fit.rowGap;
  const rows = fit.fitCount(scale.target, reserved);
  const box = Math.max(0, fit.bodyHeightPx - reserved);
  const rowHeight = rows === 0 ? 0 : Math.floor((box - fit.rowGap * (rows - 1)) / rows);
  const spent =
    scale.padTop + scale.padBottom + scale.nameLine + scale.gap + (dates ? scale.datePx : 0);
  const lines = Math.max(0, Math.floor((rowHeight - spent) / scale.bodyLine));
  return { columns, rows, rowHeight, lines, tiles: columns * rows };
}

/** The type and spacing the Pad's one note is drawn at. */
interface PadScale {
  padTop: number;
  padX: number;
  padBottom: number;
  nameSize: number;
  nameLine: number;
  dateSize: number;
  proseSize: number;
  proseLine: number;
  /** Between the head and the prose, and between two blocks. */
  proseTop: number;
  blockGap: number;
  /** The date sits beside the name from tier 2 up, and under it below that — a 13px name and a
   *  sentence on one line do not both fit in a 198px note. */
  dateBeside: boolean;
}

/** Three scales, one per band of the Pad's own table — the pager, the rail and the index. */
function padScale(tier: Tier): PadScale {
  if (tier >= 3) {
    return {
      padTop: 17,
      padX: 16,
      padBottom: 14,
      nameSize: 16,
      nameLine: 21,
      dateSize: 11.5,
      proseSize: 13,
      proseLine: 1.55,
      proseTop: 11,
      blockGap: 7,
      dateBeside: true,
    };
  }
  if (tier === 2) {
    return {
      padTop: 14,
      padX: 13,
      padBottom: 11,
      nameSize: 14,
      nameLine: 18,
      dateSize: 11,
      proseSize: 12.5,
      proseLine: 1.5,
      proseTop: 8,
      blockGap: 6,
      dateBeside: true,
    };
  }
  return {
    padTop: 13,
    padX: 11,
    padBottom: 10,
    nameSize: 13,
    nameLine: 17,
    dateSize: 10.5,
    proseSize: 11.5,
    proseLine: 1.5,
    proseTop: 8,
    blockGap: 5,
    dateBeside: false,
  };
}

/**
 * How many names the Pad's horizontal rail draws before it says `+N`.
 *
 * Measured off the artboard rather than off the text: a chip is a name, and a name's width is not
 * a thing this file can ask about without a browser. Each chip is given a share of the row as its
 * `maxWidth` and truncates inside it, so the count is what decides the layout and a long name
 * never pushes the rest out of the row.
 */
export function railChips(bodyWidthPx: number): number {
  return Math.max(1, Math.floor(bodyWidthPx / 104));
}

/* ----------------------------------------------------------------- the body ------------ */

export function StickyNotesWidget({
  widget,
  fit,
  editing,
  still,
}: WidgetBodyProps): ReactElement {
  const layout = String(pickOf(widget, "layout") ?? "board");
  const dates = toggleOn(widget, "dates");
  const strip = toggleOn(widget, "strip");
  const pinnedFirst = toggleOn(widget, "pinned");

  const api = useStickyNotes();
  const { create, remove, update } = api;

  /** Which note the editor is open on, by id. `null` is closed, and a note deleted in another
   *  window closes it by simply not being in the list any more. */
  const [openId, setOpenId] = useState<number | null>(null);

  const ordered = useMemo(() => orderedNotes(api.notes, pinnedFirst), [api.notes, pinnedFirst]);
  const open = ordered.find((note) => note.id === openId);

  // The dialog latches `onSave` in a ref and names it in a debounce's dependency array, so these
  // three are memoised: a callback rebuilt every render is a timer cleared and restarted every
  // render, which is a draft that is never written.
  const onSave = useCallback(
    (patch: StickyNotePatch) => {
      if (openId !== null) update(openId, patch);
    },
    [openId, update],
  );
  const onDelete = useCallback(() => {
    if (openId !== null) remove(openId);
    setOpenId(null);
  }, [openId, remove]);
  const onClose = useCallback(() => setOpenId(null), []);
  // A blank note, last in the order. It is **not** opened for writing here: `create` is a
  // mutation whose answer is the new id and this hook hands back `void`, so there is nothing to
  // open until the list comes round again. The reader presses the new tile, which is one press.
  const onNew = useCallback(() => create("", "", NEW_NOTE_COLOR), [create]);

  /**
   * Is a note a press?
   *
   * A still is a picture of a widget and opens nothing. While Customize is on the whole card is a
   * drag handle — the page makes this body `inert`, and drawing the notes as pictures rather than
   * presses is the same statement one layer up, so the two states agree about what a press means
   * instead of relying on `inert` alone.
   */
  const pressable = !still && !editing;

  if (api.isPending) return <WidgetMessage>{PENDING}</WidgetMessage>;
  if (api.isError) {
    return (
      <WidgetMessage tone="destructive">
        Could not read your notes — {ipcError(api.error)}
      </WidgetMessage>
    );
  }
  if (ordered.length === 0) {
    return <EmptyNotes fit={fit} pressable={pressable} onNew={onNew} />;
  }

  const shared = {
    notes: ordered,
    fit,
    dates,
    strip,
    pressable,
    writeError: api.writeError,
    onOpen: setOpenId,
    onNew,
  };

  return (
    <>
      {layout === "pad" ? <Pad {...shared} /> : <Board {...shared} />}
      {open !== undefined && (
        <StickyNoteDialog
          note={open}
          onSave={onSave}
          onDelete={onDelete}
          onClose={onClose}
          saving={api.isSaving}
          writeError={api.writeError}
        />
      )}
    </>
  );
}

/** What both layouts are handed. */
interface LayoutProps {
  notes: StickyNote[];
  fit: WidgetFit;
  dates: boolean;
  strip: boolean;
  pressable: boolean;
  writeError: unknown;
  onOpen: (id: number) => void;
  onNew: () => void;
}

/* ----------------------------------------------------------------- Board --------------- */

/**
 * Every note at once, as tinted tiles.
 *
 * The list is given its height in pixels rather than growing: the page measured the card, the
 * footer's line is reserved, and what is left is exactly the rows {@link boardGeometry} cut. It
 * clips rather than scrolls for the same reason a row is never half-drawn — the tiles inside it
 * are the ones that fit.
 */
function Board({
  notes,
  fit,
  dates,
  strip,
  pressable,
  writeError,
  onOpen,
  onNew,
}: LayoutProps): ReactElement {
  const scale = tileScale(fit.tier);
  const geometry = boardGeometry(fit, dates);
  return (
    <div
      className="flex shrink-0 flex-col"
      style={{ height: fit.bodyHeightPx, gap: fit.rowGap }}
    >
      <ul
        aria-label="Your notes"
        className="m-0 grid min-h-0 list-none overflow-hidden p-0"
        style={{
          // A column template is an inline style rather than an arbitrary class: Tailwind scans
          // source text, and a count interpolated into a class name emits nothing at all.
          gridTemplateColumns: `repeat(${geometry.columns}, minmax(0, 1fr))`,
          gridAutoRows: `${geometry.rowHeight}px`,
          gap: fit.rowGap,
          height: Math.max(0, fit.bodyHeightPx - FOOTER_PX - fit.rowGap),
        }}
      >
        {notes.slice(0, geometry.tiles).map((note) => (
          <Tile
            key={note.id}
            note={note}
            scale={scale}
            lines={geometry.lines}
            dates={dates}
            strip={strip}
            pressable={pressable}
            onOpen={onOpen}
          />
        ))}
      </ul>
      <Foot
        count={notes.length}
        tier={fit.tier}
        pressable={pressable}
        writeError={writeError}
        onNew={onNew}
      />
    </div>
  );
}

/**
 * One note as a tile.
 *
 * **The accessible name is written out and is the note's own title**, never the tile's contents:
 * the preview under the name is four words of a note rather than a name for it, and a `gap`
 * between two elements is not a word separator to name computation, so a computed one would read
 * as the title and the preview run together. A pinned note says *pinned* in that name, because the
 * gold dot that says it on screen is `aria-hidden` decoration.
 */
function Tile({
  note,
  scale,
  lines,
  dates,
  strip,
  pressable,
  onOpen,
}: {
  note: StickyNote;
  scale: TileScale;
  lines: number;
  dates: boolean;
  strip: boolean;
  pressable: boolean;
  onOpen: (id: number) => void;
}): ReactElement {
  const color = noteColor(note.color);
  const title = stickyTitle(note);
  const preview = lines > 0 ? notePreview(note.body, lines) : "";
  const clamp: CSSProperties = {
    marginTop: scale.gap,
    fontSize: scale.bodySize,
    lineHeight: `${scale.bodyLine}px`,
    color: NOTE_DIM,
    // The data is already cut to `lines` entries; this is what cuts **one** long paragraph, which
    // `notePreview` counts as a single line however many rows it draws over.
    display: "-webkit-box",
    WebkitBoxOrient: "vertical",
    WebkitLineClamp: lines,
    overflow: "hidden",
  };
  const inner = (
    <>
      {strip && (
        <span
          aria-hidden="true"
          className="absolute inset-x-0 top-0"
          style={{ height: STRIP_PX, background: EDGE[color] }}
        />
      )}
      {note.pinned && (
        <span
          aria-hidden="true"
          className="absolute rounded-full"
          style={{
            top: scale.padTop + 3,
            right: scale.padX,
            width: scale.dot,
            height: scale.dot,
            background: "var(--color-accent)",
          }}
        />
      )}
      <span
        className="block truncate font-heading font-semibold text-text"
        style={{
          fontSize: scale.nameSize,
          lineHeight: `${scale.nameLine}px`,
          paddingRight: note.pinned ? scale.dot + 6 : undefined,
        }}
      >
        {title}
      </span>
      {preview !== "" && (
        <span className="block whitespace-pre-line" style={clamp}>
          {preview}
        </span>
      )}
      {dates && (
        <span
          className="mt-auto block truncate"
          style={{ fontSize: scale.bodySize, lineHeight: `${scale.datePx}px`, color: NOTE_DIM }}
        >
          {edited(note)}
        </span>
      )}
    </>
  );
  const face: CSSProperties = {
    background: FACE[color],
    borderRadius: scale.radius,
    padding: `${scale.padTop}px ${scale.padX}px ${scale.padBottom}px`,
  };
  const box = "relative flex h-full w-full flex-col overflow-hidden border border-border text-left";
  return (
    <li className="min-w-0">
      {pressable ? (
        <button
          type="button"
          aria-label={note.pinned ? `${title}, pinned` : title}
          onClick={() => onOpen(note.id)}
          // The inset focus mark: a tile fills a box that clips, so an outline standing off its
          // edge would be painted where nobody can see it.
          className={cn(box, "hover:border-dim", PRESS_SOFT, FOCUS_INSET)}
          style={face}
        >
          {inner}
        </button>
      ) : (
        <div className={box} style={face}>
          {inner}
        </div>
      )}
    </li>
  );
}

/**
 * The line under the board: how many notes there are, and the way to make another.
 *
 * **A refused write is said here.** All four of this feature's writes can answer `BUSY` under a
 * running sync, and the only one reachable from this body is New note — so a press that did not
 * land would otherwise be a button that did nothing. The read's own failure is a different fact
 * and is drawn instead of the board, not under it.
 */
function Foot({
  count,
  tier,
  pressable,
  writeError,
  onNew,
}: {
  count: number;
  tier: Tier;
  pressable: boolean;
  writeError: unknown;
  onNew: () => void;
}): ReactElement {
  return (
    <div className="flex shrink-0 items-center gap-1.5" style={{ height: FOOTER_PX }}>
      {writeError === undefined ? (
        <p className="m-0 min-w-0 truncate text-xs text-dim">{plural(count, "note")}</p>
      ) : (
        <p className="m-0 min-w-0 truncate text-xs text-destructive">
          Not saved — {ipcError(writeError)}
        </p>
      )}
      <span className="flex-1" />
      {pressable && <NewNote wordless={tier === 0} onNew={onNew} />}
    </div>
  );
}

/**
 * A write that did not land.
 *
 * The Board says it **in place of** its count, because the count and the refusal are the same
 * line's worth of room and only one of them is news. The Pad has no count, so it says it beside
 * the press that caused it — and it says it at every tier, because New note is reachable from all
 * three and a press that silently did nothing is the failure `useStickyNotes` carries
 * `writeError` to prevent.
 */
function Refused({ writeError }: { writeError: unknown }): ReactElement | null {
  if (writeError === undefined) return null;
  return (
    <span className="min-w-0 truncate text-[0.6875rem] text-destructive">
      Not saved — {ipcError(writeError)}
    </span>
  );
}

/** The New note press. Wordless on a two-cell card, where the words are wider than the footer. */
function NewNote({
  wordless,
  height = FOOTER_PX,
  onNew,
}: {
  wordless: boolean;
  height?: number;
  onNew: () => void;
}): ReactElement {
  return (
    <button
      type="button"
      aria-label={wordless ? "New note" : undefined}
      onClick={onNew}
      className={cn(
        "flex flex-none items-center gap-1 rounded-md px-1 text-xs text-dim hover:text-text",
        PRESS,
        FOCUS,
      )}
      style={{ height }}
    >
      <Plus className="size-3.5" aria-hidden="true" />
      {!wordless && "New note"}
    </button>
  );
}

/* ----------------------------------------------------------------- Pad ----------------- */

/**
 * One note at full size, and the rest of the stack carried by whatever the card has room for.
 *
 * | tier | what carries the other notes |
 * | --- | --- |
 * | 0–1 | a pager, `‹ 2 / 7 ›`, with the stack drawn as sheets behind the note |
 * | 2 | a horizontal rail of names, the current one in the accent |
 * | 3 | the rail turns vertical and becomes the pad's index |
 *
 * ⚠️ **Which note is shown is `useState` and is deliberately not stored.** It opens on the pinned
 * note if there is one and on the first in order otherwise, and it is held **by id**: a note
 * deleted in another window falls back to that seed rather than to whatever now occupies its
 * index, and `sortOrder` is monotonic and never dense, so an index would be the wrong handle
 * twice over.
 */
function Pad({
  notes,
  fit,
  dates,
  strip,
  pressable,
  writeError,
  onOpen,
  onNew,
}: LayoutProps): ReactElement {
  const [chosen, setChosen] = useState<number | null>(null);
  const seed = notes.find((note) => note.pinned) ?? notes[0];
  const note = notes.find((entry) => entry.id === chosen) ?? seed;
  const at = notes.indexOf(note);
  const scale = padScale(fit.tier);

  const sheet = (
    <Sheet
      note={note}
      scale={scale}
      dates={dates}
      strip={strip}
      pressable={pressable}
      onOpen={onOpen}
    />
  );

  if (fit.tier >= 3) {
    const width = Math.min(INDEX_PX, Math.max(0, Math.floor(fit.bodyWidthPx / 3)));
    const rows = fit.fitCount(RAIL_ROW_PX, RAIL_NEW_PX + fit.rowGap);
    return (
      <div className="flex shrink-0" style={{ height: fit.bodyHeightPx, gap: 10 }}>
        <div className="flex flex-none flex-col" style={{ width, gap: fit.rowGap }}>
          <ul
            aria-label="Your notes"
            className="m-0 flex min-h-0 flex-1 list-none flex-col gap-0.5 overflow-hidden p-0"
          >
            {notes.slice(0, rows).map((entry) => (
              <IndexRow
                key={entry.id}
                note={entry}
                current={entry.id === note.id}
                pressable={pressable}
                onShow={setChosen}
              />
            ))}
          </ul>
          <div className="flex flex-none items-center gap-1.5" style={{ height: RAIL_NEW_PX }}>
            {pressable && <NewNote wordless={false} height={RAIL_NEW_PX} onNew={onNew} />}
            <Refused writeError={writeError} />
          </div>
        </div>
        {sheet}
      </div>
    );
  }

  if (fit.tier === 2) {
    const chips = railChips(fit.bodyWidthPx);
    const rest = Math.max(0, notes.length - chips);
    const chipMax = Math.max(48, Math.floor(fit.bodyWidthPx / chips) - 16);
    return (
      <div
        className="flex shrink-0 flex-col"
        style={{ height: fit.bodyHeightPx, gap: fit.rowGap }}
      >
        <div
          className="flex flex-none items-center gap-1.5 overflow-hidden"
          style={{ height: RAIL_PX }}
        >
          {notes.slice(0, chips).map((entry) => (
            <RailChip
              key={entry.id}
              note={entry}
              current={entry.id === note.id}
              maxWidth={chipMax}
              pressable={pressable}
              onShow={setChosen}
            />
          ))}
          {rest > 0 && (
            <span className="flex-none font-mono text-[0.6875rem] text-dim">+{rest}</span>
          )}
          <span className="flex-1" />
          <Refused writeError={writeError} />
          {pressable && <NewNote wordless onNew={onNew} height={RAIL_PX - 2} />}
        </div>
        {sheet}
      </div>
    );
  }

  // Tier 0–1: the stack is drawn rather than listed. One sheet behind a two-cell card and two
  // behind a three-cell one — the artboards' offsets, and at 220px a second sheet is 6px of a
  // 198px note rather than a stack.
  const sheets = fit.tier === 0 ? [6] : [10, 5];
  const atStart = at <= 0;
  const atEnd = at >= notes.length - 1;
  return (
    <div className="flex shrink-0 flex-col" style={{ height: fit.bodyHeightPx, gap: fit.rowGap }}>
      <div className="relative min-h-0 flex-1">
        {sheets.map((offset, i) => (
          <span
            key={offset}
            aria-hidden="true"
            className="absolute rounded-[10px] border border-border bg-surface"
            style={
              i === 0
                ? { top: offset, right: 0, bottom: 0, left: offset }
                : { top: offset, right: offset, bottom: offset, left: offset }
            }
          />
        ))}
        <div
          // `flex`, so the sheet's own `flex-1` has a container to fill: the box is positioned
          // and therefore has a definite height, and a flex item stretches to it.
          className="absolute flex"
          style={{ top: 0, right: sheets[0], bottom: sheets[0], left: 0 }}
        >
          {sheet}
        </div>
      </div>
      <div className="flex flex-none items-center gap-0.5" style={{ height: PAGER_PX }}>
        {pressable && (
          <Step
            label="Previous note"
            spent={atStart}
            onStep={() => !atStart && setChosen(notes[at - 1].id)}
          >
            <ChevronLeft className="size-3.5" aria-hidden="true" />
          </Step>
        )}
        <span className="px-1 font-mono text-[0.6875rem] tabular-nums text-dim">
          {at + 1} / {notes.length}
        </span>
        {pressable && (
          <Step
            label="Next note"
            spent={atEnd}
            onStep={() => !atEnd && setChosen(notes[at + 1].id)}
          >
            <ChevronRight className="size-3.5" aria-hidden="true" />
          </Step>
        )}
        <span className="flex-1" />
        <Refused writeError={writeError} />
        {pressable && <NewNote wordless onNew={onNew} height={PAGER_PX} />}
      </div>
    </div>
  );
}

/** One end of the pager. `aria-disabled` and never `disabled`: a step with nowhere to go keeps
 *  its tab stop, so a reader walking the card with the keyboard is never dropped out of it. */
function Step({
  label,
  spent,
  onStep,
  children,
}: {
  label: string;
  spent: boolean;
  onStep: () => void;
  children: ReactElement;
}): ReactElement {
  return (
    <button
      type="button"
      aria-label={label}
      aria-disabled={spent ? true : undefined}
      onClick={onStep}
      className={cn(
        "grid size-6 flex-none place-items-center rounded-md text-dim",
        spent ? "opacity-40" : "hover:text-text",
        PRESS,
        FOCUS,
      )}
    >
      {children}
    </button>
  );
}

/** One name in the Pad's horizontal rail. A press flips the pad; it does not open the editor. */
function RailChip({
  note,
  current,
  maxWidth,
  pressable,
  onShow,
}: {
  note: StickyNote;
  current: boolean;
  maxWidth: number;
  pressable: boolean;
  onShow: (id: number) => void;
}): ReactElement {
  const title = stickyTitle(note);
  const box = cn(
    "flex h-6 flex-none items-center truncate rounded-full border px-2.5 text-[0.6875rem]",
    current ? "border-accent text-accent" : "border-border text-dim",
  );
  if (!pressable) {
    return (
      <span className={box} style={{ maxWidth }}>
        {title}
      </span>
    );
  }
  return (
    <button
      type="button"
      aria-pressed={current}
      onClick={() => onShow(note.id)}
      className={cn(box, !current && "hover:text-text", PRESS, FOCUS)}
      style={{ maxWidth }}
    >
      {title}
    </button>
  );
}

/** One name in the Pad's vertical index, with its colour as a mark down the left. */
function IndexRow({
  note,
  current,
  pressable,
  onShow,
}: {
  note: StickyNote;
  current: boolean;
  pressable: boolean;
  onShow: (id: number) => void;
}): ReactElement {
  const title = stickyTitle(note);
  const inner = (
    <>
      <span
        aria-hidden="true"
        className="flex-none rounded-sm"
        style={{ width: 4, height: 14, background: EDGE[noteColor(note.color)] }}
      />
      <span className={cn("min-w-0 flex-1 truncate text-xs", current ? "text-text" : "text-dim")}>
        {title}
      </span>
    </>
  );
  const box = "flex w-full items-center gap-[7px] rounded-md px-2 text-left";
  return (
    <li className="flex-none" style={{ height: RAIL_ROW_PX }}>
      {pressable ? (
        <button
          type="button"
          aria-pressed={current}
          onClick={() => onShow(note.id)}
          className={cn(box, "h-full", current && "bg-surface", PRESS_SOFT, FOCUS)}
        >
          {inner}
        </button>
      ) : (
        <div className={cn(box, "h-full", current && "bg-surface")}>{inner}</div>
      )}
    </li>
  );
}

/**
 * The Pad's note, drawn whole.
 *
 * ⚠️ **The note is not one big press, and the name is.** A `<button>` wrapping the whole sheet
 * would put a note's entire prose inside one control's accessible name, take the reader's ability
 * to select a line of it, and swallow the link presses `parseNoteBody` produces. So the sheet is
 * an `article` named by the note, and the heading inside it is the press that opens the editor —
 * which is what the artboard draws anyway, since the only thing in that corner is the name.
 */
function Sheet({
  note,
  scale,
  dates,
  strip,
  pressable,
  onOpen,
}: {
  note: StickyNote;
  scale: PadScale;
  dates: boolean;
  strip: boolean;
  pressable: boolean;
  onOpen: (id: number) => void;
}): ReactElement {
  const color = noteColor(note.color);
  const title = stickyTitle(note);
  const blocks = parseNoteBody(note.body);
  const name = (
    <span
      className="block min-w-0 truncate font-heading font-semibold text-text"
      style={{ fontSize: scale.nameSize, lineHeight: `${scale.nameLine}px` }}
    >
      {title}
    </span>
  );
  return (
    <article
      aria-label={note.pinned ? `${title}, pinned` : title}
      className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-[10px] border border-border"
      style={{
        background: FACE[color],
        padding: `${scale.padTop}px ${scale.padX}px ${scale.padBottom}px`,
      }}
    >
      {strip && (
        <span
          aria-hidden="true"
          className="absolute inset-x-0 top-0"
          style={{ height: STRIP_PX, background: EDGE[color] }}
        />
      )}
      <div
        className={cn(
          "flex min-w-0 flex-none",
          scale.dateBeside ? "items-baseline gap-2" : "flex-col",
        )}
      >
        {pressable ? (
          <button
            type="button"
            aria-label={`Edit ${title}`}
            onClick={() => onOpen(note.id)}
            className={cn("min-w-0 rounded-sm text-left hover:underline", PRESS_SOFT, FOCUS)}
          >
            {name}
          </button>
        ) : (
          name
        )}
        {dates && (
          <span
            className="flex-none truncate"
            style={{ fontSize: scale.dateSize, color: NOTE_DIM, marginTop: scale.dateBeside ? 0 : 3 }}
          >
            {edited(note)}
          </span>
        )}
      </div>
      <NoteBlocks blocks={blocks} scale={scale} edge={EDGE[color]} />
    </article>
  );
}

/* ----------------------------------------------------------------- the prose ----------- */

/**
 * A note body, drawn.
 *
 * ⚠️ **`whitespace-pre-line` is load-bearing and not typography.** A hard break travels as a
 * `"\n"` inside a text run, so the default `normal` would collapse every one of them to a space
 * and a note laid out in short lines would come back as one paragraph — with nothing going red.
 * It is set once, on the container, because `white-space` inherits.
 *
 * The prose is body ink rather than `--color-note-dim`: it is what the reader wrote, and the dim
 * ink on a note is for the things *about* the note. It clips rather than scrolling — this is a
 * card on a dashboard, and the whole note is one press away.
 */
function NoteBlocks({
  blocks,
  scale,
  edge,
}: {
  blocks: Block[];
  scale: PadScale;
  edge: string;
}): ReactElement {
  return (
    <div
      className="min-h-0 flex-1 overflow-hidden whitespace-pre-line text-note-body"
      style={{ marginTop: scale.proseTop, fontSize: scale.proseSize, lineHeight: scale.proseLine }}
    >
      {blocks.map((block, i) => (
        <div key={i} style={{ marginTop: i === 0 ? 0 : scale.blockGap }}>
          <NoteBlock block={block} edge={edge} gap={scale.blockGap} />
        </div>
      ))}
    </div>
  );
}

function NoteBlock({
  block,
  edge,
  gap,
}: {
  block: Block;
  edge: string;
  gap: number;
}): ReactElement {
  if (block.kind === "heading") {
    // One drawn weight for all three depths, `DeckNotesPanel`'s call for its reason: three sizes
    // inside a note on a dashboard card is a type scale nobody chose.
    return (
      <p className="m-0 font-heading font-semibold text-text">
        <Inlines inlines={block.inlines} />
      </p>
    );
  }
  if (block.kind === "list") {
    // A real list marker rather than a drawn glyph in a span: the marker stays out of the
    // element's `textContent` and out of the accessibility tree. The marker takes its colour from
    // the list item, so the note's own edge goes on the `<ul>` and each item puts the text back —
    // which is the artboard's coloured bullet with no interpolated class anywhere near it.
    const items = block.items.map((item, i) => (
      <li key={i} style={{ marginTop: i === 0 ? 0 : Math.round(gap * 0.7) }}>
        <span style={{ color: "var(--color-note-body)" }}>
          <Inlines inlines={item} />
        </span>
      </li>
    ));
    return block.ordered ? (
      <ol start={block.start} className="m-0 list-decimal pl-4" style={{ color: edge }}>
        {items}
      </ol>
    ) : (
      <ul className="m-0 list-disc pl-4" style={{ color: edge }}>
        {items}
      </ul>
    );
  }
  if (block.kind === "quote") {
    return (
      <blockquote className="m-0 border-l-2 pl-2 italic" style={{ borderColor: edge }}>
        <Inlines inlines={block.inlines} />
      </blockquote>
    );
  }
  return (
    <p className="m-0">
      <Inlines inlines={block.inlines} />
    </p>
  );
}

function Inlines({ inlines }: { inlines: readonly Inline[] }): ReactElement {
  return (
    <>
      {inlines.map((run, i) => {
        if (run.kind === "strong") {
          return (
            <strong key={i} className="font-semibold text-text">
              {run.text}
            </strong>
          );
        }
        if (run.kind === "em") {
          return (
            <em key={i} className="italic">
              {run.text}
            </em>
          );
        }
        if (run.kind === "strike") {
          return (
            <s key={i} className="line-through">
              {run.text}
            </s>
          );
        }
        if (run.kind === "code") {
          return (
            <code key={i} className="rounded bg-bg/40 px-1 font-mono text-[0.95em]">
              {run.text}
            </code>
          );
        }
        if (run.kind === "link") {
          // A button and not an `<a href>`: this window has nowhere to navigate to, and an anchor
          // a middle-click could follow would replace the app with a web page.
          return (
            <button
              key={i}
              type="button"
              onClick={() => void openExternal(run.href)}
              className={cn("rounded-sm text-accent underline-offset-2 hover:underline", FOCUS)}
            >
              {run.text}
            </button>
          );
        }
        return <span key={i}>{run.text}</span>;
      })}
    </>
  );
}

/* ----------------------------------------------------------------- empty --------------- */

/**
 * No notes at all — which is every reader's first launch, and is an answer rather than a failure.
 *
 * Its own block rather than a `WidgetMessage`, because the press under the sentence is not a
 * sentence. A still draws the mark and the words and no press: a catalogue preview writes nothing.
 */
function EmptyNotes({
  fit,
  pressable,
  onNew,
}: {
  fit: WidgetFit;
  pressable: boolean;
  onNew: () => void;
}): ReactElement {
  return (
    <div
      className="flex shrink-0 flex-col items-center justify-center gap-2 overflow-hidden text-center"
      style={{ height: fit.bodyHeightPx }}
    >
      <Files className="size-9 flex-none text-border" strokeWidth={1.5} aria-hidden="true" />
      <p className="m-0 text-sm font-medium text-text">{EMPTY_TITLE}</p>
      <p className="m-0 max-w-[215px] text-xs leading-relaxed text-dim">{EMPTY_BLURB}</p>
      {pressable && (
        <button
          type="button"
          onClick={onNew}
          className={cn(
            "mt-0.5 flex h-7 flex-none items-center gap-1.5 rounded-lg border border-accent px-2.5",
            "text-xs text-accent hover:bg-accent/10",
            PRESS,
            FOCUS,
          )}
        >
          <Plus className="size-3.5" aria-hidden="true" />
          New note
        </button>
      )}
    </div>
  );
}

/* ----------------------------------------------------------------- helpers ------------- */

/**
 * When a note was last written, in words — one sentence, drawn by both layouts.
 *
 * ⚠️ **The clock is a default parameter and never a `Date.now()` in a component body.** That call
 * is impure in render and is a hard lint failure this repo has already paid for — green under
 * `tsc` and under vitest, red only at `verify`. `BackupPanel`'s `lastPassLine` is the shape, and
 * its reason holds here too: *2 days ago* is a fact about the render rather than state, and a
 * dashboard card on a timer would be motion with no information in it.
 *
 * @param nowMs the clock in **milliseconds**, which is what {@link ago} takes.
 */
export function edited(note: Pick<StickyNote, "updatedAt">, nowMs: number = Date.now()): string {
  return `Edited ${ago(note.updatedAt, nowMs)}`;
}
