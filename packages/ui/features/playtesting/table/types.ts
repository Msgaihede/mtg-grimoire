/**
 * The board's own shapes — what the table's pieces hand each other, as distinct from the wire's
 * (`@/lib/ipc`'s `PlaytestView`, `PlaytestSeat` and friends, which the engine answers).
 */
import type { GameCard, GamePlace } from "@/lib/ipc";

/** What the reader is pointing at: the inspect preview's card, and what T / G / E / H act on. */
export interface Pointed {
  card: GameCard;
  /** The ids of the pile it heads; one id off the battlefield. */
  ids: number[];
  place: GamePlace;
  /** The preview's caption: "Old Gnawbone", "3 Forests on the battlefield". */
  line: string;
  /** Where the pointer was when it came onto the card, so the preview can open beside it before
   *  the pointer next moves. */
  at: { x: number; y: number };
}

/**
 * What is behind the table (the game menu's Playmat): the app's own background (`felt`), a felt
 * of one colour, or the commander's art.
 */
export type Playmat = "felt" | "green" | "blue" | "red" | "purple" | "slate" | "commander";

/**
 * A zone opened face up in a dialog: the library's top cards (look, scry, surveil), the whole
 * library (search), or the graveyard or exile to browse. `count` is how many from the top, or
 * `"all"`.
 */
export interface ZoneLook {
  zone: "library" | "graveyard" | "exile";
  mode: "look" | "scry" | "surveil" | "search" | "browse";
  count: number | "all";
}
