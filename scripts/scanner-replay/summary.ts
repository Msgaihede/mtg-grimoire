// Every count drawn from a replay's `results.json`, in one place: the table, the breakdowns
// and the comparison with a baseline. `summary.md` and the report both read these, so the
// two cannot count a scan differently.

import type { Results, Run, Score } from "./results.ts";

export const PASSES = ["As scanned", "Fast", "Exact"] as const;

export type Tally = {
  n: number;
  /** The reader's printing. */
  printing: number;
  /** The reader's card: its printing, or another printing of it. */
  card: number;
  wrong: number;
  undecided: number;
  /** Of the undecided: Exact passes too short to try to resolve, which is no miss of the scanner. */
  unresolved: number;
  /** Of the undecided: a decision was made, then nothing was held at the end. */
  lost: number;
  /** Could not be replayed; left out of every percentage. */
  error: number;
  ambiguous: number;
  /** Frames to the first decision, over the runs that made one. */
  medianFrames: number | null;
};

export function tally(runs: Run[], pass: string): Tally {
  const out: Tally = { n: 0, printing: 0, card: 0, wrong: 0, undecided: 0, unresolved: 0, lost: 0, error: 0, ambiguous: 0, medianFrames: null };
  const frames: number[] = [];
  for (const run of runs) {
    const p = run.passes.find((candidate) => candidate.name === pass);
    if (!p) continue;
    out.n += 1;
    if (p.score === "printing") out.printing += 1;
    if (p.score === "printing" || p.score === "card") out.card += 1;
    if (p.score === "wrong") out.wrong += 1;
    if (p.score === "undecided") out.undecided += 1;
    const decidedAt = typeof p.decision_frame === "number";
    if (p.score === "undecided" && decidedAt) out.lost += 1;
    if (p.score === "undecided" && !decidedAt && p.resolve_ran === false) out.unresolved += 1;
    if (p.score === "error") out.error += 1;
    if (p.ambiguous) out.ambiguous += 1;
    if (typeof p.first_decision_frame === "number" && Number.isFinite(p.first_decision_frame)) frames.push(p.first_decision_frame);
  }
  frames.sort((a, b) => a - b);
  if (frames.length) {
    const mid = frames.length >> 1;
    out.medianFrames = frames.length % 2 ? frames[mid] : (frames[mid - 1] + frames[mid]) / 2;
  }
  return out;
}

/** A share of the runs that replayed, to one decimal. */
export function percent(count: number, t: Tally): string {
  const of = t.n - t.error;
  return of ? ((100 * count) / of).toFixed(1) : "—";
}

export function breakdowns(runs: Run[]): { by: string; value: string; runs: Run[] }[] {
  const keys: [string, (run: Run) => string][] = [
    ["finish", (r) => r.finish],
    ["platform", (r) => r.platform],
    ["mode", (r) => r.mode],
    ["detail", (r) => (r.detail ? "yes" : "no")],
  ];
  return keys.flatMap(([by, of]) => {
    const groups = new Map<string, Run[]>();
    for (const run of runs) groups.set(of(run), [...(groups.get(of(run)) ?? []), run]);
    return [...groups].sort(([a], [b]) => (a < b ? -1 : 1)).map(([value, group]) => ({ by, value, runs: group }));
  });
}

export type Flip = { id: string; name: string; pass: string; from: Score; to: Score };
export type Delta = { fixed: Flip[]; broken: Flip[]; moved: Flip[]; added: string[]; removed: string[] };

/** How good a score is: printing, then card, then undecided, then wrong. `error` is unranked. */
const RANK: Partial<Record<Score, number>> = { printing: 3, card: 2, undecided: 1, wrong: 0 };

/**
 * `fixed`: moved up to `printing`. `broken`: moved down from `printing`, or from `card` to
 * `wrong`. Any other change, and any change to or from `error`, is `moved`.
 */
