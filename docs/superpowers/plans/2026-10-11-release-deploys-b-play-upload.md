# A release uploads the Android bundle to Google Play — Implementation Plan (piece B)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `release.yml` puts the bundle `android-sign` signed on Google Play's internal track, as the last step before `publish`.

**Architecture:** One new job, `play-upload`, in the `release` environment: it asks whether a service account is set and a bundle was signed, downloads the artifact `play-upload-bundle`, and runs one dependency-free Node script that talks to the Play Developer API (a JWT signed with `node:crypto`, then `fetch`). The script's `fetch` is an argument, so its whole conversation with Google is tested against a stand-in.

**Tech Stack:** GitHub Actions, Node 24 (`node:crypto`, global `fetch`), Google Play Developer API v3, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-11-release-deploys-everything-design.md` (§4, §6, §7.2, §9). Piece A is `2026-10-11-release-deploys-a-workers.md`.

## Global Constraints

- **Piece A is merged first.** This plan edits `release.yml` and `scripts/release-rule.test.mjs` as piece A leaves them (ten jobs, `DEPLOYS`, `RUNS`). Start from a branch off `main` that contains it; if `git grep -n "relay-deploy:" .github/workflows/release.yml` finds nothing, stop.
- **One commit for the whole piece**, `feat:`. No task commits; Task 4 does.
- **`pnpm verify` runs once, in Task 4.** While building, run only the single test file a step names.
- **No agent uploads anything to Play, creates a service account or sets a secret.** The script is run by hand only against the test's stand-in.
- **A secret-holding job builds nothing:** no pnpm, no cargo, no Gradle, no cache, `shell: bash` only, nothing installed. The one program the key reaches is `node scripts/android-release/play-upload.mjs`.
- **Exact values:** package `com.mtggrimoire.app`; track `internal`; release status `completed`; secret `PLAY_SERVICE_ACCOUNT_JSON`; artifact `play-upload-bundle`; bundle file `mtg-grimoire-<version>-android.aab`; `versionCode` = major × 1,000,000 + minor × 1,000 + patch.
- **Action pins** are the ones `release.yml` already uses (`actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1`, `actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0`, `actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8.0.1`); `persist-credentials: false` on the checkout.
- **The key is never printed.** No error message, log line or summary carries any part of `PLAY_SERVICE_ACCOUNT_JSON` or of the token made from it.

## Review Focus

1. **The job is run again after it already uploaded** (a re-run of failed jobs, or the owner uploaded by hand first). Play refuses a `versionCode` twice; the job must end green and say the bundle is already there. Pinned in Task 1 (`uploads nothing when Play already holds the versionCode`).
2. **The secret is not a service account's key file** (truncated paste, the wrong JSON). The failure names the secret and what is wrong with it, and echoes none of it. Pinned in Task 1 (`accountOf`).
3. **Play refuses for a reason the owner can act on** — the account lacks the app permission, the app is still a draft, changes are waiting to be sent for review. The failure says which and what to do. Pinned in Task 1 (`hintFor`).
4. **A service account is set but this release signed no bundle** (no upload key, or no committed fingerprint). The job ends green and says so; it does not look for an artifact that does not exist. Pinned in Task 2 (`asks for the account and the signed bundle`).
5. **Play reads another `versionCode` out of the bundle than the release computed.** Nothing is put on a track and nothing is committed. Pinned in Task 1 (`stops when Play reads another versionCode`).

---

## File structure

| File | Responsibility |
| --- | --- |
| `scripts/android-release/play-upload.mjs` | The conversation with Google: token, edit, list, upload, track, commit; and `main`. |
| `scripts/android-release/play-upload.test.mjs` | That conversation against a stand-in, a throwaway RSA key, and each refusal. |
| `.github/workflows/release.yml` | `android-sign` says whether it signed; job `play-upload`; `publish` waits for it. |
| `scripts/release-rule.test.mjs` | The fence, extended to eleven jobs. |

---

### Task 1: The upload script

**Files:**
- Create: `scripts/android-release/play-upload.mjs`
- Test: `scripts/android-release/play-upload.test.mjs`

**Interfaces:**
- Produces:
  - `PACKAGE = "com.mtggrimoire.app"`, `TRACK = "internal"`, `GOOGLE = { token, api }`
  - `assertionFor(account: { client_email: string, private_key: string }, nowSeconds: number): string`
  - `accountOf(text: string): { client_email: string, private_key: string }` (throws)
  - `class Refused extends Error` with `step: string`, `status: number`, `body: string`
  - `hintFor(refusal: Refused): string | null`
  - `upload({ account, bundle: Uint8Array, versionCode: number, hosts?, send?, nowSeconds? }): Promise<{ uploaded: boolean, versionCode: number }>`
- CLI: `node scripts/android-release/play-upload.mjs <bundle.aab> <versionCode>`, reading `PLAY_SERVICE_ACCOUNT_JSON`. Exit 0 uploaded or already there, 1 refused, 2 usage. Task 2's job runs exactly this.

- [ ] **Step 1: Write the failing test**

Create `scripts/android-release/play-upload.test.mjs`:

```js
// @vitest-environment node
// The Play upload, against a stand-in for Google: `upload` is handed its `fetch`, so every
// request it makes — the token, the edit, the list, the bundle, the track, the commit — is
// read here, in order, and every refusal is one this file staged. Node's environment and not
// jsdom's, for `Response` and `AbortSignal.timeout` as the script meets them on a runner.
import { createVerify, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  accountOf,
  assertionFor,
  GOOGLE,
  hintFor,
  PACKAGE,
  Refused,
  TRACK,
  upload,
} from "./play-upload.mjs";

