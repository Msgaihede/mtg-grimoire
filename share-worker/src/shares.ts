import { MAX_SHARES_PER_GROUP, json, shareUrl, type Env } from "./env";

/**
 * The three gated writes: publish a share, list what a group has published, and withdraw one.
 *
 * **A share belongs to the group and not to the device that published it** (spec §9), consistent
 * with *an entitlement is a property of the GROUP*: every paired device lists, refreshes and
 * revokes, and every statement in this file is scoped by `group_id` rather than by any device
 * identity — there is none in a token beyond the group.
 *
 * **The order of the checks is `handleRotate`'s: every check that costs nothing, then the ones
 * that cost a D1 read.** The body's shape is decided in the Worker's own memory; the folder's
 * existing row and the group's count are round trips. A caller who gets the body wrong pays for
 * neither.
 */

/** The three optional fields spec §3 lets cross. Anything else is not a field this format has. */
const KNOWN_FIELDS: readonly string[] = ["condition", "lang", "value"];

/**
 * The ceiling on a text field a reader typed.
 *
 * **This and the blob cap are the only places a caller chooses how much this Worker stores.** A
 * title is a folder name and an owner name is what somebody typed into a dialog, so 200 is far
 * past any of them: a ceiling that says "something is wrong" rather than a budget, exactly as
 * `rotate.ts`'s `MAX_BLOB_CHARS` is.
 */
const MAX_TEXT_CHARS = 200;

/**
 * The machine-readable half of the cap refusal.
 *
 * **A code rather than the sentence, for `claim.ts`'s reason**: 403 already means other things,
 * and an app matching on prose breaks the day somebody improves the wording. The code is the
 * contract; `error` stays free to change — which is why the number is *in* the sentence and the
 * test reads it from there rather than from the binding.
 */
const SHARE_LIMIT = "share_limit";

/** What `state` a share that is not withdrawn is not. Bound, never written as a SQL literal. */
export const REVOKED = "revoked";

/**
 * The state a share serves in: what a publish writes, and the only state the daily pass can take
 * a lapsed one back to.
 *
 * Exported for `lapse.ts`, which writes it, so the string has one spelling in this Worker rather
 * than one here and one in the pass that undoes it.
 */
export const LIVE = "live";

/**
 * The state the daily pass writes when a membership ends, and the only one it can take back.
 *
 * Exported beside `REVOKED` because the two public routes have to tell them apart: they are the
 * same 410 with **different sentences**, and a viewer learning "withdrawn" when the owner's
 * Patreon simply lapsed would be told the owner made a decision they did not make.
 */
export const LAPSED = "lapsed";

/** One share's metadata, as the app sends it and as the columns take it. */
interface Meta {
  folderUid: string | null;
  title: string;
  ownerName: string;
  cardCount: number;
  totalValue: number | null;
  currency: string | null;
  marketplace: string | null;
  fields: string[];
}

/** A nullable text column arriving from a caller: absent, null, or a string within the ceiling. */
function optionalText(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  return typeof value === "string" && value !== "" && value.length <= MAX_TEXT_CHARS;
}

/**
 * What is wrong with this metadata, as the sentence to answer with, or `null` for a share this
 * Worker will store. `manifestProblem`'s shape, and pure for the same reason: nothing here needs
 * the database, so all of it happens before the first read.
 *
 * **`ownerName` is checked even though the plan's list did not name it**, because `owner_name` is
 * `NOT NULL`: an absent one is a constraint failure and a 500 where a sentence belongs.
 */
