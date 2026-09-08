import { BudgetPanel } from "./panels/BudgetPanel";
import { ControlsPanel } from "./panels/ControlsPanel";
import { MatchPanel } from "./panels/MatchPanel";
import { PipelinePanel } from "./panels/PipelinePanel";
import { ReadoutsPanel } from "./panels/ReadoutsPanel";
import { RectifiedPanel } from "./panels/RectifiedPanel";
import type {
  ScannerCollector,
  ScannerOcr,
  ScannerOptions,
  ScannerStatus,
  ScannerVerdict,
} from "./types";

export interface ScannerPanelsProps {
  status: ScannerStatus | null;
  verdict: ScannerVerdict | null;
  /**
   * The last title read, which is **not** `verdict.ocr` and must not be replaced by it.
   *
   * The readers run on one eligible frame in four, so the current verdict's own `ocr` is
   * `null` most of the time and a Readouts panel fed it flashes "nothing read" between reads.
   * `useScanLoop` keeps the last one; everything else on this column is still the frame's.
   */
  lastOcr: ScannerOcr | null;
  /** The last collector-line read, for {@link ScannerPanelsProps.lastOcr}'s reason. */
  lastCollector: ScannerCollector | null;
  /** The pump's last round trip; the budget's `transport` is this minus the crate's stages. */
  roundTripMs: number | null;
  /** Frames per second over the last twenty. */
  rate: number | null;
  options: ScannerOptions;
  sendPx: number;
  onOptions: (next: ScannerOptions) => void;
  onSendPx: (px: number) => void;
  onReset: () => void;
  /** Resolves to the saved file name, rejects with a sentence the panel prints verbatim. */
  onCapture: (expected: string) => Promise<string>;
}

/**
 * The Scanner's right-hand column: what the frame came to, and every knob and figure behind it.
 *
 * **Pure and prop-driven, with one exception that is deliberate.** Nothing here holds a camera,
 * a pump or a query — the whole column is a function of the last verdict and the options in
 * force, which is what makes every state of it a story and a test. The exception is the fold
 * state, which lives in `useAppStore` rather than travelling through these props: a reader who
 * folded the pipeline away and went to Settings should find it folded on the way back, and a
 * prop would make that the *view's* memory rather than the app's.
 *
 * **`Match` is first and never folds**; the five below it are developer panels, all closed until
 * asked for. `Pipeline` is the one that is conditionally *absent* rather than merely folded —
 * the stage images roughly double the response time, so a panel whose heading was there while
 * the option was off would be an invitation to open an empty box.
 */
export function ScannerPanels(p: ScannerPanelsProps) {
  const rule = p.options.rule;

  return (
    <div className="flex flex-col gap-4">
      <MatchPanel
        status={p.status}
        verdict={p.verdict}
        lastCollector={p.lastCollector}
        rate={p.rate}
        onReset={p.onReset}
        onCapture={p.onCapture}
      />
      <ControlsPanel
        options={p.options}
        sendPx={p.sendPx}
        onOptions={p.onOptions}
        onSendPx={p.onSendPx}
      />
      {p.options.stages && <PipelinePanel stages={p.verdict?.stages ?? null} />}
      <BudgetPanel verdict={p.verdict} roundTripMs={p.roundTripMs} />
      <RectifiedPanel verdict={p.verdict} />
      <ReadoutsPanel
        status={p.status}
        verdict={p.verdict}
        ocr={p.lastOcr}
        collector={p.lastCollector}
        rule={rule}
      />
    </div>
  );
}
