/**
 * **What a host says when it has no card scanner to offer at all** — the sentences, and nothing
 * else. Plain strings with no host in them, read by the page and by the web host alike, which
 * is `hostStorage.ts`'s arrangement and for its reason: a page never asks where it runs.
 *
 * A host with a scanner answers the session's commands. A host that cannot run one **refuses
 * them in one of these sentences**, every time, and the page reads that as "there is no session
 * here" rather than as an answer about a frame or a filter (`verdictText.ts`'s
 * `scannerUnavailable`): no camera is asked for, no frame is sent, and the sentence is drawn
 * where the picture would be. The words are the host's; the page only knows the list.
 *
 * The engine's own refusal — `scanner::NOT_IN_A_BROWSER_YET`, what its table says if a session
 * command reaches it on a page — is read the same way and lives in `verdictText.ts`, pinned to
 * the Rust text by `ipc.test.ts`. The two here are the web host's (`./web/scanner.ts`), which
 * imports them from this file: one source, so there is nothing to drift.
 */

/**
 * The scanner's module is built with WebAssembly SIMD (`simd128`) and a browser without it
 * will not compile the bytes. Known before anything is fetched — the web host probes with
 * thirty-one bytes — so a reader is never offered an eighteen-megabyte download for a scanner
 * that cannot start.
 */
export const SCANNER_NEEDS_SIMD =
  "The card scanner cannot run in this browser: it needs WebAssembly SIMD, which this browser does not have.";

/**
 * The origin serves no scanner files, and this browser holds none: a build made without them
 * (`npm run scanner:assets -- --web` was not run before `npm run web:build`). A release never
 * is; a developer's build may be.
 */
export const SCANNER_NOT_SHIPPED =
  "This build of MTG Grimoire was made without the card scanner's files.";

/** Every sentence a host refuses the scanner's session with when it has none to offer. */
export const HOST_SCANNER_UNAVAILABLE: readonly string[] = [SCANNER_NEEDS_SIMD, SCANNER_NOT_SHIPPED];
