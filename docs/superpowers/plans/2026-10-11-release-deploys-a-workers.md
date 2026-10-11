# A release deploys the relay and the share Worker — Implementation Plan (piece A)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `release.yml` applies pending D1 migrations and deploys the relay and the share Worker at a release tag, before the web app, each followed by a probe of the live address.

**Architecture:** Three new jobs in `release.yml` — `share` (builds the viewer, no secret), `relay-deploy` and `share-deploy` (each: ask for the token, refuse an older tag, install the pinned `wrangler`, `d1 migrations apply --remote`, `deploy`, probe). `schema.sql` is frozen as the D1 baseline; later changes are numbered files in a tracked `migrations/` folder that starts empty. Two dependency-free probe scripts share one small helper module, and their expectations are held to this tree's own routers by running `worker.fetch` over the fake D1.

**Tech Stack:** GitHub Actions, wrangler 4.146.0 (pinned in `infrastructure/wrangler/package-lock.json`), Node 24 (`node:sqlite`, type stripping), Vitest.

**Spec:** `docs/superpowers/specs/2026-10-11-release-deploys-everything-design.md` (§4, §5, §7.1, §7.3, §9). Piece B (the Play upload) is `2026-10-11-release-deploys-b-play-upload.md` and lands after this.

## Global Constraints

- **Pull request 874 merges first.** This plan edits `scripts/release-rule.test.ts` as that PR leaves it (`runsOf`, `RUNS`, `RUN_KEYS`). Before Task 1: `gh pr view 874 --json state --jq .state` must print `MERGED`, then bring `main` into this branch (`mcp__ccd_host__sync_with_base_branch`). If it is still open, stop and tell the owner.
- **One commit for the whole piece**, `feat:`, with code, tests, the spec and both plan files together (root `CLAUDE.md`, "Commit style"). No task commits; Task 6 does.
- **`pnpm verify` runs once, in Task 6.** While building, run only the single test file a step names (`pnpm exec vitest run <file>`). Never two verifies at once.
- **No agent deploys anything.** No `wrangler deploy`, no `--remote`, no `wrangler secret`, no `gh secret set`. The only wrangler commands in this plan are `--local`.
- **A secret-holding job builds nothing:** no pnpm, no cargo, no cache, `shell: bash` only, `wrangler` installed by `npm ci --ignore-scripts` in a step with no `env:` and run by path.
- **Every third-party action is pinned** to the SHAs `release.yml` already uses: `actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1`, `actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0`, `actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8.0.1`, `actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1`, `pnpm/action-setup@ea17c68df8912ef543352723c149a84f56e3d413 # v6.1.0`. `persist-credentials: false` on every checkout.
- **Secret names:** `CLOUDFLARE_INFRA_API_TOKEN` (new) and `CLOUDFLARE_ACCOUNT_ID` (already set). The account id is in no file.
- **The token alone decides whether an infra job runs.** `CLOUDFLARE_ACCOUNT_ID` is already set for `web-deploy`, so "some but not all is a failure" would turn every release red until the owner makes the new token. No token: green, deployed nothing. Token and no account id: red.
- **D1 names:** database `mtg-grimoire-relay`; tables `d1_migrations` (relay) and `d1_migrations_share` (share Worker); migration files `NNNN_what-it-does.sql`, four digits from `0001`, no gaps.
- **Documents are written in the repository's voice** (dated, plain, no marketing), and a `CLAUDE.md` stays under 200 lines (`node scripts/check-claude-md.ts`).

## Review Focus

1. **The infra token is unset while the account id is set (the state on the day this merges).** Both new jobs must end green having deployed nothing. Pinned in Task 4 (`asks for the token alone`).
2. **A migration file named out of order, twice, or with a gap** (`0002_…` beside another `0002_…`). wrangler would apply by name and say nothing. Pinned in Task 1 (`orderProblems`).
3. **A Windows checkout turns `schema.sql` to CRLF.** The baseline's pinned hash must not change with line endings. Pinned in Task 1 (`hashes the same with either line ending`).
4. **The edge answers with the previous version, a 429 or a 5xx for a moment after the deploy.** The probe asks again and, when it gives up, names the probe and the status. Pinned in Task 2 (`askUntil`, `problemsOf`).
5. **The share bundle arrives without `assets/share.js`, or the address still serves the last one.** Refused before the deploy by the job's check and after it by the probe's byte comparison. Pinned in Task 3 (`viewerProblems`) and Task 4 (step order).

---

## File structure

| File | Responsibility |
| --- | --- |
| `infrastructure/relay/applied-by-hand/*.sql` | The five migrations applied by hand before 2026-10-11, moved, unchanged. History only. |
| `infrastructure/relay/migrations/README.md` | The tracked folder's rules. Holds the folder in git while it has no `.sql`. |
| `infrastructure/share-worker/migrations/README.md` | The same for the share Worker. |
| `scripts/d1-migrations.test.ts` | The baseline's hash, the file-name order, a replay on `node:sqlite`, the two bindings' settings. |
| `scripts/deploy-probe.ts` | What both Worker probes share: build a request, read an answer, compare, ask again, report. |
| `scripts/relay-deploy-probe.ts` | The relay's probes and its `main`. |
| `scripts/share-deploy-probe.ts` | The share Worker's probes, the viewer comparison and its `main`. |
| `scripts/relay-deploy-probe.test.ts`, `scripts/share-deploy-probe.test.ts`, `scripts/deploy-probe.test.ts` | Each probe held to this tree's router; the helper's pure halves. |
| `scripts/share-worker-alias.test.ts` | The share Worker's one cross-package import, held to the `alias` that lets it bundle with no install. |
| `.github/workflows/release.yml` | Jobs `share`, `relay-deploy`, `share-deploy`; new `needs` on `web-deploy` and `publish`. |
| `.github/workflows/ci.yml` | `pnpm share:build` in the `frontend` build leg. |
| `scripts/release-rule.test.ts` | The fence, extended. |

---

### Task 1: Tracked D1 migrations over a frozen baseline

**Files:**
- Move: `infrastructure/relay/migrations/2026-*.sql` → `infrastructure/relay/applied-by-hand/`
- Create: `infrastructure/relay/migrations/README.md`, `infrastructure/share-worker/migrations/README.md`
- Create: `scripts/d1-migrations.test.ts`
- Modify: `infrastructure/relay/wrangler.jsonc` (the `d1_databases` entry), `infrastructure/share-worker/wrangler.jsonc` (the `d1_databases` entry)
- Modify: `scripts/web-smoke/sync-harness.ts` (after the `d1("--file", "infrastructure/relay/schema.sql");` line)
- Modify: `scripts/ci-route.test.ts` (one row)

**Interfaces:**
- Produces: `migrations_dir: "migrations"` on both D1 bindings; `migrations_table` `d1_migrations` (relay) and `d1_migrations_share` (share Worker). Task 4's jobs run `d1 migrations apply mtg-grimoire-relay --remote` from each Worker's folder and rely on these.

- [ ] **Step 1: Write the failing test**

Create `scripts/d1-migrations.test.ts`:

```js
// The relay's D1, as a release changes it (`release.yml`, `relay-deploy` and `share-deploy`):
// each Worker's `schema.sql` is the baseline — the shape production held on 2026-10-11 — and
// everything after it is a numbered file in that Worker's `migrations/`, which wrangler applies
// once, in name order, and records in a table of its own.
//
// Held here: the baselines do not change (a change to the schema is a new migration, never an
// edit), the files are named so that name order is the order they were written in, the whole
// chain applies to an empty database, and the two bindings name their folder and their table.
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import relaySchema from "../infrastructure/relay/schema.sql?raw";
import shareSchema from "../infrastructure/share-worker/schema.sql?raw";
import relayWrangler from "../infrastructure/relay/wrangler.jsonc?raw";
import shareWrangler from "../infrastructure/share-worker/wrangler.jsonc?raw";

const RELAY = import.meta.glob("/infrastructure/relay/migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
});
const SHARE = import.meta.glob("/infrastructure/share-worker/migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
});
const BY_HAND = import.meta.glob("/infrastructure/relay/applied-by-hand/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
});

/** A file's SHA-256 with its line endings as git stores them, whatever the checkout made of them. */
const baselineHash = (text) =>
  createHash("sha256").update(text.replaceAll("\r\n", "\n")).digest("hex");

/** A folder's `.sql` files as `[name, text]`, in the order wrangler applies them: by name. */
const inOrder = (files) =>
  Object.entries(files)
    .map(([path, text]) => [path.slice(path.lastIndexOf("/") + 1), text])
    .sort(([a], [b]) => (a < b ? -1 : 1));

/** What is wrong with a folder's file names, as sentences — none when name order is write order. */
function orderProblems(names) {
  const out = [];
  const sorted = [...names].sort();
  sorted.forEach((name, i) => {
    const found = /^(\d{4})_[a-z0-9]+(?:-[a-z0-9]+)*\.sql$/.exec(name);
    if (!found) {
      out.push(`${name} is not NNNN_what-it-does.sql`);
    } else if (Number(found[1]) !== i + 1) {
      out.push(`${name} should be number ${String(i + 1).padStart(4, "0")}`);
    }
  });
  return out;
}

/** A config's lines that are not comments. */
const code = (src) =>
  src
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");

describe("the baselines", () => {
  // **A red hash here means `schema.sql` was edited.** Production already holds that file's
  // shape, and nothing re-applies it: put the change in a new file in `migrations/` instead.
  it("are the files production was built from, to the byte", () => {
    expect(baselineHash(relaySchema)).toBe(
      "4ecf91d0da81f08373c7b2d401111fa9584a55a08d3b86e7c092dda1706d89cc",
    );
    expect(baselineHash(shareSchema)).toBe(
      "e1302b39675b1ff18c608b56e590c941e2a9fbd3cbc145d922685ac93d89f0d7",
    );
  });

  it("hashes the same with either line ending", () => {
    expect(baselineHash("a\r\nb\r\n")).toBe(baselineHash("a\nb\n"));
    expect(baselineHash("a\nb\n")).not.toBe(baselineHash("a\nb"));
  });
});

describe("the tracked folders", () => {
  it("name their files so that name order is the order they were written in", () => {
    expect(orderProblems(inOrder(RELAY).map(([name]) => name))).toEqual([]);
    expect(orderProblems(inOrder(SHARE).map(([name]) => name))).toEqual([]);
  });

  it("refuses a name out of the pattern, a number used twice, and a gap", () => {
    expect(orderProblems(["0001_add-a.sql", "0002_add-b.sql"])).toEqual([]);
    expect(orderProblems(["2026-10-12-add-a.sql"])).toEqual([
      "2026-10-12-add-a.sql is not NNNN_what-it-does.sql",
    ]);
    expect(orderProblems(["0001_add-a.sql", "0001_add-b.sql"])).toEqual([
      "0001_add-b.sql should be number 0002",
    ]);
    expect(orderProblems(["0001_add-a.sql", "0003_add-c.sql"])).toEqual([
      "0003_add-c.sql should be number 0002",
    ]);
    expect(orderProblems(["0001_Add_A.sql"])).toEqual(["0001_Add_A.sql is not NNNN_what-it-does.sql"]);
  });

  // The five that were applied by hand are in `schema.sql` already. In the tracked folder
  // wrangler would run each again on the first release, and four of them are `ALTER TABLE`s.
  it("hold none of the migrations that were applied by hand", () => {
    expect(inOrder(BY_HAND).map(([name]) => name)).toEqual([
      "2026-08-30-group-devices.sql",
      "2026-08-30-group-keys.sql",
      "2026-08-31-pairing-rendezvous.sql",
      "2026-09-26-refresh-device.sql",
      "2026-09-28-reconciled-at.sql",
    ]);
    for (const [name] of [...inOrder(RELAY), ...inOrder(SHARE)]) {
      expect(name).not.toMatch(/^2026-/);
    }
  });

  it("apply, baseline first, to a database that has never been migrated", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(relaySchema);
    for (const [, text] of inOrder(RELAY)) db.exec(text);
    db.exec(shareSchema);
    for (const [, text] of inOrder(SHARE)) db.exec(text);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => row.name);
    expect(tables).toEqual(
      expect.arrayContaining([
        "claim_codes",
        "entitlements",
        "group_devices",
        "group_keys",
        "pairing_rendezvous",
        "shares",
      ]),
    );
    db.close();
  });
});

describe("the two bindings", () => {
  // One database, two Workers, two lists: a table each, so neither list can mark the other's
  // file as applied.
  it("name the tracked folder, and a bookkeeping table of their own", () => {
    expect(code(relayWrangler)).toContain('"migrations_dir": "migrations"');
    expect(code(relayWrangler)).toContain('"migrations_table": "d1_migrations"');
    expect(code(shareWrangler)).toContain('"migrations_dir": "migrations"');
    expect(code(shareWrangler)).toContain('"migrations_table": "d1_migrations_share"');
    expect(code(relayWrangler)).not.toContain("d1_migrations_share");
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `pnpm exec vitest run scripts/d1-migrations.test.ts`
Expected: FAIL — `hold none of the migrations that were applied by hand` (the by-hand folder is empty and the tracked one holds five `2026-…` files) and `name the tracked folder…` (no `migrations_dir`).

- [ ] **Step 3: Move the five applied files**

```bash
mkdir -p infrastructure/relay/applied-by-hand
git mv infrastructure/relay/migrations/2026-08-30-group-devices.sql infrastructure/relay/applied-by-hand/
git mv infrastructure/relay/migrations/2026-08-30-group-keys.sql infrastructure/relay/applied-by-hand/
git mv infrastructure/relay/migrations/2026-08-31-pairing-rendezvous.sql infrastructure/relay/applied-by-hand/
git mv infrastructure/relay/migrations/2026-09-26-refresh-device.sql infrastructure/relay/applied-by-hand/
git mv infrastructure/relay/migrations/2026-09-28-reconciled-at.sql infrastructure/relay/applied-by-hand/
```

Do not edit their contents: they are a record of what was run.

- [ ] **Step 4: Write the two folders' rules**

Create `infrastructure/relay/migrations/README.md`:

```markdown
# The relay's D1 migrations

