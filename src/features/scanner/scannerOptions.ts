import type { ScannerOptions } from "./types";

/**
 * The debug page's sliders as they start, and the mode — `FrameOptions::default()` in the crate,
 * verbatim. `mode` is not a slider: the reader's view sends the stored prefs' mode over it.
 */
export const DEFAULT_SCANNER_OPTIONS: ScannerOptions = {
  work_long_edge: 1024,
  method: "both",
  canny_low: 40,
  canny_high: 100,
  aspect_tolerance: 0.18,
  min_cardness: 0,
  stages: false,
  previews: false,
  rule: "votes",
  decide_at: 8,
  lead_margin: 1.3,
  mode: "fast",
};

/**
 * The long edge a frame is downscaled to before it is sent — the page's `send` slider. Not a
 * `FrameOptions` field: the detector never sees the size it was not sent.
 */
export const DEFAULT_SEND_PX = 960;
export const SEND_PX = { min: 480, max: 1440, step: 80 } as const;

/**
 * How long the pump waits, in milliseconds, between a verdict asking for a detail image and the
 * grab that takes it — the page's `detail wait` slider (issue #741). Not a `FrameOptions` field
 * for `send px`'s reason: the wait is over before anything is sent.
 *
 * ⚠️ **200 is the middle of the 100–300 ms the issue's reporter suggested, and no camera has
 * measured it.** The slider is how the right value gets found; `0` is the grab on the very next
 * iteration that shipped before, which is what to compare against.
 */
export const DEFAULT_DETAIL_WAIT_MS = 200;
export const DETAIL_WAIT_MS = { min: 0, max: 500, step: 25 } as const;

export interface SliderSpec {
  key: keyof ScannerOptions;
  label: string;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
}

/** The seven numeric sliders, in the order the Controls panel draws them. */
export const SLIDERS: readonly SliderSpec[] = [
  { key: "decide_at", label: "decide at", min: 1, max: 40, step: 1, format: String },
  { key: "lead_margin", label: "lead margin", min: 1, max: 3, step: 0.1, format: (v) => v.toFixed(1) },
  { key: "work_long_edge", label: "work edge", min: 320, max: 1600, step: 64, format: String },
  { key: "canny_low", label: "canny lo", min: 5, max: 120, step: 5, format: String },
  { key: "canny_high", label: "canny hi", min: 20, max: 300, step: 10, format: String },
  { key: "aspect_tolerance", label: "aspect tol", min: 0.04, max: 0.4, step: 0.01, format: (v) => v.toFixed(2) },
  { key: "min_cardness", label: "min cardness", min: 0, max: 0.8, step: 0.05, format: (v) => v.toFixed(2) },
];
