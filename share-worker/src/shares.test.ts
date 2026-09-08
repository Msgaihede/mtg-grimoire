import { describe, expect, it } from "vitest";
import { fakeEnvOver, type Tables } from "../../relay/src/fakeD1";
import { mint } from "../../relay/src/token";
import worker, { type Env } from "./index";

/**
 * The share Worker's three gated writes, driven through the router rather than by calling their
 * handlers.
 *
 * **Through `worker.fetch` and not through `handleCreate`/`handleList`/`handleRevoke`, for
 * `rotate.test.ts`'s reason.** Where these routes sit *relative to the bearer gate* is half of
 * what this Worker is: publishing is Patreon-gated and the gate is the only thing gating it, so a
 * suite that called the handlers would pass unchanged with the gate deleted.
 *
 * There is no test runner for workerd in this tree, deliberately —
 * `@cloudflare/vitest-pool-workers` drags wrangler and workerd into a suite pinned to vitest
 * 4.1.10, and `vite.config.ts` says so. These handlers are therefore plain functions over an
 * injected `Env`, and `fakeD1`'s SQL evaluator is the whole of what they need: D1 and nothing
 * else. The blob half is R2 and is Task 5's, in its own file.
 */

const KEY = "test-signing-key";

/**
 * `fakeD1`'s tables plus the three bindings this Worker reads.
 *
 * **The entitlement row is the precondition the token stands for and is not read by anything
 * here.** No route in this file joins `entitlements` — a token is signed rather than looked up,
 * which is `token.ts`'s whole argument — but a group that reaches these routes is by construction
 * a group somebody connected a membership to, and the daily lapse pass reads exactly this row.
 *
 * **R2 is a `Map` and nothing in this file touches it.** It is here because `Env` declares the
 * binding from this task onward; the methods stubbed are the three `blob.ts` will call.
 */
function shareEnv(tables: Partial<Tables> = {}): Env & { r2: Map<string, Uint8Array> } {
  const r2 = new Map<string, Uint8Array>();
  const base = fakeEnvOver({
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
  } as Tables);
  return {
    ...base,
    RELAY_HMAC_KEY: KEY,
    SHARE_BASE: "https://share.example",
    SHARES: {
      put: (k: string, v: ArrayBuffer) => {
        r2.set(k, new Uint8Array(v));
        return Promise.resolve({});
      },
      get: (k: string) => Promise.resolve(r2.has(k) ? { body: r2.get(k) } : null),
      delete: (k: string) => {
        r2.delete(k);
        return Promise.resolve();
      },
    },
    r2,
  } as unknown as Env & { r2: Map<string, Uint8Array> };
}

/**
 * A token good for the next minute.
 *
 * ⚠️ **`Date.now()` and never a fixture stamp.** The gate calls `verify(…, Date.now())`, so an
 * `exp` written as a constant is a suite that goes green on the day it was written and red for
 * ever after — the plan's own fixture stamp was already a year in the past when this file was
 * written, which would have made every gated case below a 401 for a reason none of them is
 * about.
 */
async function token(group = "g1", exp = Date.now() + 60_000): Promise<string> {
  return mint({ sub: "sub-0", grp: group, exp }, KEY);
}

function post(group: string, bearer: string, body: unknown): Request {
  return new Request(`https://share.example/g/${group}/share`, {
    method: "POST",
    headers: { authorization: `Bearer ${bearer}` },
    body: JSON.stringify(body),
  });
}

function list(group: string, bearer: string): Request {
  return new Request(`https://share.example/g/${group}/shares`, {
    headers: { authorization: `Bearer ${bearer}` },
  });
}

function revoke(group: string, bearer: string, id: string): Request {
  return new Request(`https://share.example/g/${group}/share/${id}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${bearer}` },
  });
}

/** The id a create answered, for a test that needs one to revoke or to compare. */
async function idOf(response: Response): Promise<string> {
  return ((await response.json()) as { id: string }).id;
}

const META = {
  folderUid: "uid-1",
  title: "Trade binder",
  ownerName: "Giradeli",
  cardCount: 2,
  totalValue: 1.2,
  currency: "USD",
  marketplace: "tcgplayer",
  fields: ["condition", "lang", "value"],
};

