/**
 * A deck's own tags — the reader's free text for one deck, `decks.tags` at user schema v62
 * (issue #834): `No Gamechangers`, `Meme`, `Budget`.
 *
 * **Not a Scryfall tag and not a deck label.** `docs/agent/DOMAIN_VOCABULARY.md` has the whole
 * set; the short version is that a Tagger tag describes a *card* and is fetched, a label is the
 * coloured mark on one card in one deck, and this is a word the reader typed about a whole deck.
 * Nothing here reads a card.
 *
 * **There is no list of tags anywhere but on the decks.** The issue asked for no global system,
 * and the suggestions do not need one: what the field offers is {@link tagsInUse}, read off the
 * `deck_list` answer the gallery already holds. A tag the last deck drops is simply no longer
 * offered, and there is nothing to rename, merge or tidy up behind it.
 *
 * Pure functions and no state, `deckFilter.ts`' arrangement: the field, the tile and the two
 * hosts each call in, and none of them owns a second spelling of "are these the same tag".
 */
import type { DeckRow } from "@/lib/ipc";
import { compareLabels } from "@/lib/options";

/**
 * How long one tag may be typed. The field's `maxLength`, and the only place a limit lives:
 * Rust stores what it is handed, so a longer tag from a peer or an older build still reads and
 * still draws — truncated by the tile like any other long word.
 */
export const MAX_TAG_LENGTH = 40;

/**
 * A typed tag as it will be stored — trimmed, with each inner run of whitespace closed to one
 * space. `""` for a blank.
 *
 * **`deck::clean_tags`' rule for one tag, written here so the field can know what it is about to
 * send** — whether the draft is blank, and whether it repeats a tag already on the deck. Rust
 * applies the same tidy to whatever arrives and its readback is the row, so a disagreement
 * between the two would show as a chip that changed spelling on the way back rather than as
 * anything stored wrong.
 */
export function cleanTag(raw: string): string {
  return raw.trim().split(/\s+/).join(" ");
}

/**
 * What two tags are compared by: capitals folded, nothing else.
 *
 * **`toLowerCase` and not the gallery filter's accent fold**, because this is the question Rust
 * asks when it drops a repeat (`to_lowercase`) and the two have to agree on what a repeat *is* —
 * a field that let `Meme` in beside `meme` would send a list the write then shortens. Locale-free
 * by construction, unlike `toLocaleLowerCase`: `"I".toLowerCase()` is `"i"` on every desktop.
 */
export function tagKey(tag: string): string {
  return tag.toLowerCase();
}

/** Whether the deck already wears this tag, whatever its capitals. */
export function hasTag(tags: readonly string[], tag: string): boolean {
  const key = tagKey(tag);
  return tags.some((t) => tagKey(t) === key);
}

/**
 * The list with one more tag on the end, or `null` when there is nothing to add — a blank, or a
 * tag the deck already wears.
 *
 * `null` rather than the same list back, so a caller cannot write a no-op by forgetting to
 * compare: an Enter on an empty field and an Enter on a repeat are both a press that changes
 * nothing, and neither is a `deck_update`.
 */
export function withTag(tags: readonly string[], raw: string): string[] | null {
  const tag = cleanTag(raw);
  if (tag === "" || hasTag(tags, tag)) return null;
  return [...tags, tag];
}

/** The list without one tag — matched as {@link hasTag} matches, so a chip always removes itself. */
export function withoutTag(tags: readonly string[], tag: string): string[] {
  const key = tagKey(tag);
  return tags.filter((t) => tagKey(t) !== key);
}

/** One tag some deck wears, and how many decks wear it. */
export interface TagInUse {
  tag: string;
  count: number;
}

/**
 * Every tag currently on a deck, once each, with how many decks wear it — the suggestion list.
 *
 * **Archived decks count.** An archived deck is still the reader's and its tags are still words
 * they chose; a reader re-tagging a new build of an old list should be offered the old list's
 * words.
 *
 * **One row per {@link tagKey}, drawn in the spelling most decks use.** Two decks tagged `meme`
 * and `Meme` are one suggestion, and picking it is what brings the stragglers into line over
 * time. A tie goes to whichever spelling sorts first, so the answer does not depend on the order
 * `deck_list` happened to return — which is most-recently-touched first and therefore moves.
 *
 * Alphabetical by the app's one comparison (`compareLabels`), `options.ts`' rule for any list a
 * reader picks from.
 */
export function tagsInUse(decks: readonly Pick<DeckRow, "tags">[]): TagInUse[] {
  const byKey = new Map<string, { count: number; spellings: Map<string, number> }>();
  for (const deck of decks) {
    // Once per deck however the row spells it: Rust never stores a repeat, and a count is of
    // decks, so a peer's row that carried one must not make a tag look twice as popular.
    const seen = new Set<string>();
    for (const tag of deck.tags) {
      const key = tagKey(tag);
      if (seen.has(key)) continue;
      seen.add(key);
      const found = byKey.get(key) ?? { count: 0, spellings: new Map<string, number>() };
      found.count += 1;
      found.spellings.set(tag, (found.spellings.get(tag) ?? 0) + 1);
      byKey.set(key, found);
    }
  }
  const rows = [...byKey.values()].map(({ count, spellings }) => {
    const [tag] = [...spellings.entries()].sort(
      ([a, uses], [b, others]) => others - uses || (a < b ? -1 : a > b ? 1 : 0),
    )[0];
    return { tag, count };
  });
  return rows.sort((a, b) => compareLabels(a.tag, b.tag));
}

/**
 * What to offer under the field: the tags in use that this deck does not already wear and that
 * contain what has been typed so far.
 *
 * **An empty draft offers all of them**, which is the point of the list rather than an edge of
 * it: the reader tagging a second deck `Budget` should see `Budget` the moment the field takes
 * the caret, before deciding how it was spelled last time.
 *
 * A tag that *starts with* the draft is listed before one that merely contains it, each group in
 * the order {@link tagsInUse} gave — so `re` offers `Removal` above `Only removal`.
 */
export function suggestTags(
  inUse: readonly TagInUse[],
  tags: readonly string[],
  draft: string,
): TagInUse[] {
  const needle = tagKey(cleanTag(draft));
  const open = inUse.filter((row) => !hasTag(tags, row.tag));
  if (needle === "") return open;
  const starts: TagInUse[] = [];
  const contains: TagInUse[] = [];
  for (const row of open) {
    const at = tagKey(row.tag).indexOf(needle);
    if (at === 0) starts.push(row);
    else if (at > 0) contains.push(row);
  }
  return [...starts, ...contains];
}
