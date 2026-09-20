/**
 * The landing view: the reader's own arrangement of widgets on a grid of square cells, and the
 * gestures that change it — add, remove, move, resize, configure.
 *
 * **This file draws a layout document and owns no state about it.** `useHomeLayout` is where the
 * arrangement lives for the life of the window, `layout.ts` is where every change to it is computed,
 * `fit.ts` is the arithmetic of cells and pixels, and all three are pure of React. What is left here
 * is the mapping from a press or a pointer to one of those functions, and from a stored `kind` to a
 * body — so the state on this page is about the *session*: whether Customize is on, whether the
 * catalogue is open, and the gesture in the reader's hand.
 *
 * ## The rules this page is the last line of
 *
 * **An unknown `kind` is drawn, never thrown on.** `home.rs` stores a kind it has never heard of,
 * `parseLayout` keeps it and `widgets.ts` says outright that `isWidgetKind` is a *renderer's*
 * question — {@link renderBody}'s `default` arm is where that promise is finally kept. A reader
 * running two builds of a portable app is the ordinary case rather than the exotic one, and an older
 * build that emptied the newer build's page would be the exact loss the round-trip rule exists to
 * prevent. The card around it is the ordinary `WidgetCard`, so it keeps its grip, its corner and its
 * remove: a widget this build cannot draw is the one a reader is most likely to move or take away.
 *
 * **The column count is measured, and what is drawn is derived from it — never written back.** The
 * canvas is watched with a `ResizeObserver`; its width gives the columns and the cell (`fit.ts`), and
 * {@link HomePage} draws `normalise(layout.widgets, cols)` as a memo. A stored arrangement outlives
 * the window it was made in, so narrowing the window must not rewrite it: a reader who drags the
 * window narrow for a moment and back gets their page back exactly. Only a gesture writes, and every
 * gesture applies its `layout.ts` function to *the arrangement on screen*, because that is what the
 * reader is pointing at — a move judged free against cells nobody can see would be a move onto a
 * widget.
 *
 * **No `@container`, and no `cqw`.** `container-type` applies layout containment, which makes the box
 * the containing block for every `fixed` descendant — and these cards open anchored popovers and,
 * through them, dialogs whose scrim is a bare `fixed inset-0`. `features/decks/DeckStats.tsx` refuses
 * a container over its own columns in the same words. The design canvas used `100cqw` because its
 * runtime could not measure; this one can, so every length on the grid is a number JS measured and
 * CSS is handed as an inline style (Tailwind scans source *text*, so a computed class emits nothing).
 *
 * **No z-index on a box at rest.** A card's settings popover is anchored inside it and has to paint
 * over the cards after it in the document; a lifted box would be a stacking context capping it. The
 * one box that is raised is the one being dragged, for the length of the drag, from `LAYER`.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { Pencil, Plus, RotateCcw } from "lucide-react";
import { FOCUS } from "@/lib/focus";
import type { HomeLayout, HomeWidget } from "@/lib/ipc";
import { LAYER } from "@/lib/layers";
import { PRESS } from "@/lib/motion";
import { cn } from "@/lib/utils";
import {
  CELL_MIN,
  GAP,
  cellFor,
  columnsFor,
  isStacked,
  makeFit,
  spanPx,
} from "./fit";
import {
  addWidget,
  bounded,
  isFree,
  moveWidget,
  normalise,
  patchConfig,
  removeWidget,
  resizeWidget,
  rowsUsed,
  sameGeometry,
  type CellRect,
} from "./layout";
import { useHomeLayout } from "./useHomeLayout";
import { WidgetCard } from "./WidgetCard";
import { WidgetCatalogue } from "./WidgetCatalogue";
import type { ConfigPatch, WidgetBodyProps } from "./widgetProps";
import { widgetDensity } from "./widgetSettings";
import type { WidgetKind } from "./widgets";
import { ActivityWidget } from "./widgets/ActivityWidget";
import { CollectionValueWidget } from "./widgets/CollectionValueWidget";
import { DecksWidget, DecksWidgetSettings } from "./widgets/DecksWidget";
import { FoldersWidget, FoldersWidgetSettings } from "./widgets/FoldersWidget";
import { PriceMoversWidget } from "./widgets/PriceMoversWidget";
import { RecentCardsWidget } from "./widgets/RecentCardsWidget";
import { SetCompletionWidget } from "./widgets/SetCompletionWidget";
import { StickyNotesWidget } from "./widgets/StickyNotesWidget";
import { SummaryWidget, SummaryWidgetSettings } from "./widgets/SummaryWidget";
import { WishlistValueWidget } from "./widgets/WishlistValueWidget";

/**
 * How a test and a live pass address one widget's box — the grid item the page owns, which carries
 * the placement and, while dragging, the transform.
 *
 * A widget's *card* is addressable by its title, which is what `WidgetCard` builds its accessible
 * name out of; the **box around it** has no name of its own and must not grow one, because it is
 * scenery. The id rather than the kind, because two widgets of one kind are a layout this app builds
 * rather than a case it refuses.
 */
