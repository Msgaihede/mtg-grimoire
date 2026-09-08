import type { ScannerOptions } from "./types";

/** The debug page's sliders as they start — `FrameOptions::default()` in the crate, verbatim. */
export const DEFAULT_SCANNER_OPTIONS: ScannerOptions = {
  work_long_edge: 1024,
  method: "both",
  canny_low: 40,
  canny_high: 100,
  aspect_tolerance: 0.18,
  min_cardness: 0,
  stages: false,
  rule: "votes",
  decide_at: 8,
  lead_margin: 1.3,
};

/**
 * The long edge a frame is downscaled to before it is sent — the page's `send` slider. Not a
 * `FrameOptions` field: the detector never sees the size it was not sent.
 */
export const DEFAULT_SEND_PX = 960;
export const SEND_PX = { min: 480, max: 1440, step: 80 } as const;

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
