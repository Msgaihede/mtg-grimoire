import { useState } from "react";
import { cn } from "@/lib/utils";
import type { ScannerLabel, ScannerStatus, ScannerVerdict } from "../types";
import {
  SURE_DISTANCE,
  barFill,
  bundleSentence,
  leadLine,
  shareLine,
  standingValue,
  verdictWord,
} from "../verdictText";
import { BUTTON, FIGURES, Panel, Row } from "./Panel";

/** How a printing is named across this panel: the card, then the printing that names it. */
function printing(label: ScannerLabel): string {
  return `${label.name} — ${label.set.toUpperCase()} ${label.number}`;
}

/** The same pair in a standings row, where the separator has to survive being read in a list. */
function standingName(label: ScannerLabel | null, id: string): string {
  return label === null ? id : `${label.name} · ${label.set.toUpperCase()} ${label.number}`;
}

/**
 * What the tracker has come to, as the panel's head row.
 *
 * Not `verdictText.ts`'s `headline`, which is a different sentence for a different place: that
 * one is the word drawn *over the video* and says what the frame is ("looking…", "no card").
 * This is the name of the printing the evidence stands behind.
 */
function headLabel(verdict: ScannerVerdict | null): string {
  const lead = verdict?.tracked?.standings[0];
  if (lead === undefined) return "—";
  return lead.label === null ? lead.id.slice(0, 8) : printing(lead.label);
}

/** What *this* frame said, as against the accumulated answer above it. */
function thisFrame(verdict: ScannerVerdict | null): string {
  if (verdict === null) return "this frame: —";
  if (!verdict.ok) return "this frame: no card";
  const best = verdict.match?.candidates[0];
  if (best === undefined) return "this frame: no match";
  return `this frame: ${best.label?.name ?? best.id} · d=${best.distance}`;
}

/**
 * The panel the screen is for: what the scanner has decided, how sure it is, and what is
 * still arguing with it.
 *
 * **Never folded** — every other panel here answers "why did it decide that", which is a
 * question a reader asks occasionally; this one answers "what did it decide", which is the
 * whole screen. It is also the only panel with two presses in it, and both are about the
 * *evidence* rather than about the card: throw the accumulation away, or file this frame in
 * the dataset under the name a person read off the cardboard.
 */
