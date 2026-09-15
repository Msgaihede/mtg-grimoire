import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion, useIsPresent } from "motion/react";
import { Bug, ChevronDown } from "lucide-react";
import { Dropdown } from "@/components/Dropdown/Dropdown";
import type { DropdownOption } from "@/components/Dropdown/types";
import { FILTER_CONTROL, filterChipState } from "@/components/FilterChips";
import { useTooltip } from "@/components/tooltip/useTooltip";
import { SetCombobox } from "@/features/search/SetCombobox";
import { CONDITION_LABEL, CONDITION_NOT_SET, CONDITIONS, type Condition } from "@/lib/conditions";
import { FINISH_LABEL, FINISHES, type Finish } from "@/lib/finish";
import { FOCUS } from "@/lib/focus";
import type { ScanFilters, ScanMode } from "@/lib/ipc";
import { LAYER } from "@/lib/layers";
import { PRESS, PRESS_STILL, popup } from "@/lib/motion";
import { useDismissOnEscape } from "@/lib/useDismissOnEscape";
import { cn } from "@/lib/utils";
import { filterSummary } from "./readerText";

export interface ScanBarProps {
  mode: ScanMode;
  onMode: (m: ScanMode) => void;
  filters: ScanFilters;
  onFilters: (f: ScanFilters) => void;
  /** The last `set_filters` refusal, drawn inside the popover. */
  filterError: string | null;
  /** A reason, or null when filters can be used. */
  filtersDisabled: string | null;
  finish: Finish;
  onFinish: (f: Finish) => void;
  condition: Condition;
  onCondition: (c: Condition) => void;
  developer: boolean;
  onDeveloper: (on: boolean) => void;
}

/** The unrestricted filter, spelled once for the Clear press and nowhere else. */
const NO_FILTERS: ScanFilters = { sets: [], released_from: null, released_to: null };

/**
 * The two modes, in the order a reader meets them: the quick one first.
 *
 * The hints say what each mode *does for the reader* and never how — no hashes, no tiers, no
 * bursts. Those words belong to the developer panels behind the switch at the other end of this
 * row, and a reader choosing between two scans needs only to know which one pins the printing.
 */
const MODES: readonly { id: ScanMode; label: string; hint: string }[] = [
  { id: "fast", label: "Fast", hint: "Names a card from its picture — quickest for a pile of different cards" },
  {
    id: "exact",
    label: "Exact",
    hint: "Also reads the name and collector number, to tell one printing from another",
  },
];

/**
 * **Deliberately not through `sortOptions` — the order is the information.** A printing's finishes
 * read plain before the premium treatments everywhere in this app, and `FINISHES` is written in
 * that order.
 */
const FINISH_OPTIONS: readonly DropdownOption[] = FINISHES.map((f) => ({ value: f, label: FINISH_LABEL[f] }));

/**
 * **Deliberately not through `sortOptions` — the order is the information.** `CONDITIONS` is a
 * grade scale, `Not set` and then best to worst, which is `AddToCollection`'s list and its reason.
 */
const CONDITION_OPTIONS: readonly DropdownOption[] = CONDITIONS.map((c) => ({
  value: c,
  label: CONDITION_LABEL[c],
}));

/**
 * The reader's controls over the camera, in one row that wraps: the mode, the filters, the tray's
 * defaults, and the switch that brings the developer panels back.
 *
 * **Everything here is controlled.** The page owns the prefs and pushes the filters to the session,
 * and a refusal comes back through `filterError`; this row holds nothing but which popover is
 * open. That is what lets a story draw every state of it from arguments alone.
 *
 * **It wraps rather than scrolls**, for `src/CLAUDE.md`'s narrowest-surface rule: on a phone the
 * row is the window's width, and a flex row of fixed-width controls that cannot wrap puts a
 * horizontal scrollbar across the whole view.
 */
export function ScanBar({
  mode,
  onMode,
  filters,
  onFilters,
  filterError,
  filtersDisabled,
  finish,
  onFinish,
  condition,
  onCondition,
  developer,
  onDeveloper,
}: ScanBarProps) {
  const summary = filterSummary(filters);
  const filtering =
    filters.sets.length > 0 || Boolean(filters.released_from) || Boolean(filters.released_to);
  const conditionWords =
    condition === CONDITION_NOT_SET ? "Condition not set" : CONDITION_LABEL[condition];

  return (
    <div className="flex flex-wrap items-center gap-2">
      <ModeSwitch mode={mode} onMode={onMode} />

      <BarPopover
        caption="Filters"
        value={summary}
        active={filtering}
        refusal={filtersDisabled}
        panelLabel="Filters"
        panelClassName="w-72"
      >
        <FiltersBody filters={filters} onFilters={onFilters} filterError={filterError} />
      </BarPopover>

      <BarPopover
        caption="Defaults"
        value={`${FINISH_LABEL[finish]} · ${conditionWords}`}
        active={false}
        refusal={null}
        panelLabel="Defaults"
        panelClassName="w-64"
      >
        <DefaultsBody
          finish={finish}
          onFinish={onFinish}
          condition={condition}
          onCondition={onCondition}
        />
      </BarPopover>

      <DeveloperSwitch on={developer} onChange={onDeveloper} />
    </div>
  );
}

