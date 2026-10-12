// A baseline is a `results.json` kept under a name. When a scan is deleted its rows must leave
// every baseline too, or its id and figures live on in files the deletion never reached. This
// reads a file only as far as `runs[].id` and `skipped[].id`, so a change to the results schema
// cannot break it.

/**
 * The file's text with only the runs and skipped entries whose id is held, or null when that
 * is already all of them. Throws when the text is not JSON.
 */
export function keepingRuns(resultsText: string, held: Iterable<string>): string | null {
  const keep = new Set(held);
  const results = JSON.parse(resultsText) as { runs?: { id: string }[]; skipped?: { id: string }[] };
  let changed = false;
  for (const key of ["runs", "skipped"] as const) {
    const list = results[key];
    if (!Array.isArray(list)) continue;
    const kept = list.filter((entry) => keep.has(entry?.id));
    if (kept.length !== list.length) {
      results[key] = kept;
      changed = true;
    }
  }
  return changed ? JSON.stringify(results) : null;
}

/** `baselines/.pending.json`: the names whose upload failed. A missing or corrupt file is empty. */
export function parsePending(text: string | null): string[] {
  if (text === null) return [];
  try {
    const list: unknown = JSON.parse(text);
    if (!Array.isArray(list)) return [];
    return list.filter(
      (name): name is string => typeof name === "string" && /^[A-Za-z0-9_][A-Za-z0-9_.-]*\.json$/.test(name),
    );
  } catch {
    return [];
  }
}

/** The pending list after an attempt: names that uploaded leave it, names that failed join it. */
export function settlePending(pending: string[], failed: string[], uploaded: string[]): string[] {
  const done = new Set(uploaded);
  return [...new Set([...pending.filter((name) => !done.has(name)), ...failed])].sort();
}