`release.yml`'s `relay-deploy` runs `wrangler d1 migrations apply mtg-grimoire-relay --remote`
from `infrastructure/relay` before it deploys. wrangler applies every `.sql` file here that the
table `d1_migrations` does not name yet, in name order, and records it. A file runs once.

- **`../schema.sql` is the baseline and is never edited.** It is the shape production held on
  2026-10-11. `scripts/d1-migrations.test.ts` pins its hash; a red hash means the change
  belongs in a new file here.
- **Name a file `NNNN_what-it-does.sql`**: four digits, the next number, lower case and hyphens.
  The same test refuses a number used twice and a gap.
- **Additive only.** The migration is applied before the deploy, so for a moment the previous
  release's code runs on the new schema: add a column or a table, never drop or rename one.
- **Nothing undoes it.** A re-run applies nothing, and the way back is D1's Time Travel, by hand.
- **`../applied-by-hand/` is history**: the five migrations run by hand before this folder was
  tracked, each already in `schema.sql`. Nothing reads them.

No agent applies one to production: `--remote` is the release's, or the owner's.
```

Create `infrastructure/share-worker/migrations/README.md`:

```markdown
# The share Worker's D1 migrations

`release.yml`'s `share-deploy` runs `wrangler d1 migrations apply mtg-grimoire-relay --remote`
from `infrastructure/share-worker` before it deploys. The database is the relay's; this Worker's
list is kept in a table of its own, `d1_migrations_share`, so neither list can mark the other's
file as applied.

The rules are the relay's — `../../relay/migrations/README.md`: `../schema.sql` is the baseline
and is never edited, a file is `NNNN_what-it-does.sql`, additive only, applied once.
```

- [ ] **Step 5: Name the folder and the table in both bindings**

In `infrastructure/relay/wrangler.jsonc`, replace the `d1_databases` entry's three lines with:

```jsonc
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "mtg-grimoire-relay",
      "database_id": "5e0381b0-d2aa-4861-a725-26ca18ae00ef",
      // What `release.yml`'s `relay-deploy` applies before it deploys: every `.sql` file in
      // `migrations/` the table does not name yet, once, in name order. `schema.sql` is the
      // baseline those files start from — `migrations/README.md` has the rules.
      "migrations_dir": "migrations",
      "migrations_table": "d1_migrations",
    },
  ],
```

Also change the comment line above it that reads ``applied with `npx wrangler d1 execute mtg-grimoire-relay --remote --file=./schema.sql`.`` to say ``the baseline; `migrations/` holds what a release applies after it.``

In `infrastructure/share-worker/wrangler.jsonc`, the same edit to its `d1_databases` entry:

```jsonc
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "mtg-grimoire-relay",
      "database_id": "5e0381b0-d2aa-4861-a725-26ca18ae00ef",
      // This Worker's own list on the relay's database, in a table of its own so the two lists
      // cannot shadow each other — `migrations/README.md`.
      "migrations_dir": "migrations",
      "migrations_table": "d1_migrations_share",
    },
  ],
```

- [ ] **Step 6: Run the test and see it pass**

Run: `pnpm exec vitest run scripts/d1-migrations.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 7: Ask wrangler what it does with a folder of no `.sql` files**

This is the one fact the design rests on that no test can hold. Local only.

```bash
npm ci --ignore-scripts --prefix infrastructure/wrangler
cd infrastructure/relay
CI=true node ../wrangler/node_modules/wrangler/bin/wrangler.js d1 migrations apply mtg-grimoire-relay --local --persist-to "$SCRATCH/d1-empty"; echo "exit $?"
```

(`$SCRATCH` is the session's scratchpad directory.) Expected: `exit 0` and a line saying there is nothing to apply.

Then prove a real file is applied once. Write `infrastructure/relay/migrations/0001_probe.sql` holding `CREATE TABLE probe (x INTEGER);`, run the same command twice, and expect the first run to list and apply `0001_probe.sql` and the second to say there is nothing to apply. **Delete `0001_probe.sql` afterwards** and confirm `git status --short infrastructure/relay/migrations` shows only `README.md`.

If the empty-folder run exits non-zero: stop and report to the owner. Do not work around it.

- [ ] **Step 8: Apply the tracked files in the sync smoke's local database**

In `scripts/web-smoke/sync-harness.ts`, directly under `d1("--file", "infrastructure/relay/schema.sql");`, add:

```js
  // Then every tracked migration, in name order: what a release's `relay-deploy` applies to
  // production after that baseline. Through the same `d1 execute` — this database is thrown
  // away, so wrangler's own bookkeeping of what ran is not wanted here.
  for (const file of readdirSync(join(ROOT, "infrastructure/relay/migrations"))
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    d1("--file", `infrastructure/relay/migrations/${file}`);
  }
```

`readdirSync`, `join` and `ROOT` are already in that module. It adds no `spawn` and no wrangler subcommand, so `release-rule.test.ts`'s count of what the smoke run starts is unchanged.

- [ ] **Step 9: Route the folder in the CI router's table**

In `scripts/ci-route.test.ts`, under the row `["infrastructure/relay/schema.sql", T, T, F, F, F, F, T],` add:

```js
    // A tracked migration: the sync smoke applies it (`web`), and `d1-migrations.test.ts`
    // replays it (`frontend`).
    ["infrastructure/relay/migrations/0001_add-a-column.sql", T, T, F, F, F, F, T],
```

Run: `pnpm exec vitest run scripts/ci-route.test.ts`
Expected: PASS. (The relay's arm, `infrastructure/relay/*`, already routes it; if the row is red, read the arm and fix the row, not the router.)

---

### Task 2: The probe helper and the relay's probe

**Files:**
- Create: `scripts/deploy-probe.ts`, `scripts/deploy-probe.test.ts`
- Create: `scripts/relay-deploy-probe.ts`, `scripts/relay-deploy-probe.test.ts`

**Interfaces:**
- Produces, from `scripts/deploy-probe.ts`:
  - `requestOf(origin: string, probe: Probe): Request`
  - `answerOf(response: Response): Promise<{ status: number, type: string | null, body: string, allowOrigin: string | null }>`
  - `problemsOf(probe: Probe, answer): string[]`
  - `askAll(origin: string, probes: Probe[], send?: (request: Request) => Promise<Response>): Promise<string[]>`
  - `askUntil(once: () => Promise<string[]>, options?: { attempts?, wait?, sleep?, log? }): Promise<{ wrong: string[], asked: number }>`
  - `report(heading: { passed: string, failed: string }, passedDetail: string, result: { wrong, asked }): number` (the exit code)
  - A `Probe` is `{ name, path, method?, headers?, body?, status, says?, type?, allowOrigin?, means? }`.
- Produces, from `scripts/relay-deploy-probe.ts`: `RELAY`, `APP`, `PROBES`. Task 4's job runs `node scripts/relay-deploy-probe.ts`.

- [ ] **Step 1: Write the helper's failing test**

Create `scripts/deploy-probe.test.ts`:

```js
// What the two Worker probes share (`relay-deploy-probe.ts`, `share-deploy-probe.ts`): how a
// probe becomes a request, how an answer is compared, and how many times the host is asked.
import { describe, expect, it } from "vitest";
import { answerOf, askAll, askUntil, problemsOf, requestOf } from "./deploy-probe.ts";

describe("requestOf", () => {
  it("builds a GET with the probe's headers, following no redirect", () => {
    const request = requestOf("https://h.example", {
      name: "n",
      path: "/g/abc/keys?device=d",
      headers: { authorization: "Bearer x" },
      status: 401,
    });
    expect(request.method).toBe("GET");
    expect(request.url).toBe("https://h.example/g/abc/keys?device=d");
    expect(request.headers.get("authorization")).toBe("Bearer x");
    expect(request.headers.get("cache-control")).toBe("no-cache");
    expect(request.redirect).toBe("manual");
  });

  it("sends a body as JSON", async () => {
    const request = requestOf("https://h.example", {
      name: "n",
      method: "POST",
      path: "/token",
      body: "{}",
      status: 400,
    });
    expect(request.method).toBe("POST");
    expect(request.headers.get("content-type")).toBe("application/json");
    expect(await request.text()).toBe("{}");
  });
});

describe("problemsOf", () => {
  const probe = { name: "the door", path: "/x", status: 401, says: "unauthorized" };
  const good = { status: 401, type: "application/json", body: '{"error":"unauthorized"}', allowOrigin: null };

  it("finds none in the answer it expects", () => {
    expect(problemsOf(probe, good)).toEqual([]);
  });

  it("names the probe and the status of another answer", () => {
    expect(problemsOf(probe, { ...good, status: 429 })).toEqual(["the door: answered 429, not 401"]);
  });

  it("says what a status is known to mean", () => {
    const meant = { ...probe, means: { 500: "the table is missing" } };
    expect(problemsOf(meant, { ...good, status: 500 })).toEqual([
      "the door: answered 500, not 401 — the table is missing",
    ]);
  });

  it("names a right status with the wrong words", () => {
    expect(problemsOf(probe, { ...good, body: "{}" })).toEqual([
      'the door: answered 401 without "unauthorized"',
    ]);
  });

  it("holds the content type when the probe names one", () => {
    const page = { name: "the page", path: "/s/x", status: 404, type: "text/html" };
    expect(problemsOf(page, { ...good, status: 404, type: "text/html; charset=utf-8" })).toEqual([]);
    expect(problemsOf(page, { ...good, status: 404, type: "text/plain" })).toEqual([
      "the page: answered as text/plain, not text/html",
    ]);
  });

  it("holds the allowed origin only when the probe names one, absent included", () => {
    const from = { ...probe, allowOrigin: "https://app.example" };
    expect(problemsOf(from, { ...good, allowOrigin: "https://app.example" })).toEqual([]);
    expect(problemsOf(from, good)).toEqual([
      "the door: access-control-allow-origin is absent, not https://app.example",
    ]);
    const foreign = { ...probe, allowOrigin: null };
    expect(problemsOf(foreign, { ...good, allowOrigin: "https://evil.example" })).toEqual([
      "the door: access-control-allow-origin is https://evil.example, not absent",
    ]);
  });
});

describe("answerOf and askAll", () => {
  it("reads the status, the type, the body and the allowed origin", async () => {
    const response = new Response("hello", {
      status: 404,
      headers: { "content-type": "text/html", "access-control-allow-origin": "https://a.example" },
    });
    expect(await answerOf(response)).toEqual({
      status: 404,
      type: "text/html",
      body: "hello",
      allowOrigin: "https://a.example",
    });
  });

  it("asks every probe, in order, and gathers what is wrong", async () => {
    const seen = [];
    const send = (request) => {
      seen.push(new URL(request.url).pathname);
      return Promise.resolve(new Response("", { status: 200 }));
    };
    const wrong = await askAll(
      "https://h.example",
      [
        { name: "a", path: "/a", status: 200 },
        { name: "b", path: "/b", status: 404 },
      ],
      send,
    );
    expect(seen).toEqual(["/a", "/b"]);
    expect(wrong).toEqual(["b: answered 200, not 404"]);
  });
});

describe("askUntil", () => {
  const quiet = { wait: 5, sleep: () => Promise.resolve(), log: () => {} };

  it("stops at the first attempt that finds nothing wrong", async () => {
    const answers = [["late"], ["late"], []];
    let slept = 0;
    const result = await askUntil(() => Promise.resolve(answers.shift()), {
      ...quiet,
      attempts: 6,
      sleep: () => {
        slept += 1;
        return Promise.resolve();
      },
    });
    expect(result).toEqual({ wrong: [], asked: 3 });
    expect(slept).toBe(2);
  });

  it("gives up after its attempts, with the last attempt's problems", async () => {
    const result = await askUntil(() => Promise.resolve(["still wrong"]), { ...quiet, attempts: 3 });
    expect(result).toEqual({ wrong: ["still wrong"], asked: 3 });
  });

  it("reports a host that could not be asked, and asks again", async () => {
    let calls = 0;
    const result = await askUntil(
      () => {
        calls += 1;
        return calls === 1 ? Promise.reject(new Error("ECONNRESET")) : Promise.resolve([]);
      },
      { ...quiet, attempts: 2 },
    );
    expect(result).toEqual({ wrong: [], asked: 2 });
    const down = await askUntil(() => Promise.reject(new Error("ECONNRESET")), { ...quiet, attempts: 1 });
    expect(down.wrong).toEqual(["could not be asked: ECONNRESET"]);
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `pnpm exec vitest run scripts/deploy-probe.test.ts`
Expected: FAIL — `Failed to resolve import "./deploy-probe.ts"`.

- [ ] **Step 3: Write the helper**

Create `scripts/deploy-probe.ts`:

```js
// What a Worker's post-deploy probe is made of — `relay-deploy-probe.ts` and
// `share-deploy-probe.ts`, which `release.yml` runs the moment a `wrangler deploy` returns.
//
// A probe is a request any stranger could make and the answer this tree's router gives it:
//
//   { name, path, method?, headers?, body?, status, says?, type?, allowOrigin?, means? }
//
// `says` is a piece of the body; `type` the start of the content type; `allowOrigin` the
// `Access-Control-Allow-Origin` it must carry, or `null` for *must not carry one* (left out, it
// is not looked at); `means` says what a wrong status is known to mean, by status.
//
// **Nothing here holds a token.** The functions are pure but `askAll`, whose `send` a test
// replaces with the Worker's own `fetch` — so each probe's expectation is held to the code it
// will be asked of, in a pull request, before a release asks the host.
import { appendFileSync } from "node:fs";

/** How long one request may take, connection to last byte (`PROBE_TIMEOUT_MS`). */
const TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS ?? 15_000);

export function requestOf(origin, probe) {
  return new Request(`${origin}${probe.path}`, {
    method: probe.method ?? "GET",
    headers: {
      "cache-control": "no-cache",
      ...(probe.body === undefined ? {} : { "content-type": "application/json" }),
      ...probe.headers,
    },
    body: probe.body,
    // A redirect is an answer that is not the expected one, and is reported as one.
    redirect: "manual",
  });
}

export async function answerOf(response) {
  return {
    status: response.status,
    type: response.headers.get("content-type"),
    body: await response.text(),
    allowOrigin: response.headers.get("access-control-allow-origin"),
  };
}

/** What is wrong with an answer, as sentences — none when it is the one the probe expects. */
export function problemsOf(probe, answer) {
  const out = [];
  if (answer.status !== probe.status) {
    const meaning = probe.means?.[answer.status];
    out.push(
      `${probe.name}: answered ${answer.status}, not ${probe.status}${meaning ? ` — ${meaning}` : ""}`,
    );
    return out;
  }
  if (probe.says !== undefined && !answer.body.includes(probe.says)) {
    out.push(`${probe.name}: answered ${answer.status} without "${probe.says}"`);
  }
  if (probe.type !== undefined && !(answer.type ?? "").startsWith(probe.type)) {
    out.push(`${probe.name}: answered as ${answer.type ?? "no content type"}, not ${probe.type}`);
  }
  if ("allowOrigin" in probe && answer.allowOrigin !== probe.allowOrigin) {
    out.push(
      `${probe.name}: access-control-allow-origin is ${answer.allowOrigin ?? "absent"}, not ${probe.allowOrigin ?? "absent"}`,
    );
  }
  return out;
}

/** Ask every probe once, in order; everything that was wrong. */
export async function askAll(
  origin,
  probes,
  send = (request) => fetch(request, { signal: AbortSignal.timeout(TIMEOUT_MS) }),
) {
  const wrong = [];
  for (const probe of probes) {
    wrong.push(...problemsOf(probe, await answerOf(await send(requestOf(origin, probe)))));
  }
  return wrong;
}

/**
 * Ask until an attempt finds nothing wrong, or the attempts run out. The edge may answer with
 * the previous version, a 429 or a 5xx for a moment after a deploy returns: `PROBE_ATTEMPTS`
 * times (6), `PROBE_WAIT_MS` apart (10 s).
 */
export async function askUntil(
  once,
  {
    attempts = Number(process.env.PROBE_ATTEMPTS ?? 6),
    wait = Number(process.env.PROBE_WAIT_MS ?? 10_000),
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log = (line) => console.error(line),
  } = {},
) {
  let wrong = [];
  let asked = 0;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    asked = attempt;
    try {
      wrong = await once();
    } catch (error) {
      wrong = [`could not be asked: ${error.cause?.message ?? error.message}`];
    }
    if (wrong.length === 0) break;
    log(`attempt ${attempt} of ${attempts}: ${wrong.join("; ")}`);
    if (attempt < attempts) await sleep(wait);
  }
  return { wrong, asked };
}

