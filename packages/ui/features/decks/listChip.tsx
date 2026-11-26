/**
 * The words of a theory deck's `THEORY | ACTUAL` chip, shared by the desktop tile and the phone
 * gallery's: the word for the list the tile shows ({@link tileList}) in bold.
 *
 * **The chip does not change size when it flips.** Bold type is wider than regular, so each word
 * is laid in a one-cell grid over an invisible bold copy of itself: the cell is always the bold
 * word's width, and only the ink changes.
 */
import type { DeckVariant } from "@/lib/ipc";
import { cn } from "@/lib/utils";

export function ListWords({ showing }: { showing: DeckVariant }) {
  return (
    <>
      <ListWord word="THEORY" active={showing === "theory"} />
      {" | "}
      <ListWord word="ACTUAL" active={showing === "live"} />
    </>
  );
}

function ListWord({ word, active }: { word: string; active: boolean }) {
  return (
    <span className="inline-grid">
      <span className={cn("col-start-1 row-start-1", active && "font-bold")}>{word}</span>
      <span aria-hidden="true" className="invisible col-start-1 row-start-1 font-bold">
        {word}
      </span>
    </span>
  );
}

/** What the chip says to a screen reader: which list is showing, and — as a button — what the
 *  press does. `aria-pressed` is not used: the two states are two lists, not on and off. */
export function listChipLabel(showing: DeckVariant, pressable: boolean): string {
  const now = showing === "theory" ? "Showing the theory list" : "Showing the actual list";
  if (!pressable) return now;
  return `${now}. Show the ${showing === "theory" ? "actual" : "theory"} list`;
}

/** The list the chip turns a tile to. */
export function otherList(showing: DeckVariant): DeckVariant {
  return showing === "theory" ? "live" : "theory";
}
