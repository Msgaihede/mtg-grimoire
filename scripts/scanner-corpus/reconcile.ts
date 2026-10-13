// The baselines half of a pull, shared with `remove`: down what the corpus has and this machine
// lacks; out of every local one the rows a caller's `rewrite` drops; then up what only this
// machine has, what was just rewritten and what an earlier run could not upload. A pull's
// `rewrite` keeps the scans the corpus holds; a removal's drops the named ones.

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parsePending, settlePending } from "./baselines.ts";
import type { S3 } from "./s3.ts";

const safeName = (name: string) => name.endsWith(".json") && !name.startsWith(".");

export async function reconcileBaselines(o: {
  dir: string;
  s3: S3;
  bucket: string;
  /** The `baselines/…` keys the corpus holds. */
  down: string[];
  /** The file's new text, or null when it keeps every row. Throws on text that is not JSON. */
  rewrite: (text: string) => string | null;
  /** Said of a rewritten file: "rewritten without …". */
  without: string;
  failed: string[];
  log: (line: string) => void;
}): Promise<void> {
  const { dir, s3, bucket, failed } = o;
  const baselines = join(dir, "baselines");
  mkdirSync(baselines, { recursive: true });
  for (const key of o.down.filter((k) => safeName(basename(k)))) {
    try {
      const path = join(baselines, basename(key));
      if (!existsSync(path)) writeFileSync(path, await s3.get(bucket, key));
    } catch (error) {
      failed.push(`${key}: ${(error as Error).message}`);
    }
  }
  const remote = new Set(o.down.map((key) => basename(key)));
  const pendingPath = join(baselines, ".pending.json");
  const pending = parsePending(existsSync(pendingPath) ? readFileSync(pendingPath, "utf8") : null);
  const rewritten = new Set<string>();
  const unreadable = new Set<string>();
  for (const name of readdirSync(baselines).filter(safeName)) {
    try {
      const path = join(baselines, name);
      const text = o.rewrite(readFileSync(path, "utf8"));
      if (text === null) {
        JSON.parse(readFileSync(path, "utf8"));
        continue;
      }
      writeFileSync(path, text);
      rewritten.add(name);
      o.log(`baseline ${name} rewritten without ${o.without}`);
    } catch (error) {
      unreadable.add(name);
      failed.push(`baselines/${name}: not uploaded, ${(error as Error).message}`);
    }
  }
  const local = readdirSync(baselines).filter(safeName);
  const upload = local.filter(
    (n) => !unreadable.has(n) && (!remote.has(n) || rewritten.has(n) || pending.includes(n)),
  );
  const uploaded: string[] = [];
  const notUploaded: string[] = [];
  for (const name of upload) {
    try {
      await s3.put(bucket, `baselines/${name}`, readFileSync(join(baselines, name)));
      uploaded.push(name);
    } catch (error) {
      notUploaded.push(name);
      failed.push(`baselines/${name}: ${(error as Error).message} — retried on the next pull`);
    }
  }
  // A pending name that no longer exists, or cannot be read, has nothing to retry.
  const gone = pending.filter((n) => !local.includes(n) || unreadable.has(n));
  const nextPending = settlePending(pending, notUploaded, [...uploaded, ...gone]);
  if (nextPending.join() !== pending.join()) {
    const tmp = `${pendingPath}.tmp`;
    writeFileSync(tmp, JSON.stringify(nextPending));
    renameSync(tmp, pendingPath);
  }
}
