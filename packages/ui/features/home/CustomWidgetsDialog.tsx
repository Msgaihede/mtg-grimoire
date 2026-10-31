/**
 * **The Custom widgets dialog** — the reader's own widgets, each drawn live at its footprint with
 * one press that puts a copy on the page. The Widget catalogue's shape and its parts (the preview
 * box, its fit, the measured list), so the two dialogs read as one idea: a catalogue of the kinds
 * this build ships, and a catalogue of the ones the reader made.
 *
 * **A preview is the page's own body**, through the `renderBody` the page hands both dialogs, so a
 * custom widget's preview runs its query and draws its spec exactly as the placed copy will. Inert,
 * hidden from the accessibility tree and unpressable, the catalogue's three fences.
 *
 * **Delete asks once, in place** — the sticky note's confirmation, not a second dialog. The page
 * removes the definition's placed copies with it, so a delete never leaves a card saying its
 * widget is gone.
 */
import { useState, type ReactElement } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Dialog } from "@/components/Dialog";
import type { CustomWidget, HomeLayout, HomeWidget } from "@/lib/ipc";
import { FOCUS } from "@/lib/focus";
import { PRESS } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { customConfig } from "./generated/widgetState";
import { WidgetCard } from "./WidgetCard";
import { PREVIEW_HEIGHT, previewBoxWidth, previewFit, useListWidth } from "./WidgetCatalogue";
import type { WidgetBodyProps } from "./widgetProps";
import { CUSTOM_KIND } from "./widgets";

/** The catalogue's grid, again. */
const ENTRY_MIN_WIDTH = 320;

function ignore(): void {}

export interface CustomWidgetsDialogProps {
  open: boolean;
  widgets: readonly CustomWidget[];
  layout: HomeLayout;
  onAdd: (widget: CustomWidget) => void;
  onDelete: (widget: CustomWidget) => void;
  onDismiss: () => void;
  onClose: () => void;
  renderBody: (props: WidgetBodyProps) => ReactElement;
}

/** The placed copies of one definition. */
export function placedCopies(layout: HomeLayout, id: number): HomeWidget[] {
  return layout.widgets.filter(
    (widget) => widget.kind === CUSTOM_KIND && customConfig(widget.config).widgetId === id,
  );
}

function placedLabel(count: number): string {
  return count === 0 ? "Not on the page" : count === 1 ? "On the page" : `${count} on the page`;
}

const ACTION = cn("flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-sm", PRESS, FOCUS);

function Entry({
  widget,
  count,
  boxWidth,
  onAdd,
  onDelete,
  renderBody,
}: {
  widget: CustomWidget;
  count: number;
  boxWidth: number;
  onAdd: () => void;
  onDelete: () => void;
  renderBody: CustomWidgetsDialogProps["renderBody"];
}): ReactElement {
  const [confirming, setConfirming] = useState(false);
  const fit = previewFit({ def: [widget.w, widget.h] }, boxWidth);
  const preview: HomeWidget = {
    id: `preview-custom-${widget.id}`,
    kind: CUSTOM_KIND,
    x: 0,
    y: 0,
    w: fit.w,
    h: fit.h,
    config: { widgetId: widget.id, name: widget.name },
  };

  return (
    <li className="flex min-w-0 flex-col gap-2.5 rounded-lg border border-border bg-surface p-3">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="min-w-0 truncate text-base font-medium text-text">{widget.name}</h3>
        <span className={cn("shrink-0 text-xs", count === 0 ? "text-dim" : "text-accent")}>
          {placedLabel(count)}
        </span>
      </div>

      <div
        aria-hidden="true"
        inert
        className="pointer-events-none flex overflow-hidden"
        style={{ height: PREVIEW_HEIGHT }}
      >
        <div className="grid" style={{ width: fit.widthPx, height: fit.heightPx }}>
          <WidgetCard
            widget={preview}
            fit={fit}
            editing={false}
            still
            onConfig={ignore}
            onRemove={ignore}
          >
            {renderBody({ widget: preview, fit, editing: false, still: true, onConfig: ignore })}
          </WidgetCard>
        </div>
      </div>

      {widget.description !== "" && (
        <p className="text-[0.8125rem] leading-snug text-dim">{widget.description}</p>
      )}

      {confirming ? (
        <div role="group" aria-label={`Delete ${widget.name}?`} className="flex flex-col gap-2">
          <p className="m-0 text-[0.8125rem] text-text">
            {count === 0
              ? `Delete “${widget.name}”?`
              : `Delete “${widget.name}”? It is also removed from the page.`}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={onDelete}
              className={cn(
                ACTION,
                "border-destructive/60 text-destructive hover:bg-destructive/10",
              )}
            >
              Delete
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className={cn(ACTION, "border-border text-dim hover:text-text")}
            >
              Keep
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            aria-label={`Add ${widget.name}`}
            onClick={onAdd}
            className={cn(ACTION, "border-accent/45 bg-accent/8 text-accent hover:bg-accent/15")}
          >
            <Plus className="size-3.5" aria-hidden="true" />
            Add
          </button>
          <button
            type="button"
            aria-label={`Delete ${widget.name}`}
            onClick={() => setConfirming(true)}
            className={cn(
              ACTION,
              "border-border text-dim hover:border-destructive hover:text-destructive",
            )}
          >
            <Trash2 className="size-3.5" aria-hidden="true" />
            Delete
          </button>
        </div>
      )}
    </li>
  );
}

export function CustomWidgetsDialog({
  open,
  widgets,
  layout,
  onAdd,
  onDelete,
  onDismiss,
  onClose,
  renderBody,
}: CustomWidgetsDialogProps): ReactElement {
  return (
    <Dialog
      open={open}
      title="Custom widgets"
      subtitle="Your own widgets. New copies are placed in the first free spot on the grid."
      closeLabel="Close"
      size="w-[52rem]"
      onDismiss={onDismiss}
      onClose={onClose}
    >
      <Body
        widgets={widgets}
        layout={layout}
        onAdd={onAdd}
        onDelete={onDelete}
        renderBody={renderBody}
      />
    </Dialog>
  );
}

/** Its own component so the measurement mounts with the open dialog — the catalogue's reason. */
function Body({
  widgets,
  layout,
  onAdd,
  onDelete,
  renderBody,
}: Pick<
  CustomWidgetsDialogProps,
  "widgets" | "layout" | "onAdd" | "onDelete" | "renderBody"
>): ReactElement {
  const [listRef, listWidth] = useListWidth();
  const boxWidth = previewBoxWidth(listWidth);
  return (
    <div className="scrollbar-slim min-h-0 flex-1 overflow-y-auto p-5">
      {widgets.length === 0 ? (
        <p className="m-0 text-sm text-dim">You have no custom widgets.</p>
      ) : (
        <ul
          ref={listRef}
          className="grid gap-4"
          style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${ENTRY_MIN_WIDTH}px, 1fr))` }}
        >
          {widgets.map((widget) => (
            <Entry
              key={widget.id}
              widget={widget}
              count={placedCopies(layout, widget.id).length}
              boxWidth={boxWidth}
              onAdd={() => onAdd(widget)}
              onDelete={() => onDelete(widget)}
              renderBody={renderBody}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