const { publicKey, privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const account = { client_email: "ci@project.iam.gserviceaccount.com", private_key: privateKey };
const hosts = { token: "https://token.test/token", api: "https://api.test" };
const APP = `/androidpublisher/v3/applications/${PACKAGE}`;
const bundle = new Uint8Array([80, 75, 3, 4, 1, 2, 3]);

/**
 * Google, as far as this script knows it. `held` is the versionCodes Play already has;
 * `readsAs` what Play says it read out of an uploaded bundle; `refuse` maps `METHOD path` to
 * the `[status, body]` to answer it with instead.
 */
function google({ held = [], readsAs = 43001, refuse = {} } = {}) {
  const calls = [];
  const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
  const send = (url, init = {}) => {
    const method = init.method ?? "GET";
    const path = url === hosts.token ? "/token" : url.replace(hosts.api, "");
    calls.push({ method, path, headers: init.headers ?? {}, body: init.body, signal: init.signal });
    const staged = refuse[`${method} ${path}`];
    if (staged) return Promise.resolve(new Response(staged[1], { status: staged[0] }));
    switch (`${method} ${path}`) {
      case "POST /token":
        return Promise.resolve(json({ access_token: "at-1", expires_in: 3600 }));
      case `POST ${APP}/edits`:
        return Promise.resolve(json({ id: "e1" }));
      case `GET ${APP}/edits/e1/bundles`:
        return Promise.resolve(json({ bundles: held.map((versionCode) => ({ versionCode })) }));
      case `POST /upload${APP}/edits/e1/bundles?uploadType=media`:
        return Promise.resolve(json({ versionCode: readsAs, sha256: "x" }));
      case `PUT ${APP}/edits/e1/tracks/${TRACK}`:
        return Promise.resolve(json(JSON.parse(init.body)));
      case `POST ${APP}/edits/e1:commit`:
        return Promise.resolve(json({ id: "e1" }));
      case `DELETE ${APP}/edits/e1`:
        return Promise.resolve(new Response(null, { status: 204 }));
      default:
        return Promise.resolve(new Response("the stand-in has no such route", { status: 599 }));
    }
  };
  return { calls, send, asked: () => calls.map((call) => `${call.method} ${call.path}`) };
}

const run = (fake, versionCode = 43001) =>
  upload({ account, bundle, versionCode, hosts, send: fake.send, nowSeconds: 1_800_000_000 });

describe("assertionFor", () => {
  it("signs what Google asks of a service account, for ten minutes", () => {
    const [head, claims, signature] = assertionFor(account, 1_800_000_000).split(".");
    expect(JSON.parse(Buffer.from(head, "base64url"))).toEqual({ alg: "RS256", typ: "JWT" });
    expect(JSON.parse(Buffer.from(claims, "base64url"))).toEqual({
      iss: "ci@project.iam.gserviceaccount.com",
      scope: "https://www.googleapis.com/auth/androidpublisher",
      // Google's token address whatever host the request is sent to: it is a claim.
      aud: GOOGLE.token,
      iat: 1_800_000_000,
      exp: 1_800_000_600,
    });
    const verified = createVerify("RSA-SHA256")
      .update(`${head}.${claims}`)
      .verify(publicKey, Buffer.from(signature, "base64url"));
    expect(verified).toBe(true);
  });
});

describe("accountOf", () => {
  const SECRET = "not-json-and-must-not-be-echoed";

  it("reads a service account's key file", () => {
    const text = JSON.stringify({ type: "service_account", ...account, project_id: "p" });
    expect(accountOf(text)).toMatchObject(account);
  });

  it("refuses text that is not JSON, without repeating it", () => {
    expect(() => accountOf(SECRET)).toThrow("PLAY_SERVICE_ACCOUNT_JSON is not JSON");
    expect(() => accountOf(SECRET)).not.toThrow(new RegExp(SECRET));
  });

  it("refuses JSON that is not a service account's key file", () => {
    for (const text of ['{"type":"authorized_user"}', '{"type":"service_account"}', "null", "[]"]) {
      expect(() => accountOf(text), text).toThrow(/is not a service account's key file/);
    }
  });

  it("says an unset secret is unset", () => {
    expect(() => accountOf("")).toThrow("PLAY_SERVICE_ACCOUNT_JSON is not set");
  });
});

describe("upload", () => {
  it("opens an edit, uploads, puts the bundle on the internal track and commits", async () => {
    const fake = google();
    expect(await run(fake)).toEqual({ uploaded: true, versionCode: 43001 });
    expect(fake.asked()).toEqual([
      "POST /token",
      `POST ${APP}/edits`,
      `GET ${APP}/edits/e1/bundles`,
      `POST /upload${APP}/edits/e1/bundles?uploadType=media`,
      `PUT ${APP}/edits/e1/tracks/internal`,
      `POST ${APP}/edits/e1:commit`,
    ]);
  });

  it("asks for a token with the signed assertion, and sends the token with everything after", async () => {
    const fake = google();
    await run(fake);
    const [token, ...rest] = fake.calls;
    expect(token.headers.authorization).toBeUndefined();
    const form = new URLSearchParams(String(token.body));
    expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    expect(form.get("assertion")).toBe(assertionFor(account, 1_800_000_000));
    for (const call of rest) expect(call.headers.authorization, call.path).toBe("Bearer at-1");
    // Every request has a deadline: a host that accepts and never answers ends the step.
    for (const call of fake.calls) expect(call.signal, call.path).toBeInstanceOf(AbortSignal);
  });

  it("sends the bundle's bytes as they are, and names the release as Play wants it", async () => {
    const fake = google();
    await run(fake);
    const sent = fake.calls.find((call) => call.path.startsWith("/upload"));
    expect(sent.headers["content-type"]).toBe("application/octet-stream");
    expect(sent.body).toBe(bundle);
    const track = fake.calls.find((call) => call.method === "PUT");
    expect(track.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(track.body)).toEqual({
      track: "internal",
      releases: [{ versionCodes: ["43001"], status: "completed" }],
    });
  });

  // A re-run, or the owner's own upload: Play takes a versionCode once.
  it("uploads nothing when Play already holds the versionCode, and discards its edit", async () => {
    const fake = google({ held: [42000, 43001] });
    expect(await run(fake)).toEqual({ uploaded: false, versionCode: 43001 });
    expect(fake.asked()).toEqual([
      "POST /token",
      `POST ${APP}/edits`,
      `GET ${APP}/edits/e1/bundles`,
      `DELETE ${APP}/edits/e1`,
    ]);
  });

  it("reads a list with no bundles in it as holding none", async () => {
    const fake = google({ refuse: { [`GET ${APP}/edits/e1/bundles`]: [200, "{}"] } });
    expect(await run(fake)).toEqual({ uploaded: true, versionCode: 43001 });
  });

  it("stops when Play reads another versionCode out of the bundle", async () => {
    const fake = google({ readsAs: 43000 });
    await expect(run(fake)).rejects.toThrow(
      "Play read versionCode 43000 out of the bundle, and this release is 43001",
    );
    expect(fake.asked().some((line) => line.startsWith("PUT") || line.endsWith(":commit"))).toBe(false);
  });

  it("reports a refusal with the step, the status and Google's own words", async () => {
    const body = '{"error":{"code":403,"message":"The caller does not have permission","status":"PERMISSION_DENIED"}}';
    const fake = google({ refuse: { [`POST ${APP}/edits`]: [403, body] } });
    const refusal = await run(fake).catch((error) => error);
    expect(refusal).toBeInstanceOf(Refused);
    expect(refusal).toMatchObject({ step: "open an edit", status: 403, body });
    expect(refusal.message).toBe(`Google refused to open an edit: 403 ${body}`);
    expect(fake.asked()).toEqual(["POST /token", `POST ${APP}/edits`]);
  });

  it("commits nothing when the track is refused", async () => {
    const fake = google({
      refuse: { [`PUT ${APP}/edits/e1/tracks/internal`]: [400, "Only releases with status draft may be created on draft app."] },
    });
    const refusal = await run(fake).catch((error) => error);
    expect(refusal).toMatchObject({ step: "put the bundle on the internal track", status: 400 });
    expect(fake.asked().at(-1)).toBe(`PUT ${APP}/edits/e1/tracks/internal`);
  });
});

describe("hintFor", () => {
  const refused = (step, status, body) => new Refused(step, status, body);

  it("says what a missing permission needs", () => {
    expect(hintFor(refused("open an edit", 403, "PERMISSION_DENIED"))).toMatch(
      /Release apps to testing tracks/,
    );
    expect(hintFor(refused("open an edit", 401, "The caller does not have permission"))).toMatch(
      /Release apps to testing tracks/,
    );
  });

  it("says what a refused key means", () => {
    expect(hintFor(refused("get a token", 400, '{"error":"invalid_grant"}'))).toMatch(
      /key was deleted|clock/,
    );
  });

  it("says what a draft app needs", () => {
    expect(
      hintFor(refused("commit the edit", 400, "Only releases with status draft may be created on draft app.")),
    ).toMatch(/by hand/);
  });

  it("says what changes waiting for review need", () => {
    expect(
      hintFor(refused("commit the edit", 400, "Please set the query parameter changesNotSentForReview to true.")),
    ).toMatch(/Publishing overview/);
  });

  it("has nothing to add to a refusal it does not know", () => {
    expect(hintFor(refused("commit the edit", 500, "backend error"))).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `pnpm exec vitest run scripts/android-release/play-upload.test.mjs`
Expected: FAIL — `Failed to resolve import "./play-upload.mjs"`.

- [ ] **Step 3: Write the script**

Create `scripts/android-release/play-upload.mjs`:

```js
// Put a release's signed bundle on Google Play's internal track — `release.yml`'s
// `play-upload`, the last thing before `publish`.
//
//   PLAY_SERVICE_ACCOUNT_JSON=… node scripts/android-release/play-upload.mjs <bundle.aab> <versionCode>
//
// One conversation with the Play Developer API (v3), six requests:
//
//   1. a token, for a JWT signed with the service account's key (scope `androidpublisher`);
//   2. a new edit of `com.mtggrimoire.app`;
//   3. the bundles Play already holds — **if this versionCode is among them, the edit is
//      discarded and the run ends green**: Play takes a versionCode once, so a re-run of this
//      job, or a bundle the owner uploaded by hand, is not an error;
//   4. the bundle — and Play's reading of its versionCode has to be the release's;
//   5. that versionCode on the `internal` track, status `completed`;
//   6. the commit. Nothing reaches a tester before it, and an edit that is never committed
//      expires by itself.
//
// **Promotion is the owner's click.** This puts a build on the internal track and nowhere
// else; closed testing and production are Play Console's.
//
// **No dependency, on purpose.** This is the one program the service account's key reaches,
// in a job that installs nothing: `node:crypto` signs the JWT and `fetch` does the rest. An
// upload action would run its own dependency tree in that step.
//
// **The key is never printed**: a refusal is reported as the step, the status and Google's
// answer — never the request. `play-upload.test.mjs` holds the conversation and each refusal.
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
/** A request's deadline, and the upload's: a bundle is tens of megabytes. */
const CALL_MS = 30_000;
const UPLOAD_MS = 10 * 60_000;

const b64url = (value) => Buffer.from(value).toString("base64url");

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
  if (
    refusal.status === 401 ||
    refusal.status === 403 ||
    /PERMISSION_DENIED|does not have permission/i.test(refusal.body)
  ) {
    return "The service account may not do this. In Play Console → *Users and permissions*, the account needs **Release apps to testing tracks** on MTG Grimoire; and its Google Cloud project needs the *Google Play Android Developer API* enabled.";
  }
  return null;
}

/**
 * The whole conversation. `send` is `fetch` and `hosts` is Google, unless a test says
 * otherwise. Resolves `{ uploaded, versionCode }`; rejects with a {@link Refused} for an
 * answer that was not a success.
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
    const response = await send(url, { ...init, signal: AbortSignal.timeout(deadline) });
    const text = await response.text();
    if (!response.ok) throw new Refused(step, response.status, text);
    return text === "" ? {} : JSON.parse(text);
  };

  const { access_token: token } = await call("get a token", hosts.token, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: assertionFor(account, nowSeconds),
    }).toString(),
  });
  const auth = { authorization: `Bearer ${token}` };
  const app = `${hosts.api}/androidpublisher/v3/applications/${PACKAGE}`;

  const edit = await call("open an edit", `${app}/edits`, { method: "POST", headers: auth });
  const at = `${app}/edits/${edit.id}`;

  const held = await call("list the bundles Play holds", `${at}/bundles`, { headers: auth });
  if ((held.bundles ?? []).some((known) => known.versionCode === versionCode)) {
    await call("discard the edit", at, { method: "DELETE", headers: auth });
    return { uploaded: false, versionCode };
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
  if (sent.versionCode !== versionCode) {
    throw new Error(
      `Play read versionCode ${sent.versionCode} out of the bundle, and this release is ${versionCode}. Nothing was put on a track.`,
    );
  }

  await call(`put the bundle on the ${TRACK} track`, `${at}/tracks/${TRACK}`, {
    method: "PUT",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({
      track: TRACK,
      releases: [{ versionCodes: [String(versionCode)], status: "completed" }],
    }),
  });
  await call("commit the edit", `${at}:commit`, { method: "POST", headers: auth });
  return { uploaded: true, versionCode };
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
    lines = result.uploaded
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
  } catch (error) {
    const hint = error instanceof Refused ? hintFor(error) : null;
    lines = [
      "### Google Play — the upload failed",
      "",
      error.message,
      ...(hint ? ["", hint] : []),
      "",
      "The signed bundle is this run's artifact `play-upload-bundle`; it can be uploaded by hand.",
    ];
    process.exitCode = 1;
  }
  console.log(lines.join("\n"));
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
```

- [ ] **Step 4: Run it and see it pass**

Run: `pnpm exec vitest run scripts/android-release/play-upload.test.mjs`
Expected: PASS, 18 tests.

If the first line's `// @vitest-environment node` is not honoured (the symptom: `call.signal` is not an `AbortSignal`, or `Response` is undefined), do not weaken the assertions: read `vitest.config.ts` for how another file selects its environment and use that.

- [ ] **Step 5: Run `main` by hand, with no network and no real key**

```bash
node scripts/android-release/play-upload.mjs; echo "exit $?"
PLAY_SERVICE_ACCOUNT_JSON='oops' node scripts/android-release/play-upload.mjs package.json 43001; echo "exit $?"
PLAY_SERVICE_ACCOUNT_JSON='' node scripts/android-release/play-upload.mjs package.json 43001; echo "exit $?"
```

Expected: `exit 2` with the usage line; `exit 1` with `PLAY_SERVICE_ACCOUNT_JSON is not JSON` under `### Google Play — the upload failed`, and **the word `oops` nowhere in the output**; `exit 1` with `PLAY_SERVICE_ACCOUNT_JSON is not set`. None of the three makes a request. Keep the output for Task 3.

- [ ] **Step 6: Declare the one new global, and lint the two files**

`eslint.config.js` keeps a hand-written list of globals for `scripts/**/*.mjs`, and a name that is not on it fails `pnpm verify` at lint (`no-undef`) — which no focused Vitest run shows. Piece A added `Request`, `Response` and `URL`; this script also uses `URLSearchParams`. In that block, after `URL: "readonly",`, add:

```js
        // Asked and answered: `play-upload.mjs` posts the token request as a form, which is
        // what Google's token endpoint takes.
        URLSearchParams: "readonly",
```

Run: `pnpm exec eslint scripts/android-release eslint.config.js --max-warnings 0`
Expected: exit 0, no output. Any other `no-undef` it reports is a global to add the same way, with its reason.

- [ ] **Step 7: Route the new files in the CI router's table**

In `scripts/ci-route.test.mjs`, under the row for `scripts/android-release/StripSignature.java`, add:

```js
    ["scripts/android-release/play-upload.mjs", T, T, F, F, F, T, F],
```

Run: `pnpm exec vitest run scripts/ci-route.test.mjs`
Expected: PASS (the arm `scripts/android-release/*` already routes it).

---

### Task 2: The job, and the fence around it

**Files:**
- Modify: `.github/workflows/release.yml` (`android-sign`: `outputs`, and the signed summary's wording; new job `play-upload` between `web-deploy` and `publish`; `publish`'s `needs`; the header diagram)
- Modify: `scripts/release-rule.test.mjs`

**Interfaces:**
- Consumes: `node scripts/android-release/play-upload.mjs <bundle.aab> <versionCode>` (Task 1); `android-sign`'s step id `key` with output `present`; the artifact `play-upload-bundle` holding `mtg-grimoire-<version>-android.aab`.
- Produces: `android-sign`'s job output `signed`; job `play-upload` with step id `account`.

- [ ] **Step 1: Extend the fence first**

All edits are in `scripts/release-rule.test.mjs`.

**(a)** In `MAY_READ`, between `"web-deploy"` and `publish`, add:

```js
  "play-upload": ["PLAY_SERVICE_ACCOUNT_JSON"],
```

**(b)** In `RUNS["android-sign"]`, the second list (`// Sign the bundle with the upload key`): replace its last eight entries — from `"{",` to `'} >> "$GITHUB_STEP_SUMMARY"',` — with:

```js
      "{",
      "echo",
      'echo "**Signed \\`$aab\\`** — this run\'s artifact \\`play-upload-bundle\\`, versionCode $((major * 1000000 + minor * 1000 + patch))."',
      'echo "\\`play-upload\\` puts it on Play\'s internal track; if that job says it uploaded nothing,"',
      'echo "upload it by hand: Play Console → *Test and release* → the track → *Create new release*."',
      "echo",
      'echo "Until it is on a track and Play has reviewed it, phones stay on the previous version:"',
      'echo "\\`docs/reference/ci-and-releases.md\\`, *What only the owner can do*."',
      '} >> "$GITHUB_STEP_SUMMARY"',
```

**(c)** In `RUNS`, after the `"web-deploy"` list, add:

```js
  "play-upload": [
    // Is there an account to upload with, and a bundle to upload
    [
      "set -euo pipefail",
      'if [ "$HAS_ACCOUNT" = true ] && [ "$SIGNED" = true ]; then',
      'echo "present=true" >> "$GITHUB_OUTPUT"',
      "exit 0",
      "fi",
      'echo "present=false" >> "$GITHUB_OUTPUT"',
      "{",
      'echo "### Google Play — nothing uploaded"',
      "echo",
      'if [ "$SIGNED" != true ]; then',
      'echo "This release signed no bundle (the summary of \\`android (sign for Play)\\` says why), so there is nothing to upload."',
      "else",
      'echo "The \\`release\\` environment holds no \\`PLAY_SERVICE_ACCOUNT_JSON\\`, so the signed bundle was not uploaded."',
      'echo "It is this run\'s artifact \\`play-upload-bundle\\`: upload it by hand in Play Console."',
      "fi",
      "echo",
      'echo "Phones stay on the previous version until a bundle is on a track."',
      'echo "\\`docs/reference/ci-and-releases.md\\`, *What only the owner can do*, has the steps."',
      '} >> "$GITHUB_STEP_SUMMARY"',
    ],
    // Upload the bundle to the internal track
    [
      "set -euo pipefail",
      'IFS=. read -r major minor patch <<< "$VERSION"',
      'node scripts/android-release/play-upload.mjs "aab-in/mtg-grimoire-$VERSION-android.aab" "$((major * 1000000 + minor * 1000 + patch))"',
    ],
  ],
```

**(d)** The test `has the ten jobs, chained as the rule needs` becomes `has the eleven jobs, …`: add `"play-upload"` between `"web-deploy"` and `"publish"` in the key list; add

```js
    // The one step of a release that cannot be taken back — Play takes a versionCode once —
    // so it goes after every deploy, when only the flip of the draft is left.
    expect(needsOf(jobs["play-upload"])).toEqual(["release-please", "android-sign", "web-deploy"]);
```

and add `"play-upload"` to the end of `publish`'s expected `needs`.

**(e)** In `takes what it holds from the `release` environment…`, add `["play-upload", ["    environment: release"]],` after `web-deploy`'s row, and make the title say `five jobs`.

**(f)** Add `"play-upload"` to the deadline list and to the `never sees pnpm` list.

**(g)** In the `it.each` titled `%s builds nothing, and runs only what is listed here`, add:

```js
    ["play-upload", ["actions/checkout", "actions/download-artifact", "actions/setup-node"]],
```

**(h)** Replace the `it.each(Object.keys(DEPLOYS))` titled `%s sets Node up with caching off by name, and with nothing else` with one that also takes each job's asking step:

```js
  it.each([...Object.keys(DEPLOYS).map((name) => [name, "token"]), ["play-upload", "account"]])(
    "%s sets Node up with caching off by name, and with nothing else",
    (name, id) => {
      const node = stepsOf(jobs[name]).filter((step) => /^uses: actions\/setup-node@/.test(step));
      expect(node).toHaveLength(1);
      expect(node[0].trimEnd().split("\n").slice(1)).toEqual([
        `        if: steps.${id}.outputs.present == 'true'`,
        "        with:",
        "          node-version-file: .nvmrc",
        "          package-manager-cache: false",
      ]);
    },
  );
```

**(i)** In the test `hands the signed bundle to the owner as an artifact, and puts nothing on the release`, add after the `retention-days: 30` assertion:

```js
    // And it says whether it signed one, which is what `play-upload` asks first.
    expect(sign).toMatch(
      /^ {4}outputs:\n {6}signed: \$\{\{ steps\.key\.outputs\.present \}\}$/m,
    );
```

**(j)** After the test `applies the migrations, deploys and asks the host…`, add:

```js
  // **Uploads only what was signed, with a key that is set.** A service account with no signed
  // bundle is a release that had no upload key or no fingerprint: `android-sign` already said
  // so, and this job must not go looking for an artifact that was never made.
  it("asks for the account and the signed bundle, and does nothing without both", () => {
    const [checkout, ask, ...rest] = stepsOf(jobs["play-upload"]);
    expect(checkout).toMatch(/^uses: actions\/checkout@/);
    expect(checkout).not.toMatch(/^ {8}(?:if|env):/m);
    expect(ask).toMatch(/^ {8}id: account$/m);
    // Told whether the key is set, never what it is.
    expect(ask.match(/secrets\.[A-Z0-9_]+/g)).toEqual(["secrets.PLAY_SERVICE_ACCOUNT_JSON"]);
    expect(ask).toContain("HAS_ACCOUNT: ${{ secrets.PLAY_SERVICE_ACCOUNT_JSON != '' }}");
    expect(ask).toContain("SIGNED: ${{ needs.android-sign.outputs.signed }}");
    const lines = runsOf(ask)[0];
    expect(lines[1]).toBe('if [ "$HAS_ACCOUNT" = true ] && [ "$SIGNED" = true ]; then');
    expect(lines.filter((line) => line.includes("present=true"))).toHaveLength(1);
    // Neither absence is a failure: the job ends green and says which it was.
    expect(lines).not.toContain("exit 1");
    expect(ask).toMatch(/>> "\$GITHUB_STEP_SUMMARY"/);
    expect(rest).toHaveLength(3);
    for (const step of rest) {
      expect(step).toMatch(/^ {8}if: steps\.account\.outputs\.present == 'true'$/m);
    }
    // The key reaches one step: the script's.
    const holding = rest.filter((step) => secretsOf(step).length > 0);
    expect(holding).toHaveLength(1);
    expect(holding[0]).toContain(
      "PLAY_SERVICE_ACCOUNT_JSON: ${{ secrets.PLAY_SERVICE_ACCOUNT_JSON }}",
    );
    expect(holding[0]).toMatch(/^ {8}timeout-minutes: \d+$/m);
  });

  it("uploads the bundle `android-sign` signed, under the name and the versionCode it gave it", () => {
    const sign = jobs["android-sign"];
    const play = jobs["play-upload"];
    // One artifact, one file name, on both sides.
    expect(sign).toContain("name: play-upload-bundle");
    expect(play).toContain("name: play-upload-bundle");
    expect(sign).toContain('aab="mtg-grimoire-$VERSION-android.aab"');
    expect(play).toContain('"aab-in/mtg-grimoire-$VERSION-android.aab"');
    // And one arithmetic: Tauri's, which `versionCode` above computes and the summary prints.
    const arithmetic = "$((major * 1000000 + minor * 1000 + patch))";
    expect(sign).toContain(arithmetic);
    expect(play).toContain(arithmetic);
    // It can write nothing to the repository or the release.
    expect(play).not.toMatch(/gh release|GITHUB_TOKEN|GH_TOKEN|contents: write/);
    expect(play).toMatch(/^ {4}permissions:\n {6}contents: read\n {4}steps:$/m);
  });
```

**(k)** In the test `deploys each Worker from its own job, and holds no Cloudflare secret anywhere else`, widen the held-secret pattern from `/CLOUDFLARE_|ANDROID_KEY/` to `/CLOUDFLARE_|ANDROID_KEY|PLAY_SERVICE/`.

- [ ] **Step 2: Run the fence and see it fail**

Run: `pnpm exec vitest run scripts/release-rule.test.mjs`
Expected: FAIL — `has the eleven jobs…`, and `android-sign builds nothing, and runs only what is listed here` (the summary's old wording).

- [ ] **Step 3: `android-sign` says whether it signed**

In `.github/workflows/release.yml`, job `android-sign`: directly under `    environment: release`, add

```yaml
    # What `play-upload` asks before anything else: was a bundle signed.
    outputs:
      signed: ${{ steps.key.outputs.present }}
```

and in the step `Sign the bundle with the upload key`, replace the block from `          {` to `          } >> "$GITHUB_STEP_SUMMARY"` with:

```yaml
          {
            echo
            echo "**Signed \`$aab\`** — this run's artifact \`play-upload-bundle\`, versionCode $((major * 1000000 + minor * 1000 + patch))."
            echo "\`play-upload\` puts it on Play's internal track; if that job says it uploaded nothing,"
            echo "upload it by hand: Play Console → *Test and release* → the track → *Create new release*."
            echo
            echo "Until it is on a track and Play has reviewed it, phones stay on the previous version:"
            echo "\`docs/reference/ci-and-releases.md\`, *What only the owner can do*."
          } >> "$GITHUB_STEP_SUMMARY"
```

In the comment block above `android-sign`, replace the paragraph that begins `**The signed bundle goes to Google Play, by the owner's hand, and nowhere else**` with:

```yaml
  # **The signed bundle goes to Google Play and nowhere else** (decided 2026-10-07: Play is the
  # only place the Android app is published). So this job attaches nothing to the release and
  # can write nothing to the repository: what it signed leaves as the artifact
  # `play-upload-bundle`, which `play-upload` below puts on Play's internal track (since
  # 2026-10-11; by the owner's hand before that, and still when that job has no account to
  # upload with). **A release is therefore not on phones when this run ends** — it is when the
  # owner has promoted the build and Play has reviewed it.
```

- [ ] **Step 4: Add the job**

Insert after `web-deploy`'s last step (`Ask the host`) and before the comment block that opens `publish`:

```yaml
  # **The bundle, onto Google Play's internal track** (the owner's decision, 2026-10-11; "by
  # hand first, automated later" was 2026-10-07's, and the first bundle went up by hand). The
  # one step of a release that cannot be taken back — Play takes a `versionCode` once — so it
  # is the last thing before `publish`, behind all three deploys.
  #
  # **The internal track, and no further.** Internal testers get the build at once; closed
  # testing and production are the owner's click in Play Console, and the service account is
  # granted *Release apps to testing tracks* and nothing above it.
  #
  # **The service account's key, in a job of its own**, for `android-sign`'s reason: this job
  # runs no build and installs nothing. The one program the key reaches is
  # `scripts/android-release/play-upload.mjs` — Node's own `crypto` and `fetch`, no dependency,
  # which is why this is a script and not an upload action with a tree of its own.
  # `scripts/release-rule.test.mjs` holds every line.
  #
  # **With no account, or no signed bundle, it uploads nothing and ends green**, saying which
  # in the summary. **A re-run is safe**: when Play already holds this `versionCode` the script
  # says so and changes nothing.
  play-upload:
    name: android (upload to Play)
    needs: [release-please, android-sign, web-deploy]
    if: needs.release-please.outputs.release_created == 'true'
    runs-on: ubuntu-24.04
    timeout-minutes: 20
    environment: release
    # Reads the checkout and the artifact. It can write nothing here: what it changes is Play.
    permissions:
      contents: read
    steps:
      # The script. Nothing is installed.
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false

      # Told whether the key is set, never what it is — and what `android-sign` said it did.
      - name: Is there an account to upload with, and a bundle to upload
        id: account
        shell: bash
        env:
          HAS_ACCOUNT: ${{ secrets.PLAY_SERVICE_ACCOUNT_JSON != '' }}
          SIGNED: ${{ needs.android-sign.outputs.signed }}
        run: |
          set -euo pipefail
          if [ "$HAS_ACCOUNT" = true ] && [ "$SIGNED" = true ]; then
            echo "present=true" >> "$GITHUB_OUTPUT"
            exit 0
          fi
          echo "present=false" >> "$GITHUB_OUTPUT"
          {
            echo "### Google Play — nothing uploaded"
            echo
            if [ "$SIGNED" != true ]; then
              echo "This release signed no bundle (the summary of \`android (sign for Play)\` says why), so there is nothing to upload."
            else
              echo "The \`release\` environment holds no \`PLAY_SERVICE_ACCOUNT_JSON\`, so the signed bundle was not uploaded."
              echo "It is this run's artifact \`play-upload-bundle\`: upload it by hand in Play Console."
            fi
            echo
            echo "Phones stay on the previous version until a bundle is on a track."
            echo "\`docs/reference/ci-and-releases.md\`, *What only the owner can do*, has the steps."
          } >> "$GITHUB_STEP_SUMMARY"

      # For the one file Node runs here. No cache, as in the deploy jobs.
      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
        if: steps.account.outputs.present == 'true'
        with:
          node-version-file: .nvmrc
          package-manager-cache: false

      - uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8.0.1
        if: steps.account.outputs.present == 'true'
        with:
          name: play-upload-bundle
          path: aab-in

      # The only step the key reaches. The versionCode is Tauri's arithmetic on the release's
      # version, as `android-sign` printed it; the script refuses to go on if Play reads another
      # out of the bundle.
      # ⚠️ **A failure here leaves all three Workers deployed and the release a draft.**
      - name: Upload the bundle to the internal track
        if: steps.account.outputs.present == 'true'
        shell: bash
        timeout-minutes: 15
        env:
          PLAY_SERVICE_ACCOUNT_JSON: ${{ secrets.PLAY_SERVICE_ACCOUNT_JSON }}
          VERSION: ${{ needs.release-please.outputs.version }}
        run: |
          set -euo pipefail
          IFS=. read -r major minor patch <<< "$VERSION"
          node scripts/android-release/play-upload.mjs "aab-in/mtg-grimoire-$VERSION-android.aab" "$((major * 1000000 + minor * 1000 + patch))"
```

Then: change `publish`'s `needs` to `[release-please, build, android-sign, relay-deploy, share-deploy, web-deploy, play-upload]`; in its comment block add the sentence ``play-upload` ends green with the bundle on the internal track, already there, or with nothing to upload it with.``; in the header diagram change the chain's last line to

```yaml
#           relay-deploy ── share-deploy ── web-deploy ── play-upload ── publish
```

and `The four jobs that hold a secret — …` to `The five jobs that hold a secret — `android-sign`, `relay-deploy`, `share-deploy`, `web-deploy`, `play-upload` —`.

- [ ] **Step 5: Run the fence and its neighbours, and see them pass**

Run: `pnpm exec vitest run scripts/release-rule.test.mjs scripts/actions-pinned.test.mjs scripts/toolchain.test.mjs scripts/workflow-scripts.test.mjs`
Expected: PASS, all four files.

- [ ] **Step 6: Prove the fence bites**

Keep a copy (`cp .github/workflows/release.yml "$SCRATCH/release.yml"`), and for each row make the change, run `pnpm exec vitest run scripts/release-rule.test.mjs`, expect the named test red, restore the copy and `cmp` it.

| Mutation in `release.yml` | Test that must go red |
| --- | --- |
| Add `- run: npx some-upload-tool` with the `if:` to `play-upload` | `play-upload builds nothing, and runs only what is listed here` |
| Remove `&& [ "$SIGNED" = true ]` from the ask step | `asks for the account and the signed bundle…` (and the `RUNS` case) |
| Add `PLAY_SERVICE_ACCOUNT_JSON: ${{ secrets.PLAY_SERVICE_ACCOUNT_JSON }}` to the download step's `env:` | `asks for the account and the signed bundle…` |
| Change `play-upload`'s `needs` to `[release-please, android-sign]` | `has the eleven jobs…` |
| Rename the bundle in `play-upload` to `mtg-grimoire-$VERSION.aab` | `uploads the bundle `android-sign` signed…` (and the `RUNS` case) |
| Remove `play-upload` from `publish`'s `needs` | `has the eleven jobs…` |

Record the table for Task 3.

---

### Task 3: The documents

**Files:**
- Modify: `CLAUDE.md`, `.github/CLAUDE.md`, `docs/reference/ci-and-releases.md`, `docs/superpowers/specs/2026-10-07-google-play-release-design.md`, `docs/superpowers/specs/2026-10-11-release-deploys-everything-design.md`, and `docs/play/README.md` if it says the bundle is uploaded by hand.

- [ ] **Step 1: Find every sentence that says the upload is by hand**

```bash
git grep -n -i "uploaded by hand\|owner uploads\|uploads to Play Console\|Upload .* to Play Console\|manual first\|By hand first" -- ':!docs/superpowers/plans' ':!CHANGELOG.md'
```

Every hit is rewritten below or on the same terms.

- [ ] **Step 2: Root `CLAUDE.md`**

In the bullet **Deployments require explicit instruction** (as piece A left it), after `put the relay, the share Worker and the web app (`infrastructure/app-worker/`) on their addresses at a release tag`, add `, and `play-upload` puts the signed Android bundle on Google Play's internal track`. The sentence `merging the release PR is a deploy of everything` stays.

In the opening paragraph's `distributed through Google Play` — no change.

- [ ] **Step 3: `.github/CLAUDE.md`**

- In **The release rule**, replace the `android-sign` sub-bullet's `which the owner uploads to Play Console` with `which `play-upload` puts on Play's internal track (`scripts/android-release/play-upload.mjs`: Node's `crypto` and `fetch`, no dependency; a `versionCode` Play already holds ends green). Promotion past the internal track is the owner's.`
- `publish needs …`: add `play-upload`.
- **Secrets live in jobs that build nothing…**: add `play-upload` to the list of jobs and `PLAY_SERVICE_ACCOUNT_JSON` to what is asked for; say it also needs `android-sign` to have signed.
- Under **Assets & artifacts**, `The Android bundle is a workflow artifact, never a release asset.` stays.

Then `node scripts/check-claude-md.mjs`.

- [ ] **Step 4: `docs/reference/ci-and-releases.md`**

- The job table: a row for `play-upload` (needs `release-please`, `android-sign`, `web-deploy`; reads `PLAY_SERVICE_ACCOUNT_JSON`; what it runs), and `publish`'s *needs*.
- In the dated section piece A added (**"A release deploys everything (2026-10-11)"**), a subsection for the upload: the six requests; why a script and not an action; the re-run rule; what Task 1 Step 5 printed; Task 2 Step 6's table; and **what only a real release can settle** — that Play accepts a `completed` release on the internal track for this app from the API, and that the service account's permission is enough.
- In *What only the owner can do*, replace the entry that begins **After every release, the bundle is uploaded by hand** with:

```markdown
  - **The Play service account (`PLAY_SERVICE_ACCOUNT_JSON`).** So that `play-upload` can put
    each release's bundle on the internal track:
    1. In a Google Cloud project, enable the *Google Play Android Developer API*.
    2. Create a service account there, with no cloud role, and a **JSON key** for it.
    3. Play Console → *Users and permissions* → *Invite new users* → the service account's
       address → *App permissions* → MTG Grimoire → **Release apps to testing tracks**, and
       nothing above it. It cannot release to production with that.
    4. `gh secret set PLAY_SERVICE_ACCOUNT_JSON --env release --repo Msgaihede/mtg-grimoire < key.json`,
       then delete `key.json`.
    **Not verified**: no upload has been made with it. Until it is set, `play-upload` ends
    green saying it uploaded nothing, and the bundle is uploaded by hand as before — the run's
    artifact `play-upload-bundle`, Play Console → *Test and release* → the track → *Create new
    release*.
  - **Promotion is by hand, after every release**: the build lands on the internal track.
    Closed testing and production are Play Console's → *Test and release* → *Promote release*.
    Until then phones outside the internal testers stay a version behind.
```

- [ ] **Step 5: The two specs**

- `docs/superpowers/specs/2026-10-07-google-play-release-design.md` §8, the item **Uploading to Play from CI**: append `Done 2026-10-11 — `docs/superpowers/specs/2026-10-11-release-deploys-everything-design.md`, §6.` Its §2 row `Upload | By hand first…` is a record of that day's decision; leave it.
- `docs/superpowers/specs/2026-10-11-release-deploys-everything-design.md`: append `## 11. What changed in execution (piece B)` with anything Task 1 or Task 2 turned up, or `Nothing.`

- [ ] **Step 6: Sweep again**

Run Step 1's `git grep` again. Expected: every remaining hit is a dated record of the earlier decision, not a description of what a release does today.

---

### Task 4: Verify, commit, open the pull request

- [ ] **Step 1: The whole gate, once**

```bash
pnpm verify
```

Expected: exit 0. Keep the tail of its output for the pull request.

- [ ] **Step 2: One commit**

```bash
git add -A
git status --short
git commit -m "$(cat <<'EOF'
feat: a release uploads the Android bundle to Google Play

`release.yml` gains `play-upload`, the last job before `publish`: it puts the bundle
`android-sign` signed on Play's internal track through the Play Developer API.

- `scripts/android-release/play-upload.mjs` is the whole conversation, with no
  dependency: a JWT signed with node:crypto, then fetch. A versionCode Play already
  holds ends green, so a re-run is safe.
- A new secret in the `release` environment, `PLAY_SERVICE_ACCOUNT_JSON`. Without it,
  or without a signed bundle, the job uploads nothing and ends green.
- Promotion past the internal track stays the owner's.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 3: Push and open the pull request — only when the owner says to**

The body states at the top: **merging this uploads nothing by itself; the first release PR merged after it uploads that release's bundle to the internal track if `PLAY_SERVICE_ACCOUNT_JSON` is set.** Then the service-account steps only the owner does, what only a real release can settle, the mutation table and verify's tail. End it with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
