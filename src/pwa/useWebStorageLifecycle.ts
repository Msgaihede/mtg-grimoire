import { useEffect } from "react";
import { corpusState, markCorpusBuilt, type CorpusState } from "@/pwa/corpusMark";
import { requestPersistenceOnce } from "@/pwa/persistence";
import { isWebTarget } from "@/pwa/target";

/**
 * The two things that happen the moment the corpus exists, and the one question asked about it
 * on every poll.
 *
 * Driven from `AppShell`, which already reads `sync_status` through `useSync`. A hook of its own
 * rather than a second `useSync()` — that hook runs its own chained poll, and two of them would
 * be two loops describing one database.
 *
 * Inert on desktop: `isWebTarget()` is a build-time constant, the effect returns immediately,
 * and `corpusState` answers `"present"` for every count that is not exactly `0`.
 */
export function useWebStorageLifecycle(cardCount: number | null): CorpusState {
  useEffect(() => {
    if (!isWebTarget() || cardCount === null || cardCount <= 0) return;
    markCorpusBuilt(cardCount, localStorage);
    // Requested here rather than at boot: 526 MB is what makes persistence worth asking for,
    // and there is nothing to keep until the ingest has finished — 10.4 s on a desktop, 36.5 s
    // on a phone. `requestPersistenceOnce` is idempotent, so a poll every 30 s costs one read.
    void requestPersistenceOnce(navigator.storage, localStorage, Date.now());
  }, [cardCount]);

  return isWebTarget() ? corpusState(cardCount, localStorage) : "present";
}
