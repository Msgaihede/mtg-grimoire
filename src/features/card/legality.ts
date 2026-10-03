import { plural } from "@/lib/counts";
import { FORMAT_ORDER } from "./printings";

/**
 * A card's format legality as rows a surface can draw — **the pure half of `LegalityDialog`**,
 * split out so the phone face's card sheet reads the same grid without reaching the desktop's
 * store through that dialog.
 *
 * Everything here is a decision about *what the rows are and what they say*: which formats, in
 * what order, under what names, with which word and which colour per status. How they are laid
 * out is each surface's own — the dialog draws a two-column grid at 640px of panel, the phone
 * sheet a single column — and a second copy of any of these tables would be a second answer to
 * "what is `paupercommander` called".
 */

/**
 * The colour of one status badge — `CardDetailPane`'s `STATUS_CLASS` **adapted**, not imported.
 *
 * Adapted in two ways, and both follow from the grid drawing what the pane's chips could not.
 *
 * **`not_legal` is here at all**, which is the whole point of the surface, and it is the quiet
 * one: it is most of the grid on most cards — the pane measured 11.3 of 23 keys *surviving* its
 * filter over the dev corpus on 2026-08-20 — so it is the ground the other three are read
 * against. The pane had the opposite problem: with `not_legal` filtered out, *legal* was the
 * quiet case and got no ink.
 *
 * **`legal` therefore takes `--color-ok`.** That token was added when the deck check became a
 * glyph and its two states had to be told apart without words, which is this question one level
 * up, and it is tuned to *state* a clean answer rather than celebrate it — a peer of
 * `--destructive` rather than one of the mana greens, which are for chips and pips and never for
 * text. Gold stays unspent here for the pane's reason: it is the app's interactive colour and a
 * column of gold badges would out-shout the focus ring that has to mean something.
 *
 * `restricted` keeps full-strength text and a plain border. It is not a milder ban — it is a
 * card you may play *one* of — so it must not sit beside `not_legal` looking the same; the word
 * is what carries it, and the weight is what lets the eye find the word.
 */
export const STATUS_CLASS: Record<string, string> = {
  legal: "border-ok/40 text-ok",
  not_legal: "border-border/60 text-dim",
  restricted: "border-border text-text",
  banned: "border-destructive/40 text-destructive",
};

/**
 * The word on the badge, per status.
 *
 * A map rather than a `replace("_", " ")`, because the four values are a closed vocabulary
 * Scryfall publishes and a transformation would silently invent a label for a fifth. An
 * unrecognised status falls through to the raw value, which is how anybody would find out one
 * had arrived.
 */
export const STATUS_WORD: Record<string, string> = {
  legal: "Legal",
  not_legal: "Not legal",
  restricted: "Restricted",
  banned: "Banned",
};

/** A status neither map knows: drawn, dim, and saying whatever word Scryfall sent. */
export const UNKNOWN_STATUS_CLASS = "border-border/60 text-dim";

/** The badge class for a status, known or not. */
export const statusClass = (status: string): string => STATUS_CLASS[status] ?? UNKNOWN_STATUS_CLASS;

/** The badge word for a status, known or not. */
export const statusWord = (status: string): string => STATUS_WORD[status] ?? status;

/** One row of the grid: the key `cards.legalities` carries, and what it says. */
export interface LegalityRow {
  format: string;
  status: string;
}

/**
 * The formats whose name is **not** their key with a capital letter. Everything else is handled
 * by the rule in {@link formatLabel} rather than listed here, so this table is the exceptions and
 * a count of it is a thing the lines below answer.
 *
 * ## Why this is not read from `format_specs`
 *
 * That table is the obvious answer and it was written that way first: `schema::migrate` seeds all
 * 25 rows with a `display_name` beside every other rule those formats are judged by, and
 * `has_legality_data` is literally the column saying which of them appear in this blob. Two
 * things sent it back.
 *
 * **The workbench answers twelve of the twenty-five.** `.storybook/fake/db.ts`'s
 * `format_specs_list` is served from `validation/fixtures.ts`, deliberately — that file is
 * already a hand-copied mirror of the seed and a second mirror is a second place for a cell to
 * drift — and it carries the 12 rows the deck engine's tests need (its own doc says so, measured
 * 2026-08-09). A grid drawing every format through it would therefore show about half its rows as
 * **slugs** in Storybook: `standardbrawl`, `predh`, `oldschool`. That is a page every reader of it
 * would file as a bug, and it would be right to.
 *
 * **And it is a query.** `format_specs` is `staleTime: Infinity` but it is still a read that has
 * not landed on the render a popup opens, so the grid would either flash slugs for a frame or
 * hold a settings-table spinner over a card the modal behind it has already drawn. A name that
 * cannot be spoken synchronously is the wrong shape for this surface.
 *
 * What is given up is real and small: these are proper nouns that have not moved in a decade, and
 * a divergence from the seed is cosmetic rather than a wrong answer. If a third surface ever needs
 * format names outside the deck feature, that is the moment to lift one shared table — the phone
 * sheet is the second reader, and it reads *this* one.
 */
