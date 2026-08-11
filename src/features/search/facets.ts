import type { FacetResponse } from "@/lib/ipc";

/**
 * The greying rule, and the three consequences of it that decide every branch below.
 *
 * > **An option greys out when turning it on would not change the result set.**
 *
 * That sentence and not "would return nothing", because the filters do not all narrow — see
 * {@link colorDisabled}, which is the one that broadens.
 */

/**
 * Whether a filter option should be drawn as unavailable.
 *
 * **Three rules, and the order matters.** A *selected* option is never greyed — the way out
 * of a dead end has to stay open, and if a search matches nothing at all then every
 * unselected option greys and `Reset all` is the escape. **An absent answer fails open**,
 * because not-greyed means "we don't know" while greyed means "this is empty", and only one
 * of those is safe to guess. And a *key* that is absent from a present answer is treated the
 * same way, for the same reason: `FacetResponse` promises every key on a ready response
 * (`sets` sends the whole corpus, zeros included), so a missing one is a broken contract
 * rather than an empty option — and the honest reading of a broken contract is "unknown".
 *
 * That last arm is also what makes a cold response harmless if one ever reaches here without
 * going through {@link facetsOrUndefined}: its maps are empty rather than zeroed, so every
 * lookup misses and every control stays live.
 */
export function optionDisabled(
  counts: Record<string, number> | undefined,
  key: string,
  selected: boolean,
): boolean {
  if (selected || !counts) return false;
  return counts[key] === 0;
}

/**
 * The same question for a colour chip, which needs a different one asked.
 *
 * `colors` is subset semantics: with `U` on, pressing `W` asks for "castable in WU", which
 * is a *superset*. So a colour chip cannot be greyed for returning nothing — it is greyed
 * when pressing it would not change the result set, which covers both directions. `after`
 * is the size of the result set the press would produce, and `total` the size it has now.
 *
 * **`total` is `FacetResponse.total` and never the list's own** — the two are different
 * numbers under one name, because the search view collapses printings into cards and this
 * count does not. The rule is only correct against the former.
 */
export function colorDisabled(
  after: number | undefined,
  total: number,
  selected: boolean,
): boolean {
  if (selected || after === undefined) return false;
  return after === 0 || after === total;
}

/**
 * The tooltip and the accessible name for one option.
 *
 * **The number is printings**, and says so: the search view collapses printings into cards,
 * so a facet count and the list's own total count different things. Greying is unaffected —
 * zero printings is zero cards — and the word is the whole fix.
 *
 * Zero gets a reason rather than a numeral, because that is the tooltip on a control the
 * reader has just found they cannot press. And no count gets no sentence at all, so a
 * control with no facets behind it keeps the plain label it has always had.
 */
export function facetTitle(label: string, count: number | undefined): string | undefined {
  if (count === undefined) return undefined;
  if (count === 0) return `${label} — nothing in this search`;
  return `${label} — ${count.toLocaleString("en-US")} printing${count === 1 ? "" : "s"}`;
}

/**
 * The facet counts a control may believe, or `undefined` when nothing is known.
 *
 * **A cold index answers `ready: false` with every map empty**, not zeroed — the "a key is
 * never absent" promise on `FacetResponse` holds only for a ready one. Collapsing the whole
 * response to `undefined` here is what keeps that distinction from having to be remembered
 * at each of the five controls.
 */
export function facetsOrUndefined(f: FacetResponse | undefined): FacetResponse | undefined {
  return f?.ready ? f : undefined;
}
