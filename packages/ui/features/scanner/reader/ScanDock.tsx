import { useId, type ReactNode } from "react";
import {
  Check,
  ChevronDown,
  Crosshair,
  Funnel,
  Layers,
  Play,
  Square,
  Video,
  X,
} from "lucide-react";
import { AnchoredPopup } from "@/components/AnchoredPopup";
import { FILTER_CONTROL, filterChipState } from "@/components/FilterChips";
import { useTooltip } from "@/components/tooltip/useTooltip";
import { SetCombobox } from "@/features/search/SetCombobox";
import { FINISHES } from "@/lib/finish";
import { FOCUS, FOCUS_INSET } from "@/lib/focus";
import type { ScanFilters, ScannerFinishPref } from "@/lib/ipc";
import { PRESS, PRESS_STILL } from "@/lib/motion";
import { sortOptions } from "@/lib/options";
import { radioKeys, type RadioKeyProps } from "@/lib/radioGroup";
import { cn } from "@/lib/utils";
import type { CameraDevice } from "../useCamera";
import {
  CAMERA_CHOICE_NOTE,
  CANCEL_SCAN,
  CONTINUOUS,
  CONTINUOUS_HINT,
  filtering,
  filterSummary,
  NO_FILTERS,
  POINT_AND_SHOOT,
  POINT_AND_SHOOT_CLICK_HINT,
  SCAN_CARD,
  SKIP_PROMOS,
  SKIP_PROMOS_NOTE,
  START,
  STOP,
} from "./readerText";
import { DETECT, FINISH_PREF_LABEL } from "./trayFinish";

export interface ScanDockProps {
  scanning: boolean;
  onScanning: (scanning: boolean) => void;
  /**
   * **Point and shoot** (`usePointAndShoot`): on, the dock's primary is *Scan card* where Start
   * and Stop were — a click reads one card, and a second click while it is looking cancels it.
   */
  pointAndShoot: boolean;
  /** The other half of *How scanning runs* pressed. Never called for the half already pressed. */
  onPointAndShoot: (on: boolean) => void;
  /** A shot is running — *Scan card* reads *Cancel scan* for its length. */
  shooting: boolean;
  /** `true` is a click on *Scan card*, `false` the same press while a shot is running. */
  onShoot: (on: boolean) => void;
  filters: ScanFilters;
  onFilters: (f: ScanFilters) => void;
  /** The last `set_filters` refusal, drawn inside the popover. */
  filterError: string | null;
  /** A reason, or null when filters can be used. */
  filtersDisabled: string | null;
  /** The finish a new card lands in — `Detect`, or one finish for every card. */
  finish: ScannerFinishPref;
  onFinish: (f: ScannerFinishPref) => void;
  /** Every camera the machine has — `useCameraDevices`' list, in whatever order it came. */
  cameras: readonly CameraDevice[];
  /**
   * The camera that is **open**, never the one the reader stored: when a stored camera has been
   * unplugged the default opens in its place, and the picker says so rather than ticking a camera
   * that is not the one on screen. `null` while nothing is live.
   */
  cameraId: string | null;
  onCamera: (deviceId: string) => void;
}

/**
 * **Deliberately not through `sortOptions` — the order is the information.** `Detect` first,
 * because it is the default and the one choice that is not a finish; then a printing's finishes,
 * plain before the premium treatments as everywhere in this app, which is the order `FINISHES` is
 * written in.
 */
const FINISH_CHOICES: readonly ScannerFinishPref[] = [DETECT, ...FINISHES];

/** The Finish menu's caption, and the name of the list it heads. */
const NEW_CARDS_LAND_AS = "New cards land as";

/**
 * The reader's controls under the camera picture, in two rows: the press that runs the scanner,
 * how it runs and what it is narrowed to; then what a new card lands as and which camera reads.
 *
 * **Everything here is controlled.** The page owns the prefs and pushes the filters to the session,
 * and a refusal comes back through `filterError`; this dock holds nothing but which popover is
 * open. That is what lets a story draw every state of it from arguments alone.
 *
 * **Its rows wrap rather than scroll.** The dock is the camera column's width, which shrinks to
 * 22rem beside a wide tray: there the Filters trigger drops to a line of its own, still at the far
 * end, rather than putting a horizontal scrollbar under the picture.
 *
 * **Every panel opens upwards**, over the picture: the dock is the foot of the view, and a panel
 * hung under it would open past the bottom of the window.
 *
 * What the old scan bar also carried has gone to where it is read: the condition to the tray's
 * footer (it is read at Add), and *History* and the Developer switch to the page's header.
 */
