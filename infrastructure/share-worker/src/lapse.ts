import type { Env } from "./env";
import { LAPSED, LIVE } from "./shares";

/**
 * The daily pass that darkens a lapsed membership's links — and lights them again if the
 * membership revives. Spec §6, decision 5.
 *
 * **This is the share Worker's own cron and not an edit to the relay's**, which is §5.1's whole
 * point: the relay's source and deploy stay untouched, and a flip written into
 * `infrastructure/relay/src/claim.ts`'s `reconcile` would break exactly that claim. The free plan allows five
 * cron triggers per account and the relay uses one. `wrangler.jsonc` fires this at `30 3` so the
 * two passes do not contend on the same D1: the relay's fires at minute `0` — daily at `0 3` until
 * 2026-09-28, hourly since — and never at `30`.
 *
 * **It reads the stored `status` and does not re-run `decide`.** `reconcile` is what moves a
 * subject through `active → grace → dead` against Patreon; duplicating that judgement here would
 * give one account two opinions about when a membership ended, and the one that drifted would be
 * the one nobody drives by hand. This pass reads the answer the relay already wrote — and reads
 * a `grace` the way the relay's own `settle` does, by its `grace_until` (see `SERVING_GROUPS`).
 *
 * **What this buys is the shape of the public read.** Because a membership's verdict is written
 * into `shares.state` once a day, `GET /s/{id}` reads one row and branches on a column — no join
 * to `entitlements`, no second query — so every stranger who clicks a Discord link costs a
 * single-table read on the D1 budget the account's paying readers share.
 *
 * **A lapsed share keeps its R2 object.** Reclaiming that storage is a sweep for later (spec
 * §13), and inventing a retention rule here would delete a binder that a revived membership is
 * about to want back.
 */

/**
 * The statuses that serve, as an **allowlist** — `active`, and `grace` inside its window.
 *
 * `entitlement.ts`'s `Status` is the same three strings and is deliberately not imported:
 * `infrastructure/share-worker/tsconfig.json` names the two relay modules this Worker depends on and
 * `entitlement.ts` is not one of them, for `index.ts`'s `GROUP_SEGMENT` reason — importing a
 * constant would pull the relay's Patreon layer into a bundle that must be able to deploy while
 * the relay's is broken.
 *
 * ⚠️ **An allowlist and not "anything but `dead`".** `status` is a TEXT column and a string this
 * code has never seen is the *absence* of a yes, not a yes: `decide`'s default branch argues it —
 * serving on an unknown status is invisible, darkening on one is visible within a day, and the
 * damage a wrong darkening does is a day of dark links rather than a free subscription that lasts
 * until somebody notices.
 *
 * **`grace` is in the list, and that is not a leniency.** A declined card is a failed payment
 * Patreon retries, not a cancellation the reader chose, so a reader inside the window syncs — and
 * shares — exactly as they did the day before.
 */
const ACTIVE = "active";
const GRACE = "grace";

/**
 * The groups whose membership serves, as a subquery both statements below share — bound by
 * `servingBindings`, in that order.
 *
 * ⚠️ **A stored `grace` serves only while `grace_until` has not passed.** That is the relay's
 * `settle`, spelled in SQL: `/token` refuses a reader whose window has closed, and nothing writes
 * `dead` into the row until the relay's cron next reaches it — which, for a row Patreon refuses
 * every time, was never until issue #1117. Read as a bare status, such a member's links stayed
 * live for ever after their sync had stopped. A NULL or non-positive deadline is a closed window
 * there and fails `grace_until >= ?` here, NULL comparing as not true; `>=` because the deadline
 * instant is the last one inside the window, `decide`'s and `settle`'s `>` read from this side.
 *
 * ⚠️ **`group_id IS NOT NULL` is load-bearing, and it was not until the pass went set-based.** An
 * unbound entitlement is a subject who has connected Patreon and claimed no group; its `group_id`
 * is NULL, and a NULL in a `NOT IN` list makes the darkening statement's condition NULL — never
 * true — for **every** row. One active subject who had not claimed a group yet would freeze every
 * lapse on the account, silently: the statement would succeed and move nothing.
 * `lapse.test.ts` holds that case, and the fake answers `NOT IN` with SQLite's NULL rule.
 */
