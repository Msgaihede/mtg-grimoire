import { toBase64 } from "@/lib/base64";
import type { Finish } from "@/lib/finish";
import type { ScanMode, ScannerStatus, ScannerSubmission, ScannerVerdict } from "../types";

/**
 * The long edge a sent picture is brought down to, at most.
 *
 * 1920 is `useCamera`'s own ideal, so the camera this app asks for goes out whole and a 4K one is
 * brought down to it — the picture has to be worth reading a collector line off, and it has to be
 * awaited across a network on one press. Not the pump's 960: that is the size the detector is
 * fed, and a frame it got wrong is most worth keeping at the size it was *not* shown.
 */
export const SUBMIT_LONG_EDGE = 1920;

/** The sent picture's JPEG quality — above the pump's, for the fine print it exists to carry. */
export const SUBMIT_QUALITY = 0.9;

/**
 * The scanner's side of a submission: every field of {@link ScannerSubmission} the reader does
 * not choose. Named as a slice of that type rather than written out, so a field added to the
 * wire shape is a compile error here until this module says where it comes from.
 */
export type ScannerSaid = Omit<ScannerSubmission, "cardId" | "finish">;

/**
 * What was true at the press: the picture, and what the scanner was saying about it.
 *
 * **A snapshot, taken once.** The camera and the pump keep running behind the dialog — as they
 * do behind every dialog on the page — so by the time the reader presses Send the live verdict is
 * about another frame, and quite possibly another card. Everything a submission says about the
 * scanner is therefore read here, at the press, and never again.
 */
export interface ScanStill {
  /**
   * The JPEG as standard base64, with no `data:` prefix. **Drawn from the very string that is
   * sent** — the dialog's picture is this text behind a `data:` scheme — so what the reader
   * checks and what leaves the device cannot be two encodes of one frame.
   */
  frame: string;
  said: ScannerSaid;
  /**
   * The card the scanner was naming, for the search box to open on — `""` when it named none.
   * **A convenience and never a label**: it is not sent, and it selects nothing. The reader
   * chooses the printing, which is the whole point of asking them.
   */
  leadName: string;
}

/**
 * A {@link ScanStill} from one grabbed frame and the page's state at that moment. Pure, so each
 * rung below is a fixture's worth of test.
 *
 * **`reported` is the printing the scanner had decided on, and `null` while it had decided
 * nothing.** Never the tracker's leader: a standing's `id` is what its evidence pooled on — the
 * *oracle* id — so sent beside the printing a reader chose it would be an id of another kind,
 * and "the scanner got it right" could never be read off the two (it could not even be right).
 * A committed frame carries the decision on every frame it stays committed, so a reader who
 * sends a card the scanner has settled on sends what it settled on; one who sends while it is
 * still weighing sends `null`, with how far it had got in `confidence` and `distance`. Sent as
 * `null` rather than left out: a picture it had not named is as much worth having as one it
 * named wrongly.
 *
 * **The name the search opens on is another matter, and takes a leader.** It is a word for a
 * box, not a label: the decision's when there is one — `matchStrip` names a card by the same
 * order, so the box opens on the name the reader was just shown — else the card the tracker is
 * leaning towards, whose label is its best printing's.
 *
 * `distance` is the best candidate's, in bits, off the frame's own match; `bundle` is how many
 * cards the scanner could have answered with, off the status — `null` where the status has not
 * answered, which is "not asked", never "none".
 */
export function scanStill(
  bytes: Uint8Array,
  verdict: ScannerVerdict | null,
  mode: ScanMode,
  status: ScannerStatus | null,
): ScanStill {
  const lead = verdict?.tracked?.standings[0];
  return {
    frame: toBase64(bytes),
    said: {
      reported: verdict?.decision?.printing ?? null,
      mode,
      confidence: verdict?.tracked?.confidence ?? null,
      distance: verdict?.match?.candidates[0]?.distance ?? null,
      bundle: status?.labels ?? null,
    },
    leadName: verdict?.decision?.label?.name ?? lead?.label?.name ?? "",
  };
}

/** The whole submission: the reader's two answers beside what the scanner had said. */
export function submissionOf(still: ScanStill, cardId: string, finish: Finish): ScannerSubmission {
  return { cardId, finish, ...still.said };
}
