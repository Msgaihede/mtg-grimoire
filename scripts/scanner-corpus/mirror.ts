// The local copy of the scan corpus: `labels/<id>.json`, `runs/<id>.bin`, and each run cut
// into `frames/<id>/NN.jpg` for the report to draw. Readers' photographs — ignored by git,
// and kept in the main checkout so a worktree's removal cannot take them with it.

import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ID } from "./plan.ts";

/** `SCANNER_CORPUS_DIR`, else `.scanner-corpus/` beside the main checkout's `.git`. */
export function corpusDir(env: Record<string, string | undefined>, gitCommonDir: string): string {
  return env.SCANNER_CORPUS_DIR || join(dirname(gitCommonDir), ".scanner-corpus");
}

/** A run cut by its label, oldest frame first. The sentences are `card_scanner::replay::cut`'s. */
export function cutFrames(labelText: string, run: Uint8Array): Uint8Array[] {
  const lengths: number[] = (JSON.parse(labelText) as { run: { bytes: number }[] }).run.map((f) => f.bytes);
  const total = lengths.reduce((sum, n) => sum + n, 0);
  if (total !== run.length) {
    throw new Error(`the label's frames add up to ${total} bytes and the run is ${run.length}`);
  }
  let at = 0;
  return lengths.map((length, n) => {
    const frame = run.subarray(at, at + length);
    if (frame[0] !== 0xff || frame[1] !== 0xd8 || frame[2] !== 0xff) {
      throw new Error(`frame ${n} does not start as a JPEG does`);
    }
    at += length;
    return frame;
  });
}

function checked(id: string): string {
  if (!ID.test(id)) throw new Error(`not a scan id: ${JSON.stringify(id)}`);
  return id;
}

export function writePair(dir: string, id: string, label: Uint8Array, run: Uint8Array): void {
  checked(id);
  const frames = cutFrames(new TextDecoder().decode(label), run);
  for (const sub of ["labels", "runs", join("frames", id)]) mkdirSync(join(dir, sub), { recursive: true });
  frames.forEach((frame, n) => writeFileSync(join(dir, "frames", id, `${String(n).padStart(2, "0")}.jpg`), frame));
  writeFileSync(join(dir, "runs", `${id}.bin`), run);
  // The label last: `localIds` reads it as "this pair is whole".
  writeFileSync(join(dir, "labels", `${id}.json`), label);
}

/**
 * The sentence on why a pair does not add up, or null when it does: the label parses, its
 * frames' `bytes` sum to the run's length, and each frame starts as a JPEG does.
 */
export function checkPair(label: Uint8Array, run: Uint8Array): string | null {
  let parsed: { run?: unknown };
  try {
    parsed = JSON.parse(new TextDecoder().decode(label)) as { run?: unknown };
  } catch {
    return "the label is not JSON";
  }
  const frames = parsed?.run;
  if (Array.isArray(frames) && frames.length === 0) return "the label's run holds no frames";
  if (!Array.isArray(frames) || !frames.every((f) => Number.isSafeInteger((f as { bytes?: unknown })?.bytes))) {
    return "the label has no run of frames with a `bytes` each";
  }
  try {
    cutFrames(new TextDecoder().decode(label), run);
    return null;
  } catch (error) {
    return (error as Error).message;
  }
}

export function removePair(dir: string, id: string): void {
  checked(id);
  // The label last: `localIds` reads it, so a removal interrupted before it is seen and redone.
  rmSync(join(dir, "frames", id), { recursive: true, force: true });
  rmSync(join(dir, "out", "slices", id), { recursive: true, force: true });
  rmSync(join(dir, "runs", `${id}.bin`), { force: true });
  rmSync(join(dir, "labels", `${id}.json`), { force: true });
}

/** The frame and slice folders whose id is not a local pair (and is a safe id). */
export function orphans(
  frameDirs: string[],
  sliceDirs: string[],
  local: string[],
): { frames: string[]; slices: string[] } {
  const held = new Set(local);
  const stray = (names: string[]) => names.filter((name) => ID.test(name) && !held.has(name)).sort();
  return { frames: stray(frameDirs), slices: stray(sliceDirs) };
}

/** Remove those folders. Returns how many it removed; idempotent. */
export function sweepOrphans(dir: string): number {
  const list = (sub: string) => (existsSync(join(dir, sub)) ? readdirSync(join(dir, sub)) : []);
  const found = orphans(list("frames"), list(join("out", "slices")), localIds(dir));
  for (const id of found.frames) rmSync(join(dir, "frames", id), { recursive: true, force: true });
  for (const id of found.slices) rmSync(join(dir, "out", "slices", id), { recursive: true, force: true });
  return found.frames.length + found.slices.length;
}

/** Delete the last replay's results, summary and report, which hold every scan. True if any was there. */
export function removeReport(dir: string): boolean {
  let any = false;
  for (const name of ["results.json", "summary.md", "report.html"]) {
    const path = join(dir, "out", name);
    if (existsSync(path)) any = true;
    rmSync(path, { force: true });
  }
  return any;
}

/** Ids with both a label and a run on disk. */
export function localIds(dir: string): string[] {
  const labels = join(dir, "labels");
  if (!existsSync(labels)) return [];
  return readdirSync(labels)
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.slice(0, -".json".length))
    .filter((id) => ID.test(id))
    .filter((id) => existsSync(join(dir, "runs", `${id}.bin`)))
    .sort();
}
