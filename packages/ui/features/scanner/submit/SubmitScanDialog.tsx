import { memo, useCallback, useEffect, useId, useRef, useState, type JSX } from "react";
import { Dialog } from "@/components/Dialog";
import { FILTER_CONTROL, FILTER_FOCUS, filterChipState } from "@/components/FilterChips";
import { PANEL_BUTTON } from "@/features/settings/controls";
import { PrivacyLink } from "@/features/settings/PrivacyLink";
import { FINISH_LABEL, FINISHES, parseFinishes, type Finish } from "@/lib/finish";
import { ipc, ipcError, type CardSummary } from "@/lib/ipc";
import { radioKeys } from "@/lib/radioGroup";
import { cn } from "@/lib/utils";
import { PrintingPicker } from "./PrintingPicker";
import { submissionOf, type ScanRun } from "./run";
import { RunPictures } from "./RunPictures";
import {
  CANCEL,
  CHOOSE_ITS_FINISH,
  CHOOSE_THE_CARD,
  disclosure,
  DONE,
  FINISH,
  FINISH_NEEDS_CARD,
  KEEP_THE_REFERENCE,
  ONE_FINISH,
  REFERENCE,
  SEND,
  SEND_TITLE,
  SENDING,
  SENT,
} from "./submitText";

export interface SubmitScanDialogProps {
  /**
   * The run the reader pressed *Send scan…* on — the last couple of seconds the scanner was
   * shown, with what it was saying at the end of them — `useScanSubmit`'s. `null` is the dialog
   * closed, which is the only time nothing is drawn.
   */
  run: ScanRun | null;
  /** Escape, the ✕, Cancel and Done: hand the caret back to the press that opened this. */
  onDismiss: () => void;
  /** The scrim: close without moving the caret. */
  onClose: () => void;
}

/**
 * *Send this scan* — the pictures a reader is about to send, and the two questions that make
 * them worth having: **which printing is it, and in which finish.**
 *
 * A scan the scanner got wrong is only useful to its maker with the right answer beside it,
 * and the scanner's own answer is by construction the one that cannot be trusted here. So the
 * reader gives both halves themselves (issue #776): nothing is chosen for them but a finish the
 * printing leaves no choice about, and Send says why it will not send until both are.
 *
 * **All of the run or none of it.** What is sent is every frame the scanner was given in its
 * last couple of seconds — it decides over a run, so one picture could not say what it did — and
 * there is no switch here to send fewer: the reader looks through them (`RunPictures`), and
 * sends them or cancels. The two answers name **the card in the last one**, the one under the
 * camera at the press.
 *
 * **Both Scanner surfaces mount this one component**, so it reads no store and no window, and
 * every control grows for a finger through the shared recipes rather than through anything it
 * knows about where it is drawn. Mounted beside the page's other dialogs and never inside a
 * container-query box: a container is the containing block for the shell's fixed scrim.
 *
 * **A send cannot be walked away from.** The reference the inbox answers with is the only handle
 * a reader will ever have on their pictures — nothing kept says who sent them — and it arrives in
 * this dialog. A dialog closed while the request was in flight would be a scan sent and a
 * reference dropped on the floor, so Escape, the ✕ and the scrim wait for the answer, as
 * *Create deck* does for its write.
 */
export function SubmitScanDialog({
  run,
  onDismiss,
  onClose,
}: SubmitScanDialogProps): JSX.Element {
  /** A send is in flight. A ref, read only by the two handlers below: nothing draws it here. */
  const sending = useRef(false);
  // Stable, because the body hangs an effect on it and this component is re-rendered with its
  // page — nine times a second while the camera runs. A fresh function each time would run that
  // effect's cleanup on every verdict, and the cleanup lowers the latch.
  const onSending = useCallback((on: boolean) => {
    sending.current = on;
  }, []);
  return (
    <Dialog
      open={run !== null}
      title={SEND_TITLE}
      closeLabel="Close"
      // The printings' four columns set it: at 36rem each card is about 125px across — reckoned
      // from the classes, not measured in a window — which is roughly where a collector line
      // stops being a smudge. Wider than the window, the shell clamps it.
      size="w-[36rem]"
      onDismiss={() => {
        if (!sending.current) onDismiss();
      }}
      onClose={() => {
        if (!sending.current) onClose();
      }}
    >
      {run !== null && <Body run={run} onSending={onSending} onDismiss={onDismiss} />}
    </Dialog>
  );
}