/**
 * **Fast | Exact**, in the scanner's segment grammar: `role="group"` with `aria-pressed` per
 * button, never a radiogroup.
 *
 * `ControlsPanel`'s `Segment` is the grammar and its argument verbatim — these are toggles that
 * happen to be exclusive, and a radio's roving tab stop would put the reader inside a two-way
 * keyboard mode to change one word. That component is module-private and drawn *inside* a panel,
 * so its box does not transfer: this one stands on the page ground beside 36px triggers, so it is
 * the deck editor's `Theory | Actual` box instead — 36px, a hairline, and the chosen word filled
 * in accent, because which mode the camera is in is the one fact on this row a reader must read
 * without looking twice.
 *
 * The group is padded rather than clipped, so each button keeps the app's outset focus outline:
 * a clipped group would cut that outline off, and an inset one would vanish into the accent fill.
 */
function ModeSwitch({ mode, onMode }: { mode: ScanMode; onMode: (m: ScanMode) => void }) {
  const tip = useTooltip();
  return (
    <div
      role="group"
      aria-label="Scan mode"
      className="flex shrink-0 gap-0.5 rounded-md border border-border p-0.5"
    >
      {MODES.map(({ id, label, hint }) => (
        <button
          key={id}
          type="button"
          aria-pressed={mode === id}
          onClick={() => onMode(id)}
          {...tip(hint)}
          className={cn(
            // 30px inside a 2px pad and a hairline is the row's 36 exactly, so the switch shares
            // a line with the triggers beside it.
            "h-7.5 rounded-[4px] px-3 text-sm",
            PRESS,
            mode === id ? "bg-accent font-medium text-accent-fg" : "text-dim hover:text-text",
            FOCUS,
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/**
 * A trigger on the row and the panel it opens under itself.
 *
 * **`AnchoredPopup`'s shell, drawn for a worded trigger.** That component owns exactly this
 * behaviour — anchored rather than portalled for the shipped CSP, Escape through the one ladder
 * with the caret handed back, focus leaving the root closing it, and a fading panel that is a
 * picture rather than a second copy of its form — but its trigger is a 24px glyph with no words,
 * and it has no way to say *not now*. Both of those are this row's whole job, so the behaviour is
 * followed rather than imported; a text trigger and a refusal on that component are the change
 * that would fold this back into it.
 *
 * **Refused, the trigger stays in the tab order and says why.** `aria-disabled` rather than the
 * attribute, and the reason is its tooltip — a Filters button that silently did nothing, or that
 * vanished from the tab order the moment the scanner had no labels, would be a control a reader
 * could not learn the rule of.
 *
 * **The name is spelled, not computed.** The caption and the value are two elements in a row with
 * a gap between them, which the name algorithm would fuse into one word; an explicit label holds
 * both in the order they are drawn.
 */
function BarPopover({
  caption,
  value,
  active,
  refusal,
  panelLabel,
  panelClassName,
  children,
}: {
  caption: string;
  value: string;
  /** Gold when on — a filter narrowing the scan is a state a reader should see at a glance. */
  active: boolean;
  /** Why the popover cannot open, or `null` when it can. */
  refusal: string | null;
  panelLabel: string;
  panelClassName?: string;
  children: ReactNode;
}) {
  const tip = useTooltip();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const refused = refusal !== null;
  /** Derived rather than written back: a refusal arriving while the panel is open closes it, and
   *  the reason going away does not reopen a panel nobody asked for since. */
  const shown = open && !refused;

  const dismiss = useCallback(() => {
    setOpen(false);
    buttonRef.current?.focus();
  }, []);
  useDismissOnEscape({ layer: "inner", onDismiss: dismiss, enabled: shown });

  return (
    <div
      ref={rootRef}
      // `min-w-0` so a long summary truncates inside the trigger instead of holding the whole
      // wrapped line at its full width: a flex item's floor is its content otherwise.
      className="relative min-w-0 max-w-full"
      onBlur={(e) => {
        if (shown && !rootRef.current?.contains(e.relatedTarget)) setOpen(false);
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={shown}
        aria-disabled={refused || undefined}
        aria-label={`${caption}: ${value}`}
        onClick={() => {
          if (refused) return;
          setOpen((o) => !o);
        }}
        {...tip(refusal)}
        className={cn(
          FILTER_CONTROL,
          "inline-flex max-w-full items-center gap-1.5 px-2.5",
          FOCUS,
          filterChipState(active, refused),
        )}
      >
        <span className="shrink-0 text-dim">{caption}</span>
        <span className="min-w-0 truncate">{value}</span>
        <ChevronDown className="size-3.5 shrink-0" aria-hidden="true" />
      </button>
      <AnimatePresence>
        {shown && (
          <PopoverPanel label={panelLabel} className={panelClassName}>
            {children}
          </PopoverPanel>
        )}
      </AnimatePresence>
    </div>
  );
}

/**
 * The panel — its own component so its contents mount and unmount with it, and so the fade-out
 * reads `useIsPresent` from inside the presence, the only place that answer changes.
 *
 * Pinned by its **left** edge and grown from its top-left corner: both triggers sit at the start of
 * the row or of a wrapped line, so there is nothing to their left for a panel to open back across,
 * and a panel opening rightward from them has the row's own width to land in.
 */
function PopoverPanel({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const present = useIsPresent();

  // The caret moves into the layer, so Tab reaches its controls next and Escape has something to
  // hand back. `preventScroll`, for `AnchoredPopup`'s reason: the panel is still at its entry
  // scale on this render, and a scroll computed against it lands short.
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, []);

  return (
    <motion.div
      {...popup}
      ref={ref}
      tabIndex={-1}
      role="dialog"
      aria-label={label}
      aria-hidden={present ? undefined : true}
      className={cn(
        "absolute left-0 top-full mt-1 origin-top-left rounded-lg border border-border bg-surface p-3 text-left shadow-lg",
        LAYER.popup,
        !present && "pointer-events-none",
        // No focus outline: a landing pad, not a control — `src/lib/focus.ts` has the rule.
        className,
      )}
    >
      {children}
    </motion.div>
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
 * **No language, deliberately and in this pass's own words** (spec §3, decision 7): the bundle
 * holds one printing per card, English wherever English exists, so a language filter would bite
 * on almost nothing and read as though it bit on everything.
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
 * What a scanned card is filed as before anybody looks at it.
 *
 * **The two defaults reach the tray at different moments, and each caption says which.** A finish
 * is stamped on a row as it lands, so changing it moves the *next* card and leaves the rows already
 * there alone — a row the reader set to foil must not flip back. A condition is not a row field at
 * all: the whole tray commits in one condition, so this one is read at the press of Add.
 */
function DefaultsBody({
  finish,
  onFinish,
  condition,
  onCondition,
}: {
  finish: Finish;
  onFinish: (f: Finish) => void;
  condition: Condition;
  onCondition: (c: Condition) => void;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <label id={`${id}-finish-label`} htmlFor={`${id}-finish`} className="text-xs text-dim">
          Finish
        </label>
        <Dropdown
          id={`${id}-finish`}
          labelledBy={`${id}-finish-label`}
          value={finish}
          onChange={(v) => onFinish(v as Finish)}
          options={FINISH_OPTIONS}
          fill
        />
        <p className="text-[0.7rem] leading-snug text-dim">Each new card starts in this finish.</p>
      </div>
      <div className="flex flex-col gap-1">
        <label id={`${id}-condition-label`} htmlFor={`${id}-condition`} className="text-xs text-dim">
          Condition
        </label>
        <Dropdown
          id={`${id}-condition`}
          labelledBy={`${id}-condition-label`}
          value={condition}
          onChange={(v) => onCondition(v as Condition)}
          options={CONDITION_OPTIONS}
          fill
        />
        <p className="text-[0.7rem] leading-snug text-dim">
          Every card in the tray is added in this condition.
        </p>
      </div>
    </div>
  );
}

/**
 * The way back to today's panels, at the end of the row.
 *
 * `role="switch"` named by its own word, so the state is `aria-checked` and the name never moves
 * under a reader's finger. Accent when on and quiet until hovered when off — the Settings page's
 * switch tone, drawn in this row's 36px box rather than imported from that page's recipe, which
 * is `Panel.tsx`'s argument about a class string crossing a feature boundary.
 */
function DeveloperSwitch({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
      className={cn(
        FILTER_CONTROL,
        "ml-auto inline-flex items-center gap-1.5 px-2.5",
        FOCUS,
        on ? "border-accent text-accent" : "border-border text-dim hover:border-accent hover:text-accent",
      )}
    >
      {/* `Bug` and not `Wrench`: the wrench is Deck settings' glyph, and one picture for two
          unrelated controls is a vocabulary a reader has to unlearn. */}
      <Bug className="size-3.5 shrink-0" aria-hidden="true" />
      Developer
    </button>
  );
}
