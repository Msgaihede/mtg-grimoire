/**
 * The fake's integrations switch — the workbench's stand-in for the store's four commands
 * (issue #1396, plan `2026-10-25-integrations-projection-store.md` §3.3).
 *
 * The fake has no store and no second device, so what is held here is what the panel's stories
 * lean on: that every world opens off with every column off, that a reader with no membership and
 * a build with no address are refused before anything changes, that the switch and the columns
 * round-trip, that **a press asks for a round and the round stamps the send** (the crate's own
 * rule), that a disable clears everything, that a held lane refuses the writes and never the
 * status, and that the two faults change only what their paragraphs say.
 */
import { describe, expect, it } from "vitest";
import type { IntegrationFields } from "@grimoire/ui/lib/ipc";
import integrationStoreRs from "../../crates/grimoire-core/src/integration/store.rs?raw";
import integrationSettingsRs from "../../crates/grimoire-core/src/integration/settings.rs?raw";
import {
  INTEGRATIONS_NOT_CONNECTED,
  INTEGRATIONS_NOT_DEPLOYED,
  INTEGRATIONS_OFF,
  INTEGRATIONS_ROUND_FAILED,
  applyIntegrationsFault,
  integrationHandlers,
  makeDb,
  type FakeDb,
  type Fault,
} from "./db";
import { seed } from "./seeds";

/** Condition and notes on, the rest off — mixed, so two columns crossed in a write would show. */
const SOME: IntegrationFields = {
  condition: true,
  lang: false,
  value: false,
  tags: false,
  notes: true,
};

/** A `pub const` string out of a Rust source. `\s*` after the `=`: rustfmt may break the line. */
function rustSentence(source: string, file: string, name: string): string {
  const found = new RegExp(`pub const ${name}: &str =\\s*"([^"]+)";`).exec(source)?.[1];
  if (found === undefined) throw new Error(`no \`pub const ${name}\` found in ${file}`);
  return found;
}

/** A reader whose device can mint a relay token: this device connected Patreon. */
function entitled(fault: Fault | null = null): FakeDb {
  const db = makeDb({
    supporter: { refreshSecret: true, status: "active", since: 1_786_000_000, groupBound: true },
  });
  db.fault = fault;
  return db;
}

describe("the fake's integrations sentences are the engine's", () => {
  // A story asserts the sentence the fake throws, and the panel draws the sentence the engine
  // answers: two copies of one text, held here word for word.
  it.each([
    [INTEGRATIONS_NOT_DEPLOYED, integrationStoreRs, "store.rs", "NOT_DEPLOYED"],
    [INTEGRATIONS_NOT_CONNECTED, integrationStoreRs, "store.rs", "NOT_CONNECTED"],
    [INTEGRATIONS_OFF, integrationSettingsRs, "settings.rs", "OFF"],
    [INTEGRATIONS_ROUND_FAILED, integrationSettingsRs, "settings.rs", "ROUND_FAILED"],
  ])("%s", (fake, source, file, name) => {
    expect(fake).toBe(rustSentence(source, file, name));
  });
});

