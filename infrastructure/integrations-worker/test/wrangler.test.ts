import { describe, expect, it } from "vitest";
import wranglerText from "../wrangler.jsonc?raw";
import readme from "../README.md?raw";
import relayWrangler from "../../relay/wrangler.jsonc?raw";
import shareWrangler from "../../share-worker/wrangler.jsonc?raw";
import scanWrangler from "../../scan-worker/wrangler.jsonc?raw";
import appWrangler from "../../app-worker/wrangler.jsonc?raw";
import tokenText from "../../relay/src/token.ts?raw";

/**
 * The fence between this Worker's configuration, its script and the Workers beside it.
 *
 * **Nothing compiles any two of them together.** `wrangler.jsonc` is read by a deploy, and a
 * binding whose name drifts from `Env`'s is one this Worker reads as `undefined` — so each
 * mistake here deploys green and fails somewhere a reader is. Read as text, the way the scan
 * inbox's `wrangler.test.ts` reads its own.
 */

/** A `wrangler.jsonc` as a value: comments out, trailing commas out. Strings are stepped over. */
function jsonc(text: string): Record<string, unknown> {
  let out = "";
  for (let at = 0; at < text.length;) {
    if (text[at] === '"') {
      const from = at++;
      while (text[at] !== '"') at += text[at] === "\\" ? 2 : 1;
      out += text.slice(from, ++at);
    } else if (text.startsWith("//", at)) {
      while (at < text.length && text[at] !== "\n") at++;
    } else if (text.startsWith("/*", at)) {
      at = text.indexOf("*/", at) + 2;
    } else {
      out += text[at++];
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1")) as Record<string, unknown>;
}

/** The Discord branch's two Workers, once they land: globs, so this reads as well before. */
const LATER = import.meta.glob(
  ["/infrastructure/discord-worker/wrangler.jsonc", "/infrastructure/bot-device/wrangler.jsonc"],
  { query: "?raw", import: "default", eager: true },
);

const config = jsonc(wranglerText);
const others: Record<string, Record<string, unknown>> = {
  relay: jsonc(relayWrangler),
  share: jsonc(shareWrangler),
  scan: jsonc(scanWrangler),
  app: jsonc(appWrangler),
  ...Object.fromEntries(Object.entries(LATER).map(([path, text]) => [path, jsonc(text)])),
};

type Database = Record<string, string>;
const databaseOf = (worker: Record<string, unknown>) =>
  (worker.d1_databases as Database[] | undefined)?.[0];
const cronsOf = (worker: Record<string, unknown>) =>
  (worker.triggers as { crons?: string[] } | undefined)?.crons ?? [];
type Objects = { bindings: { name: string; class_name: string; script_name?: string }[] };
const objectsOf = (worker: Record<string, unknown>) =>
  (worker.durable_objects as Objects | undefined)?.bindings ?? [];

describe("wrangler.jsonc", () => {
  it("is its own Worker at one provisional address, with no workers.dev and no preview", () => {
    expect(config.name).toBe("mtg-grimoire-integrations");
    expect(config.main).toBe("src/index.ts");
    expect(config.routes).toEqual([
      { pattern: "integrations.mtg-grimoire.app", custom_domain: true },
    ]);
    expect(config.workers_dev).toBe(false);
    expect(config.preview_urls).toBe(false);
    // And it says, beside the route, that the owner confirms it before the first deploy.
    expect(wranglerText).toMatch(/Provisional: the owner confirms the address/);
  });

  it("binds the relay's database, as the share Worker does, with a migrations list of its own", () => {
    const own = databaseOf(config)!;
    const relay = databaseOf(others.relay)!;
    const share = databaseOf(others.share)!;
    expect(own).toEqual({
      binding: "DB",
      database_name: relay.database_name,
      database_id: relay.database_id,
      migrations_dir: "migrations",
      migrations_table: "d1_migrations_integrations",
    });
    expect(own.database_id).toBe(share.database_id);
    const taken = Object.values(others)
      .map((worker) => databaseOf(worker)?.migrations_table)
      .filter((table) => table !== undefined);
    expect(taken).not.toContain(own.migrations_table);
  });

  it("binds one Durable Object namespace — its own GroupStore — and no other Worker's", () => {
    expect(config.durable_objects).toEqual({
      bindings: [{ name: "STORE", class_name: "GroupStore" }],
    });
    expect(config.migrations).toEqual([{ tag: "v1", new_sqlite_classes: ["GroupStore"] }]);
    // No binding names the relay's classes: this Worker cannot reach a group's sync log.
    const relayClasses = objectsOf(others.relay).map((binding) => binding.class_name);
    expect(relayClasses.length).toBeGreaterThan(0);
    for (const binding of objectsOf(config)) {
      expect(relayClasses).not.toContain(binding.class_name);
      expect(binding.script_name).toBeUndefined();
    }
    // And no other Worker binds this one's class.
    for (const [name, worker] of Object.entries(others)) {
      for (const binding of objectsOf(worker))
        expect(binding.class_name, name).not.toBe("GroupStore");
    }
  });

  it("sweeps once a day, on a minute no other Worker's pass starts on", () => {
    const own = cronsOf(config);
    expect(own).toHaveLength(1);
    const minute = (cron: string) => cron.split(" ")[0];
    for (const [name, worker] of Object.entries(others)) {
      for (const cron of cronsOf(worker)) expect(minute(cron), name).not.toBe(minute(own[0]));
    }
    expect(own[0]).toMatch(/^\d+ \d+ \* \* \*$/);
    // The free plan allows five cron triggers on the account.
    expect([config, ...Object.values(others)].flatMap(cronsOf).length).toBeLessThanOrEqual(5);
  });

  it("lets the web app's origin ask, as the scan inbox does, and no development one", () => {
    expect(config.vars).toEqual({ APP_ORIGINS: "https://mtg-grimoire.app" });
    expect((others.scan.vars as Record<string, string>).APP_ORIGINS).toBe(
      "https://mtg-grimoire.app",
    );
  });

  it("keeps no log: a request carries a relay token, and a fault can name a card", () => {
    expect(config.observability).toEqual({ enabled: false });
  });

  it("binds nothing else: no bucket, no service, no asset, no other key", () => {
    expect(Object.keys(config).sort()).toEqual(
      [
        "$schema",
        "name",
        "main",
        "alias",
        "compatibility_date",
        "routes",
        "workers_dev",
        "preview_urls",
        "d1_databases",
        "durable_objects",
        "migrations",
        "triggers",
        "vars",
        "observability",
      ].sort(),
    );
  });

  it("documents its secrets, and holds none of them as a value", () => {
    const values = JSON.stringify(config);
    for (const secret of ["RELAY_HMAC_KEY", "INTEGRATIONS_KEK"]) {
      expect(values).not.toContain(secret);
      expect(readme).toContain(`secret put ${secret}`);
    }
    expect(readme).toContain("INTEGRATIONS_KEK_PREVIOUS");
  });
});

describe("the script", () => {
  // `src/` is exactly what a deploy bundles: the suite is in `test/`.
  const SCRIPT = import.meta.glob("/infrastructure/integrations-worker/src/**/*", {
    query: "?raw",
    import: "default",
    eager: true,
  });
  const script = Object.entries(SCRIPT).map(
    ([path, text]) => [path.slice(path.lastIndexOf("/") + 1), text] as const,
  );

  it("is every module a deploy needs, and no test", () => {
    const names = script.map(([name]) => name).sort();
    for (const wanted of ["index.ts", "worker.ts", "object.ts", "store.ts", "gate.ts", "seal.ts"]) {
      expect(names).toContain(wanted);
    }
    expect(names.filter((name) => /\.test\.ts$|^fake\.ts$/.test(name))).toEqual([]);
  });

  /** The issue's acceptance, as a test: `grep -rn 'group_key\|RELAY_HMAC_KEY' src`. */
  it("names no group key anywhere, and the relay's signing key only where a token is verified", () => {
    expect(script.filter(([, text]) => /group_key/i.test(text)).map(([name]) => name)).toEqual([]);
    expect(
      script.filter(([, text]) => text.includes("RELAY_HMAC_KEY")).map(([name]) => name),
    ).toEqual(["gate.ts"]);
    // It verifies and never mints: the relay's token module, and only these three names of it.
    const imported = script.flatMap(([, text]) => [
      ...text.matchAll(/import \{([^}]+)\} from "@grimoire\/relay\/src\/token";/g),
    ]);
    expect(imported.flatMap(([, names]) => names.split(",").map((n) => n.trim())).sort()).toEqual([
      "newestKeys",
      "stillInGroup",
      "verify",
    ]);
  });

  it("imports a file beside it, the runtime's own module, or the one module wrangler is given a path for", () => {
    const specifiers = script.flatMap(([name, text]) =>
      [...text.matchAll(/^(?:import|export)\s[^"]*?from\s+"([^"]+)";/gm)].map((m) => [name, m[1]]),
    );
    const outside = specifiers.filter(([, spec]) => !spec.startsWith("./"));
    expect(outside.sort()).toEqual([
      ["gate.ts", "@grimoire/relay/src/token"],
      ["object.ts", "cloudflare:workers"],
    ]);
    for (const [name, spec] of specifiers.filter(([, s]) => s.startsWith("./"))) {
      expect(SCRIPT, `${name} → ${spec}`).toHaveProperty(
        `/infrastructure/integrations-worker/src/${spec.slice(2)}.ts`,
      );
    }
    // An exact module, not the package — and that module imports nothing of its own.
    expect(config.alias).toEqual({ "@grimoire/relay/src/token": "../relay/src/token.ts" });
    expect(tokenText).not.toMatch(/^import /m);
  });

  it("exports the router and the class the namespace binds", () => {
    const index = SCRIPT["/infrastructure/integrations-worker/src/index.ts"];
    expect(index).toContain('export { default } from "./worker";');
    expect(index).toContain('export { GroupStore } from "./object";');
    expect(SCRIPT["/infrastructure/integrations-worker/src/object.ts"]).toMatch(
      /export class GroupStore extends DurableObject<Env>/,
    );
  });
});

describe("what must not be in this directory", () => {
  const files = import.meta.glob(
    [
      "/infrastructure/integrations-worker/**/*",
      "!/infrastructure/integrations-worker/.wrangler/**",
      "!/infrastructure/integrations-worker/node_modules/**",
    ],
    { query: "?raw", import: "default", eager: true, exhaustive: true },
  );

  it("sweeps every file here", () => {
    const names = Object.keys(files);
    for (const wanted of [
      "wrangler.jsonc",
      "README.md",
      "migrations/0001_integration-groups.sql",
      "src/index.ts",
      "test/fake.ts",
    ]) {
      expect(names).toContain(`/infrastructure/integrations-worker/${wanted}`);
    }
  });

  it("holds no account id, neither of Patreon's secrets, and nowhere to put a value", () => {
    const SECRETS = ["PATREON_CLIENT_SECRET", "PATREON_WEBHOOK_SECRET"];
    const found = Object.entries(files).flatMap(([name, text]) => {
      if (name.endsWith("/test/wrangler.test.ts")) return [];
      const leaks =
        /\baccount_id\b/.test(text) ||
        /\b[0-9a-f]{32}\b/i.test(text) ||
        SECRETS.some((secret) => text.includes(secret));
      return leaks ? [name] : [];
    });
    expect(found).toEqual([]);
    expect(Object.keys(files).filter((name) => /\/\.(dev\.vars|env)[^/]*$/.test(name))).toEqual([]);
  });

  it("names every table it owns integration_…, in a migration named the way wrangler orders them", () => {
    const migrations = Object.entries(files).filter(([name]) => name.endsWith(".sql"));
    expect(migrations.map(([name]) => name.slice(name.lastIndexOf("/") + 1))).toEqual([
      "0001_integration-groups.sql",
    ]);
    const tables = migrations.flatMap(([, text]) => [
      ...text.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g),
    ]);
    expect(tables.map((m) => m[1])).toEqual(["integration_groups"]);
  });
});
