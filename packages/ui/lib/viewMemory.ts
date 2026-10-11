/**
 * What a view was showing when the reader left it, kept for when they come back (issue #908).
 *
 * The Search and Tags pages hold their filters in component state, and switching views unmounts
 * the page — so a trip to a deck and back used to open a fresh query, and the reader typed their
 * filters in again. This is where those pages leave their filters on the way out and read them
 * back on the way in.
 *
 * **Module memory, not storage, and that is the scope the issue asked for.** It lives exactly as
 * long as the window: returning to a page finds it as it was left, and a restart opens every page
 * fresh. Persisting across restarts would make a stale narrowing the first thing a launch shows,
 * with nothing on screen to say why the wall is short.
 *
 * **Keyed by a string the caller names, holding a value this module never reads.** The shapes
 * belong to the features that remember them (`useCardSearch`'s filters, the Tags page's chips),
 * and `lib/` importing `features/` would invert the app's one layering rule — so this is only the
 * shelf, and each feature brings its own type.
 *
 * Tests and stories start from an empty shelf: `test-setup.ts` and the fake's `installWorld`
 * both call {@link resetViewMemory}, `resetBulkUndo`'s two callers for its reason.
 */
const shelf = new Map<string, unknown>();

/** One remembered view — the slot a page reads once as it mounts and writes as it changes. */
export interface ViewMemory<T> {
  /** What the view held when it was last left, or `undefined` if it has not been opened yet. */
  recall(): T | undefined;
  /** Keep this as what the view holds now. */
  keep(value: T): void;
}

/**
 * The slot named `key`. Cheap and stateless — two calls with one key are the same slot — so a
 * caller may build it during render or hold it at module scope, whichever reads better.
 */
export function viewMemory<T>(key: string): ViewMemory<T> {
  return {
    recall: () => shelf.get(key) as T | undefined,
    keep: (value) => {
      shelf.set(key, value);
    },
  };
}

/** Forget every view — a fresh window's state. For tests and stories. */
export function resetViewMemory(): void {
  shelf.clear();
}
