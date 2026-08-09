import { UpdatePanel } from "@/features/settings/UpdatePanel";
import type { Update } from "@/lib/useUpdate";

/**
 * Settings.
 *
 * One section so far. The data folder, sync behaviour and import/export are still a later
 * plan's — the blurb that used to stand in for this whole view now stands in for the part
 * that is genuinely still missing, rather than hiding a panel that exists.
 *
 * `update` is passed in rather than hooked up here: `AppShell` already owns it for the
 * ribbon's button, and a second `useUpdate()` would be a second `update:progress` listener
 * racing to describe the same download.
 */
export function SettingsPage({ update }: { update: Update }) {
  return (
    <div className="mx-auto max-w-2xl space-y-8 py-2">
      <UpdatePanel update={update} />

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
