import type { ReactNode } from "react";
import { Settings } from "lucide-react";
import { ManaLine } from "@/components/ManaLine";
import { FOCUS } from "@/lib/focus";
import { cn } from "@/lib/utils";
import { navigate, usePlace } from "./router";
import { TabBar } from "./TabBar";

/**
 * The phone face's frame: a title row, the page, and the tab bar.
 *
 * `h-dvh`, not `h-screen` — on a mobile browser `100vh` is the height the page would have with
 * the URL bar hidden, so an `h-screen` shell puts its own tab bar under browser chrome.
 *
 * The page is the one thing between the two bars and owns its own scrolling; the frame never
 * scrolls. The mana line is drawn once, under the title, exactly as the desktop's ribbon draws it
 * — a signature at both edges marks neither.
 */
export function Shell({ title, children }: { title: string; children: ReactNode }) {
  const place = usePlace();
  const onSettings = place.view === "settings";

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-bg text-text select-none">
      <header className="shrink-0 bg-surface pt-[env(safe-area-inset-top)]">
        <div className="flex h-12 items-center gap-3 px-4">
          <h1 className="min-w-0 flex-1 truncate font-heading text-lg">{title}</h1>
          <button
            type="button"
            aria-label="Settings"
            aria-current={onSettings ? "page" : undefined}
            onClick={() => navigate({ view: "settings", deckId: null, cardId: null })}
            className={cn(
              "flex size-11 items-center justify-center rounded-md",
              onSettings ? "text-accent" : "text-dim",
              FOCUS,
            )}
          >
            <Settings aria-hidden className="size-5" />
          </button>
        </div>
        {/* `sync={null}` is the line at rest. The phone face runs no card sync of its own yet. */}
        <ManaLine sync={null} />
      </header>

      <main className="relative flex min-h-0 flex-1 flex-col">{children}</main>

      <TabBar
        view={place.view}
        onSelect={(view) => navigate({ view, deckId: null, cardId: null })}
      />
    </div>
  );
}
