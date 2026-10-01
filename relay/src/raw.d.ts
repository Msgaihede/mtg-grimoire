/**
 * Vite's `?raw` import, declared for this program alone.
 *
 * `tsconfig.relay.json` pins `types` to `@cloudflare/workers-types` and nothing else, so
 * `vite/client` — where the app's program gets this declaration — is deliberately not in reach.
 * The root vitest still resolves the import, which is what lets a relay test read
 * `wrangler.jsonc` as text and hold a binding's name to the code that asks for it.
 */
declare module "*?raw" {
  const text: string;
  export default text;
}
