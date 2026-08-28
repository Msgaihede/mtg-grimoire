/**
 * What a browser will say about the link, which is never the thing we actually want to know.
 *
 * **No browser exposes a "metered" bit**, and this file must not pretend otherwise. Three
 * signals stand in for it, in descending order of how much they are worth:
 *
 * 1. **`saveData`** — the reader asked their browser for less data. The strongest of the three,
 *    because it is a *choice* rather than an inference, and it is the one whose sentence names
 *    something the reader recognises.
 * 2. **`type === "cellular"`** — Chrome on Android. Absent on desktop, and absent in every
 *    browser that ships `effectiveType` without `type`.
 * 3. **`effectiveType` of `2g`/`slow-2g`** — a guess about *speed*, not about cost, and here
 *    because a 78 MB download on a 2G link is a bad idea whoever is paying for it.
 *
 * **Firefox and Safari expose none of it, and absent is not metered.** Guessing "yes" would
 * default every download on two whole browsers to *Not now*, which is worse than not asking.
 */
export interface NetworkInformation {
  /** The reader turned Data Saver on. */
  saveData?: boolean;
  /** `"cellular"`, `"wifi"`, `"ethernet"`, … Chrome on Android only. */
  type?: string;
  /** `"slow-2g"` | `"2g"` | `"3g"` | `"4g"` — a speed class, not a cost class. */
  effectiveType?: string;
}

export interface LinkReading {
  metered: boolean;
  /** A sentence for the dialog, or `null` when there is nothing to say. */
  why: string | null;
}

const NOT_METERED: LinkReading = { metered: false, why: null };

/**
 * `navigator.connection`, which is in **no TypeScript lib** — checked in typescript 6.0.3:
 * `lib.dom.d.ts` declares no `NetworkInformation` and puts no `connection` on `Navigator`. One
 * cast, here, so no call site has to write its own.
 */
export function navigatorConnection(): NetworkInformation | undefined {
  return (navigator as Navigator & { connection?: NetworkInformation }).connection;
}

/** What, if anything, this link says about the cost of a download. */
export function meteredLink(connection: NetworkInformation | undefined): LinkReading {
  if (!connection) return NOT_METERED;
  if (connection.saveData) return { metered: true, why: "Data Saver is on." };
  if (connection.type === "cellular") return { metered: true, why: "You appear to be on mobile data." };
  if (connection.effectiveType === "2g" || connection.effectiveType === "slow-2g") {
    return { metered: true, why: "This connection is slow." };
  }
  return NOT_METERED;
}
