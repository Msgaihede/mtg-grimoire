import { useState } from "react";
import { cn } from "@/lib/utils";
import type { ScannerLabel, ScannerStatus, ScannerVerdict } from "../types";
import { neuralSentence, shareLine, standingValue } from "../verdictText";
import { BUTTON, FIGURES, Panel, Row } from "./Panel";

/** A card and its printing in a standings row, where the separator has to survive being read in a list. */
function standingName(label: ScannerLabel | null, id: string): string {
  return label === null ? id : `${label.name} · ${label.set.toUpperCase()} ${label.number}`;
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
 * The figures behind the Match strip: how sure the scanner is, and what is still arguing with it.
 *
 * **The card's name and the bar are not here any more** — `reader/MatchStrip` draws both above
 * the camera for every reader, a developer included, so a head row and a bar here would be the
 * same answer twice on one screen. What stays is what the strip deliberately never says: the
 * tally, the distances and the standings.
 *
 * **Never folded** — every other panel here answers "why did it decide that", which is a
 * question a reader asks occasionally; this one is the numbers under "what did it decide", which
 * is the whole screen. It is also the only panel with a press in it, and that press is about the
 * *evidence* rather than about the card: file this frame in the dataset under the name a person
 * read off the cardboard. Its sibling, *Reset evidence*, moved to the Match strip beside the bar
 * on 2026-10-01 (issue #740), where every reader can reach it.
 */
export function MatchPanel({
  status,
  verdict,
  rate,
  onCapture,
}: {
  status: ScannerStatus | null;
  verdict: ScannerVerdict | null;
  /** Frames per second over the last twenty, or `null` before there have been twenty. */
  rate: number | null;
  onCapture: (expected: string) => Promise<string>;
}) {
  const [expected, setExpected] = useState("");
  const [note, setNote] = useState("");

  const tracked = verdict?.tracked ?? null;
  const match = verdict?.match ?? null;
  const best = match?.candidates[0] ?? null;
  const neuralNote = neuralSentence(status);

  function capture() {
    setNote("saving…");
    onCapture(expected).then(
      (saved) => setNote(`saved ${saved}`),
      (err: unknown) => setNote(err instanceof Error ? err.message : String(err)),
    );
  }

  return (
    <Panel id="match" title="Match">
      {/* The recogniser's sentence, once and first: a developer reading down this panel reads
          why its figures are empty before reading the figures. */}
      {neuralNote !== null && <p className="text-sm text-destructive">{neuralNote}</p>}

      <dl className={FIGURES}>
        <Row label="votes" value={shareLine(tracked)} />
        <Row
          label="distance ↓"
          value={best === null ? "—" : `${best.normalized.toFixed(3)} (${best.distance}/256)`}
        />
        <Row label="margin" value={match?.margin == null ? "—" : `${match.margin}/128`} />
        <Row
          label="orientation"
          value={match === null ? "—" : match.rotated ? "rotated 180°" : "upright"}
        />
        <Row
          label="cards read"
          value={verdict?.candidates_examined == null ? "—" : String(verdict.candidates_examined)}
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
              <span className="shrink-0 tabular-nums">{standingValue(s)}</span>
            </li>
          ))}
        </ol>
      )}

      <p className="text-sm text-dim">{thisFrame(verdict)}</p>
      <p className="text-sm text-dim tabular-nums">
        {rate === null ? "—" : `${rate.toFixed(1)}/s`}
      </p>

      <div className="flex flex-wrap items-center gap-2">
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
