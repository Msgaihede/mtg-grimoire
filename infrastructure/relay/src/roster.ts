import { SIG_CHARS, type Refusal } from "./admit";
import { EPOCH_HISTORY, MAX_GROUP_DEVICES, REMOVAL_STEP } from "./groupauth";
// **`import type` and never a value import**, for `groupauth.ts`'s reason: `index.ts` imports this
// file, so a value import back would close a runtime cycle across its route table's construction.
import type { Env } from "./index";
import { hex } from "./md5";

/**
 * The signed roster document (RD): who is in a sync group at an epoch, with each member's two
 * public keys and what it may do — spec §5, and §12's wire contract, which this file and
 * `crates/grimoire-core` are both built against (issue #1096, the Discord integration's second PR).
 *
 * **Why the relay keeps one at all.** The manifest a rotation publishes (`group_keys.keys`) names
 * devices and carries sealed keys, and no public key: a device learns a peer's keys only at the
 * pairing ceremony, so a phone that did not pair the Discord bot could never verify one envelope
 * the bot signed (spec §2, F1). An RD names every member's X25519 and Ed25519 keys, so a device
 * that adopts one can insert the members it never met. And it says each member's `cap`, which is
 * what lets a group hold a device — the bot — that may read but not write (spec §6).
 *
 * **The RD is a string, stored and served verbatim and never re-serialised.** Both of its
 * authenticators are over its exact bytes; a relay that parsed it and wrote it back would
 * reorder a key or respell a number and break every signature it held. So this file parses a
 * *copy* to judge it and stores the text it was given.
 *
 * **Two authenticators, and the relay can check only one of them.**
 *
 * - **`rosterMac`** (open mode): HMAC-SHA256 under a key derived from the epoch's *group key*,
 *   which the relay has never held. It stores the MAC unverified and every client checks it — the
 *   same position the relay is in for every sealed batch it stores. Sound while every key holder
 *   is a full device, which is what open mode means.
 * - **`rosterSig`** (signed mode): Ed25519 by the RD's `signer`, which the relay *can* check,
 *   because the previous RD names the signer's public key. **Once a group is signed, this file
 *   refuses every RD a full member of the previous one did not sign** — which is what stops a
 *   restricted device that holds the group key (the bot does: it must, to read) from rotating the
 *   group, evicting a member or promoting itself (spec §2, F2).
 *
 * **Who may enter signed mode** is the question the latch turns on, and the answer is the same
 * rule: the first signed RD must be signed by a member the previous RD — an open one — lists as
 * `full`, verified with that member's key as the previous RD has it. **A group with no RD at all
 * cannot start signed**: there is no previous document to check a signer against, and taking the
 * new document's word for its own signer would be trust on first use for whoever posts first. The
 * gate a client meets before it may enable the bot (spec §7) needs an RD naming every member's
 * signing key anyway, so the first signed RD always has an open one before it.
 *
 * ⚠️ **An open RD may name no member whose `cap` is not `full`** — a refusal of this relay's own,
 * not spelled in §12, and the reason is that it is what makes the relay's half of a restriction
 * hold. Open mode is accepted under a MAC any key holder can compute; a group in open mode with a
 * restricted member is a group whose restricted member could MAC an amendment promoting itself,
 * and `/token` would mint it a full token. Spec §5 defines open mode as *no restricted device
 * ever*; this enforces it, so a `cap` claim on a token (`token.ts`) can only ever have come from
 * a signed RD.
 */

/** The domain tag both authenticators are computed over, ahead of a `0x00` and the RD's bytes. */
export const ROSTER_DOMAIN = "mtg-grimoire/roster/v1";

/**
 * The longest RD the relay stores, in characters.
 *
 * A member is about 230 characters — a 32-character device id, two 43-character keys, a `cap`,
 * two small numbers and the punctuation — and an RD holds at most [`MAX_GROUP_DEVICES`] of them,
 * so a full group's RD is about 1.3 KB. Eight KiB is six times that: a ceiling that says
 * "something is wrong" rather than a budget, on a write the caller chooses the size of. **Unknown
 * fields count against it**, which is what bounds the leniency below.
 */