export function MatchPanel({
  status,
  verdict,
  rate,
  onReset,
  onCapture,
}: {
  status: ScannerStatus | null;
  verdict: ScannerVerdict | null;
  /** Frames per second over the last twenty, or `null` before there have been twenty. */
  rate: number | null;
  onReset: () => void;
  onCapture: (expected: string) => Promise<string>;
}) {
  const [expected, setExpected] = useState("");
  const [note, setNote] = useState("");

  const tracked = verdict?.tracked ?? null;
  const match = verdict?.match ?? null;
  const best = match?.candidates[0] ?? null;
  const rule = tracked?.rule ?? "votes";
  const committed = tracked?.committed ?? false;
  const fill = barFill(tracked);
  const word = verdictWord(tracked);
  const noBundle = bundleSentence(status);
  const trim = verdict?.trim ?? null;
  const trimmed =
    trim !== null && [trim.left, trim.top, trim.right, trim.bottom].some((n) => n !== 0);

  function capture() {
    setNote("saving…");
    onCapture(expected).then(
      (saved) => setNote(`saved ${saved}`),
      (err: unknown) => setNote(err instanceof Error ? err.message : String(err)),
    );
  }

  return (
    <Panel id="match" title="Match">
      {/* A missing bundle is not a poor verdict, it is the absence of anything to be right
          about — so the sentence stands where the name would, rather than under it. */}
      {noBundle !== null ? (
        <p className="text-sm text-destructive">{noBundle}</p>
      ) : (
        <div className="flex items-baseline justify-between gap-2">
          <span className="font-heading text-base leading-tight">{headLabel(verdict)}</span>
          {word !== null && (
            <span
              className={cn(
                "shrink-0 rounded px-1.5 py-0.5 text-xs",
                committed ? "bg-accent text-accent-fg" : "bg-bg text-dim",
              )}
            >
              {word}
            </span>
          )}
        </div>
      )}

      {/* The bar is the evidence, and the hairline is the line it has to cross: the right end
          under the vote rule, where the bar *is* `decide_at`, and 70% under confidence. */}
      <div
        role="progressbar"
        aria-label="Evidence"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(fill * 100)}
        className="relative h-2 overflow-hidden rounded bg-bg"
      >
        <div
          className={cn(
            "h-full transition-[width] motion-reduce:transition-none",
            committed ? "bg-accent" : "bg-dim",
          )}
          style={{ width: `${fill * 100}%` }}
        />
        <span
          aria-hidden="true"
          className="absolute inset-y-0 w-px bg-dim"
          style={rule === "confidence" ? { left: "70%" } : { right: 0 }}
        />
      </div>

      <dl className={FIGURES}>
        <Row label={rule} value={shareLine(tracked)} />
        <Row label="lead" value={leadLine(tracked)} />
        <Row
          label="distance ↓"
          value={best === null ? "—" : `${best.distance} / 256 bits`}
          tone={best !== null && best.normalized > SURE_DISTANCE ? "text-accent" : undefined}
        />
        <Row label="margin" value={match?.margin == null ? "—" : `${match.margin} bits`} />
        <Row
          label="orientation"
          value={match === null ? "—" : match.rotated ? "rotated 180°" : "upright"}
        />
        <Row
          label="cardness"
          value={
            verdict?.cardness == null
              ? "—"
              : `${verdict.cardness.score.toFixed(2)} (t${verdict.cardness.title.toFixed(2)}/y${verdict.cardness.type_line.toFixed(2)})`
          }
        />
        <Row
          label="trim l/t/r/b"
          value={trimmed && trim ? `${trim.left}/${trim.top}/${trim.right}/${trim.bottom}` : "—"}
        />
        {/* `[raw] no printing` in the brief's table, with the raw read standing in for `raw`:
            the tier read *something* off the card and could not turn it into a printing, and
            the string it read is the whole of why. */}
        <Row
          label="collector"
          value={
            verdict?.collector == null
              ? "—"
              : (verdict.collector.matched ?? `[${verdict.collector.raw}] no printing`)
          }
        />
        <Row
          label="lock"
          value={verdict?.lock == null ? "—" : `${verdict.lock.phase} ${verdict.lock.agree}/3`}
        />
      </dl>

      {tracked !== null && tracked.standings.length > 0 && (
        <ol className="space-y-1 text-sm">
          {tracked.standings.map((s, i) => (
            <li
              key={s.id}
              className={cn("flex justify-between gap-3", i === 0 ? "text-text" : "text-dim")}
            >
              <span className="truncate">{standingName(s.label, s.id)}</span>
              <span className="shrink-0 tabular-nums">{standingValue(s, rule)}</span>
            </li>
          ))}
        </ol>
      )}

      <p className="text-sm text-dim">{thisFrame(verdict)}</p>
      <p className="text-sm text-dim tabular-nums">
        {rate === null ? "—" : `${rate.toFixed(1)}/s`}
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={onReset} className={BUTTON}>
          Reset evidence
        </button>
        <input
          type="text"
          aria-label="What it actually is"
          placeholder="What it actually is"
          value={expected}
          onChange={(e) => setExpected(e.target.value)}
          className="min-w-0 flex-1 rounded-md border border-border bg-bg px-2 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        />
        <button type="button" onClick={capture} className={BUTTON}>
          Add frame to dataset
        </button>
      </div>
      {/* Always mounted, empty or not: a live region added to the page at the moment it has
          something to say is one a screen reader has not been watching. */}
      <p role="status" className="min-h-[1.25rem] text-sm text-dim">
        {note}
      </p>
    </Panel>
  );
}
