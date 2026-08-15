/**
 * A pile of cards as text.
 *
 * The mirror of `../import/parse.ts`, and bound by that file's rules read backwards: **`//` is
 * part of a card name** (`Branchloft Pathway // Boulderloft Pathway` is one card, and seven
 * such names are in the importer's own reference list), so nothing here may cut one; and what
 * this writes has to be something that parser reads, which is what the round-trip test pins.
 *
 * LF and a trailing newline, always. The parser takes CRLF, a lone LF and a lone CR, so it
 * would read any of them — but a file this app wrote should have one answer, and `\n` is the
 * one every other tool in this space emits.
 *
 * **A format is a whole file rather than a row of lines**, which is why there is no
 * `Record<ExportFormat, (card) => string>` here any more: three of the six write *headings* as
 * well as lines, and two of those decide which headings exist by grouping the input. What is
 * left of that record is the per-line writers — {@link plainLine}, {@link printedLine},
 * {@link archidektLine} — assembled by {@link formatExport}'s one switch, which is also the
 * only place that knows a format writes sections at all.
 *
 * An empty list is an empty string in every format, **CSV included**. A header row over no
 * rows is a file that claims to be a decklist and is not one. **That now covers a list a
 * format empties for itself**: Arena and MTGO write only switched-on piles, so a deck that is
 * entirely maybeboard is an empty file in those two rather than a heading over nothing —
 * {@link omittedCount} is what says so out loud.
 */
import type { CategoryKind, DeckCard } from "@/lib/ipc";

