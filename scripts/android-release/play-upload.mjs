// Put a release's signed bundle on Google Play's internal track — `release.yml`'s
// `play-upload`, the last thing before `publish`.
//
//   PLAY_SERVICE_ACCOUNT_JSON=… node scripts/android-release/play-upload.mjs <bundle.aab> <versionCode>
//
// One conversation with the Play Developer API (v3), seven requests:
//
//   1. a token, for a JWT signed with the service account's key (scope `androidpublisher`);
//   2. a new edit of `com.mtggrimoire.app`;
//   3. the bundles Play already holds — **if this versionCode is among them, the edit is
//      discarded and the run ends green**: Play takes a versionCode once, so a re-run of this
//      job, or a bundle the owner uploaded by hand, is not an error;
//   4. the tracks, and what each holds — **if a bundle or a track has a higher versionCode
//      than this release's, the edit is discarded and the run ends red** (since 2026-10-11):
//      this is an older release's job run again, after a release that never reached Play, and
//      its bundle would put an older build on the track over the newer one;
//   5. the bundle — and Play's reading of its versionCode has to be the release's;
//   6. that versionCode on the `internal` track, status `completed`;
//   7. the commit. Nothing reaches a tester before it, and an edit that is never committed
//      expires by itself — which is why discarding one (an eighth request, on the two paths
//      that upload nothing) is a courtesy whose failure is not this run's.
//
// **Promotion is the owner's click.** This puts a build on the internal track and nowhere
// else; closed testing and production are Play Console's.
//
// **No dependency, on purpose.** This is the one program the service account's key reaches,
// in a job that installs nothing: `node:crypto` signs the JWT and `fetch` does the rest. An
// upload action would run its own dependency tree in that step.
//
// **The key is never printed**, nor the assertion signed with it, nor the token it buys. A
// refusal is reported as the step, the status and Google's answer — never the request. No
// answer at all is reported as the step and `fetch`'s reason, without its `cause`. A success
// that is not what was asked for — no token in it, no edit id, not JSON — is reported by name
// and never quoted. And no request follows a redirect, which would send its body again.
//
// **What it says at the end depends on what happened** (`summaryOf`): "upload it by hand" is
// sound advice after most failures, and wrong after an older release was refused or after a
// commit that may have landed.
//
// `play-upload.test.mjs` holds the conversation, each refusal and each silence.
import { createSign } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** The app's permanent name on Play (`apps/light/src-tauri/tauri.conf.json`, `identifier`). */
export const PACKAGE = "com.mtggrimoire.app";
/** The only track a release reaches by itself (the owner's decision, 2026-10-11). */
export const TRACK = "internal";
export const GOOGLE = {
  token: "https://oauth2.googleapis.com/token",
  api: "https://androidpublisher.googleapis.com",
};
const SCOPE = "https://www.googleapis.com/auth/androidpublisher";
/**
 * A request's deadline; the upload's, a bundle being tens of megabytes; and the commit's — the
 * one request whose outcome is not known when this side gives up, so it is given longer.
 */
const CALL_MS = 30_000;
const UPLOAD_MS = 10 * 60_000;
const COMMIT_MS = 120_000;
/** How much of a refusal's body the summary prints. The refusal itself keeps all of it. */
const PRINTED = 2_000;

const b64url = (value) => Buffer.from(value).toString("base64url");
/** A list out of an answer, or none: Play leaves out what is empty. */
const listOf = (value) => (Array.isArray(value) ? value : []);

/** The JWT Google exchanges for an access token, good for ten minutes. */
export function assertionFor(account, nowSeconds) {
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(
    JSON.stringify({
      iss: account.client_email,
      scope: SCOPE,
      aud: GOOGLE.token,
      iat: nowSeconds,
      exp: nowSeconds + 600,
    }),
  );
  const signature = createSign("RSA-SHA256")
    .update(`${head}.${claims}`)
    .sign(account.private_key)
    .toString("base64url");
  return `${head}.${claims}.${signature}`;
}