export function metaProblem(body: unknown): string | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return "malformed share";
  const { folderUid, title, ownerName, cardCount, totalValue, currency, marketplace, fields } =
    body as Record<string, unknown>;

  // `undefined` and `null` are both the whole collection. The app sends `null`; a body that
  // omits the key entirely means the same thing and there is nothing to be gained by refusing it.
  if (folderUid !== undefined && folderUid !== null && !optionalText(folderUid)) {
    return "that is not a folder";
  }
  if (typeof title !== "string" || title === "") return "a share needs a title";
  if (title.length > MAX_TEXT_CHARS) return `a title may be at most ${MAX_TEXT_CHARS} characters`;
  if (typeof ownerName !== "string" || ownerName === "") return "a share needs an owner's name";
  if (ownerName.length > MAX_TEXT_CHARS) {
    return `a name may be at most ${MAX_TEXT_CHARS} characters`;
  }
  // A non-integer count is refused rather than floored, for `handleRotate`'s reason about an
  // epoch: `1.5` would be stored as itself and the page would render a card count no collection
  // can have.
  if (typeof cardCount !== "number" || !Number.isInteger(cardCount) || cardCount < 0) {
    return "that is not a card count";
  }
  // ⚠️ `Number.isFinite` is reachable and not ceremony: `JSON.parse("1e400")` is `Infinity`, and
  // an infinite total in a REAL column is a page that says a binder is worth ∞.
  if (
    totalValue !== undefined &&
    totalValue !== null &&
    (typeof totalValue !== "number" || !Number.isFinite(totalValue))
  ) {
    return "that is not a total value";
  }
  if (!optionalText(currency)) return "that is not a currency";
  if (!optionalText(marketplace)) return "that is not a marketplace";
  if (!Array.isArray(fields)) return "malformed share";
  // ⚠️ **The ceiling is the format's own arity rather than a number somebody picked**: `fields` is
  // a set over three known names, so anything longer is duplicates or junk. Checking each element
  // does not bound the array — `["condition"] × 100_000` passes that check and is a megabyte of
  // JSON text in a column of a D1 database the whole account shares, which is the same thing
  // [`MAX_TEXT_CHARS`] exists to stop one field away.
  if (fields.length > KNOWN_FIELDS.length) {
    return "that is not a list of fields this format carries";
  }
  for (const field of fields) {
    if (typeof field !== "string" || !KNOWN_FIELDS.includes(field)) {
      return "that is not a field this format carries";
    }
  }
  return null;
}

/** The body, once `metaProblem` has said it is one. Absent optionals become explicit nulls. */
function readMeta(body: unknown): Meta {
  const raw = body as Record<string, unknown>;
  return {
    folderUid: (raw.folderUid as string | null | undefined) ?? null,
    title: raw.title as string,
    ownerName: raw.ownerName as string,
    cardCount: raw.cardCount as number,
    totalValue: (raw.totalValue as number | null | undefined) ?? null,
    currency: (raw.currency as string | null | undefined) ?? null,
    marketplace: (raw.marketplace as string | null | undefined) ?? null,
    fields: raw.fields as string[],
  };
}

/**
 * The share id: 12 random bytes as unpadded base64url — 96 bits, 16 characters, in the same
 * alphabet `GROUP_SEGMENT` already constrains a path segment to.
 *
 * **It is the only credential a viewer has**, so it is unguessable and it is minted rather than
 * derived from anything about the folder: a hash of the folder uid would let anyone who knows a
 * uid rebuild the link, and a revoked share's replacement would be the same string.
 *
 * The byte-at-a-time loop rather than `String.fromCharCode(...bytes)`, for `token.ts`'s reason:
 * the spread blows the stack on a large input, and this one is never large enough to find out.
 */
