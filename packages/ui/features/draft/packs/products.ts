/**
 * What the Packs page offers to open of one set: its boosters, then the sealed products that hold
 * boosters (spec §7). Names are MTGJSON's own — "The Hobbit Play Booster", "… Collector Booster
 * Box" — so the picker reads as the shelf in a shop does.
 */
import type { BoosterSet } from "@/lib/ipc";

/** One thing to open: a booster by its product key, or a sealed product by its uuid. */
export type Openable =
  | { kind: "booster"; id: string; name: string }
  | { kind: "sealed"; id: string; name: string; category: string | null };

/**
 * The order sealed products are offered in: a box first (what a reader most often prices), then
 * a case of boxes, then the smaller bundles and packs of packs; anything else after, by name.
 */
const CATEGORY_ORDER = [
  "booster_box",
  "booster_case",
  "bundle",
  "bundle_case",
  "box_set",
  "booster_pack",
];

function categoryRank(category: string | null): number {
  const at = category === null ? -1 : CATEGORY_ORDER.indexOf(category);
  return at === -1 ? CATEGORY_ORDER.length : at;
}

/** {@link Openable}s of `set`: the boosters by name, then the sealed products by kind and name. */
export function openables(set: BoosterSet): Openable[] {
  const boosters: Openable[] = [...set.products]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((p) => ({ kind: "booster", id: p.key, name: p.name }));
  const sealed: Openable[] = [...set.sealed]
    .sort(
      (a, b) => categoryRank(a.category) - categoryRank(b.category) || a.name.localeCompare(b.name),
    )
    .map((s) => ({ kind: "sealed", id: s.uuid, name: s.name, category: s.category }));
  return [...boosters, ...sealed];
}

/** The value an {@link Openable} is picked by in a dropdown: unique across both kinds. */
export function openableValue(o: Openable): string {
  return `${o.kind}:${o.id}`;
}
