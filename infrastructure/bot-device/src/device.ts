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
import { press, startAdd, type AddHost, type Interaction } from "./add";
import { ENGINE_FAILED, NOT_PAIRED, NOT_YET, answer } from "./interaction";
import type { Proposals } from "./proposals";
import { privately, refused, type Reply } from "./render";
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
 *  purge); `purge` revokes the page store and deletes every byte of storage. The rest is an add's
 *  (`add.ts`): where its proposals are kept, how its work outlives the answer (`ctx.waitUntil`),
 *  and the `fetch` and the two addresses its Scryfall lookup and its reply's edit go to. */
export interface Host {
  open(): Engine;
  purge(): Promise<void>;
  alarms: Alarms;
  publicKey: string;
  now(): number;
  proposals: Proposals;
  defer(work: Promise<unknown>): void;
  fetch: typeof fetch;
  scryfallUrl: string;
  discordApi: string;
}

const APPLICATION_COMMAND = 2;
const MESSAGE_COMPONENT = 3;

/** The interaction's JSON, when it is an object — `answer` says what it is otherwise. */
function parsed(body: string): Interaction | null {
  try {
    const value: unknown = JSON.parse(body);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Interaction)
      : null;
  } catch {
    return null;
  }
}

/** `/collection add` or `/wishlist add`. */
function isAdd(interaction: Interaction): boolean {
  const name = interaction.data?.name;
  return (
    interaction.type === APPLICATION_COMMAND &&
    (name === "collection" || name === "wishlist") &&
    (interaction.data?.options ?? []).find((o) => o.type === 1)?.name === "add"
  );
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
    // `add` and nothing else (§14.1): `read` is a word every build understands, and nothing
    // pairs with it any more.
    if (typeof req?.invite !== "string" || req.capability !== "add") {
      return { ok: false, code: "bad_invite", error: "the request names no invite to add with" };
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
    const interaction = parsed(req.body);
    if (interaction !== null && (interaction.type === MESSAGE_COMPONENT || isAdd(interaction))) {
      return this.#add(engine ?? stubEngine, status, interaction);
    }
    if (engine === null) return answer(stubEngine, NO_ENGINE, req.body);
    return answer(engine, status, req.body);
  }

  /** An add, or a press on one's buttons (`add.ts`). */
  async #add(engine: Engine, status: BotStatus, interaction: Interaction): Promise<Reply> {
    const host: AddHost = {
      engine,
      proposals: this.#host.proposals,
      now: () => this.#host.now(),
      defer: (work) => this.#host.defer(work),
      fetch: this.#host.fetch,
      scryfallUrl: this.#host.scryfallUrl,
      discordApi: this.#host.discordApi,
      alarmBy: (at) => this.#alarmBy(at),
    };
    try {
      if (interaction.type === MESSAGE_COMPONENT) {
        return await press(host, interaction, status.paired, NOT_PAIRED);
      }
      if (!status.paired) return privately(NOT_PAIRED);
      if (status.lastPullAt === null) return privately(NOT_YET);
      return startAdd(host, interaction);
    } catch {
      return privately(ENGINE_FAILED);
    }
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
  folders: () => '{"ok":[]}',
  target: () => '{"err":"the bot did not open"}',
  add: () => '{"err":"the bot did not open"}',
  close: () => {},
};
