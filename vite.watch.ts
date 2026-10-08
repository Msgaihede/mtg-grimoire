/**
 * What no dev server in this repository watches: `server.watch.ignored` for `vite.base.ts` —
 * and through `mergeConfig`, which concatenates arrays, for every config merged over it — and
 * for Storybook, which cannot inherit it and so imports it (`.storybook/main.ts` has why).
 *
 * **A dev server watches its root, and the roots here are of two kinds.** Storybook's is the
 * repository, so its watcher is handed the whole checkout. Each app's is its own folder since
 * 2026-10-08 — `apps/desktop`, `apps/light`, `apps/share` — which still holds that app's own
 * build outputs and, for two of them, a cargo host. (Until then every config rooted at the
 * repository, because the base config's `@` alias was the root-relative `"/src"`, and every
 * server was handed everything.) Of the build outputs under a root, Vite keeps the watcher out
 * of `node_modules` and the *running* config's own `outDir` and no other: the light app's
 * server in the mode that builds into `apps/light/dist-mobile/` ignores that folder, and
 * watches `apps/light/dist-web/` beside it. The chokidar Vite bundles takes an `fs.watch` on
 * every **file** it finds, so each of the rest is watched one file at a time, as the build
 * writes it.
 *
 * **On Windows that is fatal rather than wasteful.** A watch taken on a file a compiler still
 * holds open is refused with `EBUSY`, chokidar raises it as an `error` event nobody listens
 * for, and the process exits. Driven 2026-10-01 on Windows 11, Vite 8.3.1, Node 24.16, with
 * `cargo clean -p libsqlite3-sys` in front of the card scanner's `cargo test` to force the
 * files into existence: the base config's server and the share viewer's both exited on the
 * first run — one on `…/libsqlite3-sys-…/out/…-sqlite3.o`, one on that crate's
 * `build_script_build-….exe` — and Storybook on the second. That is the tail of
 * `npm run verify`, so a dev server left up through one died, having already reloaded the page
 * once for `dist/index.html`.
 *
 * `src-tauri` is Tauri's own template line, and it used to cover the workspace's `target`,
 * which was inside the desktop host's folder. **The workspace's build tree is at the repository
 * root since 2026-10-08**, outside both hosts, so `target` has a line of its own — the one
 * Storybook's server needs, with the whole checkout under it. The card scanner is deliberately
 * not a member of that workspace and builds into a `target/` of its own; its line is the entry
 * that was missing on 2026-10-01, and it stays for what it says, though the new one covers it.
 * The rest are the build outputs `.gitignore` names. Each opens with a globstar so that it also
 * holds in the main checkout, where `.claude/worktrees/` puts whole second checkouts — every
 * one with all of these — under the root. (Spelled out, because the glob prefix itself would
 * close this comment.)
 *
 * `dist-wasm/` is the one a dev server is most likely to be up beside while it is written:
 * `npm run web:wasm` rebuilds the engine the web app's server (`npm run web:dev`) is serving.
 */
export const WATCH_IGNORED = [
  "**/src-tauri/**",
  "**/target/**",
  "**/crates/**/target/**",
  "**/dist/**",
  "**/dist-mobile/**",
  "**/dist-share/**",
  "**/dist-web/**",
  "**/dist-wasm/**",
  "**/storybook-static/**",
];
