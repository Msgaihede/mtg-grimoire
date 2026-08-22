import { describe, expect, it } from "vitest";
import type { TagHit, TagNamespace } from "@/lib/ipc";

import {
  addChip,
  chipKey,
  EMPTY_SELECTION,
  mergeTagTerms,
  removeChip,
  termsFor,
  toggleChipMode,
} from "./tagFilters";

/**
 * A hit as the backend answers one, with only the fields the chip set reads made interesting.
 *
 * **These are hand-made and reach no backend** — this module is a pure reducer, so the slugs
 * below name nothing in the Storybook fake and are not required to. A test that goes through
 * `ipc` is a different matter: the fake's 43-card corpus has no dog in it and tagging one on
 * would make every story built on the seed a fiction.
 *
 * **That is also why the two-namespace case can only be proved here.** The fake's 13 art slugs
 * and 29 oracle slugs are completely disjoint, so there is no collision in it to search for —
 * while the real taxonomies share plenty, `ipc.ts`'s {@link TagNamespace} naming `dog` as one.
 */
function hit(namespace: TagNamespace, slug: string): TagHit {
  return {
    slug,
    id: `${namespace}-${slug}-id`,
    label: slug[0].toUpperCase() + slug.slice(1),
    namespace,
    description: null,
    cardCount: 1,
    childCount: 0,
    parents: [],
  };
}

const artHit = (slug: string) => hit("art", slug);
const oracleHit = (slug: string) => hit("oracle", slug);

describe("addChip", () => {
  it("adds a chip once, even when the same tag is clicked twice", () => {
    const h = artHit("landscape");
    expect(addChip(addChip(EMPTY_SELECTION, h), h).chips).toHaveLength(1);
  });

  /**
   * Two taxonomies, two id spaces, and plenty of slugs in both — `ipc.ts`'s {@link
   * TagNamespace} names `dog` as one, meaning a picture in the art file and a rules effect in
   * the oracle one. A chip set keyed on the slug alone would silently merge the pair and the
   * reader would lose whichever they picked second.
   */
  it("keeps the same slug in two namespaces apart", () => {
    const s = addChip(addChip(EMPTY_SELECTION, artHit("dragon")), oracleHit("dragon"));
    expect(s.chips).toHaveLength(2);
    expect(s.chips.map((c) => c.namespace)).toEqual(["art", "oracle"]);
  });

  /** Re-adding gives back the *same object*, so a second click on a picked row cannot cost a
   *  re-render of the wall below it. */
  it("gives back the same selection when the tag is already picked", () => {
    const s = addChip(EMPTY_SELECTION, artHit("forest"));
    expect(addChip(s, artHit("forest"))).toBe(s);
  });

  /** `EMPTY_SELECTION` is shared by every caller and the module is strict-mode, so a reducer
   *  that pushed into its array would throw here rather than corrupting the next page. */
  it("never mutates the selection it was handed", () => {
    addChip(EMPTY_SELECTION, artHit("water"));
    expect(EMPTY_SELECTION.chips).toHaveLength(0);
  });
});

describe("removeChip", () => {
  it("removes only the chip in the namespace it names", () => {
    const s = addChip(addChip(EMPTY_SELECTION, artHit("dragon")), oracleHit("dragon"));
    const t = removeChip(s, "dragon", "art");
    expect(t.chips.map((c) => c.namespace)).toEqual(["oracle"]);
  });

  it("gives back the same selection when there is nothing to remove", () => {
    const s = addChip(EMPTY_SELECTION, artHit("forest"));
    expect(removeChip(s, "forest", "oracle")).toBe(s);
  });
});

describe("toggleChipMode", () => {
  /** Position is the reader's: a chip that jumped to the end of the row when it was flipped
   *  would make the row unreadable exactly while it is being edited. */
  it("toggles a chip between include and exclude without reordering the set", () => {
    const s = addChip(addChip(EMPTY_SELECTION, artHit("forest")), artHit("water"));
    const t = toggleChipMode(s, "forest", "art");
    expect(t.chips.map((c) => c.slug)).toEqual(["forest", "water"]);
    expect(t.chips[0].mode).toBe("exclude");
    expect(toggleChipMode(t, "forest", "art").chips[0].mode).toBe("include");
  });

  it("leaves the other namespace's chip of the same slug alone", () => {
    const s = addChip(addChip(EMPTY_SELECTION, artHit("dragon")), oracleHit("dragon"));
    const t = toggleChipMode(s, "dragon", "art");
    expect(t.chips.map((c) => c.mode)).toEqual(["exclude", "include"]);
  });
});

