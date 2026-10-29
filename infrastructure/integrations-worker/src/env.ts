import type { CorsEnv } from "./cors";
import type { GateEnv } from "./gate";
import type { KekEnv, StoreRpc } from "./store";

/**
 * The integrations Worker's bindings (the spec's §6.4,
 * `docs/superpowers/specs/2026-10-24-integration-data-access-design.md`).
 *
 * **A fourth Worker beside the relay, the share Worker and the scan inbox, and for the share
 * Worker's reason** (its spec's §5.1): a bad deploy here must not be a sync outage. The four
 * share the relay's D1 database and the relay's signing key, and nothing else — no service
 * binding, no binding to the relay's Durable Objects, no bucket.
 *
 * **What it holds**: per group that switched integrations on, a store — the projection of the
 * group's collection, wishlist and decks its devices publish, the policy of which opt-in fields
 * it carries, and a data key the rows are sealed under (`store.ts`, `seal.ts`). **What it never
 * holds**: the group key, a relay token past the request that carried it, or a device's
 * identity. A storage dump of it is the index columns `projection.ts` names and sealed bodies.
 */
export interface Env extends GateEnv, KekEnv, CorsEnv {
  /**
   * One `GroupStore` per group, addressed by `idFromName(group)` (`object.ts`). SQLite-backed —
   * `wrangler.jsonc`'s `new_sqlite_classes` — because a store is a table of rows and its
   * replacement one transaction.
   */
  STORE: DurableObjectNamespace;
}

/**
 * The group segment of a path, and the group a consumer token names — the share Worker's
 * `GROUP_SEGMENT`, spelled from the relay's character class rather than imported from `claim.ts`,
 * for that Worker's reason: an unconstrained segment lets `%41` and `A` name two groups a reader
 * would read as one. Here rather than in the router because a consumer token's group is held to
 * it too (`consumer.ts`), before it is ever handed to `idFromName`.
 */
export const GROUP_SEGMENT = "[A-Za-z0-9_-]{1,128}";

/** {@link GROUP_SEGMENT}, whole. */
export const GROUP_PATTERN = new RegExp(`^${GROUP_SEGMENT}$`);

/**
 * A JSON answer. `infrastructure/relay/src/rotate.ts`'s five lines, copied for the share Worker's
 * reason (`infrastructure/share-worker/src/env.ts`): a shared helper would couple two deploys.
 */
export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** `{ error, code }`, plan §3.2's refusal: a sentence to show, and a word to branch on. */
export function refuse(status: number, error: string, code: string): Response {
  return json({ error, code }, status);
}

/**
 * A binding a deploy was supposed to set, or a throw that names it — the share Worker's
 * `required`. Left to throw rather than answered: an unset secret is a misconfigured Worker, and
 * a 500 that says which is far better than every device in the world quietly getting a 401.
 */
export function required(value: string | undefined, name: string): string {
  if (typeof value !== "string" || value === "") {
    throw new Error(`the integrations Worker is missing its ${name} binding`);
  }
  return value;
}

/**
 * The group's store, as the RPC surface the router calls. `GroupStore` implements
 * {@link StoreRpc} (`object.ts`), which is what the cast stands on; the suite's namespace hands
 * out a `Store` over `node:sqlite` under the same name.
 */
export function storeOf(env: Env, group: string): StoreRpc {
  return env.STORE.get(env.STORE.idFromName(group)) as unknown as StoreRpc;
}
