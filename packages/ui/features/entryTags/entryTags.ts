/**
 * Entry tags — the reader's free-text tags on one **stack**: one `collection_entries` row or one
 * `wishlist_entries` row (issue #1398), every copy in it sharing them.
 *
 * **Not a Scryfall tag and not a deck tag.** `docs/agent/DOMAIN_VOCABULARY.md` has the set; the
 * short version is that a Tagger tag describes a card and is fetched, a deck tag describes a whole
 * deck, and this is a word the reader typed about one row of the binder or the wishlist. The two
 * free-text kinds share their *rules* — `@/features/decks/deckTags`' `tagKey` is what a repeat is
 * on both, because Rust tidies both through `deck::clean_tags` — and never their *lists*: the
 * suggestions here are read off the stacks, the deck tag field's off the decks.
 *
 * Pure functions and no state, `deckTags.ts`' arrangement; `./useEntryTags` is the cache half.
 */
import type { EntryTagUse } from "@/lib/ipc";
import { tagKey, type TagInUse } from "@/features/decks/deckTags";
import { compareLabels } from "@/lib/options";

/**
 * A row's `tags` column as a list — `deck::read_tags`' rule on this side.
 *
 * **Lenient**: text that is not JSON, JSON that is not an array, and a missing value all read as
 * no tags, and an item that is not a string is skipped. The column's `CHECK` asks only for valid
 * JSON and it syncs, so a row a newer peer or a hand-edit wrote may hold anything; such a row
 * still draws and still takes a write, which is where it is tidied. A throw here would take the
 * whole wall down over one odd row.
 */
export function parseEntryTags(json: string | null | undefined): string[] {
  if (json === null || json === undefined) return [];
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return [];
  }
  return Array.isArray(value) ? value.filter((t): t is string => typeof t === "string") : [];
}

/**
 * Every entry tag in use, once per {@link tagKey}, with how many stacks wear it — the suggestion
 * list, in `deckTags.ts`' `tagsInUse` contract so one field draws either.
 *
 * **Rust answers per exact spelling** (`entry_tags_in_use`) and this is where the capitals fold:
 * `Cube` on three rows and `cube` on one are one suggestion counted four, drawn in the spelling
 * more stacks use. A tie goes to whichever spelling sorts first — byte order, the crate's own
 * `ORDER BY` — so the answer does not depend on which of two equal spellings came back first.
 *
 * The counts are summed rather than re-derived per row, which is exact: Rust stores no
 * case-insensitive repeat on a row (`clean_tags`), so no stack is in two spellings' counts. A
 * peer's row that slipped one through would count twice here, and the cost of that is a number
 * one too high on a suggestion.
 *
 * Alphabetical by the app's one comparison (`compareLabels`), `options.ts`' rule for any list a
 * reader picks from.
 */
export function entryTagsInUse(rows: readonly EntryTagUse[]): TagInUse[] {
  const byKey = new Map<string, { count: number; spellings: Map<string, number> }>();
  for (const { tag, count } of rows) {
    const key = tagKey(tag);
    const found = byKey.get(key) ?? { count: 0, spellings: new Map<string, number>() };
    found.count += count;
    found.spellings.set(tag, (found.spellings.get(tag) ?? 0) + count);
    byKey.set(key, found);
  }
  const folded = [...byKey.values()].map(({ count, spellings }) => {
    const [tag] = [...spellings.entries()].sort(
      ([a, uses], [b, others]) => others - uses || (a < b ? -1 : a > b ? 1 : 0),
    )[0];
    return { tag, count };
  });
  return folded.sort((a, b) => compareLabels(a.tag, b.tag));
}
