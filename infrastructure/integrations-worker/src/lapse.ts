import { storeOf, type Env } from "./env";

/**
 * The daily pass that **empties the store of a group whose membership has lapsed** (the spec's
 * §6.3: "a lapsed membership past the grace window does the same", the same as switching
 * integrations off). `wrangler.jsonc`'s cron fires it.
 *
 * **It reads the relay's verdict and does not re-decide it**, as the share Worker's lapse does
 * (`infrastructure/share-worker/src/lapse.ts`, whose argument this copies): `entitlements.status`
 * is what the relay's `reconcile` wrote, and a second judgement here would give one account two
 * opinions about when a membership ended.
 *
 * **Unlike a share, a deleted store is not relit.** A share's `lapsed` is reversible because the
 * snapshot stays in R2; a store is a projection the devices can publish again, and a group whose
 * membership revives switches integrations on again from Settings — which is the same press
 * that made the store the first time. Keeping a lapsed group's collection on the server against
 * the day it might come back is the thing this pass exists not to do.
 */

/**
 * The statuses that serve, as an **allowlist** — `active`, and `grace` inside its window. The
 * share Worker's `ACTIVE`/`GRACE` and its argument: a status this code has never seen is the
 * absence of a yes, and here the cost of a wrong "no" is a store the devices republish, while
 * the cost of a wrong "yes" is a lapsed group's collection kept indefinitely.
 */
const ACTIVE = "active";
const GRACE = "grace";

/**
 * The groups whose membership serves — the share Worker's `SERVING_GROUPS`, to the letter.
 *
 * ⚠️ **`group_id IS NOT NULL` is load-bearing.** An entitlement nobody has bound to a group yet
 * has a NULL `group_id`, and one NULL in a `NOT IN` list makes the condition NULL — never true —
 * for every row: one subscriber who had not claimed a group would freeze every lapse on the
 * account, silently. A stored `grace` serves only while `grace_until` has not passed (a NULL
 * deadline compares as not true, a closed window), which is the relay's own `settle`.
 */
const SERVING_GROUPS =
  `SELECT group_id FROM entitlements ` +
  `WHERE group_id IS NOT NULL AND (status = ? OR (status = ? AND grace_until >= ?))`;

/**
 * **At most twenty-five stores a pass.** A pass costs two D1 queries whatever this is — one
 * `SELECT`, one `DELETE … IN (…)` — plus one for each store made again while the pass ran (rare:
 * see {@link sweepLapsed}), against the free plan's fifty per invocation
 * (`infrastructure/relay/src/claim.ts`'s `RECONCILE_BUDGET` is sized for the same cap); and two
 * Durable Object requests per store, the emptying and the asking again, against the thousand an
 * invocation may make of Cloudflare's own services. Twenty-five keeps the `IN` list well under D1's hundred bound parameters and the
 * pass's wall time near a second. The pass is daily and groups with integrations on are a
 * subset of paying groups, so a backlog — a day on which more than twenty-five lapsed — drains
 * at twenty-five a day, oldest store first.
 */
export const LAPSE_BUDGET = 25;

/**
 * Empty every store, up to {@link LAPSE_BUDGET}, whose group no serving membership names — and
 * forget it in `integration_groups`, in one statement, for the stores that emptied. A store whose
 * `deleteAll` failed keeps its row and is asked again on the next pass.
 *
 * **Then each emptied object is asked again**, and one that holds a store gets its row back: a
 * device switched integrations on between the `deleteAll` and the row's delete (the review of
 * 2026-10-25), and a store with no row is one no later pass could find. An object that cannot be
 * asked keeps its row too, for the same reason a failed one does.
 *
 * **`NOT IN` the serving groups, not `IN` the lapsed ones**, as the share Worker's darkening
 * statement: a group no entitlement names at all — a subscriber who moved their binding to
 * another group — is not serving, and its store goes.
 *
 * Answers the groups it emptied, for the suite.
 */
export async function sweepLapsed(env: Env, nowMs = Date.now()): Promise<string[]> {
  const { results } = await env.DB.prepare(
    `SELECT group_id FROM integration_groups WHERE group_id NOT IN (${SERVING_GROUPS}) ` +
      `ORDER BY created_at LIMIT ?`,
  )
    .bind(ACTIVE, GRACE, nowMs, LAPSE_BUDGET)
    .all<{ group_id: string }>();

  const emptied: string[] = [];
  for (const { group_id: group } of results) {
    try {
      await storeOf(env, group).deleteAll();
      emptied.push(group);
    } catch {
      // Asked again tomorrow: the row stays until the object has been emptied.
    }
  }
  if (emptied.length > 0) {
    await env.DB.prepare(
      `DELETE FROM integration_groups WHERE group_id IN (${emptied.map(() => "?").join(", ")})`,
    )
      .bind(...emptied)
      .run();
  }
  for (const group of emptied) {
    const remade = await storeOf(env, group)
      .exists()
      .catch(() => true);
    if (remade) await remember(env.DB, group, nowMs);
  }
  return emptied;
}

/**
 * Write a group's `integration_groups` row if it has none — the one statement that makes a row,
 * for `PUT …/settings` (before and after the object) and for the two places that delete a row and
 * then find a store made again (`DELETE /g/{group}`, the lapse pass). `created_at` is the first
 * write's: a row already there keeps its own.
 */
export async function remember(db: D1Database, group: string, nowMs: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO integration_groups (group_id, created_at) VALUES (?, ?)
         ON CONFLICT (group_id) DO NOTHING`,
    )
    .bind(group, nowMs)
    .run();
}
