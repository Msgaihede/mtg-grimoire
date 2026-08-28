/** Where the answer is written down. `localStorage`, deliberately — see below. */
export const PERSIST_KEY = "grimoire.storage.persist";

export interface PersistenceRecord {
  /** Unix millis of the one time this was asked. */
  askedAt: number;
  /** What the browser said. **A record, not a guarantee.** */
  granted: boolean;
}

/**
 * Ask the browser to keep this origin's storage, once, and write down the answer.
 *
 * **Once, because the answer does not change for the asking.** Chrome decides from
 * installation and engagement, not from repetition, and a request in a loop is a request that
 * will be answered `false` forever at some cost.
 *
 * **Called when the corpus exists, not at boot.** 526 MB is what makes persistence worth having
 * and there is nothing to keep before the first sync finishes — 10.4 s on a desktop, 36.5 s on a
 * OnePlus 12.
 *
 * **`localStorage` and not `app_meta`.** This is a fact about *this browser profile's* storage
 * grant, not about the reader's data: it must not sync to a phone, and it should disappear
 * exactly when the origin's storage does, which is what a wipe of site data already gives.
 *
 * ⚠️ **The answer is recorded and not trusted.** The spike got `false` throughout (expected: no
 * install, no gesture, headless), and a `true` would not have meant the corpus was safe either —
 * Cache Storage and OPFS are evicted independently, and "shell loaded, corpus gone" is a state
 * this app has to handle whatever this returns. That handling is `corpusMark`'s and it comes
 * from opening the database.
 */
export async function requestPersistenceOnce(
  storage: StorageManager | undefined,
  store: Storage,
  now: number,
): Promise<PersistenceRecord | null> {
  if (!storage?.persist) return null;
  const already = readPersistence(store);
  if (already) return already;
  const granted = await storage.persist().catch(() => false);
  const record: PersistenceRecord = { askedAt: now, granted };
  try {
    store.setItem(PERSIST_KEY, JSON.stringify(record));
  } catch {
    // A private window with storage disabled. The request still happened; nothing else here
    // depends on it having been written down.
  }
  return record;
}

/** What was written down, or `null` — including for a record that cannot be read. */
export function readPersistence(store: Storage): PersistenceRecord | null {
  const raw = store.getItem(PERSIST_KEY);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const { askedAt, granted } = parsed as Partial<PersistenceRecord>;
    if (typeof askedAt !== "number" || typeof granted !== "boolean") return null;
    return { askedAt, granted };
  } catch {
    return null;
  }
}
