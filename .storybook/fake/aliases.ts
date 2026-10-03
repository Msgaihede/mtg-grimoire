import { fileURLToPath } from "node:url";

/**
 * **The four specifiers the fake answers for, in the one place both of its Vite hosts read them**
 * — `.storybook/main.ts` (the workbench) and `vite.mobile.config.ts` (`npm run mobile:dev`, the
 * light app over the fake in a plain browser). The second used to restate the list by hand with
 * nothing holding the two together, so a fifth boundary added to the workbench would have reached
 * every story and left the light app calling the real module.
 *
 * **The fake sits _under_ `src/lib/ipc.ts`, not in place of it**, and that is why these are the
 * Tauri modules rather than `ipc` itself: `ipc.ts` is the hand-written mirror of the Rust structs
 * and the thing that can drift, so a fake beneath it means every story — and the light app in a
 * browser — exercises the mirror too.
 *
 * **Exact-match rules, as an array, and the order is part of the contract.** `@/lib/images` has
 * to be tried before a host's own bare `@/` prefix: `main.ts` appends that prefix after these, and
 * `mergeConfig` puts these ahead of `vite.config.ts`'s `@` alias.
 *
 * **Absolute paths, never root-relative.** The dependency optimizer applies an alias while it
 * pre-bundles a Tauri plugin that imports `@tauri-apps/api/core` from inside `node_modules`, and a
 * root-relative replacement is read off the drive's root there — the light dev server exited of
 * it on 2026-10-01 (`docs/reference/light-app.md` §4).
 *
 * Node code, like `main.ts`: it is type-checked by the `.storybook` program, which is the one that
 * declares `node:url` (`node-url.d.ts`). `src/stories.test.tsx` cannot read it — a Vitest
 * `vi.mock` matches a resolved id rather than a specifier — and keeps its own three mocks.
 */
export const FAKE_ALIASES: { find: RegExp; replacement: string }[] = [
  { find: /^@tauri-apps\/api\/core$/, replacement: fake("core.ts") },
  { find: /^@tauri-apps\/api\/event$/, replacement: fake("event.ts") },
  { find: /^@tauri-apps\/api\/window$/, replacement: fake("window.ts") },
  { find: /^@\/lib\/images$/, replacement: fake("images.ts") },
];

/** A file of the fake, as an absolute path on this machine. */
function fake(name: string): string {
  return fileURLToPath(new URL(`./${name}`, import.meta.url));
}
