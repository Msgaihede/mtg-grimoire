/**
 * Rows the chosen fields cannot tell apart become one row, with the copies summed.
 *
 * **A correctness rule wearing a formatting hat.** The collection's grain keeps 2 NM and 1 LP
 * Lightning Bolt as two rows on purpose. A plain-text export has no condition channel, so
 * writing them as two lines produces a file that names one card twice — and a reader pasting
 * that into Moxfield gets a deck with a duplicate in it. Fold on what the file can actually
 * say, and the same two rows separate again the moment Condition is switched on.
 *
 * The two quantity fields are **summed, never keyed on**: they are what folding accumulates.
 *
 * **The chosen `fields` are not the only thing a writer can tell rows apart by — the optional
 * `discriminator` is for the rest.** A field is something the reader can switch on or off; a
 * *structural* fact — which section a line lands under, whether a bracket carries `{noDeck}` —
 * is something the writer branches on unconditionally, whether or not the field that names it
 * (`category`) is in the chosen set. Folding on `fields` alone can merge a Sideboard row into a
 * Main deck row: the merged row inherits the *first* card's section, so the caller's own
 * `formatExport` passes each format's own discriminator (`sectionOf` for the three that group or
 * prefix by it, category name **and** the active flag for Archidekt's `{noDeck}`) so a fold can
 * never cross a line the file itself draws.
 */
import { TRANSFER_FIELDS, type TransferFieldId } from "../fields";
import type { TransferCard } from "../TransferCard";

const SUMMED: readonly TransferFieldId[] = ["quantity", "tradelistQuantity"];

export function foldForFields(
  cards: readonly TransferCard[],
  fields: readonly TransferFieldId[],
  discriminator?: (card: TransferCard) => string,
): TransferCard[] {
  const keyed = fields.filter((id) => !SUMMED.includes(id));
  // A Map preserves insertion order, which is what keeps the caller's order the file's order.
  const out = new Map<string, TransferCard>();
  for (const card of cards) {
    // JSON rather than a joined string: it escapes, so no separator a card name — or a
    // discriminator's own return value — could contain can make two different rows share one
    // key. The discriminator rides as one more entry in the same flat array as the fields, not
    // nested — a nested array would still be safe, but flat is what the rest of this file reads.
    const key = JSON.stringify([
      ...keyed.map((id) => TRANSFER_FIELDS[id].read(card)),
      discriminator?.(card) ?? "",
    ]);
    const seen = out.get(key);
    if (seen === undefined) {
      out.set(key, { ...card });
      continue;
    }
    seen.quantity += card.quantity;
    // `null` is absence, not poison: it contributes nothing to the sum but must never suppress
    // one. A group where every row is `null` stays `null` — the surface never had the fact — but
    // one known value anywhere in the group has to survive, whichever row it arrived on.
    seen.tradelistQuantity =
      seen.tradelistQuantity === null && card.tradelistQuantity === null
        ? null
        : (seen.tradelistQuantity ?? 0) + (card.tradelistQuantity ?? 0);
  }
  return [...out.values()];
}
