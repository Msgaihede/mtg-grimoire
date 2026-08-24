/**
 * The labels a pasted list carries, and which of them the reader wants.
 *
 * Archidekt writes one per card as `^Keeper,#4aab08^`; `parse.ts` reads it, `destinations/deck.ts`
 * folds the distinct ones onto {@link ImportPlan.tags}, and this is where the reader says yes or
 * no to each. **All ticked**, because a list that carries labels is a list somebody labelled on
 * purpose — the box exists for the one they have finished with, not as a decision they have to
 * make before every import.
 *
 * **It draws the tag the import would actually use, which is not always the one in the file.** A
 * name this app already knows is *used*, not remade: the row keeps the reader's capitals and the
 * reader's colour, and the file's colour is discarded. So the swatch and the word here come off
 * `deck_tag_all` whenever that read has answered and matched, and off the file only for a label
 * this app has never heard of. Drawing the file's green `Keeper` over a reader's purple one would
 * be a preview of an import that is not going to happen.
 *
 * Shared by both deck destinations. The collection and the wishlist have no label column and draw
 * nothing — `deck_cards.tag_id` is the only home a tag has.
 */
import { useId, useMemo, useState, type JSX } from "react";
import { useQuery } from "@tanstack/react-query";
import { plural } from "@/lib/counts";
import { ipc, type GlobalTag } from "@/lib/ipc";
import { findTagByName } from "@/features/decks/tagNames";
import { TagSwatch } from "@/features/decks/TagColorPicker";
import type { PlannedTag } from "../destinations/deck";

/** Stable identity for "nothing unticked", so the memo below is not recomputed over a new empty
 *  set on every render. */
const NONE_DROPPED: ReadonlySet<string> = new Set<string>();

/** No tag list yet — a stable empty array, for `NONE_DROPPED`'s reason. */
const NO_TAGS: readonly GlobalTag[] = [];

/**
 * Which labels are coming across, held as the ones that are **not**.
 *
 * **The unticked set rather than the ticked one, and that is the whole of why this needs no
 * effect.** "All ticked by default" as a `useState(new Set(every key))` is state derived from a
 * prop: the moment the plan changes — a different paste, a Back and a second Preview — the seed is
 * stale and the only repair is a `setState` inside an effect, which this repo's lint refuses and
 * which would flash the wrong tally for a frame either way. Holding the *exclusions* makes the
 * default the empty set, which is correct for every plan without being about any of them.
 *
 * A key unticked on one paste and absent from the next is harmless: `chosen` is built by filtering
 * the plan's own list, so a stale exclusion narrows nothing.
 */
export function useTagChoice(tags: readonly PlannedTag[]): {
  dropped: ReadonlySet<string>;
  chosen: ReadonlySet<string>;
  toggle: (key: string) => void;
} {
  const [dropped, setDropped] = useState<ReadonlySet<string>>(NONE_DROPPED);
  const chosen = useMemo(
    () => new Set(tags.filter((tag) => !dropped.has(tag.key)).map((tag) => tag.key)),
    [tags, dropped],
  );
  const toggle = (key: string) =>
    setDropped((held) => {
      const next = new Set(held);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  return { dropped, chosen, toggle };
}

/**
 * Every tag there is, for the one question this step asks of it: does this name already exist.
 *
 * **The same `["decks", "tagsAll"]` key `useDeckMeta` uses**, so with a deck editor open behind
 * the dialog this costs no round trip at all — TanStack shares a query's cache between observers.
 * Ungated where that hook gates on a deck id, because the new-deck destination has no deck and
 * asks the same question; `enabled` is the list itself, so a paste carrying no labels makes no
 * call.
 *
 * **A refused read is not a refused import**, exactly as `useImport`'s Oracle-tag read is not: an
 * empty answer draws every label as new, which is the honest thing to say when nothing is known
 * about what exists — and `commit_import` finds-or-creates regardless, so the write is right even
 * when the preview was pessimistic.
 */
function useAllTags(enabled: boolean): readonly GlobalTag[] {
  const query = useQuery({
    queryKey: ["decks", "tagsAll"],
    queryFn: () => ipc.deckTagAll(),
    enabled,
  });
  return query.data ?? NO_TAGS;
}

/**
 * The picker.
 *
 * Draws nothing at all when the list carries no labels, which is every format but Archidekt's —
 * the same rule `Tally`, `Commander` and `OwnCopies` follow, and the reason an ordinary paste sees
 * no new control.
 */
export function ImportTags({
  tags,
  dropped,
  onToggle,
}: {
  tags: readonly PlannedTag[];
  dropped: ReadonlySet<string>;
  onToggle: (key: string) => void;
}): JSX.Element | null {
  const id = useId();
  const existing = useAllTags(tags.length > 0);
  if (tags.length === 0) return null;
  const kept = tags.filter((tag) => !dropped.has(tag.key)).length;
  return (
    <section aria-labelledby={`${id}-heading`} className="space-y-1.5">
      <h3 id={`${id}-heading`} className="text-xs text-dim">
        Tags
      </h3>
      <p className="text-[0.6875rem] text-dim">
        {/* The sentence says what the ticks currently mean rather than what they could mean: a
            reader who has unticked two is owed the number that is coming, and a reader who has
            touched nothing reads the same clause with every label in it. */}
        This list carries {plural(tags.length, "tag")}. {sentenceFor(tags.length, kept)} A tag you
        already have is used as it is — its colour here is yours, not the file’s.
      </p>
      <ul className="divide-y divide-border rounded-md border border-border">
        {tags.map((tag) => {
          // `findTagByName` is `tagNameKey`'s comparison, which is `deck_tags.name_key`'s — so
          // this matches exactly what `commit_import` will match, and the row drawn is the row
          // used.
          const mine = findTagByName(existing, tag.name);
          return (
            <li key={tag.key} className="flex items-center gap-2 px-3 py-1.5">
              <input
                id={`${id}-${tag.key}`}
                type="checkbox"
                checked={!dropped.has(tag.key)}
                onChange={() => onToggle(tag.key)}
                aria-describedby={`${id}-${tag.key}-note`}
                className="accent-accent"
              />
              <TagSwatch color={mine?.color ?? tag.color} />
              {/* The label element carries the name and nothing else, so the checkbox's
                  accessible name is the name — a count and a note inside it would compute to
                  "Keeper new tag 28" and no test could ask for the row by what it is called. */}
              <label htmlFor={`${id}-${tag.key}`} className="min-w-0 flex-1 truncate text-sm">
                {mine?.name ?? tag.name}
              </label>
              <span id={`${id}-${tag.key}-note`} className="shrink-0 text-[0.6875rem] text-dim">
                {mine === undefined ? "new tag" : "already yours"}
              </span>
              <span className="shrink-0 font-mono text-xs tabular-nums text-dim">{tag.copies}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** What the ticks add up to, in the one clause that is true of them. Exported for its test: three
 *  arms over two numbers is exactly the shape that goes wrong at the edges. */
export function sentenceFor(total: number, kept: number): string {
  if (kept === 0) return "None of them will be brought across.";
  if (kept === total) return `${total === 1 ? "It" : "They"} will be brought across.`;
  return `${kept} of them will be brought across.`;
}
