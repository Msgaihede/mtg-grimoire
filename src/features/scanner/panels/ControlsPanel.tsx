import { PRESS_STILL } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { SEND_PX, SLIDERS, type SliderSpec } from "../scannerOptions";
import type { ScannerMethod, ScannerOptions, ScannerRule } from "../types";
import { Panel } from "./Panel";

/** The two words the `stages` boolean is drawn as. A switch would not say what it turns on. */
const STAGE_CHOICES = ["overlay only", "full stages"] as const;
type StageChoice = (typeof STAGE_CHOICES)[number];

/**
 * A row of mutually exclusive choices, drawn as one control rather than as N buttons.
 *
 * `role="group"` with `aria-pressed` per button, not a radiogroup: these are toggles that
 * happen to be exclusive, and a radio's roving tab stop would put the reader inside a
 * three-way keyboard mode to change one word.
 */
function Segment<T extends string>({
  label,
  value,
  choices,
  onChange,
}: {
  label: string;
  value: T;
  choices: readonly T[];
  onChange: (v: T) => void;
}) {
  return (
    <div role="group" aria-label={label} className="flex gap-1 rounded-lg bg-bg p-0.5">
      {choices.map((c) => (
        <button
          key={c}
          type="button"
          aria-pressed={c === value}
          onClick={() => onChange(c)}
          className={cn(
            "flex-1 rounded-md px-2 py-1 text-sm text-dim",
            "aria-pressed:bg-surface aria-pressed:text-text",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
            PRESS_STILL,
          )}
        >
          {c}
        </button>
      ))}
    </div>
  );
}

/**
 * One slider row: the name, the track, and the figure it currently reads.
 *
 * The `aria-label` is what names the input, *not* the wrapping `<label>` — the label's own
 * text is the name plus the live figure, and "decide at 8" is a control whose accessible name
 * changes every time it is dragged. `<output>` is the figure's element for the same reason a
 * range has no `<span>`: it is the calculated result of the control beside it.
 */
function Slider({
  label,
  min,
  max,
  step,
  value,
  display,
  onChange,
}: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  display: string;
  onChange: (v: number) => void;
}) {
  return (
    <label className="grid grid-cols-[76px_1fr_46px] items-center gap-2 text-sm">
      <span className="text-dim">{label}</span>
      <input
        type="range"
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="accent-accent"
      />
      <output className="text-right tabular-nums">{display}</output>
    </label>
  );
}

/**
 * Every knob the detector takes, and the one the *page* takes.
 *
 * The seven numeric sliders come from `SLIDERS` rather than being written out here, because
 * their bounds are a fact about `FrameOptions` and are asserted against the crate's defaults
 * next door. The eighth — `send px` — is deliberately not one of them: it is the size a frame
 * is downscaled to *before* it is sent, so the detector never sees it and it has no field in
 * `ScannerOptions` to live in.
 */
export function ControlsPanel({
  options,
  sendPx,
  onOptions,
  onSendPx,
}: {
  options: ScannerOptions;
  sendPx: number;
  onOptions: (next: ScannerOptions) => void;
  onSendPx: (px: number) => void;
}) {
  // `SliderSpec["key"]` is `keyof ScannerOptions`, which includes the three that are not
  // numbers — the seven specs above name only numeric ones, and this assertion is where that
  // fact is stated. Spreading a computed key of a union widens the result past `ScannerOptions`.
  const setNumber = (key: SliderSpec["key"], v: number) =>
    onOptions({ ...options, [key]: v } as ScannerOptions);

  return (
    <Panel id="controls" title="Controls">
      <Segment<ScannerRule>
        label="rule"
        value={options.rule}
        choices={["votes", "confidence"]}
        onChange={(rule) => onOptions({ ...options, rule })}
      />
      <Segment<ScannerMethod>
        label="method"
        value={options.method}
        choices={["canny", "otsu", "both"]}
        onChange={(method) => onOptions({ ...options, method })}
      />
      <Segment<StageChoice>
        label="stages"
        value={options.stages ? "full stages" : "overlay only"}
        choices={STAGE_CHOICES}
        onChange={(choice) => onOptions({ ...options, stages: choice === "full stages" })}
      />

      {SLIDERS.map((spec) => {
        const value = options[spec.key] as number;
        return (
          <Slider
            key={spec.key}
            label={spec.label}
            min={spec.min}
            max={spec.max}
            step={spec.step}
            value={value}
            display={spec.format(value)}
            onChange={(v) => setNumber(spec.key, v)}
          />
        );
      })}

      <Slider
        label="send px"
        min={SEND_PX.min}
        max={SEND_PX.max}
        step={SEND_PX.step}
        value={sendPx}
        display={String(sendPx)}
        onChange={onSendPx}
      />
    </Panel>
  );
}
