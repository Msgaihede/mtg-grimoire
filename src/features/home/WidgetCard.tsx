/**
 * The card every home-page widget is drawn in — the frame, the title line, the chip, the settings
 * popover, the question before a remove, the grip and the resize corner — around a body that knows
 * nothing about any of them.
 *
 * **The page draws every card's chrome and a widget draws only its body** (`widgetProps.ts`). All of
 * this is identical for every kind, so it is written once here, and a body is a scroll container's
 * contents and nothing else. Drawn to the grid redesign's `Widget.dc.html` and the settings and
 * confirmation panels of `widget-home.dc.html`.
 *
 * ## What this component is the only place for
 *
 * **The title is the card's accessible name.** A `<section>` with a name is a `region`, so a test, a
 * live pass and a screen reader address a widget by what it says rather than by where it sits — and
 * where it sits is the one thing about a widget a reader is free to change. The name is the stored
 * title (`widgetTitle`), never the field's draft, so a card does not rename itself keystroke by
 * keystroke under a reader who has not finished typing.
 *
 * **While Customize is on, the whole card is the handle and nothing in the body is live.** A press
 * anywhere picks the widget up, which is what a reader expects of a tile they are arranging — so the
 * body's content is `inert` (a press on a deck tile falls through to the card rather than opening
 * the deck, and nothing in it takes the caret) and the card is `select-none` (a drag across live
 * text would otherwise sweep a selection over it). Everything that is a control of its own — the
 * title field, the tray, the resize corner — carries `data-no-drag`, and the press handler reads
 * that mark rather than a list of elements. The grip is *not* marked: it is where the drag is
 * advertised, and a press on it is a press on the card.
 *
 * **The card does not clip.** Its two popovers are anchored inside the title line and open over
 * the card's body and past its edge; an `overflow-hidden` here would cut both off at the border.
 * Clipping is the body scroller's job and nobody else's. The frame is lifted by
 * `LAYER.raisedWhenPopupOpen` while either popover is open, so the panel paints over the card drawn
 * after this one rather than under it.
 *
 * **No `@container`, here or on the page.** Layout containment makes a box the containing block for
 * every `fixed` descendant, and a widget opens popovers and, through them, dialogs. What fits is
 * measured by the page and handed down as `fit`.
 *
 * **Every drag and resize is also a key press.** `dndManager` ships no `KeyboardSensor`, so a grid
 * that could only be arranged by pointer is half a grid for the readers without one: the grip's
 * arrow keys move the card a cell (`onNudge`), the resize corner's grow or shrink it (`onGrow`), and
 * the settings popover's steppers do the same for a reader who never finds the corner. Only the page
 * holds the grid, so each is a delta and the page decides what it lands on.
 */
import { useState, type KeyboardEvent, type PointerEvent, type ReactElement } from "react";
import { GripVertical, MoveDiagonal2, Settings2, Trash2, X } from "lucide-react";

import { AnchoredPopup } from "@/components/AnchoredPopup";
import { useTooltip } from "@/components/tooltip/useTooltip";
import { FOCUS } from "@/lib/focus";
import { LAYER } from "@/lib/layers";
import { PRESS } from "@/lib/motion";
import { cn } from "@/lib/utils";

import { bodyPadPx, titleRowPx } from "./fit";
import type { WidgetCardProps } from "./widgetProps";
import { WidgetSettingsPanel } from "./WidgetSettingsPanel";
import { chipLabel, customTitle, defaultTitle, widgetTitle } from "./widgetSettings";

export type { WidgetCardProps } from "./widgetProps";

/**
 * The four arrow keys as one-cell deltas — the grip's move and the corner's resize read the same
 * table, so the two cannot come to disagree about which way is up.
 */
const ARROWS: Readonly<Record<string, readonly [number, number]>> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

/** Answer an arrow key with its delta and consume it; leave every other key alone, so neither
 *  control is a keyboard trap. */
function onArrow(event: KeyboardEvent, act: ((dx: number, dy: number) => void) | undefined) {
  const delta = ARROWS[event.key];
  if (delta === undefined) return;
  event.preventDefault();
  act?.(delta[0], delta[1]);
}

/**
 * A control on the title line. 24px is `AnchoredPopup`'s trigger — two of the tray's controls are
 * one and cannot be restyled past it — so the grip is read off that box rather than chosen again.
 */
const TITLE_BUTTON = cn("grid size-6 shrink-0 place-items-center rounded-md", PRESS, FOCUS);

/** The glyph inside one of those controls. */
const TITLE_ICON = "size-3.5";

