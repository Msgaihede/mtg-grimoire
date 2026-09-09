import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeEnvOver, type Row, type Tables } from "../../relay/src/fakeD1";
import { mint } from "../../relay/src/token";
import worker, { type Env } from "./index";

/**
 * The blob store, the two public routes, and the shell page — driven through `worker.fetch` for
 * `shares.test.ts`'s reason: **which side of the bearer gate a route stands on is half of what
 * this Worker is**, and a suite that called `handleUpload` and `handleShell` directly would pass
 * unchanged with the gate deleted. The whole entitlement asymmetry is that `PUT` is gated and
 * `GET /s/…` is not, and only a request through the router can show it.
 *
 * **The R2 fake counts its operations rather than merely storing bytes.** Two of the guarantees
 * here are about *how many* times storage is touched — the edge cache is in front of the blob so
 * a warm view costs no R2 read, and a republish of unchanged bytes must not delete the object it
 * has just written — and a `Map` alone cannot answer either.
 *
 * ⚠️ **`fakeD1` enforces nothing about `shares`.** Its `UNIQUE_NOT_NULL` has no row for the table
 * and its `PRIMARY_KEY` entry only matters to `ON CONFLICT`, so a test whose pass depended on the
 * fake refusing a duplicate would pass vacuously. Nothing below relies on that: every assertion
 * here is about a value this Worker wrote or a response it built.
 */

const KEY = "test-signing-key";

/** Eight megabytes, spelled as `env.ts` spells it — the assertions read the number from the
 * refusal's own sentence rather than from the binding, so this is only used to build a body. */
const CAP = 8 * 1024 * 1024;

interface Fake {
  env: Env;
  /** The tables `fakeEnvOver` is holding, so a test can assert on `object_key` directly. */
  tables: Tables;
  r2: {
    store: Map<string, Uint8Array>;
    reads: number;
    writes: number;
    deletes: number;
    /** Set before a `PUT` to stage an R2 outage. */
    down: boolean;
  };
}

function bytesOf(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new Error("the R2 fake was handed something it does not model");
}

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function shareEnv(tables: Partial<Tables> = {}): Fake {
  const r2: Fake["r2"] = { store: new Map(), reads: 0, writes: 0, deletes: 0, down: false };
  const all = {
    entitlements: [
      {
        subject: "sub-0",
        source: "patreon",
        external_id: "e0",
        status: "active",
        grace_until: null,
        group_id: "g1",
        refresh_secret: "s0",
        patreon_refresh: null,
        created_at: 0,
        checked_at: 0,
        group_epoch: null,
        group_auth: null,
      },
    ],
    shares: [],
    ...tables,
  } as Tables;
  const base = fakeEnvOver(all);
  const env = {
    ...base,
    RELAY_HMAC_KEY: KEY,
    SHARE_BASE: "https://share.example",
    SHARES: {
      put: (key: string, value: unknown) => {
        if (r2.down) return Promise.reject(new Error("R2 is unreachable"));
        r2.writes += 1;
        r2.store.set(key, bytesOf(value));
        return Promise.resolve({});
      },
      get: (key: string) => {
        r2.reads += 1;
        const stored = r2.store.get(key);
        return Promise.resolve(
          stored === undefined ? null : { body: streamOf(stored), size: stored.byteLength },
        );
      },
      delete: (key: string) => {
        r2.deletes += 1;
        r2.store.delete(key);
        return Promise.resolve();
      },
    },
  } as unknown as Env;
  return { env, tables: all, r2 };
}

/**
 * A stand-in for `caches.default`, which does not exist in jsdom.
 *
 * It stores **bytes** rather than the `Response` it was handed, which is what a real cache does
 * and what keeps the fake honest: a fake that kept the object and cloned it on the way out would
 * hide a handler that returned a body it had already consumed.
 *
 * ⚠️ **It is installed for every test in this file, and that is a fix rather than a
 * convenience.** It used to be opt-in, and exactly one test opted in — so *"answers 410 for a
 * revoked share"* was green because the setup had no cache in it, while the shipped Worker
 * checked the cache **before** it read `state` and would have gone on serving a withdrawn
 * snapshot for a year. A guarantee asserted with the mechanism that breaks it absent is not
 * asserted. The default is therefore the production shape, and a test that wants the cache gone
 * has to say so.
 */
