/**
 * The multi-card picker's words and rules, with nothing drawn — a scry's, a surveil's, a discard's,
 * a search's, a sacrifice's, a cast's, an order's, a cost's, a separation into piles'
 * (`PlaytestPrompt.pick`, answered by `pickCards`).
 *
 * **The engine sends the bounds, the board keeps to them**: `min` and `max` say how many may be
 * picked, `eligible` which, and `ordered` whether the order is the answer (a scry's or surveil's
 * picked cards stay on top, the first picked on top; an order's every card is picked, in the
 * order it goes, and a split order's first `split` picked go on top, the rest on the bottom).
 * A separation into piles (Fact or Fiction) picks pile A; the cards left are pile B. Confirm
 * is offered only within the bounds, rather than letting the reader send a set the engine will
 * only refuse. A keep within a total
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
    case "sacrifice":
      return `Sacrifice ${bound(pick)}`;
    case "cast":
      return `Choose ${bound(pick)} to cast`;
    case "order": {
      const top = splitOf(pick);
      if (top === null) return "Put on the bottom in order";
      return top >= pick.cards.length
        ? "Put them on top in order"
        : `Put ${top} on top and the rest on the bottom`;
    }
    case "pay":
      return `Choose ${bound(pick)} to pay the cost`;
    case "pile":
      return "Separate into two piles: picked cards are pile A";
    case "outside":
      return `Choose ${bound(pick)} from outside the game`;
  }
}

/** How many of an `order` pick go on top (Telling Time), or `null` for one place alone. */
function splitOf(pick: Pick<PlaytestPick, "purpose" | "split">): number | null {
  return pick.purpose === "order" && pick.split !== null && pick.split > 0 ? pick.split : null;
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

/** The two zones a scry, a surveil or a separation into piles sorts into; `null` for a picker
 *  that is one row. */
export function pickZones(pick: PlaytestPick): { picked: string; rest: string } | null {
  if (pick.purpose === "scry") return { picked: "Keep on top", rest: "Bottom" };
  if (pick.purpose === "surveil") return { picked: "Top", rest: "Graveyard" };
  if (pick.purpose === "pile") return { picked: "Pile A", rest: "Pile B" };
  return null;
}

/** One row of a sorting picker: its heading, the cards in it in order, and what an empty one
 *  says. */
export interface PickRow {
  label: string;
  ids: number[];
  empty: string;
}

/**
 * The rows a sorting picker lays its cards in, given the cards `picked` so far: a scry's, a
 * surveil's or a pile's two (the picked ones in the order picked, then the rest), and a split
 * order's three — the first `split` picked on top, the picked after them on the bottom, and the
 * cards not yet placed. `null` for a picker that is one row.
 */
export function pickRows(pick: PlaytestPick, picked: readonly number[]): PickRow[] | null {
  const rest = pick.cards.map((c) => c.id).filter((id) => !picked.includes(id));
  const top = splitOf(pick);
  if (top !== null)
    return [
      {
        label: "On top",
        ids: picked.slice(0, top),
        empty: "Click a card to put it on top. The first click is the top card.",
      },
      {
        label: "On the bottom",
        ids: picked.slice(top),
        empty: `Once ${top} ${top === 1 ? "is" : "are"} on top, the next cards clicked go on the bottom.`,
      },
      { label: "To place", ids: rest, empty: "Every card is placed." },
    ];
  const zones = pickZones(pick);
  if (zones === null) return null;
  const pile = pick.purpose === "pile";
  return [
    {
      label: zones.picked,
      ids: [...picked],
      empty: pile
        ? "Click a card to put it in pile A."
        : "Click a card to keep it here. The first click goes on top.",
    },
    {
      label: zones.rest,
      ids: rest,
      empty: pile ? "Every card is in pile A." : "Every card stays on top.",
    },
  ];
}

/**
 * Where the card picked `at` (from 0) goes, for its badge and its name: its place in order
 * (`1`), and in a split order its place on top or on the bottom (`top 1`, `bottom 2`). `null`
 * for a pick whose order is not the answer.
 */
export function pickPosition(
  pick: PlaytestPick,
  at: number,
): { badge: number; words: string } | null {
  if (!pick.ordered || at < 0) return null;
  const top = splitOf(pick);
  if (top === null) return { badge: at + 1, words: String(at + 1) };
  return at < top
    ? { badge: at + 1, words: `top ${at + 1}` }
    : { badge: at - top + 1, words: `bottom ${at - top + 1}` };
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
    case "sacrifice":
      return `Sacrifice ${n}`;
    case "cast":
      return n === 0 ? "Cast nothing" : n === 1 ? "Cast it" : `Cast ${n}`;
    case "order":
      return "Done";
    case "pay":
      return "Pay";
    case "pile":
      return "Make piles";
    case "outside":
      return n === 0 ? "Take nothing" : `Take ${n}`;
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
