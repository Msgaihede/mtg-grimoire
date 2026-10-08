import { useMutation } from "@tanstack/react-query";
import { Download, Upload } from "lucide-react";
import { useState } from "react";
import { ipc, ipcError } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { PANEL_BUTTON } from "./controls";
import { PanelAlert } from "./panelChrome";

/** A full reload also discards persisted hook state and open editors that refer to replaced rows.
 *  Invalidating queries alone would leave those editors attached to the previous database. */
export function reloadAfterRestore(): void {
  window.location.reload();
}

/** The host owns both file pickers and the destructive confirmation; no path crosses IPC. */
export function FullBackupPanel({ onRestored = reloadAfterRestore }: { onRestored?: () => void }) {
  const [note, setNote] = useState<{ tone: "plain" | "problem"; text: string } | null>(null);
  const operation = useMutation({
    mutationFn: (action: "export" | "import") =>
      action === "export" ? ipc.archiveExport() : ipc.archiveImport(),
    onMutate: () => setNote(null),
    onSuccess: (completed, action) => {
      setNote({
        tone: "plain",
        text: completed
          ? action === "export"
            ? "Complete backup saved."
            : "Backup restored. Reloading your data…"
          : action === "export"
            ? "Export cancelled."
            : "Import cancelled. Your data is unchanged.",
      });
      if (completed && action === "import") onRestored();
    },
    onError: (error) => setNote({ tone: "problem", text: ipcError(error) }),
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
      <PanelAlert tone={note?.tone ?? "plain"}>{note?.text ?? null}</PanelAlert>
    </div>
  );
}
