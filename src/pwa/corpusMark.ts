/** The one thing the shell remembers about the corpus: that there was one. */
export const CORPUS_KEY = "grimoire.corpus.built";

export type CorpusState = "present" | "never-built" | "evicted";

/**
 * Write down that this browser has had a corpus.
 *
 * **In `localStorage`, which is the shell's own storage, and that is what makes this work.**
 * Cache Storage, `localStorage` and OPFS are evicted independently; this mark lives with the
 * shell, so the case it detects — shell intact, corpus gone — is precisely the case where the
 * mark survives and the database does not. If the browser clears *everything*, the mark goes
 * too and the reader gets the first-run screen, which is then the truth.
 *
 * Idempotent, and a no-op for an empty count: a database with no cards is not a corpus, and
 * marking one would turn every genuine first run into a reported eviction.
 */
export function markCorpusBuilt(cardCount: number | null, store: Storage): void {
  if (cardCount === null || cardCount <= 0) return;
  try {
    store.setItem(CORPUS_KEY, JSON.stringify({ at: Date.now(), cards: cardCount }));
  } catch {
    // Storage disabled. The consequence is a reader who is one day told "first run" after an
    // eviction, which is the state this app shipped with before this file existed.
  }
}

/**
 * What an empty database means right now.
 *
 * `cardCount` is `sync_status`'s, with its own meanings kept exactly: `0` is a real empty
 * database, and `null` is a count that could not be read — which is the normal state *during*
 * every sync, and which `SyncProgress` has always refused to treat as empty.
 */
export function corpusState(cardCount: number | null, store: Storage): CorpusState {
  if (cardCount !== 0) return "present";
  return hasMark(store) ? "evicted" : "never-built";
}

/** Whether a readable mark is there. A record nobody can parse is treated as no record — the
 *  cost of guessing wrong here is telling a reader something untrue about their own history. */
function hasMark(store: Storage): boolean {
  try {
    const raw = store.getItem(CORPUS_KEY);
    return raw !== null && JSON.parse(raw) !== null;
  } catch {
    return false;
  }
}
