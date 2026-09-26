import type { Currency, Marketplace } from "./marketplace";

/**
 * Money, as this app writes it.
 *
 * Three call sites had their own `Intl.NumberFormat` and two had their own copy of the
 * as-of sentence — which is exactly the kind of duplication that ends with two screens
 * making different promises about the same number. Prices come from one place (whatever
 * the last sync wrote, quoted by whichever marketplace the reader picked), so they say so
 * in one sentence.
 */

/**
 * One formatter per currency, built once.
 *
 * Module-level on purpose: an `Intl.NumberFormat` is expensive to construct and these are
 * called once per price cell in a virtualised table. Building one per call is the thing this
 * module was written to stop, and switching marketplace must not reintroduce it — the switch
 * changes which constant is *looked up*, never how many exist.
 */
const FORMATTERS: Record<Currency, Intl.NumberFormat> = {
  usd: new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }),
  eur: new Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR" }),
};

/** A price, or an em dash. Never `$0.00`, which is a price nobody quoted. */
export function formatPrice(value: number | null, currency: Currency): string {
  return value === null ? "—" : FORMATTERS[currency].format(value);
}

/**
 * A purchase price written as text — what a reader typed into a **purchase price** box, or what a
 * spreadsheet put in a CSV's `Purchase price` cell — as an amount, or `undefined` for "nothing
 * to send".
 *
 * **Both of those read through this one function**, and they used to read through two that
 * misread in opposite directions: the importer stripped every comma (`4,50` from a Danish or
 * German spreadsheet stored as 450) and the box read any lone comma as a decimal point (`$1,500`
 * stored as 1.5).
 *
 * **Here rather than in either box, because it has to read back what {@link formatPrice} writes.**
 * The add popup shows the marketplace's figure as its placeholder and the edit dialog seeds its
 * box with the recorded one, so `$2.50` and `€1,234.56` are strings a reader is *shown* and may
 * retype verbatim — which makes this function and the formatter above one contract with two
 * halves, and a change to `FORMATTERS` that this cannot parse is a change that breaks a box
 * nobody edited. Two files can drift apart; two functions in one file are read together.
 *
 * It landed as a private copy in `AddToCollection.tsx` and a second, byte-identical private copy
 * in `EditCopy.tsx` — written by two agents on the same afternoon, from the same brief. That is
 * the duplication this module's own header was written about, arriving a third time, and the
 * drift it would have produced is the worst kind: silent, and in the fifth decimal place.
 *
 * **`undefined` is the whole point of the return type.** `purchase_price` is written through a
 * `coalesce(?, column)`, so an absent field leaves the row's own price where it was, while a `0`
 * overwrites it with a claim nobody made. A blank box, a half-typed separator and a word are all
 * the same answer here: say nothing.
 *
 * **A typed `0` is not that answer and is sent as it stands.** "It was free" is a fact about a
 * copy — a prize, a gift, a card out of somebody's spare box — and the reader had to press a key
 * to say it.
 *
 * **Text is stripped from the ends and never from between the digits** ({@link numeral}): a
 * currency symbol, a code or a word before or after the number goes (`USD 4.50`, `4,50 kr`), and
 * between its digits only a space or apostrophe used as a thousands mark may stand, and only
 * before a group of three (`1 234,50`, `1'234.50`). Anything else there refuses the whole text —
 * stripping it would glue the digits into another number (`1e3` → 13, `2 for 5` → 25,
 * `10 (paid 8)` → 108). **Any dash or minus sign refuses it too** (`-4`, `−4,50`): a negative is
 * no price anybody paid.
 *
 * **The separators are read off the digits rather than off a locale**, because no real price has
 * three decimals:
 *
 * - **both `.` and `,` present — the later one is the decimal point** and the other is grouping
 *   (`$1,234.50`, `1.234,50`);
 * - **one separator that appears more than once is grouping** (`1,234,567`, `1.234.567`);
 * - **a lone comma before exactly three digits is grouping** (`$1,500`, `12,000`);
 * - **a lone dot before exactly three digits is refused** (`1.500`, `1.125`) — a thousands figure
 *   in a Danish hand, and a three-decimal price in this app's own CSV, which writes `String(n)`.
 *   Either reading is a silent thousand-fold error for somebody, and a refusal is one the reader
 *   is told about ({@link unreadablePriceNote}, and the import preview's list);
 * - **a lone separator before any other number of digits is a decimal point** (`4,50`, `0,99`,
 *   `12.5`, `1.2345`) — which is the form this app's own CSV writes, so it round-trips.
 *
 * Grouping has to be well-formed to be read at all — a first group of one to three digits with no
 * leading zero, then groups of exactly three — and **anything else is refused rather than
 * guessed**: `1,2,3`, `1234,567`, and `0,500`, where reading five hundred would be the thousand-fold
 * error this rule exists to stop. A number silently wrong is worse than a field that took nothing.
 * Both of this app's formatters write `$1,234.56` and `€1,234.56`, which is the first arm.
 *
 * `PriceRange`'s `parsePrice` is the same shape over a different question — a *filter bound*,
 * where an empty end means "open" rather than "unstated" and no currency symbol ever appears
 * because that control has no hint to retype. Two meanings, two functions, deliberately.
 */
