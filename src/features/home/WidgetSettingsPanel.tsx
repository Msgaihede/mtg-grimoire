/**
 * What a widget's settings popover holds — **the same rows for every kind, read off the registry**,
 * so a kind grows a setting by adding a row to `widgets.ts` and never by this panel learning a
 * special case.
 *
 * The order is the design's (`widget-home.dc.html`'s settings panel): the footprint, then one group
 * per pick, then the density, then the switches, then whatever the kind draws beyond its rows (the
 * deck picker behind `Pinned`, the Summary's figure checklist). The title is not here — it is
 * renamed on the card's own heading line, where the name is.
 *
 * **Every write is a patch, never a whole config** (`ConfigPatch`): the page merges the fields and
 * keeps every key it was not handed, a newer build's included. Two keys are written as *absence*
 * rather than as a word, and both are the registry's rule stated at its one writer: a switch at
 * **its own default** stores nothing, whichever way round that default runs — on for a toggle
 * that names no `dflt` (so a reader who changed nothing sees the widget's whole face), off for a
 * kind whose row names `dflt: false` — and the comfortable density stores nothing (only
 * `"compact"` is a density).
 *
 * A kind this build cannot draw gets the footprint and the density and nothing else — its picks
 * and switches are a newer build's vocabulary, and a row guessing at them would write words that
 * build may not mean.
 *
 * **`WidgetSettingsPanel`, never `WidgetSettings`, and the name is load-bearing on Windows.**
 * `widgetSettings.ts` sits in this folder, and a case-insensitive file system resolves
 * `./WidgetSettings` to whichever of the two the resolver probes first — `.ts` before `.tsx` — so
 * the import took the settings *readers* and rendered `undefined`. `folderTree.ts` beside
 * `FolderTree.tsx`, and a planned `quickAdd.ts` beside `QuickAdd.tsx`, are the same trap met before.
 */
import { useId, type ReactElement, type ReactNode } from "react";

import type { HomeWidget } from "@/lib/ipc";
import { FOCUS } from "@/lib/focus";
import { PRESS } from "@/lib/motion";
import { cn } from "@/lib/utils";

import type { ConfigPatch } from "./widgetProps";
import { pickValue, toggleOn, widgetDensity, widgetTitle, type Density } from "./widgetSettings";
import { boundsOf, isWidgetKind, widgetMeta } from "./widgets";

export interface WidgetSettingsPanelProps {
  widget: HomeWidget;
  onConfig: ConfigPatch;
  /** One cell more or less — the two steppers. */
  onGrow?: (dw: number, dh: number) => void;
  /**
   * Can the footprint change by this much? The page's answer knows the grid (free cells, the
   * column count); absent, the steppers fall back to the kind's own bounds, which is the half of
   * the question this panel can answer by itself.
   */
  canGrow?: (dw: number, dh: number) => boolean;
  /** The kind's own settings, already rendered, drawn last. */
  extraSettings?: ReactNode;
}

/**
 * A pressable choice in a row of them — a pick's option or a density.
 *
 * `aria-pressed` and the accent say which one is on, **never a glyph that comes and goes**, so the
 * chip's width holds still as the choice moves. Pressed is `border-accent text-accent` — the
 * accent means *on* everywhere else in this app — and the rest are `text-dim`, the app's one
 * spelling of dim text.
 */
const CHIP = cn("rounded-md border px-2 py-[3px] text-[0.8125rem] leading-snug", PRESS, FOCUS);
const CHIP_ON = "border-accent text-accent";
const CHIP_OFF = "border-border text-dim hover:text-text";

/**
 * A stepper's `−` / `+`: 18px, glyph only, the design's `STEP`.
 *
 * **At the bound it greys with opacity and keeps its tab stop** (`aria-disabled`, never the
 * attribute). Not a `text-border` class: that name is not a text utility in this system and paints
 * in the body colour — which made the control that cannot be pressed the brighter of the two.
 */
const STEP = cn(
  "grid size-[18px] place-items-center rounded-sm text-sm leading-none text-dim hover:text-text",
  "aria-disabled:opacity-35 aria-disabled:hover:text-dim",
  FOCUS,
);

