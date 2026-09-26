/**
 * The Widget catalogue: every kind this build can draw, each shown as **the real widget** at the
 * footprint it arrives at, with one press that puts it on the page.
 *
 * **A preview is the same `WidgetCard` and the same body the page draws, never a picture of one.**
 * A skeleton drawn beside the real thing would be a second idea of what a widget looks like, and the
 * two would drift the first time either moved — this app's resemblance rule, one feature over. So an
 * entry renders the card with `still` (no tray, a body that clips rather than scrolls) over the
 * kind's own body with `still` (reads, but writes nothing, opens nothing and publishes nothing), at
 * the kind's `def` footprint, inside a box that is `aria-hidden`, `inert` and `pointer-events-none`:
 * a picture to the eye, absent to the keyboard and to a screen reader, and unpressable by a pointer.
 *
 * **The body is handed in rather than imported** ({@link WidgetCatalogueProps.renderBody}). The page
 * is where a stored `kind` becomes a component — with its `default` arm for a kind from a newer
 * build — and the catalogue importing that switch back out of `HomePage.tsx` would be an import
 * cycle with the file that mounts it. Handed in, there is one switch and the catalogue cannot draw a
 * kind differently from the page.
 *
 * **Where a widget lands is the page's arithmetic, not this file's.** An Add press names a kind and
 * nothing else; the page places it with `addWidget` against the grid it is drawing, which is the one
 * place that knows the column count.
 */
import { useCallback, useState, type ReactElement } from "react";
import { Plus } from "lucide-react";
import { Dialog } from "@/components/Dialog";
import type { HomeLayout, HomeWidget } from "@/lib/ipc";
import { FOCUS } from "@/lib/focus";
import { PRESS } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { makeFit, type WidgetFit } from "./fit";
import { WidgetCard } from "./WidgetCard";
import type { WidgetBodyProps } from "./widgetProps";
import { WIDGETS, type WidgetKind, type WidgetMeta } from "./widgets";

/** The preview box's height, in pixels — the design's 212. */
export const PREVIEW_HEIGHT = 212;

/**
 * The preview box's width before the list has been measured — jsdom, and the one commit before the
 * observer answers.
 *
 * Read off the design's own geometry rather than chosen: the panel is `w-[52rem]` (832), the body's
 * `p-5` leaves 792, two `minmax(320px, 1fr)` tracks with `gap-4` between are 388 each, and an
 * entry's `p-3` and its 1px border leave 362. A wrong guess here costs one frame of a preview drawn
 * a little too wide or narrow, never a wrong widget.
 */
const NOMINAL_BOX_WIDTH = 362;

/** The entries' grid: tracks no narrower than this, as many as fit. */
const ENTRY_MIN_WIDTH = 320;
/** `gap-4` between entries, spelled for the arithmetic that has to subtract it. */
const ENTRY_GAP = 16;
/** An entry's `p-3` and its `border`, both sides, between its outer width and its preview box. */
const ENTRY_INSET = 2 * 12 + 2;

/** Nothing: a still widget writes nothing, so its config patch and its remove go nowhere. */
function ignore(): void {}

export interface WidgetCatalogueProps {
  open: boolean;
  /** The page's document, for each entry's *on the page* count. */
  layout: HomeLayout;
  /** Put one widget of this kind on the page. The page places it and closes the catalogue. */
  onAdd: (kind: WidgetKind) => void;
  /** Escape and the ✕ — `Dialog`'s contract: hand focus back to the opener, then close. */
  onDismiss: () => void;
  /** A press on the scrim: close without moving focus. */
  onClose: () => void;
  /** The page's own `kind` → body switch. See the module doc. */
  renderBody: (props: WidgetBodyProps) => ReactElement;
}

/**
 * How wide one preview box is in a list this wide: `repeat(auto-fill, minmax(320px, 1fr))` worked
 * out by hand, less the entry's own padding and border. `0` is unmeasured and answers the nominal.
 */
export function previewBoxWidth(listWidth: number): number {
  if (listWidth <= 0) return NOMINAL_BOX_WIDTH;
  const tracks = Math.max(1, Math.floor((listWidth + ENTRY_GAP) / (ENTRY_MIN_WIDTH + ENTRY_GAP)));
  const entry = (listWidth - ENTRY_GAP * (tracks - 1)) / tracks;
  return Math.max(0, entry - ENTRY_INSET);
}

/**
 * A kind's preview fit: its `def` footprint for **which** content it carries (the tier), and the
 * whole preview box for **how much** of it fits.
 *
 * **The card fills the box, as the design's catalogue does, rather than keeping its footprint's
 * proportions.** Proportions were tried first and measured in the shipped window (2026-09-15,
 * 1920×1080): a 2×3 kind held to square cells inside a 212px-tall box came out 137px wide, so a
 * value chart's labels truncated to `R…` and `Oth…` — a preview reading as a broken card, which is
 * the one thing a catalogue must not show. The tier still comes from the footprint, so a two-cell
 * kind previews with a tile's content rather than a band's.
 */
export function previewFit(meta: Pick<WidgetMeta, "def">, boxWidth: number): WidgetFit {
  const [w, h] = meta.def;
  return makeFit({
    w,
    h,
    widthPx: Math.max(0, boxWidth),
    heightPx: PREVIEW_HEIGHT,
    density: "comfortable",
  });
}

/** What an entry's status line says, and whether it is in the accent. */
function placedLabel(count: number): string {
  return count === 0 ? "Not on the page" : count === 1 ? "On the page" : `${count} on the page`;
}

