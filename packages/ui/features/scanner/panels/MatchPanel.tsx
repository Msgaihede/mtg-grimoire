import { useState } from "react";
import { cn } from "@/lib/utils";
import type { ScannerCollector, ScannerLabel, ScannerStatus, ScannerVerdict } from "../types";
import { SURE_DISTANCE, bundleSentence, leadLine, shareLine, standingValue } from "../verdictText";
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
 * tally, the lead, the distances and the standings.
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
  lastCollector,
  rate,
  onCapture,
}: {
  status: ScannerStatus | null;
  verdict: ScannerVerdict | null;
  /**
   * The last collector-line read, not this frame's — `ScannerPanelsProps.lastOcr`'s reason.
   * The readers run on one eligible frame in four, so `verdict.collector` is `null` three
   * frames in four and a row fed it blinks `—` about a tier that read the card correctly.
   */
  lastCollector: ScannerCollector | null;
  /** Frames per second over the last twenty, or `null` before there have been twenty. */
  rate: number | null;
  onCapture: (expected: string) => Promise<string>;
}) {
  const [expected, setExpected] = useState("");
  const [note, setNote] = useState("");

  const tracked = verdict?.tracked ?? null;
  const match = verdict?.match ?? null;
  const best = match?.candidates[0] ?? null;
  const rule = tracked?.rule ?? "votes";
  const bundleNote = bundleSentence(status);
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
      {/* The bundle's sentence, once and first. It used to stand in place of the card's name
          when nothing could be named, and under it when only the labels failed; with the name
          gone to the strip there is one place left for it, and a developer reading down this
          panel reads why its figures are empty — or are ids — before reading the figures. A
          file's path is not the strip's to say; the strip says only that nothing can be named. */}
      {bundleNote !== null && <p className="text-sm text-destructive">{bundleNote}</p>}

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
            lastCollector === null
              ? "—"
              : (lastCollector.matched ?? `[${lastCollector.raw}] no printing`)
          }
        />
        <Row
          label="lock"
          // "/3" is the three-frame count still to reach; a locked quad has reached it, or
          // Fast's two-frame quick path has made it unnecessary, so "locked 2/3" never shows.
          value={
            verdict?.lock == null
              ? "—"
              : verdict.lock.phase === "locked"
                ? `locked ${verdict.lock.agree}`
                : `${verdict.lock.phase} ${verdict.lock.agree}/3`
          }
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