export const HOME_WIDGET_ATTR = "data-home-widget";

/** The measured canvas — the box whose width decides the columns. Scenery, like the boxes. */
export const HOME_CANVAS_ATTR = "data-home-canvas";

/** The sentence under the header while Customize is on — the design's, word for word. */
export const CUSTOMIZE_HINT =
  "Drag a widget anywhere on it, pull the corner to resize, or add one from the catalogue.";

/**
 * The page's own header controls — Add widget, Reset and Customize share one box so the row reads
 * as one control strip rather than three sizes. `h-9` is the app's control height. Nothing here
 * ever greys: Reset is meaningful on any arrangement, including one already at the default.
 */
const HEADER_BUTTON = cn(
  "flex h-9 shrink-0 items-center gap-1.5 rounded-md border px-3 text-sm",
  PRESS,
  FOCUS,
);

/** A header control at rest. `text-dim` is the app's dim text and the only spelling of it. */
const HEADER_RESTING = "border-border text-dim hover:text-text";

/** The accent recipe: Add widget always, Customize while pressed. The hover colour is restated so
 *  the resting recipe's `hover:text-text` cannot win it back. */
const HEADER_ACCENT = "border-accent text-accent hover:text-accent";

/** The glyph inside a header control, at the type size beside it. */
const HEADER_ICON = "size-4";

/**
 * The editing grid's guides: a dashed rule down the middle of every gap.
 *
 * **Lines in the gaps rather than dots in the cells** — the design's reasoning: a line says where a
 * widget's *edge* can land, which is what a reader is aiming at while dragging or pulling a corner;
 * a dot at a cell's centre marks the one place nothing ever snaps to. The colour is the border token
 * thinned, so the guides read as the page's own furniture and never as a second set of cards.
 */
const GUIDE_STROKE = "1px dashed color-mix(in oklab, var(--color-border) 60%, transparent)";

/** The ghost's two colourings, whole class strings. Free is the accent; refused is destructive, so
 *  the answer is on screen before the pointer is let go. */
const GHOST_FREE = "border-accent bg-accent/12";
const GHOST_REFUSED = "border-destructive bg-destructive/12";

/**
 * A widget from a build that is not this one: the sentence that says so.
 *
 * The heading is the card's (`widgetTitle` answers `Unknown widget (kind)` for a kind this build does
 * not know), so two widgets from a newer build are two addressable cards rather than one name twice.
 * It carries no settings of its own — an empty panel is a question with no answers in it — and the
 * card's shared rows (size, density, title) still work, because they are config every kind has.
 */
function UnknownWidgetBody(): ReactElement {
  return (
    <p className="text-sm text-dim">
      This widget came from a newer version of MTG Grimoire. Update to draw it here, or remove it —
      either way, this build leaves its settings exactly as it found them.
    </p>
  );
}

/**
 * One stored entry, as the body that draws it.
 *
 * A `switch` over a `string` rather than a lookup keyed by `WidgetKind`, because the value genuinely
 * is a `string`: a record would answer `undefined` for a kind a newer build wrote and put the check
 * somewhere a reader of this file cannot see. The `default` arm is the whole point — see the module
 * doc. Handed to the catalogue as a prop, so a preview is drawn through the one switch the page
 * draws with and `WidgetCatalogue.tsx` has no import back into this file.
 */
