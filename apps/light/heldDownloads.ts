import { createContext, useContext } from "react";

/**
 * **The way back to the mobile-data prompt** (issue #1155): whether the launch's downloads are
 * still held, and the press that asks the host again and opens the prompt.
 *
 * Provided by `DownloadsPrompt`, which `LightApp` mounts around both faces, and read by the places
 * an empty corpus shows — the phone's Search (`NoCards`) and Settings. A reader who said *Not now*
 * keeps an offer there for as long as the host holds; without it the only way back was a
 * relaunch, and Android resumes this process rather than launching it again.
 */
export interface HeldDownloads {
  /** The host said its launch is holding downloads, and has not said otherwise since. */
  held: boolean;
  /** Ask the host again and, if it still holds, open the prompt. */
  offer: () => void;
}

/** What a page reads with no prompt above it — a story, a test of one page, the desktop app. */
const NOTHING_HELD: HeldDownloads = { held: false, offer: () => {} };

export const HeldDownloadsContext = createContext<HeldDownloads>(NOTHING_HELD);

/** The launch's held downloads, as the prompt above this face last heard them. */
export function useHeldDownloads(): HeldDownloads {
  return useContext(HeldDownloadsContext);
}
