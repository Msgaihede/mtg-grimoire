import type { ArtWeightFloor, TagHit, TagNamespace, TagTerms } from "@/lib/ipc";

/**
 * One tag the reader has picked, and which way they picked it.
 *
 * `label` rides along rather than being looked up again, because the chip has to keep naming
 * the tag after a refresh has renamed or removed it — the same reason `muted_tags` stores a
 * slug it never joins.
 */
export interface TagChip {
  slug: string;
  label: string;
  /** Half of the chip's identity — see {@link chipKey}. */
  namespace: TagNamespace;
  mode: "include" | "exclude";
}

/**
 * Everything the Tags page's query is built from: the chips, which taxonomy the search box is
 * showing, and the art weight floor.
 *
 * **`namespace` is the *box's*, not a filter.** It decides which taxonomy the type-ahead and
 * the tree draw; a chip carries its own namespace and is unaffected by it. {@link selectionKey}
 * deliberately leaves it out for that reason.
 */
export interface TagSelection {
  /** `readonly` because {@link EMPTY_SELECTION} is shared by every caller: a `push` onto it
   *  would hand the next page somebody else's chips, and this is the fence that refuses one at
   *  compile time. Every reducer here returns a new array. */
  chips: readonly TagChip[];
  namespace: TagNamespace | "both";
  floor: ArtWeightFloor;
}

/**
 * Nothing picked, both taxonomies offered, no floor.
 *
 * **Both defaults are the widening one.** `"both"` was the one control here with a real hazard
 * — a reader parked on the wrong taxonomy sees an empty type-ahead and blames their spelling —
 * and `"any"` is no floor at all, so the toggle can only ever narrow from here.
 *
 * Frozen as well as `readonly`-typed, because a cast gets past the type and this does not:
 * under ES modules a mutation of a frozen object throws at the site rather than silently
 * handing the next page somebody else's chips.
 */
export const EMPTY_SELECTION: TagSelection = Object.freeze({
  chips: Object.freeze([] as TagChip[]),
  namespace: "both",
  floor: "any",
} satisfies TagSelection);

/**
 * A chip's identity, for a React key or a lookup — **the namespace and the slug, never the slug
 * alone.**
 *
 * The two taxonomies are separate files with separate id spaces that share plenty of slugs:
 * `ipc.ts`'s {@link TagNamespace} names `dog`, which is a picture in one file and a rules
 * effect in the other. Keyed on the slug, picking both would silently drop one of them.
 */
export function chipKey(namespace: TagNamespace, slug: string): string {
  return `${namespace}:${slug}`;
}

/** Every reducer below asks "is this the chip I was named?" through {@link chipKey}, so the
 *  identity rule is written once rather than four times as a pair of `&&`s that a fifth site
 *  could get half right. */
const isChip = (c: TagChip, key: string) => chipKey(c.namespace, c.slug) === key;

/**
 * Pick a tag, as an include.
 *
 * Adding a tag that is already picked gives back **the same object**, so a second click on a
 * row that is already chipped costs no re-render of the wall below it — and cannot flip a chip
 * the reader had set to exclude back to include behind their back.
 */
export function addChip(s: TagSelection, hit: TagHit): TagSelection {
  const key = chipKey(hit.namespace, hit.slug);
  if (s.chips.some((c) => isChip(c, key))) return s;
  return {
    ...s,
    chips: [
      ...s.chips,
      { slug: hit.slug, label: hit.label, namespace: hit.namespace, mode: "include" },
    ],
  };
}

/** Drop one chip. Naming a tag that is not picked gives back the same object. */
export function removeChip(s: TagSelection, slug: string, ns: TagNamespace): TagSelection {
  const key = chipKey(ns, slug);
  const chips = s.chips.filter((c) => !isChip(c, key));
  return chips.length === s.chips.length ? s : { ...s, chips };
}

/**
 * Flip one chip between include and exclude, **in place in the row**.
 *
 * A chip that jumped to the end when it was flipped would make the row unreadable exactly
 * while the reader is editing it.
 */
export function toggleChipMode(s: TagSelection, slug: string, ns: TagNamespace): TagSelection {
  const key = chipKey(ns, slug);
  if (!s.chips.some((c) => isChip(c, key))) return s;
  return {
    ...s,
    chips: s.chips.map((c) =>
      isChip(c, key) ? { ...c, mode: c.mode === "include" ? "exclude" : "include" } : c,
    ),
  };
}

/** The slugs of one namespace and one mode, sorted — see {@link termsFor}. */
function slugsOf(chips: readonly TagChip[], ns: TagNamespace, mode: TagChip["mode"]): string[] {
  return chips
    .filter((c) => c.namespace === ns && c.mode === mode)
    .map((c) => c.slug)
    .sort();
}

/**
 * The chips as request fields — what rides on `SearchRequest` and `CardFilters`.
 *
 * **Includes INTERSECT.** Two chips means forests AND water, never the union; the backend gives
 * each included slug its own `EXISTS` for exactly that, and nothing here may imply otherwise.
 *
 * **A taxonomy nobody picked from is absent, not empty.** Absent means no filter everywhere in
 * this codebase and the Rust tests pin absent-means-no-predicate, so an `include: []` riding on
 * every request would be a payload that lies about intent. A taxonomy with *any* chip sends
 * both of its lists, because "include these, exclude nothing" is a complete statement.
 *
 * **The floor is sent only when it can narrow something.** It applies to the art side's
 * *include* half alone — `oracle_tag_cards` carries no `weight` column and "not a forest" means
 * not a forest at all — so with no art include it changes no rows while changing the query key:
 * a refetch of the whole wall for a switch that did nothing.
 *
 * Each list is sorted, which changes no answer (`filters::picked_tags` sorts and dedups anyway)
 * and is what lets {@link selectionKey} ignore the order the reader picked them in.
 */
export function termsFor(s: TagSelection): {
  artTags?: TagTerms;
  oracleTags?: TagTerms;
  artWeightFloor?: ArtWeightFloor;
} {
  const out: { artTags?: TagTerms; oracleTags?: TagTerms; artWeightFloor?: ArtWeightFloor } = {};

  const artInclude = slugsOf(s.chips, "art", "include");
  const artExclude = slugsOf(s.chips, "art", "exclude");
  if (artInclude.length > 0 || artExclude.length > 0) {
    out.artTags = { include: artInclude, exclude: artExclude };
  }

  const oracleInclude = slugsOf(s.chips, "oracle", "include");
  const oracleExclude = slugsOf(s.chips, "oracle", "exclude");
  if (oracleInclude.length > 0 || oracleExclude.length > 0) {
    out.oracleTags = { include: oracleInclude, exclude: oracleExclude };
  }

  if (s.floor === "strong" && artInclude.length > 0) out.artWeightFloor = "strong";

  return out;
}

/**
 * One string that changes exactly when the request does — the segment a card query keys on.
 *
 * Derived from {@link termsFor} rather than from the chips, so "same payload, same key" holds
 * by construction: the sorting is already done there, chip order is already gone, and anything
 * the payload leaves out (the search box's `namespace`, a floor with nothing to narrow) cannot
 * mint a key that refetches for nothing.
 */
export function selectionKey(s: TagSelection): string {
  const t = termsFor(s);
  return JSON.stringify([
    t.artTags?.include ?? [],
    t.artTags?.exclude ?? [],
    t.oracleTags?.include ?? [],
    t.oracleTags?.exclude ?? [],
    t.artWeightFloor ?? "",
  ]);
}
