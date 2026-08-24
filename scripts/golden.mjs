/**
 * Regenerates the golden files from the TypeScript writer, which is the behaviour of record.
 *
 * Run with `npm run golden`. Both suites then assert byte equality against what this wrote:
 * `src/features/transfer/golden.test.ts` for this writer, and (from Task 2 on) the Rust one's
 * own suite for `src-tauri/src/transfer/`. A change to either writer is a red suite, which is
 * the whole point — so **nothing here may massage the output**. If a golden file looks wrong,
 * the writer is what to argue with.
 *
 * **How the `.ts` imports run, decided by running it (2026-08-25, Node v24.16.0).** Node strips
 * types on its own now, so `--experimental-strip-types` is not passed and is not needed — but
 * plain `node scripts/golden.mjs` still fails with `ERR_MODULE_NOT_FOUND` on
 * `src/features/transfer/export/format.ts`'s `import { csvRow } from "../csv"`: the app is
 * written for a bundler and leaves the extension off, and Node's ESM resolver requires one.
 * `vite-node` is not installed, and driving Vite's own `ssrLoadModule` pulls the whole app
 * through `vite:dep-scan` for two pure modules. So the resolver gets one hook — retry an
 * extensionless *relative* specifier with `.ts` on it — and nothing else changes. It is
 * registered before the modules load, which is why they arrive by `await import()` rather than
 * by a static import: a static one is hoisted above this file's body and would be resolved
 * before the hook exists.
 */
import { readFileSync, writeFileSync, readdirSync, unlinkSync } from "node:fs";
import { registerHooks } from "node:module";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      // Only a relative specifier, and only after the plain resolution failed: a bare package
      // name that is genuinely missing must still fail as itself rather than as `foo.ts`.
      if (err?.code === "ERR_MODULE_NOT_FOUND" && /^\.\.?\//.test(specifier)) {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw err;
    }
  },
});

const { formatExport } = await import("../src/features/transfer/export/format.ts");
const { availableFields, defaultFields } = await import("../src/features/transfer/fields.ts");
const { EXPORT_FORMATS } = await import("../src/features/transfer/formats.ts");

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "src/features/transfer/__golden__");
const corpus = JSON.parse(readFileSync(join(DIR, "corpus.json"), "utf8"));

for (const name of readdirSync(DIR)) if (name.endsWith(".txt")) unlinkSync(join(DIR, name));

let written = 0;
for (const [scenario, { surface, cards }] of Object.entries(corpus.scenarios)) {
  for (const format of EXPORT_FORMATS) {
    for (const [setName, fields] of [
      ["all", availableFields(format, surface)],
      ["default", defaultFields(format, surface)],
    ]) {
      // LF and a trailing newline are `formatExport`'s own doing — an empty list is `""` there,
      // so `empty.*.txt` is a zero-byte file rather than a lone newline, and writing the string
      // verbatim is what keeps that true.
      writeFileSync(
        join(DIR, `${scenario}.${format}.${setName}.txt`),
        formatExport(cards, format, fields),
        "utf8",
      );
      written += 1;
    }
  }
}
console.log(`wrote ${written} golden files`);
