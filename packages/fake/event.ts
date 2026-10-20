/**
 * The fake `listen`, aliased over `@tauri-apps/api/event`.
 *
 * Eleven events reach the frontend, and they are all of `app.emit` in `apps/desktop/src-tauri/src` —
 * `grep -n 'app\.emit(' -r apps/desktop/src-tauri/src` is what answers that count, not this list, because it
 * has already drifted twice (this read "five" while `combos:progress` and `art-tags:progress`
 * were already live, and live sync then added two more without anybody re-counting; then it read
 * "nine" while `startup:changed` was already live, which the grep found on 2026-09-19 when
 * `db:changed` was added):
 * `sync:progress` (`SyncProgressEvent`, subscribed once by `useSyncProgress`),
 * `collection:reconciled` (`ReconciledEvent`, subscribed by `useSyncInvalidation`),
 * `update:progress` (`UpdateProgressEvent`, subscribed by `useUpdate`),
 * `marketplace:progress` (`FeedProgressEvent`, subscribed once by `useMarketplaceProgress`),
 * `oracle-tags:progress` (`OracleTagProgressEvent`, subscribed once by `useOracleTagProgress`),
 * `art-tags:progress` (`ArtTagProgressEvent`, subscribed by `TagPicker`),
 * `combos:progress` (`ComboProgress`, reached through `ipc.onCombosProgress` — the one entry
 * here that names its wrapper instead of a component, because the combo feed downloads at
 * launch since 2026-09-08 and the Settings panel this line used to name is gone with the press
 * that started it),
 * `sync:applied` (`RelayOutcome`, subscribed by `useDeviceSyncInvalidation`),
 * `sync:live` (`SyncLiveEvent`, subscribed by `useDeviceSyncLive`),
 * `scanner:assets` (`ScannerAssetsProgress`, subscribed by `useScannerAssets` while the scanner's
 * files are owed or on their way — **a twelfth, and one that grep cannot count**: the core emits
 * it through the state's event sink, `scanner_assets::PROGRESS_EVENT`, and no `app.emit` names
 * it; here `scannerAssetHandlers`' fetch is what says it, through {@link worldEmitter}),
 * `startup:changed` (`StartupStatus`, reached through `ipc.onStartupChanged` by `DesktopBoot`,
 * which gates the whole app on it) and
 * `db:changed` (`DbChanged`, subscribed once by `useCrossWindowRefresh`). **That last one is
 * emitted only while two or more windows are open**, so a single-window session never sees it —
 * and a story is one window (`window_count` answers one here), so it never hears it either unless
 * it calls `emitFake` itself. **And driving that one reaches the listener without changing
 * anything a story can see**: `useCrossWindowRefresh` invalidates the module-level `queryClient`
 * from `@/lib/query`, never the client the story's own `QueryClientProvider` holds — so the
 * subscription is what an `emitFake` here proves, and the refresh is `useCrossWindowRefresh`'s
 * own suite's. A story drives any of them with `emitFake`.
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
import { activeScope, listeningScopes, standing } from "./scope";
import type { FakeListener, FakeScope } from "./scope";

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
 *
 * **This is the `play` function's emit, not a handler's.** A command handler does hold a world —
 * the one its call is answering as — and says its events through {@link worldEmitter}.
 */
export function emitFake<T>(event: string, payload: T): void {
  for (const scope of listeningScopes()) deliver(scope, event, payload);
}

/**
 * The emit of the world this call is answering as, **read now and kept** — what a command
 * handler in `db.ts` says its events with, where a `play` uses {@link emitFake}.
 *
 * A handler is the one emitter that knows its world: `core.ts`' `invoke` points the fake at the
 * caller's world before it calls one, so the active scope at the top of a handler *is* that
 * world. Read later it is not — `scanner_assets_fetch` awaits between its stretches, and by the
 * time it says `done` the pointer may name another story on the page, or the next test's. So the
 * scope is captured once, before the first `await`, as `invoke` captures its own, and its events
 * go to that world's listeners and no other's: a press on one story of a docs page is not a bar
 * moving on its neighbours, and a fetch a finished test left running is not heard by the next
 * test's `useScannerAssets` (issue #1191).
 *
 * **And to nobody once that world has gone with another standing** — `scope.ts`' `standing`,
 * the same rule `invoke` re-points by. A world's subscribers leave with its components as a
 * rule, but a test that subscribed by hand and never unsubscribed would otherwise go on hearing
 * a world that is over.
 *
 * A synchronous handler would emit to the right world either way; it takes its emitter the same
 * way so that one rule covers every handler, and a handler that grows an `await` cannot regress.
 */
export function worldEmitter(): <T>(event: string, payload: T) => void {
  const scope = activeScope();
  return (event, payload) => {
    if (standing(scope)) deliver(scope, event, payload);
  };
}

function deliver<T>(scope: FakeScope, event: string, payload: T): void {
  for (const cb of scope.listeners.get(event) ?? []) cb({ payload });
}

/** Drop the active world's subscribers. Nothing in the decorator calls it — a world's map
 *  leaves with its world — but a test that subscribed by hand can clean up with it. */
export function resetListeners(): void {
  activeScope().listeners.clear();
}
