/**
 * The landing view: the reader's own arrangement of widgets, and the four gestures that change
 * it — add, remove, widen, reorder.
 *
 * **This file draws a layout document and owns no state about it.** `useHomeLayout` is where the
 * arrangement lives for the life of the window, `layout.ts` is where every change to it is
 * computed, and both are pure of React. What is left here is the mapping from a press to one of
 * those functions and from a stored `kind` to a component — which is why the only `useState` on
 * the page is whether **Customize** is on, a fact about this session and not about the document.
 *
 * ## The three rules this page is the last line of
 *
 * **An unknown `kind` is drawn, never thrown on.** `home.rs` stores a kind it has never heard of,
 * `parseLayout` keeps it and `widgets.ts` says outright that `isWidgetKind` is a *renderer's*
 * question — {@link renderWidget}'s `default` arm is where that promise is finally kept. A reader
 * running two builds of a portable app is the ordinary case rather than the exotic one, and an
 * older build that emptied the newer build's page would be the exact loss the whole round-trip
 * rule exists to prevent. The placeholder keeps its full edit tray on purpose: a widget this build
 * cannot draw is the one a reader is most likely to want to move or take off the page.
 *
 * **No `@container`, here or in `WidgetCard`.** `container-type: inline-size` applies layout
 * containment, which makes the box the containing block for every `fixed` descendant — and these
 * widgets open anchored popovers, context menus and, through them, dialogs whose scrim is a bare
 * `fixed inset-0` that corrects for nothing. `features/decks/DeckStats.tsx` refuses a container
 * over its own two columns in the same words. The row wraps with flexbox instead, and
 * {@link WIDGET_CARD_BOX}/{@link WIDGET_CARD_WIDE} are whole class strings rather than a width
 * computed from `span`, because Tailwind scans source *text* and an interpolated class emits no
 * rule at all.
 *
 * **The page does no arithmetic about position.** `useWidgetDropTarget` reports *which widget was
 * dragged* and *which edge of this one it was let go on*, and `moveWidget` takes exactly that
 * pair — so a drop is one call with nothing computed in between. An index worked out here would
 * be an index into the list *before* the dragged widget was lifted out of it, and one too high for
 * every forward move. The arrow keys go the same way: {@link HomePage} turns a delta into the
 * neighbouring widget's id and hands `moveWidget` an edge, because `dndManager` ships no
 * `KeyboardSensor` and a reorder that was only a drag would be a rearrange half the readers do
 * not have.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { Pencil, RotateCcw } from "lucide-react";
import { Dropdown } from "@/components/Dropdown/Dropdown";
import type { DropdownOption } from "@/components/Dropdown/types";
import { FOCUS } from "@/lib/focus";
import type { HomeWidget } from "@/lib/ipc";
import { PRESS } from "@/lib/motion";
import { sortOptions } from "@/lib/options";
import { cn } from "@/lib/utils";
import { useWidgetDropTarget, widgetDraggable, type WidgetEdge } from "./homeDrag";
import { addWidget, moveWidget, removeWidget, setConfig, setSpan, widgetSpan } from "./layout";
import { useHomeLayout } from "./useHomeLayout";
import { WIDGET_CARD_BOX, WIDGET_CARD_WIDE, WidgetCard } from "./WidgetCard";
import { WidgetDropLine } from "./WidgetDropLine";
import type { WidgetProps } from "./widgetProps";
import { isWidgetKind, WIDGETS } from "./widgets";
import { ActivityWidget } from "./widgets/ActivityWidget";
import { CollectionValueWidget } from "./widgets/CollectionValueWidget";
import { DecksWidget } from "./widgets/DecksWidget";
import { FoldersWidget } from "./widgets/FoldersWidget";
import { SummaryWidget } from "./widgets/SummaryWidget";
import { WishlistValueWidget } from "./widgets/WishlistValueWidget";

/**
 * How a test and a live pass address one widget's box — the element the page owns, which is the
 * one carrying the width and the drop target.
 *
 * `WIDGET_DROP_LINE_ATTR`'s shape and its reason. A widget's *card* is addressable by its heading,
 * which is what `WidgetCard` builds the accessible name out of; the **box around it** has no name
 * of its own and must not grow one, because it is scenery. The id rather than the kind, because
 * two widgets of one kind are a layout this app builds rather than a case it refuses.
 */
