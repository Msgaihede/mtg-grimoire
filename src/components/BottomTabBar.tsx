import { useRef } from "react";
import type { LucideIcon } from "lucide-react";
import { NAV } from "@/components/nav";
import { useSidebarDropTarget, type SidebarDrop } from "@/components/useSidebarDrops";
import { DROP_OVER, DROP_RING } from "@/lib/dropMarks";
import { PRESS } from "@/lib/motion";
import type { ViewId } from "@/lib/store";
import { cn } from "@/lib/utils";

/**
 * The six destinations across the foot of a phone window — and, for two of them, one place to
 * let a card go.
 *
 * **The second drawing of navigation, and deliberately not the rail with a flag on it.** A rail
 * entry is a full-width button with a left-anchored icon and a tooltip when there is no room for
 * its word; a tab is a square with its word under the glyph. What the two share is the *list* —
 * `NAV`, which moved out of `AppShell` for exactly this — and the *drop rule*,
 * `useSidebarDropTarget`. Neither of those is written twice, and the row is.
 *
 * **The arithmetic, re-measured rather than inherited.** Six tabs across a 390px window is
 * **65 × 52** each and the row is **53** tall — the 52 plus the hairline. 20px of glyph, 4px of
 * gap and 12px of label make the 36 that `py-2` puts 16 around. Driven in headless Chromium over
 * the **built** stylesheet with the real Geist face loaded (2026-08-29, `dist` of this branch,
 * served over http because `dist`'s font URLs are absolute and a `file://` page lays the text out
 * in a fallback face and lies about every width — the check is that the forced-`sans-serif` widths
 * differ, and they did: `Search` 38.67 against 38.03).
 *
 * **jsdom lays nothing out**, so none of that can go red in this component's suite: what the tests
 * pin is markup, and every pixel above came from a browser.
 *
 * **The mana line stays at the top and this bar gets a plain hairline**, which is the one design
 * decision in the layout and it is a decision to spend nothing. The app now has chrome at two
 * edges, and the templated answer — a second 2px gradient under the bar, so the frame is
 * "bracketed" — draws the app's signature twice. `Ribbon`'s own comment is the argument: the line
 * marks *the app's* edge rather than the content's, and a mark at both edges marks neither. So
 * `border-t border-border`, this app's ordinary word for an edge.
 */
export function BottomTabBar({
  activeView,
  onSelect,
  dragging,
  decks,
  wishlist,
}: {
  /** Which of the six is open — the one that wears `aria-current`. */
  activeView: ViewId;
  /** A tab was pressed. The bar reports and does not navigate: the store write is the shell's,
   *  exactly as it is for the rail. */
  onSelect: (view: ViewId) => void;
  /** A card is in the air somewhere in the window — what raises the ring. */
  dragging: boolean;
  /** What a drop on Decks would mean, from `useSidebarDrops`. */
  decks: SidebarDrop | null;
  /** …and on Wishlist. The other four take nothing and say so by passing `null`. */
  wishlist: SidebarDrop | null;
}) {
  return (
    // **`--safe-b` as an inline style, and that is not a stylistic choice.** The token shipped in
    // PR #274 published and deliberately applied nowhere, "for whatever 9b puts down there", and a
    // bar anchored to the window's bottom edge is that thing: without this it sits under the home
    // indicator. A Tailwind arbitrary value would read the same and is not the same — a mistyped
    // one emits **nothing**, silently, with `tsc` and the suite both green, which is why
    // `BottomTabBar.test.tsx` asserts the mechanism rather than the effect. It is `0px` on every
    // desktop and in every test, so it costs those nothing — and that it is a live reference
    // rather than a resolved zero was checked by forcing the token in a browser: at
    // `--safe-b: 34px` (an iPhone's home indicator) the bar goes 53 → 87 and the tabs stay 52.
    //
    // `aria-label="Views"` is the rail's, because it is the same landmark drawn for a narrower
    // window — the shell draws one or the other and never both.
    <nav
      aria-label="Views"
      className="flex shrink-0 border-t border-border bg-surface"
      style={{ paddingBottom: "var(--safe-b)" }}
    >
      {NAV.map(({ id, label, Icon }) => (
        <Tab
          key={id}
          label={label}
          Icon={Icon}
          active={id === activeView}
          onSelect={() => onSelect(id)}
          dragging={dragging}
          // **Every tab registers a drop target, the four that refuse included.** `null` is what
          // a tab that takes nothing passes, and it still registers — see
          // `useSidebarDropTarget`, where the reason lives: a droppable whose `accepts()` is
          // false costs a registry entry and nothing else, and registering all six is what keeps
          // the target set from changing shape mid-drag.
          drop={id === "decks" ? decks : id === "wishlist" ? wishlist : null}
        />
      ))}
    </nav>
  );
}