export function compare(now: Results, base: Results): Delta {
  const before = new Map(base.runs.map((run) => [run.id, run]));
  const delta: Delta = { fixed: [], broken: [], moved: [], added: [], removed: [] };
  for (const run of now.runs) {
    const old = before.get(run.id);
    if (!old) {
      delta.added.push(run.id);
      continue;
    }
    for (const p of run.passes) {
      const from = old.passes.find((candidate) => candidate.name === p.name)?.score;
      if (from === undefined || from === p.score) continue;
      const flip = { id: run.id, name: run.card.name, pass: p.name, from, to: p.score };
      // A run that could not replay says nothing of the scanner: its change is only ever a move.
      const was = RANK[from];
      const is = RANK[p.score];
      let bucket = delta.moved;
      if (was !== undefined && is !== undefined) {
        if (p.score === "printing") bucket = delta.fixed;
        else if (is < was && (from === "printing" || (from === "card" && p.score === "wrong"))) bucket = delta.broken;
      }
      bucket.push(flip);
    }
  }
  const held = new Set(now.runs.map((run) => run.id));
  delta.removed = base.runs.map((run) => run.id).filter((id) => !held.has(id));
  return delta;
}

/** A value from the file, made safe for a table cell or a list line. */
export const cell = (value: unknown): string =>
  String(value ?? "")
    .replace(/\s*[\r\n]+\s*/g, " ")
    .replaceAll("|", "\\|");

const HEAD =
  "| pass | n | printing ✓ % | card ✓ % | wrong card | undecided % | errors | ambiguous | median frames | never resolved | decided then lost |\n" +
  "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |";

function row(name: string, runs: Run[], pass: string): string {
  const t = tally(runs, pass);
  return `| ${cell(name)} | ${t.n} | ${percent(t.printing, t)} | ${percent(t.card, t)} | ${t.wrong} | ${percent(t.undecided, t)} | ${t.error} | ${t.ambiguous} | ${t.medianFrames ?? "—"} | ${t.unresolved} | ${t.lost} |`;
}

const flips = (title: string, list: Flip[]) =>
  list.length ? [`**${title}** (${list.length})`, "", ...list.map((f) => `- ${cell(f.name)} — ${cell(f.pass)}: ${cell(f.from)} → ${cell(f.to)} (\`${cell(f.id)}\`)`), ""] : [];

export function summaryMarkdown(now: Results, base: Results | null): string {
  const lines = [
    "# Scanner replay",
    "",
    "Readers' scans, replayed: real frames, labelled by the reader who sent them. A replay starts",
    "with no earlier evidence and no detail pictures, so *then* is what the scanner said live.",
    "",
    `${now.runs.length} scans, ${now.skipped.length} skipped; commit \`${cell(now.commit ?? "unknown")}\`, bundle of ${cell(now.bundle_printings)} printings.`,
    "",
    HEAD,
    ...PASSES.map((pass) => row(pass, now.runs, pass)),
    "",
  ];
  const then = now.runs.filter((run) => run.then.score === "printing").length;
  const differs = now.runs.filter((run) => (run.decided_differs ?? 0) > 0).length;
  const unknown = now.runs.filter((run) => run.decided_differs === null).length;
  lines.push(`Then: the shipped scanner had the reader's printing on ${then} of ${now.runs.length}. ` +
    `${differs} replayed with a different decision on at least one frame${unknown ? `; ${unknown} not comparable frame by frame` : ""}.`, "");
  lines.push("## As scanned, by kind", "", HEAD.replace("| pass |", "| kind |"));
  for (const part of breakdowns(now.runs)) lines.push(row(`${part.by}: ${part.value}`, part.runs, "As scanned"));
  lines.push("");
  if (now.skipped.length) {
    lines.push("## Skipped", "", ...now.skipped.map((s) => `- \`${cell(s.id)}\` — ${cell(s.why)}`), "");
  }
  if (base) {
    const delta = compare(now, base);
    lines.push(`## Against \`${cell(base.commit ?? "unknown")}\``, "");
    if (base.bundle_printings !== now.bundle_printings) {
      lines.push(`The baseline ran against another bundle (${base.bundle_printings} printings then, ${now.bundle_printings} now), so a change here may be the bundle's.`, "");
    }
    lines.push(...flips("Fixed", delta.fixed), ...flips("Broken", delta.broken), ...flips("Moved", delta.moved));
    if (!delta.fixed.length && !delta.broken.length && !delta.moved.length) lines.push("No scan changed.", "");
    if (delta.added.length) lines.push(`${delta.added.length} scans are new since the baseline.`, "");
    if (delta.removed.length) lines.push(`${delta.removed.length} scans of the baseline are gone.`, "");
  }
  return lines.join("\n");
}
