import { useId, useState } from "react";
import { Camera, Gauge, ListFilter, ScanLine, Sparkles } from "lucide-react";
import {
  CAMERA_CHOICE_NOTE,
  filterSummary,
  NO_FILTERS,
  SCAN_MODES,
} from "@/features/scanner/reader/readerText";
import { DETECT, FINISH_PREF_LABEL } from "@/features/scanner/reader/trayFinish";
import type { CameraDevice } from "@/features/scanner/useCamera";
import { SetCombobox } from "@/features/search/SetCombobox";
import { CONDITION_LABEL, CONDITIONS, type Condition } from "@/lib/conditions";
import { FINISHES } from "@/lib/finish";
import { FOCUS } from "@/lib/focus";
import type { ScanFilters, ScanMode, ScannerFinishPref } from "@/lib/ipc";
import { PRESS, PRESS_STILL } from "@/lib/motion";
import { sortOptions } from "@/lib/options";
import { cn } from "@/lib/utils";
import { ActionSheet, SheetBack, SheetChoice, SheetRow } from "../deck/sheet";

type Page = "main" | "mode" | "filters" | "finish" | "condition" | "camera";

/** `Detect` first, because it is the default and the one choice that is not a finish; then a
 *  printing's finishes, plain before the premium treatments — the desktop Defaults popover's order. */
const FINISH_PREFS: readonly ScannerFinishPref[] = [DETECT, ...FINISHES];

/** What each default finish does, said under its name — the desktop popover's two captions. */
const finishNote = (pref: ScannerFinishPref): string =>
  pref === DETECT
    ? "The scanner reads each card's finish. A card it can't tell waits in the tray for you to pick."
    : "Each new card starts in this finish.";

/** A date field a thumb can hit and a phone does not zoom on: 44px tall, 16px type. */
const DATE_FIELD = cn(
  "h-11 w-full min-w-0 rounded-md border border-border bg-bg px-2 text-base text-text",
  "focus:border-accent focus:outline-none",
  PRESS_STILL,
);

/**
 * Everything about a scan that is not on the bar, as a sheet — the desktop bar's Filters, Defaults
 * and Camera popovers, drawn for a finger.
 *
 * **Rows that open lists, each saying what it is set to** (`SheetRow`'s value), and each list a
 * page of this one sheet: the popovers are anchored panels, which at 360px have nowhere to be
 * anchored. Every choice is written as it is pressed, as on the desktop — the camera is running
 * behind the sheet, and the next card should be read under what the sheet says.
 *
 * - **Scan mode** — the bar's switch again, with each mode's sentence under its name. On the
 *   desktop that sentence is a tooltip; here it has to be on the page to be read at all.
 * - **Filters** — the set picker and the release window, sent as they are changed. A refusal from
 *   the session (*No printing matches these filters.*) is said in words under the fields, and the
 *   row itself is refused, with its reason, where the scanner has no card names to filter by.
 * - **Finish** and **Condition** — the tray's two defaults. A finish moves the *next* card; the
 *   condition is read at the press of Add, for every card in the tray.
 * - **Camera** — drawn only where there is a choice to make: a device with one camera, or none,
 *   has no row. The tick follows the camera that is open, not the one last pressed.
 *
 * **No Developer switch.** The developer panels are the desktop's; the phone never asks the engine
 * for their previews, whatever the stored switch says — the pref is shared with the desktop face of
 * the same install, so it is left alone rather than written.
 */
