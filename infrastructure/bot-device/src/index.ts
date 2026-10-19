/**
 * **`mtg-grimoire-bot-device`** — the Discord bot as a restricted device of a reader's sync group
 * (the Discord spec, `docs/superpowers/specs/2026-10-17-discord-integration-design.md`, §9, §13).
 *
 * One `BotDevice` Durable Object per Discord link. It holds the bot's identity, the group key and
 * the group's materialised data — `grimoire-core` in wasm (`crates/grimoire-bot`), over a SQLite
 * page store on this object's SQL storage, every page sealed under `BOT_KEK` (`store.ts`). It
 * implements §13.2's RPC for the Discord front (`infrastructure/discord-worker`, the one script
 * that can reach it — this Worker has no route) and pulls in its alarms. What it decides is
 * `device.ts`'s; this file is the binding of that to workerd.
 */
import { DurableObject } from "cloudflare:workers";
import type {
  BotDeviceRpc,
  BotStatus,
  EnrollRequest,
  Enrolled,
  EnrollRefused,
  InteractionAnswer,
  InteractionRequest,
} from "@grimoire/discord-worker/src/rpc";
import { Device } from "./device";
import { DISCORD_API } from "./discord";
import { openEngine } from "./engine";
import { Proposals, proposalKey } from "./proposals";
import { API as SCRYFALL_API } from "./scryfall";
import { SqlPageStore } from "./store";

export interface Env {
  /** 32 bytes, base64url — a secret, never committed (the README's runbook). */
  BOT_KEK: string;
  /** Discord's application public key, hex. */
  DISCORD_PUBLIC_KEY: string;
  /** Local runs only (`wrangler dev --local`): a relay and a Scryfall to point the engine at, and
   *  a Discord API for an add's reply to be edited at. */
  BOT_RELAY_URL?: string;
  BOT_SCRYFALL_URL?: string;
  BOT_DISCORD_API?: string;
}

export class BotDevice extends DurableObject<Env> implements BotDeviceRpc {
  #device: Device;
  #store: SqlPageStore | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#device = new Device({
      open: () => {
        this.#store = new SqlPageStore(ctx.storage);
        return openEngine(this.#store, env.BOT_KEK ?? "", ctx.id.toString(), {
          ...(env.BOT_RELAY_URL ? { relayUrl: env.BOT_RELAY_URL } : {}),
          ...(env.BOT_SCRYFALL_URL ? { scryfallUrl: env.BOT_SCRYFALL_URL } : {}),
        });
      },
      purge: async () => {
        this.#store?.revoke();
        this.#store = null;
        await ctx.storage.deleteAll();
      },
      alarms: ctx.storage,
      publicKey: env.DISCORD_PUBLIC_KEY ?? "",
      now: () => Date.now(),
      // An add's proposals, beside the page store and sealed under the same secret (`proposals.ts`).
      proposals: new Proposals(ctx.storage, () =>
        proposalKey(env.BOT_KEK ?? "", ctx.id.toString()),
      ),
      // An add's Scryfall lookup and its reply's edit run after the deferred answer has gone.
      defer: (work) => ctx.waitUntil(work),
      fetch: (input, init) => fetch(input, init),
      scryfallUrl: env.BOT_SCRYFALL_URL || SCRYFALL_API,
      discordApi: env.BOT_DISCORD_API || DISCORD_API,
    });
  }

  enroll(req: EnrollRequest): Promise<Enrolled | EnrollRefused> {
    return this.#device.enroll(req);
  }

  interaction(req: InteractionRequest): Promise<InteractionAnswer> {
    return this.#device.interaction(req);
  }

  status(): Promise<BotStatus> {
    return this.#device.status();
  }

  unlink(): Promise<void> {
    return this.#device.unlink();
  }

  async alarm(): Promise<void> {
    await this.#device.alarm();
  }
}

/** No route reaches this Worker; a request that somehow does is told nothing. */
export default {
  fetch(): Response {
    return new Response(null, { status: 404 });
  },
};
