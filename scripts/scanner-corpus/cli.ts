// The arguments of `scripts/scanner-corpus.ts`, read before any network call: a flag it does
// not know is refused, so `pull --dry-run` cannot pull for real, and an id that is not a safe
// one is refused by name before anything is listed.

import { ID } from "./plan.ts";

export type Args = {
  command: "status" | "pull" | "remove";
  drain: boolean;
  /** `remove` only: delete for real. Without it `remove` lists what it would delete. */
  yes: boolean;
  /** `remove` only: the ids written as arguments, once each, in the order given. */
  ids: string[];
  /** `remove` only: a file of ids, one a line (`parseIdFile`). */
  fromFile: string | null;
};

const SAY = "say `status`, `pull` (`pull --drain` empties the inbox) or `remove <id>...`";
const notAnId = (id: string) => `not a scan id: ${JSON.stringify(id)} (letters, digits, - and _, not starting with -)`;

/** The arguments after `node scripts/scanner-corpus.ts`. Throws an `Error` whose message is the sentence. */
export function parseArgs(argv: string[]): Args {
  const [command, ...rest] = argv;
  if (command !== "status" && command !== "pull" && command !== "remove") throw new Error(SAY);
  const args: Args = { command, drain: false, yes: false, ids: [], fromFile: null };
  for (let i = 0; i < rest.length; i += 1) {
    const word = rest[i];
    if (word === "--drain") {
      if (command !== "pull") throw new Error("--drain goes with `pull`: `status` and `remove` do not drain");
      args.drain = true;
    } else if (word === "--yes") {
      if (command !== "remove") throw new Error("--yes goes with `remove`: `pull` and `status` ask nothing to confirm");
      args.yes = true;
    } else if (word === "--from-file") {
      if (command !== "remove") throw new Error("--from-file goes with `remove`");
      const path = rest[i + 1];
      if (args.fromFile !== null) throw new Error("--from-file is given once: put every id in one file");
      if (path === undefined || path.startsWith("--")) throw new Error("--from-file needs the path of a file of ids");
      args.fromFile = path;
      i += 1;
    } else if (word.startsWith("-") || command !== "remove") {
      throw new Error(`unknown argument ${JSON.stringify(word)}`);
    } else {
      if (!ID.test(word)) throw new Error(notAnId(word));
      if (!args.ids.includes(word)) args.ids.push(word);
    }
  }
  return args;
}

/** The ids in a file, one a line: blank lines and lines starting with `#` are skipped. */
export function parseIdFile(text: string): string[] {
  const ids: string[] = [];
  text.split(/\r?\n/).forEach((raw, n) => {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) return;
    if (!ID.test(line)) throw new Error(`line ${n + 1} of the id file: ${notAnId(line)}`);
    if (!ids.includes(line)) ids.push(line);
  });
  return ids;
}

/** The ids to remove: the arguments' then the file's, each once. Throws when there are none. */
export function removalIds(args: string[], fromFile: string[]): string[] {
  const ids = [...new Set([...args, ...fromFile])];
  if (!ids.length) throw new Error("name the scans to remove: `remove <id>...` or `remove --from-file <path>`");
  return ids;
}
