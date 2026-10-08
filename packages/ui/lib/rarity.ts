/**
 * Rarity, as a colour.
 *
 * Four tokens and a fallback. The direction spends its colour budget on mana and card
 * art, so a rarity gets a 6px gem or a tinted word — never a filled badge, which at
 * mythic orange would out-shout the art it sits under.
 */
/**
 * A `Map`, not a `Record`: an object lookup answers for every key on `Object.prototype`, so
 * `rarity === "toString"` would come back holding a *function* — which
 * {@link hasRarityColor} would call a real colour and a `style` prop would render as
 * nonsense. A rarity arrives from the database rather than from a user, so it is a hole
 * nothing reaches today; it is closed here because the whole point of this module is that
 * the fallback path is right.
 */
const RARITY_COLOR = new Map<string, string>([
  ["common", "var(--color-rarity-common)"],
  ["uncommon", "var(--color-rarity-uncommon)"],
  ["rare", "var(--color-rarity-rare)"],
  ["mythic", "var(--color-rarity-mythic)"],
]);

/**
 * What a rarity with no token of its own is drawn in.
 *
 * The hairline colour, which reads as "no rarity stated" — the truth, and the right answer
 * for 6px of dot. It is *not* an answer for text: see {@link hasRarityColor}.
 */
const NO_TOKEN = "var(--color-border)";

export function rarityColor(rarity: string | null): string {
  // `special` and `bonus` exist in the data and have no token of their own.
  return (rarity === null ? undefined : RARITY_COLOR.get(rarity)) ?? NO_TOKEN;
}

/**
 * Whether this rarity has a colour of its own — whether {@link rarityColor} is a claim about
 * the rarity, or a shrug.
 *
 * Worth asking because the two things a rarity is drawn as have different floors. The gem is
 * decoration and may wear the fallback; a **word** may not — `--color-border` on the app
 * background is about 1.9:1, well under the AA floor the direction sets, so a `special`
 * printing would be captioned in a colour nobody can read. Anything that tints text asks
 * this first and leaves the word dim when the answer is no.
 */
export function hasRarityColor(rarity: string | null): boolean {
  return rarity !== null && RARITY_COLOR.has(rarity);
}
