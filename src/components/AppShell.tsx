import type { ReactNode } from "react";
import {
  Heart,
  Layers,
  LibraryBig,
  Search,
  Settings,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import { Ribbon } from "@/components/Ribbon";
import { SyncProgress } from "@/components/SyncProgress";
import { manaLineSync } from "@/lib/mana";
import { useAppStore, type ViewId } from "@/lib/store";
import { statusLine, useSync } from "@/lib/useSync";
import { useSyncInvalidation } from "@/lib/useSyncInvalidation";
import { useSyncProgress } from "@/lib/useSyncProgress";
import { cn } from "@/lib/utils";

const NAV: { id: ViewId; label: string; Icon: LucideIcon }[] = [
  { id: "search", label: "Search", Icon: Search },
  { id: "collection", label: "Collection", Icon: LibraryBig },
  { id: "wishlist", label: "Wishlist", Icon: Heart },
  { id: "decks", label: "Decks", Icon: Layers },
  { id: "settings", label: "Settings", Icon: Settings },
];

/**
 * The window: sidebar, ribbon, and whatever view the store points at.
 *
 * Owns the sync status because everything that needs it lives here — the ribbon's summary
 * line, Refresh button and mana line, and the first-run overlay — and one poll for the
 * whole app is the point of the arrangement.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const activeView = useAppStore((s) => s.activeView);
  const setActiveView = useAppStore((s) => s.setActiveView);
  const { status, error, refresh, refreshing, upToDate } = useSync();
  const progress = useSyncProgress();
  // Here rather than in a view, because it is about the whole cache and this is the one
  // component that is always mounted — and it takes the progress event as a prop so the
  // app still registers exactly one `sync:progress` listener.
  useSyncInvalidation(progress);

  // Either this window started the sync or something else did (the run spawned at
  // startup, most often). A second `sync_run` would only be refused.
  const busy = refreshing || status?.syncing === true;
  const title = NAV.find((n) => n.id === activeView)?.label ?? "";

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
                "relative flex items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm",
                "transition-colors duration-150 motion-reduce:transition-none",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                // The gold indicator: a hairline against the item, not a filled pill. The
                // sidebar is chrome, and chrome does not get to be the loudest thing on a
                // screen that is about to be full of card art.
                active
                  ? "bg-bg text-accent before:absolute before:inset-y-1.5 before:left-0 before:w-0.5 before:rounded-full before:bg-accent"
                  : "text-dim hover:bg-bg/60 hover:text-text",
              )}
            >
              <Icon className="size-4 shrink-0" aria-hidden="true" />
              {label}
            </button>
          );
        })}
      </nav>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* The data directory is the app's one piece of hidden state — it silently falls
            back to AppData when the folder beside the exe is not writable, and spec §3
            asks for an indicator of which one is live. The ribbon hangs it as a tooltip
            on the line that already summarises the database. */}
        <Ribbon
          title={title}
          statusLine={statusLine(status)}
          dataDir={status?.dataDir}
          imageStoreFailures={status?.imageStoreFailures}
          busy={busy}
          upToDate={upToDate}
          hasError={error !== null}
          onRefresh={refresh}
          sync={manaLineSync(progress, busy)}
        />

        {/* Given the whole screen when the database is empty, so it needs the error and
            the retry action too: it covers the ribbon, Refresh button included. */}
        <SyncProgress
          progress={progress}
          cardCount={status?.cardCount ?? null}
          error={error}
          busy={busy}
          onRetry={refresh}
        />

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
