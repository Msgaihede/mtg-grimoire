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

/**
 * The words an {@link Openable} is found by in the product picker's search: its name, what kind
 * of thing it is ("booster", or "sealed") and a sealed product's MTGJSON category in words
 * ("booster_case" → "booster case"). Lower-cased.
 */
function openableWords(o: Openable): string {
  const kind = o.kind === "booster" ? "booster" : "sealed";
  const category = o.kind === "sealed" && o.category !== null ? o.category.replace(/_/g, " ") : "";
  return `${o.name} ${kind} ${category}`.toLowerCase();
}

/**
 * Whether `o` answers the product picker's search: every whitespace-separated word of `query`,
 * case-insensitively, somewhere in its words ({@link openableWords}) — so "collector box" finds
 * "… Collector Booster Box" and "sealed" every sealed product. A blank query keeps every product.
 */
export function openableMatches(o: Openable, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const haystack = openableWords(o);
  return words.every((w) => haystack.includes(w));
}
