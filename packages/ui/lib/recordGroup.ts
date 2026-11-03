/**
 * Where a **multi-select drag off a `dragRecord` wall** keeps the *whole record* of every other
 * picked tile — issue #1501.
 *
 * `dnd.ts`'s `dragGroup` already carries the rest of a picked set, but only as **card** payloads:
 * the shape a deck category and the sidebar's Decks entry read. A wall that draws its tiles through
 * `CardGrid`'s `dragRecord` composes more than a card into each tile's record — the collection's
 * tile writes the copies behind the art (`collectionDrag.ts`), the wishlist's writes the wish
 * (`wishDrag.ts`), a docked search column writes a card nobody owns (`searchCardDrag.ts`) — and
 * none of that survived into the group. So a set of five tiles dragged onto a collection folder
 * arrived as one tile's copies: the folder honoured the tile the drag started on and nothing else,
 * which is the "sometimes works" of the issue (it worked whenever the set was one tile).
 *
 * **Each member is the record the wall would have written for that tile on its own**, so a reader
 * reads a member with the very function it reads the primary with — no second, laxer reader, and
 * no feature module that has to know how another one spells its keys. The primary stays flat
 * beside this key, which is `dnd.ts`'s own design one level up: a target that has never heard of
 * groups goes on answering about the tile that was picked up.
 */

/** The key the members travel under. Not `dnd.ts`'s `dragGroup`: that one holds card payloads
 *  without their mark, and these are whole records with every mark they were composed with. */
const RECORD_GROUP_KEY = "recordGroup";

/**
 * Add the **other** picked tiles' records to an already-composed primary record. An empty `rest`
 * returns `record` untouched, by identity, so an ordinary drag is byte for byte what it was.
 */
export function withRecordGroup(
  record: Record<string, unknown>,
  rest: readonly Record<string, unknown>[],
): Record<string, unknown> {
  return rest.length === 0 ? record : { ...record, [RECORD_GROUP_KEY]: rest };
}

/**
 * The members **other than the primary**, each read through `read` — the caller reads the primary
 * itself, with the same function, and decides what a group of one means.
 *
 * A member `read` refuses is **dropped rather than fatal**, `dnd.ts`'s `readDragGroup` rule and its
 * reason: four readable members of five is still the gesture the reader made, and refusing the four
 * over the fifth is a failure with nothing on screen to say why. A member that is not even an object
 * is dropped the same way — the array comes out of the drag library's untyped store, and a shape
 * that arrives looking right while carrying anything is exactly what this boundary is for.
 */
export function readRecordGroup<T>(
  data: Record<string, unknown>,
  read: (member: Record<string, unknown>) => T | null,
): T[] {
  const group = data[RECORD_GROUP_KEY];
  if (!Array.isArray(group)) return [];
  return group.flatMap((member) => {
    if (typeof member !== "object" || member === null || Array.isArray(member)) return [];
    const one = read(member as Record<string, unknown>);
    return one === null ? [] : [one];
  });
}

/** How many tiles a record carries: the primary and its members. For the drag's count chip, which
 *  must not under-count a group whose primary carries no card payload (an any-printing wish). */
export function recordGroupSize(data: Record<string, unknown>): number {
  const group = data[RECORD_GROUP_KEY];
  return Array.isArray(group) ? group.length + 1 : 1;
}