describe("POST /g/{group}/share", () => {
  it("mints a share for an entitled caller and answers its id", async () => {
    const env = shareEnv();
    const res = await worker.fetch(post("g1", await token(), META), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; url: string };
    expect(body.id).toMatch(/^[A-Za-z0-9_-]{16}$/);
    // The link is built here rather than in the app, because `SHARE_BASE` is this Worker's own
    // address and the app would be spelling it a second time.
    expect(body.url).toBe(`https://share.example/s/${body.id}`);
  });

  it("refuses a request with no bearer", async () => {
    const env = shareEnv();
    const res = await worker.fetch(
      new Request("https://share.example/g/g1/share", { method: "POST", body: "{}" }),
      env,
    );
    expect(res.status).toBe(401);
  });

  it("refuses a token that has expired", async () => {
    // The token is the whole of the entitlement check — publishing is gated by nothing else —
    // so a gate that verified the signature and not the clock would let a cancelled membership
    // publish for ever off a token it kept.
    const env = shareEnv();
    const res = await worker.fetch(post("g1", await token("g1", Date.now() - 1), META), env);
    expect(res.status).toBe(401);
  });

  /**
   * Not redundant with the signature check: a validly signed token for the caller's OWN group is
   * exactly what an attacker has. Without this comparison it would open every group.
   */
  it("refuses a valid token minted for a different group", async () => {
    const env = shareEnv();
    const res = await worker.fetch(post("g1", await token("g2"), META), env);
    expect(res.status).toBe(401);
  });

  it("returns the same id when the same folder is shared again", async () => {
    const env = shareEnv();
    const first = await idOf(await worker.fetch(post("g1", await token(), META), env));
    const again = await idOf(
      await worker.fetch(post("g1", await token(), { ...META, title: "Renamed" }), env),
    );
    expect(again).toBe(first);
    // And the second publish is an update rather than a second row: decision 7 is one share per
    // folder, and a link that changed under the reader's friends is the failure it prevents.
    const rows = (await (await worker.fetch(list("g1", await token()), env)).json()) as {
      shares: { id: string; title: string }[];
    };
    expect(rows.shares).toHaveLength(1);
    expect(rows.shares[0].title).toBe("Renamed");
  });

  it("tells a folder share apart from a whole-collection one", async () => {
    // ⚠️ SQLite treats NULLs as distinct, so the folder key is `coalesce(folder_uid, '')` on both
    // sides of this: a naive `folder_uid = ?` matches no row for a whole-collection share, and
    // every republish of the whole collection would mint another link.
    const env = shareEnv();
    const folder = await idOf(await worker.fetch(post("g1", await token(), META), env));
    const whole = await idOf(
      await worker.fetch(post("g1", await token(), { ...META, folderUid: null }), env),
    );
    expect(whole).not.toBe(folder);

    const wholeAgain = await idOf(
      await worker.fetch(post("g1", await token(), { ...META, folderUid: null }), env),
    );
    expect(wholeAgain).toBe(whole);
  });

  it("caps a group's shares and names the number", async () => {
    const env = shareEnv();
    const first = await idOf(
      await worker.fetch(post("g1", await token(), { ...META, folderUid: "uid-0" }), env),
    );
    for (let i = 1; i < 20; i += 1) {
      await worker.fetch(post("g1", await token(), { ...META, folderUid: `uid-${i}` }), env);
    }
    const res = await worker.fetch(post("g1", await token(), { ...META, folderUid: "uid-over" }), env);
    expect(res.status).toBe(403);
    const refusal = (await res.json()) as { error: string; code: string };
    // The number comes out of the message and never out of the binding — an assertion that read
    // `MAX_SHARES_PER_GROUP` would be green at any cap.
    expect(JSON.stringify(refusal)).toContain("20");
    // **And the code is asserted as a literal, because the code is the contract.** 403 already
    // means other things to a caller, `share/publish.rs` branches on this string, and the
    // sentence beside it is copy that is *meant* to be improvable — so renaming the code has to
    // be what goes red, exactly as the relay pins `device_limit`.
    expect(refusal.code).toBe("share_limit");

    // And the cap counts what is live rather than what was ever minted: a revoked share has to
    // give its slot back, or a reader who publishes and withdraws twenty times is locked out for
    // ever.
    expect((await worker.fetch(revoke("g1", await token(), first), env)).status).toBe(204);
    const after = await worker.fetch(post("g1", await token(), { ...META, folderUid: "uid-over" }), env);
    expect(after.status).toBe(200);
  });

  it("refuses a body that is not a share", async () => {
    const env = shareEnv();
    for (const bad of [
      {},
      { ...META, title: "" },
      { ...META, ownerName: "" },
      { ...META, cardCount: -1 },
      { ...META, cardCount: 1.5 },
      { ...META, folderUid: 5 },
      { ...META, fields: "condition" },
      { ...META, fields: ["condition", "notes"] },
      // Every element is a known field and the array is still a megabyte. The element check does
      // not bound the array, and this lands in a column of a D1 the whole account shares.
      { ...META, fields: new Array(100_000).fill("condition") as string[] },
    ]) {
      const res = await worker.fetch(post("g1", await token(), bad), env);
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }

    const unreadable = new Request("https://share.example/g/g1/share", {
      method: "POST",
      headers: { authorization: `Bearer ${await token()}` },
      body: "{not json",
    });
    expect((await worker.fetch(unreadable, env)).status).toBe(400);

    // Every one of those is a 400 **and** a no-op.
    const rows = (await (await worker.fetch(list("g1", await token()), env)).json()) as {
      shares: unknown[];
    };
    expect(rows.shares).toEqual([]);
  });

  it("answers 405 to the wrong method, and 404 to a path that is not a route", async () => {
    const env = shareEnv();
    const bearer = await token();

    const getOnShare = await worker.fetch(
      new Request("https://share.example/g/g1/share", {
        headers: { authorization: `Bearer ${bearer}` },
      }),
      env,
    );
    expect(getOnShare.status).toBe(405);
    expect(getOnShare.headers.get("allow")).toBe("POST");

    const shortId = await worker.fetch(
      new Request("https://share.example/g/g1/share/tooshort", {
        method: "DELETE",
        headers: { authorization: `Bearer ${bearer}` },
      }),
      env,
    );
    expect(shortId.status).toBe(404);
  });
});

