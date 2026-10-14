import { memo, useEffect, useId, useRef, useState, type JSX } from "react";
import { Dialog } from "@/components/Dialog";
import { PANEL_BUTTON } from "@/features/settings/controls";
import type { Finish } from "@/lib/finish";
import type { CardSummary } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { finishesOf, FinishRadios } from "../submit/FinishRadios";
import { PrintingPicker } from "../submit/PrintingPicker";
import { CANCEL, CHOOSE_ITS_FINISH } from "../submit/submitText";
import type { ScannerFinishPref } from "../types";
import type { PickedPrinting } from "./tray";

export const ADD_CARD_TITLE = "Add a card";
export const ADD_CARD_LABEL = "Add card…";
export const ADD_CARD_QUESTION = "Which card do you want to add?";
export const ADD_TO_TRAY = "Add to tray";
/** Why Add will not add yet — the printing first, because the finishes offered depend on it. */
export const CHOOSE_A_PRINTING = "Choose a printing.";
export const SCANNER_PAUSED = "Scanning is paused while this is open.";

export interface AddCardDialogProps {
  open: boolean;
  /**
   * The Defaults popover's finish. A fixed one is chosen for the reader wherever the picked
   * printing comes in it — the same "this pile is all one finish" a scan lands under; `detect`
   * chooses nothing a printing does not settle by itself.
   */
  finishPref: ScannerFinishPref;
  /** The reader's printing and finish, for the tray. The dialog closes itself after. */
  onAdd: (picked: PickedPrinting, finish: Finish) => void;
  /** Escape, the ✕, Cancel and an Add: hand the caret back to the press that opened this. */
  onDismiss: () => void;
  /** The scrim: close without moving the caret. */
  onClose: () => void;
}

/**
 * *Add a card…* — a card the camera will not read, searched for by name and put in the tray by
 * hand (issue #978).
 *
 * **Two questions, the same two *Send scan…* asks**: which printing (`PrintingPicker`, the whole
 * card per tile, so the frame and the collector line tell printings apart), and which finish
 * (`FinishRadios`, only what the printing was sold in). The answer is a tray row like any scan's —
 * it bumps the newest row by the same rule, it is filed by the same Add, and the page lands it
 * with the same marks.
 *
 * **The page pauses the scanner while this is open** (the page's `picking`, in `useScanLoop`'s
 * `live`): a reader turned to the keyboard is not holding a card still, and a card scanned behind
 * the dialog would land in a tray they cannot see. The footer says so, because the picture behind
 * the scrim is still moving.
 *
 * Both Scanner surfaces mount this one component, beside their other dialogs and never inside a
 * container-query box — a container is the containing block for the shell's fixed scrim.
 */
export function AddCardDialog({
  open,
  finishPref,
  onAdd,
  onDismiss,
  onClose,
}: AddCardDialogProps): JSX.Element {
  return (
    <Dialog
      open={open}
      title={ADD_CARD_TITLE}
      closeLabel="Close"
      // *Send scan…*'s width, for its reason: four columns of whole cards, each wide enough for a
      // collector line to be read.
      size="w-[36rem]"
      onDismiss={onDismiss}
      onClose={onClose}
    >
      {open && <Body finishPref={finishPref} onAdd={onAdd} onDismiss={onDismiss} />}
    </Dialog>
  );
}

/** A finish, and whose choice it was — `SubmitScanDialog`'s, plus the Defaults' own. */
type FinishChoice = { value: Finish; by: "reader" | "printing" | "default" };

/**
 * The finish a newly chosen printing opens with. A printing sold one way settles it; a finish the
 * reader pressed is kept where the new printing comes in it; then the Defaults' fixed finish, on
 * the same condition. Anything else is asked — never guessed.
 */
function finishFor(
  card: CardSummary,
  was: FinishChoice | null,
  pref: ScannerFinishPref,
): FinishChoice | null {
  const offered = finishesOf(card);
  if (offered.length === 1) return { value: offered[0], by: "printing" };
  if (was?.by === "reader" && offered.includes(was.value)) return was;
  if (pref !== "detect" && offered.includes(pref)) return { value: pref, by: "default" };
  return null;
}

/**
 * The dialog's contents, mounted only while it is open, so every open starts with nothing chosen.
 * Memoised because the page re-renders on its own clock; the props are a stored word and two
 * functions the page keeps stable enough for a picker that holds two hundred pictures.
 */
const Body = memo(function Body({
  finishPref,
  onAdd,
  onDismiss,
}: {
  finishPref: ScannerFinishPref;
  onAdd: AddCardDialogProps["onAdd"];
  onDismiss: () => void;
}) {
  const id = useId();
  const [chosen, setChosen] = useState<CardSummary | null>(null);
  const [finish, setFinish] = useState<FinishChoice | null>(null);
  const finishBox = useRef<HTMLDivElement>(null);

  // The finishes brought into view once there is one to choose — `SubmitScanDialog`'s reason: on
  // a phone the printings fill the scroller and the second question is under its fold.
  useEffect(() => {
    if (chosen !== null && finish === null) {
      finishBox.current?.scrollIntoView?.({ block: "nearest" });
    }
  }, [chosen, finish]);

  const choose = (card: CardSummary) => {
    setChosen(card);
    setFinish((was) => finishFor(card, was, finishPref));
  };

  const reason = chosen === null ? CHOOSE_A_PRINTING : finish === null ? CHOOSE_ITS_FINISH : null;

  const add = () => {
    if (chosen === null || finish === null) return;
    onAdd(
      {
        cardId: chosen.id,
        oracleId: chosen.oracleId,
        name: chosen.name,
        setCode: chosen.setCode,
        collectorNumber: chosen.collectorNumber,
      },
      finish.value,
    );
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* A block, not a flex column — the printings' grid is a scroller of its own, and a column
          would squeeze it first (`SubmitScanDialog`). */}
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 pt-4 pb-4">
        <PrintingPicker
          initialQuery=""
          label={ADD_CARD_QUESTION}
          chosen={chosen}
          onChoose={choose}
        />
        <div ref={finishBox}>
          <FinishRadios
            chosen={chosen}
            finish={finish?.value ?? null}
            onFinish={(value) => setFinish({ value, by: "reader" })}
          />
        </div>
      </div>

      <footer className="flex shrink-0 flex-col gap-2 border-t border-border px-5 pt-3 pb-4">
        {/* Why Add is out of reach, in words beside it — a finger cannot open a tooltip. A line of
            height whatever it holds, so the buttons do not move as the reader answers. */}
        <p id={`${id}-reason`} className="min-h-4 text-right text-xs text-dim">
          {reason ?? ""}
        </p>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <p className="mr-auto text-xs text-dim">{SCANNER_PAUSED}</p>
          <button type="button" onClick={onDismiss} className={cn(PANEL_BUTTON, "border-border")}>
            {CANCEL}
          </button>
          <button
            type="button"
            // `aria-disabled`, never the attribute: a `disabled` button drops the caret to
            // `<body>` the moment it greys.
            aria-disabled={reason !== null || undefined}
            aria-describedby={reason === null ? undefined : `${id}-reason`}
            onClick={add}
            className={cn(
              PANEL_BUTTON,
              "border-accent/60 text-accent",
              reason !== null
                ? "cursor-not-allowed opacity-50 active:scale-100"
                : "hover:bg-accent/10",
            )}
          >
            {ADD_TO_TRAY}
          </button>
        </div>
      </footer>
    </div>
  );
});
