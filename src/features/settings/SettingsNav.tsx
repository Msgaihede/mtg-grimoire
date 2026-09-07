import type { JSX } from "react";
import { Search } from "lucide-react";
import { count } from "@/lib/counts";
import { LAYER } from "@/lib/layers";
import { PRESS_SOFT } from "@/lib/motion";
import { clearFieldOnEscape } from "@/lib/useDismissOnEscape";
import { cn } from "@/lib/utils";
import { GROUPS, GROUP_ORDER, searching, type BadgeId, type GroupId } from "./nav";

/**
 * The list, in both of its shapes.
 *
 * A column of full-width rows beside the pane; a horizontally scrolling strip of chips when the
 * rail has wrapped above it, which in practice means a phone. The strip is the shape a reader
 * already has for "pick one of six" at that width — the app's own bottom tab bar — and a column
 * of six full-width rows above the pane would push every panel a screen and a half down.
 *
 * **The threshold is a question about this box and not about the window, and the arithmetic
 * behind it is the page's own layout.** `SettingsPage` lays the rail and the pane out as a
 * `flex-wrap` row where the rail is `flex-[1_1_232px]` and the pane `flex-[999_1_480px]`. That
 * grow ratio is lopsided on purpose: while the two share a line, the pane takes all but a
 * fraction of a pixel of the free space and the rail sits at its 232px basis — and the moment
 * the line cannot hold both, the rail wraps onto a line of its own and becomes the **full width
 * of the page**. So the rail's own inline size is a true and complete answer to "am I beside the
 * pane, or above it?", with no second source of truth to keep in step. 260 rather than 233
 * because a threshold sitting a pixel off a measured value is one that flips on a scrollbar
 * appearing, and there is nothing between 232 and the narrowest page this app supports for it to
 * catch by mistake.
 *
 * **Every variant is written out whole, and `260` cannot be lifted into a constant.** Tailwind
 * scans source *text* for complete class names, so a name assembled by interpolation —
 * `` `${WRAPPED}flex-row` `` — matches nothing the scanner knows and emits **no rule at all**:
 * the source would read correctly, `dist/` would have no such rule in it, and the strip would
 * simply never happen. It is `layers.ts`'s reason for spelling its variants out, one file over.
 *
 * **The scroller's 2px of padding is not decoration.** `overflow-x-auto` computes `overflow-y`
 * to `auto` as well, and both clip at the scroller's *padding* box — while an entry's focus mark
 * here is `ring-2`, a box shadow painted 2px **outside** its border box. With no padding the
 * first and last chips lose the outer 2px of their ring and the whole strip loses its top and
 * bottom, which is half a focus indicator and a WCAG 2.4.7 failure. It is `dropMarks.ts`'s
 * `DROP_MARK_ROOM` rule at this component's own numbers: 6px there is room for an `outline-2
 * outline-offset-2` standing 4px proud, and 2px here is room for a ring standing 2.
 */
const LIST = cn(
  "flex flex-col gap-0.5",
  "@min-[260px]/rail:flex-row @min-[260px]/rail:gap-1",
  "@min-[260px]/rail:overflow-x-auto @min-[260px]/rail:p-0.5",
);

/**
 * One entry, in both shapes.
 *
 * **The accent mark is a border that changes side rather than two different marks**, which is
 * what keeps the current entry reading as one idea across the switch: a 2px rule on the leading
 * edge of a row, and the same 2px rule under a chip. Only the *width* is moved between sides
 * here; the colour is applied at the call site, where "is this the current one" is known, and
 * `border-transparent` on the others is what stops the row shifting 2px sideways as the
 * selection moves.
 *
 * `PRESS_SOFT` rather than `PRESS`: these rows are as wide as the rail, and a full-width row
 * that dips 3% under the finger reads as the page moving rather than as a button going down —
 * `MarketplacePanel`'s rows are the same shape and made the same choice.
 *
 * The focus ring is `controls.ts`'s spelling, character for character. These are **not**
 * `BUTTON`s — a nav row is not a bordered control, and drawing six of them as bordered buttons
 * would make the rail look like a page of settings in its own right — but a second focus mark
 * in one page would be a vocabulary lesson bought for nothing.
 */
const ENTRY = cn(
  "flex w-full items-center justify-between gap-2 rounded-r-md border-l-2 px-3 py-1.5",
  "text-left text-sm coarse:min-h-[var(--target-min)]",
  PRESS_SOFT,
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
  "@min-[260px]/rail:w-auto @min-[260px]/rail:shrink-0 @min-[260px]/rail:justify-start",
  "@min-[260px]/rail:rounded-md @min-[260px]/rail:border-l-0 @min-[260px]/rail:border-b-2",
);

