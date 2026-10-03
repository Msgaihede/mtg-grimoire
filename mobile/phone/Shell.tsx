import type { ReactNode } from "react";
import { Settings } from "lucide-react";
import { ManaLine } from "@/components/ManaLine";
import { FOCUS_INSET } from "@/lib/focus";
import { cn } from "@/lib/utils";
import { linkTo, usePlace } from "./router";
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
 *
 * **All four safe-area insets are the frame's, and the bars bleed past them.** The page is drawn
 * edge to edge (`viewport-fit=cover`), so nothing else keeps it out from under a cutout. Each bar
 * paints its surface to the screen's edge and insets its *content* — the header takes the top and
 * both sides, the tab bar the bottom and both sides — and the page between them is inset on the
 * sides. Until 2026-10-03 the frame itself padded the two sides, which in landscape left a strip
 * of page colour beside the notch where the bars stopped short of the screen.
 *
 * **From 600px wide the tab bar is a rail down the left edge** (`TabBar`'s own block says why).
 * The page and the rail then share the row under the header, the rail is the one beside the left
 * inset, and the page takes the bottom inset the bar no longer stands on. The rail comes *after*
 * the page in the document, as the bar does — so the tab order is the same at every width, and
 * `flex-row-reverse` is what draws it on the left.
 */
export function Shell({ title, children }: { title: string; children: ReactNode }) {
  const place = usePlace();
  const onSettings = place.view === "settings";

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-bg text-text select-none">
      <header className="shrink-0 bg-surface pt-[env(safe-area-inset-top)]">
        <div className="flex h-12 items-center gap-3 pr-[calc(1rem+env(safe-area-inset-right))] pl-[calc(1rem+env(safe-area-inset-left))]">
          <h1 className="min-w-0 flex-1 truncate font-heading text-lg">{title}</h1>
          {/* A link, for the tab bar's reason: it changes the URL. */}
          <a
            {...linkTo({ view: "settings", deckId: null, cardId: null })}
            aria-label="Settings"
            aria-current={onSettings ? "page" : undefined}
            className={cn(
              "flex size-11 items-center justify-center rounded-md",
              onSettings ? "text-accent" : "text-dim",
              // Inset, as the tabs are: wherever the top inset is 0 this control is flush to the
              // viewport's top edge, and a ring standing 2px off it loses that side to the screen.
              FOCUS_INSET,
            )}
          >
            <Settings aria-hidden className="size-5" />
          </a>
        </div>
        {/* `sync={null}` is the line at rest. The phone face runs no card sync of its own yet. */}
        <ManaLine sync={null} />
      </header>

      <div className="flex min-h-0 flex-1 flex-col min-[600px]:flex-row-reverse">
        <main
          className={cn(
            "relative flex min-h-0 min-w-0 flex-1 flex-col",
            "pr-[env(safe-area-inset-right)] pl-[env(safe-area-inset-left)]",
            // Beside the rail: the rail stands on the left inset, and nothing on the bottom one.
            "min-[600px]:pb-[env(safe-area-inset-bottom)] min-[600px]:pl-0",
          )}
        >
          {children}
        </main>

        <TabBar view={place.view} />
      </div>
    </div>
  );
}