function fakeCache(): { entries: Map<string, { body: Uint8Array; init: ResponseInit }> } & {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
} {
  const entries = new Map<string, { body: Uint8Array; init: ResponseInit }>();
  return {
    entries,
    async match(request) {
      const hit = entries.get(request.url);
      return hit === undefined ? undefined : new Response(hit.body, hit.init);
    },
    async put(request, response) {
      entries.set(request.url, {
        body: new Uint8Array(await response.arrayBuffer()),
        init: {
          status: response.status,
          headers: Object.fromEntries(response.headers.entries()),
        },
      });
    },
  };
}

beforeEach(() => {
  vi.stubGlobal("caches", { default: fakeCache() });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function token(group = "g1", exp = Date.now() + 60_000): Promise<string> {
  return mint({ sub: "sub-0", grp: group, exp }, KEY);
}

const META = {
  folderUid: "uid-1",
  title: "Trade binder",
  ownerName: "Giradeli",
  cardCount: 412,
  totalValue: 1.2,
  currency: "USD",
  marketplace: "tcgplayer",
  fields: ["condition", "lang", "value"],
};

function post(group: string, bearer: string, body: unknown): Request {
  return new Request(`https://share.example/g/${group}/share`, {
    method: "POST",
    headers: { authorization: `Bearer ${bearer}` },
    body: JSON.stringify(body),
  });
}

function put(group: string, bearer: string | null, id: string, body: BodyInit): Request {
  return new Request(`https://share.example/g/${group}/share/${id}`, {
    method: "PUT",
    headers: bearer === null ? {} : { authorization: `Bearer ${bearer}` },
    body,
  });
}

/** Bytes that begin with gzip's two magic bytes, which is all this Worker ever inspects. */
function gz(payload: string): Uint8Array {
  const tail = new TextEncoder().encode(payload);
  const bytes = new Uint8Array(tail.byteLength + 2);
  bytes[0] = 0x1f;
  bytes[1] = 0x8b;
  bytes.set(tail, 2);
  return bytes;
}

/** Publish metadata and answer the id, so a test that is about the blob can get to one. */
async function publish(fake: Fake, meta: unknown = META): Promise<string> {
  const res = await worker.fetch(post("g1", await token(), meta), fake.env);
  expect(res.status).toBe(200);
  return ((await res.json()) as { id: string }).id;
}

async function upload(fake: Fake, id: string, body: Uint8Array): Promise<string> {
  const res = await worker.fetch(put("g1", await token(), id, body), fake.env);
  expect(res.status, await res.clone().text()).toBe(200);
  return ((await res.json()) as { hash: string }).hash;
}

function shell(id: string): Request {
  return new Request(`https://share.example/s/${id}`);
}

function snapshot(id: string, hash: string): Request {
  return new Request(`https://share.example/s/${id}/${hash}.json.gz`);
}

/** One `shares` row, for the states only the daily lapse pass can put a share into. */
function shareRow(overrides: Partial<Row> = {}): Row {
  return {
    id: "LAPSEDLAPSEDLAPS",
    group_id: "g1",
    folder_uid: "uid-9",
    title: "Old binder",
    owner_name: "Giradeli",
    card_count: 5,
    total_value: null,
    currency: null,
    marketplace: null,
    fields: "[]",
    object_key: null,
    bytes: null,
    state: "lapsed",
    created_at: 0,
    updated_at: 0,
    ...overrides,
  };
}

describe("PUT /g/{group}/share/{id}", () => {
  it("stores a blob and only then points the row at it", async () => {
    const fake = shareEnv();
    const id = await publish(fake);

    // **`object_key` is NULL in between**, which is the whole of what makes the two-step safe:
    // a publish that dies here leaves a row with no snapshot rather than a row pointing at one
    // that was never written.
    expect(fake.tables.shares[0].object_key).toBeNull();
    expect(fake.tables.shares[0].bytes).toBeNull();

    const body = gz("snapshot one");
    const hash = await upload(fake, id, body);
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
    expect(fake.tables.shares[0].object_key).toBe(`shares/${id}/${hash}.json.gz`);
    expect(fake.tables.shares[0].bytes).toBe(body.byteLength);
    expect(fake.r2.store.get(`shares/${id}/${hash}.json.gz`)).toEqual(body);
  });

  it("names the object after the SHA-256 of the bytes it was handed", async () => {
    // The hash is read back from an independent digest rather than from the answer's own field,
    // which would be green for any string this Worker chose to return.
    const fake = shareEnv();
    const id = await publish(fake);
    const body = gz("snapshot one");
    const digest = await crypto.subtle.digest("SHA-256", body);
    const expected = [...new Uint8Array(digest)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
      .slice(0, 16);

    expect(await upload(fake, id, body)).toBe(expected);
  });

  it("leaves the previous snapshot serving when the upload fails", async () => {
    const fake = shareEnv();
    const id = await publish(fake);
    const first = await upload(fake, id, gz("snapshot one"));

    fake.r2.down = true;
    await expect(
      worker.fetch(put("g1", await token(), id, gz("snapshot two")), fake.env),
    ).rejects.toThrow(/unreachable/);

    // The row never moved, the old object is still there, and the link a viewer holds still
    // resolves. That is what the two-step is for.
    expect(fake.tables.shares[0].object_key).toBe(`shares/${id}/${first}.json.gz`);
    expect((await worker.fetch(snapshot(id, first), fake.env)).status).toBe(200);
  });

  it("deletes the superseded object after the row has moved to the new one", async () => {
    const fake = shareEnv();
    const id = await publish(fake);
    const first = await upload(fake, id, gz("snapshot one"));
    const second = await upload(fake, id, gz("snapshot two"));

    expect(second).not.toBe(first);
    expect(fake.r2.store.has(`shares/${id}/${first}.json.gz`)).toBe(false);
    expect(fake.r2.store.has(`shares/${id}/${second}.json.gz`)).toBe(true);
    expect(fake.tables.shares[0].object_key).toBe(`shares/${id}/${second}.json.gz`);
  });

  it("does not delete the object it has just written when the bytes are unchanged", async () => {
    // ⚠️ A republish of an unchanged collection is content-addressed to the **same** key, so a
    // delete-the-previous that did not compare the two keys would erase the live snapshot and
    // leave every link 404ing — with the D1 row still pointing confidently at it.
    const fake = shareEnv();
    const id = await publish(fake);
    const body = gz("snapshot one");
    const first = await upload(fake, id, body);
    const again = await upload(fake, id, body);

    expect(again).toBe(first);
    expect(fake.r2.deletes).toBe(0);
    expect(fake.r2.store.has(`shares/${id}/${first}.json.gz`)).toBe(true);
    expect((await worker.fetch(snapshot(id, first), fake.env)).status).toBe(200);
  });

  it("refuses a blob over the cap and names the size", async () => {
    const fake = shareEnv();
    const id = await publish(fake);
    const body = gz("x".repeat(CAP));
    const res = await worker.fetch(put("g1", await token(), id, body), fake.env);

    expect(res.status).toBe(413);
    const refusal = (await res.json()) as { error: string; code: string };
    expect(refusal.error).toContain(String(body.byteLength));
    expect(refusal.error).toContain("8388608");
    expect(refusal.code).toBe("blob_limit");
    // Refused rather than truncated: nothing was stored and the row still has no snapshot.
    expect(fake.r2.writes).toBe(0);
    expect(fake.tables.shares[0].object_key).toBeNull();
  });

  it("refuses a declared length over the cap without reading the body", async () => {
    // The cheap check first, `handleRotate`'s order: a `content-length` past the cap is a fact
    // about the headers, and reading eight megabytes to reach the same answer is the cost this
    // avoids. The lying small one is caught by the running count above, which is why both exist.
    const fake = shareEnv();
    const id = await publish(fake);
    const request = new Request(`https://share.example/g/g1/share/${id}`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${await token()}`,
        "content-length": String(CAP + 1),
      },
      body: gz("small"),
    });

    const res = await worker.fetch(request, fake.env);
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: string }).error).toContain(String(CAP + 1));
    expect(request.bodyUsed).toBe(false);
  });

  it("refuses a body that is not gzip", async () => {
    // The public route serves this back with `content-encoding: gzip` nailed on, so a plain JSON
    // body would reach every viewer as a decoding error rather than as a collection.
    const fake = shareEnv();
    const id = await publish(fake);
    const res = await worker.fetch(
      put("g1", await token(), id, new TextEncoder().encode('{"v":1}')),
      fake.env,
    );
    expect(res.status).toBe(400);
    expect(fake.r2.writes).toBe(0);
  });

  it("is gated by the same bearer as every other write", async () => {
    const fake = shareEnv();
    const id = await publish(fake);

    expect((await worker.fetch(put("g1", null, id, gz("x")), fake.env)).status).toBe(401);
    expect(
      (await worker.fetch(put("g1", await token("g2"), id, gz("x")), fake.env)).status,
    ).toBe(401);
    expect(
      (await worker.fetch(put("g1", await token("g1", Date.now() - 1), id, gz("x")), fake.env))
        .status,
    ).toBe(401);
    expect(fake.r2.writes).toBe(0);
  });

  it("refuses to upload into another group's share, and into a revoked one", async () => {
    const fake = shareEnv();
    const id = await publish(fake);

    // A share id is a *public* string. Without `AND group_id = ?` any entitled caller could
    // overwrite anybody's binder with their own bytes.
    const wrongGroup = await worker.fetch(put("g2", await token("g2"), id, gz("x")), fake.env);
    expect(wrongGroup.status).toBe(404);

    await worker.fetch(
      new Request(`https://share.example/g/g1/share/${id}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${await token()}` },
      }),
      fake.env,
    );
    const revoked = await worker.fetch(put("g1", await token(), id, gz("x")), fake.env);
    expect(revoked.status).toBe(404);
    expect(fake.r2.writes).toBe(0);
  });

  it("still answers 405 with both methods when the path takes an id", async () => {
    const fake = shareEnv();
    const id = await publish(fake);
    const res = await worker.fetch(
      new Request(`https://share.example/g/g1/share/${id}`, {
        method: "POST",
        headers: { authorization: `Bearer ${await token()}` },
        body: "{}",
      }),
      fake.env,
    );
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("PUT, DELETE");
  });
});

describe("GET /s/{id}/{hash}.json.gz", () => {
  it("serves the snapshot immutably at a content-addressed path", async () => {
    const fake = shareEnv();
    const id = await publish(fake);
    const body = gz("snapshot one");
    const hash = await upload(fake, id, body);

    const res = await worker.fetch(snapshot(id, hash), fake.env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("content-encoding")).toBe("gzip");
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(body);
  });

  it("needs no bearer at all — the link is the whole capability", async () => {
    const fake = shareEnv();
    const id = await publish(fake);
    const hash = await upload(fake, id, gz("snapshot one"));
    const res = await worker.fetch(snapshot(id, hash), fake.env);
    expect(res.status).toBe(200);
  });

  it("costs no R2 read on a warm view", async () => {
    // `caches.default` in front of R2 is what keeps a share that goes viral off the account's
    // storage budget; the request budget is spec §7.1's problem and nothing here can fix it.
    const fake = shareEnv();
    const id = await publish(fake);
    const hash = await upload(fake, id, gz("snapshot one"));

    const cold = await worker.fetch(snapshot(id, hash), fake.env);
    expect(cold.status).toBe(200);
    expect(fake.r2.reads).toBe(1);

    const warm = await worker.fetch(snapshot(id, hash), fake.env);
    expect(warm.status).toBe(200);
    expect(new Uint8Array(await warm.arrayBuffer())).toEqual(gz("snapshot one"));
    expect(fake.r2.reads).toBe(1);
  });

  it("answers 404 for a hash that is not the one the row is serving", async () => {
    // ⚠️ **The stray object has to actually be in R2**, or this proves nothing: a hash nobody
    // ever stored 404s on the storage miss whether or not the row is consulted, and the guard
    // that matters — *the row decides which object may be served* — would be untested. An
    // orphan is a real state: the superseded object is deleted on a best-effort basis after the
    // row moves, and a delete that failed leaves exactly this.
    const fake = shareEnv();
    const id = await publish(fake);
    await upload(fake, id, gz("snapshot one"));
    const orphan = "0123456789abcdef";
    fake.r2.store.set(`shares/${id}/${orphan}.json.gz`, gz("a snapshot nobody is serving"));

    const res = await worker.fetch(snapshot(id, orphan), fake.env);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("nobody is serving");
  });

  it("answers 410 for a revoked share rather than serving its bytes", async () => {
    // ⚠️ **The first view is what makes this test mean anything.** It warms the edge cache, and
    // a lookup that sat in front of the `state` read would then answer those bytes to every
    // later viewer for the full year the `immutable` header claims — a withdrawn snapshot served
    // by this Worker's own cache, to a *new* stranger, while D1 says the share is gone. Revoking
    // cannot evict it: the URL is content-addressed and the lapse path beside it is Task 6's
    // bulk cron, which will not be deleting anything per object. So the cache goes **behind**
    // the row read, and this test is the fence.
    const fake = shareEnv();
    const id = await publish(fake);
    const hash = await upload(fake, id, gz("snapshot one"));
    expect((await worker.fetch(snapshot(id, hash), fake.env)).status).toBe(200);

    await worker.fetch(
      new Request(`https://share.example/g/g1/share/${id}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${await token()}` },
      }),
      fake.env,
    );

    const res = await worker.fetch(snapshot(id, hash), fake.env);
    expect(res.status).toBe(410);
    expect(await res.text()).not.toContain("snapshot one");
  });

  it("answers 410 for a share that lapsed after the cache was warmed", async () => {
    // The half a `cache.delete` on revoke could never have covered: the lapse is written by the
    // daily pass over every share of a subject at once (spec §6), and it darkens the link by
    // moving a column rather than by touching R2 or the cache.
    const fake = shareEnv();
    const id = await publish(fake);
    const hash = await upload(fake, id, gz("snapshot one"));
    expect((await worker.fetch(snapshot(id, hash), fake.env)).status).toBe(200);

    fake.tables.shares[0].state = "lapsed";

    const res = await worker.fetch(snapshot(id, hash), fake.env);
    expect(res.status).toBe(410);
    expect(await res.text()).not.toContain("snapshot one");
  });

  it("answers a HEAD with the headers and no body", async () => {
    // A link checker or a `curl -I` on the URL whose whole purpose is being unfurled.
    const fake = shareEnv();
    const id = await publish(fake);
    const hash = await upload(fake, id, gz("snapshot one"));

    const res = await worker.fetch(
      new Request(`https://share.example/s/${id}/${hash}.json.gz`, { method: "HEAD" }),
      fake.env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(await res.arrayBuffer()).toEqual(new ArrayBuffer(0));
  });
});

