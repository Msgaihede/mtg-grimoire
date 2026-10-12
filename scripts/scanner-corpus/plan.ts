// What a sync has to do, from three listings and nothing else — so it is decided without a
// network, and tested without one. The executor is `scripts/scanner-corpus.ts`.

import type { Entry } from "./s3.ts";

export type Plan = {
  /** Ids to copy from the inbox to the corpus. */
  adopt: string[];
  /** Ids the mirror lacks. */
  fetch: string[];
  /** Local ids the corpus no longer holds — a deleted scan. */
  prune: string[];
  /** Inbox runs with no label: failed uploads. Reported, never touched. */
  litter: string[];
  /** Raw inbox keys under `runs/` or `labels/` whose id is not a safe one. Reported, never touched. */
  strange: string[];
  /** Baseline keys the corpus holds. */
  baselinesDown: string[];
};

/** A scan id: no dot and no slash, so it cannot name anything outside its folder. */
export const ID = /^[A-Za-z0-9_-]+$/;
const RUN = /^runs\/([A-Za-z0-9_-]+)\.bin$/;
const LABEL = /^labels\/([A-Za-z0-9_-]+)\.json$/;

/** A corpus that lists no scans beside a mirror that holds some is a bad listing, not a purge. */
export function refusesPrune(corpusPairs: number, localCount: number): boolean {
  return corpusPairs === 0 && localCount > 0;
}

/** Complete pairs by id, with each object's size. */
export function pairs(entries: Entry[]): Map<string, { run: number; label: number }> {
  const runs = new Map<string, number>();
  const labels = new Map<string, number>();
  for (const { key, size } of entries) {
    const run = RUN.exec(key)?.[1];
    const label = LABEL.exec(key)?.[1];
    if (run) runs.set(run, size);
    if (label) labels.set(label, size);
  }
  const out = new Map<string, { run: number; label: number }>();
  for (const [id, run] of [...runs].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const label = labels.get(id);
    if (label !== undefined) out.set(id, { run, label });
  }
  return out;
}

export function plan(listing: { inbox: Entry[]; corpus: Entry[]; local: string[] }): Plan {
  const inbox = pairs(listing.inbox);
  const corpus = pairs(listing.corpus);
  const local = new Set(listing.local);
  const adopt = [...inbox.keys()].filter((id) => !corpus.has(id));
  const held = new Set([...corpus.keys(), ...adopt]);
  return {
    adopt,
    fetch: [...held].filter((id) => !local.has(id)).sort(),
    prune: listing.local.filter((id) => !held.has(id)).sort(),
    litter: listing.inbox.flatMap(({ key }) => {
      const id = RUN.exec(key)?.[1];
      return id && !inbox.has(id) ? [id] : [];
    }),
    strange: listing.inbox
      .map((e) => e.key)
      .filter((key) => /^(runs|labels)\//.test(key) && !RUN.test(key) && !LABEL.test(key)),
    baselinesDown: listing.corpus.map((e) => e.key).filter((key) => key.startsWith("baselines/")),
  };
}

/** The candidate ids whose copy in the corpus is as long as the inbox's, object for object. */
export function drainable(candidates: string[], inbox: Entry[], corpusAfter: Entry[]): string[] {
  const from = pairs(inbox);
  const to = pairs(corpusAfter);
  return candidates.filter((id) => {
    const a = from.get(id);
    const b = to.get(id);
    return a !== undefined && b !== undefined && a.run === b.run && a.label === b.label;
  });
}

/** The adopted ids whose copy in the corpus is missing or of other sizes than the inbox's. */
export function unverified(adopted: string[], inbox: Entry[], corpusAfter: Entry[]): string[] {
  const ok = new Set(drainable(adopted, inbox, corpusAfter));
  return adopted.filter((id) => !ok.has(id));
}
