import type { Env } from "./env";
import { LAPSED, LIVE } from "./shares";

/**
 * The daily pass that darkens a lapsed membership's links — and lights them again if the
 * membership revives. Spec §6, decision 5.
 *
 * **This is the share Worker's own cron and not an edit to the relay's**, which is §5.1's whole
 * point: the relay's source and deploy stay untouched, and a flip written into
 * `relay/src/claim.ts`'s `reconcile` would break exactly that claim. The free plan allows five
 * cron triggers per account and the relay uses one. `wrangler.jsonc` fires this at `30 3` rather
 * than `0 3` so the two passes do not contend on the same D1.
 *
 * **It reads the stored `status` and does not re-run `decide`.** `reconcile` is what moves a
 * subject through `active → grace → dead` against Patreon; duplicating that judgement here would
 * give one account two opinions about when a membership ended, and the one that drifted would be
 * the one nobody drives by hand. This pass reads the answer the relay already wrote.
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
 * The statuses that serve, as an **allowlist**.
 *
 * `entitlement.ts`'s `Status` is the same three strings and is deliberately not imported:
 * `tsconfig.share-worker.json` names the two relay modules this Worker depends on and
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
const SERVING: readonly string[] = ["active", "grace"];

/** One share's row, narrowed to the one column this pass needs from it. */
interface GroupRow {
  group_id: string;
}

/** One entitlement, narrowed to the verdict and the group it is a verdict about. */
interface StatusRow {
  group_id: string;
  status: string;
}

/**
 * Sweep every group that has published a share, and move its shares to whichever state its
 * membership now says.
 *
 * **The candidate groups come from `shares` and not from `entitlements`**, which is the one place
 * this departs from the plan's sketch. The set of groups that could possibly be *written* is the
 * set that has a row here, and it is bounded by the twenty-shares cap; driving from the other side
 * would issue a statement for every subscriber on the account — including every one who has never
 * shared anything — and would still miss the case below.
 *
 * ⚠️ **The candidate query is deliberately unfiltered — no `WHERE state <> 'revoked'`.** Narrowing
 * it to the rows that can move would be free and correct, and it would make the `AND state = ?`
 * guard in the re-lighting statement unreachable for a group whose only share is a tombstone,
 * which is precisely the case that guard exists for. The refusal belongs in the statement that
 * writes, not in the query that chooses what to write to, so that deleting the guard is a red
 * test rather than a link somebody withdrew coming back to life.
 *
 * **A group with no entitlement row at all is not serving, and its shares go dark.** That is a
 * real state rather than a hypothetical: `/claim` *moves* a binding rather than refusing one, so
 * a subject who reconnects on another group leaves this one entitled by nothing. Publishing is
 * gated on a membership, so a group nothing entitles is a group nobody is paying for — and the
 * asymmetry that makes fail-closed cheap here is that `lapsed` is the reversible state. A group
 * that should not have gone dark lights again on the next pass; a group that should have gone
 * dark and did not, never does.
 *
 * `now` is a parameter with the clock as its default, for `index.ts`'s reason about one clock
 * read per request: every row this pass moves carries the same `updated_at`, and a test can say
 * what that stamp is without stubbing time.
 */
export async function sweepLapsed(env: Env, now = Date.now()): Promise<void> {
  const published = await env.DB.prepare(`SELECT group_id FROM shares`).all<GroupRow>();
  const groups = new Set(published.results.map((row) => row.group_id));
  // **No statements means no `batch`**, which is a refusal on D1 rather than a wasted round trip.
  // A relay with no shares on it is also every relay until the first one is published.
  if (groups.size === 0) return;

  // `group_id IS NOT NULL` narrows the read rather than guarding the decision — an unbound
  // entitlement is a subject who has connected Patreon and claimed no group, and it has nothing
  // to say about any group. It is written here so the statement means what it says; the map
  // below would ignore such a row either way, so do not write a test claiming it is load-bearing.
  const entitled = await env.DB.prepare(
    `SELECT group_id, status FROM entitlements WHERE group_id IS NOT NULL`,
  ).all<StatusRow>();
  const serving = new Set(
    entitled.results.filter((row) => SERVING.includes(row.status)).map((row) => row.group_id),
  );

  // One prepared statement for both directions: D1's `bind` answers a new statement rather than
  // mutating this one, so the four values are what say which way a group is going.
  //
  // ⚠️ **`AND state = ?` is the load-bearing clause of the whole file.** `revoked` is the reader's
  // own press and is terminal; `lapsed` is this pass's and is reversible, and that asymmetry is
  // the reason `state` is a state rather than a `revoked_at` stamp. Without this clause the
  // re-lighting statement would republish every binder a reader had ever withdrawn, to an
  // audience that already has the link.
  //
  // It is also what keeps `updated_at` honest in the other direction: a statement that matched
  // rows it had nothing to say about would restamp every share on the account nightly, and the
  // shell page renders that stamp.
  //
  // The states are **bound and never written as SQL literals**, as `shares.ts` binds `REVOKED`:
  // one shape for both directions, and one spelling of each string in the codebase.
  const move = env.DB.prepare(
    `UPDATE shares SET state = ?, updated_at = ? WHERE group_id = ? AND state = ?`,
  );
  await env.DB.batch(
    [...groups].map((group) =>
      serving.has(group)
        ? move.bind(LIVE, now, group, LAPSED)
        : move.bind(LAPSED, now, group, LIVE),
    ),
  );
}
