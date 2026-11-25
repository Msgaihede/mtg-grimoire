import { useId } from "react";
import { LayoutGroup, motion } from "motion/react";
import { NAV } from "@grimoire/ui/components/nav";
import { LIGHT_VIEWS, type LightView } from "@grimoire/ui/lib/edition";
import { FOCUS_INSET } from "@grimoire/ui/lib/focus";
import { pressSpring, SPRING } from "@grimoire/ui/lib/motion";
import { cn } from "@grimoire/ui/lib/utils";
import { tabLinkTo } from "./router";

/**
 * The seven destinations a thumb reaches for. Settings is the top bar's.
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
 * to hear *link*. `tabLinkTo` keeps a plain press inside the page.
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
 *
 * **The tab the reader is on wears a marker, and the marker travels** (2026-11-25): a soft gold
 * lozenge behind the glyph and the word, which slides to the tab pressed on `SPRING.marker`
 * (`layoutId`, so it is one element moving rather than two fading) — the colour alone said *here*
 * as quietly as a word can. A press squeezes the tab under the finger (`pressSpring`). The
 * marker's `layoutId` is scoped by a `LayoutGroup` per bar, so two bars on a page (a story) never
 * trade one marker. Under reduced motion the marker steps and the squeeze is gone.
 */
export function TabBar({
  view,
  onReselect = () => {},
}: {
  view: LightView;
  /** A press on the tab whose root the reader is already on — the shell scrolls the page up. */
  onReselect?: () => void;
}) {
  const group = useId();
  return (
    <LayoutGroup id={group}>
      <nav
        aria-label="Views"
        className={cn(
          "flex shrink-0 border-t border-border bg-surface",
          "pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)]",
          // The rail: 80px of tabs, plus whatever the left inset is. **No top padding since the
          // seventh tab** (Life, 2026-11-20): the 8px it had is what seven rows of the 44px floor
          // needed on a phone on its side — see the tab's own arithmetic below. And it scrolls
          // rather than clips, for a window shorter still.
          "min-[600px]:w-[calc(5rem+env(safe-area-inset-left))] min-[600px]:flex-col",
          "min-[600px]:border-t-0 min-[600px]:border-r min-[600px]:pr-0 min-[600px]:overflow-y-auto",
        )}
      >
        {TABS.map(({ id, label, Icon }) => (
          <motion.a
            key={id}
            {...pressSpring}
            // `switchTo`, not a push: a tab sits one step above the start view however many the
            // reader has pressed, and a tab pressed from inside it (a deck, a trade) lands on its
            // root — see `router.ts`.
            {...tabLinkTo({ view: id, deckId: null, cardId: null }, onReselect)}
            aria-current={id === view ? "page" : undefined}
            className={cn(
              // 52px: over the 44px touch floor in both directions at seven tabs on 360px, where
              // each is 51.4px wide (60 when there were six); a label wider than that — Collection —
              // is cut short on its one line. In the rail each tab is a share of the column between
              // that floor and 64px — a phone on its side at 360 tall has 310px under the header
              // (48 and the 2px mana line): seven rows of 44.3, where seven at 64 would be 448. The
              // rail's 8px of top padding went with the seventh tab, which would have left 302px —
              // seven rows of 43.1, under the floor.
              "relative flex h-13 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 text-xs",
              "min-[600px]:h-auto min-[600px]:max-h-16 min-[600px]:min-h-11",
              id === view ? "text-accent" : "text-dim",
              FOCUS_INSET,
            )}
          >
            {id === view && (
              <motion.span
                aria-hidden
                layoutId="tab-marker"
                transition={SPRING.marker}
                className="absolute inset-x-1 inset-y-1 rounded-xl bg-accent/12"
              />
            )}
            <Icon aria-hidden className="relative size-5" />
            <span className="relative max-w-full truncate">{label}</span>
          </motion.a>
        ))}
      </nav>
    </LayoutGroup>
  );
}
