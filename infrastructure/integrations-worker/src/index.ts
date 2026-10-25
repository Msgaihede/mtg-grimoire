/**
 * **`mtg-grimoire-integrations`** — the integrations store (plan
 * `docs/superpowers/plans/2026-10-25-integrations-projection-store.md`, §3.2; the spec's §6).
 *
 * The Worker's two exports, and nothing else: the router (`worker.ts`), and the Durable Object
 * class `wrangler.jsonc` binds as `STORE` (`object.ts`). They are apart so the suite can import
 * the router without the runtime's `cloudflare:workers`, which only `object.ts` names.
 */
export { default } from "./worker";
export { GroupStore } from "./object";