/**
 * A press that is drawn and will not act: dimmed, and held still under the finger. The dip is
 * the recipe's own, so it is undone here by name — a button that sinks and then does nothing is
 * the lie `FilterChips`' greyed chips refuse to tell.
 */
const OUT_OF_REACH = "cursor-not-allowed opacity-50 active:scale-100";

/**
 * A finish, and whose choice it was.
 *
 * **The two have to be told apart, or a finish nobody chose can be sent.** A printing sold one
 * way has its finish selected for the reader, which is a fact about the cardboard; were that
 * selection to ride along when they then pick a printing sold three ways, the group would open
 * with an answer already in it and Send would be live on a question nobody was asked. So a
 * finish the *printing* supplied is dropped with the printing, and only one the *reader* pressed
 * is carried across — and then only where the new printing comes in it.
 */
type FinishChoice = { value: Finish; by: "reader" | "printing" };

/**
 * The finishes a printing is offered in. An empty or unreadable list is **unknown**, never "none"
 * (`CardSummary.finishes`), so it offers all three and selects none of them.
 */
function finishesOf(card: CardSummary): readonly Finish[] {
  const listed = parseFinishes(card.finishes);
  return listed.length > 0 ? listed : FINISHES;
}

/**
 * The dialog's contents, mounted only while it is open — the shell's rule, and what makes the
 * search, the two choices, a refusal and the thanks one *session*: every open starts with nothing
 * chosen and nothing said, with no effect to clear any of it.
 *
 * **Memoised, because of where it is mounted.** A Scanner page re-renders on every verdict —
 * about nine a second — and this dialog is its child, with up to two hundred card pictures in
 * it. Its three props are a value in state and two stable functions (`useScanSubmit`), so behind
 * the memo the body renders when the reader does something and not when the camera does. Which
 * of the run's pictures is showing is `RunPictures`' own state for the same reason one floor
 * down: a pass through them is nine steps a second, and none of them is the printings' business.
 */
