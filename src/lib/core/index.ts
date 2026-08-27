import { tauriCore } from "./tauri";
import type { Core } from "./types";

export type { Core };

/**
 * The implementation this build talks to.
 *
 * One `const` today because there is one implementation. When the web target lands this
 * becomes the selection point — and it stays a module-level constant rather than a hook or
 * a context, because which core is answering is a fact about the *build*, not about a
 * component tree, and nothing should be able to re-render its way into a different one.
 */
export const core: Core = tauriCore;