export function ScanDock({
  scanning,
  onScanning,
  pointAndShoot,
  onPointAndShoot,
  shooting,
  onShoot,
  filters,
  onFilters,
  filterError,
  filtersDisabled,
  finish,
  onFinish,
  cameras,
  cameraId,
  onCamera,
}: ScanDockProps) {
  // `Default` for a live camera the list has not caught up with yet, and for no camera at all —
  // the trigger still has to read as something, and what opens with nothing chosen is the default.
  const cameraName = cameras.find((c) => c.deviceId === cameraId)?.label ?? "Default";

  return (
    <div className="flex shrink-0 flex-col gap-2.5 rounded-lg border border-border bg-surface px-3.5 py-3">
      <div className="flex flex-wrap items-center gap-2.5">
        {pointAndShoot ? (
          <PrimaryPress
            label={shooting ? CANCEL_SCAN : SCAN_CARD}
            glyph={
              shooting ? (
                <X className="size-4" aria-hidden="true" />
              ) : (
                <Crosshair className="size-4" aria-hidden="true" />
              )
            }
            outline={shooting}
            onClick={() => onShoot(!shooting)}
          />
        ) : (
          <PrimaryPress
            label={scanning ? STOP : START}
            glyph={
              scanning ? (
                <Square className="size-3.5 fill-current" aria-hidden="true" />
              ) : (
                <Play className="size-3.5 fill-current" aria-hidden="true" />
              )
            }
            outline={false}
            onClick={() => onScanning(!scanning)}
          />
        )}
        <HowScanningRuns pointAndShoot={pointAndShoot} onPointAndShoot={onPointAndShoot} />

        <DockPopover
          caption="Filters"
          value={filterSummary(filters)}
          icon={<Funnel className="size-3.5 shrink-0" aria-hidden="true" />}
          active={filtering(filters)}
          refusal={filtersDisabled}
          panelLabel="Filters"
          // The row's far end, so the panel opens back across the dock rather than off it.
          align="end"
          tall
          className="ml-auto"
          panelClassName="w-72"
        >
          <FiltersBody filters={filters} onFilters={onFilters} filterError={filterError} />
        </DockPopover>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <DockPopover
          caption="Finish"
          value={FINISH_PREF_LABEL[finish]}
          icon={<Layers className="size-3.5 shrink-0" aria-hidden="true" />}
          active={false}
          refusal={null}
          panelLabel="Finish"
          // `p-1.5` over the shell's `p-3`: the rows carry their own inset for their hover wash, as
          // `FolderPicker`'s list does in the tray's footer.
          panelClassName="w-64 p-1.5"
        >
          {(close) => (
            <FinishBody
              finish={finish}
              onFinish={onFinish}
              onPress={(f) => {
                onFinish(f);
                close();
              }}
            />
          )}
        </DockPopover>

        <DockPopover
          caption="Camera"
          value={cameraName}
          icon={<Video className="size-3.5 shrink-0" aria-hidden="true" />}
          active={false}
          refusal={cameras.length === 0 ? "No camera found" : null}
          panelLabel="Camera"
          panelClassName="w-75 p-1.5"
        >
          {(close) => (
            <CameraBody
              cameras={cameras}
              cameraId={cameraId}
              onCamera={onCamera}
              onPress={(id) => {
                onCamera(id);
                close();
              }}
            />
          )}
        </DockPopover>
      </div>
    </div>
  );
}

/**
 * The dock's gold primary: *Start* / *Stop*, or under point and shoot *Scan card* / *Cancel scan*.
 * Filled, because it is the one press the reader makes once a card and reaches for without
 * looking. **A running shot is drawn as an outline**, so *Cancel scan* never reads as the call to
 * act — a click that found nothing is still never left running behind the reader's back.
 *
 * Point and shoot is **a click, not a hold**, on this face (the owner's decision, 2026-10-22): a
 * mouse held down is a hand that cannot also hold the card, and a click is one press per card
 * either way.
 */
