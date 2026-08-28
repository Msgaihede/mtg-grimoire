import { BackupPanel } from "@/features/settings/BackupPanel";
import { isAndroid } from "@/lib/platform";
import { CachePanel } from "@/features/settings/CachePanel";
import { CombosPanel } from "@/features/settings/CombosPanel";
import { DangerZonePanel } from "@/features/settings/DangerZonePanel";
import { ErrorLogPanel } from "@/features/settings/ErrorLogPanel";
import { HiddenTagsPanel } from "@/features/settings/HiddenTagsPanel";
import { MarketplacePanel } from "@/features/settings/MarketplacePanel";
import { SyncPanel } from "@/features/settings/SyncPanel";
import { UpdatePanel } from "@/features/settings/UpdatePanel";
import { WebStoragePanel, useWebStorage } from "@/features/settings/WebStoragePanel";
import { useDangerZone, useLocalCache } from "@/features/settings/useDataReset";
import { useHiddenTags } from "@/features/settings/useHiddenTags";
import type { Update } from "@/lib/useUpdate";
import { useErrorLog } from "@/lib/useErrorLog";
import { useMarketplace } from "@/lib/useMarketplace";
import { useReleaseHistory } from "@/lib/useReleaseHistory";
import { isWebTarget } from "@/pwa/target";

/**
 * Settings.
 *
 * The data folder and import/export are still a later plan's — the blurb near the foot stands in
 * for the part that is genuinely still missing, rather than hiding panels that exist.
 *
 * **Ordered by what a press costs**, which is the one rule about this page's shape: updates,
 * prices, combos and errors first, since none of them throws anything away; then the cache,
 * which throws away bytes the app fetches again; then the three clears that cannot be taken
 * back, alone at the bottom in their own region. See `DangerZonePanel` for why that distance is
 * load-bearing rather than tidy.
 *
 * `useLocalCache` and `useDangerZone` are hooked up here for the error log's reason — nothing
 * else in the window writes to those tables, so there is no second caller to race.
 *
 * `update` is passed in rather than hooked up here: `AppShell` already owns it for the
 * ribbon's button, and a second `useUpdate()` would be a second `update:progress` listener
 * racing to describe the same download. The error log is the opposite and is hooked up
 * *here*, because nothing else in the window reads it — it is not polled, it has no
 * listener, and there is no second surface for it to race.
 *
 * The version history is hooked up here for the error log's reason and one more of its own:
 * it reads a row the update check already wrote, so there is nothing in flight for a second
 * caller to race — and hooking it in `AppShell` beside `useUpdate` would fetch thirty release
 * bodies at launch for a panel most sessions never open. It takes `lastCheckAt` so that
 * pressing Check now moves its query key and refreshes the list.
 *
 * The marketplace is hooked up here for the same reason arrived at from the other side. Half
 * the window reads it — every price surface asks `useMarketplace()` for its currency — and
 * that is precisely why a second call here is free: it is one TanStack Query entry with
 * `staleTime: Infinity`, so every caller is reading the same cached answer rather than opening
 * a second channel to the backend. There is nothing to race, and threading it down from
 * `App.tsx` would buy nothing but a prop.
 *
 * `BackupPanel` and `CombosPanel` take no props at all and reach the backend themselves, which
 * is the same argument from one step further along: the mirror has no second reader in the
 * window, and the combo status has one — the deck editor's bracket advisory — that is reading
 * the very same cache entry. Either way `SettingsPage` would be holding a hook only to hand its
 * answer straight back down.
 */
export function SettingsPage({ update }: { update: Update }) {
  const log = useErrorLog();
  const marketplace = useMarketplace();
  const history = useReleaseHistory(update.status?.lastCheckAt ?? null);
  const cache = useLocalCache();
  const danger = useDangerZone();
  const hidden = useHiddenTags();
  // Called unconditionally, `useLocalCache`'s shape, and inert on desktop: every read inside
  // it is behind `isWebTarget()`, which is a build-time constant.
  const webStorage = useWebStorage();

  return (
    <div className="mx-auto max-w-2xl space-y-8 py-2">
      <UpdatePanel update={update} history={history} />

      <MarketplacePanel marketplace={marketplace} />

      {/* **Directly under Prices, because it is the same kind of thing.** Both are optional bulk
          feeds from a third party that the app works entirely without: a marketplace with no
          feed quotes em dashes, and a database with no combos estimates a bracket from three
          signals instead of four. Nothing here throws anything away either, so it stays in the
          page's first group. It reaches the backend itself — see `CombosPanel`, and
          `BackupPanel` for the rule it follows. */}
      <CombosPanel />

      {/* Above the error log rather than below it, because this is the page's only *undo*: the
          rail tells a reader who has just hidden a tag that Settings is where it comes back, and
          the shorter the scroll from the top of the page to that list, the fewer of them give up
          on the way. Everything below is either a report or a deletion. */}
      <HiddenTagsPanel hidden={hidden} />

      {/* **Still in the group that throws nothing away**, which is the page's one ordering rule,
          and below the undo above it because that one is what a reader arrives here looking for.
          Removing a device is the sharpest press on this panel and it is not a clear: the copies,
          the decks and the wishlist are untouched, and what changes is which other machine can
          read what comes next. It reaches the backend itself — `BackupPanel`'s rule, and its
          reason exactly: nothing else in the window reads `sync_pairing_status`. */}
      <SyncPanel />

      <ErrorLogPanel log={log} />

      {/* Still in the group that throws nothing away, and beside the cache because the two are
          this page's only panels about the folder on disk — one says what is kept there and the
          other what can be swept out of it. Above it rather than below for the ordering rule:
          the mirror deletes nothing a reader owns, and Clear cache does.

          **Desktop only, and the decision is the mirror's purpose rather than a limitation.**
          The mirror's whole point is a folder a reader opens in a text editor, syncs with
          Dropbox or greps; on Android that directory is reachable mainly through a file-manager
          app and often not by other apps at all, so the feature would exist without delivering
          what it is for. The picker it needs is not there either — `tauri-plugin-dialog`'s own
          manifest records Android support as "partial — Does not support folder picker", so a
          reader could not choose the root.

          Rust agrees from the other side: `lib.rs` installs neither the mirror's update hook nor
          its thread on mobile, so `mirror_status` would answer about a mirror that cannot
          run. */}
      {!isAndroid() && <BackupPanel />}

      <CachePanel cache={cache} />

      {/* Web only: none of these rows means anything in a window that owns its own disk.
          `isWebTarget()` is a build-time constant, so on desktop this subtree is not merely
          hidden - nothing under it is ever constructed.

          Beside the cache because these are the page's two panels about where the bytes
          live, and this one throws nothing away either. */}
      {isWebTarget() && <WebStoragePanel storage={webStorage} />}

      <section aria-labelledby="later-heading" className="space-y-2">
        <h2 id="later-heading" className="font-heading text-lg leading-none text-dim">
          Not here yet
        </h2>
        {/* Export left this list when the mirror landed — the panel above writes every deck,
            the collection and the wishlist in all seven formats, continuously, which is more
            than this line ever promised. Import is still the dialog's alone. */}
        <p className="text-sm text-dim">
          Data folder, sync behaviour and import. Coming in a later plan.
        </p>
      </section>

      {/* **Last on the page, under the blurb about what is still missing, and deliberately so.**
          Everything above is a setting; these three empty the app for good. Distance is the only
          thing standing between a reader scrolling for the error log and the button that deletes
          their collection — the typed word inside the dialog is the second fence, not the
          first. */}
      <DangerZonePanel danger={danger} />
    </div>
  );
}
