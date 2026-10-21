/**
 * The multi-card picker's words and rules, with nothing drawn — a scry's, a surveil's, a discard's,
 * a search's, a cast's (`PlaytestPrompt.pick`, answered by `pickCards`).
 *
 * **The engine sends the bounds, the board keeps to them**: `min` and `max` say how many may be
 * picked, `eligible` which, and `ordered` whether the order is the answer (a scry's or surveil's
 * picked cards stay on top, the first picked on top). Confirm is offered only within the bounds,
 * rather than letting the reader send a set the engine will only refuse. A keep within a total
 * power (`powerCap`, issue #1079) is bounded by the picked creatures' power as well: a creature
 * that would pass the cap is not picked.
 *
 * **An optional cast is asked before it is picked** (issue #1329): "you may cast a spell from
 * your graveyard" is a yes or a no first (`pickOffer`), and only a yes shows the cards.
 */
import type { GamePlace, PlaytestPick } from "@/lib/ipc";

/** "up to 3", "2", "1 to 3". */
function bound(pick: Pick<PlaytestPick, "min" | "max">): string {
  if (pick.min === pick.max) return String(pick.max);
  return pick.min === 0 ? `up to ${pick.max}` : `${pick.min} to ${pick.max}`;
}

/** The picker's title: "Scry 3", "Discard 2", "Choose up to 1 to find". */
export function pickTitle(pick: PlaytestPick): string {
  switch (pick.purpose) {
    case "scry":
      return `Scry ${pick.cards.length}`;
    case "surveil":
      return `Surveil ${pick.cards.length}`;
    case "discard":
      return `Discard ${bound(pick)}`;
    case "search":
      return `Choose ${bound(pick)} to find`;
    case "dig":
      return `Choose ${bound(pick)} to keep`;
    case "reveal":
      return `Choose ${bound(pick)} to reveal`;
    case "targets":
      return `Choose ${bound(pick)} ${pick.max === 1 ? "target" : "targets"}`;
    case "choose":
      return `Choose ${bound(pick)}`;
    case "keep":
      return pick.powerCap === null
        ? `Keep ${bound(pick)}`
        : `Keep total power ${pick.powerCap} or less`;
    case "cast":
      return `Choose ${bound(pick)} to cast`;
  }
}

/** Where an offered cast is from, as its question says it. */
const FROM: Partial<Record<GamePlace, string>> = {
  graveyard: " from your graveyard",
  exile: " from exile",
  hand: " from your hand",
  libraryTop: " from your library",
  command: " from the command zone",
};

/** The question an optional cast asks before its cards are shown, and its two answers. */
export interface PickOffer {
  /** "Cast a spell from your graveyard?" */
  question: string;
  /** Shows the cards: "Choose a card". */
  yes: string;
  /** Picks none, which declines: "Don't cast". */
  no: string;
}

/**
 * The yes-or-no an optional cast is asked as first (issue #1329): a cast the reader may decline
 * — none of its cards need be picked — is asked whether at all before which. `null` for any
 * other pick, and for a cast that must be made.
 */
export function pickOffer(
  pick: Pick<PlaytestPick, "purpose" | "min" | "max" | "zone">,
): PickOffer | null {
  if (pick.purpose !== "cast" || pick.min > 0) return null;
  const one = pick.max === 1;
  const from = pick.zone === null ? "" : (FROM[pick.zone] ?? "");
  return {
    question: `Cast ${one ? "a spell" : "spells"}${from}?`,
    yes: one ? "Choose a card" : "Choose cards",
    no: "Don’t cast",
  };
}

/** The two zones a scry or surveil sorts into; `null` for a picker that is one row. */
export function pickZones(pick: PlaytestPick): { picked: string; rest: string } | null {
  if (pick.purpose === "scry") return { picked: "Keep on top", rest: "Bottom" };
  if (pick.purpose === "surveil") return { picked: "Top", rest: "Graveyard" };
  return null;
}

/** "2 of up to 3", "1 of 2"; under a power cap, "2 kept, power 3 of 4". */
export function pickCounter(pick: PlaytestPick, n: number, power = 0): string {
  if (pick.powerCap !== null) return `${n} kept, power ${power} of ${pick.powerCap}`;
  return `${n} of ${bound(pick)}`;
}

/** The picked cards' power added up, as a total-power keep counts it. */
export function pickedPower(picked: readonly number[], powerOf: (id: number) => number): number {
  return picked.reduce((sum, id) => sum + powerOf(id), 0);
}

/** Whether `n` picked cards of `power` in all is an answer the engine takes. */
export function canConfirm(
  pick: Pick<PlaytestPick, "min" | "max"> & Partial<Pick<PlaytestPick, "powerCap">>,
  n: number,
  power = 0,
): boolean {
  const cap = pick.powerCap ?? null;
  return n >= pick.min && n <= pick.max && (cap === null || power <= cap);
}

/** The confirm button's words for `n` picked: "Discard 2", "Find 1", "Done". */
export function confirmLabel(pick: PlaytestPick, n: number): string {
  switch (pick.purpose) {
    case "scry":
    case "surveil":
      return "Done";
    case "discard":
      return `Discard ${n}`;
    case "search":
      return n === 0 ? "Find nothing" : `Find ${n}`;
    case "dig":
      return `Keep ${n}`;
    case "reveal":
      return `Reveal ${n}`;
    case "targets":
      return n === 1 ? "Target it" : `Target ${n}`;
    case "choose":
      return `Choose ${n}`;
    case "keep":
      return n === 0 ? "Sacrifice all" : `Keep ${n}`;
    case "cast":
      return n === 0 ? "Cast nothing" : n === 1 ? "Cast it" : `Cast ${n}`;
  }
}

/** Whether an eligible card can be added to `picked` without passing `max` or the power cap. */
export function hasRoom(
  picked: readonly number[],
  id: number,
  pick: PlaytestPick,
  powerOf: (id: number) => number = () => 0,
): boolean {
  if (picked.length >= pick.max) return false;
  return pick.powerCap === null || pickedPower(picked, powerOf) + powerOf(id) <= pick.powerCap;
}

/**
 * A card clicked: picked cards are put back, an eligible one is picked (last in order) while
 * there is room under `max` and the power cap, and anything else is left as it was.
 */
export function togglePick(
  picked: readonly number[],
  id: number,
  pick: PlaytestPick,
  powerOf: (id: number) => number = () => 0,
): number[] {
  if (picked.includes(id)) return picked.filter((p) => p !== id);
  if (!pick.eligible.includes(id) || !hasRoom(picked, id, pick, powerOf)) return [...picked];
  return [...picked, id];
}
