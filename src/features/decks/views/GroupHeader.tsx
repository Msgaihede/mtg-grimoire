/**
 * One group's heading, drawn the same way in all four views.
 *
 * Every view says the same three things over a pile — **what it is called, how many cards are
 * in it and what they cost** — plus the two markers that change what the pile *means*. Four
 * copies of that would be four places for the count to start disagreeing with itself, which
 * is exactly the failure `grouping.ts` exists to prevent one level down.
 */
import type { ReactNode } from "react";
import type { CategoryKind } from "@/lib/ipc";
import { PRICES_AS_OF, usdPrice } from "@/lib/prices";
import { cn } from "@/lib/utils";
import type { CardGroup } from "../grouping";

/**
 * The kinds whose pile the format's rules read **by name**: a commander zone, a sideboard, a
 * companion. That is what `RULE` means, and it is the marker's whole definition.
 *
 * ## The wrong reading, named so the next person does not have it
 *
 * **`RULE` does not mean "predefined and undeletable."** It is the plausible reading — all
 * three of these *are* predefined — and it is wrong, because it would put the marker on the
 * Maybeboard too. `RULE` and `INACTIVE` answer **different questions**, and a pile can carry
 * both:
 *
 * * `RULE` — *does the ruleset name this pile?* The commander zone, the sideboard and the
 *   companion slot are things a format has an opinion about, which is why they cannot be
 *   renamed or removed. A category the reader made is theirs.
 * * `INACTIVE` — *is the switch off?* Nothing in here counts toward size, copy limits or
 *   legality, and the allocator reserves nothing for it.
 *
 * A reader who switches the Sideboard off gets a pile marked `RULE INACTIVE`, and both words
 * are true of it.
 *
 * So `maybe` is deliberately absent. A Maybeboard is not a rules role — `SIZE_KINDS` counts
 * an *active* one exactly like a `main` pile — it is a pile seeded with its switch off, and
 * being switched off is the whole of what it is. `INACTIVE` already says that; `RULE` beside
 * it would claim a rules role the format has never heard of.
 *
 * (Checked against the design canvas, which draws `RULE` on the Commander and `INACTIVE` on
 * the Maybeboard, and confirmed as the intended reading.)
 */
const RULE_KINDS: readonly CategoryKind[] = ["commander", "side", "companion"];

/** A small uppercase chip in the data face — the shape both markers take. */
function Marker({ label, title }: { label: string; title: string }) {
  return (
    <span
      title={title}
      className="shrink-0 rounded-[3px] border border-border px-1 font-mono text-[0.5625rem] text-dim"
    >
      {label}
    </span>
  );
}

export function GroupHeader({
  group,
  layout = "spread",
  id,
  actions,
  className,
}: {
  group: CardGroup;
  /**
   * Where the counts go, and it is a question about the width of the box rather than about
   * taste.
   *
   * * `spread` pushes them to the far edge — a table band and a 300px text column, where the
   *   edge is close enough that the eye still reads the pair as one line.
   * * `tight` sets them right after the name, for a section as wide as the window: a price
   *   1 200px away from the heading it belongs to is a price attached to nothing.
   * * `stacked` drops them onto a second line, which is all a 224px column has room for.
   */
  layout?: "spread" | "tight" | "stacked";
  /** So the section under this can be `aria-labelledby` it. */
  id?: string;
  /** The group's own menu, where a view has one. A derived group has none — nothing can be
   *  renamed, reordered or switched off about "Mana value 3". */
  actions?: ReactNode;
  className?: string;
}) {
  const rule = group.kind !== null && RULE_KINDS.includes(group.kind);

  return (
    <div
      className={cn(
        "flex min-w-0 gap-x-2",
        layout === "stacked" ? "flex-col gap-y-0.5" : "items-baseline",
        className,
      )}
    >
      <div className={cn("flex min-w-0 items-center gap-1.5", layout !== "tight" && "flex-1")}>
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
        {rule && (
          <Marker
            label="RULE"
            title="The format's rules read this pile by name, so it cannot be renamed or removed."
          />
        )}
        {!group.isActive && (
          <Marker
            label="INACTIVE"
            title="Switched off: nothing here counts toward the deck's size, its copy limits or its legality, and no collection copy is reserved for it."
          />
        )}
        {actions}
      </div>

      <div
        className={cn(
          "flex shrink-0 items-baseline gap-1.5 font-mono text-[0.625rem] tabular-nums text-dim",
          layout === "stacked" && "justify-between",
        )}
      >
        {/* Copies, not rows — a deck is counted in cards. */}
        <span>
          {group.count} {group.count === 1 ? "card" : "cards"}
        </span>
        {layout !== "stacked" && <span aria-hidden="true">·</span>}
        {/* The as-of sentence rides here, as it does on every other price in the app: a price
            is never shown without saying when it was true. */}
        <span title={PRICES_AS_OF}>{usdPrice(group.totalPriceUsd)}</span>
      </div>
    </div>
  );
}