export function parsePurchasePrice(draft: string): number | undefined {
  const read = readSeparators(draft);
  if (read.kind !== "plain") return undefined;
  const value = Number(read.text);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * The sentence a purchase-price box draws under what it has just refused, or `null` when there is
 * nothing to say — a blank box, or one that reads.
 *
 * **Beside the parser so the two cannot disagree about which texts are refused**, and one
 * wording for both boxes. The ambiguous lone dot names both of its readings in spellings the
 * parser takes without a second thought, and **without rounding** — `12.125` is offered back as
 * `12.1250`, never a nearby `12.13`. Everything else gets the ordinary sentence, including `0.125`
 * and `1000.125`, which cannot be thousands figures and so have only one reading to offer.
 */
export function unreadablePriceNote(draft: string): string | null {
  if (draft.trim() === "" || parsePurchasePrice(draft) !== undefined) return null;
  const read = readSeparators(draft);
  return read.kind === "ambiguous"
    ? `Write ${read.thousands} or ${read.decimal} — "${draft.trim()}" could mean either.`
    : "That is not a price — try 12.50.";
}

/**
 * A recorded price as text {@link parsePurchasePrice} reads back as exactly that number — what the
 * edit box is seeded with and what a CSV's `Purchase price` cell holds.
 *
 * `String(n)` with one exception: a value with exactly three decimals gets a fourth, because
 * `1.125` is the ambiguous lone dot the parser refuses and `1.1250` is not. Without it a row priced
 * `1.125` — by an older build, a sync, or `1.1250` typed into the add popup — opened in its own
 * edit box as unreadable.
 */
export function priceText(value: number): string {
  const text = String(value);
  return /\.\d{3}$/.test(text) ? `${text}0` : text;
}

/** Any dash or minus sign — hyphen-minus, the Unicode dashes, U+2212. */
const DASH = /[-‐-―−]/;

/** A space of any kind (NBSP and U+202F included) or an apostrophe used as a thousands mark:
 *  after a digit and before a group of exactly three. */
const GROUP_GAP = /(?<=\d)[\s'’](?=\d{3}(?!\d))/gu;

/**
 * The number in a text — digits and separators only, from its first digit to its last — or
 * `undefined` when anything else stands between them.
 *
 * What is outside the first and last digit goes: a currency symbol, a code, a word. The one
 * character kept from outside is a separator directly before the first digit (`.99`), unless it
 * closes an abbreviation (`kr.4,50`). Between the digits only {@link GROUP_GAP} is removed; any
 * other character there — a letter, a bracket, a stray space — is a text this cannot read.
 */
function numeral(draft: string): string | undefined {
  if (DASH.test(draft)) return undefined;
  const first = draft.search(/\d/);
  if (first === -1) return undefined;
  let last = draft.length - 1;
  while (!/\d/.test(draft[last])) last -= 1;
  const leading =
    first > 0 && /[.,]/.test(draft[first - 1]) && !(first > 1 && /\p{L}/u.test(draft[first - 2]));
  const body = draft.slice(leading ? first - 1 : first, last + 1).replace(GROUP_GAP, "");
  return /^[\d.,]+$/.test(body) ? body : undefined;
}

/** Well-formed grouping by one separator: one to three digits with no leading zero, then one or
 *  more groups of exactly three. */
const GROUPED: Record<"." | ",", RegExp> = {
  ".": /^[1-9]\d{0,2}(?:\.\d{3})+$/,
  ",": /^[1-9]\d{0,2}(?:,\d{3})+$/,
};

/** What {@link readSeparators} made of a text: digits `Number` can read, the one refusal that
 *  has two readings, or a refusal. */
type Separated =
  | { kind: "plain"; text: string }
  | { kind: "ambiguous"; thousands: string; decimal: string }
  | { kind: "refused" };

/**
 * {@link parsePurchasePrice}'s rule, as a reading: grouping gone and the decimal point spelt `.`
 * when the text follows one of its arms. `ambiguous` is the lone dot before three digits when the
 * thousands reading is well-formed grouping, carrying both readings for
 * {@link unreadablePriceNote}.
 */
function readSeparators(draft: string): Separated {
  const text = numeral(draft);
  if (text === undefined) return { kind: "refused" };
  const cut = Math.max(text.lastIndexOf("."), text.lastIndexOf(","));
  if (cut === -1) return { kind: "plain", text };
  const mark = text[cut] as "." | ",";
  const other = mark === "." ? "," : ".";
  const whole = text.slice(0, cut);
  const tail = text.slice(cut + 1);
  if (whole.includes(other)) {
    // Both separators: `mark` is the decimal point, so it may appear once, and `other` groups.
    if (whole.includes(mark) || !GROUPED[other].test(whole)) return { kind: "refused" };
    return { kind: "plain", text: `${whole.split(other).join("")}.${tail}` };
  }
  if (whole.includes(mark) || (mark === "," && tail.length === 3)) {
    // Repeated, or a lone comma before exactly three digits: grouping, and nothing else.
    return GROUPED[mark].test(text)
      ? { kind: "plain", text: text.split(mark).join("") }
      : { kind: "refused" };
  }
  if (tail.length === 3) {
    // A lone dot before exactly three digits: a thousand and a decimal are both honest readings.
    // The decimal one is offered in a spelling that reads back exactly — a trailing zero dropped
    // (`1.500` → `1.50`) or one added (`1.125` → `1.1250`) — and never rounded.
    return GROUPED["."].test(text)
      ? {
          kind: "ambiguous",
          thousands: `${whole}${tail}`,
          decimal: tail.endsWith("0") ? `${whole}.${tail.slice(0, 2)}` : `${whole}.${tail}0`,
        }
      : { kind: "refused" };
  }
  return { kind: "plain", text: `${whole}.${tail}` };
}

/**
 * The provenance sentence, which has to name the marketplace **and get its source right**.
 *
 * It was a constant while there was only one answer. With five in the picker, a bare "prices as
 * of the last sync" would leave the reader to guess whose prices they are looking at — and the
 * whole point of the setting is that the answer changed.
 *
 * Two sentences now, because there are two sources and they are refreshed by different things.
 * TCGplayer's and Cardmarket's numbers ride in with the card data, so the card sync is what
 * dates them; Card Kingdom's and Mana Pool's are downloaded on their own schedule, and saying
 * "the last card-data sync" over those would point a reader at a date that has nothing to do
 * with the figure beside it. The exact stamp for a feed lives in Settings, where there is room
 * for it — see `MarketplacePanel`.
 */
export function pricesAsOf(marketplace: Marketplace): string {
  return marketplace.feed
    ? `${marketplace.label} prices as of the last price-feed refresh.`
    : `${marketplace.label} prices as of the last card-data sync.`;
}