const SERVING_GROUPS =
  `SELECT group_id FROM entitlements ` +
  `WHERE group_id IS NOT NULL AND (status = ? OR (status = ? AND grace_until >= ?))`;

/** `SERVING_GROUPS`'s parameters, with the instant the windows are judged at. */
function servingBindings(nowMs: number): [string, string, number] {
  return [ACTIVE, GRACE, nowMs];
}

/**
 * Move every share to whichever state its group's membership now says, in **two statements
 * however many groups there are** — one per direction.
 *
 * ⚠️ **Until 2026-10-20 this sent one statement per group that had ever published a share**, and
 * because a revoked row is a tombstone that stays (`schema.sql`'s partial index), that set only
 * grew. The free plan caps an invocation at fifty D1 queries — the cap
 * `infrastructure/relay/src/claim.ts`'s `RECONCILE_BUDGET` is sized for — and if each statement in
 * a batch counts toward it, which the review that found this could not rule out, then past about
 * fifty groups every pass would have thrown and no share would ever have lapsed or lit again
 * (issue #1194). The judgement now lives in SQL, where its cost does not depend on the account's
 * size: the rows read grow with the tables, the query count does not.
 *
 * **The darkening statement is `NOT IN` the serving groups, not `IN` the dead ones**, so a group
 * with no entitlement row at all is not serving and its shares go dark. That is a real state
 * rather than a hypothetical: `/claim` *moves* a binding rather than refusing one, so a subject
 * who reconnects on another group leaves this one entitled by nothing. Publishing is gated on a
 * membership, so a group nothing entitles is a group nobody is paying for — and the asymmetry
 * that makes fail-closed cheap here is that `lapsed` is the reversible state. A group that should
 * not have gone dark lights again on the next pass; a group that should have gone dark and did
 * not, never does.
 *
 * ⚠️ **It never writes `updated_at`, in either direction.** That stamp is what the shell's
 * OpenGraph card dates the snapshot by — *"updated today"* — and nothing about the snapshot changes
 * when a membership lapses or revives. Until 2026-10-01 both statements restamped it, so a share
 * relit after a month of lapse told every Discord preview that a month-old binder was fresh. The
 * row's state is what moved; the column that says when the *owner* last published stays theirs.
 */
export async function sweepLapsed(env: Env, nowMs = Date.now()): Promise<void> {
  // ⚠️ **`AND state = ?` is the load-bearing clause of the whole file.** `revoked` is the reader's
  // own press and is terminal; `lapsed` is this pass's and is reversible, and that asymmetry is
  // the reason `state` is a state rather than a `revoked_at` stamp. Without this clause the
  // re-lighting statement would republish every binder a reader had ever withdrawn, to an
  // audience that already has the link.
  //
  // The states are **bound and never written as SQL literals**, as `shares.ts` binds `REVOKED`:
  // one spelling of each string in the codebase.
  //
  // **One `batch`, so one transaction**: a pass that failed between the two statements would
  // leave nothing half-moved — and the two touch disjoint groups, so their order is not a choice.
  // A relay with no shares on it is two statements that match nothing, not an empty `batch`.
  //
  // **One clock for both**, so a window closing between them cannot leave a group in neither set.
  const serving = servingBindings(nowMs);
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE shares SET state = ? WHERE state = ? AND group_id IN (${SERVING_GROUPS})`,
    ).bind(LIVE, LAPSED, ...serving),
    env.DB.prepare(
      `UPDATE shares SET state = ? WHERE state = ? AND group_id NOT IN (${SERVING_GROUPS})`,
    ).bind(LAPSED, LIVE, ...serving),
  ]);
}
