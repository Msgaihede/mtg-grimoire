/**
 * The fake's Discord commands (issue #1096, spec §13.6) — `discordHandlers` in `db.ts`.
 *
 * What is held here is the part a story leans on: the state machine unlinked → linking → linked
 * → enrolled, a sign-in the fake approves on its **second** claim, a request past its ten minutes
 * refused, the gate refusing before anything is enrolled, and the faults standing up the states
 * no press can reach. Which names exist is `parity.test.ts`'s, against `desktop.rs`.
 */
import { describe, expect, it } from "vitest";
import {
  DISCORD_BOT_DEVICE_ID,
  DISCORD_GATE_SENTENCE,
  DISCORD_LINK_EXPIRED,
  DISCORD_LINK_MS,
  DISCORD_NOT_LINKED,
  DISCORD_UNREACHABLE,
  allHandlers,
  applyDiscordFault,
  discordHandlers,
  makeDb,
} from "./db";

const UNLINKED = {
  linked: false,
  username: null,
  discordUserId: null,
  linking: false,
  linkExpiresAt: null,
  enrolled: false,
  botDeviceId: null,
  lastPullAt: null,
  gate: null,
};

describe("the fake's Discord sign-in", () => {
  it("starts unlinked, and links on the second claim after a begin", () => {
    const h = discordHandlers(makeDb());
    expect(h.discord_status()).toEqual(UNLINKED);

    const start = h.discord_link_begin();
    expect(start.authorizeUrl).toMatch(/^https:\/\/discord\.com\/oauth2\/authorize\?/);
    expect(start.authorizeUrl).toContain("integration_type=1");
    expect(h.discord_status()).toMatchObject({ linking: true, linkExpiresAt: start.expiresAt });

    expect(h.discord_link_poll()).toMatchObject({ linked: false, linking: true });
    expect(h.discord_link_poll()).toMatchObject({
      linked: true,
      linking: false,
      username: "giradeli",
      linkExpiresAt: null,
      enrolled: false,
      gate: null,
    });
  });

  it("refuses a request past its deadline, and forgets it", () => {
    const db = makeDb();
    const h = discordHandlers(db);
    h.discord_link_begin();
    db.discord.pending = { expiresAt: Date.now() - 1, polls: 0 };

    expect(() => h.discord_link_poll()).toThrow(DISCORD_LINK_EXPIRED);
    expect(h.discord_status().linking).toBe(false);
  });

  it("forgets a pending request on cancel", () => {
    const h = discordHandlers(makeDb());
    h.discord_link_begin();

    expect(h.discord_link_cancel()).toEqual(UNLINKED);
  });

  it("never approves under `discordLinking`, which stands a request up", () => {
    const db = makeDb({ fault: "discordLinking" });
    applyDiscordFault(db);
    const h = discordHandlers(db);
    expect(h.discord_status().linking).toBe(true);
    expect(h.discord_status().linkExpiresAt).toBeGreaterThan(Date.now() + DISCORD_LINK_MS - 5_000);

    for (let i = 0; i < 5; i += 1) expect(h.discord_link_poll().linked).toBe(false);
  });

  it("refuses to begin under `discordUnreachable`", () => {
    const db = makeDb({ fault: "discordUnreachable" });
    expect(() => discordHandlers(db).discord_link_begin()).toThrow(DISCORD_UNREACHABLE);
    expect(db.discord.pending).toBeNull();
  });
});

describe("the fake's Discord enable and disable", () => {
  const world = (fault: "discordLinked" | "discordGate" | "discordEnrolled") => {
    const db = makeDb({ fault });
    applyDiscordFault(db, 1_760_700_000_000);
    return db;
  };

  it("enrols the bot from a linked account that is ready", () => {
    const h = discordHandlers(world("discordLinked"));
    expect(h.discord_status()).toMatchObject({ linked: true, enrolled: false, gate: null });

    expect(h.discord_enable()).toMatchObject({
      linked: true,
      enrolled: true,
      botDeviceId: DISCORD_BOT_DEVICE_ID,
      lastPullAt: null,
      gate: null,
    });
  });

  it("refuses to enable before a link, and in the gate's own sentence under `discordGate`", () => {
    expect(() => discordHandlers(makeDb()).discord_enable()).toThrow(DISCORD_NOT_LINKED);

    const db = world("discordGate");
    const h = discordHandlers(db);
    expect(h.discord_status().gate).toBe(DISCORD_GATE_SENTENCE);
    expect(() => h.discord_enable()).toThrow(DISCORD_GATE_SENTENCE);
    expect(db.discord.bot).toBeNull();
  });

  it("stands up an enrolled bot that fetched two hours ago under `discordEnrolled`", () => {
    expect(discordHandlers(world("discordEnrolled")).discord_status()).toEqual({
      linked: true,
      username: "giradeli",
      discordUserId: "1029384756473829101",
      linking: false,
      linkExpiresAt: null,
      enrolled: true,
      botDeviceId: DISCORD_BOT_DEVICE_ID,
      lastPullAt: 1_760_700_000_000 - 2 * 60 * 60_000,
      gate: null,
    });
  });

  it("forgets the bot and the link on disable", () => {
    expect(discordHandlers(world("discordEnrolled")).discord_disable()).toEqual(UNLINKED);
  });

  it("is in the whole command table a story registers", () => {
    const names = Object.keys(allHandlers(makeDb()));
    for (const name of Object.keys(discordHandlers(makeDb()))) expect(names).toContain(name);
    expect(Object.keys(discordHandlers(makeDb())).sort()).toEqual([
      "discord_disable",
      "discord_enable",
      "discord_link_begin",
      "discord_link_cancel",
      "discord_link_poll",
      "discord_status",
    ]);
  });
});