export function WidgetCard({
  widget,
  fit,
  editing,
  still = false,
  dragging = false,
  arrangeable = true,
  onDragStart,
  onResizeStart,
  onNudge,
  onGrow,
  canGrow,
  onConfig,
  onRemove,
  extraSettings,
  children,
}: WidgetCardProps): ReactElement {
  const tip = useTooltip();
  const title = widgetTitle(widget);
  /** A catalogue preview is a picture of a card, so it carries none of Customize's controls even
   *  on a page that is being customised. */
  const customizing = editing && !still;
  const movable = customizing && arrangeable;

  // The design's two rhythms: a one-cell-tall or compact card is packed tighter on every side. The
  // title line's height is `titleRowPx`, the same number `makeFit` subtracts, so the body a widget
  // was told it has is the body it gets.
  const tight = fit.compact || fit.h === 1;
  const pad = bodyPadPx(fit.h, fit.compact);
  const chip = fit.tier >= 2 ? chipLabel(widget) : "";

  const onPointerDown = (event: PointerEvent<HTMLElement>) => {
    if (!movable) return;
    // A secondary press is a context menu, never a pick-up.
    if (event.button > 0) return;
    if ((event.target as Element).closest("[data-no-drag]") !== null) return;
    onDragStart?.(event);
  };

  return (
    <section
      aria-label={title}
      onPointerDown={onPointerDown}
      className={cn(
        "relative flex h-full min-w-0 flex-col rounded-lg border border-border",
        LAYER.raisedWhenPopupOpen,
        customizing && "cursor-grab touch-none bg-surface/55 select-none",
        dragging && "cursor-grabbing border-accent opacity-[0.92] shadow-[0_16px_36px_rgb(0_0_0/0.5)]",
      )}
    >
      <div
        className="flex shrink-0 items-center gap-1"
        style={{ height: titleRowPx(fit.h), padding: tight ? "7px 8px 0" : "9px 10px 0" }}
      >
        {movable && (
          <button
            type="button"
            aria-label={`Move ${title}`}
            {...tip("Drag to move, or press the arrow keys")}
            onKeyDown={(event) => onArrow(event, onNudge)}
            className={cn(TITLE_BUTTON, "cursor-grab text-dim hover:text-text")}
          >
            <GripVertical className={TITLE_ICON} aria-hidden="true" />
          </button>
        )}

        {customizing ? (
          <TitleField widget={widget} onConfig={onConfig} />
        ) : (
          <h3
            {...tip(title, { whenClipped: true })}
            // One size for every card's name: a heading that shrank with the footprint made a wall
            // of widgets read as a wall of different things. The title is chrome, and chrome holds
            // still.
            className="m-0 min-w-0 flex-1 truncate text-[0.9375rem] leading-6 font-medium text-text"
          >
            {title}
          </h3>
        )}

        {chip !== "" && (
          <span className="shrink-0 text-[0.6875rem] tracking-[0.04em] whitespace-nowrap text-dim uppercase">
            {chip}
          </span>
        )}

        {customizing && (
          <div
            role="group"
            aria-label={`Customize ${title}`}
            data-no-drag=""
            // A control here is a press, not a handle, so it does not wear the card's grab cursor.
            className="flex shrink-0 cursor-auto items-center gap-1"
          >
            <AnchoredPopup
              label={`Settings for ${title}`}
              panelLabel={`${title} settings`}
              icon={<Settings2 className={TITLE_ICON} aria-hidden="true" />}
              // Pinned by the corner it grows from: the tray is at the right-hand end of the line.
              align="end"
              triggerClassName="aria-expanded:border-accent aria-expanded:text-accent"
              panelClassName="w-[268px] cursor-auto"
            >
              {(close) => (
                <div className="flex flex-col gap-3">
                  <div className="flex items-baseline justify-between gap-2">
                    <h4 className="m-0 min-w-0 truncate font-heading text-sm">{title} settings</h4>
                    <button
                      type="button"
                      aria-label="Close settings"
                      onClick={close}
                      className={cn("shrink-0 rounded-sm text-dim hover:text-text", FOCUS)}
                    >
                      <X className={TITLE_ICON} aria-hidden="true" />
                    </button>
                  </div>
                  <WidgetSettingsPanel
                    widget={widget}
                    onConfig={onConfig}
                    onGrow={onGrow}
                    canGrow={canGrow}
                    extraSettings={extraSettings}
                  />
                </div>
              )}
            </AnchoredPopup>

            <AnchoredPopup
              label={`Remove ${title}`}
              panelLabel={`Remove ${title}?`}
              icon={<Trash2 className={TITLE_ICON} aria-hidden="true" />}
              align="end"
              // The destructive colour arrives on hover, or while the question is open, rather than
              // at rest: a red glyph on every card of a customizable page reads as nine things
              // being wrong.
              triggerClassName={cn(
                "hover:border-destructive/60 hover:text-destructive",
                "aria-expanded:border-destructive/60 aria-expanded:text-destructive",
              )}
              panelClassName="w-[236px] cursor-auto"
            >
              {(close) => (
                <div className="flex flex-col gap-2.5">
                  <p className="m-0 text-sm leading-[1.35]">
                    Take <span className="font-medium">{title}</span> off the page?
                  </p>
                  <p className="m-0 text-xs leading-[1.35] text-dim">
                    Its settings go with it. You can add it again from the catalogue.
                  </p>
                  <div className="flex gap-1.5">
                    <button
                      type="button"
                      onClick={() => {
                        close();
                        onRemove();
                      }}
                      className={cn(
                        "flex-1 rounded-md border border-destructive/60 px-2 py-[5px] text-[0.8125rem] text-destructive",
                        "hover:bg-destructive/10",
                        PRESS,
                        FOCUS,
                      )}
                    >
                      Remove
                    </button>
                    <button
                      type="button"
                      onClick={close}
                      className={cn(
                        "flex-1 rounded-md border border-border px-2 py-[5px] text-[0.8125rem] text-dim hover:text-text",
                        PRESS,
                        FOCUS,
                      )}
                    >
                      Keep
                    </button>
                  </div>
                </div>
              )}
            </AnchoredPopup>
          </div>
        )}
      </div>

      {/*
        The one box that clips. `scrollbar-slim scrollbar-accent` are `src/index.css`'s slim bar and
        gold thumb. A catalogue preview clips rather than scrolls: behind `pointer-events: none` a
        scroller is a bar a reader can see and cannot move.
      */}
      <div
        className={cn(
          "scrollbar-slim scrollbar-accent flex min-h-0 flex-1 flex-col overflow-x-hidden",
          still ? "overflow-y-hidden" : "overflow-y-auto",
        )}
        style={{ padding: `0 ${pad}px ${pad}px` }}
      >
        {/*
          `inert` on the contents and not on the scroller: an inert element is skipped by hit
          testing, so a press lands on the scroller and bubbles to the card's drag handler, while
          the wheel still scrolls a body taller than its card. A still preview is inert too — nine
          previews in a catalogue must not be nine sets of tab stops.
        */}
        <div
          inert={customizing || still}
          className="flex flex-auto flex-col"
          style={{ gap: tight ? 5 : 8 }}
        >
          {children}
        </div>
      </div>

      {movable && (
        <button
          type="button"
          aria-label={`Resize ${title}`}
          data-no-drag=""
          {...tip("Drag to resize, or press the arrow keys")}
          onPointerDown={(event) => {
            if (event.button > 0) return;
            onResizeStart?.(event);
          }}
          onKeyDown={(event) => onArrow(event, onGrow)}
          className={cn(
            "absolute right-0 bottom-0 grid size-[22px] cursor-nwse-resize place-items-center rounded-tl-md rounded-br-lg text-accent",
            FOCUS,
          )}
        >
          <MoveDiagonal2 className="size-3" aria-hidden="true" />
        </button>
      )}
    </section>
  );
}

