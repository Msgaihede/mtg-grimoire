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
 */
import { TRANSFER_FIELDS, type TransferFieldId } from "../fields";
import type { TransferCard } from "../TransferCard";

const SUMMED: readonly TransferFieldId[] = ["quantity", "tradelistQuantity"];

export function foldForFields(
  cards: readonly TransferCard[],
  fields: readonly TransferFieldId[],
): TransferCard[] {
  const keyed = fields.filter((id) => !SUMMED.includes(id));
  // A Map preserves insertion order, which is what keeps the caller's order the file's order.
  const out = new Map<string, TransferCard>();
  for (const card of cards) {
    // JSON rather than a joined string: it escapes, so no separator a card name could
    // contain can make two different rows share one key.
    const key = JSON.stringify(keyed.map((id) => TRANSFER_FIELDS[id].read(card)));
    const seen = out.get(key);
    if (seen === undefined) {
      out.set(key, { ...card });
      continue;
    }
    seen.quantity += card.quantity;
    if (seen.tradelistQuantity !== null && card.tradelistQuantity !== null) {
      seen.tradelistQuantity += card.tradelistQuantity;
    }
  }
  return [...out.values()];
}
