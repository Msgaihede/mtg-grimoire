// The Play upload, against a stand-in for Google: `upload` is handed its `fetch`, so every
// request it makes — the token, the edit, the bundles, the tracks, the bundle, the track, the
// commit — is read here, in order, and every refusal and every silence is one this file
// staged. Nothing here crosses a socket: Node's own `fetch` was put under the script once, by
// hand (docs/reference/ci-and-releases.md has what it sent). It runs in the suite's jsdom
// and picks no environment of its own: the one setup file (`packages/ui/test-setup.ts`)
// touches `document`, so a file that opted into Node's would fail before its first test. jsdom's
// window keeps Node's `Response` and has an `AbortSignal.timeout` of its own.
import { createVerify, generateKeyPairSync } from "node:crypto";
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import {
  accountOf,
  assertionFor,
  GOOGLE,
  hintFor,
  Misread,
  Newer,
  PACKAGE,
  Refused,
  summaryOf,
  TRACK,
  Unanswered,
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
 * Google, as far as this script knows it. `held` is the versionCodes Play already has as
 * bundles and `tracks` what its tracks hold, as Play lists them; `readsAs` what Play says it
 * read out of an uploaded bundle; `refuse` maps `METHOD path` to the `[status, body]` to answer
 * it with instead, and `fail` maps one to what the request throws with no answer at all (an
 * error, or a function of the request that makes one).
 */
function google({ held = [], tracks = [], readsAs = 43001, refuse = {}, fail = {} } = {}) {
  const calls = [];
  const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
  const send = (url, init = {}) => {
    const method = init.method ?? "GET";
    const path = url === hosts.token ? "/token" : url.replace(hosts.api, "");
    calls.push({
      method,
      path,
      headers: init.headers ?? {},
      body: init.body,
      signal: init.signal,
      redirect: init.redirect,
    });
    const thrown = fail[`${method} ${path}`];
    if (thrown) return Promise.reject(typeof thrown === "function" ? thrown(init) : thrown);
    const staged = refuse[`${method} ${path}`];
    if (staged) return Promise.resolve(new Response(staged[1], { status: staged[0] }));
    switch (`${method} ${path}`) {
      case "POST /token":
        return Promise.resolve(json({ access_token: "at-1", expires_in: 3600 }));
      case `POST ${APP}/edits`:
        return Promise.resolve(json({ id: "e1" }));
      case `GET ${APP}/edits/e1/bundles`:
        return Promise.resolve(json({ bundles: held.map((versionCode) => ({ versionCode })) }));
      case `GET ${APP}/edits/e1/tracks`:
        return Promise.resolve(json({ tracks }));
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

const UPLOAD = `POST /upload${APP}/edits/e1/bundles?uploadType=media`;
const COMMIT = `POST ${APP}/edits/e1:commit`;
/** What Node's `fetch` throws when the connection drops, and when its deadline passes. */
const dropped = () => new TypeError("fetch failed", { cause: { code: "UND_ERR_SOCKET" } });
const timedOut = () =>
  Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });

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
      `GET ${APP}/edits/e1/tracks`,
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

  // `fetch` follows a 307 or a 308 by sending the same body again, to wherever it was told:
  // the assertion, the token in its header, the bundle. No request here is ever to be moved.
  it("follows no redirect, on any request", async () => {
    const through = google();
    await run(through);
    const there = google({ held: [43001] });
    await run(there);
    const calls = [...through.calls, ...there.calls];
    expect(calls).toHaveLength(7 + 4);
    for (const call of calls) expect(call.redirect, `${call.method} ${call.path}`).toBe("error");
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

  // The discard is a courtesy: an edit that is never committed expires by itself, so a
  // `DELETE` that fails does not turn a correct "already there" red.
  it.each([
    ["is refused", { refuse: { [`DELETE ${APP}/edits/e1`]: [503, "backend error"] } }],
    ["gets no answer", { fail: { [`DELETE ${APP}/edits/e1`]: dropped() } }],
  ])("still says the versionCode is already there when the discard %s", async (_what, staged) => {
    const fake = google({ held: [43001], ...staged });
    expect(await run(fake)).toEqual({ uploaded: false, versionCode: 43001 });
    expect(fake.asked().at(-1)).toBe(`DELETE ${APP}/edits/e1`);
  });

  it("still refuses an older release, in its own words, when the discard is refused", async () => {
    const fake = google({
      held: [44000],
      refuse: { [`DELETE ${APP}/edits/e1`]: [503, "backend error"] },
    });
    const refusal = await run(fake).catch((error) => error);
    expect(refusal).toBeInstanceOf(Newer);
    expect(fake.asked().at(-1)).toBe(`DELETE ${APP}/edits/e1`);
  });

  it("reads a list with no bundles in it as holding none", async () => {
    const fake = google({ refuse: { [`GET ${APP}/edits/e1/bundles`]: [200, "{}"] } });
    expect(await run(fake)).toEqual({ uploaded: true, versionCode: 43001 });
  });

  // **An older release is refused.** A release that never reached Play — no account at the
  // time — can have its job run again after the next release uploaded: without this, the older
  // build goes onto the track over the newer one.
  it("refuses a release older than a bundle Play holds, and uploads nothing", async () => {
    const fake = google({ held: [42000, 44000] });
    const refusal = await run(fake).catch((error) => error);
    expect(refusal).toBeInstanceOf(Newer);
    expect(refusal).toMatchObject({ name: "Newer", held: 44000, versionCode: 43001 });
    expect(refusal.message).toBe(
      "Play already holds versionCode 44000, newer than this release's 43001. Nothing was uploaded.",
    );
    expect(fake.asked()).toEqual([
      "POST /token",
      `POST ${APP}/edits`,
      `GET ${APP}/edits/e1/bundles`,
      `GET ${APP}/edits/e1/tracks`,
      `DELETE ${APP}/edits/e1`,
    ]);
  });

  // A build can be on a track and missing from the list of bundles; `versionCodes` are strings there.
  it("refuses a release older than what a track holds", async () => {
    const fake = google({
      held: [42000],
      tracks: [
        { track: "internal", releases: [{ versionCodes: ["42000"], status: "completed" }] },
        { track: "production", releases: [{ versionCodes: ["41000", "44002"], status: "completed" }] },
      ],
    });
    const refusal = await run(fake).catch((error) => error);
    expect(refusal).toBeInstanceOf(Newer);
    expect(refusal).toMatchObject({ held: 44002, versionCode: 43001 });
    expect(fake.asked().at(-1)).toBe(`DELETE ${APP}/edits/e1`);
    expect(fake.asked().some((line) => line.startsWith("POST /upload"))).toBe(false);
  });

  it("uploads over lower versionCodes, as bundles and on tracks", async () => {
    const fake = google({
      held: [41000, 42000],
      tracks: [{ track: "internal", releases: [{ versionCodes: ["42000"], status: "completed" }] }],
    });
    expect(await run(fake)).toEqual({ uploaded: true, versionCode: 43001 });
    expect(fake.asked()).toHaveLength(7);
  });

  it.each([
    ["no tracks", "{}"],
    ["a track with no releases", '{"tracks":[{"track":"internal"}]}'],
    ["a release with no versionCodes", '{"tracks":[{"track":"internal","releases":[{"status":"draft"}]}]}'],
    ["versionCodes that are not numbers", '{"tracks":[{"track":"internal","releases":[{"versionCodes":["x","1e400",null]}]}]}'],
    ["a track that is nothing", '{"tracks":[null,{"track":"internal","releases":[null]}]}'],
  ])("reads %s as holding none", async (_what, body) => {
    const fake = google({ refuse: { [`GET ${APP}/edits/e1/tracks`]: [200, body] } });
    expect(await run(fake)).toEqual({ uploaded: true, versionCode: 43001 });
  });

  it("reads a bundle with no number for a versionCode as none", async () => {
    const body = '{"bundles":[{"versionCode":"x"},{},{"versionCode":9007199254740993}]}';
    const fake = google({ refuse: { [`GET ${APP}/edits/e1/bundles`]: [200, body] } });
    expect(await run(fake)).toEqual({ uploaded: true, versionCode: 43001 });
  });

  it("stops when Play reads another versionCode out of the bundle", async () => {
    const fake = google({ readsAs: 43000 });
    await expect(run(fake)).rejects.toThrow(
      "Play read versionCode 43000 out of the bundle, and this release is 43001",
    );
    await expect(run(google({ readsAs: 43000 }))).rejects.toBeInstanceOf(Misread);
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

  // **A 2xx that is not what was asked for.** A proxy's page, a body cut short, an answer with
  // the field missing: each is refused by name, and none of it is quoted — a token answer cut
  // short is a slice of a credential, and V8's own complaint about JSON quotes its source.
  it.each([
    ["nothing in it", "{}"],
    ["an empty token", '{"access_token":""}'],
    ["a token that is not text", '{"access_token":{"value":"ya29.SLICE-OF-A-CREDENTIAL"}}'],
    ["null", "null"],
  ])("stops at a token answer with %s", async (_what, body) => {
    const fake = google({ refuse: { "POST /token": [200, body] } });
    const error = await run(fake).catch((thrown) => thrown);
    expect(error.message).toBe("Google answered the token request without an access token");
    expect(fake.asked()).toEqual(["POST /token"]);
  });

  // Node's `fetch` quotes a header it will not send ("Headers.append: "Bearer …" is an
  // invalid header value"), so a token no header can carry never gets as far as one.
  it("stops at a token no header can carry, without repeating it", async () => {
    const body = JSON.stringify({ access_token: "ya29.SLICE-OF\nA-CREDENTIAL" });
    const fake = google({ refuse: { "POST /token": [200, body] } });
    const error = await run(fake).catch((thrown) => thrown);
    expect(error.message).toBe("Google answered the token request with an access token no header can carry");
    expect(fake.asked()).toEqual(["POST /token"]);
  });

  it.each([
    ["a page", "<!DOCTYPE html><html><body>the proxy says ya29.SLICE-OF-A-CREDENTIAL</body></html>"],
    ["JSON cut short", '{"access_token":"ya29.SLICE-OF-A-CREDENTIAL","expi'],
  ])("stops at a token answer that is %s, quoting none of it", async (_what, body) => {
    const fake = google({ refuse: { "POST /token": [200, body] } });
    const error = await run(fake).catch((thrown) => thrown);
    expect(error.message).toBe(
      `Google's answer to "get a token" was not JSON (200, ${body.length} characters)`,
    );
    expect(error.message).not.toMatch(/ya29|SLICE|proxy|html|access_token/);
    expect(error.cause).toBeUndefined();
    expect(fake.asked()).toEqual(["POST /token"]);
  });

  it.each(["{}", '{"id":""}', '{"id":7}', "null"])("stops at an edit opened as %s", async (body) => {
    const fake = google({ refuse: { [`POST ${APP}/edits`]: [200, body] } });
    const error = await run(fake).catch((thrown) => thrown);
    expect(error.message).toBe("Google opened an edit without an id");
    expect(fake.asked()).toEqual(["POST /token", `POST ${APP}/edits`]);
  });

  // **No answer at all**: `fetch` throws "fetch failed" for a dropped connection and
  // "The operation was aborted due to timeout" for a deadline, and neither says where.
  it.each([
    ["upload the bundle", UPLOAD, 600],
    ["commit the edit", COMMIT, 120],
  ])("names the step when it gets no answer trying to %s", async (step, route, seconds) => {
    const lost = await run(google({ fail: { [route]: dropped() } })).catch((error) => error);
    expect(lost).toBeInstanceOf(Unanswered);
    expect(lost).toMatchObject({ name: "Unanswered", step });
    expect(lost.message).toBe(
      `No answer from Google while trying to ${step}: fetch failed (UND_ERR_SOCKET)`,
    );
    // What `fetch` threw is not carried along: a cause is printed by whatever prints an error.
    expect(lost.cause).toBeUndefined();

    const late = await run(google({ fail: { [route]: timedOut() } })).catch((error) => error);
    expect(late).toBeInstanceOf(Unanswered);
    expect(late.step).toBe(step);
    expect(late.message).toBe(
      `No answer from Google while trying to ${step}: nothing within ${seconds} s`,
    );
    expect(late.cause).toBeUndefined();
  });

  it("names the step when an answer breaks off while it is read, or is aborted", async () => {
    const half = (thrown) => ({
      ok: true,
      status: 200,
      text: () => Promise.reject(thrown),
    });
    const cut = google();
    const send = (url, init) =>
      url.endsWith("/edits") ? Promise.resolve(half(new TypeError("terminated"))) : cut.send(url, init);
    const lost = await upload({ account, bundle, versionCode: 43001, hosts, send, nowSeconds: 1 }).catch(
      (error) => error,
    );
    expect(lost).toBeInstanceOf(Unanswered);
    expect(lost.message).toBe("No answer from Google while trying to open an edit: terminated");

    const aborted = Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
    const late = await run(google({ fail: { "POST /token": aborted } })).catch((error) => error);
    expect(late.message).toBe("No answer from Google while trying to get a token: nothing within 30 s");
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

// What the job prints and appends to its summary: the last thing a failed release's reader
// is told to do, so it has to be advice that is sound for what happened.
describe("summaryOf", () => {
  const FAILED = "### Google Play — the upload failed";
  const BY_HAND =
    "The signed bundle is this run's artifact `play-upload-bundle`; it can be uploaded by hand.";
  const MAY_HAVE_LANDED =
    "The commit may have landed. Re-run this job: it says the bundle is already there if it did, and uploads again if it did not. Do not upload by hand first.";
  const failing = (staged, versionCode = 43001) =>
    run(google(staged), versionCode).then(
      () => expect.unreachable("the stand-in was staged to fail"),
      (error) => summaryOf({ versionCode, error }),
    );

  it("says the bundle is on the internal track, and whose click the next one is", () => {
    expect(summaryOf({ versionCode: 43001, result: { uploaded: true, versionCode: 43001 } })).toEqual([
      "### Google Play — versionCode 43001 is on the internal track",
      "",
      "Internal testers get it from Play at once. **Promotion to closed testing or production is yours**, in Play Console → *Test and release*.",
    ]);
  });

  it("says the versionCode was already there", () => {
    expect(summaryOf({ versionCode: 43001, result: { uploaded: false, versionCode: 43001 } })).toEqual([
      "### Google Play — versionCode 43001 was already there",
      "",
      "Play already holds a bundle with this versionCode, so nothing was uploaded and no track was changed.",
    ]);
  });

  it("follows a refusal with its hint, then with the bundle to upload by hand", async () => {
    const body = "Only releases with status draft may be created on draft app.";
    const lines = await failing({ refuse: { [`PUT ${APP}/edits/e1/tracks/internal`]: [400, body] } });
    expect(lines).toEqual([
      FAILED,
      "",
      `Google refused to put the bundle on the internal track: 400 ${body}`,
      "",
      hintFor(new Refused("put the bundle on the internal track", 400, body)),
      "",
      BY_HAND,
    ]);
    expect(lines[4]).toMatch(/Roll a release out on the internal track by hand once/);
  });

  it("adds no hint to a refusal it does not know, or to a failure that is not a refusal", async () => {
    expect(await failing({ refuse: { [UPLOAD]: [500, "backend error"] } })).toEqual([
      FAILED,
      "",
      "Google refused to upload the bundle: 500 backend error",
      "",
      BY_HAND,
    ]);
    expect(await failing({ fail: { [UPLOAD]: timedOut() } })).toEqual([
      FAILED,
      "",
      "No answer from Google while trying to upload the bundle: nothing within 600 s",
      "",
      BY_HAND,
    ]);
    expect(summaryOf({ versionCode: 43001, error: new Error("PLAY_SERVICE_ACCOUNT_JSON is not JSON") })).toEqual([
      FAILED,
      "",
      "PLAY_SERVICE_ACCOUNT_JSON is not JSON",
      "",
      BY_HAND,
    ]);
  });

  // Uploading the older bundle by hand is the thing that was refused.
  it("does not offer the bundle by hand after refusing an older release", async () => {
    expect(await failing({ held: [44000] })).toEqual([
      FAILED,
      "",
      "Play already holds versionCode 44000, newer than this release's 43001. Nothing was uploaded.",
    ]);
  });

  // The bundle is not this release's: by hand it would be as wrong as it was here.
  it("does not offer the bundle by hand when Play read another versionCode out of it", async () => {
    expect(await failing({ readsAs: 43000 })).toEqual([
      FAILED,
      "",
      "Play read versionCode 43000 out of the bundle, and this release is 43001. Nothing was put on a track.",
    ]);
  });

  // Play would refuse the same bundle by hand, in the same words.
  it("does not offer the bundle by hand when Play has used the versionCode", async () => {
    const body = '{"error":{"code":403,"message":"Version code 43001 has already been used.","status":"PERMISSION_DENIED"}}';
    const lines = await failing({ refuse: { [UPLOAD]: [403, body] } });
    expect(lines).toEqual([
      FAILED,
      "",
      `Google refused to upload the bundle: 403 ${body}`,
      "",
      hintFor(new Refused("upload the bundle", 403, body)),
    ]);
    expect(lines.at(-1)).toMatch(/the next release's higher versionCode is the way forward/);
  });

  // **The one outcome nobody knows**: the commit was sent, and what came back was nothing, or
  // a server's own failure. A second upload by hand would be refused if it landed.
  it.each([
    ["gets no answer", { fail: { [COMMIT]: dropped() } }, "No answer from Google while trying to commit the edit: fetch failed (UND_ERR_SOCKET)"],
    ["runs out of time", { fail: { [COMMIT]: timedOut() } }, "No answer from Google while trying to commit the edit: nothing within 120 s"],
    ["is answered 503", { refuse: { [COMMIT]: [503, "backend error"] } }, "Google refused to commit the edit: 503 backend error"],
  ])("says the commit may have landed when it %s", async (_what, staged, message) => {
    expect(await failing(staged)).toEqual([FAILED, "", message, "", MAY_HAVE_LANDED]);
  });

  it("offers the bundle by hand when the commit was refused outright", async () => {
    const body = "Please set the query parameter changesNotSentForReview to true.";
    const lines = await failing({ refuse: { [COMMIT]: [400, body] } });
    expect(lines.at(-1)).toBe(BY_HAND);
    expect(lines).not.toContain(MAY_HAVE_LANDED);
    expect(lines[4]).toMatch(/Publishing overview/);
  });

  // A proxy's error page is not a summary. The refusal keeps all of it, so a hint whose
  // words sit past the cut is still found.
  it("prints the first 2,000 characters of a refusal's body, and says how many it left out", async () => {
    const body = `${"x".repeat(2_000)}${"y".repeat(487)}invalid_grant`;
    const lines = await failing({ refuse: { "POST /token": [400, body] } });
    expect(lines[2]).toBe(
      `Google refused to get a token: 400 ${"x".repeat(2_000)}… (500 more characters)`,
    );
    expect(lines[4]).toMatch(/Make a new JSON key/);
    const whole = await failing({ refuse: { "POST /token": [400, "x".repeat(2_000)] } });
    expect(whole[2]).toBe(`Google refused to get a token: 400 ${"x".repeat(2_000)}`);
  });
});

// **The rule that matters most, over everything this file can stage**: whatever goes wrong,
// and wherever, nothing the job would print holds the key, the assertion made with it or the
// token it bought. Read three ways — the error's message, the summary's lines, and the error as
// Node prints one that nobody caught (its stack, its own fields, and its `cause` if it had one).
describe("what a failure can print", () => {
  const SLICE = "ya29.SLICE-OF-A-CREDENTIAL";
  const assertion = assertionFor(account, 1_800_000_000);
  const SECRETS = [
    privateKey,
    ...privateKey.split("\n").filter((line) => line !== "" && !line.startsWith("-----")),
    assertion,
    ...assertion.split(".").slice(1),
    "at-1",
    // The start of it is enough: V8 quotes the first ten characters of JSON it cannot read.
    SLICE.slice(0, 4),
  ];
  const ROUTES = [
    "POST /token",
    `POST ${APP}/edits`,
    `GET ${APP}/edits/e1/bundles`,
    `GET ${APP}/edits/e1/tracks`,
    UPLOAD,
    `PUT ${APP}/edits/e1/tracks/internal`,
    COMMIT,
  ];
  const STATUSES = [400, 401, 403, 404, 429, 500, 503];
  const wording = (status) =>
    JSON.stringify({ error: { code: status, message: "The caller does not have permission", status: "PERMISSION_DENIED" } });
  // A transport that keeps the whole request beside its failure, as a careless one might:
  // the token's header and the assertion's body are in reach of whatever prints the cause.
  const droppedWith = (init) =>
    new TypeError("fetch failed", { cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET", request: init }) });

  const STAGED = [
    ...ROUTES.flatMap((route) =>
      STATUSES.map((status) => [`${status} to ${route}`, { refuse: { [route]: [status, wording(status)] } }]),
    ),
    ...ROUTES.flatMap((route) => [
      [`a dropped ${route}`, { fail: { [route]: droppedWith } }],
      [`a late ${route}`, { fail: { [route]: timedOut } }],
    ]),
    ["a token answer with no token", { refuse: { "POST /token": [200, JSON.stringify({ id_token: SLICE })] } }],
    ["a token answer that is a page", { refuse: { "POST /token": [200, `<html>${SLICE}</html>`] } }],
    ["a token answer that is the bare token", { refuse: { "POST /token": [200, SLICE] } }],
    ["a token answer cut short", { refuse: { "POST /token": [200, `{"access_token":"${SLICE}","expi`] } }],
    ["a token no header can carry", { refuse: { "POST /token": [200, JSON.stringify({ access_token: `${SLICE}\n` })] } }],
    ["an edit with no id", { refuse: { [`POST ${APP}/edits`]: [200, "{}"] } }],
    ["an answer cut short after the token", { refuse: { [COMMIT]: [200, '{"id":"e1"'] } }],
    ["an older release", { held: [44000] }],
    ["an older release whose discard is dropped", { held: [44000], fail: { [`DELETE ${APP}/edits/e1`]: droppedWith } }],
    ["another versionCode in the bundle", { readsAs: 43000 }],
  ];

  it("stages every step's refusal and every step's silence", () => {
    expect(STAGED).toHaveLength(ROUTES.length * STATUSES.length + ROUTES.length * 2 + 10);
  });

  it.each(STAGED)("holds no key, assertion or token after %s", async (_what, staged) => {
    const fake = google(staged);
    const error = await run(fake).then(
      () => expect.unreachable("the stand-in was staged to fail"),
      (thrown) => thrown,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error.cause === undefined, "no cause is attached").toBe(true);
    const printed = [error.message, ...summaryOf({ versionCode: 43001, error }), inspect(error)].join("\n");
    // Asked as yes or no, and named by its place in the list: a failure here prints neither
    // the text that was searched nor the secret that was found in it.
    SECRETS.forEach((secret, index) => {
      expect(printed.includes(secret), `secret ${index} of ${SECRETS.length}`).toBe(false);
    });
    // …and the stand-in did see the assertion, so this read a conversation that carried one.
    const sent = fake.calls.map((call) => String(call.body ?? "")).join("\n");
    expect(sent.includes(encodeURIComponent(assertion)), "the assertion was sent").toBe(true);
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

  // Play answers a versionCode it has seen before with a 403, and in Google's errors a 403
  // carries `PERMISSION_DENIED` whatever it is about: the wording is read before the status.
  it("says a versionCode Play has used is used, and not that a permission is missing", () => {
    const body =
      '{"error":{"code":403,"message":"Version code 43001 has already been used.","status":"PERMISSION_DENIED"}}';
    const hint = hintFor(refused("upload the bundle", 403, body));
    expect(hint).toMatch(/somewhere the bundle list does not show/);
    expect(hint).toMatch(/the next release's higher versionCode is the way forward/);
    expect(hint).not.toMatch(/Users and permissions/);
  });

  // A 401 or a 403 means "the account may not" only where nothing else can be meant: asking
  // for the token and opening the edit. Later, a status alone says nothing this script knows.
  it("reads a missing permission from the status only at the first two steps", () => {
    expect(hintFor(refused("upload the bundle", 403, "backend said no"))).toBeNull();
    expect(hintFor(refused("commit the edit", 401, "backend said no"))).toBeNull();
    expect(hintFor(refused("open an edit", 403, "backend said no"))).toMatch(
      /Release apps to testing tracks/,
    );
    expect(hintFor(refused("get a token", 401, "backend said no"))).toMatch(
      /Release apps to testing tracks/,
    );
  });

  it("reads a missing permission from Google's wording at any step", () => {
    for (const body of [
      '{"error":{"status":"PERMISSION_DENIED"}}',
      "The caller does not have permission",
      "Google Play Android Developer API has not been used in project 1234 before or it is disabled.",
    ]) {
      expect(hintFor(refused("upload the bundle", 403, body)), body).toMatch(
        /Google Play Android Developer API/,
      );
    }
  });

  it("says what an app Play does not know for this account means", () => {
    const hint = hintFor(refused("open an edit", 404, '{"error":{"code":404,"message":"Package not found: com.mtggrimoire.app."}}'));
    expect(hint).toBe(
      "Play does not know com.mtggrimoire.app for this account: the service account has not been given the app in Play Console yet (a new permission can take a while to take effect), or the app is under another developer account.",
    );
    // Only there: a 404 anywhere later is an edit that expired, or a path this script got wrong.
    expect(hintFor(refused("commit the edit", 404, "Edit not found"))).toBeNull();
  });
});
