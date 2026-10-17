/**
 * The one door every wrapper calls through, and the two helpers the domains share.
 *
 * Split out of `../ipc.ts` with the domains (issue #557) so that each domain file imports the
 * transport rather than reaching into a sibling for it. `invoke` and `asciiJson` are exported for
 * those files only: `../ipc.ts` re-exports `ipcError` and `Unlisten` and nothing else from here, so a
 * page still has no way to call a command by name around its typed wrapper.
 */
import { core } from "@/lib/core";
import type { CallArgs, CallOptions } from "@/lib/core";

/**
 * What a subscription hands back: call it to stop listening.
 *
 * This app's own type now, rather than the one Tauri exported. It is **synchronous** because
 * {@link Core} is — a React cleanup cannot await, and a component can unmount before the
 * transport has finished subscribing, so the handle has to be callable immediately and still
 * take effect later. `core/tauri.ts` is where that is arranged.
 */
export type Unlisten = () => void;

/**
 * The methods below are written as `invoke("name", { args })` and stay that way. (This read
 * "~136" long after it stopped being true; count them in the file rather than here.)
 * Only where the call goes has changed — {@link core} decides that.
 *
 * **Two parameters wider than that sentence since the scanner**, and both widenings serve the
 * one call that cannot be `{ args }`: a camera frame is bytes with no fields to name, so `args`
 * takes {@link CallArgs}' other arm, and whatever the bytes cannot say rides in
 * {@link CallOptions}' headers. Every other wrapper passes a record and no options, which is
 * what keeps `core.call`'s one- and two-argument forms — and the
 * `toHaveBeenCalledWith("sync_status")` assertions that depend on them — unchanged.
 *
 * **Every rejection leaves here as the backend's sentence, a plain string, whichever host
 * refused** (issue #557). The hosts disagreed: Tauri rejects with the `Err(String)` itself, the
 * web host's Worker and the Android table with a string too, but the fake core every test and
 * story runs on rejects with an `Error`, and a transport fault on any host can be an `Error`
 * or an object. A caller written against one shape was right on some hosts and wrong on the
 * rest — `DeckHistoryDialog` read `error instanceof Error && error.message`, which held in
 * every test and on no shipped desktop, where the real Rust message was always swapped for a
 * generic one. **A string rather than an `Error`** because the string is the contract the
 * crates already keep (`Result<_, String>`), the light app and the scanner compare rejections
 * to their sentence constants with `===`, and a string renders as a React child where an
 * `Error` throws. {@link ipcError} is what turned the other shapes into that string before, and
 * it is what does it here, so a caller that still wraps a rejection in it gets the same answer.
 */
export const invoke = <T>(command: string, args?: CallArgs, options?: CallOptions): Promise<T> =>
  // `Promise.resolve` around the call is for the suites, not for a host: every `Core` answers a
  // promise, but a test that stubs the transport with a bare `vi.fn()` answers `undefined`, and a
  // `.catch` straight on that would throw where the call used to go through. The command is
  // still sent synchronously, so a `toHaveBeenCalledWith` right after the call holds as before.
  Promise.resolve(core.call<T>(command, args, options)).catch((e: unknown) =>
    Promise.reject(ipcError(e)),
  );

/**
 * JSON with every non-ASCII character escaped, for the two scanner headers.
 *
 * **A header value is not a string, it is bytes, and three layers disagree about which bytes
 * are allowed.** `JSON.stringify` leaves non-ASCII characters as themselves; a browser sends
 * a header value's 0x80–0xFF as Latin-1 and throws a `TypeError` outright above that; and
 * Rust's `HeaderValue::to_str` refuses anything outside visible ASCII. So `Æther Vial` in a
 * `x-scanner-capture` either kills the call in the page or arrives as mojibake the far end
 * rejects — and a scanner refusing exactly the cards whose names are worth reading is the
 * failure this prevents. `\uXXXX` is the one spelling that survives all three hops, and it is
 * still the same JSON: `JSON.parse` on the far side yields the original character.
 *
 * Used for **both** headers, so the two are symmetric even though only one has ever carried a
 * card name.
 *
 * A surrogate pair escapes to its two code units, which is exactly what JSON asks for.
 */
export function asciiJson(value: unknown): string {
  return JSON.stringify(value).replace(
    /[\u0080-\uffff]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/**
 * The message out of a rejected `invoke`.
 *
 * All three commands return `Result<_, String>`, so the rejection value is that bare
 * string — not an `Error`. Rendering it with `String(e)` would be right for those and
 * `"[object Object]"` for anything the IPC layer itself throws, so both are handled.
 *
 * **A rejection out of an {@link ipc} wrapper is already a string** — `invoke` runs it through
 * here on the way out, so the first branch is the one it takes. The other two are for what did
 * not come through `invoke`: a direct `core.call`, a file read, a `fetch`, a thrown `Error`.
 */
export function ipcError(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return "Unexpected error: " + JSON.stringify(e);
}
