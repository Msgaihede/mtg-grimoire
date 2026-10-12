// The arguments of `scripts/scanner-corpus.ts`, read before any network call: a flag it does
// not know is refused, so `pull --dry-run` cannot pull for real.

export type Args = { command: "status" | "pull"; drain: boolean };

/** The arguments after `node scripts/scanner-corpus.ts`. Throws an `Error` whose message is the sentence. */
export function parseArgs(argv: string[]): Args {
  const [command, ...flags] = argv;
  if (command !== "status" && command !== "pull") {
    throw new Error("say `status` or `pull` (`pull --drain` empties the inbox)");
  }
  let drain = false;
  for (const flag of flags) {
    if (flag !== "--drain") throw new Error(`unknown argument ${JSON.stringify(flag)}`);
    if (command !== "pull") throw new Error("--drain goes with `pull`: `status` changes nothing");
    drain = true;
  }
  return { command, drain };
}
