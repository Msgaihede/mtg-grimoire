import { describe, expect, it } from "vitest";
import wranglerText from "../wrangler.jsonc?raw";
import relayWrangler from "../../relay/wrangler.jsonc?raw";
import shareWrangler from "../../share-worker/wrangler.jsonc?raw";
import scanWrangler from "../../scan-worker/wrangler.jsonc?raw";
import appWrangler from "../../app-worker/wrangler.jsonc?raw";
import { configured } from "./env";
import { LIMIT } from "./index";

/**
 * The fence between this Worker's configuration, its code and the Workers beside it.
 *
 * **Nothing compiles any two of them together.** `wrangler.jsonc` is read by a deploy, and a
 * binding whose name drifts from `Env`'s is one this Worker reads as `undefined` — a limiter it
 * then treats as absent on purpose, a namespace that throws on the first command — so each
 * mistake here deploys green and fails somewhere a reader is. Read as text, the way
 * `infrastructure/scan-worker/src/wrangler.test.ts` reads its own.
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

/**
 * The bot device's config, when its folder is there — built beside this one, and the other half
 * of the `BOT` binding. A glob, so this file reads as well before that folder lands as after.
 */
const BOT_DEVICE = import.meta.glob("/infrastructure/bot-device/wrangler.jsonc", {
  query: "?raw",
  import: "default",
  eager: true,
});

const config = jsonc(wranglerText);
const others: Record<string, Record<string, unknown>> = {
  relay: jsonc(relayWrangler),
  share: jsonc(shareWrangler),
  scan: jsonc(scanWrangler),
  app: jsonc(appWrangler),
  ...Object.fromEntries(Object.values(BOT_DEVICE).map((text) => ["bot-device", jsonc(text)])),
};
const vars = config.vars as Record<string, string>;

type Database = Record<string, string>;
const databaseOf = (worker: Record<string, unknown>) =>
  (worker.d1_databases as Database[] | undefined)?.[0];
const cronsOf = (worker: Record<string, unknown>) =>
  (worker.triggers as { crons?: string[] } | undefined)?.crons ?? [];

describe("wrangler.jsonc", () => {
  it("is deployed at its own address, which is DISCORD_BASE, with nothing beside it", () => {
    expect(config.name).toBe("mtg-grimoire-discord");
    expect(config.main).toBe("src/index.ts");
    expect(config.routes).toEqual([{ pattern: "discord.mtg-grimoire.app", custom_domain: true }]);
    expect(vars.DISCORD_BASE).toBe("https://discord.mtg-grimoire.app");
    // No trailing slash: the redirect URI is built on it and Discord compares it byte for byte.
    expect(vars.DISCORD_BASE).not.toMatch(/\/$/);
    // No build was ever cut with a `workers.dev` address for this Worker, as for the scan inbox.
    expect(config.workers_dev).toBe(false);
    expect(config.preview_urls).toBe(false);
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
      migrations_table: "d1_migrations_discord",
    });
    expect(own.database_name).toBe(share.database_name);
    expect(own.database_id).toBe(share.database_id);
    expect([relay.migrations_table, share.migrations_table]).not.toContain(own.migrations_table);
  });

  it("binds the bot's Durable Objects, which are another script's, under the name the code reads", () => {
    expect(config.durable_objects).toEqual({
      bindings: [{ name: "BOT", class_name: "BotDevice", script_name: "mtg-grimoire-bot-device" }],
    });
    // It defines no class, so it migrates none: the class's migrations are its own script's.
    expect(config).not.toHaveProperty("migrations");
    // And the other script, once its folder is here, is that name and exports that class.
    const bot = others["bot-device"];
    if (bot !== undefined) {
      expect(bot.name).toBe("mtg-grimoire-bot-device");
      expect(JSON.stringify(bot.migrations)).toContain("BotDevice");
    }
  });

  it("binds one limiter with the numbers the router repeats, in a namespace of its own", () => {
    expect(config.ratelimits).toEqual([{ name: "RL_BEGIN", namespace_id: "3001", simple: LIMIT }]);
    expect([10, 60]).toContain(LIMIT.period);
    const taken = Object.values(others).flatMap(
      (worker) =>
        (worker.ratelimits as { namespace_id: string }[] | undefined)?.map((r) => r.namespace_id) ??
        [],
    );
    expect(taken).not.toContain("3001");
  });

  it("sweeps once a day, on a minute no other Worker's pass starts on, the third of the plan's five", () => {
    const own = cronsOf(config);
    expect(own).toEqual(["45 3 * * *"]);
    const minute = (cron: string) => cron.split(" ")[0];
    for (const [name, worker] of Object.entries(others)) {
      for (const cron of cronsOf(worker)) expect(minute(cron), name).not.toBe(minute(own[0]));
    }
    // The free plan allows five cron triggers on the account. `wrangler.jsonc` and the README
    // say this is the third; a Worker that adds one changes both sentences.
    const all = [config, ...Object.values(others)].flatMap(cronsOf);
    expect(all).toHaveLength(3);
    expect(all.length).toBeLessThanOrEqual(5);
  });

  it("ships the application's two public values as placeholders the Worker refuses to run on", () => {
    expect(Object.keys(vars).sort()).toEqual(
      ["DISCORD_APPLICATION_ID", "DISCORD_BASE", "DISCORD_PUBLIC_KEY"].sort(),
    );
    expect(vars.DISCORD_APPLICATION_ID).toBe("<set when the Discord application exists>");
    expect(vars.DISCORD_PUBLIC_KEY).toBe("<set when the Discord application exists>");
    expect(
      configured({
        DISCORD_APPLICATION_ID: vars.DISCORD_APPLICATION_ID,
        DISCORD_PUBLIC_KEY: vars.DISCORD_PUBLIC_KEY,
      }),
    ).toBe(false);
    // And the same check takes real-shaped values, so filling them in is all a deploy needs.
    expect(
      configured({
        DISCORD_APPLICATION_ID: "1300000000000000000",
        DISCORD_PUBLIC_KEY: "0f".repeat(32),
      }),
    ).toBe(true);
  });

  it("keeps no log: a request carries a link secret, an invite, and a callback Discord's code", () => {
    expect(config.observability).toEqual({ enabled: false });
  });

  it("binds nothing else: no bucket, no asset, no service, no alias", () => {
    expect(Object.keys(config).sort()).toEqual(
      [
        "$schema",
        "name",
        "main",
        "compatibility_date",
        "routes",
        "workers_dev",
        "preview_urls",
        "d1_databases",
        "durable_objects",
        "ratelimits",
        "triggers",
        "vars",
        "observability",
      ].sort(),
    );
  });
});

