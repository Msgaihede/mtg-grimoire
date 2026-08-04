/**
 * Magic's colour pie, as the interface uses it.
 *
 * The direction doc's thesis: colour appears only where it carries Magic meaning. This
 * module is the whole of that vocabulary — the five (plus colourless) symbol keys, the
 * `mana-font` class names that draw them, and the gradient behind the app's one signature
 * element. Nothing else in the app invents a colour.
 */
import type { SyncPhase, SyncProgressEvent } from "@/lib/ipc";
import { PHASE_LABEL } from "@/lib/useSyncProgress";

/** The filter chips: WUBRG plus colourless. */
export const MANA_KEYS = ["W", "U", "B", "R", "G", "C"] as const;
export type ManaKey = (typeof MANA_KEYS)[number];

/**
 * The mana line is the colour *pie*, not the filter row — five colours, no colourless.
 * WUBRG order is not a preference: it is the order the symbols are printed in.
 */
export const MANA_LINE_KEYS = ["W", "U", "B", "R", "G"] as const;

export const MANA_LABEL: Record<ManaKey, string> = {
  W: "White",
  U: "Blue",
  B: "Black",
  R: "Red",
  G: "Green",
  C: "Colorless",
};

/**
 * The `mana-font` classes that draw one symbol.
 *
 * The glyph comes from the bundled font; the *fill* comes from our own tokens, because
 * `mana-font`'s built-in `--ms-mana-*` values are a shade off the direction doc's
 * (`#fdfbce` where the doc says `#FFFBD5`) and the doc is what is binding.
 */
export function manaSymbolClass(key: ManaKey): string {
  return `ms ms-${key.toLowerCase()}`;
}

/**
 * The signature: a soft W→U→B→R→G blend, written against the theme tokens so the line and
 * the chips can never drift apart.
 */
export const MANA_LINE_GRADIENT = `linear-gradient(90deg, var(--color-mana-w) 0%, var(--color-mana-u) 25%, var(--color-mana-b) 50%, var(--color-mana-r) 75%, var(--color-mana-g) 100%)`;

/** What the mana line is showing, or `null` when it is just a line. */
export interface ManaLineSync {
  /** 0–1, or `null` for a phase with no denominator. */
  value: number | null;
  label: string;
}

/**
 * Fold a sync into what the line should draw.
 *
 * `busy` decides, not the event: a run inside the 24 h check window emits nothing at all,
 * and Tauri drops the events emitted before the webview started listening — so an event
 * is evidence of progress, never of running. `done` and `error` are terminal phases whose
 * event can outlive the run by a poll interval, so they read as indeterminate rather than
 * as a full or empty bar.
 */
export function manaLineSync(
  progress: SyncProgressEvent | null,
  busy: boolean,
): ManaLineSync | null {
  if (!busy) return null;
  const phase: SyncPhase | null =
    progress && progress.phase !== "done" && progress.phase !== "error" ? progress.phase : null;
  if (!phase || !progress) return { value: null, label: "Syncing card data" };
  return {
    value: progress.total > 0 ? Math.min(1, progress.done / progress.total) : null,
    label: PHASE_LABEL[phase],
  };
}
