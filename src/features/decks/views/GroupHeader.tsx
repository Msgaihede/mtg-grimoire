/**
 * One group's heading, drawn the same way in all four views.
 *
 * Every view says the same three things over a pile — **what it is called, how many copies are
 * in it and what they cost** — plus the two markers that change what the pile *means*. Four
 * copies of that would be four places for the count to start disagreeing with itself, which
 * is exactly the failure `grouping.ts` exists to prevent one level down.
 *
 * **The token pile is a fifth caller, and it is not a group** (token stacks spec §3.2). It hands
 * over a {@link GroupHeading} — the five fields this component reads — rather than a `CardGroup`
 * faked around them, because a token is never a deck card and a pile of them has no key, no
 * category id and no cards list to invent. Its count is said in its own words through `words`.
 *
 * **The count and the price are one block of figures on the name's own row** (spec §3.1): the
 * count is a {@link CountPill}, the price follows it with no separator — the pill's own edge is
 * the separator — and the row wraps the figures under the name where the column is too narrow
 * for both, rather than hanging them out of it.
 */
import type { ReactNode } from "react";
import { Gavel, PowerOff, type LucideIcon } from "lucide-react";
import { useTooltip } from "@/components/tooltip/useTooltip";
import type { CategoryKind } from "@/lib/ipc";
import type { Marketplace } from "@/lib/marketplace";
import { formatPrice, pricesAsOf } from "@/lib/prices";
import { cn } from "@/lib/utils";
import { cardCountWords, CountPill } from "../CountPill";
import type { CardGroup } from "../grouping";

/**
 * What a heading reads off a pile, and nothing else.
 *
 * **Every existing caller passes a whole `CardGroup`, which satisfies this**, so narrowing the
 * prop moved no call site. What it buys is the token pile: a `Pick` rather than a `CardGroup` is
 * what lets `Tokens & Emblems` be headed by this component without inventing a `key`, a
 * `categoryId` or a `cards` array for a pile that is not in the deck. `kind: null` draws neither
 * marker, which is the truth about that pile — it is not a rules zone and not a switched-off one.
 */
export type GroupHeading = Pick<CardGroup, "name" | "count" | "totalPrice" | "isActive" | "kind">;

/**
 * The kinds whose pile the format's rules read **by name**: a commander zone, a sideboard, a
 * companion. That is what the **rule mark** means — the `Gavel` chip, said to a screen reader as
 * {@link MARKER_WORDS}`.rule` — and it is the mark's whole definition.
 *
 * ## The wrong reading, named so the next person does not have it
 *
 * **The rule mark does not mean "predefined and undeletable."** It is the plausible reading — all
 * three of these *are* predefined — and it is wrong, because it would put the mark on the
 * Maybeboard too. The rule mark and the switched-off mark answer **different questions**, and a
 * pile can carry both:
 *
 * * **Rule** — *does the ruleset name this pile?* The commander zone, the sideboard and the
 *   companion slot are things a format has an opinion about, which is why they cannot be
 *   renamed or removed. A category the reader made is theirs.
 * * **Switched off** — *is the switch off?* Nothing in here counts toward size, copy limits or
 *   legality, and the allocator reserves nothing for it.
 *
 * A reader who switches the Sideboard off gets a pile wearing both chips, and both are true of
 * it.
 *
 * So `maybe` is deliberately absent. A Maybeboard is not a rules role — `SIZE_KINDS` counts
 * an *active* one exactly like a `main` pile — it is a pile seeded with its switch off, and
 * being switched off is the whole of what it is. The switched-off mark already says that; a rule
 * mark beside it would claim a rules role the format has never heard of.
 *
 * (Checked against the design canvas, which drew the words `RULE` on the Commander and
 * `INACTIVE` on the Maybeboard, and confirmed as the intended reading. The words became icons on
 * 2026-09-26 — see {@link Marker} — and the reading did not move.)
 */
const RULE_KINDS: readonly CategoryKind[] = ["commander", "side", "companion"];

/**
 * What each mark says to a screen reader — exported so a test or a story addresses a mark by the
 * words rather than by re-spelling them, which is `CountPill`'s `cardCountWords` arrangement.
 *
 * **Phrased to follow the pile's name**, because that is where they are heard: a name computed
 * over a heading reads `Sideboard Rules pile Switched off 3 cards $4.97`. `Rules pile` rather than
 * the canvas's bare `Rule`, which after a name reads as a verb; `Switched off` rather than
 * `Inactive`, because it is the word the heading's own tooltip and the category menu's
 * `Deactivate` row are both about — the pile's switch.
 */
export const MARKER_WORDS = { rule: "Rules pile", inactive: "Switched off" } as const;

