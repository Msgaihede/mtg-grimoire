/**
 * The two Vite imports `hosting.test.ts` reads files as text by, declared for this program alone
 * — `relay/src/raw.d.ts`'s arrangement, and its reason: `tsconfig.app-worker.json` pins `types`
 * to `@cloudflare/workers-types`, so `vite/client` is deliberately out of reach. The root vitest
 * resolves both whatever `tsc` is told.
 */
declare module "*?raw" {
  const text: string;
  export default text;
}

interface ImportMeta {
  /** Every file a pattern matches, as text, by its path from the repository root. */
  glob(
    pattern: string | string[],
    options: { query: "?raw"; import: "default"; eager: true },
  ): Record<string, string>;
}