describe("termsFor", () => {
  it("splits chips into the two namespaces' terms", () => {
    const s = toggleChipMode(
      addChip(addChip(EMPTY_SELECTION, artHit("forest")), oracleHit("ramp")),
      "forest",
      "art",
    );
    expect(termsFor(s)).toEqual({
      artTags: { include: [], exclude: ["forest"] },
      oracleTags: { include: ["ramp"], exclude: [] },
    });
  });

  /**
   * An empty selection must send NO tag fields at all — absent means no filter everywhere in
   * this codebase, and an empty `include: []` travelling on every request is a payload that
   * lies about intent. The backend's own tests pin absent-means-no-predicate.
   */
  it("sends no tag terms at all when nothing is selected", () => {
    expect(termsFor(EMPTY_SELECTION)).toEqual({});
  });

  /** A namespace nobody picked from is absent too, for the same reason. */
  it("omits the taxonomy that has no chips", () => {
    expect(termsFor(addChip(EMPTY_SELECTION, oracleHit("ramp")))).toEqual({
      oracleTags: { include: ["ramp"], exclude: [] },
    });
  });

  /** Sorted before they leave, which is what lets a key derived from this payload ignore the
   *  order the reader picked them in. `filters::picked_tags` sorts and dedups on the Rust side anyway,
   *  so this changes no answer — only how many times the answer is asked for. */
  it("sorts each list so two orders make one payload", () => {
    const a = addChip(addChip(EMPTY_SELECTION, artHit("water")), artHit("forest"));
    const b = addChip(addChip(EMPTY_SELECTION, artHit("forest")), artHit("water"));
    expect(termsFor(a).artTags?.include).toEqual(["forest", "water"]);
    expect(termsFor(a)).toEqual(termsFor(b));
  });

  it("carries the weight floor when it is on", () => {
    const s = { ...addChip(EMPTY_SELECTION, artHit("landscape")), floor: "strong" as const };
    expect(termsFor(s).artWeightFloor).toBe("strong");
  });

  /**
   * The floor is the art side's and the *include* side's — `oracle_tag_cards` has no `weight`
   * column at all, and "not a forest" means not a forest at all. So with no art include it can
   * narrow nothing, and sending it would be a field that changes no rows while changing the
   * query key: a refetch of the whole wall for a switch that did nothing.
   */
  it("omits the floor when there is no art include for it to narrow", () => {
    const excludeOnly = toggleChipMode(
      addChip(EMPTY_SELECTION, artHit("landscape")),
      "landscape",
      "art",
    );
    expect(termsFor({ ...excludeOnly, floor: "strong" }).artWeightFloor).toBeUndefined();
    expect(termsFor({ ...addChip(EMPTY_SELECTION, oracleHit("ramp")), floor: "strong" })).toEqual({
      oracleTags: { include: ["ramp"], exclude: [] },
    });
  });

  it("omits the floor when it is off", () => {
    const s = addChip(EMPTY_SELECTION, artHit("landscape"));
    expect(termsFor(s).artWeightFloor).toBeUndefined();
  });

  /**
   * The selection's `namespace` is the **search box's** — which taxonomy the tree and the
   * type-ahead draw. It filters no card, so it must not reach the payload, or the query key
   * derived from that payload would refetch the whole wall when a reader flipped a toggle that
   * describes the rail.
   *
   * Kept from the deleted `selectionKey` block, because it is the one claim there that was about
   * *this* function: everything else it asserted — order, the two namespaces' shared slugs, the
   * floor — is asserted above over the payload the key is now derived from.
   */
  it("says nothing about which taxonomy the search box is showing", () => {
    const s = addChip(EMPTY_SELECTION, artHit("forest"));
    expect(termsFor(s)).toEqual(termsFor({ ...s, namespace: "oracle" }));
  });
});

describe("chipKey", () => {
  /** React keys and lookups both: keying on the slug alone would collapse `dragon` the picture
   *  onto `dragon` the rules text and drop one of the reader's two chips. */
  it("names the namespace as well as the slug", () => {
    expect(chipKey("art", "dragon")).not.toBe(chipKey("oracle", "dragon"));
  });
});

/**
 * The two gestures that pick a tag — a chip off the Tags page's rail, and a name typed into the
 * search box — as one filter.
 */
describe("mergeTagTerms", () => {
  it("unions each list rather than letting one side win", () => {
    const merged = mergeTagTerms(
      { artTags: { include: ["dog"], exclude: [] } },
      { artTags: { include: ["forest"], exclude: ["water"] } },
    );

    expect(merged.artTags).toEqual({ include: ["dog", "forest"], exclude: ["water"] });
  });

  /**
   * Absent means "no filter" everywhere in this codebase, and the Rust tests pin
   * absent-means-no-predicate. An `include: []` riding on every request would be a payload that
   * lies about intent — and, since the query key is derived from this object, a second cache
   * entry for a search that asked nothing extra.
   */
  it("leaves a taxonomy neither side picked from absent rather than empty", () => {
    expect(mergeTagTerms({}, {})).toEqual({});
    expect(mergeTagTerms({ artTags: { include: ["dog"], exclude: [] } }, {}).oracleTags).toBeUndefined();
  });

  /**
   * Chipping `dog` and *also* typing `a:dog` is one predicate at the far end
   * (`filters::picked_tags` sorts and dedups) — and, more to the point here, one **query key**.
   * Sorted for the same reason: the order the reader picked them in must not mint a second one.
   */
  it("deduplicates and sorts, so one tag picked twice is one key", () => {
    const a = mergeTagTerms(
      { artTags: { include: ["dog", "forest"], exclude: [] } },
      { artTags: { include: ["forest"], exclude: [] } },
    );
    const b = mergeTagTerms(
      { artTags: { include: ["forest"], exclude: [] } },
      { artTags: { include: ["forest", "dog"], exclude: [] } },
    );

    expect(a.artTags).toEqual({ include: ["dog", "forest"], exclude: [] });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  /** The typed syntax has no keyword for the weight floor — Scryfall has none to borrow — so
   *  the floor can only ever be the caller's. */
  it("carries the floor through from whichever side has one", () => {
    expect(
      mergeTagTerms({ artTags: { include: ["dog"], exclude: [] }, artWeightFloor: "strong" }, {})
        .artWeightFloor,
    ).toBe("strong");
    expect(mergeTagTerms({}, {}).artWeightFloor).toBeUndefined();
  });

  /** One side empty is the common case — a plain search on a page that passes no chips — and it
   *  has to hand back exactly the other side. */
  it("is the other side when one is empty", () => {
    const typed = { oracleTags: { include: ["ramp"], exclude: [] } };
    expect(mergeTagTerms({}, typed)).toEqual(typed);
    expect(mergeTagTerms(typed, {})).toEqual(typed);
  });
});