/**
 * One tab: a glyph, its word under it, and — for two of the six — a place to let a card go.
 *
 * **65 × 52 clears `--target-min` in both directions**, so the floor below is a fence rather than
 * the thing deciding the size. It is read as the custom property rather than typed as `44` again,
 * for the reason every token in this app is: a number written twice is a number that can drift.
 *
 * **The label is `text-xs`, which is the app's smallest interface size and not a new one** — the
 * sidebar's own drop report (`NavNote`) is already 12px, so nothing is invented here. **The rung
 * above it was measured and rejected rather than assumed away.** `Collection` is the longest of
 * the six words: at 12px it inks **55.23** in a 65px tab, nearly 10px of slack; at the chrome
 * ladder's 14px status-line size it inks **64.44** in the same 65 — half a pixel of slack, hard
 * against both edges — and it takes the row from 53px to **55**, which is height spent on the axis
 * this whole layout is short of. Both figures headless over the built stylesheet, 2026-08-29.
 *
 * **No `touch-action` here.** `src/index.css:464` already applies it to whatever is mid-drag, and
 * a second registration on one element silently replaces the first.
 */
function Tab({
  label,
  Icon,
  active,
  onSelect,
  dragging,
  drop,
}: {
  label: string;
  Icon: LucideIcon;
  active: boolean;
  onSelect: () => void;
  dragging: boolean;
  drop: SidebarDrop | null;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const { over, eligible, inert } = useSidebarDropTarget({ ref, drop, dragging });

  return (
    // `relative` for the report region below: `.sr-only` is `position: absolute`, so a region
    // with no positioned ancestor resolves against the *initial* containing block and stretches
    // the document — `src/CLAUDE.md`'s rule, and the deck editor's 1704px phantom scrollbar is
    // what ignoring it cost.
    <div className="relative flex min-w-0 flex-1">
      <button
        ref={ref}
        type="button"
        onClick={onSelect}
        aria-current={active ? "page" : undefined}
        // Only while a card is in the air and only when it cannot land — `NavItem`'s attribute,
        // for `NavItem`'s measured reason, and it is a **description** rather than a tooltip.
        // Chromium freezes `:hover` at the element a drag started from for the whole drag, so
        // nobody ever *sees* this sentence; what a reader gets is the accname spec's description
        // fallback, `button "Decks", description "Open a deck to drop cards into it"`. On a
        // phone there is no hover at all, which makes the point sharper rather than weaker: the
        // sentence exists for the accessibility tree and nowhere else.
        title={inert ? (drop?.inertReason ?? undefined) : undefined}
        className={cn(
          "flex w-full min-w-0 flex-col items-center justify-center gap-1 py-2",
          PRESS,
          // **`ring-inset`, and it covers both rings this button can wear.** The bar sits on the
          // window's own bottom edge, so a ring drawn *outside* the border box has its lower 2px
          // painted off the window — `TitleBar`'s flush caption buttons take the same class for
          // the same reason. It is not `DROP_MARK_ROOM`'s case: nothing here is inside a
          // scroller, so there is no padding box doing the clipping.
          "ring-inset focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
          active ? "text-accent" : "text-dim",
          eligible && DROP_RING,
          over && DROP_OVER,
        )}
        // The floor, read as the token rather than as `44` typed again. Measured at 65 × 52, so
        // nothing here is deciding the size — this only says what the size may never fall below.
        style={{ minWidth: "var(--target-min)", minHeight: "var(--target-min)" }}
      >
        <Icon className="size-5 shrink-0" aria-hidden="true" />
        <span className="w-full truncate text-center text-xs leading-none">{label}</span>
      </button>
      {drop && (
        // **Mounted for the life of the bar and `sr-only` throughout**, which is two decisions
        // and only the first is `NavItem`'s. A live region that first appears with its sentence
        // already inside it announces nothing, so the region exists from the start — that half
        // is the app's standing rule.
        //
        // The second half is that a 65px tab has no column to draw a line in, so unlike the
        // rail's report this one is never *painted*: it is announced and not seen. Where the
        // sentence goes for the eye is a decision about the assembled phone chrome rather than
        // about this component — the ribbon is shedding in the same round — so it is recorded
        // here as owed rather than answered by inventing a floating panel over the wall.
        //
        // Outside the button, never inside it: a report inside would join the button's
        // accessible name, and a name and a sentence in two elements compute to one string with
        // no space between them.
        <p role="status" className="sr-only">
          {drop.report}
        </p>
      )}
    </div>
  );
}
