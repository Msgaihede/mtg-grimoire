/**
 * A life total as the board holds it and as it draws it.
 *
 * **Life is a `bigint`, held to a signed 64-bit integer** — the owner's rule on the design canvas
 * (2026-11-19): a total runs up to 9,223,372,036,854,775,807 and down to its negative, past the
 * 2^53 a `number` holds exactly, so a doubling deck's tenth doubling is still the right figure and
 * not the nearest float. Everything that touches a total goes through {@link clampLife}.
 *
 * **Never more than three digits on a panel** ({@link humanize}): plain up to 999, then 1.00k,
 * 12.5k, 125k, 1.25m … 9.22qi, with the exact figure on the line under it. A panel is sized for a
 * two-digit total (`fit.ts`), and three digits and a unit letter is what still reads at that size.
 */

/** The largest life total: the largest signed 64-bit integer. */
export const LIFE_MAX = 9223372036854775807n;
/** The smallest: the smallest signed 64-bit integer. Life goes below zero, all the way. */
export const LIFE_MIN = -9223372036854775808n;

/** `value` held between `least` and `most`, both inclusive. */
export function within(value: bigint, least: bigint, most: bigint): bigint {
  return value < least ? least : value > most ? most : value;
}

/** A total held to what a life total can be. */
export function clampLife(value: bigint): bigint {
  return within(value, LIFE_MIN, LIFE_MAX);
}

/** A number as the board draws it: at most three digits and a unit, and the exact figure when
 *  the short one is not exact (`""` when it is). */
export interface ShownNumber {
  text: string;
  exact: string;
}

/**
 * k, m, b, t, then quadrillion and quintillion — the largest 64-bit integer is 9.22qi, so the
 * ladder stops there. Largest first, so the first unit a number reaches is its unit.
 */
const UNITS: readonly [bigint, string][] = [
  [10n ** 18n, "qi"],
  [10n ** 15n, "qa"],
  [10n ** 12n, "t"],
  [10n ** 9n, "b"],
  [10n ** 6n, "m"],
  [10n ** 3n, "k"],
];

/**
 * Three significant digits and a unit, **cut and never rounded up**: 999,999 is "999k", not the
 * "1.00m" nobody's life total is. Negatives take a real minus sign (U+2212), which is the width of
 * a plus in Geist Mono where a hyphen is narrower and reads as a dash.
 */
export function humanize(value: bigint): ShownNumber {
  if (value < 0n) {
    const below = humanize(-value);
    return { text: `−${below.text}`, exact: below.exact ? `−${below.exact}` : "" };
  }
  if (value < 1000n) return { text: String(value), exact: "" };
  for (const [unit, name] of UNITS) {
    if (value < unit) continue;
    const places = value < unit * 10n ? 2 : value < unit * 100n ? 1 : 0;
    const scale = 10n ** BigInt(places);
    const cut = value / (unit / scale);
    const whole = String(cut / scale);
    const text = places === 0 ? whole : `${whole}.${String(cut % scale).padStart(places, "0")}`;
    return { text: `${text}${name}`, exact: grouped(value) };
  }
  return { text: String(value), exact: "" };
}

/**
 * The whole figure with thousands separators — `1,250,000` — and a real minus sign. What the
 * calculator's display, the line under a large total and every accessible name read.
 *
 * Grouped by hand rather than by `toLocaleString`: a `bigint`'s locale formatting goes through
 * `Intl.NumberFormat`, which an engine built without full ICU answers without separators, and the
 * board's figures must read the same on every host.
 */
export function grouped(value: bigint): string {
  const negative = value < 0n;
  const digits = String(negative ? -value : value);
  let out = "";
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ",";
    out += digits[i];
  }
  return negative ? `−${out}` : out;
}

/** A delta as the line under the number draws it: `+3`, `−12`, `+1.25m`. */
export function deltaText(delta: bigint): string {
  if (delta === 0n) return "+0";
  return (delta > 0n ? "+" : "−") + humanize(delta < 0n ? -delta : delta).text;
}