/** Print the outcome, write it to the step summary, and give the exit code. */
export function report(heading, passedDetail, { wrong, asked }) {
  const lines =
    wrong.length === 0
      ? [`### ${heading.passed}`, "", `Asked ${asked} time${asked === 1 ? "" : "s"}: ${passedDetail}`]
      : [
          `### ${heading.failed}`,
          "",
          `After ${asked} attempts:`,
          "",
          ...wrong.map((sentence) => `- ${sentence}`),
        ];
  console.log(lines.join("\n"));
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`);
  }
  return wrong.length === 0 ? 0 : 1;
}
```

- [ ] **Step 4: Run it and see it pass**

Run: `pnpm exec vitest run scripts/deploy-probe.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 5: Write the relay probe's failing test**

Create `scripts/relay-deploy-probe.test.ts`:

```js
// The relay's post-deploy probes, held to the relay: every one is asked of this tree's own
// `fetch`, over the fake D1, and has to be answered as the probe expects. So a route whose
// answer changes fails here, in the pull request that changes it — not at a release, with the
// new relay already live. The answers are also the ones `docs/reference/hosted-relay-deploy.md`
// step 0 recorded from the host on 2026-10-01 and 2026-10-04.
import { describe, expect, it } from "vitest";
import worker from "../infrastructure/relay/src/index.ts";
import { fakeEnvOver, fakeTables } from "../infrastructure/relay/src/fakeD1.ts";
import relayWrangler from "../infrastructure/relay/wrangler.jsonc?raw";
import { askAll } from "./deploy-probe.ts";
import { APP, PROBES, RELAY } from "./relay-deploy-probe.ts";

const limiter = { limit: () => Promise.resolve({ success: true }) };
const env = {
  ...fakeEnvOver({
    ...fakeTables({ groups: [] }),
    group_keys: [],
    group_devices: [],
    pairing_rendezvous: [],
  }),
  RELAY_BASE: RELAY,
  RELAY_HMAC_KEY: "test-signing-key",
  PATREON_WEBHOOK_SECRET: "test-webhook-secret",
  PATREON_CLIENT_ID: "client",
  PATREON_CLIENT_SECRET: "secret",
  PATREON_CAMPAIGN_ID: "1",
  RL_CLAIM: limiter,
  RL_MINT: limiter,
  RL_READ: limiter,
  APP_ORIGINS: APP,
};

describe("the relay's probes", () => {
  it.each(PROBES.map((probe) => [probe.name, probe]))("%s", async (_name, probe) => {
    expect(await askAll(RELAY, [probe], (request) => worker.fetch(request, env))).toEqual([]);
  });

  it("ask the address the Worker is deployed at, from the origin it allows", () => {
    expect(relayWrangler).toContain(`"RELAY_BASE": "${RELAY}"`);
    expect(relayWrangler).toContain(`"APP_ORIGINS": "${APP}"`);
  });

  it("are named apart, and pair each origin probe with a control", () => {
    expect(new Set(PROBES.map((probe) => probe.name)).size).toBe(PROBES.length);
    const origins = PROBES.filter((probe) => "allowOrigin" in probe);
    expect(origins.filter((probe) => probe.allowOrigin === APP)).toHaveLength(2);
    expect(origins.filter((probe) => probe.allowOrigin === null)).toHaveLength(2);
  });

  // Six attempts must fit under the limiter the unauthenticated doors share (`RL_MINT`, 30 a
  // minute for one address): a probe that trips it reads its own 429s as a failed deploy.
  it("spend fewer than five requests an attempt on the token door", () => {
    expect(PROBES.filter((probe) => probe.path === "/token").length).toBeLessThan(5);
  });
});
```

- [ ] **Step 6: Run it and see it fail**

Run: `pnpm exec vitest run scripts/relay-deploy-probe.test.ts`
Expected: FAIL — `Failed to resolve import "./relay-deploy-probe.ts"`.

- [ ] **Step 7: Write the relay probe**

Create `scripts/relay-deploy-probe.ts`:

```js
// Is the relay up and routing, the moment `wrangler deploy` returned? — asked by
// `release.yml`'s `relay-deploy`.
//
//   node scripts/relay-deploy-probe.ts [origin]     # origin: the relay's own address
//
// The probes are `docs/reference/hosted-relay-deploy.md`'s step 0, less the two that open a
// socket: ten requests a stranger could make, each answered before any Durable Object, and each
// with the answer this tree's router gives (`relay-deploy-probe.test.ts` asks the router).
//
// **What it proves, and what it does not.** That the Worker answers, that the tables its doors
// read are there (a missing one is a 500, and the probe says which), and that a page at the web
// app's origin is allowed in. **Not which version is live**: the runbook records that no request
// without a credential tells one deploy from the next, so that rests on `wrangler deploy`
// exiting zero, and the version id it prints is in the job's log.
//
// It deploys nothing and holds no token.
import { pathToFileURL } from "node:url";
import { askAll, askUntil, report } from "./deploy-probe.ts";

/** `RELAY_BASE` in `infrastructure/relay/wrangler.jsonc`, and in every binary. */
export const RELAY = "https://mtg-grimoire-relay.denmark-east.workers.dev";
/** The one origin a page may ask from (`APP_ORIGINS`, same file). */
export const APP = "https://mtg-grimoire.app";

/** Well-formed and unknown: 64 hex, which is what gets a request as far as the D1 read. */
const UNKNOWN = { authorization: `Bearer ${"ab".repeat(32)}` };
const PREFLIGHT = { "access-control-request-method": "POST" };

export const PROBES = [
  {
    name: "the token door refuses an empty request",
    method: "POST",
    path: "/token",
    body: "{}",
    status: 400,
    says: "malformed token request",
    means: { 404: "the baseline Worker is deployed, with no entitlement routes" },
  },
  {
    name: "the key store reads D1 for a credential it does not know",
    path: "/g/abc/keys?device=deadbeef",
    headers: UNKNOWN,
    status: 401,
    means: { 500: "the router is live and the `group_keys` table is missing" },
  },
  {
    name: "the refresh door reads the device",
    method: "POST",
    path: "/token",
    body: '{"refresh":"x"}',
    status: 400,
    says: "that is not a device id",
  },
  {
    name: "the refresh door, with a device, refuses the secret",
    method: "POST",
    path: "/token",
    body: '{"refresh":"x","device":"deadbeef"}',
    status: 401,
  },
  {
    name: "the pairing rendezvous has its table",
    path: `/p/${"0".repeat(32)}/offer`,
    status: 404,
    says: "nothing there",
    means: { 500: "the route is live and the `pairing_rendezvous` table is missing" },
  },
  {
    name: "the key store reads the epoch",
    path: "/g/abc/keys?device=deadbeef&epoch=x",
    headers: UNKNOWN,
    status: 400,
    says: "that is not an epoch",
  },
  {
    name: "a page's pre-flight is answered",
    method: "OPTIONS",
    path: "/token",
    headers: { origin: APP, ...PREFLIGHT },
    status: 204,
    allowOrigin: APP,
  },
  {
    name: "a foreign origin's pre-flight is not",
    method: "OPTIONS",
    path: "/token",
    headers: { origin: "https://example.com", ...PREFLIGHT },
    status: 405,
    allowOrigin: null,
  },
  {
    name: "a page can read a refusal",
    path: "/g/abc/pull",
    headers: { origin: APP },
    status: 401,
    allowOrigin: APP,
  },
  {
    name: "a foreign origin cannot",
    path: "/g/abc/pull",
    headers: { origin: "https://example.com" },
    status: 401,
    allowOrigin: null,
  },
];

async function main() {
  const [origin = RELAY] = process.argv.slice(2);
  const result = await askUntil(() => askAll(origin, PROBES));
  process.exitCode = report(
    { passed: `${origin} answers as this relay`, failed: `${origin} does not answer as this relay` },
    `all ${PROBES.length} probes of \`docs/reference/hosted-relay-deploy.md\` step 0 were answered as this tree's router answers them. Which version is live is \`wrangler deploy\`'s to say, in this job's log.`,
    result,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
```

- [ ] **Step 8: Run it and see it pass**

Run: `pnpm exec vitest run scripts/relay-deploy-probe.test.ts`
Expected: PASS, 13 tests.

**If a probe is red, do not edit its expectation to make it green.** The expectations are the host's recorded answers. Find out why this tree's router answers differently (a table the fake does not hold, a header the request lacks), fix the test's `env` or the request — and if the router really answers otherwise, stop and report it: the runbook is then wrong about production.

- [ ] **Step 9: Run it by hand against a local relay**

```bash
cd infrastructure/relay
node ../wrangler/node_modules/wrangler/bin/wrangler.js dev --local --port 8799 --var APP_ORIGINS:https://mtg-grimoire.app
```

(as a background command), then from the repository root:

```bash
PROBE_ATTEMPTS=1 node scripts/relay-deploy-probe.ts http://127.0.0.1:8799; echo "exit $?"
```

Expected: the heading `### http://127.0.0.1:8799 does not answer as this relay` listing only probes that read D1 (the local database has no tables), or `answers as this relay` — either shows `main` runs under plain Node and reports by name. Stop the dev server. Record what it printed in `docs/reference/ci-and-releases.md` in Task 5.

---

### Task 3: The share Worker bundles without a workspace, and its probe

**Files:**
- Modify: `infrastructure/share-worker/wrangler.jsonc` (add `alias`)
- Create: `scripts/share-worker-alias.test.ts`
- Create: `scripts/share-deploy-probe.ts`, `scripts/share-deploy-probe.test.ts`

**Interfaces:**
- Consumes: `askAll`, `askUntil`, `report`, `answerOf`, `requestOf` from `scripts/deploy-probe.ts` (Task 2).
- Produces: `SHARE`, `PROBES`, `VIEWER`, `viewerProblems(built: string, answered: { status: number, body: string }): string[]` from `scripts/share-deploy-probe.ts`. Task 4's job runs `node scripts/share-deploy-probe.ts apps/share/dist-share`.

- [ ] **Step 1: Write the alias's failing test**

Create `scripts/share-worker-alias.test.ts` (in `scripts/`, as plain JavaScript: the share Worker's own type-check program declares neither `?raw` nor `import.meta.glob`):

```js
// What the share Worker's script imports, in a job that installs only wrangler —
// `release.yml`'s `share-deploy` checks the repository out and runs no pnpm, so nothing links
// `@grimoire/relay` into that folder there. `infrastructure/app-worker/src/hosting.test.ts`
// holds the same rule for the web app's Worker.
import { describe, expect, it } from "vitest";
import wranglerText from "../infrastructure/share-worker/wrangler.jsonc?raw";
import tokenText from "../infrastructure/relay/src/token.ts?raw";

const OWN = import.meta.glob("/infrastructure/share-worker/src/*.ts", {
  query: "?raw",
  import: "default",
  eager: true,
});

/** The config as a value: comments and trailing commas out, strings left alone. */
function jsonc(text) {
  const bare = text
    .replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (_, string) => string ?? "")
    .replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(bare);
}

/** Every specifier a source names — `from "x"`, `import "x"`, `import("x")` — comments out. */
const named = (source) =>
  [
    ...source
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1")
      .matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["']([^"']+)["']/g),
  ].map(([, spec]) => spec);

describe("what the share Worker's script imports, in a job that installs only wrangler", () => {
  /** The script: the folder's modules by `./name.ts`, less the tests and the declarations. */
  const script = Object.entries(OWN)
    .map(([path, source]) => [`./${path.slice(path.lastIndexOf("/") + 1)}`, source])
    .filter(([path]) => !/\.(?:test|d)\.ts$/.test(path));

  it("is a file beside it, or a module `wrangler.jsonc` gives a path for", () => {
    const paths = script.map(([path]) => path).sort();
    expect(paths).toContain("./index.ts");
    const specs = script.flatMap(([, source]) => named(source));
    for (const spec of specs.filter((s) => s.startsWith("."))) {
      expect(paths, spec).toContain(`${spec}.ts`);
    }
    const outside = [...new Set(specs.filter((spec) => !spec.startsWith(".")))];
    expect(outside).toEqual(["@grimoire/relay/src/token"]);
    // An exact module, not the package: wrangler matches an alias against the whole specifier.
    expect(jsonc(wranglerText).alias).toEqual({
      "@grimoire/relay/src/token": "../relay/src/token.ts",
    });
  });

  it("reaches a module that imports nothing of its own", () => {
    expect(tokenText).toContain("export async function verify");
    expect(named(tokenText)).toEqual([]);
  });

  it("reads a config with comments, a URL in a string and a trailing comma", () => {
    expect(jsonc('{\n  // a comment\n  "a": "https://x.example", /* b */\n  "c": [1, 2,],\n}')).toEqual({
      a: "https://x.example",
      c: [1, 2],
    });
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `pnpm exec vitest run scripts/share-worker-alias.test.ts`
Expected: FAIL — `alias` is `undefined`, not the one pair.

- [ ] **Step 3: Add the alias**

In `infrastructure/share-worker/wrangler.jsonc`, under the `"main": "src/index.ts",` line, add:

```jsonc
  // The script's one import of another package's module, as a path wrangler follows with
  // nothing installed. `release.yml`'s `share-deploy` checks the repository out and installs
  // wrangler from `infrastructure/wrangler`'s lockfile — no pnpm, so no `node_modules` link for
  // `@grimoire/relay` — and without this line the bundle stops at "Could not resolve". An exact
  // module, not the package: wrangler matches an alias against the whole specifier
  // (`infrastructure/app-worker/wrangler.jsonc`, measured 2026-10-08). `scripts/share-worker-alias.test.ts`
  // holds the pair, and holds the module it points at to importing nothing.
  "alias": { "@grimoire/relay/src/token": "../relay/src/token.ts" },
```

- [ ] **Step 4: Run it and see it pass, then prove the bundle resolves with no workspace link**

Run: `pnpm exec vitest run scripts/share-worker-alias.test.ts`
Expected: PASS, 3 tests.

Then the fact the test cannot hold — that wrangler bundles the script through the alias. `--dry-run` uploads nothing and needs no token:

```bash
pnpm share:build
ls apps/share/dist-share/assets/share.js
cd infrastructure/share-worker
node ../wrangler/node_modules/wrangler/bin/wrangler.js deploy --dry-run --outdir "$SCRATCH/share-dry"; echo "exit $?"
```

Expected: `exit 0`, and a bundle in `$SCRATCH/share-dry`. To prove it is the alias and not the workspace link doing it, rename the link and run again: `mv node_modules/@grimoire/relay node_modules/@grimoire/relay.off`, the same `deploy --dry-run` (expect `exit 0`), then `mv node_modules/@grimoire/relay.off node_modules/@grimoire/relay`. Do the same `deploy --dry-run` once from `infrastructure/relay` (expect `exit 0`): it has never been bundled by a job with no install.

If `ls` finds no `share.js` after `pnpm share:build`, this worktree's `node_modules` is stale: run `pnpm install` and build again (the `worktree-setup` skill).

- [ ] **Step 5: Write the share probe's failing test**

Create `scripts/share-deploy-probe.test.ts`:

```js
// The share Worker's post-deploy probes, held to the Worker: each is asked of this tree's own
// `fetch` over the fake D1 (`infrastructure/share-worker/README.md`, "Deploying", has the same
// five as `curl`s, and the answers the host gave on 2026-10-01). The fifth — the viewer's
// script — is served by the assets layer and never reaches the Worker, so its comparison is
// held as a pure function.
import { describe, expect, it } from "vitest";
import worker from "../infrastructure/share-worker/src/index.ts";
import { fakeEnvOver } from "../infrastructure/relay/src/fakeD1.ts";
import shareWrangler from "../infrastructure/share-worker/wrangler.jsonc?raw";
import pageTs from "../infrastructure/share-worker/src/page.ts?raw";
import { askAll } from "./deploy-probe.ts";
import { PROBES, SHARE, VIEWER, viewerProblems } from "./share-deploy-probe.ts";

const refused = () => Promise.reject(new Error("no probe reaches the bucket or the assets"));
const env = {
  ...fakeEnvOver({ entitlements: [], shares: [] }),
  RELAY_HMAC_KEY: "test-signing-key",
  SHARE_BASE: SHARE,
  SHARES: { put: refused, get: refused, delete: refused },
  ASSETS: { fetch: refused },
};

describe("the share Worker's probes", () => {
  it.each(PROBES.map((probe) => [probe.name, probe]))("%s", async (_name, probe) => {
    expect(await askAll(SHARE, [probe], (request) => worker.fetch(request, env))).toEqual([]);
  });

  it("ask the address the Worker is deployed at, for the script its pages name", () => {
    expect(shareWrangler).toContain(`"SHARE_BASE": "${SHARE}"`);
    expect(VIEWER).toBe("/assets/share.js");
    expect(pageTs).toContain(VIEWER);
  });

  it("says a missing signing key is what a 500 at the gate means", () => {
    const gate = PROBES.find((probe) => probe.headers?.authorization === "Bearer nonsense");
    expect(gate.means[500]).toMatch(/RELAY_HMAC_KEY/);
  });
});

describe("viewerProblems", () => {
  it("finds none when the address serves the bundle's script", () => {
    expect(viewerProblems("built();", { status: 200, body: "built();" })).toEqual([]);
  });

  it("names a script that is not served", () => {
    expect(viewerProblems("built();", { status: 404, body: "" })).toEqual([
      "/assets/share.js answered 404, not 200",
    ]);
  });

  it("names a script that is the previous deploy's", () => {
    expect(viewerProblems("built();", { status: 200, body: "older();" })).toEqual([
      "/assets/share.js is not the bundle's — the previous deploy is still being served",
    ]);
  });

  it("refuses an empty bundle before it asks whether the address serves it", () => {
    expect(viewerProblems("", { status: 200, body: "" })).toEqual([
      "the bundle's assets/share.js is empty",
    ]);
  });
});
```

- [ ] **Step 6: Run it and see it fail**

Run: `pnpm exec vitest run scripts/share-deploy-probe.test.ts`
Expected: FAIL — `Failed to resolve import "./share-deploy-probe.ts"`.

- [ ] **Step 7: Write the share probe**

Create `scripts/share-deploy-probe.ts`:

```js
// Is the share Worker serving the build that was just deployed? — asked by `release.yml`'s
// `share-deploy` the moment `wrangler deploy` returns.
//
//   node scripts/share-deploy-probe.ts <apps/share/dist-share> [origin]
//
// `infrastructure/share-worker/README.md`'s five, "Deploying": four requests of the Worker —
// a page for a share nobody published, the gate with no bearer, the gate with a malformed one
// (the signing key's tell: 500 means it is unset), an unknown gated route — and the viewer's
// script, **byte for byte against the bundle**. That last one is the probe that says *this*
// build is what the address serves; the other four pass on any deploy since the first.
//
// It deploys nothing and holds no token.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { answerOf, askAll, askUntil, report, requestOf } from "./deploy-probe.ts";

/** `SHARE_BASE` in `infrastructure/share-worker/wrangler.jsonc`, and in every binary. */
export const SHARE = "https://mtg-grimoire-share.denmark-east.workers.dev";
/** The one file every shared page names (`src/page.ts`), pinned and not hashed by the build. */
export const VIEWER = "/assets/share.js";

export const PROBES = [
  {
    name: "a share nobody published is a page that says so",
    path: "/s/AAAAAAAAAAAAAAAA",
    status: 404,
    type: "text/html",
    means: { 500: "the `shares` table is missing from the database" },
  },
  {
    name: "the gate refuses a request with no bearer",
    path: "/g/abc/shares",
    status: 401,
    says: "unauthorized",
  },
  {
    name: "the gate holds the relay's signing key",
    path: "/g/abc/shares",
    headers: { authorization: "Bearer nonsense" },
    status: 401,
    means: { 500: "`RELAY_HMAC_KEY` is not set on this Worker" },
  },
  {
    name: "an unknown gated route is not found",
    path: "/g/abc/bogus",
    status: 404,
    says: "not found",
  },
];

/** What is wrong with the viewer's script as served — none when it is the bundle's. */
export function viewerProblems(built, answered) {
  if (built === "") return ["the bundle's assets/share.js is empty"];
  if (answered.status !== 200) return [`${VIEWER} answered ${answered.status}, not 200`];
  if (answered.body !== built) {
    return [`${VIEWER} is not the bundle's — the previous deploy is still being served`];
  }
  return [];
}

async function main() {
  const [dist, origin = SHARE] = process.argv.slice(2);
  if (!dist) {
    console.error("usage: node scripts/share-deploy-probe.ts <apps/share/dist-share> [origin]");
    process.exitCode = 2;
    return;
  }
  const built = readFileSync(join(dist, "assets", "share.js"), "utf8");
  const result = await askUntil(async () => {
    const wrong = await askAll(origin, PROBES);
    const viewer = await answerOf(
      await fetch(requestOf(origin, { name: "the viewer", path: VIEWER, status: 200 }), {
        signal: AbortSignal.timeout(Number(process.env.PROBE_TIMEOUT_MS ?? 15_000)),
      }),
    );
    return [...wrong, ...viewerProblems(built, viewer)];
  });
  process.exitCode = report(
    { passed: `${origin} serves this build`, failed: `${origin} does not serve this build` },
    `the four probes of \`infrastructure/share-worker/README.md\` were answered as this tree's Worker answers them, and \`${VIEWER}\` is the bundle's byte for byte.`,
    result,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
```

- [ ] **Step 8: Run it and see it pass**

Run: `pnpm exec vitest run scripts/share-deploy-probe.test.ts`
Expected: PASS, 10 tests.

The rule of Task 2, Step 8 holds here too: a red probe is investigated, never re-pointed. If `worker.fetch` needs a third argument for a probed route, pass `{ waitUntil: () => {} }` in the test's `send`.

---

### Task 4: The three jobs, and the fence around them

**Files:**
- Modify: `.github/workflows/release.yml` (the header comment's diagram; new jobs `share`, `relay-deploy`, `share-deploy` between `web` and `web-deploy`; `web-deploy`'s `needs` and comment; `publish`'s `needs` and comment)
- Modify: `.github/workflows/ci.yml` (`frontend` job, after the `pnpm build` step)
- Modify: `scripts/release-rule.test.ts`

**Interfaces:**
- Consumes: `node scripts/relay-deploy-probe.ts` (Task 2), `node scripts/share-deploy-probe.ts apps/share/dist-share` (Task 3), the two bindings' `migrations_dir` (Task 1).
- Produces: jobs `share`, `relay-deploy`, `share-deploy`; artifact `share-bundle`; step id `token` with output `present` in both deploy jobs. Piece B adds `play-upload` to `publish`'s `needs` after `web-deploy`.

- [ ] **Step 1: Extend the fence first (it fails until the workflow follows)**

All edits are in `scripts/release-rule.test.ts`.

**(a)** Under `const CLOUDFLARE_SECRETS = …`, add:

```js
/** What the two jobs that deploy the relay and the share Worker read: a token of their own. */
const INFRA_SECRETS = ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_INFRA_API_TOKEN"];
/** The three jobs that start wrangler, with the Worker's folder each one deploys from. */
const DEPLOYS = {
  "relay-deploy": "infrastructure/relay",
  "share-deploy": "infrastructure/share-worker",
  "web-deploy": "infrastructure/app-worker",
};
const WRANGLER = "node ../wrangler/node_modules/wrangler/bin/wrangler.js";
```

**(b)** Replace `MAY_READ` with (the key order is the jobs' order in the file):

```js
const MAY_READ = {
  "release-please": ["GITHUB_TOKEN"],
  build: ["GITHUB_TOKEN"],
  android: [],
  "android-sign": [...ANDROID_SECRETS],
  web: [],
  share: [],
  "relay-deploy": [...INFRA_SECRETS, "GITHUB_TOKEN"],
  "share-deploy": [...INFRA_SECRETS, "GITHUB_TOKEN"],
  "web-deploy": [...CLOUDFLARE_SECRETS, "GITHUB_TOKEN"],
  publish: ["GITHUB_TOKEN"],
};
```

**(c)** Above `const RUNS = {`, add the two builders the new jobs' lists are made with — the two jobs' first two steps differ by a few words, and the words are arguments here so each list is still every line, to the letter:

```js
/** The first step of a job that deploys with the infra token: the token alone decides. */
const infraAsk = (heading, still, nothing, runbook) => [
  "set -euo pipefail",
  'if [ "$HAS_TOKEN" != true ]; then',
  'echo "present=false" >> "$GITHUB_OUTPUT"',
  "{",
  `echo "### ${heading} — not deployed"`,
  "echo",
  `echo "**${still}** The \\\`release\\\` environment holds no"`,
  `echo "\\\`CLOUDFLARE_INFRA_API_TOKEN\\\`, so this release ${nothing}"`,
  `echo "Deploy $TAG by hand — \\\`${runbook}\\\`."`,
  "echo",
  'echo "\\`docs/reference/ci-and-releases.md\\`, *What only the owner can do*, has the commands."',
  '} >> "$GITHUB_STEP_SUMMARY"',
  "exit 0",
  "fi",
  'if [ "$HAS_ACCOUNT" != true ]; then',
  'echo "CLOUDFLARE_INFRA_API_TOKEN is set in the release environment and CLOUDFLARE_ACCOUNT_ID is not." >&2',
  "echo \"Set both — docs/reference/ci-and-releases.md, 'What only the owner can do'.\" >&2",
  "exit 1",
  "fi",
  'echo "present=true" >> "$GITHUB_OUTPUT"',
];
/** The step that refuses a tag older than the newest published release, by what it would deploy. */
const refuseOlder = (what) => [
  "set -euo pipefail",
  'latest=$(gh api "repos/$REPO/releases/latest" --jq .tag_name)',
  'newest=$(printf \'%s\\n%s\\n\' "$latest" "$TAG" | sort -V | tail -1)',
  'echo "this run\'s tag: $TAG; the newest published release: $latest"',
  'if [ "$newest" != "$TAG" ]; then',
  `echo "$latest is published and is newer than $TAG: deploying $TAG's ${what} would put older code behind it. Nothing was deployed." >&2`,
  "exit 1",
  "fi",
];
```

**(d)** Inside `RUNS`, before `"web-deploy": [`, add:

```js
  "relay-deploy": [
    // Is there a token to deploy with
    infraAsk(
      "Relay",
      "The relay still runs the previous deploy.",
      "applied no migration and deployed nothing to it.",
      "docs/reference/hosted-relay-deploy.md",
    ),
    // Refuse to deploy an older release over a newer one
    refuseOlder("relay"),
    // Install the lockfile's packages, running no script
    ["npm ci --ignore-scripts"],
    // Apply the database's pending migrations
    [`${WRANGLER} d1 migrations apply mtg-grimoire-relay --remote`],
    // Deploy the Worker
    [`${WRANGLER} deploy`],
    // Ask the host
    ["node scripts/relay-deploy-probe.ts"],
  ],
  "share-deploy": [
    // Is there a token to deploy with
    infraAsk(
      "Share Worker",
      "The share Worker still runs the previous deploy.",
      "applied no migration and deployed nothing to it.",
      "infrastructure/share-worker/README.md",
    ),
    // Refuse to deploy an older release over a newer one
    refuseOlder("share Worker"),
    // Check the bundle arrived whole
    [
      "set -euo pipefail",
      '[ -s apps/share/dist-share/assets/share.js ] || { echo "apps/share/dist-share/assets/share.js is missing or empty" >&2; exit 1; }',
    ],
    // Install the lockfile's packages, running no script
    ["npm ci --ignore-scripts"],
    // Apply the database's pending migrations
    [`${WRANGLER} d1 migrations apply mtg-grimoire-relay --remote`],
    // Deploy the Worker
    [`${WRANGLER} deploy`],
    // Ask the host
    ["node scripts/share-deploy-probe.ts apps/share/dist-share"],
  ],
```

**(e)** Replace the test `has the seven jobs, chained as the rule needs` with:

```js
  it("has the ten jobs, chained as the rule needs", () => {
    expect(Object.keys(jobs)).toEqual([
      "release-please",
      "build",
      "android",
      "android-sign",
      "web",
      "share",
      "relay-deploy",
      "share-deploy",
      "web-deploy",
      "publish",
    ]);
    expect(needsOf(jobs.build)).toEqual(["release-please"]);
    expect(needsOf(jobs.android)).toEqual(["release-please"]);
    expect(needsOf(jobs["android-sign"])).toEqual(["release-please", "android"]);
    expect(needsOf(jobs.web)).toEqual(["release-please"]);
    expect(needsOf(jobs.share)).toEqual(["release-please"]);
    // A deploy is live the moment it returns, so the first of them goes after everything that
    // can still fail to build…
    expect(needsOf(jobs["relay-deploy"])).toEqual([
      "release-please",
      "build",
      "android-sign",
      "web",
      "share",
    ]);
    // …and they go one behind the other: the relay, whose tokens the share Worker verifies and
    // whose CORS answer the web app's page waits on; the share Worker; then the page.
    expect(needsOf(jobs["share-deploy"])).toEqual(["release-please", "share", "relay-deploy"]);
    expect(needsOf(jobs["web-deploy"])).toEqual([
      "release-please",
      "build",
      "android-sign",
      "web",
      "share-deploy",
    ]);
    expect(needsOf(jobs.publish)).toEqual([
      "release-please",
      "build",
      "android-sign",
      "relay-deploy",
      "share-deploy",
      "web-deploy",
    ]);
  });
```

**(f)** In `takes what it holds from the `release` environment…`, the expected list becomes the four jobs, in file order; rename the test to end `in those four jobs and no other`:

```js
    expect(environments).toEqual([
      ["android-sign", ["    environment: release"]],
      ["relay-deploy", ["    environment: release"]],
      ["share-deploy", ["    environment: release"]],
      ["web-deploy", ["    environment: release"]],
    ]);
```

**(g)** The deadline list becomes `["android", "android-sign", "web", "share", "relay-deploy", "share-deploy", "web-deploy"]`.

**(h)** In the `it.each` titled `%s builds nothing, and runs only what is listed here`, add two rows:

```js
    ["relay-deploy", ["actions/checkout", "actions/setup-node"]],
    ["share-deploy", ["actions/checkout", "actions/download-artifact", "actions/setup-node"]],
```

**(i)** Replace the test `sets Node up in `web-deploy` with caching off by name, and with nothing else` with one over all three:

```js
  it.each(Object.keys(DEPLOYS))("%s sets Node up with caching off by name, and with nothing else", (name) => {
    const node = stepsOf(jobs[name]).filter((step) => /^uses: actions\/setup-node@/.test(step));
    expect(node).toHaveLength(1);
    expect(node[0].trimEnd().split("\n").slice(1)).toEqual([
      "        if: steps.token.outputs.present == 'true'",
      "        with:",
      "          node-version-file: .nvmrc",
      "          package-manager-cache: false",
    ]);
  });

  it("runs no Node in `android-sign`, so there is no step of it to hold there", () => {
    expect(jobs["android-sign"]).not.toMatch(/setup-node/);
  });
```

Keep the comment that stood above the old test, above the new `it.each`.

**(j)** The `never sees pnpm` list becomes `["android-sign", "relay-deploy", "share-deploy", "web-deploy"]`.

**(k)** After the `it.each` titled `%s asks whether its secrets are set, and does nothing without them`, add:

```js
  // **The token alone decides, for these two.** `CLOUDFLARE_ACCOUNT_ID` is in the environment
  // already — `web-deploy` reads it — so "one of two is a mistake" would fail every release
  // until the owner made the second token. No token is a job that deploys nothing and says so;
  // a token with no account is the mistake.
  it.each(["relay-deploy", "share-deploy"])("%s asks for the token alone, and does nothing without it", (name) => {
    const [checkout, ask, ...rest] = stepsOf(jobs[name]);
    expect(checkout).toMatch(/^uses: actions\/checkout@/);
    expect(checkout).not.toMatch(/^ {8}(?:if|env):/m);
    expect(ask).toMatch(/^ {8}id: token$/m);
    expect(secretsOf(ask)).toEqual(INFRA_SECRETS);
    // Told whether each is set, never what it is.
    expect(ask.match(/secrets\.[A-Z0-9_]+/g)).toHaveLength(2);
    expect(ask.match(/\$\{\{ secrets\.[A-Z0-9_]+ != '' \}\}/g)).toHaveLength(2);
    expect(ask).toContain("HAS_TOKEN: ${{ secrets.CLOUDFLARE_INFRA_API_TOKEN != '' }}");
    expect(ask).toContain("HAS_ACCOUNT: ${{ secrets.CLOUDFLARE_ACCOUNT_ID != '' }}");
    // No token: `present=false`, the summary, and a green end — before the account is looked at.
    const lines = runsOf(ask)[0];
    const at = (line) => lines.indexOf(line);
    expect(at('if [ "$HAS_TOKEN" != true ]; then')).toBe(1);
    expect(at("exit 0")).toBeGreaterThan(at('} >> "$GITHUB_STEP_SUMMARY"'));
    expect(at('if [ "$HAS_ACCOUNT" != true ]; then')).toBeGreaterThan(at("exit 0"));
    expect(at("exit 1")).toBeGreaterThan(at('if [ "$HAS_ACCOUNT" != true ]; then'));
    expect(lines.at(-1)).toBe('echo "present=true" >> "$GITHUB_OUTPUT"');
    expect(lines.filter((line) => line.includes("present=true"))).toHaveLength(1);
    for (const step of rest) {
      expect(step).toMatch(/^ {8}if: steps\.token\.outputs\.present == 'true'$/m);
    }
    // The token reaches two steps and no third: the migrations and the deploy, both wrangler's.
    const holding = rest.filter((step) => secretsOf(step).length > 0 && !step.includes("GITHUB_TOKEN"));
    expect(holding).toHaveLength(2);
    for (const step of holding) {
      expect(secretsOf(step)).toEqual(INFRA_SECRETS);
      expect(step).toContain("CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_INFRA_API_TOKEN }}");
      expect(step).toMatch(/^ {8}run: node \.\.\/wrangler\/node_modules\/wrangler\/bin\/wrangler\.js /m);
    }
  });

  it("builds the share viewer at the tag, as every pull request does, and hands it on", () => {
    const share = stepsOf(jobs.share);
    const at = (needle) => share.findIndex((step) => step.includes(needle));
    expect(at("run: pnpm share:build")).toBeGreaterThan(at("run: pnpm install --frozen-lockfile"));
    expect(at("apps/share/dist-share/assets/share.js")).toBeGreaterThan(at("run: pnpm share:build"));
    expect(at("name: share-bundle")).toBeGreaterThan(at("apps/share/dist-share/assets/share.js"));
    expect(share[at("name: share-bundle")]).toContain("path: apps/share/dist-share/");
    expect(share[at("name: share-bundle")]).toContain("if-no-files-found: error");
    expect(secretRefs(jobs.share)).toEqual([]);
    // The same command, in the leg of `ci.yml` that builds: a pull request that breaks the
    // viewer is red before a tag is.
    expect(ciYml).toMatch(/^ {8}run: pnpm share:build$/m);
  });

  it("applies the migrations, deploys and asks the host, in that order, in both Worker jobs", () => {
    const orderOf = (name, needles) => {
      const steps = stepsOf(jobs[name]);
      const order = needles.map((needle) => steps.findIndex((s) => s.includes(needle)));
      expect(order[0], name).toBeGreaterThan(-1);
      expect(order, name).toEqual([...order].sort((a, b) => a - b));
      expect(new Set(order).size, name).toBe(order.length);
    };
    orderOf("relay-deploy", [
      'gh api "repos/$REPO/releases/latest"',
      "run: npm ci --ignore-scripts",
      `run: ${WRANGLER} d1 migrations apply mtg-grimoire-relay --remote`,
      `run: ${WRANGLER} deploy`,
      "run: node scripts/relay-deploy-probe.ts",
    ]);
    orderOf("share-deploy", [
      'gh api "repos/$REPO/releases/latest"',
      "name: share-bundle",
      "[ -s apps/share/dist-share/assets/share.js ]",
      "run: npm ci --ignore-scripts",
      `run: ${WRANGLER} d1 migrations apply mtg-grimoire-relay --remote`,
      `run: ${WRANGLER} deploy`,
      "run: node scripts/share-deploy-probe.ts apps/share/dist-share",
    ]);
    // What `share-deploy` uploads is what `share` built: one artifact name, one folder.
    expect(stepsOf(jobs["share-deploy"]).find((s) => s.includes("name: share-bundle"))).toContain(
      "path: apps/share/dist-share",
    );
  });
```

**(l)** Replace the test `refuses to deploy a release older than the newest published one` with one over all three:

```js
  it.each(Object.keys(DEPLOYS))("%s refuses to deploy a release older than the newest published one", (name) => {
    const refusal = stepsOf(jobs[name]).find((s) => s.includes("releases/latest"));
    expect(refusal).toMatch(
      /newest=\$\(printf '%s\\n%s\\n' "\$latest" "\$TAG" \| sort -V \| tail -1\)/,
    );
    expect(refusal).toMatch(/if \[ "\$newest" != "\$TAG" \]; then[\s\S]*exit 1/);
    expect(refusal).toMatch(/^ {8}if: steps\.token\.outputs\.present == 'true'$/m);
  });
```

**(m)** In `describe("deploys, across every workflow", …)`, replace the test `runs wrangler once: …` (and the comment above it) with:

```js
  // **Three jobs start wrangler, each from its own Worker's folder** (the owner's decision,
  // 2026-10-11: a release deploys everything). Five commands, and these are all of them: two
  // `d1 migrations apply --remote` and three `deploy`. A sixth line, a `secret`, a `rollback`,
  // a `d1 execute --remote`, is a line that is not here.
  it("runs wrangler five times, in the three deploy jobs, from each Worker's own folder", () => {
    const wrangler = lines.filter(({ line }) => /\bwrangler\b/.test(line));
    const release = "/.github/workflows/release.yml";
    const install = { path: release, line: "        working-directory: infrastructure/wrangler" };
    const migrate = {
      path: release,
      line: `        run: ${WRANGLER} d1 migrations apply mtg-grimoire-relay --remote`,
    };
    const deploy = { path: release, line: `        run: ${WRANGLER} deploy` };
    expect(wrangler).toEqual([
      {
        // Not a run of it: the `web` job's step that *installs* the same lockfile, for the sync
        // smoke (phase 6, step 6.3). The test below holds what that run may ask of it.
        path: "/.github/workflows/ci.yml",
        line: "      - name: Install wrangler from its lockfile",
      },
      {
        path: "/.github/workflows/ci.yml",
        line: "        run: npm ci --ignore-scripts --prefix infrastructure/wrangler",
      },
      // relay-deploy
      install,
      migrate,
      deploy,
      // share-deploy
      install,
      migrate,
      deploy,
      // web-deploy: no database, so no migration.
      install,
      deploy,
    ]);
    for (const [name, folder] of Object.entries(DEPLOYS)) {
      const steps = stepsOf(jobsOf(releaseYml)[name]);
      const runs = steps.filter((s) => /^ {8}run: node \.\.\/wrangler\//m.test(s));
      expect(runs.length, name).toBe(name === "web-deploy" ? 1 : 2);
      for (const step of runs) {
        // From the Worker's folder, where `wrangler.jsonc` is…
        expect(step, name).toMatch(new RegExp(`^ {8}working-directory: ${folder}$`, "m"));
        expect(secretsOf(step), name).toEqual(
          name === "web-deploy" ? CLOUDFLARE_SECRETS : INFRA_SECRETS,
        );
        expect(step, name).toContain('WRANGLER_SEND_METRICS: "false"');
      }
      // …and the install is the step before the first of them, in the tool's folder, with
      // **nothing in its environment**: what it installs is not run until a token's step.
      const before = steps[steps.indexOf(runs[0]) - 1];
      expect(before, name).toMatch(/^ {8}run: npm ci --ignore-scripts$/m);
      expect(before, name).toMatch(/^ {8}working-directory: infrastructure\/wrangler$/m);
      expect(before, name).not.toMatch(/^ {8}env:/m);
      expect(secretRefs(before), name).toEqual([]);
    }
  });
```

**(n)** Replace the test `names neither of the other two Workers, and no Cloudflare secret anywhere else` with:

```js
  it("deploys each Worker from its own job, and holds no Cloudflare secret anywhere else", () => {
    // A Worker's folder is a working directory in exactly one job: its own.
    const jobs = jobsOf(releaseYml);
    for (const [name, job] of Object.entries(jobs)) {
      const folders = [...job.matchAll(/^ {8}working-directory: (infrastructure\/[\w-]+)$/gm)]
        .map((m) => m[1])
        .filter((folder) => folder !== "infrastructure/wrangler");
      expect([...new Set(folders)], name).toEqual(name in DEPLOYS ? [DEPLOYS[name]] : []);
    }
    // `ci.yml` names the relay on one line, and deploys nothing: the sync smoke's step, which
    // runs the relay's code on the runner — the test above has what that run may do.
    expect(
      lines.filter(({ path, line }) => path.endsWith("/ci.yml") && /\b(?:relay|share-worker)\b/.test(line)),
    ).toEqual([
      {
        path: "/.github/workflows/ci.yml",
        line: "      - name: Pair two browsers through the local relay",
      },
    ]);
    const held = lines.filter(({ line }) => /CLOUDFLARE_|ANDROID_KEY/.test(line));
    expect([...new Set(held.map(({ path }) => path))].sort()).toEqual([
      "/.github/workflows/release.yml",
    ]);
    expect(secretsOf(code(ciYml))).toEqual([]);
  });
```

**(o)** Replace the test `commits no account id: the deploy reads it from a secret` with:

```js
  it("commits no account id: every deploy reads it from a secret", () => {
    for (const name of Object.keys(DEPLOYS)) {
      const steps = stepsOf(jobsOf(releaseYml)[name]).filter((s) =>
        /^ {8}run: node \.\.\/wrangler\//m.test(s),
      );
      for (const step of steps) {
        expect(step, name).toContain("CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}");
      }
    }
    // A Cloudflare account id is 32 hex characters; an action's pin is 40.
    expect(code(releaseYml)).not.toMatch(/(?<![0-9a-f])[0-9a-f]{32}(?![0-9a-f])/);
  });
```

(`5e0381b0-d2aa-4861-a725-26ca18ae00ef`, the D1 id, is in `wrangler.jsonc` and not in `release.yml`; with its hyphens it is not 32 hex in a row either.)

**(p)** In the test `deploys the bundle `web` built and opened in a browser, then asks the host`, the `web-deploy` order list is unchanged. Leave it.

- [ ] **Step 2: Run the fence and see it fail**

Run: `pnpm exec vitest run scripts/release-rule.test.ts`
Expected: FAIL — `has the ten jobs…` (seven found), and every test that reads `jobs["relay-deploy"]`.

- [ ] **Step 3: Add `pnpm share:build` to `ci.yml`**

In `.github/workflows/ci.yml`, job `frontend`, directly after the step that runs `pnpm build` (the one with `if: ${{ !matrix.shard }}`), add a step of the same shape:

```yaml
      # The viewer the share Worker serves (`apps/share/dist-share`). `pnpm build` type-checks
      # it and bundles nothing; a release's `share` job runs this same command, and its bundle
      # is deployed minutes later — so a pull request that breaks it is red here first.
      - name: Build the share viewer
        if: ${{ !matrix.shard }}
        run: pnpm share:build
```

- [ ] **Step 4: Add the three jobs to `release.yml`**

**(a)** Replace the header comment's diagram (the five lines from `#   release-please ─┬─ build` to `(publish also needs build and android-sign)`) with:

```yaml
#   release-please ─┬─ build (windows, linux) ─────────────┐
#                   ├─ android ── android-sign ────────────┤
#                   ├─ web ────────────────────────────────┤
#                   └─ share ──────────────────────────────┤
#                                                          ▼
#           relay-deploy ── share-deploy ── web-deploy ── publish
#                              (publish also needs build and android-sign)
```

and, in the paragraph under it, replace `The two jobs that hold a secret — `android-sign`, `web-deploy` —` with `The four jobs that hold a secret — `android-sign`, `relay-deploy`, `share-deploy`, `web-deploy` —`.

**(b)** Insert these three jobs after the `web` job's last step (the `web-bundle` upload) and before the comment block that opens `web-deploy`:

```yaml
  # **The share Worker's viewer, built at the tag** — the bundle `infrastructure/share-worker`
  # serves beside its script (`apps/share/dist-share`, `assets/share.js` by a fixed name). It
  # holds no secret and deploys nothing; what it leaves is the artifact `share-bundle`, for
  # `share-deploy`. `ci.yml`'s `frontend` runs the same `pnpm share:build` on every pull request.
  share:
    name: share (build)
    needs: release-please
    if: needs.release-please.outputs.release_created == 'true'
    runs-on: ubuntu-24.04
    timeout-minutes: 15
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false

      - uses: pnpm/action-setup@ea17c68df8912ef543352723c149a84f56e3d413 # v6.1.0

      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
        with:
          node-version-file: .nvmrc
          cache: pnpm

      - run: pnpm install --frozen-lockfile

      - name: Build the viewer
        run: pnpm share:build

      # The one file every shared page names. A build that wrote it under another name, or not
      # at all, is a deploy whose every link opens a blank page.
      - name: Check the bundle is whole
        shell: bash
        run: |
          set -euo pipefail
          [ -s apps/share/dist-share/assets/share.js ] || { echo "apps/share/dist-share/assets/share.js is missing or empty" >&2; exit 1; }
          ls apps/share/dist-share apps/share/dist-share/assets

      - uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1
        with:
          name: share-bundle
          path: apps/share/dist-share/
          retention-days: 14
          if-no-files-found: error

  # **The relay, deployed by a release** (the owner's decision, 2026-10-11: a release deploys
  # everything; it reverses 2026-10-04's "the relay is deployed by no job"). First of the three
  # deploys, once every host has built at the tag: a page that asks a relay without its half
  # fails every request (docs/agent/EXTERNAL_SERVICES.md), and the share Worker verifies the
  # tokens this one mints.
  #
  # **A token of its own**, `CLOUDFLARE_INFRA_API_TOKEN`, which this job and `share-deploy` read
  # and no other: it can write the D1 that holds every entitlement, where the web app's token
  # can touch one Worker. **The token alone decides whether this job does anything** — the
  # account id is in the environment already, for `web-deploy` — so with no token it applies
  # nothing, deploys nothing, says so in the summary and ends green; with a token and no account
  # id it fails. The Worker's own three secrets are Cloudflare's to hold: a deploy neither reads
  # nor changes them, and this workflow never sees them.
  #
  # **The database first, then the code.** `wrangler d1 migrations apply` runs every `.sql` file
  # in `infrastructure/relay/migrations/` the table `d1_migrations` does not name yet, once, in
  # name order — so a migration is additive, because for a moment the previous release's code
  # runs on it (that folder's README). ⚠️ **A migration is not undone by a re-run**, and a
  # failure after it leaves the schema ahead of the code: D1's Time Travel is the way back, by
  # hand.
  #
  # It builds nothing, for `web-deploy`'s reasons: the pinned `wrangler`, installed with no
  # script run and no token in reach, run by path. `scripts/release-rule.test.ts` holds every
  # line it runs.
  relay-deploy:
    name: relay (deploy)
    needs: [release-please, build, android-sign, web, share]
    if: needs.release-please.outputs.release_created == 'true'
    runs-on: ubuntu-24.04
    timeout-minutes: 20
    environment: release
    permissions:
      contents: read
    steps:
      # `infrastructure/relay/` — `wrangler.jsonc`, the script, the migrations —
      # `infrastructure/wrangler/`, the tool's lockfile, and the probe.
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false

      # Told whether each is set, never what it is — as in `android-sign`.
      - name: Is there a token to deploy with
        id: token
        shell: bash
        env:
          HAS_TOKEN: ${{ secrets.CLOUDFLARE_INFRA_API_TOKEN != '' }}
          HAS_ACCOUNT: ${{ secrets.CLOUDFLARE_ACCOUNT_ID != '' }}
          TAG: ${{ needs.release-please.outputs.tag_name }}
        run: |
          set -euo pipefail
          if [ "$HAS_TOKEN" != true ]; then
            echo "present=false" >> "$GITHUB_OUTPUT"
            {
              echo "### Relay — not deployed"
              echo
              echo "**The relay still runs the previous deploy.** The \`release\` environment holds no"
              echo "\`CLOUDFLARE_INFRA_API_TOKEN\`, so this release applied no migration and deployed nothing to it."
              echo "Deploy $TAG by hand — \`docs/reference/hosted-relay-deploy.md\`."
              echo
              echo "\`docs/reference/ci-and-releases.md\`, *What only the owner can do*, has the commands."
            } >> "$GITHUB_STEP_SUMMARY"
            exit 0
          fi
          if [ "$HAS_ACCOUNT" != true ]; then
            echo "CLOUDFLARE_INFRA_API_TOKEN is set in the release environment and CLOUDFLARE_ACCOUNT_ID is not." >&2
            echo "Set both — docs/reference/ci-and-releases.md, 'What only the owner can do'." >&2
            exit 1
          fi
          echo "present=true" >> "$GITHUB_OUTPUT"

      # A re-run long after its run would put this tag's relay over a later release's.
      - name: Refuse to deploy an older release over a newer one
        if: steps.token.outputs.present == 'true'
        shell: bash
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          TAG: ${{ needs.release-please.outputs.tag_name }}
          REPO: ${{ github.repository }}
        run: |
          set -euo pipefail
          latest=$(gh api "repos/$REPO/releases/latest" --jq .tag_name)
          newest=$(printf '%s\n%s\n' "$latest" "$TAG" | sort -V | tail -1)
          echo "this run's tag: $TAG; the newest published release: $latest"
          if [ "$newest" != "$TAG" ]; then
            echo "$latest is published and is newer than $TAG: deploying $TAG's relay would put older code behind it. Nothing was deployed." >&2
            exit 1
          fi

      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
        if: steps.token.outputs.present == 'true'
        with:
          node-version-file: .nvmrc
          package-manager-cache: false

      # No lifecycle script run, and nothing in this step's environment — `web-deploy` has why.
      - name: Install the lockfile's packages, running no script
        if: steps.token.outputs.present == 'true'
        working-directory: infrastructure/wrangler
        run: npm ci --ignore-scripts

      # The first of the two steps the token reaches. Nothing to apply is the usual answer.
      - name: Apply the database's pending migrations
        if: steps.token.outputs.present == 'true'
        working-directory: infrastructure/relay
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_INFRA_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          WRANGLER_SEND_METRICS: "false"
        run: node ../wrangler/node_modules/wrangler/bin/wrangler.js d1 migrations apply mtg-grimoire-relay --remote

      # The second, and the deploy: live the moment it returns. The version id it prints is the
      # record of what is running — no probe without a credential can tell one from the next.
      - name: Deploy the Worker
        if: steps.token.outputs.present == 'true'
        working-directory: infrastructure/relay
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_INFRA_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          WRANGLER_SEND_METRICS: "false"
        run: node ../wrangler/node_modules/wrangler/bin/wrangler.js deploy

      # The runbook's step 0, asked of the real address: the relay answers, its tables are
      # there, and a page at the web app's origin is let in.
      # ⚠️ **A failure here leaves the relay deployed and the release a draft.**
      - name: Ask the host
        if: steps.token.outputs.present == 'true'
        timeout-minutes: 5
        run: node scripts/relay-deploy-probe.ts

  # **The share Worker, deployed by a release**, behind the relay and with the relay's token:
  # the two share one database and one signing key, so they share the token that can write
  # both. Everything `relay-deploy` says of itself holds here — the token alone decides, the
  # database before the code (this Worker's own list, in its own table `d1_migrations_share`),
  # nothing built, every line held by the fence. What it uploads beside the script is the
  # viewer `share` built at the tag.
  share-deploy:
    name: share (deploy)
    needs: [release-please, share, relay-deploy]
    if: needs.release-please.outputs.release_created == 'true'
    runs-on: ubuntu-24.04
    timeout-minutes: 20
    environment: release
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false

      - name: Is there a token to deploy with
        id: token
        shell: bash
        env:
          HAS_TOKEN: ${{ secrets.CLOUDFLARE_INFRA_API_TOKEN != '' }}
          HAS_ACCOUNT: ${{ secrets.CLOUDFLARE_ACCOUNT_ID != '' }}
          TAG: ${{ needs.release-please.outputs.tag_name }}
        run: |
          set -euo pipefail
          if [ "$HAS_TOKEN" != true ]; then
            echo "present=false" >> "$GITHUB_OUTPUT"
            {
              echo "### Share Worker — not deployed"
              echo
              echo "**The share Worker still runs the previous deploy.** The \`release\` environment holds no"
              echo "\`CLOUDFLARE_INFRA_API_TOKEN\`, so this release applied no migration and deployed nothing to it."
              echo "Deploy $TAG by hand — \`infrastructure/share-worker/README.md\`."
              echo
              echo "\`docs/reference/ci-and-releases.md\`, *What only the owner can do*, has the commands."
            } >> "$GITHUB_STEP_SUMMARY"
            exit 0
          fi
          if [ "$HAS_ACCOUNT" != true ]; then
            echo "CLOUDFLARE_INFRA_API_TOKEN is set in the release environment and CLOUDFLARE_ACCOUNT_ID is not." >&2
            echo "Set both — docs/reference/ci-and-releases.md, 'What only the owner can do'." >&2
            exit 1
          fi
          echo "present=true" >> "$GITHUB_OUTPUT"

      - name: Refuse to deploy an older release over a newer one
        if: steps.token.outputs.present == 'true'
        shell: bash
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          TAG: ${{ needs.release-please.outputs.tag_name }}
          REPO: ${{ github.repository }}
        run: |
          set -euo pipefail
          latest=$(gh api "repos/$REPO/releases/latest" --jq .tag_name)
          newest=$(printf '%s\n%s\n' "$latest" "$TAG" | sort -V | tail -1)
          echo "this run's tag: $TAG; the newest published release: $latest"
          if [ "$newest" != "$TAG" ]; then
            echo "$latest is published and is newer than $TAG: deploying $TAG's share Worker would put older code behind it. Nothing was deployed." >&2
            exit 1
          fi

      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
        if: steps.token.outputs.present == 'true'
        with:
          node-version-file: .nvmrc
          package-manager-cache: false

      # Where `wrangler.jsonc`'s `assets.directory` (`../../apps/share/dist-share`) looks.
      - uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8.0.1
        if: steps.token.outputs.present == 'true'
        with:
          name: share-bundle
          path: apps/share/dist-share

      # `share` checked this before it uploaded; asked again here because after the deploy is
      # too late. `wrangler deploy` uploads whatever the directory holds.
      - name: Check the bundle arrived whole
        if: steps.token.outputs.present == 'true'
        shell: bash
        run: |
          set -euo pipefail
          [ -s apps/share/dist-share/assets/share.js ] || { echo "apps/share/dist-share/assets/share.js is missing or empty" >&2; exit 1; }

      - name: Install the lockfile's packages, running no script
        if: steps.token.outputs.present == 'true'
        working-directory: infrastructure/wrangler
        run: npm ci --ignore-scripts

      - name: Apply the database's pending migrations
        if: steps.token.outputs.present == 'true'
        working-directory: infrastructure/share-worker
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_INFRA_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          WRANGLER_SEND_METRICS: "false"
        run: node ../wrangler/node_modules/wrangler/bin/wrangler.js d1 migrations apply mtg-grimoire-relay --remote

      # From the Worker's folder; its `alias` is what lets the script's one import of the
      # relay's token module bundle in a job with no workspace links (`scripts/share-worker-alias.test.ts`).
      - name: Deploy the Worker
        if: steps.token.outputs.present == 'true'
        working-directory: infrastructure/share-worker
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_INFRA_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          WRANGLER_SEND_METRICS: "false"
        run: node ../wrangler/node_modules/wrangler/bin/wrangler.js deploy

      # The README's five: the Worker's four doors, and the viewer's script byte for byte
      # against the bundle — the one that says this build is what the address serves.
      # ⚠️ **A failure here leaves the share Worker deployed and the release a draft.**
      - name: Ask the host
        if: steps.token.outputs.present == 'true'
        timeout-minutes: 5
        run: node scripts/share-deploy-probe.ts apps/share/dist-share
```

**(c)** In `web-deploy`: change `needs: [release-please, build, android-sign, web]` to `needs: [release-please, build, android-sign, web, share-deploy]`. In the comment block above it, replace the paragraph that begins `**The one job in this repository that deploys anything, and it deploys one Worker**` through `…and fails one more.` with:

```yaml
  # **The web app's hosting, `infrastructure/app-worker/`, to https://mtg-grimoire.app** — the
  # third of a release's three deploys, behind the relay and the share Worker (`relay-deploy`
  # has why the relay is first). The owner decided on 2026-10-04 that a release deploys it — one
  # core means one user schema per commit, so the three hosts ship from one tag
  # (docs/reference/ci-and-releases.md, "The release rule") — and on 2026-10-11 that a release
  # deploys the other two Workers as well. `scripts/release-rule.test.ts` lists every workflow
  # line that names `wrangler`, and fails one more.
```

Leave the rest of that comment block as it is, except the sentence `a token that can deploy this Worker can, unless it was scoped down, deploy over the relay on the same account`, which stays true and stays.

**(d)** In `publish`: change `needs` to `[release-please, build, android-sign, relay-deploy, share-deploy, web-deploy]`, and replace the comment block above the job with:

```yaml
  # **Publishes only when every host and every Worker is through.** `build` is the desktop's;
  # `android-sign` ends green with the bundle signed or with no key to sign it; `relay-deploy`,
  # `share-deploy` and `web-deploy` each end green with their address serving this tag or with
  # no token to deploy it. A failure in any of them — or in `android`, `web` or `share`, which
  # those need — leaves the release a draft: a release that publishes some hosts and not the
  # rest is what the rule exists to prevent. ⚠️ **A draft left by a failed deploy may have live
  # Workers ahead of it** — whichever deploys ran before the one that failed.
```

- [ ] **Step 5: Run the fence and its neighbours, and see them pass**

Run: `pnpm exec vitest run scripts/release-rule.test.ts scripts/actions-pinned.test.ts scripts/toolchain.test.ts scripts/workflow-scripts.test.ts scripts/ci-route.test.ts`
Expected: PASS, all five files.

The likeliest red is `runs only what is listed here` for a new job: a line of a `run:` block that differs from its `RUNS` entry by a character. The test prints both; fix whichever is not what Step 4 says. If `toolchain.test.ts` or `workflow-scripts.test.ts` is red on a new job, read the assertion: both already pass for `web-deploy`, which has the same shape, so the difference from it is the bug.

- [ ] **Step 6: Prove the fence bites**

One mutation per new rule, each in a single shell call that restores the file. For each: make the change, run `pnpm exec vitest run scripts/release-rule.test.ts`, expect the named test red, then `git checkout -- .github/workflows/release.yml` (the workflow is uncommitted work — instead keep a copy: `cp .github/workflows/release.yml "$SCRATCH/release.yml"` before, `cp "$SCRATCH/release.yml" .github/workflows/release.yml` after, and `cmp` them).

| Mutation in `release.yml` | Test that must go red |
| --- | --- |
| Add `- run: ./tools/x` with the `if:` to `relay-deploy` | `relay-deploy builds nothing, and runs only what is listed here` |
| In `share-deploy`'s ask step, swap the two `if` blocks | `share-deploy asks for the token alone…` |
| Move `relay-deploy`'s `Deploy the Worker` above the migrations step | `applies the migrations, deploys and asks the host, in that order…` |
| Change `share-deploy`'s deploy to `working-directory: infrastructure/relay` | `runs wrangler five times…` |
| Add `--remote d1 execute` as a new wrangler step in `web-deploy` | `runs wrangler five times…` |
| Remove `share-deploy` from `web-deploy`'s `needs` | `has the ten jobs…` |

Record the table, with what each printed, for Task 5.

---

### Task 5: The documents

**Files:**
- Modify: `CLAUDE.md`, `.github/CLAUDE.md`, `docs/agent/EXTERNAL_SERVICES.md`, `docs/reference/ci-and-releases.md`, `docs/reference/hosted-relay-deploy.md`, `infrastructure/relay/README.md`, `infrastructure/share-worker/README.md`, `infrastructure/app-worker/wrangler.jsonc` (one comment), `infrastructure/share-worker/wrangler.jsonc` (comments), `infrastructure/relay/schema.sql` — **no**: it is hash-pinned; leave it and its stale "Applied with" comment alone.
- Modify: `docs/superpowers/specs/2026-10-11-release-deploys-everything-design.md` (a "What changed in execution" section)

No test cycle of its own; `node scripts/check-claude-md.ts` and the two fences that read documents (`pnpm lint:claude`, if `package.json` has it) are the gate.

- [ ] **Step 1: Find every sentence that states the old rule**

```bash
git grep -n -i "deployed by no job\|only job that deploys\|only \`wrangler\` in any workflow\|One job deploys\|one job that deploys\|deploys stay by hand\|migrations/2026-" -- ':!docs/superpowers' ':!CHANGELOG.md'
```

Every hit is rewritten or re-pointed below. A hit in a file not listed is rewritten on the same terms.

- [ ] **Step 2: Root `CLAUDE.md` — the global rule**

Replace the bullet `**Deployments require explicit instruction**: …` with:

```markdown
- **Deployments require explicit instruction**: No agent may deploy a Worker, apply a D1 migration or set a secret without explicit instruction from the user. A release deploys all three: `release.yml`'s `relay-deploy`, `share-deploy` and `web-deploy` apply any pending D1 migration and put the relay, the share Worker and the web app (`infrastructure/app-worker/`) on their addresses at a release tag (the owner's decisions, 2026-10-04 and 2026-10-11 — every host ships from one tag). So **merging the release PR is a deploy of everything**, and an agent merges it only when asked to. Between releases a deploy is by hand and asked for, each time.
```

- [ ] **Step 3: `.github/CLAUDE.md` — the `release.yml` section**

- In the bullet **The release rule**, add `share` to the builds (`pnpm share:build`, no secret) and replace the `web-deploy` sub-bullet's last sentence (`It needs `build`, `android-sign` and `web` …`) with: ``It needs `build`, `android-sign`, `web` and `share-deploy` — the last of three deploys, each live at once — and refuses a tag older than the newest published release.``
- Add a sub-bullet after `android-sign`'s:

```markdown
  - `relay-deploy`, then `share-deploy`, run `wrangler d1 migrations apply mtg-grimoire-relay --remote` and `wrangler deploy` from their Worker's folder (`infrastructure/relay`, `infrastructure/share-worker`), then a probe of the live address (`scripts/relay-deploy-probe.ts`, `scripts/share-deploy-probe.ts`). `share-deploy` uploads the viewer `share` built. Migrations are numbered files in each Worker's `migrations/`; `schema.sql` is the frozen baseline (`scripts/d1-migrations.test.ts`).
```

- Replace the bullet **Secrets live in jobs that build nothing…**'s list of jobs (`android-sign` and `web-deploy`) with `android-sign`, `relay-deploy`, `share-deploy` and `web-deploy`, and add: ``The two Worker jobs read `CLOUDFLARE_INFRA_API_TOKEN`, and **that token alone decides whether they run**: none → deploy nothing, end green; a token with no `CLOUDFLARE_ACCOUNT_ID` → fail.``
- Replace the bullet **One job deploys one Worker** with:

```markdown
- **Three jobs deploy three Workers**, in order: `relay-deploy`, `share-deploy`, `web-deploy`. Five `wrangler` lines in all workflows — two `d1 migrations apply --remote`, three `deploy` — and the fence lists them. Merging the release PR is therefore a deploy of everything.
```

- In the **Fence** bullet, replace `the single `wrangler` line and its lockfile` with `the five `wrangler` lines and their lockfile`.
- In `ci.yml`'s **`frontend`** job-specifics bullet, add `and `pnpm share:build`` to what the first leg runs.

Then `node scripts/check-claude-md.ts` — the file must stay at or under 200 lines; tighten the wording above if it does not.

- [ ] **Step 4: `docs/agent/EXTERNAL_SERVICES.md`**

- In *Sync and the hosted relay*: after the sentence that ends `…a first landing.`, add a dated sentence: `**Since 2026-10-11 a release deploys it** — `release.yml`'s `relay-deploy`, at the tag, after applying any pending D1 migration (`infrastructure/relay/migrations/`), before the share Worker and the web app. A deploy between releases is still by hand and asked for.`
- In *The share Worker*: add the equivalent sentence naming `share-deploy` and `d1_migrations_share`.
- In *The app Worker*: replace `**One job deploys it, and it is the only job that deploys anything** (decided 2026-10-04)` with `**A job deploys it** (decided 2026-10-04; since 2026-10-11 the third of three, behind the relay's and the share Worker's)`, and replace the paragraph's sentence `The relay and the share Worker are deployed by no job.` with `The relay and the share Worker are deployed by the same release, ahead of it.`
- Keep the file's opening warning (*Deploy state changes outside the repository*) as it is.

- [ ] **Step 5: `docs/reference/ci-and-releases.md`**

- In the job table of *The release rule* (the row for `web-deploy` is near line 571), add rows for `share`, `relay-deploy` and `share-deploy` in the table's own column order, and correct `web-deploy`'s and `publish`'s *needs*.
- Add a dated section, **"A release deploys everything (2026-10-11)"**, holding: the decision and what it reverses; the order and why; the token rule (the token alone decides) and why it differs from `web-deploy`'s; the D1 design (frozen baseline, tracked folders starting empty, two tables); what Task 1 Step 7 measured of wrangler with an empty folder and with one file, verbatim; what Task 2 Step 9 printed; what Task 3 Step 4's `--dry-run`s printed; and Task 4 Step 6's mutation table.
- In *What only the owner can do*, add an entry **The Workers' deploy token**:

```markdown
  - **The Workers' deploy token (`CLOUDFLARE_INFRA_API_TOKEN`).** A second custom token on the
    one account, for `relay-deploy` and `share-deploy`: **Account → Workers Scripts → Edit**,
    **Account → D1 → Edit**, **Account → Workers R2 Storage → Edit**. No zone permission — both
    Workers are on `workers.dev`. ⚠️ **It can write the database that holds every entitlement
    and deploy over any Worker on the account**, the web app's included; what bounds it is the
    `release` environment's restriction to `main` (step 0).
    `gh secret set CLOUDFLARE_INFRA_API_TOKEN --env release --repo Msgaihede/mtg-grimoire`.
    **Not verified**: no deploy has been made with such a token. If the first run fails on a
    permission, its log names it. Until it is set the two jobs end green having deployed
    nothing, and each says so in the run's summary.
  - **Before the first release with it: is `schema.sql` what production holds?** The baseline
    is frozen on the claim that it is. Compare `sqlite_master` of the live database with one
    built from `infrastructure/relay/schema.sql` and `infrastructure/share-worker/schema.sql`
    — a read, by the owner or at his word.
```

- [ ] **Step 6: The two runbooks and the READMEs**

- `docs/reference/hosted-relay-deploy.md`: at the top, a dated note — since 2026-10-11 a release runs this deploy (`relay-deploy`); the page remains the record of every deploy before it and the runbook for a deploy between releases; step 0's probes are what `scripts/relay-deploy-probe.ts` asks. Re-point every `migrations/2026-…` path to `applied-by-hand/2026-…`. In step 2, add that a **new** schema change is a file in `infrastructure/relay/migrations/` and is applied by the release, not by a `d1 execute`.
- `infrastructure/relay/README.md`: the same two changes where it lists the migration commands (near line 904), and one sentence in its deploy section naming `relay-deploy`.
- `infrastructure/share-worker/README.md`, *Deploying*: replace the opening warning's `Those are the repo owner's.` with `Those are the repo owner's, or a release's: since 2026-10-11 `release.yml`'s `share-deploy` runs this deploy at a tag.`; say the five `curl`s are what `scripts/share-deploy-probe.ts` asks.
- `infrastructure/share-worker/wrangler.jsonc`: two comments are stale and are corrected in passing — the R2 one (`The bucket does not exist yet…`) and the assets one (``../../apps/share/dist-share` does not exist yet…`). Both exist since 2026-10-01; say so in one line each and say that `release.yml`'s `share` job builds the directory.
- `infrastructure/app-worker/wrangler.jsonc`: the `name` comment's `while the relay's deploys stayed by hand` becomes `and, since 2026-10-11, the relay and the share Worker by jobs of their own`.

- [ ] **Step 7: The spec's record**

Append to `docs/superpowers/specs/2026-10-11-release-deploys-everything-design.md` a section `## 10. What changed in execution (piece A)` listing, as found: the token-alone rule (already in §4); that the sync smoke applies tracked migrations through `d1 execute --file` rather than `d1 migrations apply`, to add no wrangler subcommand to what CI may start; and anything Task 1 Step 7, Task 2 Step 8 or Task 3 Step 4 turned up.

- [ ] **Step 8: Sweep again**

Run Step 1's `git grep` again. Expected: no hit that still states the old rule; every `migrations/2026-` hit is gone.

---

### Task 6: Verify, commit, open the pull request

- [ ] **Step 1: The whole gate, once**

Follow the `worktree-setup` skill first if this worktree has not run a verify. Then:

```bash
pnpm verify
```

Expected: exit 0. Paste the tail of its output into the pull request. A failure in a file this plan did not touch is checked against `main` before it is believed (memory: flaky tests under verify load).

- [ ] **Step 2: One commit**

```bash
git add -A
git status --short
git commit -m "$(cat <<'EOF'
feat: a release deploys the relay and the share Worker

`release.yml` gains `share`, `relay-deploy` and `share-deploy`: at a release tag the
relay and the share Worker have their pending D1 migrations applied and are deployed,
in that order, ahead of the web app, each followed by a probe of the live address.

- D1: `schema.sql` is the frozen baseline; later changes are numbered files in each
  Worker's tracked `migrations/`, which start empty. The five migrations applied by
  hand move to `infrastructure/relay/applied-by-hand/`.
- A second token, `CLOUDFLARE_INFRA_API_TOKEN`, read by the two new deploy jobs only.
  Without it they deploy nothing and end green.
- The fence (`scripts/release-rule.test.ts`) holds the ten jobs, the five wrangler
  lines and every line the two new jobs run.

Reverses "the relay and the share Worker are deployed by no job" (2026-10-04), at the
owner's decision of 2026-10-11.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

Check `git status --short` before committing: the spec and both plan files are in it; nothing under `data/`, no `0001_probe.sql`, no `.wrangler/`.

- [ ] **Step 3: Push and open the pull request — only when the owner says to**

The pull request's body states, at the top: **merging this deploys nothing by itself; the first release PR merged after it deploys the relay and the share Worker if `CLOUDFLARE_INFRA_API_TOKEN` is set, and nothing new if it is not.** Then the two things only the owner does (the token; the read of production's D1), the mutation table, and verify's tail. End it with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
