import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * **The catalogue never asks for `new Function`.** The page's policy is `script-src 'self'` with
 * no `'unsafe-eval'`, and zod 4 probes for eval on its first parse (`util.allowsEval`, a
 * `new Function("")` inside a `try`) to decide whether to compile fast parsers. The throw is
 * caught; the browser reports the violation anyway, and `pnpm web:scanner-smoke` fails the page on
 * any report (`kEvalViolation`). `zodConfig.ts` sets `jitless`, which skips the probe and the
 * compiler both — this is what holds it.
 */
describe("the catalogue under the page's script-src", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("validates every example without constructing a Function", async () => {
    const constructed: unknown[][] = [];
    vi.stubGlobal(
      "Function",
      new Proxy(Function, {
        construct(target, args: unknown[]) {
          constructed.push(args);
          return Reflect.construct(target, args) as object;
        },
      }),
    );
    const { catalog } = await import("./catalog");
    const { EXAMPLES } = await import("./examples");
    for (const spec of Object.values(EXAMPLES)) {
      expect(catalog.validate(spec).success).toBe(true);
    }
    expect(constructed).toEqual([]);
  });
});
