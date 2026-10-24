// The pure bits of `scripts/scanner-replay.ts`: its arguments, the name a baseline may have, and
// what the results are stamped with. Nothing here touches a file, so the wrapper stays thin and
// this is tested.

export type Args = {
  baseline: string | null;
  saveBaseline: string | null;
  only: string[];
  corpus: string | null;
  jobs: string | null;
  neuralEvidence: string | null;
  neuralEvidenceMeta: string | null;
  noBuild: boolean;
};

const WITH_VALUE = ["--baseline", "--save-baseline", "--only", "--corpus", "--jobs", "--neural-evidence", "--neural-evidence-meta"] as const;

/** A baseline is a file name in the corpus folder: no separators, no leading dot. */
const BASELINE_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

/** The name, or a sentence on why it cannot name a baseline. Throws an `Error`. */
export function baselineName(flag: string, name: string): string {
  if (!BASELINE_NAME.test(name)) {
    throw new Error(
      `${flag} ${JSON.stringify(name)} is not a baseline name: use letters, digits, _, . and -, and do not start with a dot`,
    );
  }
  return name;
}

/** The arguments after `node scripts/scanner-replay.ts`. Throws an `Error` whose message is the sentence. */
export function parseArgs(argv: string[]): Args {
  const args: Args = {
    baseline: null,
    saveBaseline: null,
    only: [],
    corpus: null,
    jobs: null,
    neuralEvidence: null,
    neuralEvidenceMeta: null,
    noBuild: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--no-build") {
      args.noBuild = true;
      continue;
    }
    if (!(WITH_VALUE as readonly string[]).includes(flag)) throw new Error(`unknown argument ${JSON.stringify(flag)}`);
    const value = argv[++i];
    if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value`);
    switch (flag) {
      case "--baseline":
        args.baseline = baselineName(flag, value);
        break;
      case "--save-baseline":
        args.saveBaseline = baselineName(flag, value);
        break;
      case "--only":
        args.only.push(value);
        break;
      case "--corpus":
        args.corpus = value;
        break;
      case "--jobs":
        if (!/^[1-9]\d*$/.test(value)) {
          throw new Error(`--jobs needs a whole number above zero, not ${JSON.stringify(value)}`);
        }
        args.jobs = value;
        break;
      case "--neural-evidence":
        args.neuralEvidence = value;
        break;
      case "--neural-evidence-meta":
        args.neuralEvidenceMeta = value;
        break;
    }
  }
  return args;
}

/** The commit a results file is stamped with: `+dirty` for a changed scanner crate, `+nobuild` when the binary was not rebuilt, so it may not be this commit's. */
export function commitLabel(sha: string, dirty: boolean, noBuild: boolean): string {
  return sha + (dirty ? "+dirty" : "") + (noBuild ? "+nobuild" : "");
}

/** The closing line after `--save-baseline`; a replaced name is not carried to the bucket again. */
export function baselineNote(name: string, path: string, replaced: boolean): string {
  return replaced
    ? `replaced baseline ${name} at ${path} — a pull does not replace the bucket's copy; use a new name to share a changed one`
    : `baseline ${path} — \`pnpm scanner:corpus pull\` puts it in the corpus bucket`;
}
