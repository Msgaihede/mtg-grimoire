/**
 * A list becoming a deck of its own.
 *
 * **No planner of its own**, deliberately: `buildImportPlan` beside this is the app's one set of
 * deck decisions and a second copy filed by a second rule would be the same list landing in
 * different piles depending on which door it came through. What differs is the *commit* — a
 * `deck_create` before it, and a rollback if the commit is refused — and that lives in
 * `useImport`, where the write that invalidates `["decks"]` is.
 */
import type { ImportDestination } from "../destination";
import { NewDeckPreview } from "./NewDeckPreview";

/**
 * The new deck as a destination.
 *
 * **A value rather than a factory**, unlike `deckDestination` one file along, and the difference
 * is which extra props are required: this preview's two are both optional — a host with no
 * remembered format and nowhere to go afterwards passes neither — so the bare descriptor is a
 * thing that really works when it is mounted. A host that has answers spreads this and overrides
 * `Preview` with a wrapper closing over them; see `DecksPage`.
 */
export const newDeckDestination: ImportDestination = {
  key: "newDeck",
  label: "a new deck",
  Preview: NewDeckPreview,
};
