import { ErrorLogPanel } from "@/features/settings/ErrorLogPanel";
import { MarketplacePanel } from "@/features/settings/MarketplacePanel";
import { UpdatePanel } from "@/features/settings/UpdatePanel";
import type { Update } from "@/lib/useUpdate";
import { useErrorLog } from "@/lib/useErrorLog";
import { useMarketplace } from "@/lib/useMarketplace";

/**
 * Settings.
 *
 * Three sections. The data folder and import/export are still a later plan's — the blurb below
 * stands in for the part that is genuinely still missing, rather than hiding panels that
 * exist.
 *
 * `update` is passed in rather than hooked up here: `AppShell` already owns it for the
 * ribbon's button, and a second `useUpdate()` would be a second `update:progress` listener
 * racing to describe the same download. The error log is the opposite and is hooked up
 * *here*, because nothing else in the window reads it — it is not polled, it has no
 * listener, and there is no second surface for it to race.
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

  return (
    <div className="mx-auto max-w-2xl space-y-8 py-2">
      <UpdatePanel update={update} />

      <MarketplacePanel marketplace={marketplace} />

      <ErrorLogPanel log={log} />

      <section aria-labelledby="later-heading" className="space-y-2">
        <h2 id="later-heading" className="font-heading text-lg leading-none text-dim">
          Not here yet
        </h2>
        <p className="text-sm text-dim">
          Data folder, sync behaviour, import and export. Coming in a later plan.
        </p>
      </section>
    </div>
  );
}
