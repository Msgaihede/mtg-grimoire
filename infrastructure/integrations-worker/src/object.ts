import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import type { GroupSettings, Table } from "./projection";
import {
  Store,
  type Answer,
  type Digests,
  type SettingsAnswer,
  type StoreRpc,
  type Watermark,
} from "./store";

/**
 * **`GroupStore`** — one Durable Object per group, addressed by `idFromName(group)`, holding that
 * group's store on its own SQLite storage (`wrangler.jsonc`'s `new_sqlite_classes`). Everything it
 * decides is `store.ts`'s; this file is the binding of that to workerd, and the one module of
 * the Worker the suite cannot import (`cloudflare:workers` is the runtime's).
 *
 * **Reached over Workers RPC from this Worker's router and from nothing else**: no route names
 * an object, and no other script binds the namespace. Each method takes the group the router
 * matched, which the store holds itself to (`#own`).
 */
export class GroupStore extends DurableObject<Env> implements StoreRpc {
  #store: Store;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#store = new Store(ctx.storage, env);
  }

  digests(group: string): Promise<Digests | null> {
    return this.#store.digests(group);
  }

  settings(
    group: string,
    wanted: GroupSettings,
    create: boolean,
    now: number,
  ): Promise<SettingsAnswer | null> {
    return this.#store.settings(group, wanted, create, now);
  }

  replace(
    group: string,
    table: Table,
    gz: Uint8Array,
    watermark: Watermark,
    digest: string,
    now: number,
  ): Promise<Answer> {
    return this.#store.replace(group, table, gz, watermark, digest, now);
  }

  exists(): Promise<boolean> {
    return this.#store.exists();
  }

  deleteAll(): Promise<void> {
    return this.#store.deleteAll();
  }
}