export const HOME_WIDGET_ATTR = "data-home-widget";

/**
 * The page's own header controls — Customize, Add widget's trigger and Reset share one box so the
 * row reads as one control strip rather than three sizes.
 *
 * `h-9` is `DropdownSize`'s `md`, read off the dropdown standing beside them rather than chosen
 * again. `text-dim` is the app's dim text and the only spelling of it. Nothing here ever greys —
 * Reset is meaningful on any arrangement, including one already at the default — so there is no
 * out-of-reach clause; anything that ever does grey uses `aria-disabled` and keeps its tab stop.
 */
const HEADER_BUTTON = cn(
  "flex h-9 shrink-0 items-center gap-1.5 rounded-md border border-border px-3 text-sm",
  "text-dim hover:text-text",
  PRESS,
  FOCUS,
);

/** Customize while it is on, in the accent that means *pressed* everywhere else in this app. The
 *  hover colour is restated so the resting recipe's `hover:text-text` cannot win it back. */
const HEADER_PRESSED = "border-accent text-accent hover:text-accent";

/** The glyph inside a header control, at the type size beside it. */
const HEADER_ICON = "size-4";

/**
 * A widget from a build that is not this one.
 *
 * **Drawn rather than dropped, and drawn with its whole tray.** The document round-trips an
 * unknown `kind` and its opaque `config` untouched — `home.rs` refuses no kind, `parseLayout`
 * keeps it — and this is the sentence that says so to the reader. It carries no `settings`
 * popover, because an empty panel is a question with no answers in it.
 *
 * The kind is in the heading rather than only in the sentence, so two widgets from a newer build
 * are two addressable cards instead of one name repeated: every control in the tray folds the
 * heading into its own accessible name.
 */
function UnknownWidget({
  widget,
  editing,
  onRemove,
  onSpan,
  dragHandleRef,
  onNudge,
}: WidgetProps): ReactElement {
  return (
    <WidgetCard
      heading={`Unknown widget (${widget.kind})`}
      editing={editing}
      span={widgetSpan(widget)}
      onRemove={onRemove}
      onSpan={onSpan}
      dragHandleRef={dragHandleRef}
      onNudge={onNudge}
    >
      <p className="text-sm text-dim">
        This widget came from a newer version of MTG Grimoire. Update to draw it here, or remove it
        — either way, this build leaves its settings exactly as it found them.
      </p>
    </WidgetCard>
  );
}

/**
 * One stored entry, as the component that draws it.
 *
 * A `switch` over a `string` rather than a lookup keyed by {@link WidgetKind}, because the value
 * genuinely is a `string`: a record would answer `undefined` for a kind a newer build wrote and
 * put the check somewhere a reader of this file cannot see. The `default` arm is the whole point —
 * see the module doc.
 */
function renderWidget(props: WidgetProps): ReactElement {
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
    default:
      return <UnknownWidget {...props} />;
  }
}

/**
 * The box one widget is drawn in: its width in the row, its drop target, and its drag source.
 *
 * **Its own component because the drag needs a per-widget element and per-widget state**, and a
 * hook cannot be called in a loop. It also happens to be where the width lives, which is a second
 * reason it is not simply `renderWidget` called in a `map`: `WidgetCard` puts the width class on
 * the card, and the drop line has to be positioned against a box the *page* owns — the card is the
 * widget's, and a widget is free to draw anything inside it.
 *
 * The wrapper carries the same two width recipes the card does. That is not a duplicate: the
 * wrapper is what the wrapping row lays out, and the card fills it. Both are the whole strings
 * from `WidgetCard`, never a computed one.
 */
