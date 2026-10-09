import { NAV } from "@grimoire/ui/components/nav";
import { LIGHT_VIEWS, type LightView } from "@grimoire/ui/lib/edition";
import { FOCUS_INSET } from "@grimoire/ui/lib/focus";
import { cn } from "@grimoire/ui/lib/utils";
import { linkTo } from "./router";

/**
 * The five destinations a thumb reaches for. Settings is the top bar's.
 *
 * **The words and the glyphs are the desktop rail's**, read out of `NAV` rather than written
 * again — one word per view, in both apps, is what that module exists to keep.
 */
const TABS = NAV.filter(
  (entry): entry is (typeof NAV)[number] & { id: LightView } =>
    (LIGHT_VIEWS as readonly string[]).includes(entry.id) && entry.id !== "settings",
);

/**
 * **Each tab is a link, not a button.** A tab changes the URL, so in a browser it has to answer
 * what a link answers — a middle click, "open in new tab", "copy link" — and a screen reader has
 * to hear *link*. `linkTo` keeps a plain press inside the page.
 *
 * **Below 600px it is a bar along the bottom; from 600px it is a rail down the left** (decided
 * 2026-10-03, `docs/reference/light-app.md` §7.8). The band between 600 and the desktop face's
 * 1024 is a portrait tablet, an unfolded foldable, or a phone on its side — and on the phone on
 * its side the vertical is what is scarce: at 915 × 412 the bar's 52px was a fifth of what the
 * wall had, which drew less than one row. The rail spends 80px of width instead. On a portrait
 * tablet that costs the wall a column (800 wide: five to four, each tile wider) out of a height it
 * has to spare. Below 600 is a phone upright, where the spec's own measurement stands: the bar is
 * worth a column of card art. **It asks the viewport's width and nothing else**, like the face.
 *
 * Either way the bar paints to the screen's edges and insets its tabs: the bottom inset (the home
 * indicator) and the sides (a cutout in landscape) as a bar, the left inset and the bottom as a
 * rail.
 */
export function TabBar({ view }: { view: LightView }) {
  return (
    <nav
      aria-label="Views"
      className={cn(
        "flex shrink-0 border-t border-border bg-surface",
        "pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)]",
        // The rail: 80px of tabs, plus whatever the left inset is.
        "min-[600px]:w-[calc(5rem+env(safe-area-inset-left))] min-[600px]:flex-col",
        "min-[600px]:border-t-0 min-[600px]:border-r min-[600px]:pt-2 min-[600px]:pr-0",
      )}
    >
      {TABS.map(({ id, label, Icon }) => (
        <a
          key={id}
          {...linkTo({ view: id, deckId: null, cardId: null })}
          aria-current={id === view ? "page" : undefined}
          className={cn(
            // 52px: over the 44px touch floor in both directions at five tabs on 360px. In the
            // rail each tab is a share of the column between that floor and 64px — a phone on
            // its side at 360 tall has 310px under the header, and five 64px rows are 320.
            "flex h-13 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 text-xs",
            "min-[600px]:h-auto min-[600px]:max-h-16 min-[600px]:min-h-11",
            id === view ? "text-accent" : "text-dim",
            FOCUS_INSET,
          )}
        >
          <Icon aria-hidden className="size-5" />
          <span className="max-w-full truncate">{label}</span>
        </a>
      ))}
    </nav>
  );
}
