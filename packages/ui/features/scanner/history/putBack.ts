import { ipcError } from "@/lib/ipc";
import type { ScanBatch } from "@/lib/ipc";
import { addBatch } from "../reader/tray";
import type { TrayState } from "../useTray";
import { NOTHING_TO_PUT_BACK } from "./historyWords";

/** What one *Put back in tray* came to: the copies it landed and the copies it left out, or why
 *  it landed none. */
export type PutBackOutcome =
  { ok: true; copies: number; left: number } | { ok: false; sentence: string };

/**
 * **A past scan back into the tray** (issue #1374) — {@link addBatch} over the tray as it is now,
 * written through the tray's own `setRows`, so it is stored behind the reader like any other change
 * and filed by nothing until the tray's Add (or Archive) is pressed.
 *
 * **Built on `tray.latest()`**, every tray writer's rule: the camera may have landed cards since
 * the dialog opened, and a pile put back must not write them away.
 *
 * Words nothing: each Scanner face says the outcome at its own press — the toast is the call
 * site's (`packages/ui/CLAUDE.md`'s toast rule).
 */
export function putBack(
  tray: Pick<TrayState, "latest" | "setRows">,
  batch: ScanBatch,
  now: number = Date.now(),
  newKey: () => string = () => crypto.randomUUID(),
): PutBackOutcome {
  let landed: ReturnType<typeof addBatch>;
  try {
    landed = addBatch(tray.latest(), batch.lines, now, newKey);
  } catch (e) {
    return { ok: false, sentence: ipcError(e) };
  }
  if (landed.copies === 0) return { ok: false, sentence: NOTHING_TO_PUT_BACK };
  tray.setRows(landed.rows);
  return { ok: true, copies: landed.copies, left: landed.left };
}