export const EXPORT_FORMATS = ["plain", "mtgo", "arena", "moxfield", "archidekt", "csv"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export const EXPORT_FORMAT_LABEL: Record<ExportFormat, string> = {
  plain: "Plain text",
  mtgo: "MTGO",
  arena: "Arena",
  moxfield: "Moxfield",
  archidekt: "Archidekt",
  csv: "CSV",
};

export const EXPORT_FORMAT_EXTENSION: Record<ExportFormat, string> = {
  plain: "txt",
  mtgo: "txt",
  arena: "txt",
  moxfield: "txt",
  archidekt: "txt",
  csv: "csv",
};

/**
 * What a card needs to be exported — a `Pick` of `DeckCard`, so a whole one satisfies it.
 *
 * The three category fields are what a *deck* export needs and a category export never did: a
 * pile has one name, one kind and one switch, so a single-pile caller passes rows that all agree
 * and every grouped format writes it as one section.
 */
export type ExportCard = Pick<
  DeckCard,
  | "name"
  | "quantity"
  | "setCode"
  | "collectorNumber"
  | "categoryName"
  | "categoryKind"
  | "categoryActive"
>;

/** The maybeboard's heading, spelled once — it is `SECTION_CATEGORY.maybeboard`'s word read
 *  backwards, and the importer's `SECTIONS` map is what reads it. */
const MAYBEBOARD = "Maybeboard";

/**
 * What a kind is called in a format whose section vocabulary is fixed.
 *
 * **Total over {@link CategoryKind}, with no arm for `maybe` in the sense the word suggests** —
 * nothing anywhere may branch on a kind being `maybe`, and this does not: a pile whose kind is
 * `maybe` but which the reader has switched **on** counts toward the deck like any other, so it
 * writes under `Deck`. {@link sectionOf} is where a switched-*off* pile becomes a maybeboard, and
 * it asks `categoryActive` rather than the kind, which is the whole of what `is_active = 0`
 * means. Rewriting this entry to `Maybeboard` "because that is what it is called" is the bug
 * that rule exists to keep out — it would file a switched-on Maybeboard out of the deck it
 * counts toward, and leave a reader's own switched-off `Ramp` under `Deck` beside it.
 */
const KIND_SECTION: Record<CategoryKind, string> = {
  commander: "Commander",
  companion: "Companion",
  main: "Deck",
  side: "Sideboard",
  maybe: "Deck",
};

/**
 * The order sections come out in.
 *
 * **Deliberately not `sortOptions` — one of the exceptions `lib/options.ts` names, the kind
 * whose order *is* the information.** It is the order a decklist is read in, from the zone the
 * game starts with down to the cards that are not in the deck at all; alphabetically it would
 * open on `Commander`, then `Companion`, `Deck`, `Maybeboard`, `Sideboard`, which puts the cards
 * that count toward nothing in the middle of the ones that do.
 */
const SECTION_ORDER: readonly string[] = [
  "Commander",
  "Companion",
  "Deck",
  "Sideboard",
  MAYBEBOARD,
];

/** The section a card writes under in a fixed-vocabulary format. */
function sectionOf(card: ExportCard): string {
  return card.categoryActive ? KIND_SECTION[card.categoryKind] : MAYBEBOARD;
}

/**
 * The formats with no maybeboard, which therefore write **only** the piles that are switched on.
 *
 * One set rather than the same two-name test written at each of its two readers: {@link written}
 * and {@link omittedCount} are the two halves of one rule — what is left out, and how much of it
 * — and a drift between them is a number on screen that quietly stops describing the file.
 *
 * The test is `categoryActive` and never the kind: `is_active = 0` is the whole of what a
 * maybeboard is, and a reader's own switched-off pile behaves the same way.
 */
const ACTIVE_ONLY: ReadonlySet<ExportFormat> = new Set<ExportFormat>(["arena", "mtgo"]);

/**
 * A CSV field, quoted when it carries a comma, a quote or a newline — and never otherwise, so
 * `Lightning Bolt` stays `Lightning Bolt` rather than becoming `"Lightning Bolt"` on every row.
 * An inner quote doubles, which is the escape RFC 4180 (and every spreadsheet reading this
 * file) agrees on.
 */
function csvField(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

const CSV_HEADER = "Quantity,Name,Set,Collector number,Category";

/** `quantity name`, with nothing about the printing — the shape a plain paste and MTGO share. */
function plainLine(card: ExportCard): string {
  return `${card.quantity} ${card.name}`;
}

/**
 * `quantity name (SET) collectorNumber` — the shape Moxfield and Arena share, and the one that
 * names a printing rather than just a card. The set code is uppercased for the same reason the
 * importer uppercases the one it reads: `(ltc)` and `(LTC)` are the same set and a decklist
 * should pick one spelling rather than echo whatever case this row happened to store.
 */
function printedLine(card: ExportCard): string {
  return `${card.quantity} ${card.name} (${card.setCode.toUpperCase()}) ${card.collectorNumber}`;
}

/**
 * Archidekt's line: `1x`, a **lowercase** set code, and the pile in brackets.
 *
 * Lowercase against every other writer here on purpose — it is what Archidekt itself emits, and
 * the point of a format named for a site is that the site reads it back. Our own parser
 * uppercases what it reads, so the round trip is unaffected either way.
 *
 * `{noDeck}` on a switched-off pile is what makes an export and a re-import keep a maybeboard.
 * It is the only format here that can say it — which is why Archidekt is the one format that
 * writes an inactive pile *and* leaves nothing out.
 */
function archidektLine(card: ExportCard): string {
  const flag = card.categoryActive ? "" : "{noDeck}";
  const set = card.setCode.toLowerCase();
  return `${card.quantity}x ${card.name} (${set}) ${card.collectorNumber} [${card.categoryName}${flag}]`;
}

/**
 * The cards a format will not write, in **copies**.
 *
 * Only `arena` and `mtgo` leave anything out, and only a pile the reader has switched off:
 * neither format has a maybeboard, and writing one into an Arena deck produces an illegal import
 * at the other end. The dialog draws this number, so the omission is never silent.
 *
 * Copies rather than rows because that is the sentence the reader is owed — six basic lands on
 * one row are six cards missing from the file, and "1 card" would be a true statement about the
 * array and a false one about the deck.
 */
export function omittedCount(cards: readonly ExportCard[], format: ExportFormat): number {
  if (!ACTIVE_ONLY.has(format)) return 0;
  return cards.reduce((n, card) => (card.categoryActive ? n : n + card.quantity), 0);
}

/** The cards a format writes, in the caller's own order. */
function written(cards: readonly ExportCard[], format: ExportFormat): readonly ExportCard[] {
  if (!ACTIVE_ONLY.has(format)) return cards;
  return cards.filter((card) => card.categoryActive);
}

/**
 * Cards under headings: one group per key, **in first-appearance order** unless an order is
 * given.
 *
 * First appearance is what keeps this file pure — the caller's array order is the file's order,
 * so a deck's own category order needs no second argument and no `DeckCategory` here.
 */
function grouped(
  cards: readonly ExportCard[],
  keyOf: (card: ExportCard) => string,
  order?: readonly string[],
): [string, ExportCard[]][] {
  const groups = new Map<string, ExportCard[]>();
  for (const card of cards) {
    const key = keyOf(card);
    const existing = groups.get(key);
    if (existing) existing.push(card);
    else groups.set(key, [card]);
  }
  const entries = [...groups];
  if (order === undefined) return entries;
  return entries.sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]));
}

