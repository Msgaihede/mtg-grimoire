import { useMutation, useQueryClient } from "@tanstack/react-query";
import { autoCategoryFor } from "@/features/decks/autoCategory";
import { ipc, type DeckInput, type DeckRow, type ImportItem, type ScannerTrayRow } from "@/lib/ipc";
import { DEFAULT_MARKETPLACE } from "@/lib/marketplace";
import { invalidateOwnedWrite } from "@/lib/searchMarks";
import { isKnownFinish } from "./reader/trayFinish";

/**
 * Make a deck from the tray snapshot the dialog opened with. Scanning may continue behind the
 * dialog, so neither new scans nor edits to the current tray change the list being created.
 * The tray stays available for the separate, atomic Add to collection gesture.
 */
export function useScannedDeck(rows: readonly ScannerTrayRow[]) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: DeckInput): Promise<DeckRow> => {
      if (rows.length === 0) throw new Error("Scan at least one card before creating a deck.");
      const snapshot = rows.map((row) => {
        if (!row.cardId || row.choices.length > 0) {
          throw new Error(`${row.name} is still waiting for a printing to be picked.`);
        }
        if (!isKnownFinish(row.finish)) {
          throw new Error(`${row.name} has no finish yet. Pick one before creating a deck.`);
        }
        if (!Number.isInteger(row.quantity) || row.quantity < 1) {
          throw new Error(`${row.name} must have at least one copy.`);
        }
        return {
          cardId: row.cardId,
          quantity: row.quantity,
          finish: row.finish === "nonfoil" ? null : row.finish,
        };
      });
      const ids = [...new Set(snapshot.map((row) => row.cardId))];
      // Tray rows carry no type line. Read the exact printing, never resolve its name to a
      // different edition; the marketplace only prices fields this operation does not use.
      const cards = await Promise.all(ids.map((id) => ipc.cardDetail(id, DEFAULT_MARKETPLACE)));
      const types = new Map<string, string | null>();
      cards.forEach((card, index) => {
        if (card === null) {
          throw new Error("A scanned printing is no longer in the card database. Pick it again.");
        }
        types.set(ids[index], card.typeLine);
      });
      const tags = new Map<string, string[]>();
      try {
        for (const answer of await ipc.oracleTagsForPrintings(ids)) {
          tags.set(answer.cardId, answer.slugs);
        }
      } catch {
        // A taxonomy refresh must not strand a scan: autoCategoryFor supports type-line filing.
      }
      const items: ImportItem[] = snapshot.map((row) => ({
        cardId: row.cardId,
        quantity: row.quantity,
        finish: row.finish,
        categoryName: autoCategoryFor({
          typeLine: types.get(row.cardId) ?? null,
          oracleTags: tags.get(row.cardId),
        }),
      }));
      const deck = await ipc.deckCreate(input);
      try {
        await ipc.deckImportCommit(deck.id, "live", "merge", items);
      } catch (refusal) {
        try {
          await ipc.deckDelete(deck.id);
        } catch {
          // Match the importer: preserve the commit's refusal if cleanup also fails.
        }
        throw refusal;
      }
      return deck;
    },
    onSettled: () => invalidateOwnedWrite(queryClient),
  });
}
