/**
 * **zod without eval** — imported first by `catalog.ts`, before json-render or a schema exists.
 *
 * zod 4 compiles fast object parsers with `new Function`, and before its first parse it probes
 * whether it may (`util.allowsEval`: a `new Function("")` in a `try`). The page's policy is
 * `script-src 'self'` with no `'unsafe-eval'`, so the probe is refused — and although zod catches
 * the throw, the browser still reports a `securitypolicyviolation`, which the web app's smoke run
 * fails on. `jitless` skips the probe and the compiler both; the parsers zod interprets instead are
 * the same parsers, and a widget's spec is a few kilobytes. `csp.test.ts` holds it.
 */
import { z } from "zod";

z.config({ jitless: true });
