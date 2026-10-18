/**
 * **The engine** — the bot's wasm module, instantiated once per isolate, and the narrow shape the
 * rest of this Worker uses it through.
 *
 * Everything else here takes an {@link Engine}, never the module, so `vitest` runs the Durable
 * Object's decisions with a fake (`fake.ts`) and no wasm at all. This file is the one that loads
 * the module, and the one the tests replace.
 */
// By path, into the build's output (`node scripts/build-wasm.ts --only bot`): the module is the
// root's build artefact, no package's, and wrangler's wasm rule matches an import that names the
// `.wasm` file itself.
import wasm from "../../../dist-wasm/bot/grimoire_bot_bg.wasm";
import { Bot, initSync } from "../../../dist-wasm/bot/grimoire_bot.js";
import type { PageStoreJs } from "./store";
import type { Engine } from "./types";

let ready = false;

/** Instantiate the module — once: two instances of a `wasm-bindgen` module in one isolate would
 *  share nothing, and the VFS registry must be one. */
function load(): void {
  if (ready) return;
  initSync({ module: wasm });
  ready = true;
}

/** Open the engine for one Durable Object (`Bot.open`); throws one sentence. */
export function openEngine(
  store: PageStoreJs,
  kek: string,
  object: string,
  options: { relayUrl?: string; scryfallUrl?: string },
): Engine {
  load();
  return Bot.open(store, kek, object, JSON.stringify(options));
}
