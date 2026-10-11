/** Native and browser scanner measurements reduced by summary.js. */
export interface FrameRecord {
  ok: boolean | null;
  error: string | null;
  decision_seq: number | null;
  printing: string | null;
  named: string | null;
  outcome: string | null;
  title: string | null;
  title_matched: string | null;
  collector: string | null;
  collector_matched: string | null;
  ms: Record<string, number>;
  call_ms: number;
  round_trip_ms?: number;
}

export interface RawMeasurement {
  host: string;
  threads: boolean;
  target?: string;
  inputs: {
    frames: number;
    bundle_bytes: number;
    labels_bytes: number | null;
    models_bytes: number | null;
  };
  module?: { wasm_bytes: number; module_ms: number };
  trap?: { panicked: string; next: string };
  configs: {
    ocr: boolean;
    load_ms: number;
    fetch_ms?: number;
    loaded_memory_bytes?: number;
    memory_bytes?: number;
    printings: number;
    labels: number;
    runs: { mode: string; run: number; frames: FrameRecord[] }[];
  }[];
}

interface Timing {
  median: number | null;
  runs: (number | null)[];
}

export interface ModeSummary {
  mode: string;
  runs: number;
  frames: number;
  first_ms: Timing;
  steady_ms: Timing;
  steady_max_ms: Timing;
  round_trip_ms: Timing;
  resolve_frame_ms: Timing;
  read_frame_ms: Timing;
  read_frames: number[];
  ok_frames: number[];
  decisions: number[];
  decided_at: (number | null)[];
  decided: (string | null)[];
  titles: { read: number; matched: string[] } | null;
  collectors: { read: number; matched: string[] } | null;
  errors: string[];
  stages_ms: Record<string, number | null>;
}

export interface ConfigSummary {
  ocr: boolean;
  printings: number;
  labels: number;
  fetch_ms: number | null;
  load_ms: number;
  loaded_memory_bytes: number | null;
  memory_bytes: number | null;
  modes: ModeSummary[];
}

export interface MeasurementSummary {
  host: string;
  threads: boolean;
  target: string | null;
  inputs: RawMeasurement["inputs"];
  module: RawMeasurement["module"] | null;
  trap: RawMeasurement["trap"] | null;
  configs: ConfigSummary[];
}

export function summarise(raw: RawMeasurement): MeasurementSummary;
export function textOf(summary: MeasurementSummary): string;
export function recordOf(
  verdict: Record<string, unknown>,
): Omit<FrameRecord, "call_ms" | "round_trip_ms">;
