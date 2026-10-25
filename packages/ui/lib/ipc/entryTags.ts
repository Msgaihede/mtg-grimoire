/**
 * Entry tags: the reader's free-text tags on one stack — one `collection_entries` row or one
 * `wishlist_entries` row, every copy in it sharing them (issue #1398).
 *
 * **Not a Scryfall tag and not a deck tag.** `docs/agent/DOMAIN_VOCABULARY.md` has the set: a
 * Tagger tag describes a card and is fetched, a deck tag (`decks.tags`) describes a whole deck,
 * and these are words the reader typed about one row of the binder or the wishlist. The two
 * free-text kinds are kept apart on purpose — the suggestions a stack's field offers are read
 * off the stacks ({@link entryTagCommands.entryTagsInUse}), never off the decks.
 *
 * **One domain of `../ipc.ts`, and one Rust module's worth**: `crates/grimoire-core/src/entry_tags.rs`
 * holds both tables' writes and the one read across them, so the two setters live here rather
 * than one each in `./collection.ts` and `./wishlist.ts`. Nothing outside `packages/ui/lib/ipc*`
 * imports this file — `@/lib/ipc` re-exports its type and spreads `entryTagCommands` into `ipc`.
 */
import { invoke } from "./invoke";

/**
 * One spelling of an entry tag and how many stacks wear it — collection rows and wishes summed
 * (`entry_tags::EntryTagUse`).
 *
 * **Per exact spelling, not per tag**: `Cube` on one row and `cube` on another are two of these.
 * Rust supplies the fact and this side draws the conclusion — `entryTagsInUse` in
 * `@/features/entryTags/entryTags` folds the capitals, the same `tagKey` the deck tags fold by.
 */
export interface EntryTagUse {
  tag: string;
  count: number;
}

/** The entry tag commands — spread into `ipc` by `../ipc.ts`, which is the only reader of this object. */
export const entryTagCommands = {
  /**
   * Replace one collection row's tags with `tags`, whole — an empty list clears them. Answers
   * the list as stored, tidied by `deck::clean_tags`' rule (trimmed, inner whitespace closed,
   * blanks and case-insensitive repeats dropped, the first spelling and the reader's order kept),
   * so a caller draws the answer rather than what it sent. A row that is gone is refused in words.
   *
   * **The whole list, never a union**: `collection_update`'s `patch.tags` and the importer's
   * extras are the paths that merge, and an editor that removed a chip through one of those would
   * see it come back.
   */
  collectionSetTags: (id: number, tags: string[]) =>
    invoke<string[]>("collection_set_tags", { id, tags }),
  /** {@link entryTagCommands.collectionSetTags} one table over: one wish's tags, whole. */
  wishlistSetTags: (id: number, tags: string[]) =>
    invoke<string[]>("wishlist_set_tags", { id, tags }),
  /**
   * Every entry tag spelling across the collection and the wishlist, with how many rows wear it,
   * sorted by tag — the suggestion list's raw material. Takes no arguments: an object sent to a
   * command that declares only its managed state is a deserialisation error, not a type error.
   */
  entryTagsInUse: () => invoke<EntryTagUse[]>("entry_tags_in_use"),
};
