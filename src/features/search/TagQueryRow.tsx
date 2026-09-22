import { X } from "lucide-react";
import { FILTER_CONTROL, FILTER_FOCUS } from "@/components/FilterChips";
import { TagChips } from "@/features/tags/TagChips";
import { TAG_NAMESPACE_LABEL } from "@/features/tags/namespaces";
import { useTagSearch } from "@/features/tags/useTagSearch";
import { FOCUS_INSET } from "@/lib/focus";
import { PRESS } from "@/lib/motion";
import { cn } from "@/lib/utils";
import type { TagChip } from "@/features/tags/tagFilters";
import type { TagNamespace } from "@/lib/ipc";
import type { TagToken } from "./queryLanguage";
import type { PredicateChip } from "./useCardSearch";

/**
 * What the query syntax in the search box turned into — the typed terms, the tags it found, and
 * the names it could not.
 *
 * **The predicates come first and they never wait for anything.** A tag name has to be resolved
 * against a taxonomy before it can be drawn, so a tag chip arrives a round trip late and may
 * never arrive at all; `cmc>=3` is settled the moment it parses. Putting the settled row above
 * the one that can still change keeps a chip from appearing *above* chips already on screen and
 * shoving them down a line.
 *
 * **The row exists only when there is something to say.** A permanent strip under the filter bar
 * would spend the deck panel's scarcest axis on a feature most searches never use; drawn only
 * once a tag has been typed, it costs nothing until it is earned.
 *
 * # The unknown half is the reason this is a component and not a chip row
 *
 * A tag name that resolves to nothing empties the wall on purpose — `useCardSearch`'s
 * `tagQueryBlocked` — and Scryfall, which 404s here, has nothing to teach us about saying so.
 * Left silent it is the worst failure this feature could have: a reader who mistypes
 * `otag:remov` sees an empty wall and concludes their collection has no removal in it. So the
 * note names the word it could not find and offers the tags that *are* called something like
 * it, from `tag_search` — which substring-matches, deliberately, and is therefore the one
 * command in the app that can find `removal` from `remov`.
 *
 * # Why every field is optional
 *
 * `FilterBar` draws this unconditionally under the stated filters, and since 2026-08-25 that bar
 * is drawn over two searches: the card search, which parses query syntax out of its box, and the
 * deck editor's collection list, which does not. A surface with no tag query answers none of these
 * fields and this renders `null` — the same nothing it renders for a card search with no tag in
 * the box. The alternative was a flag on the bar saying which surface it was over, which is the
 * bar knowing about its callers to decide something its caller has already answered by what it
 * passes.
 */
export interface TagQuerySurface {
  tagChips?: readonly TagChip[];
  tagNotFound?: readonly TagToken[];
  removeTagChip?: (slug: string, namespace: TagNamespace) => void;
  toggleTagChipMode?: (slug: string, namespace: TagNamespace) => void;
  replaceTagToken?: (token: TagToken, value: string) => void;
  /** The typed predicates — `cmc>=3`, `t:goblin`. Optional for the same reason the tag fields
   *  are: a surface with no query parsing at all answers none of them. */
  predicateChips?: readonly PredicateChip[];
  removePredicateChip?: (key: string) => void;
  togglePredicateChipMode?: (key: string) => void;
}

export function TagQueryRow({ search }: { search: TagQuerySurface }) {
  const { tagChips = [], tagNotFound = [], predicateChips = [] } = search;
  const empty =
    tagChips.length === 0 && tagNotFound.length === 0 && predicateChips.length === 0;
  if (empty) return null;
  return (
    <div className="flex flex-col gap-1.5">
      {predicateChips.length > 0 && (
        <PredicateChips
          chips={predicateChips}
          onRemove={(key) => search.removePredicateChip?.(key)}
          onToggleMode={(key) => search.togglePredicateChipMode?.(key)}
        />
      )}
      {tagChips.length > 0 && (
        <TagChips
          selection={{ chips: tagChips, namespace: "both", floor: "any" }}
          ariaLabel="Tags from the search box"
          // Nothing to invite: this row is not drawn at all until a tag is in it, so an empty
          // state here could only ever be a sentence about a row nobody can see.
          emptyMessage={null}
          onRemove={(slug, namespace) => search.removeTagChip?.(slug, namespace)}
          onToggleMode={(slug, namespace) => search.toggleTagChipMode?.(slug, namespace)}
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
          onPick={(value) => search.replaceTagToken?.(token, value)}
        />
      ))}
    </div>
  );
}