function WidgetSlot({
  widget,
  editing,
  onRemove,
  onSpan,
  onConfig,
  onNudge,
  onDrop,
}: {
  widget: HomeWidget;
  editing: boolean;
  onRemove: (id: string) => void;
  onSpan: (id: string, span: 1 | 2) => void;
  onConfig: (id: string, config: unknown) => void;
  onNudge: (id: string, delta: -1 | 1) => void;
  /** The dragged widget, this widget, and the side of it the drop landed on — `moveWidget`'s
   *  three arguments, in that order, with nothing computed on the way. */
  onDrop: (dragged: string, targetId: string, edge: WidgetEdge) => void;
}): ReactElement {
  const box = useRef<HTMLDivElement>(null);

  // The callback is read through a ref inside the hook, so an inline arrow here does not tear the
  // droppable down and re-register it every time the layout answers.
  const { edge } = useWidgetDropTarget({
    ref: box,
    widgetId: widget.id,
    onDrop: (dragged, at) => onDrop(dragged, widget.id, at),
  });

  /**
   * The grip, held as **state** rather than in a ref — which is the difference between a
   * registration that happens and one that never runs again.
   *
   * `WidgetCard`'s contract is a ref callback: the element on the render that draws the tray, and
   * `null` when Customize goes off and the grip unmounts. `widgetDraggable` answers a teardown
   * rather than watching an element, so something has to pair the two — and an effect is the only
   * place that can, because a ref holds no value React re-renders on. `useState`'s setter is
   * stable for the life of the component, which is the other half of the contract: React 19
   * re-runs a ref callback whose *identity* changed, so an unstable one would unregister and
   * re-register the draggable on every render of the page, including the ones a drag it started
   * is causing.
   *
   * `DeckTile` registers the same way one component over, off a `useRef` it can put on the
   * element itself; only a grip handed back by somebody else's card needs this shape.
   */
  const [grip, setGrip] = useState<HTMLElement | null>(null);

  useEffect(() => {
    if (grip === null) return;
    return widgetDraggable({ element: grip, widgetId: widget.id });
  }, [grip, widget.id]);

  const props: WidgetProps = {
    widget,
    editing,
    onRemove: () => onRemove(widget.id),
    onSpan: (span) => onSpan(widget.id, span),
    onConfig: (config) => onConfig(widget.id, config),
    onNudge: (delta) => onNudge(widget.id, delta),
    dragHandleRef: setGrip,
  };

  return (
    <div
      ref={box}
      {...{ [HOME_WIDGET_ATTR]: widget.id }}
      // `relative` is what the drop line is absolute against; `flex` is what makes the card fill
      // the box rather than sit at its content width.
      className={cn("relative flex", widgetSpan(widget) === 2 ? WIDGET_CARD_WIDE : WIDGET_CARD_BOX)}
    >
      {renderWidget(props)}
      <WidgetDropLine edge={edge} />
    </div>
  );
}

/**
 * The home page.
 *
 * The title is the ribbon's — `NAV` names the view — so the `<h2>` here is `sr-only`, which is
 * `DecksPage`'s and `TagsPage`'s arrangement: a second visible "Home" under the ribbon's own would
 * be a subheading repeating its heading.
 */