const Body = memo(function Body({
  run,
  onSending,
  onDismiss,
}: {
  run: ScanRun;
  /** Tell the shell a send has started or ended, so it holds its ways out meanwhile. */
  onSending: (on: boolean) => void;
  onDismiss: () => void;
}) {
  const id = useId();
  const [chosen, setChosen] = useState<CardSummary | null>(null);
  const [finish, setFinish] = useState<FinishChoice | null>(null);
  const [pending, setPending] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  /** The inbox's reference for the scan it took — `null` until it has taken one. */
  const [sent, setSent] = useState<string | null>(null);
  /** The same fact as `pending`, readable inside the tick a second press lands in. */
  const inFlight = useRef(false);
  const done = useRef<HTMLButtonElement>(null);
  const finishBox = useRef<HTMLDivElement>(null);

  // **The second question is brought to the reader, where the screen is too short to hold both.**
  // Seen in a real window at a phone's size (375×812, 2026-10-11): the picture, the search and
  // two rows of printings fill the scroller, and the finishes are under its fold — so a reader
  // who had just chosen a printing was told "Choose its finish." by a footer with no finish in
  // sight. Only when there is a choice to make: a finish the printing settled needs no looking
  // at. `nearest`, so a dialog tall enough to show them already does not move at all; and the
  // optional call is for jsdom, which has no scrolling to do.
  useEffect(() => {
    if (chosen !== null && finish === null) {
      finishBox.current?.scrollIntoView?.({ block: "nearest" });
    }
  }, [chosen, finish]);

  // A body that unmounts mid-send cannot happen through the shell, which is holding its exits;
  // this is for a host that closes the dialog some other way, so the shell's latch is not left
  // up for the next open.
  useEffect(() => () => onSending(false), [onSending]);

  // The press that sent is gone with the form, and a caret on an unmounted control falls to
  // `<body>`, where the next Tab starts the app's tab order over. Done is the one thing left
  // to press.
  useEffect(() => {
    if (sent !== null) done.current?.focus();
  }, [sent]);

  const choose = (card: CardSummary) => {
    const offered = finishesOf(card);
    setChosen(card);
    setFinish((was) =>
      offered.length === 1
        ? { value: offered[0], by: "printing" }
        : was?.by === "reader" && offered.includes(was.value)
          ? was
          : null,
    );
  };

  // The card first: which finishes there are to choose between depends on it.
  const reason = chosen === null ? CHOOSE_THE_CARD : finish === null ? CHOOSE_ITS_FINISH : null;
  const blocked = reason !== null || pending;

  const send = async () => {
    if (chosen === null || finish === null || inFlight.current) return;
    inFlight.current = true;
    onSending(true);
    setRefusal(null);
    setPending(true);
    try {
      // One argument: the reader's two answers, what the scanner had said, and every frame of
      // the run as it stood at the press.
      const taken = await ipc.scannerSubmit(submissionOf(run, chosen.id, finish.value));
      setSent(taken.id);
    } catch (e) {
      // Drawn in place, with both choices left as they were: the commonest refusals are the
      // inbox's and the network's, and the cure for those is the same press again.
      setRefusal(ipcError(e));
    } finally {
      inFlight.current = false;
      onSending(false);
      setPending(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {sent === null && (
        <>
          {/* The body's own scroller, which the shell leaves to its host. **A block, and not a
              flex column**: a flex item may be shrunk to fit its container, and a scroller's
              children must overflow it instead — the printings' grid is a scroller of its own,
              which is exactly the item a column would squeeze first. */}
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 pt-4 pb-4">
            {/* **The pictures, out of the very text that is sent** — one at a time, resting on
                the last, with the way through all of them under it. `RunPictures` has the box
                and its reasons. */}
            <RunPictures frames={run.frames} />

            <PrintingPicker initialQuery={run.leadName} chosen={chosen} onChoose={choose} />

            <div ref={finishBox}>
              <FinishRadios
                chosen={chosen}
                finish={finish?.value ?? null}
                onFinish={(value) => setFinish({ value, by: "reader" })}
              />
            </div>
          </div>

          {/* **Outside the scroller**, so what is sent and to whom is on screen at the moment of
              the press however far the printings have been scrolled. */}
          <footer className="flex shrink-0 flex-col gap-2 border-t border-border px-5 pt-3 pb-4">
            <p className="text-xs leading-relaxed text-dim">{disclosure(run.frames.length)}</p>

            {refusal !== null && (
              // `alert`, not `status`: mounted only when there is something to say, and
              // announcing on insertion is what the role is for (`OpenShareDialog`).
              <p role="alert" className="text-sm text-destructive">
                {refusal}
              </p>
            )}

            {/* Why Send is out of reach, in words beside it — never a tooltip, which a finger
                cannot open. A line of height whether or not there is a reason in it, so the
                buttons under it do not move as the reader answers. */}
            <p id={`${id}-reason`} className="min-h-4 text-right text-xs text-dim">
              {reason ?? ""}
            </p>

            <div className="flex flex-wrap items-center justify-end gap-2">
              <span className="mr-auto">
                <PrivacyLink />
              </span>
              <button
                type="button"
                // `aria-disabled` on both, never the attribute: a `disabled` button drops the
                // caret to `<body>` the moment it greys, and both of these grey under the
                // reader's own press.
                aria-disabled={pending || undefined}
                onClick={() => {
                  if (!pending) onDismiss();
                }}
                className={cn(PANEL_BUTTON, "border-border", pending && OUT_OF_REACH)}
              >
                {CANCEL}
              </button>
              <button
                type="button"
                aria-disabled={blocked || undefined}
                aria-describedby={reason === null ? undefined : `${id}-reason`}
                onClick={() => void send()}
                className={cn(
                  PANEL_BUTTON,
                  "border-accent/60 text-accent",
                  blocked ? OUT_OF_REACH : "hover:bg-accent/10",
                )}
              >
                {pending ? SENDING : SEND}
              </button>
            </div>
          </footer>
        </>
      )}

      {/* **Mounted from the first render and filled on the answer** — a live region that arrives
          with its words already inside announces nothing, and "Sent" is the one thing here a
          reader who cannot see the dialog change has to be told. Empty, it is no box at all. */}
      <div
        role="status"
        aria-live="polite"
        className={cn(sent !== null && "flex flex-col gap-2 px-5 pt-5 pb-1 text-sm")}
      >
        {sent !== null && (
          <>
            <p className="text-text">{SENT}</p>
            <p className="text-dim">
              {REFERENCE}{" "}
              {/* One press selects the whole of it, and it may break anywhere: it is an id, and
                  a phone's column is narrower than it is long. */}
              <span className="font-mono break-all text-text select-all">{sent}</span>
            </p>
            <p className="text-dim">{KEEP_THE_REFERENCE}</p>
          </>
        )}
      </div>
      {sent !== null && (
        <footer className="flex justify-end px-5 pt-3 pb-4">
          <button
            ref={done}
            type="button"
            onClick={onDismiss}
            className={cn(PANEL_BUTTON, "border-border")}
          >
            {DONE}
          </button>
        </footer>
      )}
    </div>
  );
});

/**
 * *Finish* — the ways the chosen printing was sold, as a radio group.
 *
 * **Only what the printing comes in is offered**, as everywhere a finish is chosen in this app:
 * the engine refuses a finish the printing does not have, and a chip that can only be refused is
 * a question with a wrong answer in it. Before there is a printing, all three are drawn out of
 * reach with a sentence saying what they are waiting for — the group does not appear from nowhere
 * under the reader's press, and the dialog's shape says from the start that there are two things
 * to answer.
 *
 * The chips are the filter row's own (`FilterChips`), which is what the desktop's add-to-collection
 * popup draws a finish with, and they carry the 44px floor for the phone. The keys are
 * `radioGroup.ts`'s: one Tab stop, and the arrows choose.
 */
function FinishRadios({
  chosen,
  finish,
  onFinish,
}: {
  chosen: CardSummary | null;
  finish: Finish | null;
  onFinish: (finish: Finish) => void;
}) {
  const id = useId();
  const waiting = chosen === null;
  const offered = waiting ? FINISHES : finishesOf(chosen);
  const pick = (next: Finish | null) => {
    if (!waiting && next !== null) onFinish(next);
  };
  const note = waiting ? FINISH_NEEDS_CARD : offered.length === 1 ? ONE_FINISH : "";

  return (
    <div className="flex flex-col gap-2">
      <p id={`${id}-label`} className="text-sm font-medium text-text">
        {FINISH}
      </p>
      <div
        role="radiogroup"
        aria-labelledby={`${id}-label`}
        aria-describedby={`${id}-note`}
        aria-disabled={waiting || undefined}
        className="flex flex-wrap gap-1.5"
      >
        {offered.map((one, index) => (
          <button
            key={one}
            type="button"
            role="radio"
            aria-checked={finish === one}
            // Out of reach rather than gone from the tab order, like every greyed chip here.
            aria-disabled={waiting || undefined}
            {...radioKeys<Finish | null>(offered, finish, pick, index)}
            onClick={() => pick(one)}
            className={cn(
              FILTER_CONTROL,
              FILTER_FOCUS,
              "px-3",
              filterChipState(finish === one, waiting),
              // The two responses the state's classes cannot reach — `ToggleChip` carries the
              // same pair for the same reason.
              waiting && "hover:text-dim active:scale-100",
            )}
          >
            {FINISH_LABEL[one]}
          </button>
        ))}
      </div>
      <p id={`${id}-note`} className="min-h-4 text-xs text-dim">
        {note}
      </p>
    </div>
  );
}