function PrimaryPress({
  label,
  glyph,
  outline,
  onClick,
}: {
  label: string;
  glyph: ReactNode;
  outline: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex h-11 min-w-32 shrink-0 items-center justify-center gap-2 rounded-md border border-accent pr-4.5 pl-3.5 text-[15px] font-semibold whitespace-nowrap",
        outline ? "text-accent" : "bg-accent text-accent-fg",
        PRESS,
        FOCUS,
      )}
    >
      {glyph}
      {label}
    </button>
  );
}

/**
 * *How scanning runs*: **Continuous** (Start once, and every card is read until Stop) or **Point
 * & shoot** (one card per press of *Scan card*) — the stored `pointAndShoot` pref, beside the press
 * it changes. Two `aria-pressed` buttons in a named group, the pressed one filled gold; what each
 * does is its tooltip.
 *
 * Either way the change lands stopped, which is the page's to do; a press on the half already
 * pressed changes nothing, so it calls nothing — it must not stop a scan that is running.
 */
function HowScanningRuns({
  pointAndShoot,
  onPointAndShoot,
}: {
  pointAndShoot: boolean;
  onPointAndShoot: (on: boolean) => void;
}) {
  const tip = useTooltip();
  const halves = [
    { on: false, label: CONTINUOUS, hint: CONTINUOUS_HINT },
    { on: true, label: POINT_AND_SHOOT, hint: POINT_AND_SHOOT_CLICK_HINT },
  ];
  return (
    <div
      role="group"
      aria-label="How scanning runs"
      className="flex shrink-0 gap-0.5 rounded-md border border-border p-0.5"
    >
      {halves.map(({ on, label, hint }) => {
        const pressed = pointAndShoot === on;
        return (
          <button
            key={label}
            type="button"
            aria-pressed={pressed}
            onClick={() => {
              if (!pressed) onPointAndShoot(on);
            }}
            {...tip(hint)}
            className={cn(
              "h-9.5 rounded-sm px-4 text-sm whitespace-nowrap coarse:min-h-[var(--target-min)]",
              "transition-colors duration-[var(--duration-fast)] motion-reduce:transition-none",
              pressed ? "bg-accent font-medium text-accent-fg" : "text-dim hover:text-text",
              FOCUS,
            )}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * A worded trigger in the dock and the panel it opens over itself — `AnchoredPopup`, with the
 * filter row's box, a glyph, and a caption beside the value.
 *
 * **The shell is `AnchoredPopup`'s and nothing about it is re-decided here**: anchored rather than
 * portalled for the shipped CSP, Escape through the one ladder with the caret handed back, focus
 * leaving the root closing it, the scroll into view once the entry tween settles, the drag mark,
 * and the refusal that stays in the tab order with its reason as the tooltip. What this adds is the
 * row's own box, the words it prints, and **the panel hung above the trigger**, grown from the
 * corner it is pinned by.
 *
 * **The name is spelled, not computed.** The caption and the value are two elements in a row with
 * a gap between them, which the name algorithm would fuse into one word; the label holds both in
 * the order they are drawn — `Filters: Any set`, `Finish: Detect`, `Camera: Logitech BRIO`.
 *
 * **Camera is the one to watch**, second on its row and 300px wide: at the camera column's 22rem
 * floor its panel reaches past the dock's right edge and over the tray, which only a live pass at
 * the narrow rung can see.
 */
function DockPopover({
  caption,
  value,
  icon,
  active,
  refusal,
  panelLabel,
  panelClassName,
  align = "start",
  tall = false,
  className,
  children,
}: {
  caption: string;
  value: string;
  /** The trigger's glyph, before the caption — already sized and `aria-hidden`. */
  icon: ReactNode;
  /** Gold when on — a filter narrowing the scan is a state a reader should see at a glance. */
  active: boolean;
  /** Why the popover cannot open, or `null` when it can. */
  refusal: string | null;
  panelLabel: string;
  panelClassName: string;
  /** Which edge of the panel is pinned to the trigger's — `end` for a trigger at a row's end. */
  align?: "start" | "end";
  /** The first row's 44px, beside the primary, rather than the filter row's 36. */
  tall?: boolean;
  /** On the root — where it sits in its row. */
  className?: string;
  /** Or a function of `close`, handed straight to `AnchoredPopup` — for a panel whose press is
   *  the whole of what it is for, and shuts it (the Finish and Camera lists). */
  children: ReactNode | ((close: () => void) => ReactNode);
}) {
  return (
    <AnchoredPopup
      label={`${caption}: ${value}`}
      panelLabel={panelLabel}
      refusal={refusal}
      align={align}
      // `min-w-0` so a long summary truncates inside the trigger instead of holding the whole
      // wrapped line at its full width: a flex item's floor is its content otherwise.
      className={cn("min-w-0 max-w-full", className)}
      triggerClassName={cn(
        FILTER_CONTROL,
        "inline-flex max-w-full items-center gap-1.5 px-2.5",
        tall && "h-11 px-3",
        filterChipState(active, refusal !== null),
      )}
      triggerContent={
        <>
          {icon}
          <span className="shrink-0 text-dim">{caption}</span>
          <span className="min-w-0 truncate">{value}</span>
          <ChevronDown className="size-3.5 shrink-0" aria-hidden="true" />
        </>
      }
      // Over the trigger rather than under it: the dock is the foot of the view. Both origins
      // written out whole — Tailwind scans source text, so an interpolated class emits nothing.
      panelClassName={cn(
        "bottom-full top-auto mb-1",
        align === "start" ? "origin-bottom-left" : "origin-bottom-right",
        panelClassName,
      )}
    >
      {children}
    </AnchoredPopup>
  );
}

/** The date fields' box — the filter row's geometry without the press dip, because a reader types
 *  into these and a field that shrinks under the pointer moves its own contents away from it. */
const DATE_FIELD = cn(
  "h-9 w-full min-w-0 rounded-md border border-border bg-bg px-2 text-sm text-text",
  "focus:border-accent focus:outline-none",
  PRESS_STILL,
);

/**
 * What the scan is narrowed to: sets, a release window, and the way back to everything.
 *
 * **Every change is sent as it is made** — a set ticked, a date settled — rather than held for an
 * Apply. The camera is running while this is open, so the next frame the reader holds up should
 * already be read against what the popover says; a draft here would be a popover and a scanner
 * disagreeing for as long as it was open.
 *
 * **No language, deliberately and in this pass's own words** (spec §3, decision 7): a language
 * filter would bite on almost nothing and read as though it bit on everything.
 */
function FiltersBody({
  filters,
  onFilters,
  filterError,
}: {
  filters: ScanFilters;
  onFilters: (f: ScanFilters) => void;
  filterError: string | null;
}) {
  const id = useId();
  const toggle = (code: string) =>
    onFilters({
      ...filters,
      sets: filters.sets.includes(code)
        ? filters.sets.filter((s) => s !== code)
        : [...filters.sets, code],
    });
  // A cleared date field reports `""`; the session's word for "no bound" is `null`.
  const dateOf = (raw: string): string | null => (raw === "" ? null : raw);
  const skipPromos = filters.exclude_promos === true;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        {/* A caption for the eye only: the picker names itself `Set`, and a second name here
            would be announced before the one the control already carries. */}
        <span aria-hidden="true" className="text-xs text-dim">
          Sets
        </span>
        <SetCombobox selected={filters.sets} onToggle={toggle} align="start" fill />
      </div>

      {/* Beside the set picker, as issue #981 asks: a promo is most often the printing a set's
          own card is mistaken for. A switch named by its own word, as the header's Developer is. */}
      <div className="flex flex-col gap-1">
        <button
          type="button"
          role="switch"
          aria-checked={skipPromos}
          aria-describedby={`${id}-promos`}
          onClick={() => onFilters({ ...filters, exclude_promos: !skipPromos })}
          className={cn(
            FILTER_CONTROL,
            "inline-flex items-center gap-1.5 self-start px-2.5",
            FOCUS,
            filterChipState(skipPromos),
          )}
        >
          {skipPromos && <Check className="size-3.5 shrink-0" aria-hidden="true" />}
          {SKIP_PROMOS}
        </button>
        <p id={`${id}-promos`} className="text-xs leading-snug text-dim">
          {SKIP_PROMOS_NOTE}
        </p>
      </div>

      {/* No flex on the fieldset: a rendered legend is not a flex item, so a gap there would
          space the two fields and never the caption. */}
      <fieldset>
        <legend className="mb-1.5 text-xs text-dim">Released</legend>
        <div className="grid grid-cols-2 gap-2">
          <label htmlFor={`${id}-from`} className="flex min-w-0 flex-col gap-1 text-xs text-dim">
            From
            <input
              id={`${id}-from`}
              type="date"
              aria-label="Released from"
              value={filters.released_from ?? ""}
              max={filters.released_to ?? undefined}
              onChange={(e) => onFilters({ ...filters, released_from: dateOf(e.target.value) })}
              className={DATE_FIELD}
            />
          </label>
          <label htmlFor={`${id}-to`} className="flex min-w-0 flex-col gap-1 text-xs text-dim">
            To
            <input
              id={`${id}-to`}
              type="date"
              aria-label="Released to"
              value={filters.released_to ?? ""}
              min={filters.released_from ?? undefined}
              onChange={(e) => onFilters({ ...filters, released_to: dateOf(e.target.value) })}
              className={DATE_FIELD}
            />
          </label>
        </div>
      </fieldset>

      {filterError !== null && (
        <p role="alert" className="text-xs text-destructive">
          {filterError}
        </p>
      )}

      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => onFilters(NO_FILTERS)}
          className={cn(FILTER_CONTROL, "px-3", FOCUS, filterChipState(false))}
        >
          Clear
        </button>
      </div>
    </div>
  );
}

/**
 * What a scanned card lands as before anybody looks at it: `Detect`, or one finish for all.
 *
 * **Stamped on a row as it lands**, so changing it moves the *next* card and leaves the rows
 * already in the tray alone — a row the reader set to foil must not flip back. The caption under
 * the list says which of the two policies is in force; **`Detect`'s says what it does when it
 * cannot tell**, the one thing a reader has to know about it before a row reading `Unknown` turns
 * up in the tray.
 *
 * The Camera list's arrangement ({@link CameraBody}): a radiogroup, one Tab stop, a press chooses
 * and closes and an arrow only chooses.
 */
function FinishBody({
  finish,
  onFinish,
  onPress,
}: {
  finish: ScannerFinishPref;
  /** An arrow's choice: the panel stays open. */
  onFinish: (f: ScannerFinishPref) => void;
  /** A press's choice: the caller chooses and closes. */
  onPress: (f: ScannerFinishPref) => void;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      {/* A caption for the eye only, as the Camera list's is: the group is named by the same
          words, and a second name here would be announced before the one it already carries. */}
      <span aria-hidden="true" className="px-2 pb-1 pt-1.5 text-xs text-dim">
        {NEW_CARDS_LAND_AS}
      </span>
      <div role="radiogroup" aria-label={NEW_CARDS_LAND_AS} className="flex flex-col gap-0.5">
        {FINISH_CHOICES.map((choice, i) => (
          <RadioRow
            key={choice}
            label={FINISH_PREF_LABEL[choice]}
            checked={choice === finish}
            onPress={() => onPress(choice)}
            keys={radioKeys(FINISH_CHOICES, finish, onFinish, i)}
          />
        ))}
      </div>
      <div aria-hidden="true" className="my-1 h-px bg-border" />
      <p className="px-2 pb-1.5 pt-1 text-xs leading-snug text-dim">
        {finish === DETECT
          ? "A card printed in one finish takes it. One printed in several waits in the tray for you to pick."
          : "Each new card starts in this finish."}
      </p>
    </div>
  );
}

/**
 * Which camera reads the cards: one radio per camera, the open one ticked and marked `Live`.
 *
 * **A radiogroup**, because this is a list of unknown length and exactly one value. One Tab stop
 * and the arrows choose, through `radioKeys` like every group in the app.
 *
 * **A press chooses and closes; an arrow only chooses.** Both are the same choice — `onCamera` with
 * the camera's id — and differ only in whether the panel stays: a press is "that one", while an
 * arrow is a walk, and shutting the panel on its first step would have a keyboard reader reopen it
 * for every camera they pass. Each step does restart the stream, which is what the line under the
 * list warns of.
 *
 * **Alphabetical through `sortOptions`**: the order `enumerateDevices` answers in is the driver's
 * and says nothing a reader could use.
 *
 * **The tick follows the camera that is open, not the one last pressed.** Between a press and the
 * new stream nothing is ticked, which is true — the old camera has stopped and the new one has not
 * started — and a stored camera that has been unplugged leaves the default ticked in its place.
 */
function CameraBody({
  cameras,
  cameraId,
  onCamera,
  onPress,
}: {
  cameras: readonly CameraDevice[];
  cameraId: string | null;
  /** An arrow's choice: the panel stays open. */
  onCamera: (deviceId: string) => void;
  /** A press's choice: the caller chooses and closes. */
  onPress: (deviceId: string) => void;
}) {
  const sorted = sortOptions(cameras, (c) => c.label);
  const ids = sorted.map((c) => c.deviceId);
  const walk = (id: string | null) => {
    if (id !== null) onCamera(id);
  };

  return (
    <div className="flex flex-col gap-0.5">
      {/* A caption for the eye only, as `FiltersBody`'s `Sets` is: the group names itself
          `Camera`, and a second name here would be announced before the one it already carries. */}
      <span aria-hidden="true" className="px-2 pb-1 pt-1.5 text-xs text-dim">
        Camera
      </span>
      <div role="radiogroup" aria-label="Camera" className="flex flex-col gap-0.5">
        {sorted.map((camera, i) => {
          const live = camera.deviceId === cameraId;
          return (
            <RadioRow
              key={camera.deviceId}
              label={camera.label}
              checked={live}
              onPress={() => onPress(camera.deviceId)}
              keys={radioKeys<string | null>(ids, cameraId, walk, i)}
              mark={
                live && (
                  <span
                    aria-hidden="true"
                    className="inline-flex shrink-0 items-center gap-1.5 text-[0.6875rem] text-ok"
                  >
                    <span className="size-1.5 rounded-full bg-ok" />
                    Live
                  </span>
                )
              }
            />
          );
        })}
      </div>
      <div aria-hidden="true" className="my-1 h-px bg-border" />
      <p className="px-2 pb-1.5 pt-1 text-xs leading-snug text-dim">{CAMERA_CHOICE_NOTE}</p>
    </div>
  );
}

/**
 * One row of a dock menu's radiogroup — a finish, a camera — written once so the two lists cannot
 * start to differ.
 *
 * **Named outright, because the visible name does not survive being computed**: the label and a
 * trailing mark (the camera's `Live`) are two elements a `gap` apart, which the name algorithm
 * fuses into `Logitech BRIOLive`. `aria-checked` is what says which one is chosen.
 */
function RadioRow({
  label,
  checked,
  onPress,
  keys,
  mark,
}: {
  label: string;
  checked: boolean;
  onPress: () => void;
  /** `radioKeys`' two props for this row: its Tab stop and the arrows. */
  keys: RadioKeyProps;
  /** Drawn at the row's end, for the eye only. */
  mark?: ReactNode;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      aria-label={label}
      onClick={onPress}
      {...keys}
      className={cn(
        "flex h-9 w-full items-center gap-2 rounded-md px-2 text-left text-sm text-text",
        "transition-colors duration-[var(--duration-fast)] motion-reduce:transition-none",
        // The chosen row sits on the page ground, the context menu's hover wash held still; the
        // rest take a lighter wash of it under the pointer, so a hover never reads as a second
        // choice being made.
        checked ? "bg-bg" : "hover:bg-bg/60",
        // Inset: the rows are stacked 2px apart, and an outline standing off one would be drawn
        // over its neighbour.
        FOCUS_INSET,
      )}
    >
      {/* `invisible` rather than absent, so every label starts at the same x whether or not its
          row is the ticked one — the context menu's radio rows, for their reason. */}
      <Check
        className={cn("size-4 shrink-0 text-accent", !checked && "invisible")}
        aria-hidden="true"
      />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {mark}
    </button>
  );
}