const FORMAT_LABEL: Record<string, string> = {
  future: "Future Standard",
  penny: "Penny Dreadful",
  standardbrawl: "Standard Brawl",
  competitivebrawl: "Competitive Brawl",
  paupercommander: "Pauper Commander",
  duel: "Duel Commander",
  oldschool: "Old School",
  predh: "PreDH",
  tlr: "Tiny Leaders: Reborn",
};

/**
 * What one format key is called.
 *
 * The rule is the first letter, because Scryfall's keys are lowercase and most of them are one
 * word — and because it is also the right answer for a format that lands *after* this build:
 * `explorer` reads as `Explorer` rather than as a slug. A **new multi-word**
 * key is the case the rule gets visibly wrong (`Standardbrawl`), which is the tell that
 * {@link FORMAT_LABEL} needs a line, and it is a better failure than dropping the row — Scryfall
 * adds formats without asking, and a grid that silently omitted one would be wrong in exactly the
 * direction this whole surface exists to prevent.
 *
 * Capitalised in **JS and not with a `capitalize` class**: the word is the answer here, and a
 * status a reader can only get by looking at rendered pixels is the thing the badge beside it
 * refuses to do.
 */
export function formatLabel(format: string): string {
  return FORMAT_LABEL[format] ?? format.charAt(0).toUpperCase() + format.slice(1);
}

/**
 * Every format in the blob, in the order it should be read.
 *
 * **Nothing is filtered.** The only rows dropped are entries whose value is not a string, which
 * is a blob that is not the shape it claims rather than a card with fewer formats.
 *
 * `FORMAT_ORDER` is Scryfall's own emission order and is a **display order, not a schema**: a key
 * it has never heard of ranks last and is drawn rather than dropped, because Scryfall adds
 * formats without asking and a grid that silently omitted one would be wrong in the direction
 * this whole surface exists to prevent. `sort` is stable, so several unknown keys keep the order
 * the blob listed them in.
 */
export function legalityRows(legalitiesJson: string | null): LegalityRow[] {
  if (!legalitiesJson) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(legalitiesJson);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null) return [];

  const rank = (format: string) => {
    const i = FORMAT_ORDER.indexOf(format as (typeof FORMAT_ORDER)[number]);
    return i === -1 ? FORMAT_ORDER.length : i;
  };
  return Object.entries(parsed as Record<string, unknown>)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .sort((a, b) => rank(a[0]) - rank(b[0]))
    .map(([format, status]) => ({ format, status }));
}

/**
 * The one-line answer a folded grid stands on — **how many formats a card may be played in,
 * out of how many the blob names**, and, where there are any, how many ban it.
 *
 * It is what lets a surface with no room for 23 rows draw the grid behind a disclosure without
 * making absence the answer: `LegalityDialog`'s whole argument is that a format missing from the
 * grid reads as data that failed to load, and a count of the rows that are not on screen is a
 * statement about them rather than a silence. `restricted` counts as playable — it is a card you
 * may play one of — which is why it is not folded in with the bans.
 *
 * `null` for no rows at all: there is nothing to count, and the surface already has a sentence of
 * its own for a card Scryfall lists no formats for.
 */
export function legalitySummary(rows: readonly LegalityRow[]): string | null {
  if (rows.length === 0) return null;
  const playable = rows.filter((r) => r.status === "legal" || r.status === "restricted").length;
  const banned = rows.filter((r) => r.status === "banned").length;
  const base = `Legal in ${playable} of ${plural(rows.length, "format")}`;
  return banned > 0 ? `${base} · banned in ${banned}` : base;
}