/**
 * The rail: six groups, a box to search them all with, and what is still missing from the page.
 *
 * **It decides nothing.** Which panels a group holds and which panels a query matches are
 * `nav.ts`'s, and are pure; this component draws the six entries that module orders and reports
 * presses. The one rule it *enforces* is the one `visiblePanels` states — **a query outranks the
 * group**, so while the box has words in it no entry is marked current, because a reader who
 * types "dropbox" while standing on `Updates` is asking the page a question rather than asking
 * the `Updates` group one. Clearing the query is the page's, not this component's: `onGroup`
 * fires and nothing else, so the two states can never both apply and neither can be lost.
 *
 * ## Why a container query, and not `useNarrowWindow()` or a `sm:` branch
 *
 * `src/lib/viewports.ts` forbids a viewport branch outside `AppShell`, and it is right to: the
 * question here is not how wide the *window* is but whether this rail has the pane beside it.
 * The rail's own inline size answers that exactly — see {@link LIST} for the arithmetic —
 * and a window-width branch would answer a different question that happens to agree today and
 * would stop agreeing the moment the page's `flex` bases move.
 *
 * ## Why the container is on this `<nav>` and never on the settings root
 *
 * `container-type: inline-size` — which is what every `@container` in this app compiles to —
 * applies **layout containment**, and a layout-contained box is the containing block for every
 * `position: fixed` descendant under it, exactly as a `transform` is. Settings panels mount
 * their dialogs **inline** — `DangerZonePanel.tsx:169` and `SyncPanel.tsx:1527` each render a
 * `<ConfirmDialog>` in the middle of their own markup, and `Dialog.tsx:333` is the bare
 * `fixed inset-0` scrim underneath it, with no `createPortal` anywhere in this app. So a
 * container box wrapped around the page would size every settings scrim and every settings
 * dialog to the *page box* instead of to the window: a scrim covering the panel it came out of,
 * and a panel clamped to a column.
 * `FilterBar.tsx:1287` is the same trap found from the other end — its root is a fragment so
 * that the phone's filter sheet is the container box's **sibling**. Nothing in jsdom can see any
 * of this: it applies no stylesheet and computes no containment. What a test can pin is the
 * structure, which is that the container is this element and the panels are not inside it.
 */
