/**
 * The least a draft deck must hold — a module of its own, with nothing imported, because the deck
 * editor's draft bar reads it and must not pull the deal (`setup/deal.ts`, with the booster
 * generator and the importer's parser) into the editor's chunk.
 */

/** Limited's 40. */
export const MIN_DECK_SIZE = 40;

/** A Commander draft's deck: 60 cards, one of them its commander (spec §4a). */
export const COMMANDER_DECK_SIZE = 60;
