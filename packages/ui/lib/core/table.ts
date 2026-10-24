import { toBase64 } from "@/lib/base64";
import { tauriCore } from "./tauri";
import type { CallArgs, CallOptions, Core } from "./types";

/**
 * The light host's implementation: **every command through one Tauri command, `core_call`**,
 * which forwards it to the engine's command table (`grimoire_core::dispatch`) by name. The
 * Android host registers nothing else (`apps/light/src-tauri/src/lib.rs`, the light-app spec §2.4), so
 * a call here is the desktop's call with its name moved into the arguments — and a command the
 * table does not have yet is refused by the table, in words.
 *
 * - **The arguments are forwarded untouched**, camelCase as `ipc.ts` spells them: the table's
 *   argument structs read the same keys a desktop wrapper does.
 * - **A byte payload crosses as base64** in `body`, because Tauri accepts no raw body on Android;
 *   **its headers ride as the call's `args`**, an object of strings under the desktop's own
 *   header names. That is the shape the table takes — settled in phase 7's step 7.3, when the
 *   scanner's frame and capture joined it as its two `bytes` entries: `scanner_frame` is
 *   `{ name, args: {}, body }` — a frame is its JPEG and nothing beside it — and `scanner_capture`
 *   `{ name, args: { "x-scanner-capture": "<json>" }, body }`, whose key the engine reads with the
 *   reader the desktop hands its request headers to (`grimoire_core::scanner::capture_from`). The
 *   web host's `protocol.ts` sends the same `args` beside a transferred buffer.
 * - **Events are Tauri's own**: the host forwards every engine event with `app.emit`, so
 *   subscribing is the desktop's `listen` exactly.
 * - **It is a call through `tauriCore`, never an import of Tauri's API**: `tauri.ts` stays the one
 *   door to `@tauri-apps/*` that `apps/light/phone/fence.test.ts` lets the phone face through.
 */
export const tableCore: Core = {
  call: <T>(command: string, args?: CallArgs, options?: CallOptions) => {
    if (args instanceof Uint8Array) {
      return tauriCore.call<T>("core_call", {
        name: command,
        args: options?.headers ?? {},
        body: toBase64(args),
      });
    }
    return tauriCore.call<T>(
      "core_call",
      args === undefined ? { name: command } : { name: command, args },
    );
  },
  listen: tauriCore.listen,
};