function renderBody(props: WidgetBodyProps): ReactElement {
  switch (props.widget.kind) {
    case "summary":
      return <SummaryWidget {...props} />;
    case "decks":
      return <DecksWidget {...props} />;
    case "folders":
      return <FoldersWidget {...props} />;
    case "collectionValue":
      return <CollectionValueWidget {...props} />;
    case "wishlistValue":
      return <WishlistValueWidget {...props} />;
    case "activity":
      return <ActivityWidget {...props} />;
    case "recentCards":
      return <RecentCardsWidget {...props} />;
    case "setCompletion":
      return <SetCompletionWidget {...props} />;
    case "priceMovers":
      return <PriceMoversWidget {...props} />;
    case "stickyNotes":
      return <StickyNotesWidget {...props} />;
    default:
      return <UnknownWidgetBody />;
  }
}

/** The settings a kind has beyond its registry rows — drawn at the foot of the card's popover. A
 *  kind with none answers `undefined`, which draws nothing rather than an empty section. */
function renderExtraSettings(widget: HomeWidget, onConfig: ConfigPatch): ReactNode {
  switch (widget.kind) {
    case "summary":
      return <SummaryWidgetSettings widget={widget} onConfig={onConfig} />;
    case "decks":
      return <DecksWidgetSettings widget={widget} onConfig={onConfig} />;
    case "folders":
      return <FoldersWidgetSettings widget={widget} onConfig={onConfig} />;
    default:
      return undefined;
  }
}

/**
 * The canvas's width, measured, and the ref that measures it.
 *
 * **A callback ref rather than `useDeskWidth`'s effect over a `RefObject`**, and the difference is
 * the first paint. A ref callback is called in the commit, before the browser paints, and a state
 * write made there is flushed synchronously — so the page's first frame is already drawn at the
 * measured columns rather than one frame later at a guessed width. It also names no dependency: the
 * callback is handed the element itself, so nothing depends on a `RefObject` that notifies nobody.
 * React 19 runs the returned function as the ref's cleanup, which is where the observer is given
 * back.
 *
 * `0` is **unmeasured** — jsdom, which lays nothing out, and nothing else in practice. The page reads
 * it as "draw the stack" rather than as a canvas of no width, because a stack at an unknown width is
 * a wrong size, where a grid at a guessed column count is a wrong *arrangement*.
 *
 * A setter handed the same number bails out, so the observer answering a height change (the page
 * grew a row) costs nothing.
 */
