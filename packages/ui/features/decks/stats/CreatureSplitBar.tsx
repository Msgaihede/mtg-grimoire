/**
 * `Creatures vs noncreatures` — one 32px bar in two parts, under Card distribution's chart and
 * over its type breakdown (2026-09-28).
 *
 * **The Mana pips `Cost` band's grammar**, on purpose: a 15px label above a full-width rounded
 * strip whose parts are shares of one whole. A reader who has learned to read one band reads this
 * one without being told, which is the only reason two different questions may share a shape.
 *
 * **The counts are the curve's and nothing else's** — `creatureSplit` reads them off
 * `DeckStatsSummary.curveCreatures`, so this band and the Mana curve's `Creatures` legend are one
 * number by construction. That also decides what it is *over*: nonlands with a mana value, which
 * is why the parts do not add up to the Card distribution bars' total a few pixels above. The
 * bars count every active copy; this band answers the curve's question, *what is this deck
 * casting*.
 *
 * The fills are `--color-creature` and `--color-noncreature`, the violet pair the curve's split
 * bars use — one hue at two weights, so the split reads as one fact in two parts. The drawing is
 * `aria-hidden` and the whole reading is one `sr-only` sentence, the band's standing rule.
 */
import type { JSX } from "react";
import { plural } from "@/lib/counts";
import { cn } from "@/lib/utils";
import type { DeckStatsSummary } from "../DeckStats";
import { percent } from "./StatsCard";
import { creatureSplit } from "./typeBreakdownCounts";

/**
 * The share below which a part prints its words **beside** the bar rather than inside it.
 *
 * **0.35, measured against the text and the widths this card is actually drawn at, rather than
 * the round quarter the design sketched.** The longer of the two strings is `24 noncreatures
 * 60%` — 13px mono bold digits, the word in 12px Geist, the share in 12px mono, two 4px gaps and
 * the part's own 12px of padding — which comes to ~132px. The card's content box is ~430px in
 * the three-column layout (a 1400px band) and ~550px in the two-column one at a 1440 window,
 * so the text needs **31%** and **24%** of the bar there: a quarter clips the three-column case
 * this redesign exists for, and 0.35 holds both with room. At the band's floor, both columns at
 * `22rem` (a 326px content box), it needs ~40%, and a part between 35% and 40% there loses the
 * tail of its share to the part's `overflow: hidden` — a legible failure at a width that is
 * already the narrowest the band draws, with every figure still in the sentence.
 *
 * Only one part can ever be under it: the two shares sum to one and 0.35 is under a half.
 */
export const PART_TEXT_MIN_SHARE = 0.35;

/** The label over the bar — `ManaPips`' band label, so the two bands are one grammar. */
const LABEL = "text-[0.9375rem] font-medium text-text";

interface Part {
  key: "creature" | "noncreature";
  count: number;
  share: number;
  one: string;
  many: string;
  fill: string;
  fg: string;
}

export function CreatureSplitBar({ stats }: { stats: DeckStatsSummary }): JSX.Element | null {
  const { creatures, noncreatures, total } = creatureSplit(stats);
  // Nothing drawn for a deck with no nonland spells: a bar of nothing is a shape with no answer
  // in it, and the chart above already says the deck is lands or empty.
  if (total === 0) return null;

  const parts: Part[] = [
    {
      key: "creature",
      count: creatures,
      share: creatures / total,
      one: "creature",
      many: "creatures",
      fill: "var(--color-creature)",
      fg: "var(--color-creature-fg)",
    },
    {
      key: "noncreature",
      count: noncreatures,
      share: noncreatures / total,
      one: "noncreature",
      many: "noncreatures",
      fill: "var(--color-noncreature)",
      fg: "var(--color-text)",
    },
  ];
  // A part of nothing is not drawn at all — no zero-width segment, no `0 creatures` beside the
  // bar. The sentence still says it, which is where a zero is worth hearing.
  const drawn = parts.filter((part) => part.count > 0);
  const beside = drawn.filter((part) => part.share < PART_TEXT_MIN_SHARE);

  const spoken =
    `Creatures vs noncreatures: ${plural(creatures, "creature")} (${percent(creatures / total)}) ` +
    `and ${plural(noncreatures, "noncreature")} (${percent(noncreatures / total)}).`;

  return (
    <div className="flex flex-col gap-1">
      <span className={LABEL} aria-hidden="true">
        Creatures vs noncreatures
      </span>
      <span className="sr-only">{spoken}</span>
      <div aria-hidden="true" className="flex h-8 w-full overflow-hidden rounded-md bg-surface">
        {drawn.map((part, index) => (
          <span
            key={part.key}
            data-split-part={part.key}
            className="flex min-w-0 items-center justify-center overflow-hidden px-1.5"
            style={{
              width: `${part.share * 100}%`,
              background: part.fill,
              color: part.fg,
              // The seam — `--color-bg` and inset, so it is not subtracted from the share the
              // part stands for. On the first of two parts only; a lone part has nothing to meet.
              boxShadow:
                index < drawn.length - 1 ? "inset -1px 0 0 var(--color-bg)" : undefined,
            }}
          >
            {part.share >= PART_TEXT_MIN_SHARE ? <PartText part={part} /> : null}
          </span>
        ))}
      </div>
      {beside.length > 0 ? (
        // Under the bar at its own part's end — the creature part is always the left one and the
        // noncreature the right — with a swatch, since the words are no longer on the colour they
        // name.
        <div
          aria-hidden="true"
          data-split-beside={beside[0].key}
          className={cn(
            "flex text-text",
            beside[0].key === "creature" ? "justify-start" : "justify-end",
          )}
        >
          <span className="inline-flex items-center gap-1.5">
            <span
              className="size-2.5 shrink-0 rounded-sm"
              style={{ background: beside[0].fill }}
            />
            <PartText part={beside[0]} />
          </span>
        </div>
      ) : null}
    </div>
  );
}

/** `<count> creatures <share>` — the count bold, the share a step back at 80%. */
function PartText({ part }: { part: Part }): JSX.Element {
  return (
    <span className="inline-flex min-w-0 items-baseline gap-1 whitespace-nowrap">
      <span className="font-mono text-[0.8125rem] font-bold tabular-nums">{part.count}</span>
      <span className="text-xs">{part.count === 1 ? part.one : part.many}</span>
      <span className="font-mono text-xs tabular-nums opacity-80">{percent(part.share)}</span>
    </span>
  );
}