export function SettingsNav({
  group,
  onGroup,
  query,
  onQuery,
  badges,
}: {
  /** The current group. Not marked current while `query` has words in it. */
  group: GroupId;
  /** Picking an entry. The page clears the query itself — this component does not. */
  onGroup: (id: GroupId) => void;
  query: string;
  onQuery: (query: string) => void;
  /** What each badge stands for. Zero draws no badge at all. */
  badges: Readonly<Record<BadgeId, number>>;
}): JSX.Element {
  // Asked once rather than per entry: it is the same answer six times, and asking it here is
  // also what puts the rule in one place a reader can find.
  const filtering = searching(query);

  return (
    <nav
      aria-label="Settings"
      className={cn(
        // **Named, and the name is what stops another container claiming these variants.**
        // `@container` variants bind to the *nearest* ancestor container, so an unnamed one here
        // would be what any future `@container` inside a panel resolved against. Everything
        // below spells `/rail`.
        "@container/rail sticky top-0 flex-[1_1_232px] self-start",
        // `self-start` is what makes the pin do anything at all: a flex item stretches to its
        // line by default, and a sticky element that already fills its containing block has no
        // travel to stick through. It costs nothing beside the pane, where the rail is shorter
        // than the panels either way.
        //
        // `bg-bg` and the header rung are for the wrapped shape, where the pane scrolls *under*
        // the strip: the settings page is a growing `<div>` rather than an `h-full` column, so
        // `AppShell`'s `main` genuinely scrolls here and the pin genuinely engages. Opaque, in
        // `main`'s own colour, or the panels are legible straight through the rail; and the rung
        // is taken from `layers.ts` because `layers.test.ts` sweeps `src/` for a bare one. It is
        // the rung named for exactly this pairing — something sticky, over the content passing
        // beneath it — and it stays below `popup`, so a panel's dropdown still opens over it.
        //
        // Not corrected for `main`'s own 20px of padding (`FilterBar`'s `-mt-5 pt-5`), and that
        // is deliberate: the rail is not the first thing in `main` on this page, so the bleed
        // would take a bite out of whatever is above it at rest to fix a gutter only a scrolled
        // page shows.
        "bg-bg",
        LAYER.header,
      )}
    >
      {/*
        The box, and it is a `<label>` so that the whole bordered box is the hit target rather
        than the input inside it.

        **The name is on the input and not on this label**, which is the one choice worth
        stating: a wrapping `<label>` names its control from its *text*, and the only thing in
        here besides the field is an icon that is `aria-hidden` — so the label contributes an
        empty name and the field would end up named by its placeholder, which is a name that
        disappears the moment a reader types. `aria-label` says the same words unconditionally.
        The placeholder repeats them exactly rather than paraphrasing: two spellings of one
        name is two things for a reader to reconcile.
      */}
      <label
        className={cn(
          "mb-3 flex h-[34px] items-center gap-2 rounded-md border border-border bg-surface px-2",
          "coarse:min-h-[var(--target-min)]",
          // The field's own `focus:border-accent`, moved onto the box because the box is what
          // has the border — `focus-within` is the only spelling that can reach it from a
          // caret on a child.
          "focus-within:border-accent",
        )}
      >
        <Search className="size-4 shrink-0 text-dim" aria-hidden="true" />
        <input
          type="search"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          // Escape empties the box while there is something in it to empty, and falls through
          // when there is not — the one press a filter box owns anywhere in this app. Chromium
          // clears an `<input type="search">` natively but leaves `defaultPrevented` false, so
          // without this the same press would both empty the box and reach whatever Escape means
          // to the view behind it; jsdom implements no native clear at all, so this handler is
          // also the only half of the behaviour a test can see. The rule is
          // {@link clearFieldOnEscape}'s.
          onKeyDown={(e) => clearFieldOnEscape(e, query, () => onQuery(""))}
          aria-label="Search settings"
          placeholder="Search settings"
          // `min-w-0` because a flex item's floor is its own min-content and an input's is
          // wider than this box: without it the field pushes the icon out of the border.
          className="min-w-0 flex-1 bg-transparent text-sm text-text outline-none placeholder:text-dim"
        />
      </label>

      <ul className={LIST}>
        {GROUP_ORDER.map((id) => {
          const meta = GROUPS[id];
          // **Zero draws no badge at all**, rather than a `0` — a count is a thing worth looking
          // at, and six entries each carrying a nought is a rail that always looks like it is
          // asking for something. `badges` is total over `BadgeId`, so a group with no badge
          // reads nothing here and a badge with no group is a type error in `nav.ts`.
          const badge = meta.badge === undefined ? 0 : badges[meta.badge];
          const current = !filtering && id === group;
          /**
           * **The whole name in one string, because a count in a sibling element cannot reach
           * the accessible name with a space in front of it.**
           *
           * A label and a number in two elements compute to `Sync2` — the gap that separates
           * them on screen is a layout property, and a name is computed from text. The obvious
           * repairs both fail, and the second one fails *silently*: an intervening whitespace
           * text node is not rendered inside a flex container at all, and a visually-hidden span
           * whose own text begins with a space is **trimmed per node** before the parts are
           * joined. Measured here on 2026-09-03 against `dom-accessibility-api` — the four
           * unbadged entries read correctly and the two badged ones read `Sync(2)` and
           * `Errors(41)`.
           *
           * So the name is written once, and the visible figure is `aria-hidden` as a duplicate
           * of it — which is `CountTag`'s rule for a bare number arrived at from the other side.
           * The visible label stays the start of the name, so a reader speaking what they see
           * still reaches this control.
           *
           * Parentheses rather than words because `nav.ts` says what a badge *is* and not what
           * it counts: `review` and `errors` are two different sentences, and inventing one
           * apiece here would put the count's meaning in the rail rather than on the panel that
           * answers it.
           */
          const name = badge > 0 ? `${meta.label} (${count(badge)})` : meta.label;

          return (
            <li key={id}>
              <button
                type="button"
                onClick={() => onGroup(id)}
                aria-label={name}
                // The current entry, and **nothing is current while the box has words in it** —
                // see the rule in this component's own doc. `undefined` rather than `"false"`:
                // the attribute's absence is what "not current" is spelled as, and `aria-current
                // ="false"` on five entries is five things for a reader to be told about.
                aria-current={current ? "page" : undefined}
                className={cn(
                  ENTRY,
                  current
                    ? "border-accent bg-surface text-text"
                    : "border-transparent text-dim hover:text-text",
                )}
              >
                <span className="truncate">{meta.label}</span>

                {/* `aria-hidden` because the button's own name already carries this figure —
                    see {@link name} above for why it has to. Gold, which is what "the number
                    worth looking at" is spelled in everywhere else in this window, and
                    `tabular-nums` so that a count changing under the reader's eye does not shift
                    the entry's width. */}
                {badge > 0 && (
                  <span
                    aria-hidden="true"
                    className="shrink-0 font-mono text-xs tabular-nums text-accent"
                  >
                    {count(badge)}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>

      {/*
        What the page still does not have, at the foot of the thing that lists what it does.

        **It loses the `Not here yet` heading it had on the page, and the loss is the point.**
        In a rail a heading *is* an entry, and an entry is a destination — so a seventh heading
        with no panels behind it would be a place a reader can be sent to that draws nothing.
        `panelChrome.tsx` already refuses the softer version of this ("a heading over an absence
        is `text-dim` with no box, and drawing it a panel's frame would promise a panel behind
        it"); a rail entry promises more than a frame does. One dim line under six real
        destinations says the same thing and promises nothing.
      */}
      <p className="mt-3 text-xs text-dim">Import. Coming in a later plan.</p>
    </nav>
  );
}