export function WidgetSettingsPanel({
  widget,
  onConfig,
  onGrow,
  canGrow,
  extraSettings,
}: WidgetSettingsPanelProps): ReactElement {
  const title = widgetTitle(widget);
  const meta = isWidgetKind(widget.kind) ? widgetMeta(widget.kind) : null;
  const density = widgetDensity(widget);

  // The kind's bounds are the floor of the question even when the page answers it: a page that
  // forgot a bound must not let a stepper take a Summary past its eight columns.
  const bounds = boundsOf(widget.kind);
  const withinBounds = (dw: number, dh: number) => {
    const w = widget.w + dw;
    const h = widget.h + dh;
    return w >= bounds.min[0] && w <= bounds.max[0] && h >= bounds.min[1] && h <= bounds.max[1];
  };
  const can = (dw: number, dh: number) => withinBounds(dw, dh) && (canGrow?.(dw, dh) ?? true);

  return (
    <div className="flex flex-col gap-3">
      <Group label="Size">
        <div className="flex gap-1.5">
          <Stepper
            axis="Wide"
            value={widget.w}
            lessLabel={`Narrower, ${title}`}
            moreLabel={`Wider, ${title}`}
            canLess={can(-1, 0)}
            canMore={can(1, 0)}
            onLess={() => onGrow?.(-1, 0)}
            onMore={() => onGrow?.(1, 0)}
          />
          <Stepper
            axis="Tall"
            value={widget.h}
            lessLabel={`Shorter, ${title}`}
            moreLabel={`Taller, ${title}`}
            canLess={can(0, -1)}
            canMore={can(0, 1)}
            onLess={() => onGrow?.(0, -1)}
            onMore={() => onGrow?.(0, 1)}
          />
        </div>
      </Group>

      {meta?.picks.map((pick) => {
        const current = pickValue(widget, pick);
        return (
          <Group key={pick.key} label={pick.label}>
            <div className="flex flex-wrap gap-1">
              {pick.options.map((option) => {
                const on = option.id === current;
                return (
                  <button
                    key={String(option.id)}
                    type="button"
                    aria-pressed={on}
                    onClick={() => onConfig({ [pick.key]: option.id })}
                    className={cn(CHIP, on ? CHIP_ON : CHIP_OFF)}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
          </Group>
        );
      })}

      <Group label="Density">
        <div className="flex gap-1">
          {DENSITIES.map(({ id, label }) => {
            const on = density === id;
            return (
              <button
                key={id}
                type="button"
                aria-pressed={on}
                // Comfortable is the absence of a density, so choosing it removes the key rather than
                // writing a second spelling of the default.
                onClick={() => onConfig({ density: id === "compact" ? "compact" : undefined })}
                className={cn(CHIP, on ? CHIP_ON : CHIP_OFF)}
              >
                {label}
              </button>
            );
          })}
        </div>
      </Group>

      {meta !== null && meta.toggles.length > 0 && (
        <Group label="Show">
          {meta.toggles.map((toggle) => {
            const dflt = toggle.dflt ?? true;
            const on = toggleOn(widget, toggle.key, dflt);
            return (
              <label key={toggle.key} className="flex items-center justify-between gap-2 py-px">
                <span className={cn("text-[0.8125rem]", on ? "text-text" : "text-dim")}>
                  {toggle.label}
                </span>
                <input
                  type="checkbox"
                  checked={on}
                  // **The default is stored as absence, whichever way round it runs** — see the
                  // module doc.
                  onChange={() => onConfig({ [toggle.key]: !on === dflt ? undefined : !on })}
                  className={cn("size-3.5 accent-accent", FOCUS)}
                />
              </label>
            );
          })}
        </Group>
      )}

      {extraSettings}
    </div>
  );
}

const DENSITIES: readonly { id: Density; label: string }[] = [
  { id: "comfortable", label: "Comfortable" },
  { id: "compact", label: "Compact" },
];

/** A labelled run of controls. A `group` named by its visible caption, so a screen reader hears
 *  *Density* before *Compact, toggle button, pressed*. */
function Group({ label, children }: { label: string; children: ReactNode }): ReactElement {
  const id = useId();
  return (
    <div role="group" aria-labelledby={id} className="flex flex-col gap-1">
      <span id={id} className="text-xs text-dim">
        {label}
      </span>
      {children}
    </div>
  );
}

/** One axis of the footprint: its name, `−`, the count, `+`. */
function Stepper({
  axis,
  value,
  lessLabel,
  moreLabel,
  canLess,
  canMore,
  onLess,
  onMore,
}: {
  axis: string;
  value: number;
  lessLabel: string;
  moreLabel: string;
  canLess: boolean;
  canMore: boolean;
  onLess: () => void;
  onMore: () => void;
}): ReactElement {
  return (
    <div className="flex flex-1 items-center justify-between gap-1 rounded-md border border-border px-1 py-0.5">
      <span className="text-[0.6875rem] tracking-[0.04em] text-dim uppercase">{axis}</span>
      <span className="flex items-center gap-0.5">
        <button
          type="button"
          aria-label={lessLabel}
          aria-disabled={canLess ? undefined : true}
          onClick={() => {
            if (canLess) onLess();
          }}
          className={STEP}
        >
          −
        </button>
        <span className="min-w-3 text-center font-mono text-[0.8125rem] text-text tabular-nums">
          {value}
        </span>
        <button
          type="button"
          aria-label={moreLabel}
          aria-disabled={canMore ? undefined : true}
          onClick={() => {
            if (canMore) onMore();
          }}
          className={STEP}
        >
          +
        </button>
      </span>
    </div>
  );
}
