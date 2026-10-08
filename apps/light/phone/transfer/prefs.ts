/**
 * What the phone face remembers about transfers for the session: each surface's export format,
 * fields and two filters, and the import's condition and finish fallbacks.
 *
 * **The desktop keeps the same answers in `useAppStore`**, which this face may not import
 * (`fence.test.ts`). So the phone holds its own, opening on **the same values**
 * (`@/features/transfer/prefs`, which the desktop store opens on too) and with the same grain:
 * export settings per surface, one shared import pair. Session state on both faces — no stored
 * row behind either — so the only thing a crossing of the 1024px floor loses is a choice made
 * since the app opened, which is what `apps/light/CLAUDE.md` already says a crossing costs.
 *
 * Its own small store rather than a provider's state, `@/lib/bulkUndo`'s arrangement: the import
 * and export sheets are mounted by several pages and must all read one answer.
 */
import { create } from "zustand";
import type { TransferSurface } from "@/features/transfer/fields";
import {
  INITIAL_EXPORT_PREFS,
  INITIAL_IMPORT_DEFAULTS,
  type ExportPrefs,
  type ImportDefaults,
} from "@/features/transfer/prefs";

interface PhoneTransferPrefs {
  exportPrefs: Record<TransferSurface, ExportPrefs>;
  setExportPrefs: (surface: TransferSurface, prefs: ExportPrefs) => void;
  importDefaults: ImportDefaults;
  setImportDefaults: (defaults: ImportDefaults) => void;
}

export const usePhoneTransferPrefs = create<PhoneTransferPrefs>((set) => ({
  exportPrefs: INITIAL_EXPORT_PREFS,
  setExportPrefs: (surface, prefs) =>
    set((s) => ({ exportPrefs: { ...s.exportPrefs, [surface]: prefs } })),
  importDefaults: INITIAL_IMPORT_DEFAULTS,
  setImportDefaults: (importDefaults) => set({ importDefaults }),
}));
