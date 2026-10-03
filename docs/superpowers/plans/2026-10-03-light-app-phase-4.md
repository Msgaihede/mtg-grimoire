# The light app, phase 4 — the Android host

Issue #761's phase 4: a second Tauri project, `mobile/src-tauri`, depending on `grimoire-core`.
The design is [the light-app spec](../specs/2026-10-01-light-app-android-and-web-design.md) §5;
the record of each step is [light-app.md](../../reference/light-app.md) §8.

## Decided before building (Markus, 2026-10-03)

| Question | Answer |
| --- | --- |
| Where the APK is built | **In CI.** This session's container cannot reach `dl.google.com` (the egress proxy answers 403), so neither the SDK nor the NDK installs here; `ubuntu-24.04` ships both and JDK 21 |
| How the first PR is cut | **4.1 the host, 4.2 the table** — each its own PR, auto-merge and auto-fix armed |
| Signing and distribution | **A debug-signed APK for now**; decided after a real phone has run it |
| An Android tablet ≥ 1024px | **Keeps the width rule** — the desktop face, as a wide browser gets it. Pinning the phone face would need the host to tell the page what it is (spec §3) |

## Steps — one PR each

1. **4.1 — the host, its seam and the APK.** `mobile/src-tauri` (workspace member
   `grimoire-light`): the mobile entry point, `core_call` over `grimoire_core::dispatch`, the
   startup gate answered inside it, the `mtgimg` protocol over the core's `images::answer` (moved
   from `src-tauri`), the launch over a new `grimoire_core::launch::open`. The `Core` seam picks
   `core_call` by a mark the host sets (`window.__GRIMOIRE_CORE__`), below `@/lib/core`.
   `gen/android` generated against a stub SDK and committed with its hand edits, each held by
   `mobile/host.test.ts`. A CI `android` job that builds a release APK signed with the debug key
   and reports its size; `release-please` bumps the host with the rest.
2. **4.2 — the table covers the light app.** Every write, owned write and task a light install can
   answer moves from `src-tauri`'s `NOT_YET` into `crates/grimoire-core/src/commands.rs`, with the
   parity fence's argument check; a sixth kind if the `State`-taking reads need it.
3. **4.3 — the host seams.** Android's back gesture as History navigation, the safe-area insets
   reaching the page, and files: a picked `content://` document read and a save written through
   the host, behind the `Core` seam that `phone/transfer/browserFiles.ts` stands in for.
4. **4.4 — the mobile-data prompt.** Any download over 5 MB shows its measured size first and, on
   a connection that reports itself metered, defaults to *Not now*.
5. **4.5 — the first run, measured.** On an emulator in CI if a phone is not to hand: install, cold
   start, the first corpus ingest, and the APK's size, each with the device named.

What only Markus can close stays open on the issue: his own toolchain (JDK 21, the SDK, the NDK),
a run on a real phone, and signing and distribution.