/** The secret as a service account. What it throws names the secret and never quotes it. */
export function accountOf(text) {
  if (text === "") throw new Error("PLAY_SERVICE_ACCOUNT_JSON is not set");
  let account;
  try {
    account = JSON.parse(text);
  } catch {
    throw new Error("PLAY_SERVICE_ACCOUNT_JSON is not JSON");
  }
  if (
    account === null ||
    typeof account !== "object" ||
    account.type !== "service_account" ||
    typeof account.client_email !== "string" ||
    typeof account.private_key !== "string"
  ) {
    throw new Error(
      "PLAY_SERVICE_ACCOUNT_JSON is not a service account's key file: it needs `type: service_account`, a `client_email` and a `private_key`",
    );
  }
  return account;
}

/** Google said no: at which step, with what status, in its own words. */
export class Refused extends Error {
  constructor(step, status, body) {
    super(`Google refused to ${step}: ${status} ${body}`);
    this.name = "Refused";
    this.step = step;
    this.status = status;
    this.body = body;
  }
}

/**
 * No answer at all: the connection dropped, or the deadline passed, at which step. It carries
 * no `cause` — what prints an error prints its cause too, and this says all there is to say.
 */
export class Unanswered extends Error {
  constructor(step, detail) {
    super(`No answer from Google while trying to ${step}: ${detail}`);
    this.name = "Unanswered";
    this.step = step;
  }
}

/**
 * Play has a higher versionCode than this release's, as a bundle or on a track: this is an
 * older release's job run again, and its bundle on the track would put an older build in
 * front of testers who have the newer one. Nothing is uploaded.
 */
export class Newer extends Error {
  constructor(held, versionCode) {
    super(
      `Play already holds versionCode ${held}, newer than this release's ${versionCode}. Nothing was uploaded.`,
    );
    this.name = "Newer";
    this.held = held;
    this.versionCode = versionCode;
  }
}

/**
 * Play read another versionCode out of the bundle than the release's: the bundle is not this
 * release's, here or in Play Console. The edit is left to expire.
 */
export class Misread extends Error {
  constructor(read, versionCode) {
    super(
      `Play read versionCode ${read} out of the bundle, and this release is ${versionCode}. Nothing was put on a track.`,
    );
    this.name = "Misread";
    this.read = read;
    this.versionCode = versionCode;
  }
}

/** Play's words for a versionCode it has taken before, wherever it keeps it. */
const USED = /already been used/i;

/** What the owner can do about a refusal this script knows, or `null`. */
export function hintFor(refusal) {
  if (/invalid_grant/.test(refusal.body)) {
    return "Google did not accept the service account's key: the key was deleted or belongs to another account, or the runner's clock is off. Make a new JSON key and set `PLAY_SERVICE_ACCOUNT_JSON` again.";
  }
  if (/draft app/i.test(refusal.body)) {
    return "Play still treats the app as a draft, and takes only draft releases for it. Roll a release out on the internal track by hand once, in Play Console, then re-run this job.";
  }
  if (/changesNotSentForReview/.test(refusal.body)) {
    return "Play will not send this change for review by itself: changes are waiting in Play Console. Send them from *Publishing overview*, then re-run this job.";
  }
  // Before the permission hint: Play says this with a 403, and Google's 403s are all
  // `PERMISSION_DENIED`, whatever they are about.
  if (USED.test(refusal.body)) {
    return "Play holds this versionCode somewhere the bundle list does not show (an edit that was never committed, or a build since removed). Nothing was put on a track; the next release's higher versionCode is the way forward.";
  }
  // A 401 or a 403 by itself means "the account may not" only where nothing else can: at the
  // token and at the edit. Later in the conversation it takes Google's wording to say so.
  const first = refusal.step === "get a token" || refusal.step === "open an edit";
  if (
    (first && (refusal.status === 401 || refusal.status === 403)) ||
    /PERMISSION_DENIED|does not have permission|has not been used in project/i.test(refusal.body)
  ) {
    return "The service account may not do this. In Play Console → *Users and permissions*, the account needs **Release apps to testing tracks** on MTG Grimoire; and its Google Cloud project needs the *Google Play Android Developer API* enabled.";
  }
  if (refusal.status === 404 && refusal.step === "open an edit") {
    return `Play does not know ${PACKAGE} for this account: the service account has not been given the app in Play Console yet (a new permission can take a while to take effect), or the app is under another developer account.`;
  }
  return null;
}

