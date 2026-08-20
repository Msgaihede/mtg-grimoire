import { CachePanel } from "@/features/settings/CachePanel";
import { DangerZonePanel } from "@/features/settings/DangerZonePanel";
import { ErrorLogPanel } from "@/features/settings/ErrorLogPanel";
import { HiddenTagsPanel } from "@/features/settings/HiddenTagsPanel";
import { MarketplacePanel } from "@/features/settings/MarketplacePanel";
import { UpdatePanel } from "@/features/settings/UpdatePanel";
import { useDangerZone, useLocalCache } from "@/features/settings/useDataReset";
import { useHiddenTags } from "@/features/settings/useHiddenTags";
import type { Update } from "@/lib/useUpdate";
import { useErrorLog } from "@/lib/useErrorLog";
import { useMarketplace } from "@/lib/useMarketplace";
import { useReleaseHistory } from "@/lib/useReleaseHistory";

/**
 * Settings.
 *
 * The data folder and import/export are still a later plan's — the blurb near the foot stands in
 * for the part that is genuinely still missing, rather than hiding panels that exist.
 *
 * **Ordered by what a press costs**, which is the one rule about this page's shape: updates,
 * prices and errors first; then the cache, which throws away bytes the app fetches again; then
 * the three clears that cannot be taken back, alone at the bottom in their own region. See
 * `DangerZonePanel` for why that distance is load-bearing rather than tidy.
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
 */
export function SettingsPage({ update }: { update: Update }) {
  const log = useErrorLog();
  const marketplace = useMarketplace();
  const history = useReleaseHistory(update.status?.lastCheckAt ?? null);
  const cache = useLocalCache();
  const danger = useDangerZone();
  const hidden = useHiddenTags();

  return (
    <div className="mx-auto max-w-2xl space-y-8 py-2">
      <UpdatePanel update={update} history={history} />

      <MarketplacePanel marketplace={marketplace} />

      {/* Above the error log rather than below it, because this is the page's only *undo*: the
          rail tells a reader who has just hidden a tag that Settings is where it comes back, and
          the shorter the scroll from the top of the page to that list, the fewer of them give up
          on the way. Everything below is either a report or a deletion. */}
      <HiddenTagsPanel hidden={hidden} />

      <ErrorLogPanel log={log} />

      <CachePanel cache={cache} />

      <section aria-labelledby="later-heading" className="space-y-2">
        <h2 id="later-heading" className="font-heading text-lg leading-none text-dim">
          Not here yet
        </h2>
        <p className="text-sm text-dim">
          Data folder, sync behaviour, import and export. Coming in a later plan.
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
