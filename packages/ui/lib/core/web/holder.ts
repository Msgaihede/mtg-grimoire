/**
 * **Which document holds the database, and what to do when the pool says it is taken** — the
 * page's half of the one-tab rule (the light-app spec §6: "A second document opening the same
 * database fails hard. The second tab detects it at start and says so").
 *
 * The engine's answer alone cannot tell two things apart. The OPFS pool holds exclusive access
 * handles, so an open refused with `already-open` means *some Worker of this origin holds them* —
 * and that Worker may belong to a second tab, or to **a document that is already gone**.
 *
 * **Measured, Chrome 154, 2026-10-04**, by reloading a page and asking from the new document —
 * in a Worker that did nothing else — when every file of the pool could be opened again:
 *
 * | The old document's Worker was | All 64 files free, after the reload was asked |
 * | --- | --- |
 * | idle, or awaiting a `fetch` | by the first look, 35–42 ms |
 * | inside the engine — an ingest's synchronous finish | 984 ms, 2 897 ms |
 * | the same, with `worker.terminate()` on `pagehide` | 1 589 ms, 1 045 ms |
 *
 * (The probe's resolution is about 100 ms — one pass over the 64 files. With the fix in, the
 * same reload opened on its fifth ask, 3.0–3.3 s after the first, six runs in six.)
 *
 * A dedicated Worker is ended with its document, but one that is inside a long synchronous call
 * does not end at once, and its access handles are its until it has. The new document's engine is
 * up and asking within ~150 ms, so it met a pool still held and — the engine's answer being all
 * the page had — told the reader the app was open in another tab, with none open, for as long as
 * the page stood. `terminate()` on the way out buys nothing: it asks for the same ending the
 * browser was already giving, and the two columns above do not differ by more than their spread.
 *
 * **So the page holds a Web Lock for as long as its document lives**, which a dying Worker
 * cannot: the browser lets a document's locks go with the document. A new document that finds
 * the lock **held** has a living neighbour — a second tab — and is told so at once, without
 * starting an engine. One that finds it **free** is the only document there is, so an
 * `already-open` it then meets is a pool still being let go: it asks again, a fresh Worker each
 * time, until the pool is free or {@link RETRY_BOUND_MS} is spent.
 */

/** The lock's name. One per origin, as the database is. */
export const DATABASE_LOCK = "mtg-grimoire:database";

/** As much of `navigator.locks` as is used. The real one is assignable. */
export interface LockManagerLike {
  request(
    name: string,
    options: { ifAvailable: true },
    callback: (lock: object | null) => Promise<void> | void,
  ): Promise<unknown>;
}

/**
 * What asking for the lock found: it is this document's now; another living document has it; or
 * there was nobody to ask — a browser with no Web Locks, or one that refused the ask.
 */
export type Claim = "ours" | "elsewhere" | "unknown";

export interface Claimed {
  /** Never rejects. */
  claim: Promise<Claim>;
  /**
   * Let the lock go while the document lives — for a document whose database did not open, so
   * that it does not stand between another tab and a database it is not holding.
   */
  release(): void;
}

/**
 * Ask for the lock, without waiting for it: `ifAvailable` answers at once either way.
 *
 * **Held by a promise that only {@link Claimed.release} settles**, so for a document that opened
 * its database it is held until the document is gone — a reload, a closed tab, a crash of the
 * whole page — and released by the browser, not by anything here that would have to run on the
 * way out. (Driven in Chrome 154: a navigation to another of the app's pages and a Back each
 * made a new document that opened the database — the page was not kept in the back/forward
 * cache, where it would have kept its Worker frozen and the Worker its handles. Whether the
 * lock or the Worker is what keeps it out was not separated.)
 */
export function claimDatabase(locks: LockManagerLike | undefined): Claimed {
  let release: () => void = () => undefined;
  if (locks === undefined) return { claim: Promise.resolve("unknown"), release };
  const claim = new Promise<Claim>((answer) => {
    try {
      locks
        .request(DATABASE_LOCK, { ifAvailable: true }, (lock) => {
          if (lock === null) return answer("elsewhere");
          answer("ours");
          return new Promise<void>((done) => (release = done));
        })
        // A browser that has the API and will not grant it here: a context with no storage.
        .catch(() => answer("unknown"));
    } catch {
      answer("unknown");
    }
  });
  return { claim, release: () => release() };
}

/**
 * How long to wait before each new attempt at a pool that answered `already-open`: short at
 * first — an idle Worker's handles are free within tens of milliseconds — and no longer than
 * the last of these after that.
 */
export const RETRY_DELAYS_MS: readonly number[] = [200, 400, 800];

/**
 * How long the page goes on asking before it says the database could not be opened: **10 s**
 * from the first refusal. The longest hold seen was a little over 3 s, so this is three times
 * it, and the gate reads *Opening your collection…* throughout. Not a measured ceiling: every
 * figure is one machine's, with a 120 000-card ingest as the long call.
 */
export const RETRY_BOUND_MS = 10_000;

/**
 * The wait before attempt number `attempt` (the first retry is 1), given that `waited`
 * milliseconds have passed since the first refusal — or `null` when the bound is spent.
 */
export function retryDelay(attempt: number, waited: number): number | null {
  if (waited >= RETRY_BOUND_MS) return null;
  const delay = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length) - 1];
  return Math.min(delay, RETRY_BOUND_MS - waited);
}
