import { FILTER_CONTROL, FILTER_FOCUS } from "@/components/FilterChips";
import { TagChips } from "@/features/tags/TagChips";
import { TAG_NAMESPACE_LABEL } from "@/features/tags/namespaces";
import { useTagSearch } from "@/features/tags/useTagSearch";
import { cn } from "@/lib/utils";
import type { TagToken } from "./tagQuery";
import type { CardSearch } from "./useCardSearch";

/**
 * What the tagger syntax in the search box turned into — the tags it found, and the names it
 * could not.
 *
 * **The row exists only when there is something to say.** A permanent strip under the filter bar
 * would spend the deck panel's scarcest axis on a feature most searches never use; drawn only
 * once a tag has been typed, it costs nothing until it is earned.
 *
 * # The unknown half is the reason this is a component and not a chip row
 *
 * A tag name that resolves to nothing empties the wall on purpose — `useCardSearch`'s
 * `tagQueryBlocked` — and Scryfall, which 404s here, has nothing to teach us about saying so.
 * Left silent it is the worst failure this feature could have: a reader who mistypes `o:remov`
 * sees an empty wall and concludes their collection has no removal in it. So the note names the
 * word it could not find and offers the tags that *are* called something like it, from
 * `tag_search` — which substring-matches, deliberately, and is therefore the one command in the
 * app that can find `removal` from `remov`.
 */
export function TagQueryRow({ search }: { search: CardSearch }) {
  const { tagChips, tagNotFound } = search;
  if (tagChips.length === 0 && tagNotFound.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5">
      {tagChips.length > 0 && (
        <TagChips
          selection={{ chips: tagChips, namespace: "both", floor: "any" }}
          ariaLabel="Tags from the search box"
          // Nothing to invite: this row is not drawn at all until a tag is in it, so an empty
          // state here could only ever be a sentence about a row nobody can see.
          emptyMessage={null}
          onRemove={search.removeTagChip}
          onToggleMode={search.toggleTagChipMode}
          // No weight floor. The syntax has no keyword for one — Scryfall has none to borrow —
          // and a control here that the query language cannot express would be a setting the
          // reader could not write down.
        />
      )}
      {tagNotFound.map((token) => (
        // Keyed on the span rather than on the value: two terms can name the same unknown word,
        // and the note under each of them is about that term's own position in the string.
        <UnknownTagNote
          key={`${token.start}-${token.end}`}
          token={token}
          onPick={(value) => search.replaceTagToken(token, value)}
        />
      ))}
    </div>
  );
}

/** How many near misses to offer. Three fits the row at the deck panel's floor and is as many
 *  as a reader scans without it becoming a list to read rather than a nudge. */
const SUGGESTIONS = 3;

/**
 * One name the taxonomy does not have, and the closest things it does.
 *
 * The suggestions come from `useTagSearch`, which is the Tags page's type-ahead: substring
 * matching with the exact hit ranked first. That is exactly the tool for this — the reader has
 * typed something *close* to a tag by definition, or they would not be reading this line — and
 * it is the same hook rather than a second query so a muted tag stays unoffered in both places.
 *
 * `role="status"` because the sentence replaces a wall of cards the reader was expecting: it
 * arrives after the search rather than with it, and a reader who is not looking at this corner
 * of the screen has no other way to learn why the results went away.
 */
function UnknownTagNote({
  token,
  onPick,
}: {
  token: TagToken;
  onPick: (value: string) => void;
}) {
  const { hits } = useTagSearch(token.value, token.namespace);
  const near = hits.slice(0, SUGGESTIONS);
  const namespaceWord = TAG_NAMESPACE_LABEL[token.namespace].toLowerCase();
  return (
    <p role="status" className="flex flex-wrap items-center gap-1.5 text-sm text-dim">
      <span>
        No {namespaceWord} tag called “{token.value}”.
      </span>
      {near.length > 0 && (
        <>
          <span>Did you mean</span>
          {near.map((hit) => (
            <button
              key={hit.slug}
              type="button"
              className={cn(FILTER_CONTROL, FILTER_FOCUS, "h-7 px-2 text-accent")}
              onClick={() => onPick(hit.slug)}
            >
              {hit.label}
            </button>
          ))}
        </>
      )}
    </p>
  );
}