/**
 * A 14px chip holding one glyph — the shape both marks take (token stacks, 2026-09-26).
 *
 * **Icons rather than the words `RULE` and `INACTIVE`, and the reason is the one-row heading.**
 * The two words were ~30px and ~50px of chrome inside the name block, so a switched-off
 * Sideboard's grip and both words came to ~114px — more than the stacked block's 4rem floor
 * accounts for, so at 0.8× and 0.9× the row stayed single while the words painted over the count
 * pill (26px and 5px, in a Chromium class-rewrite harness with system fonts). The grip and two
 * 14px chips come to 54px, and the same harness then reads no overlap and no overflow at any of
 * the sixteen zoom stops, one row at 1× and above, and the Sideboard's whole name at 1×.
 *
 * **The glyphs:**
 * * **`Gavel` for the rule mark** — a ruling, which is what the format makes about this pile.
 *   Deliberately not `Scale`: the deck editor's header already draws `Scale` on its `Compare`
 *   button, on the same screen as every one of these headings, and one glyph meaning two
 *   things a few hundred pixels apart is the collision to avoid.
 * * **`PowerOff` for the switched-off mark** — the glyph the category menu's `Deactivate` row
 *   already draws (`categoryMenu.tsx`), so the chip is the picture of the press that put the pile
 *   in this state.
 *
 * **The words still reach a screen reader, in one element**: the glyph is `aria-hidden` and an
 * `sr-only` span inside the chip spells {@link MARKER_WORDS}. The chip is `relative` so that
 * `sr-only`'s `position: absolute` has a containing block of its own (`src/CLAUDE.md`'s scroller
 * rule — an unanchored `sr-only` has stretched this app's document before).
 *
 * **It stays hit-testable**, and must: the tooltip is bound on the chip through `useTooltip()`,
 * and a hint inside anything `pointer-events-none` can never open. `title` stays the prop's name
 * — every call site still reads as a plain mark-plus-explanation pair — and is bound as a tooltip
 * inside this component rather than left as a DOM attribute.
 */
function Marker({ icon: Icon, words, title }: { icon: LucideIcon; words: string; title: string }) {
  const tip = useTooltip();
  return (
    <span
      {...tip(title)}
      className="relative grid size-3.5 shrink-0 place-items-center rounded-[3px] border border-border text-dim"
    >
      <Icon aria-hidden="true" className="size-2.5" strokeWidth={2.5} />
      <span className="sr-only">{words}</span>
    </span>
  );
}

