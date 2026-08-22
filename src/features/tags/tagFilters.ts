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
 * the tree draw; a chip carries its own namespace and is unaffected by it. {@link termsFor}
 * deliberately leaves it out for that reason, which is what keeps a key derived from that
 * payload from refetching the wall when the rail changes taxonomy.
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
 * Adding a tag that is already picked gives back **the same object**, so an add that lands on a
 * chipped tag costs no re-render of the wall below it — and cannot flip a chip the reader had set
 * to exclude back to include behind their back.
 *
 * **Not what a rail row presses.** That is {@link toggleChip}: this reducer only ever adds, and a
 * control wired straight to it can turn a filter on but never off. See there for issue #181.
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

/**
 * Pick a tag, or un-pick it — **what a press on a rail row does**.
 *
 * The rail used to press {@link addChip}, which answers an already-picked tag with the same
 * object. So the row that turned a filter on could not turn it off: the only way back was to find
 * the chip two controls away and press its ×, which is what issue #181 was reported as. A control
 * that has one direction is half a control, and this is the half that was missing.
 *
 * **Mode is deliberately not part of the cycle.** An excluded chip is *picked* — the rail draws
 * its tick, the wall is filtered by it — so a press takes it off rather than walking
 * include → exclude → off. Include ↔ exclude is {@link toggleChipMode}, and it belongs to the
 * chip, which is where both states are drawn and named; a rail row shows neither and would be
 * cycling a reader through a state they cannot see from there.
 */
export function toggleChip(s: TagSelection, hit: TagHit): TagSelection {
  const key = chipKey(hit.namespace, hit.slug);
  return s.chips.some((c) => isChip(c, key))
    ? removeChip(s, hit.slug, hit.namespace)
    : addChip(s, hit);
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
 * and is what lets a **key derived from this payload** ignore the order the reader picked them
 * in. That key is `useCardSearch`'s and is derived there rather than offered here: this module
 * once exported a `selectionKey` beside this function, and two derivations over one object are
 * two things that can disagree — invisibly, since the symptom is one search answered out of
 * another's cached pages.
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

/** One namespace's two lists, concatenated and put back in {@link termsFor}'s canonical shape. */
function mergeOne(a: TagTerms | undefined, b: TagTerms | undefined): TagTerms | undefined {
  if (!a) return b;
  if (!b) return a;
  const join = (x: readonly string[] = [], y: readonly string[] = []) =>
    [...new Set([...x, ...y])].sort();
  return { include: join(a.include, b.include), exclude: join(a.exclude, b.exclude) };
}

/**
 * Two sets of tag terms as one — the chips a page picked, ANDed with the tags a reader typed
 * into the search box.
 *
 * **Both halves are statements the reader made and both narrow**, so this is a union of the
 * lists rather than one side winning: a Tags page reader who has chipped `dog` and then types
 * `o:ramp` is asking for a dog that ramps, and either half silently dropping the other's tags
 * would answer a question nobody asked. Includes still intersect at the far end —
 * `filters::picked_tags` gives each slug its own `EXISTS` — so a longer list is a narrower wall,
 * which is what both gestures mean.
 *
 * **A namespace neither side picked from stays absent, not empty**, which is `termsFor`'s rule
 * and the reason this returns `undefined` rather than `{ include: [], exclude: [] }`: absent
 * means no filter everywhere in this codebase, and an empty list riding on every request would
 * be a payload that lies about intent.
 *
 * Each list is deduplicated and sorted, so chipping `dog` and *also* typing `a:dog` is one
 * `EXISTS` and — more to the point — one **query key**: the key `useCardSearch` derives from
 * this payload must not mint a second cache entry for a search that is the same search.
 *
 * **The floor is the caller's alone.** The typed syntax has no keyword for it — Scryfall has no
 * such qualifier to borrow — so `b` never carries one, and taking `a`'s is both arms of the
 * `??` doing the only thing they can.
 */
export function mergeTagTerms(
  a: { artTags?: TagTerms; oracleTags?: TagTerms; artWeightFloor?: ArtWeightFloor },
  b: { artTags?: TagTerms; oracleTags?: TagTerms; artWeightFloor?: ArtWeightFloor },
): { artTags?: TagTerms; oracleTags?: TagTerms; artWeightFloor?: ArtWeightFloor } {
  const out: { artTags?: TagTerms; oracleTags?: TagTerms; artWeightFloor?: ArtWeightFloor } = {};
  const artTags = mergeOne(a.artTags, b.artTags);
  const oracleTags = mergeOne(a.oracleTags, b.oracleTags);
  // Assigned only when there is one, so the object's *keys* say what was picked — which is what
  // makes `JSON.stringify` of it a usable query key rather than a constant.
  if (artTags) out.artTags = artTags;
  if (oracleTags) out.oracleTags = oracleTags;
  const floor = a.artWeightFloor ?? b.artWeightFloor;
  if (floor) out.artWeightFloor = floor;
  return out;
}
