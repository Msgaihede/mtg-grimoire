/**
 * The day each release was cut, read out of `CHANGELOG.md`.
 *
 * Build-time code — `vite.base.ts` is its only caller, and hands the answer to the page as
 * `import.meta.env.VITE_RELEASE_DATES`. It lives under `packages/ui/` so the suite covers it,
 * `iconFont.ts`'s reason; nothing in the app imports it, so it is in no bundle.
 *
 * **Why the dates come from here and not from the notes the page draws.** A release's notes are
 * `changelog/<version>.md` — the release's GitHub body, word for word — and those files carry no
 * date. release-please's log does, on every heading it writes, and it is the one record of the
 * day that ships in the repository. Reading it at build time costs the bundle a few dozen short
 * strings rather than the 350 KB log.
 */

/** `## [0.44.0](https://…/compare/v0.43.0...v0.44.0) (2026-10-11)` — one release's heading. */
const HEADING = /^#{2,3} \[(\d+\.\d+\.\d+)\]\([^)]*\) \((\d{4}-\d{2}-\d{2})\)/gm;

/**
 * Every release the log names, by version, as `YYYY-MM-DD`.
 *
 * The hand-written `## Unreleased` block at the top has no version and is not a release, so the
 * pattern passes over it. A version the log names twice keeps its first, newest, heading.
 */
export function releaseDates(changelog: string): Record<string, string> {
  const dates: Record<string, string> = {};
  for (const [, version, date] of changelog.matchAll(HEADING)) {
    if (version !== undefined && date !== undefined) dates[version] ??= date;
  }
  return dates;
}
