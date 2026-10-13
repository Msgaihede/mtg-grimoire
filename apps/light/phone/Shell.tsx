import { useId, type ReactNode } from "react";
import { Bell, Settings } from "lucide-react";
import { ManaLine } from "@grimoire/ui/components/ManaLine";
import type { ManaLineSync } from "@grimoire/ui/lib/mana";
import { FOCUS_INSET } from "@grimoire/ui/lib/focus";
import { useUnreadCount } from "@grimoire/ui/lib/notifications";
import { cn } from "@grimoire/ui/lib/utils";
import { tabLinkTo, usePlace } from "./router";
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
 *
 * **The mana line is the face's progress bar**, as the ribbon's is the desktop's: `activity` is the
 * loudest job running — the card sync above the feeds, `topActivity`'s fold — and `null` draws the
 * line at rest. Its label is the bar's accessible name; nothing else on the frame grows a caption,
 * so a download never pushes the page down. An empty wall over a first run says the rest itself.
 *
 * **The bell beside the gear opens the Notifications inbox** (`onInbox`) — the desktop rail's entry,
 * in the one row this face keeps for things that are not a destination. A button, not a link: the
 * inbox is a dialog over wherever the reader is, and its Back step is the dialog host's. It carries
 * the unread count as the rail's collapsed entry does, a pip on the glyph.
 */
export function Shell({
  title,
  activity = null,
  inboxOpen = false,
  onInbox = () => {},
  children,
}: {
  title: string;
  activity?: ManaLineSync | null;
  /** The inbox is up — the bell's `aria-expanded`. */
  inboxOpen?: boolean;
  /** A press on the bell. */
  onInbox?: () => void;
  children: ReactNode;
}) {
  const place = usePlace();
  const onSettings = place.view === "settings";
  // Found by id when pressed rather than held in a ref: the press is wired up during render, and a
  // ref handed to it there is one the compiler's rules cannot tell is read only later.
  const mainId = useId();
  const toTop = () => scrollToTop(document.getElementById(mainId));

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-bg text-text select-none">
      <header className="shrink-0 bg-surface pt-[env(safe-area-inset-top)]">
        <div className="flex h-12 items-center gap-3 pr-[calc(1rem+env(safe-area-inset-right))] pl-[calc(1rem+env(safe-area-inset-left))]">
          <h1 className="min-w-0 flex-1 truncate font-heading text-lg">{title}</h1>
          <InboxBell open={inboxOpen} onOpen={onInbox} />
          {/* A link, for the tab bar's reason: it changes the URL. A destination of its own, so it
              is switched to as a tab is (`switchTo`), and a second press scrolls it up. */}
          <a
            {...tabLinkTo({ view: "settings", deckId: null, cardId: null }, toTop)}
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
        <ManaLine sync={activity} />
      </header>

      <div className="flex min-h-0 flex-1 flex-col min-[600px]:flex-row-reverse">
        <main
          id={mainId}
          className={cn(
            "relative flex min-h-0 min-w-0 flex-1 flex-col",
            "pr-[env(safe-area-inset-right)] pl-[env(safe-area-inset-left)]",
            // Beside the rail: the rail stands on the left inset, and nothing on the bottom one.
            "min-[600px]:pb-[env(safe-area-inset-bottom)] min-[600px]:pl-0",
          )}
        >
          {children}
        </main>

        <TabBar view={place.view} onReselect={toTop} />
      </div>
    </div>
  );
}

/**
 * The header's way into the inbox: the bell, a 44px press, and the count of notices that arrived
 * since the inbox was last opened — `99+` past two digits, the rail's badge. The count is in the
 * press's name as well as on the glyph, so a screen reader hears what the pip shows.
 */
function InboxBell({ open, onOpen }: { open: boolean; onOpen: () => void }) {
  const unread = useUnreadCount();
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
      className={cn(
        "relative flex size-11 shrink-0 items-center justify-center rounded-md text-dim",
        // Inset, the gear's reason: flush to the top edge wherever that inset is 0.
        FOCUS_INSET,
      )}
    >
      <Bell aria-hidden className="size-5" />
      {unread > 0 && (
        <span
          aria-hidden
          data-testid="inbox-pip"
          className="absolute top-1.5 right-1 min-w-4 rounded-full bg-accent px-1 text-center text-[0.625rem] leading-4 font-semibold text-accent-foreground"
        >
          {unread > 99 ? "99+" : unread}
        </span>
      )}
    </button>
  );
}

/**
 * Every scroller on the page that is not at its top, back to its top — what a second press on
 * the tab the reader is on does.
 *
 * **Asked of the page rather than handed a ref**: each page owns its own scroller (a wall, a
 * list, the Scanner's two columns), and a ref threaded through seven pages to answer one press
 * would be seven places to forget it. A wall's virtualiser hears the scroll like any other.
 */
export function scrollToTop(page: HTMLElement | null): void {
  if (page === null) return;
  const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
  for (const el of page.querySelectorAll<HTMLElement>("*")) {
    if (el.scrollTop > 0) el.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" });
  }
}