function mintId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Which row a folder's next publish is about: this group's, this folder's, **and not a
 * tombstone**.
 *
 * ⚠️ **The folder key is `coalesce(folder_uid, '')` and never `folder_uid` on its own.** SQLite
 * treats NULLs as distinct, so `WHERE folder_uid = ?` matches nothing for a whole-collection
 * share and every republish of the whole collection would mint a second link — and a bare unique
 * index would let it. The empty string is *bound* rather than written as a literal so the
 * statement is one shape whichever kind of share it is about.
 *
 * ⚠️ **`state <> 'revoked'` is the other half and it was missing for one commit.** A revoked row
 * *stays* — it is what answers a viewer 410 rather than 404 — so after a withdrawal there are two
 * rows on this key and `first()` answers the tombstone. `handleCreate` then took the mint-a-new-id
 * branch on **every** later publish: the second publish looked right, and the third raised
 * `UNIQUE constraint failed: index 'shares_folder'` against the real index, for ever. That is one
 * uncaught 500 on every Refresh of a folder that has ever been revoked, and the test that was
 * supposed to cover it published only twice. With this clause the answer is the live-or-lapsed
 * row or nothing at all, which is what the partial index guarantees is unambiguous.
 */
const FOLDER_KEY = `group_id = ? AND coalesce(folder_uid, ?) = ? AND state <> ?`;

/**
 * The share this group is serving for this folder, or `null` for a folder it has never shared —
 * or has withdrawn.
 *
 * `shares_folder` is unique over exactly this predicate, so there is at most one row to find and
 * no `ORDER BY` can change the answer.
 */
async function serving(env: Env, group: string, key: string): Promise<{ id: string } | null> {
  return env.DB.prepare(`SELECT id FROM shares WHERE ${FOLDER_KEY}`)
    .bind(group, "", key, REVOKED)
    .first<{ id: string }>();
}

/** The columns a share crosses the wire as, in the order the list answers them. */
interface ShareRow {
  id: string;
  folder_uid: string | null;
  title: string;
  owner_name: string;
  card_count: number;
  total_value: number | null;
  currency: string | null;
  marketplace: string | null;
  fields: string;
  bytes: number | null;
  state: string;
  created_at: number;
  updated_at: number;
}

const ROW_COLUMNS = `id, folder_uid, title, owner_name, card_count, total_value, currency,
   marketplace, fields, bytes, state, created_at, updated_at`;

/**
 * One row as the app reads it: camelCase, `fields` parsed back into the array it was published
 * as, and the link built here rather than in the app.
 *
 * **An unreadable `fields` throws rather than answering `[]`**, for `handleKeys`'s reason about a
 * corrupt manifest: `[]` is a *valid* answer meaning "this snapshot carries no optional fields",
 * so defaulting to it would tell the owner they had published less than they did. A throw is a
 * 500 that names the row and is recoverable by fixing it.
 */