export function GroupHeader({
  group,
  marketplace,
  words = cardCountWords,
  layout = "spread",
  id,
  handle,
  actions,
  className,
}: {
  /** The pile being headed — a whole `CardGroup` from the four views and `CategoriesDialog`, and
   *  a bare {@link GroupHeading} from the token pile. */
  group: GroupHeading;
  /**
   * Which marketplace {@link GroupHeading.totalPrice} was summed at — its currency formats the
   * figure, its label is the as-of sentence.
   *
   * Passed rather than read here, and required rather than defaulted, because this heading is
   * the one place four views state the same three facts: a default would let a view that
   * forgot to thread it print dollars beside cards priced in euros, and nothing on screen
   * would say which was wrong.
   */
  marketplace: Marketplace;
  /**
   * The phrase the count pill says to a screen reader — {@link cardCountWords} unless the caller
   * says otherwise, and the token pile passes `tokenCountWords`, so its pill reads
   * `5 tokens and emblems` where a deck pile's reads `5 cards`.
   *
   * A function of the count rather than a finished string, so the phrase can never be spelled
   * for a different number than the one the pill draws.
   */
  words?: (count: number) => string;
  /**
   * Where the figures go, and it is a question about the width of the box rather than about
   * taste. **Every layout is one row that wraps** (`flex-wrap`), so what differs is only how the
   * name gives way to them.
   *
   * * `spread` pushes them to the far edge — a table band and a 300px text column, where the
   *   edge is close enough that the eye still reads the pair as one line. The name block is
   *   `flex-1`, a basis of nothing, so it never forces a wrap: the name truncates and the figures
   *   stay on the edge, which is this layout's placement kept.
   * * `tight` sets them right after the name, for a section as wide as the window: a price
   *   1 200px away from the heading it belongs to is a price attached to nothing.
   * * `stacked` is **one row**, which is the reader's ask (token stacks spec §3.1): the name
   *   truncates first, and the figures wrap under it only where even a floor of name cannot
   *   stand beside them. A 224px column is not a band — at 1× a pile's name, its markers, the
   *   pill and a price share the row with the figures on the far edge, a long name truncating to
   *   make room; at 0.5× a column is ~117px, and there the figures drop to a second line.
   *
   *   **The name block is `min-w-16 flex-1`, and the floor is the whole of that wrap.** A row
   *   breaks lines on each item's *hypothetical* size — its basis clamped by its min-width — so
   *   `flex-1` alone, a basis of 0% beside `min-w-0`, counts the block as zero wide: the row
   *   never wraps, and at a 97px header the block is squeezed until `Ramp` draws **0px** wide
   *   and a switched-off Sideboard's markers lie over its own pill. The 4rem floor makes the
   *   block count as 64px, so the figures wrap exactly when 64px of name no longer fits beside
   *   them, and never before. `flex-auto` (a content basis) was the other answer and was refused:
   *   it wraps whenever the *whole* name does not fit, which gives up the one row at 1× for any
   *   long name and for the default switched-off Maybeboard.
   *
   *   **The floor counts the name and not the markers, which sit in the same block — and that is
   *   why the markers are 14px icons.** A pile whose grip and markers are wider than the floor
   *   can be held to one row with a block narrower than its own chrome, and there the markers run
   *   over the pill. While they were the words `RULE` and `INACTIVE` a switched-off Sideboard's
   *   chrome was ~114px and did exactly that at 0.8× and 0.9×; as two chips it is 54px, and a
   *   floor under the *name* instead (`w-0 min-w-16` on the span) was measured and refused
   *   because it wraps that Sideboard at 1×. Measured in Chromium over these classes (a
   *   `file://` harness, system fonts, 2026-09-26), at every one of the sixteen zoom stops: no
   *   overlap and no overflow anywhere; one row from 0.8× up for a long name, the switched-off
   *   Sideboard and the switched-off Maybeboard, with the Sideboard's whole 60px name at 1× and
   *   18px of it at 0.8×; two rows below that, with `Card Draw and Selection` keeping 77px of
   *   name at 0.5×. The name span stays `min-w-0 truncate`, so the name is what gives way first.
   */
  layout?: "spread" | "tight" | "stacked";
  /** So the section under this can be `aria-labelledby` it. */
  id?: string;
  /**
   * The grip a pile is picked up by, for the one view that lets a reader move a pile — drawn
   * **before the name, on the name's own line**, which is why it is a slot here rather than a
   * sibling the view puts beside this component.
   *
   * A `stacked` heading wraps to two lines where its column is narrow, so a handle drawn outside
   * it would centre itself against the pair and sit between the name and the figures.
   * `CategoriesDialog` draws its own handle beside this component instead, and is right to: its
   * row is a single line and the handle belongs to the row rather than to the heading.
   *
   * Absent everywhere else, which is the whole of the rule that a pile is reorderable only where
   * the reader can see the order they are changing. A derived group never gets one — see
   * {@link actions}.
   */
  handle?: ReactNode;
  /** The group's own menu, where a view has one. A derived group has none — nothing can be
   *  renamed, reordered or switched off about "Mana value 3". */
  actions?: ReactNode;
  className?: string;
}) {
  const tip = useTooltip();
  const rule = group.kind !== null && RULE_KINDS.includes(group.kind);

  return (
    <div className={cn("flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5", className)}>
      {/* How the name gives way to the figures is `layout`'s whole answer — see its doc. */}
      <div
        className={cn(
          "flex items-center gap-1.5",
          layout === "stacked" ? "min-w-16 flex-1" : "min-w-0",
          layout === "spread" && "flex-1",
        )}
      >
        {handle}
        {/* Dimmed when the pile counts toward nothing — the quietest of the three signals
            that say so, and the one a reader sees without reading a word. */}
        <span
          id={id}
          className={cn(
            "min-w-0 truncate text-[0.8125rem] font-medium",
            group.isActive ? "text-text" : "text-dim",
          )}
        >
          {group.name}
        </span>
        {/* Each chip is preceded by a `{" "}`: layout-inert between flex items, and what keeps
            its words apart from the name's in a computed name (`Sideboard Rules pile`, never
            `SideboardRules pile`). */}
        {rule && (
          <>
            {" "}
            <Marker
              icon={Gavel}
              words={MARKER_WORDS.rule}
              title="The format's rules read this pile by name, so it cannot be renamed or removed."
            />
          </>
        )}
        {!group.isActive && (
          <>
            {" "}
            <Marker
              icon={PowerOff}
              words={MARKER_WORDS.inactive}
              title="Switched off: nothing here counts toward the deck's size, its copy limits or its legality, and no collection copy is reserved for it."
            />
          </>
        )}
        {actions}
      </div>

      {/* `shrink-0`, so the figures are never squeezed: where they do not fit beside the name,
          the name truncates — to nothing in `spread`, to its 4rem floor in `stacked` — and past
          that floor, or in `tight`, the row wraps them under it. */}
      <div className="flex shrink-0 items-center gap-1.5 font-mono text-[0.625rem] tabular-nums text-dim">
        {/* Copies, not rows — a deck is counted in cards, and the token pile in tokens.
            The `{" "}` after the pill is layout-inert (whitespace between flex items is not
            rendered) and is what keeps the pill's words and the price apart wherever a name is
            computed over this heading — `TableView` draws it inside a `role="cell"`, which read
            `3 cards$4.97` without it (`src/CLAUDE.md`'s `Missing2` rule). */}
        <CountPill count={group.count} words={words(group.count)} />{" "}
        {/* The as-of sentence rides here, as it does on every other price in the app: a price
            is never shown without saying when it was true — and, now that a reader can pick,
            whose price it is. */}
        <span {...tip(pricesAsOf(marketplace))}>
          {formatPrice(group.totalPrice, marketplace.currency)}
        </span>
      </div>
    </div>
  );
}
