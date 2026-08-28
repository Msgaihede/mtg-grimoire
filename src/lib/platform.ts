/**
 * Which platform this page is running on, for the two places the answer changes what is drawn.
 *
 * **A user-agent test rather than a Tauri call, and `src/lib/images.ts` is the precedent.**
 * `imageOrigin()` there already decides the custom-protocol origin from
 * `userAgent.includes("Android")` and has shipped. Asking `@tauri-apps/plugin-os` would be a
 * dependency, a capability entry and an async answer; asking Rust would be another command.
 * Both readers need this during their first render, synchronously, and the string is already
 * in the document.
 *
 * **It answers `false` for anything it does not recognise**, which is what keeps jsdom and
 * Storybook on the desktop shape without either of them having to say so. The suite would
 * otherwise change what it tests the day this function got looser.
 *
 * The token is `Android` and not `Linux` or `Mobile`: an Android user agent is a Linux one with
 * one extra word, and a desktop Linux build of this app draws the same caption Windows does.
 *
 * This is *not* a general platform detector and should not grow into one. The web target runs
 * in a browser on all of these operating systems, so "is this Android" and "is this the Android
 * app" become different questions the moment a PWA ships — at which point the answer moves
 * behind the core boundary, where `ipc.ts` already knows which core it is talking to.
 */
export function isAndroid(userAgent: string = navigator.userAgent): boolean {
  return userAgent.includes("Android");
}
