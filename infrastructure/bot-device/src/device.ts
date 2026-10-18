/**
 * **The Durable Object's decisions, with no Durable Object in them** — what `index.ts`'s
 * `BotDevice` does on each RPC and alarm, over an injected engine, storage and clock, so the
 * tests run it with a fake engine (`fake.ts`).
 */
import type {
  BotStatus,
  EnrollRequest,
  Enrolled,
  EnrollRefused,
  InteractionAnswer,
  InteractionRequest,
} from "@grimoire/discord-worker/src/rpc";
import { answer } from "./interaction";
import { refused } from "./render";
import type { Advanced, Engine } from "./types";
import { discordSigned } from "./verify";

/** A pull older than this makes an interaction ask for an alarm (§13.7: two minutes). */
export const STALE_MS = 2 * 60 * 1000;

/** The alarm half of `ctx.storage`. */
export interface Alarms {
  getAlarm(): Promise<number | null>;
  setAlarm(at: number): Promise<void>;
  deleteAlarm(): Promise<void>;
}

/** What the device is built over. `open` makes the engine (once per instance, again after a
 *  purge); `purge` revokes the page store and deletes every byte of storage. */
export interface Host {
  open(): Engine;
  purge(): Promise<void>;
  alarms: Alarms;
  publicKey: string;
  now(): number;
}

const NO_ENGINE: BotStatus = {
  enrolled: false,
  deviceId: null,
  paired: false,
  lastPullAt: null,
  error: null,
};

export class Device {
  #host: Host;
  #engine: Engine | null = null;
  #failed: string | null = null;

  constructor(host: Host) {
    this.#host = host;
  }

  /** The engine, opened on first use. `null` when it would not open (a missing `BOT_KEK`). */
  #open(): Engine | null {
    if (this.#engine !== null) return this.#engine;
    try {
      this.#engine = this.#host.open();
      this.#failed = null;
    } catch (e) {
      this.#failed = e instanceof Error ? e.message : String(e);
    }
    return this.#engine;
  }

  /** Ask for an alarm at `at`, unless one is already due sooner. */
  async #alarmBy(at: number): Promise<void> {
    const due = await this.#host.alarms.getAlarm();
    if (due === null || due > at) await this.#host.alarms.setAlarm(at);
  }

  async enroll(req: EnrollRequest): Promise<Enrolled | EnrollRefused> {
    const engine = this.#open();
    if (engine === null) {
      return { ok: false, code: "pairing_failed", error: this.#failed ?? "the bot did not open" };
    }
    if (typeof req?.invite !== "string" || req.capability !== "read") {
      return { ok: false, code: "bad_invite", error: "the request names no invite to read with" };
    }
    const answered = JSON.parse(await engine.enroll(req.invite, req.capability)) as
      Enrolled | EnrollRefused;
    // The pairing completes on the rendezvous: poll it soon.
    if (answered.ok) await this.#alarmBy(this.#host.now() + 1500);
    return answered;
  }

  async status(): Promise<BotStatus> {
    const engine = this.#open();
    if (engine === null) return { ...NO_ENGINE, error: this.#failed };
    return JSON.parse(engine.status()) as BotStatus;
  }

  async interaction(req: InteractionRequest): Promise<InteractionAnswer> {
    const signed = await discordSigned(
      this.#host.publicKey,
      req?.body ?? "",
      req?.signature ?? "",
      req?.timestamp ?? "",
      this.#host.now(),
    );
    if (!signed) return refused(401, "invalid request signature");
    const engine = this.#open();
    const status = engine === null ? NO_ENGINE : (JSON.parse(engine.status()) as BotStatus);
    // **Freshness** (§13.7): answer from what is held, and when that is over two minutes old ask
    // for a pull — in an alarm, never here.
    const now = this.#host.now();
    if (status.paired && (status.lastPullAt === null || now - status.lastPullAt > STALE_MS)) {
      await this.#alarmBy(now);
    }
    if (engine === null) return answer(stubEngine, NO_ENGINE, req.body);
    return answer(engine, status, req.body);
  }

  /** `ctx.storage.deleteAll()` — the identity, the group key and every page, gone for good. */
  async unlink(): Promise<void> {
    this.#engine?.close();
    this.#engine = null;
    await this.#host.alarms.deleteAlarm();
    await this.#host.purge();
  }

  /** An alarm: one step of the engine, then the next alarm it asks for — or the purge. */
  async alarm(): Promise<Advanced | null> {
    const engine = this.#open();
    if (engine === null) return null;
    const step = JSON.parse(await engine.advance()) as Advanced;
    if (step.purge) {
      await this.unlink();
      return step;
    }
    if (step.nextInMs !== null) await this.#alarmBy(this.#host.now() + step.nextInMs);
    return step;
  }
}

/** An engine that holds nothing — what an interaction is answered from when the real one would
 *  not open. Every interaction it sees is told the bot is not paired. */
const stubEngine: Engine = {
  enroll: async () => "{}",
  advance: async () => "{}",
  status: () => JSON.stringify(NO_ENGINE),
  collection_by_name: () => '{"ok":null}',
  wishlist_by_name: () => '{"ok":null}',
  names: () => '{"ok":[]}',
  decks: () => '{"ok":[]}',
  deck_cards: () => '{"ok":null}',
  close: () => {},
};
