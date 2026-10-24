import { BudgetPanel } from "./panels/BudgetPanel";
import { MatchPanel } from "./panels/MatchPanel";
import type { ScannerStatus, ScannerVerdict } from "./types";

export interface ScannerPanelsProps {
  status: ScannerStatus | null;
  verdict: ScannerVerdict | null;
  /** The pump's last round trip; the budget's `transport` is this minus the crate's stages. */
  roundTripMs: number | null;
  /** Frames per second over the last twenty. */
  rate: number | null;
  /** Resolves to the saved file name, rejects with a sentence the panel prints verbatim. */
  onCapture: (expected: string) => Promise<string>;
}

/**
 * The Scanner's developer panels: what the frame came to, and the figures behind it.
 *
 * **Behind the Developer switch, under the tray.** The reader's view never shows a vote or a
 * distance, so the page mounts this column only while `prefs.developer` is on.
 *
 * **Pure and prop-driven, with one exception that is deliberate.** Nothing here holds a camera,
 * a pump or a query — the whole column is a function of the last verdict, which is what makes
 * every state of it a story and a test. The exception is the fold state, which lives in
 * `useAppStore` rather than travelling through these props: a reader who folded a panel away
 * and went to Settings should find it folded on the way back, and a prop would make that the
 * *view's* memory rather than the app's.
 *
 * **`Match` is first and never folds**; the budget below it is closed until asked for.
 */
export function ScannerPanels(p: ScannerPanelsProps) {
  return (
    <div className="flex flex-col gap-4">
      <MatchPanel status={p.status} verdict={p.verdict} rate={p.rate} onCapture={p.onCapture} />
      <BudgetPanel verdict={p.verdict} roundTripMs={p.roundTripMs} />
    </div>
  );
}
