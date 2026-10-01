#!/usr/bin/env node
/**
 * Builds the design sync's reference storybook, drawing the same card art the bundle's previews
 * draw.
 *
 *   node .design-sync/build-reference.mjs
 *
 * The storybook half of `buildCmd`: `card-art.mjs` first (download only — nothing is copied
 * anywhere), then `storybook build` into `.design-sync/sb-reference/` with `STORYBOOK_ART=bundled`.
 *
 * **Why the variable, and why it cannot be left off.** The sync grades every component by
 * comparing a preview — the bundle, mounted inside `GrimoirePreviewProvider` — against this
 * storybook's render of the same story. Once the bundle ships its art folder, the provider draws
 * every card from real JPGs, and a reference built the default way would draw the same cards as
 * synthetic placeholders: every card-bearing component would compare as a mismatch, for a reason
 * that has nothing to do with the component. With the variable set, `.storybook/main.ts` mounts
 * `.design-sync/card-art/` at `/card-art` and `.storybook/preview.tsx` opens the Art toolbar on
 * `bundled`, so both sides load the very same files. **A plain `npm run build-storybook` is
 * unaffected** — it still opens on synthetic art and serves no art folder at all.
 *
 * The download runs first because `main.ts` mounts the folder only if it exists: a reference
 * built without it would still say `bundled` and draw the app's own no-image frame on every card.
 * A failed download therefore stops the build rather than letting it produce that.
 *
 * `shell: true` for `npx`, which is a `.cmd` shim on Windows and cannot be spawned directly. Exits
 * with the first non-zero status it sees, so `buildCmd` fails where the failure happened.
 */
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function run(label, command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: ROOT, stdio: "inherit", ...options });
  if (result.error) {
    console.error(`\nbuild-reference: ${label} did not start: ${result.error.message}`);
    return 1;
  }
  // `null` is a child ended by a signal, which is a failure with no code of its own.
  const status = result.status ?? 1;
  if (status !== 0) console.error(`\nbuild-reference: ${label} exited ${status}`);
  return status;
}

let status = run("card-art.mjs", process.execPath, [join(ROOT, ".design-sync/card-art.mjs")]);
if (status === 0) {
  status = run(
    "storybook build",
    "npx storybook build -c .storybook -o .design-sync/sb-reference",
    [],
    {
      shell: true,
      env: { ...process.env, STORYBOOK_ART: "bundled" },
    },
  );
}
process.exitCode = status;