/** Sections joined the way every export in scope writes them: a heading, its lines, a blank. */
function sections(groups: [string, ExportCard[]][], write: (card: ExportCard) => string): string {
  return groups.map(([name, cards]) => [name, ...cards.map(write)].join("\n")).join("\n\n");
}

/**
 * Render a pile of cards as decklist text in one of {@link EXPORT_FORMATS}.
 *
 * An empty list is `""` in every format, CSV's header included — a header with nothing under
 * it is a file that claims to be a decklist and is not one. **A list a format empties for
 * itself answers the same way**: the filter runs first, so an Arena export of a deck that is
 * entirely maybeboard is `""` rather than a `Deck` heading over nothing. Every non-empty result
 * ends in a single trailing `\n`.
 */
export function formatExport(cards: readonly ExportCard[], format: ExportFormat): string {
  const rows = written(cards, format);
  if (rows.length === 0) return "";

  let text: string;
  switch (format) {
    case "plain":
      text = rows.map(plainLine).join("\n");
      break;
    case "mtgo":
      // MTGO's own export omits the printing entirely — it resolves a name against whatever
      // copies a player owns rather than pinning one, so naming a set here would be a promise
      // this format was never in a position to keep. `SB:` is a one-line override rather than a
      // heading, which is exactly how the importer reads it back.
      text = rows
        .map((card) => {
          const section = sectionOf(card);
          const prefix = section === "Sideboard" || section === "Companion" ? "SB: " : "";
          return prefix + plainLine(card);
        })
        .join("\n");
      break;
    case "arena":
    case "moxfield":
      // One arm for both: the two sites write the same lines under the same fixed headings, and
      // they differ only in what reaches here — `written` has already taken the switched-off
      // piles out of Arena's, so its `Maybeboard` section can never be produced.
      text = sections(grouped(rows, sectionOf, SECTION_ORDER), printedLine);
      break;
    case "archidekt":
      // Grouped by the pile's own name rather than by a section word, because this is one of the
      // two formats with somewhere to put it. No order argument: the caller's array order is a
      // deck's category order, and imposing one here would re-file somebody's deck on the way
      // out.
      text = sections(
        grouped(rows, (card) => card.categoryName),
        archidektLine,
      );
      break;
    case "csv":
      text = [
        CSV_HEADER,
        ...rows.map((card) =>
          [
            String(card.quantity),
            csvField(card.name),
            csvField(card.setCode),
            csvField(card.collectorNumber),
            csvField(card.categoryName),
          ].join(","),
        ),
      ].join("\n");
      break;
  }
  return text + "\n";
}
