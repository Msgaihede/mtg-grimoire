import { useState, type JSX } from "react";
import { Eraser } from "lucide-react";
import { cn } from "@/lib/utils";
import { ConfirmDialog } from "./ConfirmDialog";
import { BUTTON } from "./controls";
import { PanelAlert, SettingsSection } from "./panelChrome";
import type { LocalCache } from "./useDataReset";

/**
 * The downloaded bytes, and the one button that throws them away.
 *
 * **Its own panel, above the danger zone rather than in it, and the separation is the point.**
 * Everything below the fold on this page is irreversible; this is not. A reader who has come to
 * the Settings page because the app is taking up too much room needs a button they can press
 * without reading three sentences first — and putting it one row above Clear collection would
 * make it the button they reach for by muscle memory when they meant that one.
 *
 * So the two differ in every way a page can differ: a separate region with its own heading, a
 * plain border rather than the destructive red, and a confirmation with no typed word (see
 * {@link ConfirmDialog}'s `typeToConfirm`).
 *
 * **The size is reported after the fact rather than before**, which is a deliberate absence: a
 * "Cached: 314 MB" line would need a directory walk over 5 540 files every time this page is
 * opened, and it would be a number nobody acts on until they press the button anyway. The
 * outcome sentence says what was freed.
 */
export function CachePanel({ cache }: { cache: LocalCache }): JSX.Element {
  const [asking, setAsking] = useState(false);

  return (
    <SettingsSection id="cache" title="Local cache">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="min-w-0 text-sm text-dim">
          Card images and the leftovers of each download. All of it is fetched again when it is
          next needed — your collection and decks are not touched.
        </p>
        <button
          type="button"
          onClick={() => setAsking(true)}
          disabled={cache.clear.pending}
          aria-busy={cache.clear.pending || undefined}
          className={cn(BUTTON, "border-border hover:bg-bg disabled:hover:bg-transparent")}
        >
          <Eraser className="size-4" aria-hidden="true" />
          Clear cache
        </button>
      </div>

      {/* `plain`, like `ErrorLogPanel`'s and unlike the danger zone's: the sentence here is
          usually good news, and the one refusal it can carry — a sync in flight — is a "not
          now" rather than a fault. */}
      <PanelAlert tone={cache.status?.tone ?? "plain"}>{cache.status?.text ?? null}</PanelAlert>

      <ConfirmDialog
        open={asking}
        title="Clear local cache"
        confirmLabel="Clear cache"
        typeToConfirm={false}
        pending={cache.clear.pending}
        onConfirm={cache.clear.run}
        onDismiss={() => setAsking(false)}
        onClose={() => setAsking(false)}
      >
        Deletes the card images and download leftovers stored beside the database. Nothing is
        lost — the app fetches each picture again the next time it draws that card, so the only
        cost is that they arrive over the network once more.
      </ConfirmDialog>
    </SettingsSection>
  );
}
