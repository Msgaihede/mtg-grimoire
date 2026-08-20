import { count } from "@/lib/counts";
import type { TagHit, TagNamespace } from "@/lib/ipc";

/**
 * The words the Tags page uses for the two taxonomies, and what each of them counts.
 *
 * **Its own module because all three surfaces need them and no one of them owns them.** The
 * search box names the *choice* between the two, the rail marks which one a row came from, and a
 * chip carries its namespace for the rest of its life — so "Art" spelled in three files would be
 * three independent decisions that happen to agree today. The two taxonomies are separate files
 * with separate id spaces that share plenty of slugs, which is precisely why the reader has to be
 * told which one is in front of them; a vocabulary that drifted between the box, the rail and the
 * chip would undo that.
 */

/** What a reader is shown a namespace as. Never the raw `"art"`/`"oracle"` from the wire. */
export const TAG_NAMESPACE_LABEL: Record<TagNamespace, string> = {
  art: "Art",
  oracle: "Oracle",
};

/**
 * One line saying what each taxonomy is *about* — the tooltip on the box's radios.
 *
 * "Art" and "Oracle" are Scryfall's words and neither is self-explanatory, and getting this
 * wrong is the page's one real hazard: a reader on the wrong taxonomy types a motif, sees an
 * empty list, and blames their spelling.
 */
export const TAG_NAMESPACE_HINT: Record<TagNamespace, string> = {
  art: "What the illustration shows",
  oracle: "What the card does",
};

/**
 * How far a tag reaches, in words: `3 illustrations`, `6,686 cards`.
 *
 * **The unit is not the same on both sides and saying "cards" for both would be wrong.**
 * `TagHit.cardCount` is a count of *illustrations* for the art taxonomy and of *oracle ids* for
 * the oracle one — and of printings in neither case. An art tag on one of the four Lightning
 * Bolts answers one illustration where the oracle tag `burn` answers all four, which is the whole
 * of what this page is about; a rail that printed "1 card" beside `lightning` would teach the
 * reader the opposite.
 *
 * **The unit is written out rather than left as a bare number.** A number laid beside a tag name
 * with nothing saying what it counts is a quantity of nothing in particular — the same reason the
 * search wall stopped drawing a bare `132` and says `132 printings` now.
 *
 * `count()` rather than `plural()`: that helper writes its number plainly and says at its own
 * site that a caller reaching four figures wants the separator and its own thought about it.
 * `removal` reaches 6 686 cards, so this is that caller.
 */
export function tagReachLabel(hit: Pick<TagHit, "namespace" | "cardCount">): string {
  const unit = hit.namespace === "art" ? "illustration" : "card";
  return `${count(hit.cardCount)} ${hit.cardCount === 1 ? unit : `${unit}s`}`;
}

/**
 * Which taxonomy a row came from, drawn small and quiet beside its label.
 *
 * **Body face rather than Geist Mono**: the direction reserves mono for numbers — collector
 * numbers, prices, counts — and the count sitting two boxes away on the same row is already
 * drawn in it. A taxonomy name set in mono would read as a second figure.
 *
 * `aria-hidden`, because every surface that draws this composes its own accessible name and
 * spells the namespace into it; left announced, a screen reader would hear it twice.
 */
export function TagNamespaceMark({ namespace }: { namespace: TagNamespace }) {
  return (
    <span
      aria-hidden="true"
      className="flex-none text-[0.625rem] uppercase tracking-[0.12em] text-dim"
    >
      {TAG_NAMESPACE_LABEL[namespace]}
    </span>
  );
}