export function OptionsSheet({
  open,
  onClose,
  onDismiss,
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
  cameras,
  cameraId,
  onCamera,
}: {
  open: boolean;
  /** A press on the scrim: closed, the caret left where the reader put it. */
  onClose: () => void;
  /** Escape and the ✕: closed, and the caret handed back to the press that opened it. */
  onDismiss: () => void;
  mode: ScanMode;
  onMode: (mode: ScanMode) => void;
  filters: ScanFilters;
  onFilters: (filters: ScanFilters) => void;
  /** The session's last refusal of a filter, in its words. */
  filterError: string | null;
  /** Why the filters cannot be used at all, or `null`. */
  filtersDisabled: string | null;
  finish: ScannerFinishPref;
  onFinish: (finish: ScannerFinishPref) => void;
  condition: Condition;
  onCondition: (condition: Condition) => void;
  cameras: readonly CameraDevice[];
  /** The camera that is open — `null` while nothing is live. */
  cameraId: string | null;
  onCamera: (deviceId: string) => void;
}) {
  const [page, setPage] = useState<Page>("main");
  const back = () => setPage("main");
  // Either way out starts the sheet on its first page next time.
  const close = () => {
    setPage("main");
    onClose();
  };
  const dismiss = () => {
    setPage("main");
    onDismiss();
  };
  const modeLabel = SCAN_MODES.find((m) => m.id === mode)?.label ?? "";
  const cameraName = cameras.find((c) => c.deviceId === cameraId)?.label ?? "Default";

  return (
    <ActionSheet
      open={open}
      title="Scanner options"
      closeLabel="Close scanner options"
      onClose={close}
      onDismiss={dismiss}
    >
      {page === "main" && (
        <ul>
          <SheetRow
            label="Scan mode"
            value={modeLabel}
            Icon={ScanLine}
            opens
            onPress={() => setPage("mode")}
          />
          <SheetRow
            label="Filters"
            value={filterSummary(filters)}
            Icon={ListFilter}
            opens
            reason={filtersDisabled}
            onPress={() => setPage("filters")}
          />
          <SheetRow
            label="Finish"
            value={FINISH_PREF_LABEL[finish]}
            Icon={Sparkles}
            opens
            onPress={() => setPage("finish")}
          />
          <SheetRow
            label="Condition"
            value={CONDITION_LABEL[condition]}
            Icon={Gauge}
            opens
            onPress={() => setPage("condition")}
          />
          {cameras.length > 1 && (
            <SheetRow
              label="Camera"
              value={cameraName}
              Icon={Camera}
              opens
              onPress={() => setPage("camera")}
            />
          )}
        </ul>
      )}

      {page === "mode" && (
        <>
          <SheetBack label="Scan mode" onBack={back} />
          <ul aria-label="Scan modes">
            {SCAN_MODES.map(({ id, label, hint }) => (
              <SheetChoice
                key={id}
                label={label}
                note={hint}
                current={id === mode}
                onPick={() => {
                  onMode(id);
                  back();
                }}
              />
            ))}
          </ul>
        </>
      )}

      {page === "filters" && (
        <>
          <SheetBack label="Filters" onBack={back} />
          <FiltersPage filters={filters} onFilters={onFilters} filterError={filterError} />
        </>
      )}

      {page === "finish" && (
        <>
          <SheetBack label="Finish" onBack={back} />
          <ul aria-label="Default finishes">
            {FINISH_PREFS.map((pref) => (
              <SheetChoice
                key={pref}
                label={FINISH_PREF_LABEL[pref]}
                note={finishNote(pref)}
                current={pref === finish}
                onPick={() => {
                  onFinish(pref);
                  back();
                }}
              />
            ))}
          </ul>
        </>
      )}

      {page === "condition" && (
        <>
          <SheetBack label="Condition" onBack={back} />
          <p className="px-4 pt-3 pb-1 text-xs leading-snug text-dim">
            Every card in the tray is added in this condition.
          </p>
          {/* The grade scale, `Not set` and then best to worst — the order is the information. */}
          <ul aria-label="Conditions">
            {CONDITIONS.map((c) => (
              <SheetChoice
                key={c}
                label={CONDITION_LABEL[c]}
                current={c === condition}
                onPick={() => {
                  onCondition(c);
                  back();
                }}
              />
            ))}
          </ul>
        </>
      )}

      {page === "camera" && (
        <>
          <SheetBack label="Camera" onBack={back} />
          {/* Alphabetical: the order `enumerateDevices` answers in is the driver's. */}
          <ul aria-label="Cameras">
            {sortOptions(cameras, (c) => c.label).map((camera) => (
              <SheetChoice
                key={camera.deviceId}
                label={camera.label}
                note={camera.deviceId === cameraId ? "Live" : undefined}
                current={camera.deviceId === cameraId}
                onPick={() => {
                  onCamera(camera.deviceId);
                  back();
                }}
              />
            ))}
          </ul>
          <p className="px-4 pt-2 pb-3 text-xs leading-snug text-dim">{CAMERA_CHOICE_NOTE}</p>
        </>
      )}
    </ActionSheet>
  );
}

/**
 * What the scan is narrowed to: sets, a release window, and the way back to everything.
 *
 * **Every change is sent as it is made** — the desktop popover's rule and its reason: the camera
 * is running while this is open. **No language**, for the desktop's reason too: the bundle holds
 * one printing per card.
 */
function FiltersPage({
  filters,
  onFilters,
  filterError,
}: {
  filters: ScanFilters;
  onFilters: (filters: ScanFilters) => void;
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
    <div className="flex flex-col gap-4 px-4 pt-3 pb-4">
      {/* The touch floor for the desktop's set picker, set from outside it — the search sheet's
          arrangement: its trigger and its rows are 36px there, and its search box 14px type. */}
      <div className="flex flex-col gap-1.5 [&_button]:min-h-11 [&_input]:text-base [&_input[type=text]]:min-h-11">
        {/* A caption for the eye only: the picker names itself `Set`. */}
        <span aria-hidden="true" className="text-xs text-dim">
          Sets
        </span>
        <SetCombobox selected={filters.sets} onToggle={toggle} align="start" fill />
      </div>

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
        <p role="alert" className="text-sm text-destructive">
          {filterError}
        </p>
      )}

      <button
        type="button"
        onClick={() => onFilters(NO_FILTERS)}
        className={cn(
          "h-11 self-end rounded-md border border-border px-4 text-sm text-text",
          PRESS,
          FOCUS,
        )}
      >
        Clear filters
      </button>
    </div>
  );
}
