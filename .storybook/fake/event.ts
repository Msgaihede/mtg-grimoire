/**
 * The fake `listen`, aliased over `@tauri-apps/api/event`.
 *
 * Exactly two events reach the frontend, and they are all of `app.emit` in `src-tauri/src`:
 * `sync:progress` (`SyncProgressEvent`, subscribed once by `useSyncProgress`) and
 * `collection:reconciled` (`ReconciledEvent`, subscribed by `useSyncInvalidation`). A story
 * drives either with `emitFake`.
 *
 * `UnlistenFn` is not re-exported and does not need to be: `ipc.ts` imports it as
 * `type UnlistenFn`, which the transform erases, so the alias never has to answer for it at
 * runtime — and `tsc` resolves the real package, because the alias lives in Vite's config
 * and not in any `tsconfig`.
 */
type Listener = (event: { payload: unknown }) => void;

const listeners = new Map<string, Set<Listener>>();

export async function listen<T>(
  event: string,
  cb: (e: { payload: T }) => void,
): Promise<() => void> {
  const set = listeners.get(event) ?? new Set<Listener>();
  listeners.set(event, set);
  set.add(cb as Listener);
  return () => set.delete(cb as Listener);
}

/**
 * Emit to whoever is listening. Nothing queues, which matches the real thing: `ipc.ts`
 * records that events emitted before the webview registered its listener are dropped by
 * Tauri, so a story that emits before its component has mounted must see nothing here too.
 */
export function emitFake<T>(event: string, payload: T): void {
  for (const cb of listeners.get(event) ?? []) cb({ payload });
}

export function resetListeners(): void {
  listeners.clear();
}