describe("GET /g/{group}/shares and DELETE", () => {
  it("lists what the group has published, from any device in it", async () => {
    const env = shareEnv();
    await worker.fetch(post("g1", await token(), META), env);
    const res = await worker.fetch(list("g1", await token()), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      shares: {
        title: string;
        ownerName: string;
        folderUid: string | null;
        fields: string[];
        state: string;
        url: string;
      }[];
    };
    expect(body.shares.map((s) => s.title)).toEqual(["Trade binder"]);
    // **The owner's name is on the row because spec §4.3 needs it there**: the second device in
    // a group inherits what the first one typed rather than asking the reader again.
    expect(body.shares[0].ownerName).toBe("Giradeli");
    expect(body.shares[0].folderUid).toBe("uid-1");
    // `fields` crosses as the array it was published as, not as the JSON text D1 stores.
    expect(body.shares[0].fields).toEqual(["condition", "lang", "value"]);
    expect(body.shares[0].state).toBe("live");
  });

  it("lists nothing belonging to another group", async () => {
    // A share belongs to the group, and `WHERE group_id = ?` is the whole of that. Without it
    // one valid token would list every binder on the account.
    const env = shareEnv();
    await worker.fetch(post("g1", await token(), META), env);
    const res = await worker.fetch(list("g2", await token("g2")), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ shares: [] });
  });

  it("revokes permanently, and a revoked share does not come back on re-publish", async () => {
    const env = shareEnv();
    const id = await idOf(await worker.fetch(post("g1", await token(), META), env));
    const res = await worker.fetch(revoke("g1", await token(), id), env);
    expect(res.status).toBe(204);

    const again = await idOf(await worker.fetch(post("g1", await token(), META), env));
    expect(again).not.toBe(id);

    // The revoked row is still there — it is what answers a viewer 410 rather than 404 — and it
    // is not in the owner's list either.
    const body = (await (await worker.fetch(list("g1", await token()), env)).json()) as {
      shares: { id: string }[];
    };
    expect(body.shares.map((s) => s.id)).toEqual([again]);
  });

  it("goes on refreshing a folder that was once revoked", async () => {
    // ⚠️ **Three publishes, and the third is the whole test.** A revoked row stays on this
    // folder's key for ever — it is what answers a viewer 410 — so a lookup that does not exclude
    // it finds the tombstone on every later publish and takes the mint-a-new-id branch again. Two
    // publishes cannot see that: the second one is *supposed* to mint a new id. The third is what
    // separates "the tombstone was skipped" from "the tombstone is answered every time", and
    // against the real partial index the wrong answer is `UNIQUE constraint failed: index
    // 'shares_folder'` — an uncaught 500 on every Refresh of that folder, permanently.
    const env = shareEnv();
    const first = await idOf(await worker.fetch(post("g1", await token(), META), env));
    expect((await worker.fetch(revoke("g1", await token(), first), env)).status).toBe(204);

    const second = await idOf(await worker.fetch(post("g1", await token(), META), env));
    expect(second).not.toBe(first);
    const third = await idOf(await worker.fetch(post("g1", await token(), META), env));
    expect(third).toBe(second);
    const fourth = await idOf(
      await worker.fetch(post("g1", await token(), { ...META, title: "Renamed" }), env),
    );
    expect(fourth).toBe(second);

    // And one folder is still one share, rather than a row per press.
    const body = (await (await worker.fetch(list("g1", await token()), env)).json()) as {
      shares: { id: string; title: string }[];
    };
    expect(body.shares).toEqual([expect.objectContaining({ id: second, title: "Renamed" })]);
  });

  it("answers the winner's id when two devices publish one folder at once", async () => {
    // Both devices read no row and both insert; `shares_folder` refuses the second, which is the
    // guarantee working. What must not happen is the loser being handed a 500 for losing a race
    // it could not see.
    //
    // **The race is staged, because `fakeD1` models column keys and not expression indexes** —
    // it would let both rows land. The stub writes the winner's row and then raises what D1
    // raises, which is the state the loser's handler actually meets.
    const env = shareEnv();
    const real = env.DB;
    const WINNER = "WINNERWINNERWINN";
    let raced = false;
    const db = {
      prepare: (sql: string) => {
        const statement = real.prepare(sql);
        if (!sql.trimStart().startsWith("INSERT")) return statement;
        return {
          bind: (...values: unknown[]) => ({
            run: async () => {
              if (raced) return real.prepare(sql).bind(...values).run();
              raced = true;
              await real
                .prepare(sql)
                .bind(WINNER, ...values.slice(1))
                .run();
              throw new Error("D1_ERROR: UNIQUE constraint failed: index 'shares_folder'");
            },
          }),
        };
      },
    };

    const res = await worker.fetch(post("g1", await token(), META), {
      ...env,
      DB: db,
    } as unknown as Env);
    expect(res.status).toBe(200);
    expect(await idOf(res)).toBe(WINNER);
  });

  it("rethrows a failure that is not the race", async () => {
    // The catch above asks "is a share serving this folder now?" and never matches on the error's
    // text. The other half of that rule is this one: a write that failed for any other reason
    // must not be swallowed into a 200 pointing at nothing.
    const env = shareEnv();
    const db = {
      prepare: (sql: string) => {
        const statement = env.DB.prepare(sql);
        if (!sql.trimStart().startsWith("INSERT")) return statement;
        return {
          bind: () => ({
            run: () => Promise.reject(new Error("D1_ERROR: no such table: shares")),
          }),
        };
      },
    };

    await expect(
      worker.fetch(post("g1", await token(), META), { ...env, DB: db } as unknown as Env),
    ).rejects.toThrow(/no such table/);
  });

  it("refuses to revoke a share belonging to another group", async () => {
    const env = shareEnv();
    const id = await idOf(await worker.fetch(post("g1", await token(), META), env));

    const res = await worker.fetch(revoke("g2", await token("g2"), id), env);
    expect(res.status).toBe(404);

    const body = (await (await worker.fetch(list("g1", await token()), env)).json()) as {
      shares: { id: string }[];
    };
    expect(body.shares.map((s) => s.id)).toEqual([id]);
  });

  it("answers 404 to revoking an id nobody minted", async () => {
    const env = shareEnv();
    const res = await worker.fetch(revoke("g1", await token(), "AAAAAAAAAAAAAAAA"), env);
    expect(res.status).toBe(404);
  });
});