function wireRow(env: Env, row: ShareRow): Record<string, unknown> {
  let fields: unknown;
  try {
    fields = JSON.parse(row.fields);
  } catch {
    throw new Error(`share ${row.id} has an unreadable field list`);
  }
  return {
    id: row.id,
    url: shareUrl(env, row.id),
    folderUid: row.folder_uid,
    title: row.title,
    ownerName: row.owner_name,
    cardCount: row.card_count,
    totalValue: row.total_value,
    currency: row.currency,
    marketplace: row.marketplace,
    fields,
    bytes: row.bytes,
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ---------------------------------------------------------------------------------------
// The row the two public routes read
// ---------------------------------------------------------------------------------------

/**
 * What a share looks like to a stranger holding the link: the metadata the shell renders, the
 * object the snapshot lives in, and the state that decides whether either is answered at all.
 *
 * **`group_id` is deliberately absent, and so are `folder_uid` and `marketplace`.** A viewer is
 * never told which group published a share — that is the sync side's identifier — and a projection
 * is the cheapest place to make that true, rather than a rule about what the page happens to
 * interpolate.
 */
export interface PublicRow {
  id: string;
  title: string;
  owner_name: string;
  card_count: number;
  object_key: string | null;
  state: string;
  updated_at: number;
}

const PUBLIC_COLUMNS = `id, title, owner_name, card_count, object_key, state, updated_at`;

/**
 * The one row `GET /s/{id}` and `GET /s/{id}/{hash}.json.gz` each read, or `null` for an id
 * nobody minted.
 *
 * ⚠️ **No join to `entitlements`, and that is spec §6's whole point.** Whether a membership is
 * live is written into `state` by the daily pass, once a day, so the anonymous read path branches
 * on a column rather than re-deciding an entitlement — otherwise every stranger who clicks a
 * Discord link would cost a two-table read on the D1 budget the account's paying readers share,
 * to answer a question whose answer changes at most daily.
 *
 * **It does not exclude revoked rows**, which is the opposite of every statement above it: a
 * tombstone is exactly what the public routes need to find, because answering 410 *"this was
 * withdrawn"* rather than 404 *"you mistyped it"* is the only reason the row was kept.
 */
export async function publicShare(env: Env, id: string): Promise<PublicRow | null> {
  return env.DB.prepare(`SELECT ${PUBLIC_COLUMNS} FROM shares WHERE id = ?`)
    .bind(id)
    .first<PublicRow>();
}

// ---------------------------------------------------------------------------------------
// POST /g/{group}/share
// ---------------------------------------------------------------------------------------

/**
 * Publish a folder, or answer the id the folder already has.
 *
 * **Decision 7 is one share per folder, so this is an upsert on the folder rather than an
 * insert**: re-sharing returns the same link, which is what makes Refresh a thing a reader can
 * press without their friends' bookmarks dying. The three states divide as follows:
 *
 * * a **live** row keeps its id and takes the new metadata;
 * * a **lapsed** row does too — and is left `lapsed`, because spec §6 puts that flip in the daily
 *   pass that reads what the relay already decided. A Worker that re-lit a link because the
 *   caller held a token would be a second opinion about when a membership ended, and a token
 *   outlives a cancellation by up to a day;
 * * a **revoked** row is left where it is and a **new id** is minted, because a revoked link must
 *   stay dead. That is why `shares_folder` is a *partial* index — see `schema.sql`.
 *
 * **It writes the metadata and never the blob.** `object_key` stays NULL until `blob.ts` commits
 * one, which is what makes a failed upload leave the previous snapshot serving rather than a
 * broken link.
 */
export async function handleCreate(
  request: Request,
  env: Env,
  group: string,
  now: number,
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "unreadable body" }, 400);
  }
  const problem = metaProblem(body);
  if (problem !== null) return json({ error: problem }, 400);
  const meta = readMeta(body);
  const key = meta.folderUid ?? "";

  // **`serving` excludes the tombstone**, so there is no `state` to branch on here: a row means
  // this folder has a live or lapsed share and `null` means it has none — including the folder
  // that had one and had it withdrawn, which is the case that mints a new id.
  const existing = await serving(env, group, key);

  if (existing !== null) {
    await env.DB.prepare(
      `UPDATE shares SET title = ?, owner_name = ?, card_count = ?, total_value = ?,
         currency = ?, marketplace = ?, fields = ?, updated_at = ?
       WHERE id = ?`,
    )
      .bind(
        meta.title,
        meta.ownerName,
        meta.cardCount,
        meta.totalValue,
        meta.currency,
        meta.marketplace,
        JSON.stringify(meta.fields),
        now,
        existing.id,
      )
      .run();
    return json({ id: existing.id, url: shareUrl(env, existing.id) });
  }

  // **Counted rather than `count(*)`**, because `fakeD1`'s SELECT projects named columns and an
  // aggregate is not one — and because the number this refusal names is small by construction:
  // the cap is what stops it growing.
  const { results } = await env.DB.prepare(
    `SELECT id FROM shares WHERE group_id = ? AND state <> ?`,
  )
    .bind(group, REVOKED)
    .all<{ id: string }>();
  if (results.length >= MAX_SHARES_PER_GROUP) {
    return json(
      {
        error: `that group has already shared ${MAX_SHARES_PER_GROUP} collections. ` +
          `Revoke one before sharing another.`,
        code: SHARE_LIMIT,
      },
      403,
    );
  }

  const id = mintId();
  const insert = env.DB.prepare(
    `INSERT INTO shares (id, group_id, folder_uid, title, owner_name, card_count, total_value,
       currency, marketplace, fields, object_key, bytes, state, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    id,
    group,
    meta.folderUid,
    meta.title,
    meta.ownerName,
    meta.cardCount,
    meta.totalValue,
    meta.currency,
    meta.marketplace,
    JSON.stringify(meta.fields),
    null,
    null,
    LIVE,
    now,
    now,
  );

  try {
    await insert.run();
  } catch (error) {
    // **Two devices in one group publishing the same folder at once both read `null` above.**
    // `shares_folder` refuses the second row, which is the guarantee working — a folder can never
    // hold two serving shares — but the loser must not be handed a 500 for having lost a race it
    // could not see. Re-reading answers the winner's id, which is the id it would have been given
    // a moment earlier or a moment later, so the operation is idempotent from the app's side.
    //
    // **The error's text is never matched on.** Every driver spells a constraint violation
    // differently (`D1_ERROR: UNIQUE constraint failed: index 'shares_folder': SQLITE_CONSTRAINT`
    // on D1 today), and a Worker branching on that string breaks silently on a runtime update.
    // The question asked instead is the one that actually matters: *is a share serving this
    // folder now?* If not, this was not the race and the failure is rethrown untouched.
    const won = await serving(env, group, key);
    if (won === null) throw error;
    return json({ id: won.id, url: shareUrl(env, won.id) });
  }

  return json({ id, url: shareUrl(env, id) });
}

// ---------------------------------------------------------------------------------------
// GET /g/{group}/shares
// ---------------------------------------------------------------------------------------

/**
 * What this group has published, from any device in it.
 *
 * **This list is the roster** (Task 2), the way a rotation's rewrapped key set is the roster for
 * group membership: the app's `collection_shares` is a cache that lets a folder wear its badge
 * offline, and a share this answer does not name has left. So a **revoked** row is absent —
 * withdrawing is what makes it leave — while a **lapsed** one is present and carries its state,
 * because "your links stopped working because your membership ended" is a sentence the app owes
 * the reader before their friends tell them.
 */
export async function handleList(env: Env, group: string): Promise<Response> {
  const { results } = await env.DB.prepare(
    `SELECT ${ROW_COLUMNS} FROM shares WHERE group_id = ? AND state <> ? ORDER BY created_at`,
  )
    .bind(group, REVOKED)
    .all<ShareRow>();
  return json({ shares: results.map((row) => wireRow(env, row)) });
}

// ---------------------------------------------------------------------------------------
// DELETE /g/{group}/share/{id}
// ---------------------------------------------------------------------------------------

/**
 * Withdraw a share. Terminal, and the reader's own press.
 *
 * **The row stays and its `state` moves**, which is the difference between a viewer learning the
 * share was withdrawn (410) and learning they mistyped a link (404). Deleting it would also let
 * the id be re-observed as unminted, which is a strictly worse answer to a link somebody has
 * bookmarked.
 *
 * **`AND group_id = ?` is the whole of the ownership check.** The gate proved the caller holds
 * this group's token; without this clause a share id — which is a *public* string, printed in
 * every link — would be enough for any entitled caller to revoke anyone's binder.
 *
 * Idempotent: revoking an already-revoked share answers 204 again, because the state it asked
 * for is the state it is in.
 */
export async function handleRevoke(
  env: Env,
  group: string,
  id: string,
  now: number,
): Promise<Response> {
  const { meta } = await env.DB.prepare(
    `UPDATE shares SET state = 'revoked', updated_at = ? WHERE id = ? AND group_id = ?`,
  )
    .bind(now, id, group)
    .run();
  if (meta.changes === 0) return json({ error: "no such share" }, 404);
  return new Response(null, { status: 204 });
}
