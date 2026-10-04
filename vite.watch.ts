/**
 * What no dev server in this repository watches: `server.watch.ignored` for `vite.config.ts` —
 * and through `mergeConfig`, which concatenates arrays, for every config merged over it — and
 * for Storybook, which cannot inherit it and so imports it (`.storybook/main.ts` has why).
 *
 * **Every Vite config here roots at the repository**, because the base config's `"@": "/src"`
 * alias is root-relative (`vite.share.config.ts` has the long form), so the watcher is handed
 * the whole checkout. Of the build outputs under it, Vite keeps the watcher out of
 * `node_modules` and the *running* config's own `outDir` and no other: the share viewer's
 * server ignores `dist-share/` and watches `dist/`. The chokidar Vite bundles takes an
 * `fs.watch` on every **file** it finds, so each of the rest is watched one file at a time,
 * as the build writes it.
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
 * `src-tauri` is Tauri's own template line and covers `src-tauri/target`. The card scanner is
 * deliberately not a member of that workspace and builds into a `target/` of its own, which
 * is the entry that was missing; the rest are the build outputs `.gitignore` names. Each
 * opens with a globstar so that it also holds in the main checkout, where `.claude/worktrees/`
 * puts whole second checkouts — every one with all of these — under the root. (Spelled
 * out, because the glob prefix itself would close this comment.)
 *
 * `dist-wasm/` is the one a dev server is most likely to be up beside while it is written:
 * `npm run web:wasm` rebuilds the engine the web app's server (`npm run web:dev`) is serving.
 */
export const WATCH_IGNORED = [
  "**/src-tauri/**",
  "**/crates/**/target/**",
  "**/dist/**",
  "**/dist-mobile/**",
  "**/dist-share/**",
  "**/dist-web/**",
  "**/dist-wasm/**",
  "**/storybook-static/**",
];