export const MAX_ROSTER_CHARS = 8 * 1024;

/**
 * How many RDs `/keys` answers in `rosters`, oldest first: sixteen.
 *
 * A device catching up walks the chain from the epoch it stands on; [`EPOCH_HISTORY`] epochs of
 * rotations are eight step-0 documents, and an amendment per member per epoch is rare — a device
 * amends its own entry when its keys or its protocol level change. ⚠️ **A page cannot be
 * continued inside one epoch**: `since` is an epoch, so an epoch holding more than sixteen RDs
 * would answer its first sixteen to every caller. Nothing honest writes that many, and the latest
 * RD is answered beside the page (`roster`) whatever the page holds.
 */
export const ROSTER_PAGE = 16;

/** A `rosterMac`: a 32-byte HMAC-SHA256 as base64url without padding. */
export const ROSTER_MAC_CHARS = 43;

/**
 * A `rosterSig` is an Ed25519 signature, 64 bytes, and so exactly an envelope's `sig` length —
 * one constant, `admit.ts`'s, so the two cannot drift into two ideas of a signature.
 */
export const ROSTER_SIG_CHARS = SIG_CHARS;

/** The codes this file refuses with. Clients match on `code`, never on the sentence. */
export const MALFORMED_ROSTER = "malformed_roster";
export const ROSTER_CONFLICT = "roster_conflict";
export const UNSIGNED_ROSTER = "unsigned_roster";
export const UNSIGNED_ROTATION = "unsigned_rotation";

/**
 * A member's or a signer's device id: `claim.ts`'s `GROUP_SEGMENT`, anchored.
 *
 * **Spelled out rather than built from that constant**, because `claim.ts` imports this file (its
 * `grantFor` asks [`capOf`]) and a value import back would be a cycle evaluated at module load —
 * the trap `groupauth.ts`'s first comment describes. `roster.test.ts` holds the two spellings to
 * one pattern.
 */
