/**
 * The version this build is, and the day it was released — told to the page at build time
 * (`vite.base.ts`'s `define`).
 *
 * **For a host that has no updater to ask.** The desktop reads its version from `update_status`,
 * which is the Rust binary's own `CARGO_PKG_VERSION`; neither light host has that command, and
 * neither needs one: what a light install runs is the page it was built with. release-please
 * bumps the root manifest that this is read from in the same commit as every host's, so on a
 * release tag the two agree.
 */
export const APP_VERSION: string = import.meta.env.VITE_APP_VERSION;

/** Every release's day as `YYYY-MM-DD`, by version — `releaseDates.ts`, over `CHANGELOG.md`. */
export const RELEASE_DATES: Readonly<Partial<Record<string, string>>> = JSON.parse(
  import.meta.env.VITE_RELEASE_DATES,
);

/** The day this build's version was released, or `null` before its release has been cut. */
export const APP_RELEASED: string | null = RELEASE_DATES[APP_VERSION] ?? null;