describe("the desktop's address", () => {
  // The desktop's `DISCORD_BASE` (the design, §13.6) is this Worker's address. Read from the Rust
  // wherever it is declared, once it is: a glob, so this file reads as well before that lands.
  const RUST = import.meta.glob(
    ["/apps/desktop/src-tauri/src/**/*.rs", "/crates/grimoire-core/src/**/*.rs"],
    { query: "?raw", import: "default", eager: true },
  );
  const declared = Object.values(RUST).flatMap((text) => [
    ...text.matchAll(/const DISCORD_BASE: &str = "([^"]+)";/g),
  ]);

  it("is DISCORD_BASE, wherever the Rust declares it", () => {
    for (const [, base] of declared) expect(base).toBe(vars.DISCORD_BASE);
  });
});

describe("what must not be in this directory", () => {
  const files = import.meta.glob(
    [
      "/infrastructure/discord-worker/**/*",
      "!/infrastructure/discord-worker/.wrangler/**",
      "!/infrastructure/discord-worker/node_modules/**",
    ],
    { query: "?raw", import: "default", eager: true, exhaustive: true },
  );
  const script = Object.entries(files).filter(
    ([name]) =>
      /\/src\/[\w-]+\.ts$/.test(name) &&
      !/\.(test|d)\.ts$/.test(name) &&
      !name.endsWith("/src/fake.ts"),
  );

  it("sweeps every file here", () => {
    const names = Object.keys(files);
    for (const wanted of [
      "wrangler.jsonc",
      "README.md",
      "migrations/0001_discord-links.sql",
      "src/index.ts",
      "src/rpc.ts",
    ]) {
      expect(names).toContain(`/infrastructure/discord-worker/${wanted}`);
    }
  });

  it("holds no account id, no secret of any Worker's, and nowhere to put a value", () => {
    const SECRETS = [
      "PATREON_CLIENT_SECRET",
      "PATREON_WEBHOOK_SECRET",
      "RELAY_HMAC_KEY",
      "BOT_KEK",
    ];
    const found = Object.entries(files).flatMap(([name, text]) => {
      if (name.endsWith("/src/wrangler.test.ts")) return [];
      const leaks =
        /\baccount_id\b/.test(text) ||
        /\b[0-9a-f]{32}\b/i.test(text) ||
        SECRETS.some((secret) => text.includes(secret));
      return leaks ? [name] : [];
    });
    expect(found).toEqual([]);
    expect(Object.keys(files).filter((name) => /\/\.(dev\.vars|env)[^/]*$/.test(name))).toEqual([]);
  });

  it("reads the client secret by name in one module, and is handed its value by no file", () => {
    expect(JSON.stringify(config)).not.toContain("DISCORD_CLIENT_SECRET");
    const readers = script
      .filter(([, text]) => /\benv\.DISCORD_CLIENT_SECRET\b/.test(text))
      .map(([name]) => name.slice(name.lastIndexOf("/") + 1));
    expect(readers).toEqual(["link.ts"]);
  });

  it("imports no other package's module: the bot's engine is the other script's", () => {
    for (const [name, text] of script) {
      const specifiers = [...text.matchAll(/^import [^"]*"([^"]+)";/gm)].map((m) => m[1]);
      expect(
        specifiers.filter((spec) => !spec.startsWith("./")),
        name,
      ).toEqual([]);
    }
  });

  it("keeps the RPC module types-only, so neither script bundles the other's", () => {
    const rpc = files["/infrastructure/discord-worker/src/rpc.ts"];
    const code = rpc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/^\s*export\s+(const|let|var|function|class|enum|default)\b/m);
    expect(code).not.toMatch(/^\s*import\b/m);
  });

  it("names every table it owns `discord_…`, and uses no table it does not own", () => {
    const sql = Object.entries(files)
      .filter(([name]) => name.endsWith(".sql"))
      .map(([, text]) => text)
      .join("\n");
    const tables = [...sql.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]);
    expect(tables).toEqual(["discord_link_requests", "discord_links"]);
    const code = script.map(([, text]) => text).join("\n");
    const used = new Set(
      [...code.matchAll(/\b(?:FROM|INTO|(?<!DO )UPDATE)\s+(\w+)/g)].map((m) => m[1]),
    );
    expect([...used].sort()).toEqual(tables.sort());
  });
});