describe("GET /s/{id}", () => {
  it("renders a shell carrying the owner, the title and the count in its OpenGraph tags", async () => {
    const fake = shareEnv();
    const id = await publish(fake);
    const hash = await upload(fake, id, gz("snapshot one"));

    const res = await worker.fetch(shell(id), fake.env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");

    const html = await res.text();
    // **The one thing plaintext storage bought.** If these ever go, decision 2 has no payoff.
    expect(html).toContain('property="og:title"');
    expect(html).toContain('property="og:description"');
    expect(html).toContain('property="og:url"');
    expect(html).toContain('property="og:type"');
    expect(html).toContain("Giradeli");
    expect(html).toContain("Trade binder");
    expect(html).toContain("412 cards");
    expect(html).toContain(`https://share.example/s/${id}`);
    // A share is unlisted. A search engine indexing it would make "anyone with the link" mean
    // rather more than the UI says it does.
    expect(html).toContain('<meta name="robots" content="noindex">');
    // The viewer reads this href rather than spending a second Worker request to learn the hash
    // the response already holds.
    expect(html).toContain(
      `<link id="snapshot" rel="preload" as="fetch" crossorigin href="/s/${id}/${hash}.json.gz">`,
    );
    expect(html).toContain('<div id="root"></div>');
    expect(html).toContain('<script type="module" src="/assets/share.js"></script>');
  });

  it("escapes a title and an owner's name that contain markup", async () => {
    // `claim.ts:1112` warns in words: there is no template engine standing between this string
    // and the browser, and both of these are typed by a reader.
    const fake = shareEnv();
    const id = await publish(fake, {
      ...META,
      title: `<script>alert("xss")</script>`,
      ownerName: `Gira" onload="evil()`,
    });
    await upload(fake, id, gz("snapshot one"));

    const html = await (await worker.fetch(shell(id), fake.env)).text();
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain('onload="evil()');
    expect(html).toContain("&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;");
    expect(html).toContain("Gira&quot; onload=&quot;evil()");
    // The only script tag on the page is the shell's own.
    expect(html.match(/<script/g)).toHaveLength(1);
  });

  it("says a share is not ready yet rather than rendering a broken viewer", async () => {
    // The state a publish that died between its two steps leaves behind: metadata posted, blob
    // never uploaded. There is no href to inline, so there must be no `<link>` either.
    const fake = shareEnv();
    const id = await publish(fake);

    const res = await worker.fetch(shell(id), fake.env);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain('id="snapshot"');
    expect(html).toContain("not ready yet");
    // Transient, and it resolves within seconds of the upload — so it must not sit in a cache
    // for five minutes.
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("answers 410 with different sentences for a revoked and a lapsed share", async () => {
    // NOT 404 — a viewer should learn the share was withdrawn, not that they mistyped the link.
    const fake = shareEnv({ shares: [shareRow()] });
    const id = await publish(fake);
    await upload(fake, id, gz("snapshot one"));
    await worker.fetch(
      new Request(`https://share.example/g/g1/share/${id}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${await token()}` },
      }),
      fake.env,
    );

    const withdrawn = await worker.fetch(shell(id), fake.env);
    expect(withdrawn.status).toBe(410);
    const withdrawnHtml = await withdrawn.text();
    expect(withdrawnHtml).toContain("was withdrawn");

    const lapsed = await worker.fetch(shell("LAPSEDLAPSEDLAPS"), fake.env);
    expect(lapsed.status).toBe(410);
    const lapsedHtml = await lapsed.text();
    expect(lapsedHtml).toContain("no longer available");
    expect(lapsedHtml).not.toContain("was withdrawn");

    // ⚠️ **Neither page carries the metadata.** A withdrawn share whose OpenGraph card still
    // said "Giradeli's Trade binder · 412 cards" would go on advertising in every Discord it was
    // ever pasted into, which is most of what withdrawing it was for.
    expect(withdrawnHtml).not.toContain("Trade binder");
    expect(withdrawnHtml).not.toContain("og:title");
    expect(lapsedHtml).not.toContain("Old binder");
    // And a gone share is never cached at the edge: the lapse is reversible and the daily pass
    // must be able to light the link again.
    expect(withdrawn.headers.get("cache-control")).toBe("no-store");
  });

  it("answers 404 for an id that was never minted", async () => {
    const fake = shareEnv();
    const res = await worker.fetch(shell("AAAAAAAAAAAAAAAA"), fake.env);
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
  });

  it("answers a mistyped link with the same page and not with JSON", async () => {
    // A truncated or mistyped id matches neither route and falls through to the router's own
    // 404 — and a stranger who mistyped a link is exactly the reader this page exists for. The
    // status was always right; the raw `{"error":"not found"}` body was not, and asserting only
    // the status is what let it ship.
    const fake = shareEnv();
    const res = await worker.fetch(shell("tooshort"), fake.env);
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await res.text()).toContain("does not point at a shared collection");
  });

  it("keeps JSON for a path under the gated API", async () => {
    // The other half of the rule: `/g/…` is the app's API and answers JSON, so a mistyped route
    // there does not hand a Rust client an HTML page to parse.
    const fake = shareEnv();
    const res = await worker.fetch(
      new Request("https://share.example/g/g1/nonsense", {
        headers: { authorization: `Bearer ${await token()}` },
      }),
      fake.env,
    );
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toBe("application/json");
  });

  it("answers a HEAD, and 405 to a method that is neither", async () => {
    const fake = shareEnv();
    const id = await publish(fake);

    const head = await worker.fetch(
      new Request(`https://share.example/s/${id}`, { method: "HEAD" }),
      fake.env,
    );
    expect(head.status).toBe(200);
    expect(head.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await head.text()).toBe("");

    const posted = await worker.fetch(
      new Request(`https://share.example/s/${id}`, { method: "POST", body: "{}" }),
      fake.env,
    );
    expect(posted.status).toBe(405);
    expect(posted.headers.get("allow")).toBe("GET, HEAD");
  });

  it("dates the snapshot in the OpenGraph card", async () => {
    const day = 24 * 60 * 60 * 1000;
    const fake = shareEnv({
      shares: [shareRow({ id: "DATEDDATEDDATEDD", state: "live", updated_at: Date.now() - 2 * day })],
    });
    const html = await (await worker.fetch(shell("DATEDDATEDDATEDD"), fake.env)).text();
    expect(html).toContain("updated 2 days ago");
  });
});
