import type { Env } from "./index";

/**
 * The pairing rendezvous: four slots, ten minutes, and no authentication.
 *
 * **Two slots until the Discord integration's second PR, and two more since** (spec §4,
 * *Pairing*): `offer` and `join` carry the X25519 handshake's two blobs, and `offersig` and
 * `joinsig` carry each side's Ed25519 signing key and protocol level, sealed under the same
 * `pair_key`. Same ten minutes, same first-writer-wins, same blob cap; a build that knows only the
 * first two never asks for the others, and its pairing is the one it always was. ⚠️ **The new two
 * live in a table of their own, `pairing_slots`** — the first table's `slot` is `CHECK`ed to
 * `offer` and `join`, which SQLite cannot widen in place (`migrations/0001_…`). [`TABLE`] picks.
 *
 * **It stands ahead of the bearer gate for `/rotate` and `/keys`'s reason, not by exemption.** The
 * joining device is not in the group yet and cannot derive a group auth, so a rendezvous behind the
 * gate would refuse exactly the caller it exists to serve. Both handlers are D1 only and **neither
 * reaches the Durable Object**, which is what makes standing outside affordable: the gate is in
 * front of the DO because a request that reaches one bills whether it is honoured or refused.
 *
 * **`rv` is a one-way derivation of the pairing token and never the token itself** — the token is
 * HKDF *salt* in `crypto::pair_key`, so an address the relay could invert would be the relay
 * holding half of the key derivation. This file only ever sees 32 hex characters.
 *
 * ⚠️ **The race guard is not the `INSERT ... SELECT ... WHERE NOT EXISTS` this file's own plan
 * sketched.** `fakeD1.ts`'s SQL evaluator tokenises `?` as a single placeholder and has no notion
 * of `EXISTS` at all — only the `coalesce((SELECT max(col) FROM table WHERE …))` shape the
 * monotonic-epoch guard in `groupauth.ts` uses — so teaching it a boolean subquery was
 * disproportionate to what this table needs. Instead: a `DELETE` that clears a row already past
 * its `expires_at`, then `INSERT OR IGNORE` against the `(rv, slot)` primary key. **The race safety
 * survives the substitution**: SQLite enforces that primary key at the storage layer, so of two
 * concurrent inserts into one empty slot only one can ever land — the other's `OR IGNORE` reports
 * zero rows changed rather than a read-then-write both sides could pass. The leading `DELETE` is
 * not part of that guarantee; it only ever removes a row already in the past, which nothing can
 * un-expire out from under it, so it cannot itself race anyone.
 */

/** Ten minutes. The app's `Pending` expires on the same clock. */
export const RENDEZVOUS_TTL_MS = 600_000;

/**
 * The largest blob measured is the 224-character sealed key, so this is 9× headroom.
 * It is a cap on an **unauthenticated** write, which is the only reason it exists.
 *
 * **One cap for all four slots, and the signing slots fit it with room to spare**: a 32-byte
 * public key and a protocol number sealed under `pair_key` is under a hundred characters. There
 * is no cap per `rv` beyond the four slots themselves, so four rows is what one pairing can hold.
 */
export const MAX_BLOB_CHARS = 2048;

/**
 * Which table holds which slot — and so the set of slots there are. **Interpolated into the SQL
 * below, and safe to be**: the value is one of these two literals, chosen by a key the caller's
 * slot must already be, never the caller's text.
 */
const TABLE: Readonly<Record<string, string>> = {
  offer: "pairing_rendezvous",
  join: "pairing_rendezvous",
  offersig: "pairing_slots",
  joinsig: "pairing_slots",
};

/**
 * The table for `slot`, or `undefined` for a slot there is not — `Object.hasOwn`, so a slot named
 * `constructor` is not found on the prototype.
 */
function tableFor(slot: string): string | undefined {
  return Object.hasOwn(TABLE, slot) ? TABLE[slot] : undefined;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * **First write wins, and the 409 is the feature.** Without it anyone who photographed the QR could
 * overwrite the joiner's answer after the fact; with it they can only get there first, which the
 * reader sees immediately because the six digits on the two screens then disagree.
 */
export async function handleRendezvousPut(
  request: Request,
  env: Env,
  rv: string,
  slot: string,
  now: number,
): Promise<Response> {
  const table = tableFor(slot);
  if (table === undefined) return json({ error: "no such slot" }, 400);

  let blob: unknown;
  try {
    blob = ((await request.json()) as { blob?: unknown }).blob;
  } catch {
    return json({ error: "that is not a rendezvous body" }, 400);
  }
  if (typeof blob !== "string" || blob.length === 0) {
    return json({ error: "that is not a rendezvous body" }, 400);
  }
  if (blob.length > MAX_BLOB_CHARS) return json({ error: "that blob is too large" }, 413);

  // Clears a slot that has timed out, so a fresh write can land there again. This can never race
  // anyone: it only removes a row whose `expires_at` is already behind `now`, and nothing moves
  // `now` backwards.
  await env.DB.prepare(`DELETE FROM ${table} WHERE rv = ? AND slot = ? AND expires_at <= ?`)
    .bind(rv, slot, now)
    .run();

  // The whole of the race guard: SQLite refuses a second row under one primary key regardless of
  // which of two concurrent requests asked first, and `OR IGNORE` turns that refusal into
  // `changes: 0` instead of a thrown constraint error.
  const written = await env.DB.prepare(
    `INSERT OR IGNORE INTO ${table} (rv, slot, blob, expires_at) VALUES (?, ?, ?, ?)`,
  )
    .bind(rv, slot, blob, now + RENDEZVOUS_TTL_MS)
    .run();

  // A row that already stood unexpired is what `OR IGNORE` refused, which is the 409.
  if ((written.meta?.changes ?? 0) === 0) {
    return json({ error: "that slot has already been answered" }, 409);
  }
  return new Response(null, { status: 204 });
}

/** The other half. An expired row is not there, which is the same answer as never having been. */
export async function handleRendezvousGet(
  env: Env,
  rv: string,
  slot: string,
  now: number,
): Promise<Response> {
  const table = tableFor(slot);
  if (table === undefined) return json({ error: "no such slot" }, 400);

  const row = await env.DB.prepare(
    `SELECT blob FROM ${table} WHERE rv = ? AND slot = ? AND expires_at > ?`,
  )
    .bind(rv, slot, now)
    .first<{ blob: string }>();

  if (row === null) return json({ error: "nothing there" }, 404);
  return json({ blob: row.blob });
}

/** Swept by the hourly cron, after `reconcile` — so a `reconcile` that throws skips it. Both tables. */
export async function sweepRendezvous(env: Env, now: number): Promise<void> {
  await env.DB.prepare(`DELETE FROM pairing_rendezvous WHERE expires_at <= ?`).bind(now).run();
  await env.DB.prepare(`DELETE FROM pairing_slots WHERE expires_at <= ?`).bind(now).run();
}
