import { tauriCore } from "./tauri";
import type { CallArgs, CallOptions, Core } from "./types";

export type { CallArgs, CallOptions, Core };

/** The implementation every command goes through: Tauri's own IPC. */
export const core: Core = tauriCore;