export function HomePage(): ReactElement {
  const { layout, ready, update, reset } = useHomeLayout();

  // The one piece of state on this page, and it is about the session rather than the document:
  // a reader who left Customize on does not want to find it on tomorrow.
  const [editing, setEditing] = useState(false);

  const empty = layout.widgets.length === 0;

  /**
   * Whether the header carries **Add widget** and **Reset**.
   *
   * Edit mode is the usual way in. The empty page is the other, and it is not an indulgence:
   * `useHomeLayout` keeps an empty document rather than re-seeding it — a reader who removed every
   * widget has said something — so without this the only page with nothing on it would also be the
   * only page with no way to put anything back except a control whose own affordances are all on
   * the cards that are gone.
   */
  const tray = editing || empty;

  const remove = useCallback(
    (id: string) => update(removeWidget(layout, id)),
    [layout, update],
  );

  const span = useCallback(
    (id: string, width: 1 | 2) => update(setSpan(layout, id, width)),
    [layout, update],
  );

  const config = useCallback(
    (id: string, value: unknown) => update(setConfig(layout, id, value)),
    [layout, update],
  );

  const drop = useCallback(
    (dragged: string, targetId: string, edge: WidgetEdge) =>
      update(moveWidget(layout, dragged, targetId, edge)),
    [layout, update],
  );

  /**
   * The keyboard's reorder: one step earlier or later in the row.
   *
   * A delta becomes the *neighbour's id* and an edge, which is the only shape `moveWidget` takes —
   * so the two ways to move a widget are the same call and cannot come to disagree. A widget at
   * either end has no neighbour on that side and the press does nothing, which is honest: there is
   * nowhere further to go, and wrapping around would move a card the length of the page under a
   * reader who asked for one step.
   */
  const nudge = useCallback(
    (id: string, delta: -1 | 1) => {
      const at = layout.widgets.findIndex((entry) => entry.id === id);
      if (at === -1) return;
      const neighbour = layout.widgets[at + delta];
      if (neighbour === undefined) return;
      update(moveWidget(layout, id, neighbour.id, delta === -1 ? "before" : "after"));
    },
    [layout, update],
  );

  /**
   * Add one of the kinds this build can draw.
   *
   * The dropdown speaks strings, and the guard is what turns one back into a `WidgetKind` — by
   * lookup rather than by a cast, so a value the list does not hold reaches neither the document
   * nor the write.
   */
  const add = useCallback(
    (kind: string) => {
      if (!isWidgetKind(kind)) return;
      update(addWidget(layout, kind));
    },
    [layout, update],
  );

  /** The Add widget menu's rows — `sortOptions`' order like every other option list in this app,
   *  never the registry's own insertion order. The description is the row's tooltip rather than
   *  its `hint`, which is a dim right-aligned second *fact* and not a sentence. */
  const options = useMemo<DropdownOption[]>(
    () =>
      sortOptions(WIDGETS, (meta) => meta.label).map((meta) => ({
        value: meta.kind,
        label: meta.label,
        title: meta.description,
      })),
    [],
  );

  return (
    <section className="flex h-full flex-col gap-3">
      {/* Not drawn: the ribbon's own heading already names the view. */}
      <h2 className="sr-only">Home</h2>

      {/* The page's header row, not the ribbon's — the ribbon is for actions that mean the same
          thing on every view, and rearranging this one means nothing anywhere else. */}
      <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
        {tray && (
          <>
            <Dropdown
              // A menu of actions spelled as the app's one option list: picking a row adds that
              // widget and the trigger goes straight back to saying what it does, because there
              // is no value here for it to be set to.
              label="Add widget"
              placeholder="Add widget"
              value=""
              options={options}
              onChange={add}
              align="end"
            />
            <button type="button" onClick={reset} className={HEADER_BUTTON}>
              <RotateCcw className={HEADER_ICON} aria-hidden="true" />
              Reset
            </button>
          </>
        )}
        <button
          type="button"
          aria-pressed={editing}
          onClick={() => setEditing((on) => !on)}
          className={cn(HEADER_BUTTON, editing && HEADER_PRESSED)}
        >
          <Pencil className={HEADER_ICON} aria-hidden="true" />
          Customize
        </button>
      </div>

      {/*
        **`flex flex-wrap`, and deliberately not a container query or a grid** — see the module
        doc. `items-start` so a short widget beside a tall one keeps its own height instead of
        being stretched to the tallest card on its line.
      */}
      <div className="flex flex-wrap items-start gap-3">
        {layout.widgets.map((widget) => (
          <WidgetSlot
            key={widget.id}
            widget={widget}
            editing={editing}
            onRemove={remove}
            onSpan={span}
            onConfig={config}
            onNudge={nudge}
            onDrop={drop}
          />
        ))}
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
    </section>
  );
}
