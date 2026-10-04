/**
 * **Cloudflare's `_headers` file, read the way Workers static assets reads it** — so the policy
 * the production host enforces is one a preview, a smoke run and a test can enforce too.
 *
 * `app-worker/_headers` is the source: the web build copies it into `dist-web/`, where
 * `wrangler deploy` parses it and applies its rules to every static-asset response. Nothing in
 * this repository is that parser, so without this module the Content-Security-Policy would first
 * meet the app on the day it was deployed. `vite.mobile.config.ts` applies `headersFor` in
 * `npm run web:preview`, and `hosting.test.ts` asks it what each address is sent.
 *
 * **It models the part of the format the file uses, and refuses the rest by name.** Verified
 * against `developers.cloudflare.com/workers/static-assets/headers/` on 2026-10-04:
 *
 * - a rule is a path line and the header lines under it; `#` starts a comment;
 * - a path may hold **one** splat, `*`, which matches any run of characters;
 * - every rule that matches applies, in the file's order;
 * - a header set by two matching rules has its values **joined with a comma** — so a narrower
 *   rule that means to *replace* a wider one's value detaches it first, with `! Name`;
 * - at most 100 rules, and 2,000 characters to a line.
 *
 * What it does not model — an absolute `https://host/path` pattern, a `:placeholder` — is a
 * thrown error rather than a rule quietly ignored: a rule the preview skipped and the host
 * applied is exactly the disagreement this module exists to remove.
 *
 * **Plain TypeScript with nothing but erasable types**, on purpose: Node strips those natively,
 * so a `.mjs` under `scripts/` can import this file as it stands.
 */

/** Cloudflare's limits, from the page above. A deploy that passes either is refused there. */
export const MAX_RULES = 100;
export const MAX_LINE_LENGTH = 2000;

export interface HeaderRule {
  /** The path the rule matches — a literal, or a literal holding one `*`. */
  path: string;
  /** Header names this rule detaches, lower-cased. */
  unset: string[];
  /** Header names, lower-cased, and the values this rule attaches. */
  set: [name: string, value: string][];
}

/** The rules of a `_headers` file, in the file's order. Throws on what the file may not say. */
export function parseHeaders(text: string): HeaderRule[] {
  const rules: HeaderRule[] = [];
  let rule: HeaderRule | undefined;
  text.split(/\r?\n/).forEach((raw, index) => {
    const refuse = (why: string): never => {
      throw new Error(`_headers line ${index + 1}: ${why}`);
    };
    if (raw.length > MAX_LINE_LENGTH) {
      refuse(`${raw.length} characters, and Cloudflare allows ${MAX_LINE_LENGTH}`);
    }
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) return;

    if (line.startsWith("/")) {
      if (line.split("*").length > 2) refuse("a path may hold one splat");
      if (/:[A-Za-z]/.test(line)) refuse("placeholders are not modelled here");
      rule = { path: line, unset: [], set: [] };
      rules.push(rule);
      if (rules.length > MAX_RULES) refuse(`more than ${MAX_RULES} rules`);
      return;
    }
    if (/^[^\s:]+:\/\//.test(line)) refuse("absolute URL patterns are not modelled here");
    if (rule === undefined) return refuse("a header before any path");

    if (line.startsWith("! ")) {
      rule.unset.push(line.slice(2).trim().toLowerCase());
      return;
    }
    const colon = line.indexOf(":");
    if (colon < 1) return refuse("expected `Name: value`");
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (/\s/.test(name) || value === "") return refuse("expected `Name: value`");
    rule.set.push([name, value]);
  });
  return rules;
}

/** Whether a rule's path matches a request's. The splat is greedy and crosses `/`. */
function matches(pattern: string, path: string): boolean {
  const literal = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${pattern.split("*").map(literal).join(".*")}$`).test(path);
}

/**
 * The headers a request for `path` is answered with, by lower-cased name.
 *
 * Every matching rule in order: its detaches first, then its values — appended with a comma to
 * whatever an earlier rule left, which is Cloudflare's rule and the reason `! Cache-Control`
 * stands in front of every narrower `Cache-Control` in the file.
 */
export function headersFor(rules: readonly HeaderRule[], path: string): Record<string, string> {
  const out = new Map<string, string>();
  for (const rule of rules) {
    if (!matches(rule.path, path)) continue;
    for (const name of rule.unset) out.delete(name);
    for (const [name, value] of rule.set) {
      const earlier = out.get(name);
      out.set(name, earlier === undefined ? value : `${earlier}, ${value}`);
    }
  }
  return Object.fromEntries(out);
}