/**
 * The whole conversation. `send` is `fetch` and `hosts` is Google, unless a test says
 * otherwise. Resolves `{ uploaded, versionCode }`; rejects with a {@link Refused} for an
 * answer that was not a success, an {@link Unanswered} for none, a {@link Newer} when Play
 * has moved past this release, a {@link Misread} when the bundle is not this release's, and a
 * plain `Error` for a success that was not what was asked for.
 */
export async function upload({
  account,
  bundle,
  versionCode,
  hosts = GOOGLE,
  send = fetch,
  nowSeconds = Math.floor(Date.now() / 1000),
}) {
  const call = async (step, url, init = {}, deadline = CALL_MS) => {
    let response;
    let text;
    try {
      // `redirect: "error"`: `fetch` would follow a 307 or a 308 by sending the same body
      // again — the assertion, the bundle — to wherever the answer pointed.
      response = await send(url, {
        ...init,
        redirect: "error",
        signal: AbortSignal.timeout(deadline),
      });
      text = await response.text();
    } catch (error) {
      // `fetch` says "fetch failed" and keeps the reason in `cause`; a deadline says only that
      // an operation was aborted. Neither names the step, and the step is what tells a commit
      // that may have landed from a token that was never given.
      const late = error?.name === "TimeoutError" || error?.name === "AbortError";
      const code = typeof error?.cause?.code === "string" ? ` (${error.cause.code})` : "";
      throw new Unanswered(
        step,
        late ? `nothing within ${deadline / 1000} s` : `${error?.message}${code}`,
      );
    }
    if (!response.ok) throw new Refused(step, response.status, text);
    if (text === "") return {};
    try {
      return JSON.parse(text) ?? {};
    } catch {
      // Not the `SyntaxError`'s own words: V8 quotes the text it could not read, and a token
      // answer cut short is a slice of a credential.
      throw new Error(
        `Google's answer to "${step}" was not JSON (${response.status}, ${text.length} characters)`,
      );
    }
  };

  const { access_token: token } = await call("get a token", hosts.token, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: assertionFor(account, nowSeconds),
    }).toString(),
  });
  // The answer is never printed, whatever is in it: an answer with no token may hold another.
  if (typeof token !== "string" || token === "") {
    throw new Error("Google answered the token request without an access token");
  }
  // `fetch` quotes a header value it will not send, so one it would refuse stops here.
  if (!/^[\x21-\x7e]+$/.test(token)) {
    throw new Error("Google answered the token request with an access token no header can carry");
  }
  const auth = { authorization: `Bearer ${token}` };
  const app = `${hosts.api}/androidpublisher/v3/applications/${PACKAGE}`;

  const edit = await call("open an edit", `${app}/edits`, { method: "POST", headers: auth });
  if (typeof edit.id !== "string" || edit.id === "") {
    throw new Error("Google opened an edit without an id");
  }
  const at = `${app}/edits/${edit.id}`;
  // A courtesy, and best effort: an edit that is never committed expires by itself, so a
  // discard that is refused or unanswered changes nothing about what this run found.
  const discard = () =>
    call("discard the edit", at, { method: "DELETE", headers: auth }).catch(() => {});

  const held = await call("list the bundles Play holds", `${at}/bundles`, { headers: auth });
  const bundles = listOf(held.bundles);
  if (bundles.some((known) => known?.versionCode === versionCode)) {
    await discard();
    return { uploaded: false, versionCode };
  }

  // Not held, so it would go up — unless Play has moved on. A build can be on a track and
  // gone from the list of bundles, so both are read; a track's `versionCodes` are strings.
  const listed = await call("list the tracks", `${at}/tracks`, { headers: auth });
  const onTracks = listOf(listed.tracks).flatMap((track) =>
    listOf(track?.releases).flatMap((release) => listOf(release?.versionCodes)),
  );
  const highest = [...bundles.map((known) => known?.versionCode), ...onTracks]
    .map(Number)
    .filter(Number.isSafeInteger)
    .reduce((most, code) => Math.max(most, code), 0);
  if (highest > versionCode) {
    await discard();
    throw new Newer(highest, versionCode);
  }

  const sent = await call(
    "upload the bundle",
    `${hosts.api}/upload/androidpublisher/v3/applications/${PACKAGE}/edits/${edit.id}/bundles?uploadType=media`,
    {
      method: "POST",
      headers: { ...auth, "content-type": "application/octet-stream" },
      body: bundle,
    },
    UPLOAD_MS,
  );
  if (sent.versionCode !== versionCode) throw new Misread(sent.versionCode, versionCode);

  await call(`put the bundle on the ${TRACK} track`, `${at}/tracks/${TRACK}`, {
    method: "PUT",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({
      track: TRACK,
      releases: [{ versionCodes: [String(versionCode)], status: "completed" }],
    }),
  });
  await call("commit the edit", `${at}:commit`, { method: "POST", headers: auth }, COMMIT_MS);
  return { uploaded: true, versionCode };
}

