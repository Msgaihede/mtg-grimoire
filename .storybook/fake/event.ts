/**
 * The fake `listen`, aliased over `@tauri-apps/api/event`.
 *
 * Eleven events reach the frontend, and they are all of `app.emit` in `src-tauri/src` —
 * `grep -n 'app\.emit(' -r src-tauri/src` is what answers that count, not this list, because it
 * has already drifted twice (this read "five" while `combos:progress` and `art-tags:progress`
 * were already live, and live sync then added two more without anybody re-counting; then it read
 * "nine" while `startup:changed` was already live, which the grep found on 2026-09-19 when
 * `db:changed` was added):
 * `sync:progress` (`SyncProgressEvent`, subscribed once by `useSyncProgress`),
 * `collection:reconciled` (`ReconciledEvent`, subscribed by `useSyncInvalidation`),
 * `update:progress` (`UpdateProgressEvent`, subscribed by `useUpdate`),
 * `marketplace:progress` (`FeedProgressEvent`, subscribed once by `useMarketplaceProgress`),
 * `oracle-tags:progress` (`OracleTagProgressEvent`, subscribed once by `useOracleTagProgress`),
 * `art-tags:progress` (`ArtTagProgressEvent`, subscribed by `TagsPage`),
 * `combos:progress` (`ComboProgress`, reached through `ipc.onCombosProgress` — the one entry
 * here that names its wrapper instead of a component, because the combo feed downloads at
 * launch since 2026-09-08 and the Settings panel this line used to name is gone with the press
 * that started it),
 * `sync:applied` (`RelayOutcome`, subscribed by `useDeviceSyncInvalidation`),
 * `sync:live` (`SyncLiveEvent`, subscribed by `useDeviceSyncLive`),
 * `startup:changed` (`StartupStatus`, reached through `ipc.onStartupChanged` by `DesktopBoot`,
 * which gates the whole app on it) and
 * `db:changed` (`DbChanged`, subscribed once by `useCrossWindowRefresh`). **That last one is
 * emitted only while two or more windows are open**, so a single-window session never sees it —
 * and a story is one window (`window_count` answers one here), so it never hears it either unless
 * it calls `emitFake` itself. A story drives any of them with `emitFake`.
 *
 * `UnlistenFn` is not re-exported and does not need to be: `ipc.ts` imports it as
 * `type UnlistenFn`, which the transform erases, so the alias never has to answer for it at
 * runtime — and `tsc` resolves the real package, because the alias lives in Vite's config
 * and not in any `tsconfig`.
 *
 * **A subscriber belongs to the story that made it.** The map used to be this module's, and
 * `installWorld` cleared it — which on a docs page is one story tearing down the next
 * story's subscriptions. Each world owns a map now (`scope.ts`), `listen` registers into
 * whichever world is being mounted, and the map goes when that story unmounts, so nothing
 * has to be swept.
 */
import { activeScope, listeningScopes } from "./scope";
import type { FakeListener } from "./scope";

export async function listen<T>(
  event: string,
  cb: (e: { payload: T }) => void,
): Promise<() => void> {
  const { listeners } = activeScope();
  const set = listeners.get(event) ?? new Set<FakeListener>();
  listeners.set(event, set);
  set.add(cb as FakeListener);
  return () => set.delete(cb as FakeListener);
}

/**
 * Emit to whoever is listening. Nothing queues, which matches the real thing: `ipc.ts`
 * records that events emitted before the webview registered its listener are dropped by
 * Tauri, so a story that emits before its component has mounted must see nothing here too.
 *
 * **To every mounted story, not to one.** An emit is an act on "the backend" and a `play`
 * holds no handle on a world, so there is nothing to choose between the stories on a docs
 * page with. On the canvas — and under `stories.test.tsx`, which mounts one story per `it` —
 * exactly one world is ever mounted, so this is one story's event either way. A docs page
 * does not run `play` functions unless `parameters.docs.story.autoplay` says to, which
 * nothing here does.
 */
export function emitFake<T>(event: string, payload: T): void {
  for (const scope of listeningScopes()) {
    for (const cb of scope.listeners.get(event) ?? []) cb({ payload });
  }
}

/** Drop the active world's subscribers. Nothing in the decorator calls it — a world's map
 *  leaves with its world — but a test that subscribed by hand can clean up with it. */
export function resetListeners(): void {
  activeScope().listeners.clear();
}
