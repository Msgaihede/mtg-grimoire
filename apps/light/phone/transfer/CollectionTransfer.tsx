import { useMemo, useState } from "react";
import { UndoNotice } from "@grimoire/ui/components/UndoNotice";
import {
  everythingLabel,
  scopeLabel,
  useExportScope,
  type CollectionScopeFilters,
  type ExportFiling,
} from "@grimoire/ui/features/transfer/export/scope";
import { count } from "@grimoire/ui/lib/counts";
import { useMarketplace } from "@grimoire/ui/lib/useMarketplace";
import { cn } from "@grimoire/ui/lib/utils";
import { phoneCollectionDestination } from "./destinations";
import { ExportSheet } from "./ExportSheet";
import { ImportSheet } from "./ImportSheet";
import { TransferPair } from "./TransferPair";

/**
 * **The collection's import and export, on the phone** — a self-contained piece for the
 * collection page's header: the joined pair, the two sheets it opens, and the undo the last
 * import left behind.
 *
 * The desktop page's own arrangement, read across. **Import** has one destination — the
 * collection — so its sheet draws no radios, and its second step is the desktop's own
 * `CollectionPreview` (store-free, over this face's remembered condition and finish): the same
 * plan, the same Add / Set modes, the same `collection_import_commit` and its invalidations.
 * **Export** is `useExportScope`'s paged sweep of whatever `filters` the host hands in — the wall it
 * draws, the desktop's rule — gated on the sheet being open, so nothing is swept until the reader
 * asks; with no `filters` it is the whole collection.
 *
 * **What the import did is the desktop's undo notice**, `UndoNotice` over `@/lib/bulkUndo`: the
 * preview puts the ticket and its sentence there as it does on the desktop, and this draws it
 * under the pair — `Imported 40 cards.` and `Undo`. A host page that already draws the
 * collection's notice for its own bulk writes passes `undoNotice={false}`, so one notice is not
 * drawn twice.
 */
export function CollectionTransfer({
  filters,
  filing,
  undoNotice = true,
  className,
}: {
  /**
   * What the export sweeps — the collection page's own `filters`, shelves included, so an export
   * is what the wall covers. Absent: every card the reader owns.
   */
  filters?: CollectionScopeFilters;
  /** Where the reader is standing, for the export's two sentences (`scopeLabel`). */
  filing?: ExportFiling;
  undoNotice?: boolean;
  className?: string;
}) {
  const { marketplace } = useMarketplace();
  const [importing, setImporting] = useState(false);
  const [exporting, setExporting] = useState(false);

  // The whole collection, quoted at the reader's marketplace, where the host names no narrower
  // sweep — `marketplace` is which price a row is quoted at, never a filter.
  const everything = useMemo<CollectionScopeFilters>(
    () => ({ marketplace: marketplace.id }),
    [marketplace.id],
  );
  const scope = useExportScope("collection", filters ?? everything, exporting);

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <TransferPair
        importLabel="Import cards into your collection"
        exportLabel="Export your collection"
        onImport={() => setImporting(true)}
        onExport={() => setExporting(true)}
        className="self-start"
      />
      {undoNotice && <UndoNotice scope="collection" className="empty:-mt-2" />}

      <ImportSheet
        open={importing}
        destination={phoneCollectionDestination}
        subtitle="Into your collection"
        onClose={() => setImporting(false)}
        // The preview's numbers were the reader's to read before they pressed, and the undo
        // notice says what landed — the desktop page discards this sentence for the same reason.
        onDone={() => setImporting(false)}
      />
      <ExportSheet
        open={exporting}
        subject="your collection"
        surface="collection"
        cards={scope.cards}
        suggestedFileName="collection"
        scope={{
          // With no filters handed in the sweep is already everything, so the count line names
          // the whole collection and there is no box to widen it: `scopeLabel`'s "matching your
          // filters" would be a sentence about filters nobody set.
          label:
            filters === undefined
              ? `${count(scope.total)} ${scope.total === 1 ? "card" : "cards"} in your collection`
              : scopeLabel(scope.total, scope.everything, filing),
          loading: scope.loading,
          error: scope.error,
          onRetry: scope.retry,
          widen:
            filters === undefined
              ? undefined
              : {
                  label: everythingLabel(filing),
                  everything: scope.everything,
                  onEverything: scope.setEverything,
                },
        }}
        onClose={() => setExporting(false)}
      />
    </div>
  );
}
