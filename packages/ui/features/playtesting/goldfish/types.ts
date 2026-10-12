/**
 * The goldfish board's own shapes — what its pieces hand each other, as distinct from the wire's
 * (`@/lib/ipc`'s `GoldfishView` and friends, which the engine answers).
 */
import type { GameCard, GoldfishPlace } from "@/lib/ipc";

/** What the reader is pointing at: the inspect preview's card, and what T / G / E / H act on. */
export interface Pointed {
  card: GameCard;
  /** The ids of the pile it heads; one id off the battlefield. */
  ids: number[];
  place: GoldfishPlace;
  /** The preview's caption: "Old Gnawbone", "3 Forests on the battlefield". */
  line: string;
  /** Which half of the board the pointer is on, so the preview opens over the other. */
  side: "left" | "right";
}

/** What is behind the table: felt, or the commander's art (the game menu's Playmat). */
export type Playmat = "felt" | "commander";

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
