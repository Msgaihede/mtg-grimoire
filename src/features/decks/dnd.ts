import type { DeckZone } from "@/lib/ipc";

/**
 * What a drag is carrying, and the only shape a drop target here will act on.
 *
 * Two kinds, because there are two things a drop can mean: a printing that is not in the deck
 * yet (`deck_add_card`, which folds into whatever the zone already holds) and a row that is
 * (`deck_move_card`, which takes every copy with it). A target reads the kind rather than
 * guessing from what is on screen, so the search panel and a zone column can never be
 * mistaken for each other.
 *
 * Every drag has a click path from Tasks 12–13 — the panel's Add button, the row menu's "Move
 * to", the stepper down to zero. This is speed, not capability.
 */
export type DragPayload =
  | { kind: "search-card"; cardId: string; name: string }
  | { kind: "deck-card"; cardId: string; name: string; fromZone: DeckZone };

/** Where a payload was let go: one of the deck's zones, or the tray that takes cards out. */
export type DropTarget = { kind: "zone"; zone: DeckZone } | { kind: "remove" };

/**
 * The write a drop means — named for the command it becomes, and carrying nothing the editor
 * does not already need to send.
 *
 * Addressed by the slot (`cardId` + zone) rather than by `deck_cards.id`, like every other
 * write in this feature: a stale row id is the difference between emptying the slot the
 * reader dropped and emptying one that has since been refilled.
 */
export type DeckWrite =
  | { write: "add"; cardId: string; zone: DeckZone }
  | { write: "move"; cardId: string; from: DeckZone; to: DeckZone }
  | { write: "remove"; cardId: string; zone: DeckZone };

/**
 * The mark that says a payload is a deck drag's, and its key.
 *
 * A drop target is handed whatever the drag is carrying, and the type it is handed is
 * `Record<string, unknown>` — the library's store is untyped by construction, because every
 * `draggable` in a window writes into it. A drag from *outside* the window cannot reach
 * these targets at all (a file or a selection from another app arrives through the library's
 * separate external adapter, whose drop targets are registered separately and are not these),
 * so this is not a fence against the desktop. It is a fence against **this app's own next
 * draggable**: the moment a second feature drags something, `{ kind, cardId, name }` from it
 * would otherwise be a card these zones would add.
 */
const MARK = "mtg-collection/deck-drag";
const MARK_KEY = "dragSource";

/**
 * Every zone, as a value rather than as a type.
 *
 * A `Record<DeckZone, true>` is exhaustive by the type checker: a sixth zone in the union
 * fails this line rather than silently making `readDragData` refuse the new one. Written here
 * rather than read off `ZONE_LABEL` because `ZoneColumn` imports *this* module, and a cycle
 * between the drag contract and the component that draws it is a cycle for no gain.
 */
const ZONES: Record<DeckZone, true> = {
  main: true,
  side: true,
  commander: true,
  companion: true,
  maybe: true,
};

function isZone(value: unknown): value is DeckZone {
  // The *value* is what is asked for, not the key: `"toString" in ZONES` is true, and a drag
  // claiming to come from the `toString` zone would then be handed to `deck_move_card`.
  // Nothing on `Object.prototype` is `true`, so this asks about own entries without needing
  // `Object.hasOwn` (ES2022; this project compiles to ES2020).
  return typeof value === "string" && (ZONES as Record<string, true | undefined>)[value] === true;
}

/** A name is allowed to be empty — a row denormalizes whatever `cards` had — but an id is
 *  not: an empty `cardId` addresses every row and no row. */
function isId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** What a draggable hands the adapter. Flat, so `canDrop` can read the kind without
 *  unwrapping anything. */
export function dragData(payload: DragPayload): Record<string, unknown> {
  return { [MARK_KEY]: MARK, ...payload };
}

/**
 * The payload a drop target may act on, or `null` for everything else.
 *
 * Field by field rather than a cast: this is the app's boundary with the drag library's own
 * store, and the one place where "it type-checked" means nothing at all.
 */
export function readDragData(data: Record<string, unknown>): DragPayload | null {
  if (data[MARK_KEY] !== MARK) return null;
  const { kind, cardId, name, fromZone } = data;
  if (!isId(cardId) || typeof name !== "string") return null;
  if (kind === "search-card") return { kind, cardId, name };
  if (kind === "deck-card" && isZone(fromZone)) return { kind, cardId, name, fromZone };
  return null;
}

/**
 * What a drop should write, or `null` when it should write nothing.
 *
 * One rule, asked twice: a target asks it in `canDrop` — so a drop that would mean nothing
 * never lights up and never accepts the card — and asks it again on the drop itself, because
 * the two questions can be a second apart and only the second one writes.
 */
export function dropWrite(payload: DragPayload, target: DropTarget): DeckWrite | null {
  if (target.kind === "remove") {
    // Nothing to remove: a search result is a printing in the database, not a row in this
    // deck. The tray is only drawn for a deck-card drag for the same reason.
    if (payload.kind !== "deck-card") return null;
    return { write: "remove", cardId: payload.cardId, zone: payload.fromZone };
  }
  if (payload.kind === "search-card") {
    // One copy, exactly as the panel's Add button sends — and `deck_add_card` folds, so
    // dropping the same card twice is two copies rather than a refusal.
    return { write: "add", cardId: payload.cardId, zone: target.zone };
  }
  // Back where it came from is not a move: it would touch the deck, reallocate and bump
  // `updated_at` to leave the list exactly as it was.
  if (payload.fromZone === target.zone) return null;
  return { write: "move", cardId: payload.cardId, from: payload.fromZone, to: target.zone };
}
