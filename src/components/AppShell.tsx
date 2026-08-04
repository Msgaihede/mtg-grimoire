import type { ReactNode } from "react";
import {
  Heart,
  Layers,
  LibraryBig,
  RefreshCw,
  Search,
  Settings,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import { SyncProgress } from "@/components/SyncProgress";
import { useAppStore, type ViewId } from "@/lib/store";
import { statusLine, useSync } from "@/lib/useSync";
import { cn } from "@/lib/utils";

const NAV: { id: ViewId; label: string; Icon: LucideIcon }[] = [
  { id: "search", label: "Search", Icon: Search },
  { id: "collection", label: "Collection", Icon: LibraryBig },
  { id: "wishlist", label: "Wishlist", Icon: Heart },
  { id: "decks", label: "Decks", Icon: Layers },
  { id: "settings", label: "Settings", Icon: Settings },
];

/**
 * The window: sidebar, header, and whatever view the store points at.
 *
 * Owns the sync status because both things that need it live here — the header's summary
 * line and Refresh button, and the progress overlay — and one poll for the whole app is
 * the point of the arrangement.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const activeView = useAppStore((s) => s.activeView);
  const setActiveView = useAppStore((s) => s.setActiveView);
  const { status, error, refresh, refreshing } = useSync();

  const line = statusLine(status);
  // Either this window started the sync or something else did (the run spawned at
  // startup, most often). A second `sync_run` would only be refused.
  const busy = refreshing || status?.syncing === true;

  return (
    <div className="flex h-screen overflow-hidden bg-bg text-text">
      <nav
        aria-label="Views"
        className="flex w-52 shrink-0 flex-col gap-1 border-r border-border bg-surface p-3"
      >
        {NAV.map(({ id, label, Icon }) => {
          const active = id === activeView;
          return (
            <button
              key={id}
              type="button"
              onClick={() => setActiveView(id)}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm transition-colors",
                active ? "bg-bg text-accent" : "text-muted hover:bg-bg/60 hover:text-text",
              )}
            >
              <Icon className="size-4 shrink-0" aria-hidden="true" />
              {label}
            </button>
          );
        })}
      </nav>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex shrink-0 items-baseline gap-4 border-b border-border px-5 py-3">
          <h1 className="font-heading text-base font-medium">MTG Collection Tracker</h1>
          {line && <p className="truncate text-xs text-muted">{line}</p>}
          <button
            type="button"
            onClick={refresh}
            disabled={busy}
            aria-busy={busy || undefined}
            className="ml-auto inline-flex shrink-0 items-center gap-2 self-center rounded-md border border-border px-3 py-1.5 text-sm transition-colors hover:bg-surface disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
          >
            <RefreshCw className={cn("size-4", busy && "animate-spin")} aria-hidden="true" />
            Refresh
          </button>
        </header>

        <SyncProgress cardCount={status?.cardCount ?? null} />

        {error && (
          <div
            role="alert"
            className="flex shrink-0 items-start gap-2 border-b border-destructive/40 bg-destructive/10 px-5 py-2 text-sm text-destructive"
          >
            <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span className="min-w-0">{error}</span>
          </div>
        )}

        <main className="min-h-0 flex-1 overflow-auto p-5">{children}</main>
      </div>
    </div>
  );
}
