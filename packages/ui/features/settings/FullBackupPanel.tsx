import { useMutation } from "@tanstack/react-query";
import { Download, Upload } from "lucide-react";
import { useState } from "react";
import { ipc, ipcError } from "@/lib/ipc";
import { notify } from "@/lib/notifications";
import { cn } from "@/lib/utils";
import { PANEL_BUTTON } from "./controls";
import { PanelAlert } from "./panelChrome";

/** A full reload also discards persisted hook state and open editors that refer to replaced rows.
 *  Invalidating queries alone would leave those editors attached to the previous database. */
export function reloadAfterRestore(): void {
  window.location.reload();
}

/**
 * The host owns both file pickers and the destructive confirmation; no path crosses IPC.
 *
 * **What a finished export or restore did is a toast** (`@/lib/notifications`), and so a notice
 * in the inbox. Both write somewhere the reader cannot see from here — a ZIP on disk, or every
 * table in the database — and a restore then reloads the window, which takes any line drawn on
 * this panel down with it: the inbox is kept in `localStorage`, so the receipt is still there
 * after the reload. A refusal is a toast for the same reason. What stays on the panel is the one
 * line that is about *this* moment: the reload in progress, or a picker the reader closed, which
 * changed nothing and is not worth keeping.
 */
export function FullBackupPanel({ onRestored = reloadAfterRestore }: { onRestored?: () => void }) {
  const [note, setNote] = useState<string | null>(null);
  const operation = useMutation({
    mutationFn: (action: "export" | "import") =>
      action === "export" ? ipc.archiveExport() : ipc.archiveImport(),
    onMutate: () => setNote(null),
    onSuccess: (completed, action) => {
      if (!completed) {
        setNote(
          action === "export" ? "Export cancelled." : "Import cancelled. Your data is unchanged.",
        );
        return;
      }
      if (action === "export") {
        notify.success("Complete backup saved");
        return;
      }
      notify.success("Backup restored", {
        body: "All app data was replaced from the ZIP. Pair your devices again to resume sync.",
      });
      setNote("Backup restored. Reloading your data…");
      onRestored();
    },
    onError: (error, action) => {
      const title =
        action === "export" ? "Couldn't save the backup" : "Couldn't restore the backup";
      notify.error(title, { body: ipcError(error) });
    },
  });

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-medium">Complete backup</h3>
      <p className="text-sm text-dim">
        Export all your app data to a ZIP file, including collection, decks, wishlist, notes,
        settings and dashboard layout. Import a ZIP backup to restore it.
      </p>
      <p className="text-sm text-dim">
        Import replaces all current app data. You will be asked to confirm before anything is
        replaced. Export a backup first if you want to keep your current data.
      </p>
      <p className="text-xs text-dim">
        A complete backup is also saved automatically in data/backups before app updates and
        restores. Restoring requires a backup with the same database schema version and
        disconnects device sync; pair your devices again afterwards.
      </p>
      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          className={cn(PANEL_BUTTON, "border-border hover:bg-bg")}
          disabled={operation.isPending}
          aria-busy={operation.isPending && operation.variables === "export" ? true : undefined}
          onClick={() => operation.mutate("export")}
        >
          <Download className="size-4" aria-hidden="true" />
          {operation.isPending && operation.variables === "export" ? "Exporting…" : "Export ZIP…"}
        </button>
        <button
          type="button"
          className={cn(PANEL_BUTTON, "border-destructive text-destructive hover:bg-bg")}
          disabled={operation.isPending}
          aria-busy={operation.isPending && operation.variables === "import" ? true : undefined}
          onClick={() => operation.mutate("import")}
        >
          <Upload className="size-4" aria-hidden="true" />
          {operation.isPending && operation.variables === "import" ? "Importing…" : "Import ZIP…"}
        </button>
      </div>
      <PanelAlert tone="plain">{note}</PanelAlert>
    </div>
  );
}