/**
 * The catalogue's list width, measured.
 *
 * **A callback ref rather than an effect**, `HomePage`'s canvas measurement and its reason: the list
 * mounts with the dialog's panel rather than with this component, and a ref callback is called with
 * the element the moment it exists — so there is no `RefObject` that notifies nobody, and the state
 * write lands in the commit rather than one paint later. React 19 runs the returned function as the
 * ref's cleanup, which is where the observer is given back.
 */
function useListWidth(): [(el: HTMLElement | null) => (() => void) | undefined, number] {
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

/** One kind's entry: its name, whether it is already on the page, the preview, the sentence, Add. */
function CatalogueEntry({
  meta,
  count,
  boxWidth,
  onAdd,
  renderBody,
}: {
  meta: WidgetMeta;
  count: number;
  boxWidth: number;
  onAdd: (kind: WidgetKind) => void;
  renderBody: WidgetCatalogueProps["renderBody"];
}): ReactElement {
  const fit = previewFit(meta, boxWidth);
  // A widget that is on no page: never configured, so it shows the face a reader who adds it gets.
  const preview: HomeWidget = {
    id: `preview-${meta.kind}`,
    kind: meta.kind,
    x: 0,
    y: 0,
    w: fit.w,
    h: fit.h,
    config: null,
  };

  return (
    <li className="flex min-w-0 flex-col gap-2.5 rounded-lg border border-border bg-surface p-3">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="min-w-0 text-base font-medium text-text">{meta.label}</h3>
        <span className={cn("shrink-0 text-xs", count === 0 ? "text-dim" : "text-accent")}>
          {placedLabel(count)}
        </span>
      </div>

      {/*
        The preview. **Three fences, and each covers something the other two do not**: `inert`
        takes it out of the tab order and out of the accessibility tree, `aria-hidden` says the same
        to the tree for anything reading the attribute rather than the property, and
        `pointer-events-none` keeps a hover off the card's rows. The overflow clip is the box's —
        the card inside is sized to fit, and a body that over-reaches is cut at the preview's edge
        rather than pushing the entry taller.
      */}
      <div
        aria-hidden="true"
        inert
        className="pointer-events-none flex overflow-hidden"
        style={{ height: PREVIEW_HEIGHT }}
      >
        {/* `grid`, not `flex`: a grid item stretches on both axes, where a flex row sizes the card to
            its content and a preview came out 166px wide in a 356px box. */}
        <div className="grid" style={{ width: fit.widthPx, height: fit.heightPx }}>
          <WidgetCard widget={preview} fit={fit} editing={false} still onConfig={ignore} onRemove={ignore}>
            {renderBody({ widget: preview, fit, editing: false, still: true, onConfig: ignore })}
          </WidgetCard>
        </div>
      </div>

      <p className="text-[0.8125rem] leading-snug text-dim">{meta.description}</p>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          // The visible word is "Add" on every entry; the name carries the kind so each is one
          // addressable control rather than a row of buttons all called Add.
          aria-label={`Add ${meta.label}`}
          onClick={() => onAdd(meta.kind)}
          className={cn(
            "flex items-center gap-1.5 rounded-md border border-accent/45 bg-accent/8 px-2.5 py-1",
            "text-sm text-accent hover:bg-accent/15",
            PRESS,
            FOCUS,
          )}
        >
          <Plus className="size-3.5" aria-hidden="true" />
          Add
        </button>
      </div>
    </li>
  );
}

/**
 * The catalogue dialog. **Built on `components/Dialog`** — the scrim, `aria-modal`, `trapTab` and
 * the `"inner"` Escape rung are that shell's, and a modal drawn beside it would be the fourth copy
 * of chrome this app has already folded back in once.
 *
 * Entries are in `WIDGETS` order, the registry's own: the catalogue is a *display* of the kinds,
 * arranged the way the design lays them out, rather than an option list a reader scans for a name.
 */
export function WidgetCatalogue({
  open,
  layout,
  onAdd,
  onDismiss,
  onClose,
  renderBody,
}: WidgetCatalogueProps): ReactElement {
  return (
    <Dialog
      open={open}
      title="Widget catalogue"
      subtitle="A widget arrives at its own size, in the first free place on the grid."
      closeLabel="Close the widget catalogue"
      size="w-[52rem]"
      onDismiss={onDismiss}
      onClose={onClose}
    >
      <CatalogueBody layout={layout} onAdd={onAdd} renderBody={renderBody} />
    </Dialog>
  );
}

/**
 * The scroller and the list — its own component so the measurement mounts with the open dialog,
 * which is what `Dialog`'s *closed is nothing mounted* promises every body.
 */
function CatalogueBody({
  layout,
  onAdd,
  renderBody,
}: Pick<WidgetCatalogueProps, "layout" | "onAdd" | "renderBody">): ReactElement {
  const [listRef, listWidth] = useListWidth();
  const boxWidth = previewBoxWidth(listWidth);

  return (
    <div className="scrollbar-slim min-h-0 flex-1 overflow-y-auto p-5">
      <ul
        ref={listRef}
        className="grid gap-4"
        // A template is an inline style, never an arbitrary class — see `src/CLAUDE.md`.
        style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${ENTRY_MIN_WIDTH}px, 1fr))` }}
      >
        {WIDGETS.map((meta) => (
          <CatalogueEntry
            key={meta.kind}
            meta={meta}
            count={layout.widgets.filter((widget) => widget.kind === meta.kind).length}
            boxWidth={boxWidth}
            onAdd={onAdd}
            renderBody={renderBody}
          />
        ))}
      </ul>
    </div>
  );
}