export const MEMBER_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** A `cap`: lower-case letters, so an unknown one (spec §7's next capability) still parses. */
const CAP = /^[a-z]{1,32}$/;

/** `prev`: the hex SHA-256 of the previous RD's string. */
const SHA256_HEX = /^[0-9a-f]{64}$/;

export interface Member {
  device: string;
  x25519: string;
  /**
   * `null` for a member that has no signing key yet — a device paired before signing keys
   * existed, named by another member's document until it amends its own entry (spec §12,
   * *Amendments*). Such a member can sign nothing, so it is never a signer this file accepts.
   */
  ed25519: string | null;
  cap: string;
  proto: number;
  since: number;
}

/** The RD as this file reads it — a copy, for judging; the string is what is stored. */
export interface Roster {
  v: 1;
  group: string;
  epoch: number;
  step: number;
  prev: string | null;
  mode: "open" | "signed";
  signer: string;
  members: Member[];
}

/** One stored RD, as a row holds it and as `/keys` answers it. */
export interface StoredRoster {
  epoch: number;
  step: number;
  roster: string;
  mac: string | null;
  sig: string | null;
}

/** What an RD arrived with: exactly one of the two is a string. */
export interface Authenticator {
  mac: string | null;
  sig: string | null;
}

// ---------------------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------------------

/** base64url without padding, to bytes — `null` for anything that is not that alphabet. */
function fromBase64Url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return null;
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/");
  let binary: string;
  try {
    binary = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Is `text` exactly `bytes` bytes as unpadded base64url, **in its one canonical spelling**?
 *
 * The length alone is not enough: 43 characters carry 258 bits, and the last character's two
 * spare bits can be set without changing the 32 bytes `atob` yields — so one key would have four
 * spellings, and a client comparing a pinned key as text would see four different keys.
 * Re-encoding the decoded bytes and comparing refuses all but the one an encoder writes.
 */
export function isBase64Url(text: unknown, bytes: number): text is string {
  if (typeof text !== "string" || text.length !== Math.ceil((bytes * 8) / 6)) return false;
  const decoded = fromBase64Url(text);
  return decoded !== null && decoded.length === bytes && toBase64Url(decoded) === text;
}

/** A non-negative safe integer: an epoch, a step, a protocol level. */
function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** A member entry, or the sentence that says what is wrong with it. */
function memberProblem(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "a member is not an object";
  }
  const m = value as Partial<Record<keyof Member, unknown>>;
  if (typeof m.device !== "string" || !MEMBER_ID.test(m.device)) return "a member's device";
  if (!isBase64Url(m.x25519, 32)) return "a member's x25519 key";
  if (m.ed25519 !== null && !isBase64Url(m.ed25519, 32)) return "a member's ed25519 key";
  if (typeof m.cap !== "string" || !CAP.test(m.cap)) return "a member's cap";
  if (!isCount(m.proto)) return "a member's proto";
  if (!isCount(m.since)) return "a member's since";
  return null;
}

export type Parsed = { ok: true; roster: Roster } | { ok: false; error: string };

/**
 * An RD string, read **leniently** — a field this file does not know is ignored, so a later
 * client may add one without a relay release — and checked for every field it does know.
 *
 * - `v` is `1`; a `2` is refused, because a relay that cannot read a version cannot judge it.
 * - `group` is the group of the route it arrived on — a document published into another group's
 *   chain would be a valid RD in the wrong place.
 * - `epoch` and `step` are non-negative safe integers, `prev` is 64 hex or `null`, `mode` is
 *   `open` or `signed`, `signer` is a device id.
 * - `members` holds at most [`MAX_GROUP_DEVICES`] entries with distinct devices, each with its two
 *   keys as 32 canonical base64url bytes — `ed25519` may be `null`, a member with no signing key
 *   yet, which is how `crates/grimoire-core` writes an older device (`roster-v1.json`'s second
 *   member) — a `cap`, and `proto` and `since` as counts. **None is
 *   allowed**: the last device out publishes a manifest of `{}`, and its RD names nobody.
 * - **An open RD names no member that is not `full`** — the file's doc says why.
 *
 * Every refusal is the one code, `malformed_roster`; the sentence names the field, for a log line.
 */
export function parseRoster(text: unknown, group: string): Parsed {
  const bad = (what: string): Parsed => ({ ok: false, error: `malformed roster: ${what}` });
  if (typeof text !== "string" || text === "") return bad("not a string");
  if (text.length > MAX_ROSTER_CHARS) return bad("too long");

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return bad("not JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return bad("not an object");
  }
  const r = parsed as Partial<Record<keyof Roster, unknown>>;
  if (r.v !== 1) return bad("v");
  if (r.group !== group) return bad("group");
  if (!isCount(r.epoch)) return bad("epoch");
  if (!isCount(r.step)) return bad("step");
  if (r.prev !== null && (typeof r.prev !== "string" || !SHA256_HEX.test(r.prev))) {
    return bad("prev");
  }
  if (r.mode !== "open" && r.mode !== "signed") return bad("mode");
  if (typeof r.signer !== "string" || !MEMBER_ID.test(r.signer)) return bad("signer");
  if (!Array.isArray(r.members)) return bad("members");
  if (r.members.length > MAX_GROUP_DEVICES) return bad("too many members");

  const seen = new Set<string>();
  const members: Member[] = [];
  for (const entry of r.members as unknown[]) {
    const problem = memberProblem(entry);
    if (problem !== null) return bad(problem);
    const m = entry as Member;
    if (seen.has(m.device)) return bad("a member named twice");
    seen.add(m.device);
    if (r.mode === "open" && m.cap !== "full")
      return bad("an open roster with a restricted member");
    // Rebuilt from the checked fields, so nothing downstream can read an unchecked one.
    members.push({
      device: m.device,
      x25519: m.x25519,
      ed25519: m.ed25519,
      cap: m.cap,
      proto: m.proto,
      since: m.since,
    });
  }

  return {
    ok: true,
    roster: {
      v: 1,
      group,
      epoch: r.epoch,
      step: r.step,
      prev: r.prev,
      mode: r.mode,
      signer: r.signer,
      members,
    },
  };
}

/**
 * The authenticator a body carries: exactly one of `rosterMac` (43 characters) and `rosterSig`
 * (86), as canonical unpadded base64url of 32 and 64 bytes — or the sentence that refuses it.
 *
 * ⚠️ **`null` reads as absent here**, unlike an envelope's `sig` (`admit.ts`'s `isEnvelope`, where
 * `null` is present and refused). That rule exists because an envelope is stored and served, and a
 * stored `null` would reach every peer; these two fields are read once and never stored as sent,
 * so a client's serde writing `None` as `null` costs nothing and is accepted.
 */
export function authenticatorOf(body: {
  rosterMac?: unknown;
  rosterSig?: unknown;
}): Authenticator | string {
  const mac = body.rosterMac ?? null;
  const sig = body.rosterSig ?? null;
  if ((mac === null) === (sig === null)) {
    return "malformed roster: exactly one of rosterMac and rosterSig";
  }
  if (mac !== null && !isBase64Url(mac, 32)) return "malformed roster: rosterMac";
  if (sig !== null && !isBase64Url(sig, 64)) return "malformed roster: rosterSig";
  return { mac: mac as string | null, sig: sig as string | null };
}

// ---------------------------------------------------------------------------------------
// Crypto
// ---------------------------------------------------------------------------------------

/** `ROSTER_DOMAIN ++ 0x00 ++ <RD bytes>`: what both authenticators are computed over. */
export function signedBytes(text: string): Uint8Array {
  const encoder = new TextEncoder();
  const domain = encoder.encode(ROSTER_DOMAIN);
  const body = encoder.encode(text);
  const out = new Uint8Array(domain.length + 1 + body.length);
  out.set(domain, 0);
  out[domain.length] = 0;
  out.set(body, domain.length + 1);
  return out;
}

/** The hex SHA-256 of an RD string: what the next RD's `prev` must say. */
export async function rosterHash(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return hex(new Uint8Array(digest));
}

/**
 * Does `sig` verify, under the Ed25519 public key `publicKey`, over [`signedBytes`] of `text`?
 *
 * **WebCrypto's Ed25519, in workerd and in Node alike**, so the suite runs the code that is
 * deployed. **It does not throw**: a key that will not import or a signature that will not decode
 * is `false`, the answer a forgery gets — every input here is a caller's.
 */
export async function verifyRosterSig(
  text: string,
  sig: string,
  publicKey: string,
): Promise<boolean> {
  const key = fromBase64Url(publicKey);
  const signature = fromBase64Url(sig);
  if (key === null || key.length !== 32 || signature === null || signature.length !== 64) {
    return false;
  }
  try {
    const imported = await crypto.subtle.importKey("raw", key, { name: "Ed25519" }, false, [
      "verify",
    ]);
    return await crypto.subtle.verify({ name: "Ed25519" }, imported, signature, signedBytes(text));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------
// The chain
// ---------------------------------------------------------------------------------------

/**
 * A stored RD, read back. **It throws rather than answering `null`**, for `currentManifest`'s
 * reason: every row was judged by [`parseRoster`] before it was written, so one that does not
 * parse is a corrupt row, and a quiet answer would turn it into a group that reads as having no
 * roster — open, and unlatched — on every route at once. A 500 stalls the group where it stands,
 * which is recoverable by fixing the row.
 */
export function storedRoster(row: StoredRoster, group: string): Roster {
  const parsed = parseRoster(row.roster, group);
  if (!parsed.ok) throw new Error(`group ${group} has an unreadable roster document`);
  return parsed.roster;
}

/** Is `(epoch, step)` strictly after the stored RD `latest`? Everything is after none. */
export function isAfter(epoch: number, step: number, latest: StoredRoster | null): boolean {
  if (latest === null) return true;
  return epoch > latest.epoch || (epoch === latest.epoch && step > latest.step);
}

const refusal = (status: number, code: string, error: string): Refusal => ({ status, code, error });

/**
 * Whether the RD `next` — `text` as sent, with `auth` — may follow `latest`, the group's newest
 * stored RD: `null` to store it, or the refusal. **Pure over what was read**; the store is a
 * separate, guarded statement ([`storeAmendment`], [`storeRotationRoster`]), because the chain can
 * move between this read and that write.
 *
 * In order:
 *
 * 1. **`prev` is the hash of `latest`'s string, or `null` when there is none** — else
 *    **`409 roster_conflict`**: the caller built on a document that is no longer the newest, and
 *    refetches `/keys` and retries. First, because judging a signature against a stale previous
 *    document would be asking the wrong question.
 * 2. **`(epoch, step)` is strictly after `latest`'s** — else `409 roster_conflict`, for the same
 *    reason. The routes have already pinned the position the RD must take; this is what refuses
 *    one a newer document has overtaken.
 * 3. **The latch**: `latest` signed and `next` not — `403` (the `unsignedCode` the route gives,
 *    `unsigned_roster` or `unsigned_rotation`). A 403 and not §12's `400 malformed_roster`,
 *    deliberately: every 400 these routes give is decided from the body alone, before D1 is read,
 *    and this one is decided by what the group has stored — and what it says is the same thing
 *    the other 403s say, *this group is signed and this document is not signed by one of its full
 *    members*.
 * 4. **A signed `next`**: it carries `rosterSig`, there is a `latest`, `signer` is a member of
 *    `latest` whose `cap` is `full` and whose `ed25519` is not `null`, and the signature verifies
 *    under that key as `latest` has it — else `403`. Checked whether `latest` is signed or open, which is the rule
 *    for entering signed mode as much as for staying in it.
 * 5. **An open `next`** after an open `latest` is stored with its authenticator unverified: a MAC
 *    the relay holds no key for, or a signature open mode does not require it to check.
 */
export async function judge(
  next: Roster,
  text: string,
  auth: Authenticator,
  latest: StoredRoster | null,
  group: string,
  unsignedCode: typeof UNSIGNED_ROSTER | typeof UNSIGNED_ROTATION,
): Promise<Refusal | null> {
  const expected = latest === null ? null : await rosterHash(latest.roster);
  if (next.prev !== expected) {
    return refusal(409, ROSTER_CONFLICT, "that roster does not follow the group's newest");
  }
  if (!isAfter(next.epoch, next.step, latest)) {
    return refusal(409, ROSTER_CONFLICT, "that roster does not follow the group's newest");
  }

  const previous = latest === null ? null : storedRoster(latest, group);
  const unsigned = (why: string) => refusal(403, unsignedCode, why);
  if (previous?.mode === "signed" && next.mode !== "signed") {
    return unsigned("this group is signed, and that roster is not");
  }
  if (next.mode === "signed") {
    if (auth.sig === null) return unsigned("a signed roster carries rosterSig");
    if (previous === null) return unsigned("a group's first roster cannot be signed");
    const signer = previous.members.find((member) => member.device === next.signer);
    if (signer === undefined || signer.cap !== "full" || signer.ed25519 === null) {
      return unsigned("that roster's signer is not a full member of the one before it");
    }
    if (!(await verifyRosterSig(text, auth.sig, signer.ed25519))) {
      return unsigned("that roster's signature does not verify");
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------
// D1
// ---------------------------------------------------------------------------------------

/**
 * The group's newest RD, or `null` for a group that has published none — every group before this
 * release, and every group whose devices are all older builds.
 *
 * `ORDER BY epoch DESC, step DESC LIMIT 1` is the primary key walked backwards, so it is a point
 * read on the index and no sort.
 */
export async function latestRoster(env: Env, group: string): Promise<StoredRoster | null> {
  return env.DB.prepare(
    `SELECT epoch, step, roster, mac, sig FROM rosters WHERE group_id = ?
      ORDER BY epoch DESC, step DESC LIMIT 1`,
  )
    .bind(group)
    .first<StoredRoster>();
}

/** Every RD from epoch `since` on, oldest first, at most [`ROSTER_PAGE`] — `/keys`'s `rosters`. */
export async function rostersSince(
  env: Env,
  group: string,
  since: number,
): Promise<StoredRoster[]> {
  const { results } = await env.DB.prepare(
    `SELECT epoch, step, roster, mac, sig FROM rosters WHERE group_id = ? AND epoch >= ?
      ORDER BY epoch, step LIMIT ?`,
  )
    .bind(group, since, ROSTER_PAGE)
    .all<StoredRoster>();
  return results;
}

/**
 * The group's mode, from its newest RD: `"signed"`, `"open"`, or `null` for none (which behaves
 * as open). Read by the device binding **only on a mismatch** (`index.ts`'s `bound`), so an
 * honest push or ack never pays for it.
 */
export async function rosterMode(env: Env, group: string): Promise<"open" | "signed" | null> {
  const latest = await latestRoster(env, group);
  return latest === null ? null : storedRoster(latest, group).mode;
}

/**
 * The `cap` the group's newest RD gives `device`, when it is not `full` — the `cap` claim
 * `claim.ts`'s `grantFor` mints into a token — or `undefined`: a full member, a device the RD does
 * not name, or a group with no RD. A device not named is every device of a group that has never
 * published one, and minting it a restricted token would end sync for every older group.
 *
 * One D1 read per token minted, which is once a day per device.
 */
export async function capOf(env: Env, group: string, device: string): Promise<string | undefined> {
  const latest = await latestRoster(env, group);
  if (latest === null) return undefined;
  const member = storedRoster(latest, group).members.find((m) => m.device === device);
  return member === undefined || member.cap === "full" ? undefined : member.cap;
}

/**
 * The guard both stores share: **no RD is stored after `latest`** — the one [`judge`] checked
 * `prev` against — as one `count(*)` subquery in the `INSERT`'s own `WHERE`.
 *
 * D1 has no interactive transaction (`groupauth.ts`'s `recordRotation` says why that matters), so
 * reading the newest RD and then inserting is two round trips with a window between them. Without
 * this clause a rotation and an amendment that both read the same `latest` would both store — one
 * at the next epoch and one at the next step — and the chain would fork: two documents claiming
 * one `prev`. With it, the second to arrive finds a row after the one it built on, inserts nothing
 * and is refused `409 roster_conflict`. Two writers aiming at the *same* position meet the primary
 * key as well, which `OR IGNORE` turns into the same `changes: 0`.
 *
 * `-1, -1` for a `latest` of none counts every row the group has, so a group's first RD is stored
 * only while it has none.
 */
const NOTHING_AFTER = `(SELECT count(*) FROM rosters
     WHERE group_id = ? AND (epoch > ? OR (epoch = ? AND step > ?))) = 0`;

function afterBindings(group: string, latest: StoredRoster | null): (string | number)[] {
  const epoch = latest?.epoch ?? -1;
  const step = latest?.step ?? -1;
  return [group, epoch, epoch, step];
}

/**
 * Store an amendment: `next` at the group's current epoch, **only while that is still the
 * group's current epoch and nothing has been stored after `latest`** — both in the `INSERT`'s own
 * `WHERE`. `false` when either has moved, and nothing is written.
 *
 * The epoch clause is what keeps an amendment from landing at an epoch a rotation has just left:
 * `/roster` read the epoch, and a rotation can be accepted before this statement runs.
 */
export async function storeAmendment(
  env: Env,
  group: string,
  next: Roster,
  text: string,
  auth: Authenticator,
  latest: StoredRoster | null,
  nowMs: number,
): Promise<boolean> {
  const written = await env.DB.prepare(
    `INSERT OR IGNORE INTO rosters (group_id, epoch, step, roster, mac, sig, created_at)
     SELECT ?, ?, ?, ?, ?, ?, ?
      WHERE ? = coalesce((SELECT max(epoch) FROM group_keys WHERE group_id = ?), -1)
        AND ${NOTHING_AFTER}`,
  )
    .bind(
      group,
      next.epoch,
      next.step,
      text,
      auth.mac,
      auth.sig,
      nowMs,
      next.epoch,
      group,
      ...afterBindings(group, latest),
    )
    .run();
  return (written.meta?.changes ?? 0) > 0;
}

/**
 * Store a rotation's RD, **ahead of the rotation itself** and under the rotation's own epoch
 * bound — one or [`REMOVAL_STEP`] past the group's newest key row, `recordRotation`'s `WHERE` —
 * as well as [`NOTHING_AFTER`]. `false` when any of it fails, and nothing is written.
 *
 * ⚠️ **Before `recordRotation` and not in the batch after it**, which is the one place this
 * departs from "the same batch as the rotation's other writes", and the reason is what a refusal
 * would leave. `recordRotation`'s guarded `INSERT` *is* the rotation's acceptance; an RD written
 * after it under a guard of its own could find the chain moved and write nothing — and the group
 * would stand on an accepted epoch with no RD, which in signed mode every client holds as
 * unverifiable. A D1 batch is a transaction, but a guarded `INSERT` that matches nothing is not an
 * error and rolls nothing back. Written first, a lost race refuses the whole rotation before any
 * of it is recorded; and if the rotation is then refused, `handleRotate` deletes this row
 * ([`unstoreRoster`]). **What that costs** is a window of one round trip in which the group's
 * newest RD is at an epoch its newest key row has not reached: a `/keys` in it answers a `roster`
 * one epoch ahead of its `epoch`, and a client must read an RD ahead of the manifest as *not yet*.
 */
export async function storeRotationRoster(
  env: Env,
  group: string,
  next: Roster,
  text: string,
  auth: Authenticator,
  latest: StoredRoster | null,
  nowMs: number,
): Promise<boolean> {
  const written = await env.DB.prepare(
    `INSERT OR IGNORE INTO rosters (group_id, epoch, step, roster, mac, sig, created_at)
     SELECT ?, ?, ?, ?, ?, ?, ?
      WHERE ? > coalesce((SELECT max(epoch) FROM group_keys WHERE group_id = ?), -1)
        AND ? <= coalesce((SELECT max(epoch) FROM group_keys WHERE group_id = ?), -1) + ?
        AND ${NOTHING_AFTER}`,
  )
    .bind(
      group,
      next.epoch,
      next.step,
      text,
      auth.mac,
      auth.sig,
      nowMs,
      next.epoch,
      group,
      next.epoch,
      group,
      REMOVAL_STEP,
      ...afterBindings(group, latest),
    )
    .run();
  return (written.meta?.changes ?? 0) > 0;
}

/**
 * Take back a rotation's RD whose rotation was then refused — by its exact text, so a row another
 * request wrote at the same position (none can: the primary key refused it) is never touched.
 */
export async function unstoreRoster(
  env: Env,
  group: string,
  next: Roster,
  text: string,
): Promise<void> {
  await env.DB.prepare(
    `DELETE FROM rosters WHERE group_id = ? AND epoch = ? AND step = ? AND roster = ?`,
  )
    .bind(group, next.epoch, next.step, text)
    .run();
}

/**
 * Prune the RDs older than the key window, after a rotation that stored one: `epoch <= newest -`
 * [`EPOCH_HISTORY`], `group_keys`' own arithmetic. **Only after a rotation that carried an RD**,
 * because then the newest RD is at the newest epoch and cannot be pruned; a rotation by an older
 * build that carried none could leave the newest RD further back than the window, and pruning it
 * would restart the chain — and unlatch a signed group, since the latch is read off the newest
 * RD. A device dark across more than the window cannot walk the chain anyway (spec §5).
 */
export async function pruneRosters(env: Env, group: string, epoch: number): Promise<void> {
  await env.DB.prepare(`DELETE FROM rosters WHERE group_id = ? AND epoch <= ? - ?`)
    .bind(group, epoch, EPOCH_HISTORY)
    .run();
}

/** Every RD a group holds, for the teardown that drops its key history (`claim.ts`). */
export async function forgetRosters(env: Env, group: string): Promise<void> {
  await env.DB.prepare(`DELETE FROM rosters WHERE group_id = ?`).bind(group).run();
}

/** `/keys`'s three fields for one stored RD. */
export function wireRoster(row: StoredRoster | null): {
  roster: string | null;
  rosterMac: string | null;
  rosterSig: string | null;
} {
  return { roster: row?.roster ?? null, rosterMac: row?.mac ?? null, rosterSig: row?.sig ?? null };
}