/**
 * The typed predicates, as a row of chips — and **not drawn by `TagChips`**, which is a decision
 * about words rather than about pixels.
 *
 * A `TagChip` carries a slug, a namespace and a label out of one of Scryfall's two taxonomies,
 * and `TagChips` announces every one of them as "… tag" with the taxonomy's own mark beside it.
 * `cmc>=3` is none of those things: it is a *predicate*, a fourth thing beside the two tag
 * taxonomies, the deckbuilder's labels and the collection's free-text column — and the root
 * `CLAUDE.md` spends a paragraph on exactly that word never trading places. So a predicate would
 * have needed a fake namespace to be drawn there, and a screen reader would have been told a
 * mana-value filter was an oracle tag.
 *
 * What it *does* share is the geometry and both gestures, so the recipe is the same one
 * `PickedChip` uses and the two rows sit on one line: press the name to flip include/exclude,
 * press the ✕ to take the term out of the box.
 */
function PredicateChips({
  chips,
  onRemove,
  onToggleMode,
}: {
  chips: readonly PredicateChip[];
  onRemove: (key: string) => void;
  onToggleMode: (key: string) => void;
}) {
  return (
    // Named apart from both tag rows — the Tags page can have this row, its own picked-tags row
    // and the box's tag chips on screen at once, and three groups sharing a name are three
    // controls a screen reader cannot tell apart.
    <div
      role="group"
      aria-label="Terms from the search box"
      className="flex flex-wrap items-center gap-1.5"
    >
      {chips.map((chip) => (
        <TypedChip
          key={chip.key}
          chip={chip}
          onRemove={() => onRemove(chip.key)}
          onToggleMode={() => onToggleMode(chip.key)}
        />
      ))}
    </div>
  );
}

/**
 * One typed term: what the reader wrote, and the way out.
 *
 * `not` and a dashed edge tell an exclusion apart, never a hue — `PickedChip`'s rule beside it,
 * and for its reasons: gold already means "on" everywhere here, and a red chip would read as an
 * error, which an exclusion is not. **The words say "search term"**, which is what this is: the
 * one thing the accessible name must not call it is a tag.
 */
function TypedChip({
  chip,
  onRemove,
  onToggleMode,
}: {
  chip: PredicateChip;
  onRemove: () => void;
  onToggleMode: () => void;
}) {
  const excluded = chip.mode === "exclude";
  const shown = excluded ? `not ${chip.label}` : chip.label;
  const state = excluded
    ? `${shown}, search term, excluded. Press to include.`
    : `${shown}, search term, included. Press to exclude.`;
  return (
    <span
      className={cn(
        FILTER_CONTROL,
        "inline-flex items-center overflow-hidden",
        excluded ? "border-dashed border-dim" : "border-accent",
        // The press belongs to the two buttons inside; this box is not itself pressable.
        "active:scale-100",
      )}
    >
      <button
        type="button"
        onClick={onToggleMode}
        aria-label={state}
        className={cn(
          "flex h-full items-center gap-1.5 pl-2.5 pr-1.5",
          PRESS,
          // Inset, because this button fills a clipped box — `PickedChip`'s reason, which is
          // WCAG 2.4.7 rather than a matter of taste.
          FOCUS_INSET,
          excluded ? "text-dim hover:text-text" : "text-accent",
        )}
      >
        {/* The term in the mono face: it is something the reader typed rather than a word of
            prose, and a chip beside it holding a tag's label should not read as the same kind
            of thing. One span, so the accessible name computes as one phrase. */}
        <span className="max-w-48 truncate font-mono text-sm">{shown}</span>
      </button>
      <button
        type="button"
        onClick={onRemove}
        // The label rather than the visible ×, and the whole term with it: two chips differing
        // only in their operator would otherwise be two buttons with one name.
        aria-label={`Remove ${chip.label}, search term`}
        className={cn(
          "grid h-full w-7 flex-none place-items-center text-dim hover:text-text",
          PRESS,
          FOCUS_INSET,
        )}
      >
        <X className="size-3.5" aria-hidden="true" />
      </button>
    </span>
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