function useCanvasWidth(): [(el: HTMLElement | null) => (() => void) | undefined, number] {
  const [width, setWidth] = useState(0);
  const ref = useCallback((el: HTMLElement | null) => {
    if (el === null) return undefined;
    const measure = () => setWidth(el.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

/** The gesture in the reader's hand: which widget, which kind of pull, how far the pointer has
 *  travelled, and the cells it would land on with whether they are free. */
interface Gesture {
  id: string;
  mode: "move" | "resize";
  dx: number;
  dy: number;
  ghost: CellRect & { ok: boolean };
}

/**
 * The home page.
 *
 * The title is the ribbon's — `NAV` names the view — so the `<h2>` here is `sr-only`, which is
 * `DecksPage`'s and `TagsPage`'s arrangement: a second visible "Home" under the ribbon's own would be
 * a subheading repeating its heading.
 */
export function HomePage(): ReactElement {
  const { layout, ready, update, reset } = useHomeLayout();

  // Session state, all of it. A reader who left Customize on does not want to find it on tomorrow.
  const [editing, setEditing] = useState(false);
  const [catalogueOpen, setCatalogueOpen] = useState(false);
  const [gesture, setGesture] = useState<Gesture | null>(null);

  const [canvasRef, width] = useCanvasWidth();
  const measured = width > 0;
  const cols = columnsFor(width);
  const cell = cellFor(width, cols);
  /** One widget per row: a canvas too narrow for a readable cell — or not measured yet. */
  const stacked = !measured || isStacked(width);

  /**
   * The arrangement as drawn: the stored one brought inside this many columns.
   *
   * **A memo and never a write** — see the module doc. `normalise` is idempotent, so a document that
   * already fits is answered with the same geometry and this costs a pass over a dozen widgets.
   */
  const shown = useMemo(() => normalise(layout.widgets, cols), [layout.widgets, cols]);
  const arranged = useMemo<HomeLayout>(() => ({ ...layout, widgets: shown }), [layout, shown]);

  const empty = layout.widgets.length === 0;

  /**
   * Whether the header carries **Add widget** and **Reset**.
   *
   * Edit mode is the usual way in. The empty page is the other, and it is not an indulgence:
   * `useHomeLayout` keeps an empty document rather than re-seeding it — a reader who removed every
   * widget has said something — so without this the only page with nothing on it would also be the
   * only page with no way to put anything back.
   */
  const tray = editing || empty;

  /**
   * What a pointer listener on `window` reads when it fires.
   *
   * **A ref written after every commit, rather than closures over this render's values**, because a
   * drag outlives the render that started it: the pointer moves, the page re-renders with the ghost,
   * and the listener registered at the press is still the one being called. Reading this render's
   * `arranged` from it would judge a drop against the arrangement from before the drag — and if the
   * window was resized mid-drag, against the wrong column count.
   */
  const live = useRef({ arranged, cols, cell, update });
  useLayoutEffect(() => {
    live.current = { arranged, cols, cell, update };
  });

  /**
   * The listeners a gesture put on `window`, and how to take them off — held in a ref object that
   * is itself never replaced, so the unmount cleanup below can capture it once.
   */
  const held = useRef<{ release: (() => void) | null }>({ release: null });
  useEffect(() => {
    const hand = held.current;
    // A page that unmounts mid-drag — a view switch from the keyboard — must not leave three
    // listeners on `window` writing into a component that no longer exists.
    return () => hand.release?.();
  }, []);

  /** Write an arrangement a geometry gesture produced — **unless it changed nothing**, which is a
   *  refused move, a drag let go where it began, or a stepper at its bound. A write that restores
   *  the page it replaced is still a write, and an optimistic one re-renders every card. */
  const commitGeometry = useCallback(
    (next: HomeLayout) => {
      if (sameGeometry(next.widgets, arranged.widgets)) return;
      update(next);
    },
    [arranged, update],
  );

  /**
   * A press on a card (move) or on its corner (resize), followed to its release.
   *
   * **Snapped as it goes, committed once.** Every pointer move rounds the travel to whole cells and
   * redraws the ghost, green where the cells are free and red where they are not; only the release
   * writes, and only a free ghost — `moveWidget` and `resizeWidget` refuse an overlap themselves,
   * but a ghost that said "no" and a drop that did something anyway would be two answers. A
   * `pointercancel` (the window losing the pointer) puts everything down unwritten.
   *
   * The listeners are on `window` rather than on the card, so a pointer that leaves the card — which
   * a drag across the page does at once — is still followed.
   */
  const startGesture = useCallback(
    (widget: HomeWidget, mode: Gesture["mode"], event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0) return;
      // No text selection swept across the page, and no native drag of whatever was under the press.
      event.preventDefault();
      held.current.release?.();

      const step = live.current.cell + GAP;
      const originX = event.clientX;
      const originY = event.clientY;
      const start: CellRect = { x: widget.x, y: widget.y, w: widget.w, h: widget.h };
      let ghost: Gesture["ghost"] = { ...start, ok: true };

      const follow = (e: PointerEvent) => {
        const { arranged: now, cols: across } = live.current;
        const dx = e.clientX - originX;
        const dy = e.clientY - originY;
        const cx = Math.round(dx / step);
        const cy = Math.round(dy / step);
        let rect: CellRect;
        if (mode === "move") {
          rect = {
            ...start,
            x: Math.max(0, Math.min(Math.max(0, across - start.w), start.x + cx)),
            y: Math.max(0, start.y + cy),
          };
        } else {
          const [w, h] = bounded(
            widget.kind,
            Math.min(across - start.x, start.w + cx),
            start.h + cy,
            across,
          );
          rect = { ...start, w, h };
        }
        ghost = { ...rect, ok: isFree(now.widgets, rect, across, widget.id) };
        setGesture({ id: widget.id, mode, dx, dy, ghost });
      };

      const finish = (commit: boolean) => {
        held.current.release?.();
        setGesture(null);
        if (!commit || !ghost.ok) return;
        const { arranged: now, cols: across, update: write } = live.current;
        const next =
          mode === "move"
            ? moveWidget(now, widget.id, ghost.x, ghost.y, across)
            : resizeWidget(now, widget.id, ghost.w, ghost.h, across);
        if (!sameGeometry(next.widgets, now.widgets)) write(next);
      };
      const drop = () => finish(true);
      const cancel = () => finish(false);

      window.addEventListener("pointermove", follow);
      window.addEventListener("pointerup", drop);
      window.addEventListener("pointercancel", cancel);
      held.current.release = () => {
        window.removeEventListener("pointermove", follow);
        window.removeEventListener("pointerup", drop);
        window.removeEventListener("pointercancel", cancel);
        held.current.release = null;
      };

      setGesture({ id: widget.id, mode, dx: 0, dy: 0, ghost });
    },
    [],
  );

  /** The grip's arrow keys: one cell. Up at the top row stays on the top row rather than refusing,
   *  so the press is a no-op and not a move off the page. */
  const nudge = useCallback(
    (widget: HomeWidget, dx: number, dy: number) =>
      commitGeometry(
        moveWidget(arranged, widget.id, widget.x + dx, Math.max(0, widget.y + dy), cols),
      ),
    [arranged, cols, commitGeometry],
  );

  /** The corner's arrow keys and the size steppers: one cell more or less. */
  const grow = useCallback(
    (widget: HomeWidget, dw: number, dh: number) =>
      commitGeometry(resizeWidget(arranged, widget.id, widget.w + dw, widget.h + dh, cols)),
    [arranged, cols, commitGeometry],
  );

  /** Can the footprint change by this much? Inside the kind's bounds (the bounded footprint is not
   *  the current one) *and* onto free cells — a stepper that says yes and a press that refuses would
   *  be two answers. */
  const canGrow = useCallback(
    (widget: HomeWidget, dw: number, dh: number) => {
      const [w, h] = bounded(widget.kind, widget.w + dw, widget.h + dh, cols);
      if (w === widget.w && h === widget.h) return false;
      return isFree(arranged.widgets, { x: widget.x, y: widget.y, w, h }, cols, widget.id);
    },
    [arranged, cols],
  );

  const configure = useCallback(
    (id: string, fields: Record<string, unknown>) => update(patchConfig(arranged, id, fields)),
    [arranged, update],
  );

  const remove = useCallback(
    (id: string) => update(removeWidget(arranged, id)),
    [arranged, update],
  );

  /* ------------------------------------------------------------------ the catalogue ------- */

  const addButton = useRef<HTMLButtonElement>(null);
  const customizeButton = useRef<HTMLButtonElement>(null);
  /** Set by the two closes that owe the caret back (Escape, ✕, an Add) and read once the dialog has
   *  gone — `Dialog`'s rule: an outside click does not move focus, because the reader is already
   *  somewhere else. */
  const returnCaret = useRef(false);

  useEffect(() => {
    if (catalogueOpen || !returnCaret.current) return;
    returnCaret.current = false;
    // After the commit that closed it, so the opener is judged as it now is: an Add from the empty
    // page takes the tray away with the emptiness, and the caret goes to Customize instead of to a
    // button that no longer exists.
    (addButton.current ?? customizeButton.current)?.focus();
  }, [catalogueOpen]);

  const dismissCatalogue = useCallback(() => {
    returnCaret.current = true;
    setCatalogueOpen(false);
  }, []);

  /** An Add press: the kind at its own footprint, at the first free cell of the grid on screen. */
  const add = useCallback(
    (kind: WidgetKind) => {
      update(addWidget(arranged, kind, cols));
      returnCaret.current = true;
      setCatalogueOpen(false);
    },
    [arranged, cols, update],
  );

  /* ----------------------------------------------------------------------- drawing ------- */

  const used = rowsUsed(shown);
  // Four spare rows under the arrangement while Customize is on, none when it is off: room to drag
  // a widget somewhere new is worth the scroll it costs only while there is something to drag, and
  // an empty row under the last card reads as a widget that failed to draw.
  const rows = editing ? Math.max(8, used + 4) : Math.max(1, used);
  const step = cell + GAP;

  /** One card, with everything the page hands it. `box` is the pixels it is drawn at, which on the
   *  grid is its footprint and in the stack is the canvas's width. */
  const card = (widget: HomeWidget, box: { widthPx: number; heightPx: number }): ReactElement => {
    const fit = makeFit({ w: widget.w, h: widget.h, ...box, density: widgetDensity(widget) });
    const onConfig: ConfigPatch = (fields) => configure(widget.id, fields);
    return (
      <WidgetCard
        widget={widget}
        fit={fit}
        editing={editing}
        dragging={gesture?.mode === "move" && gesture.id === widget.id}
        arrangeable={!stacked}
        onDragStart={stacked ? undefined : (event) => startGesture(widget, "move", event)}
        onResizeStart={stacked ? undefined : (event) => startGesture(widget, "resize", event)}
        onNudge={stacked ? undefined : (dx, dy) => nudge(widget, dx, dy)}
        onGrow={(dw, dh) => grow(widget, dw, dh)}
        canGrow={(dw, dh) => canGrow(widget, dw, dh)}
        onConfig={onConfig}
        onRemove={() => remove(widget.id)}
        extraSettings={renderExtraSettings(widget, onConfig)}
      >
        {/* No inert wrapper: `WidgetCard` makes its body's contents inert while Customize is on,
            which is where `WidgetBodyProps.editing`'s promise is kept for every kind at once. */}
        {renderBody({ widget, fit, editing, still: false, onConfig })}
      </WidgetCard>
    );
  };

  return (
    <section className="flex min-h-full flex-col gap-3">
      {/* Not drawn: the ribbon's own heading already names the view. */}
      <h2 className="sr-only">Home</h2>

      {/* The page's header row, not the ribbon's — the ribbon is for actions that mean the same
          thing on every view, and rearranging this one means nothing anywhere else. */}
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <p className="min-w-0 flex-1 text-sm text-dim">{editing ? CUSTOMIZE_HINT : null}</p>
        {tray && (
          <>
            <button
              ref={addButton}
              type="button"
              onClick={() => setCatalogueOpen(true)}
              className={cn(HEADER_BUTTON, HEADER_ACCENT)}
            >
              <Plus className={HEADER_ICON} aria-hidden="true" />
              Add widget
            </button>
            <button type="button" onClick={reset} className={cn(HEADER_BUTTON, HEADER_RESTING)}>
              <RotateCcw className={HEADER_ICON} aria-hidden="true" />
              Reset
            </button>
          </>
        )}
        <button
          ref={customizeButton}
          type="button"
          aria-pressed={editing}
          onClick={() => setEditing((on) => !on)}
          className={cn(HEADER_BUTTON, editing ? HEADER_ACCENT : HEADER_RESTING)}
        >
          <Pencil className={HEADER_ICON} aria-hidden="true" />
          {editing ? "Done" : "Customize"}
        </button>
      </div>

      {/*
        **`ready` is what separates two pages that look identical.** Before the stored document
        answers, a page with no widgets is a page that has not spoken yet; after it answers, the
        same page is a reader who cleared it. Drawing this over the first would greet every launch
        with a sentence that vanishes a moment later.
      */}
      {ready && empty && (
        <p className="text-sm text-dim">
          Your home page is empty. Add a widget to put something back on it, or reset to the ones
          this app starts with.
        </p>
      )}

      {/* The canvas is always mounted — it is what is measured, and a measurement that waited for
          widgets would leave an empty page's first Add placed against no grid at all. */}
      <div ref={canvasRef} {...{ [HOME_CANVAS_ATTR]: "" }} className="min-w-0">
        {stacked ? (
          // One widget per row, in reading order, at the full canvas width and at the height its
          // footprint has on the narrowest readable grid. There is no grid to drop on, so the cards
          // are not arrangeable; the size steppers still write the footprint the wide page uses.
          <div className="flex flex-col" style={{ gap: GAP }}>
            {[...shown]
              .sort((a, b) => a.y - b.y || a.x - b.x)
              .map((widget) => {
                const heightPx = spanPx(widget.h, CELL_MIN);
                return (
                  <div
                    key={widget.id}
                    {...{ [HOME_WIDGET_ATTR]: widget.id }}
                    className="relative flex min-w-0 flex-col"
                    style={{ height: heightPx }}
                  >
                    {card(widget, { widthPx: width, heightPx })}
                  </div>
                );
              })}
          </div>
        ) : (
          (editing || shown.length > 0) && (
            // `relative` so the guides are positioned against the grid's own box, which is exactly
            // `rows` cells tall — a guide against anything taller would run past the last row.
            <div className="relative">
              {editing && (
                <div aria-hidden="true" className="pointer-events-none absolute inset-0">
                  {Array.from({ length: Math.max(0, cols - 1) }, (_, i) => (
                    <span
                      key={`v${i}`}
                      className="absolute inset-y-0 opacity-50"
                      style={{ left: (i + 1) * step - GAP / 2, borderLeft: GUIDE_STROKE }}
                    />
                  ))}
                  {Array.from({ length: Math.max(0, rows - 1) }, (_, i) => (
                    <span
                      key={`h${i}`}
                      className="absolute inset-x-0 opacity-50"
                      style={{ top: (i + 1) * step - GAP / 2, borderTop: GUIDE_STROKE }}
                    />
                  ))}
                </div>
              )}

              <div
                className="grid"
                style={{
                  gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
                  gridTemplateRows: `repeat(${rows}, ${cell}px)`,
                  gap: GAP,
                }}
              >
                {shown.map((widget) => {
                  const dragging = gesture?.mode === "move" && gesture.id === widget.id;
                  return (
                    <div
                      key={widget.id}
                      {...{ [HOME_WIDGET_ATTR]: widget.id }}
                      // `relative` and nothing else at rest — see the module doc on z-index. The box
                      // being dragged is lifted over the ghost and every other card.
                      className={cn("relative flex min-w-0 flex-col", dragging && LAYER.raised)}
                      style={{
                        gridColumn: `${widget.x + 1} / span ${widget.w}`,
                        gridRow: `${widget.y + 1} / span ${widget.h}`,
                        transform: dragging
                          ? `translate(${gesture.dx}px, ${gesture.dy}px)`
                          : undefined,
                      }}
                    >
                      {card(widget, {
                        widthPx: spanPx(widget.w, cell),
                        heightPx: spanPx(widget.h, cell),
                      })}
                    </div>
                  );
                })}

                {/*
                  Where the gesture would land. **Last in the grid and `relative` with no z-index**,
                  so it paints over every resting card by document order — a refusal is drawn *over*
                  the card in the way, which is the one place it has to be visible — and under the
                  card being dragged, which is the one box that is raised.
                */}
                {gesture !== null && (
                  <div
                    aria-hidden="true"
                    className={cn(
                      "pointer-events-none relative rounded-lg border-2",
                      gesture.ghost.ok ? GHOST_FREE : GHOST_REFUSED,
                    )}
                    style={{
                      gridColumn: `${gesture.ghost.x + 1} / span ${gesture.ghost.w}`,
                      gridRow: `${gesture.ghost.y + 1} / span ${gesture.ghost.h}`,
                    }}
                  />
                )}
              </div>
            </div>
          )
        )}
      </div>

      <WidgetCatalogue
        open={catalogueOpen}
        layout={layout}
        onAdd={add}
        onDismiss={dismissCatalogue}
        onClose={() => setCatalogueOpen(false)}
        renderBody={renderBody}
      />
    </section>
  );
}