/**
 * What the job prints and appends to its summary, as lines: for a `result` of {@link upload},
 * or for the `error` that ended it.
 */
export function summaryOf({ versionCode, result, error }) {
  if (!error) {
    return result.uploaded
      ? [
          `### Google Play — versionCode ${versionCode} is on the internal track`,
          "",
          "Internal testers get it from Play at once. **Promotion to closed testing or production is yours**, in Play Console → *Test and release*.",
        ]
      : [
          `### Google Play — versionCode ${versionCode} was already there`,
          "",
          "Play already holds a bundle with this versionCode, so nothing was uploaded and no track was changed.",
        ];
  }
  const refused = error instanceof Refused;
  const hint = refused ? hintFor(error) : null;
  // A proxy's error page is not a summary: the body is cut in what is printed, and whole in
  // `Refused.body`, which is what `hintFor` read.
  const more = refused ? error.body.length - PRINTED : 0;
  const message =
    more > 0
      ? `Google refused to ${error.step}: ${error.status} ${error.body.slice(0, PRINTED)}… (${more} more characters)`
      : error.message;
  const last = lastWordOn(error);
  return [
    "### Google Play — the upload failed",
    "",
    message,
    ...(hint ? ["", hint] : []),
    ...(last ? ["", last] : []),
  ];
}

/**
 * What a failure leaves the reader to do, or `null` when there is nothing sound to say.
 * "Upload it by hand" is the usual answer and the wrong one three times: for an older release,
 * which is the upload that was refused; for a bundle Play read another versionCode out of, or
 * a versionCode Play has used, which Play Console would take no better; and after a commit
 * that may have landed, where a second upload is the one thing that cannot help.
 */
function lastWordOn(error) {
  if (error instanceof Newer || error instanceof Misread) return null;
  if (error instanceof Refused && USED.test(error.body)) return null;
  const unknown =
    error instanceof Unanswered || (error instanceof Refused && error.status >= 500);
  if (unknown && error.step === "commit the edit") {
    return "The commit may have landed. Re-run this job: it says the bundle is already there if it did, and uploads again if it did not. Do not upload by hand first.";
  }
  return "The signed bundle is this run's artifact `play-upload-bundle`; it can be uploaded by hand.";
}

async function main() {
  const [path, code] = process.argv.slice(2);
  const versionCode = Number(code);
  if (!path || !Number.isSafeInteger(versionCode) || versionCode <= 0) {
    console.error("usage: node scripts/android-release/play-upload.mjs <bundle.aab> <versionCode>");
    process.exitCode = 2;
    return;
  }
  let lines;
  try {
    const account = accountOf(process.env.PLAY_SERVICE_ACCOUNT_JSON ?? "");
    const result = await upload({ account, bundle: readFileSync(path), versionCode });
    lines = summaryOf({ versionCode, result });
  } catch (error) {
    lines = summaryOf({ versionCode, error });
    process.exitCode = 1;
  }
  console.log(lines.join("\n"));
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
