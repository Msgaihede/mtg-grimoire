import { count } from "@/lib/counts";
import { cn } from "@/lib/utils";
import type { ScannerChoice, ScannerOutcome, ScannerResolution, ScannerTier } from "../types";
import { FIGURES, Panel, Row } from "./Panel";

/** The empty panel's sentence — the one instruction that fills it. */
export const NO_RESOLVE = "No resolve yet — switch to Exact and hold a card steady.";

/** The crate's tier ids in words. The rows draw in the order the resolve lists them, which is the
 *  pipeline's — nothing here sorts them, because the order is what the panel is showing. */
const TIER_WORDS: Record<ScannerTier["tier"], string> = {
  filters: "filters",
  whole_card: "whole card",
  title: "title",
  collector: "collector",
  re_rank: "re-rank",
  classifier: "classifier",
};

const OUTCOME_WORDS: Record<ScannerOutcome, string> = {
  resolved: "resolved",
  ambiguous: "ambiguous",
  not_found: "not found",
};

/** `Lightning Bolt — 2X2 117`, or the bare id where the corpus could not name the printing. */
function choiceName(choice: ScannerChoice): string {
  const label = choice.label;
  return label === null ? choice.id : `${label.name} — ${label.set.toUpperCase()} ${label.number}`;
}

/**
 * The normalized distance a choice reached, or what found it instead. A printing only a name read
 * reached has no distance at all, and an em dash there would read as a figure that failed to load.
 */
function choiceDistance(choice: ScannerChoice): string {
  return choice.distance === null ? "name read" : choice.distance.toFixed(3);
}

/**
 * What the last Exact resolve did, tier by tier — the developer's answer to *why this printing*.
 *
 * **The last resolve, not this frame's.** A resolve is reported on the one frame it ran on, and
 * the page's loop latches it until the card leaves the frame, so the panel reads the same list for
 * as long as the card it is about is still in front of the lens — `lastOcr`'s argument, one tier
 * further on.
 *
 * **One row per tier, in the pipeline's order, all six of them** — survivors beside the tier's own
 * words for what it did: the read name, the collector pairing, a conflict, the margin. A tier that
 * changed nothing still draws, because *the title read found nothing* is as much of an answer as
 * *the title read narrowed four printings to one*. Then the choices the resolve ended on, best
 * first, each with the distance it reached across the burst.
 *
 * Folded by default like every panel in this column: a reader who is only scanning never asks it
 * anything, and the reader's own view already says what the outcome means for them.
 */
export function TiersPanel({ resolution }: { resolution: ScannerResolution | null }) {
  return (
    <Panel id="tiers" title="Tiers">
      {resolution === null ? (
        <p className="text-sm text-dim">{NO_RESOLVE}</p>
      ) : (
        <>
          <dl className={FIGURES}>
            <Row
              label="outcome"
              value={OUTCOME_WORDS[resolution.outcome]}
              tone={resolution.outcome === "resolved" ? "text-accent" : undefined}
            />
            <Row label="elapsed" value={`${resolution.elapsed_ms.toFixed(0)} ms`} />
          </dl>

          <ol aria-label="Tiers, in order" className="space-y-1.5 text-sm">
            {resolution.tiers.map((t) => (
              <li key={t.tier} className="grid grid-cols-[auto_1fr] gap-x-3">
                <span className="text-dim">{TIER_WORDS[t.tier]}</span>
                <span className="text-right tabular-nums">{count(t.survivors)}</span>
                {/* The detail under the pair rather than beside it: it is the tier's own sentence,
                    and a 320px column has no room for a sentence and two figures on one line. */}
                <span className="col-span-2 break-words text-xs text-dim">{t.detail}</span>
              </li>
            ))}
          </ol>

          {resolution.choices.length > 0 && (
            <ol aria-label="Choices, best first" className="space-y-1 text-sm">
              {resolution.choices.map((c, i) => (
                <li
                  key={c.id}
                  className={cn("flex justify-between gap-3", i === 0 ? "text-text" : "text-dim")}
                >
                  <span className="min-w-0 truncate">{choiceName(c)}</span>
                  <span className="shrink-0 tabular-nums">{choiceDistance(c)}</span>
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </Panel>
  );
}
