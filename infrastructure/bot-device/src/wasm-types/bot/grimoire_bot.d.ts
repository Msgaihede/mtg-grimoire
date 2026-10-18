/**
 * **The bot's wasm glue, as this program sees it** — hand-written, because the file
 * `wasm-bindgen` writes (`dist-wasm/bot/grimoire_bot.d.ts`, beside the `.js` `engine.ts` imports)
 * is a build output and not in git, and this program must type-check on a checkout that has not
 * built it. `tsconfig.json`'s `rootDirs` lays this folder over `dist-wasm/`, so the import's
 * relative path finds this file when the build's is not there.
 *
 * ⚠️ **It mirrors `crates/grimoire-bot/src/glue.rs`**, method for method, and nothing checks the
 * two against each other but `scripts/build-wasm.ts`'s export check (each method below is in its
 * `MODULES.bot.classes`) and a run under workerd. Change both in one commit.
 */
export class Bot {
  private constructor();
  free(): void;
  /** `store` is a `PageStoreJs` (`src/store.ts`). */
  static open(store: unknown, kek: string, object: string, options: string): Bot;
  enroll(invite: string, capability: string): Promise<string>;
  advance(): Promise<string>;
  status(): string;
  collection_by_name(name: string): string;
  wishlist_by_name(name: string): string;
  names(kind: string, prefix: string, limit: number): string;
  decks(prefix: string): string;
  deck_cards(uid: string): string;
  close(): void;
}

export function initSync(module: { module: WebAssembly.Module }): unknown;
