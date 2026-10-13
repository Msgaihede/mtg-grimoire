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

/**
 * A scan id: no dot and no slash, so it cannot name anything outside its folder, and no leading
 * `-`, so it can never read as a flag in a command line. The one definition: the report's script
 * and every key pattern here are made from it.
 */
export const ID_BODY = "[A-Za-z0-9_][A-Za-z0-9_-]*";
export const ID = new RegExp(`^${ID_BODY}$`);
const RUN = new RegExp(`^runs/(${ID_BODY})\\.bin$`);
const LABEL = new RegExp(`^labels/(${ID_BODY})\\.json$`);

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

/** Which of a scan's two objects a bucket holds. */
export type Side = "both" | "run" | "label" | null;
export type Deletion = { bucket: "inbox" | "corpus"; key: string };
export type Removal = {
  id: string;
  inbox: Side;
  corpus: Side;
  /** The mirror holds the pair (`localIds`). */
  local: boolean;
  /** Found in neither bucket nor the mirror: nothing to delete, and the command exits 1. */
  notFound: boolean;
  /** Only objects that were listed, in the order they are deleted. */
  deletions: Deletion[];
};

/**
 * What `remove` would do to each id, from the listings alone. The order is the inbox before
 * the corpus (so an interrupted run cannot be adopted again by the next pull) and, in each,
 * the label before the run (so a half-deleted scan is litter, never a label with no run). An
 * object that is not listed is not deleted, so a half pair or a lone run can be removed too;
 * the keys are the exact two names a scan has, nothing matched by prefix.
 */
export function removalPlan(ids: string[], inbox: Entry[], corpus: Entry[], local: string[]): Removal[] {
  const inboxKeys = new Set(inbox.map((e) => e.key));
  const corpusKeys = new Set(corpus.map((e) => e.key));
  const mirrored = new Set(local);
  const side = (keys: Set<string>, id: string): Side => {
    const run = keys.has(`runs/${id}.bin`);
    const label = keys.has(`labels/${id}.json`);
    return run && label ? "both" : run ? "run" : label ? "label" : null;
  };
  return ids.map((id) => {
    const here = side(inboxKeys, id);
    const there = side(corpusKeys, id);
    const deletions: Deletion[] = [];
    for (const [bucket, held] of [["inbox", here], ["corpus", there]] as const) {
      if (held === "both" || held === "label") deletions.push({ bucket, key: `labels/${id}.json` });
      if (held === "both" || held === "run") deletions.push({ bucket, key: `runs/${id}.bin` });
    }
    const local = mirrored.has(id);
    return { id, inbox: here, corpus: there, local, notFound: !here && !there && !local, deletions };
  });
}