describe("the integrations switch, as the fake answers it", () => {
  it("opens off, with every column off and nothing asked or sent, in a seeded world", () => {
    const status = integrationHandlers(seed("starter")).integrations_status();

    expect(status).toEqual({
      available: true,
      // `starter` connected nothing, so no relay token — the panel's not-entitled sentence.
      entitled: false,
      enabled: false,
      fields: { condition: false, lang: false, value: false, tags: false, notes: false },
      checkedAt: null,
      publishedAt: null,
      error: null,
      pending: false,
    });
  });

  it("is entitled in the `shared` world, whose device connected", () => {
    expect(integrationHandlers(seed("shared")).integrations_status().entitled).toBe(true);
  });

  it("refuses every write from a reader with no membership, and changes nothing", () => {
    const db = makeDb();
    const commands = integrationHandlers(db);

    expect(() => commands.integrations_enable({ fields: SOME })).toThrow(
      INTEGRATIONS_NOT_CONNECTED,
    );
    expect(() => commands.integrations_set_fields({ fields: SOME })).toThrow(
      INTEGRATIONS_NOT_CONNECTED,
    );
    expect(() => commands.integrations_disable()).toThrow(INTEGRATIONS_NOT_CONNECTED);
    expect(db.integrations.enabled).toBe(false);
  });

  /**
   * **The round publishes, not the press** — `settings.rs`' own test, and the reason the panel
   * polls: a fake that stamped the send on the press drew "Last sent … just now" at once, where
   * the real panel would sit on "Nothing sent" until something asked again.
   */
  it("switches on under the columns it was sent, and asks for a round rather than sending", () => {
    const db = entitled();
    const commands = integrationHandlers(db);
    const status = commands.integrations_enable({ fields: SOME });

    expect(status.enabled).toBe(true);
    expect(status.fields).toEqual(SOME);
    expect(status.publishedAt).toBeNull();
    expect(status.pending).toBe(true);

    // The next ask finds the round run: the copy sent, the request answered.
    const after = commands.integrations_status();
    expect(after.fields).toEqual(SOME);
    expect(after.publishedAt).not.toBeNull();
    expect(after.pending).toBe(false);
  });

  it("changes the columns while on, and refuses to while off", () => {
    const db = entitled();
    const commands = integrationHandlers(db);

    expect(() => commands.integrations_set_fields({ fields: SOME })).toThrow(INTEGRATIONS_OFF);
    expect(db.integrations.enabled).toBe(false);

    commands.integrations_enable({ fields: SOME });
    commands.integrations_status();
    const status = commands.integrations_set_fields({ fields: { ...SOME, lang: true } });
    expect(status.fields).toEqual({ ...SOME, lang: true });
    // The store dropped every table: a round is owed again.
    expect(status.pending).toBe(true);
  });

  it("clears the columns, the send stamp and the owed round when switched off", () => {
    const db = entitled();
    const commands = integrationHandlers(db);
    commands.integrations_enable({ fields: SOME });
    commands.integrations_status();
    commands.integrations_set_fields({ fields: { ...SOME, value: true } });

    const status = commands.integrations_disable();

    expect(status.enabled).toBe(false);
    expect(status.fields).toEqual({
      condition: false,
      lang: false,
      value: false,
      tags: false,
      notes: false,
    });
    expect(status.publishedAt).toBeNull();
    expect(status.pending).toBe(false);
    expect(status.error).toBeNull();
  });

  /**
   * The crate's three writes take the lane as a press does and refuse with `db::BUSY` while a
   * trip or a round holds it; its status answers the cache instead — and a cache answer has asked
   * nobody, so it neither stamps `checkedAt` nor runs the round still owed.
   */
  it("refuses the writes while the lane is held, and answers the status from what it holds", () => {
    const db = entitled();
    const commands = integrationHandlers(db);
    commands.integrations_enable({ fields: SOME });
    const checked = db.integrations.checkedAt;
    db.fault = "busy";

    expect(() => commands.integrations_enable({ fields: SOME })).toThrow(/busy/i);
    expect(() => commands.integrations_set_fields({ fields: SOME })).toThrow(/busy/i);
    expect(() => commands.integrations_disable()).toThrow(/busy/i);

    const status = commands.integrations_status();
    expect(status.enabled).toBe(true);
    expect(status.pending).toBe(true);
    expect(status.checkedAt).toBe(checked);
  });

  it("answers `available: false` and refuses first in a build with no address", () => {
    const db = entitled("integrationsNotDeployed");
    const commands = integrationHandlers(db);

    const status = commands.integrations_status();
    expect(status.available).toBe(false);
    // A build with no address asks nobody, so nothing was checked.
    expect(status.checkedAt).toBeNull();
    expect(() => commands.integrations_enable({ fields: SOME })).toThrow(INTEGRATIONS_NOT_DEPLOYED);
    expect(db.integrations.enabled).toBe(false);
  });

  /**
   * An On state, as `installWorld` stands it up: the crate clears a round's failure whenever it
   * hears the store is off, so the sentence is only ever drawn over a switch that is on. A press
   * clears it (`settle_on`); every round in this world fails, so the next one puts it back.
   */
  it("is a store that is on with a failed round behind it, and every round fails", () => {
    const db = entitled("integrationsError");
    applyIntegrationsFault(db);
    const commands = integrationHandlers(db);

    const before = commands.integrations_status();
    expect(before.enabled).toBe(true);
    expect(before.error).toBe(INTEGRATIONS_ROUND_FAILED);
    const sent = before.publishedAt;
    expect(sent).not.toBeNull();

    const pressed = commands.integrations_set_fields({ fields: SOME });
    expect(pressed.error).toBeNull();
    expect(pressed.pending).toBe(true);

    const after = commands.integrations_status();
    expect(after.error).toBe(INTEGRATIONS_ROUND_FAILED);
    expect(after.pending).toBe(false);
    expect(after.publishedAt).toBe(sent);
  });

  it("leaves every other world off", () => {
    const db = entitled();
    applyIntegrationsFault(db);
    expect(db.integrations.enabled).toBe(false);
  });
});