/**
 * The title line while Customize is on: the name, as a field.
 *
 * **A draft, committed on blur and on Enter** — never a write per keystroke, which would be a layout
 * write per letter and a card whose accessible name changed under the reader's fingers. The draft
 * is `null` while nothing has been typed, so the field shows the stored title and follows it.
 *
 * It opens on the name the card is *showing* — the reader's own, or the kind's — so a title is
 * edited rather than retyped. **A blank, or the kind's own name, stores nothing**, and the kind's
 * name comes back: a stored title that happens to equal the default is a rename that would stop
 * following the kind's label the day it changes.
 *
 * Escape reverts a draft, and only while there *is* one — `DeckNameField`'s rule: the press is
 * consumed so it closes nothing else, and with nothing to undo it falls through to whatever layer
 * is underneath.
 */
function TitleField({
  widget,
  onConfig,
}: Pick<WidgetCardProps, "widget" | "onConfig">): ReactElement {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = widgetTitle(widget);
  const fallback = defaultTitle(widget);

  const commit = () => {
    if (draft === null) return;
    const trimmed = draft.trim();
    setDraft(null);
    const next = trimmed === "" || trimmed === fallback ? undefined : trimmed;
    if (next === (customTitle(widget) ?? undefined)) return;
    onConfig({ title: next });
  };

  return (
    <input
      type="text"
      aria-label={`Name for ${fallback}`}
      placeholder={fallback}
      value={draft ?? shown}
      data-no-drag=""
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commit();
        } else if (event.key === "Escape" && draft !== null) {
          event.preventDefault();
          setDraft(null);
        }
      }}
      className={cn(
        "h-6 min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-1",
        "text-[0.9375rem] font-medium text-text select-text placeholder:text-dim",
        "cursor-text hover:border-border focus:border-accent",
        FOCUS,
      )}
    />
  );
}
