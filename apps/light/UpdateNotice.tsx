import { useState } from "react";
import { RefreshCw, X } from "lucide-react";
import type { HostUpdate } from "@grimoire/ui/lib/core/hostUpdate";
import { FOCUS } from "@grimoire/ui/lib/focus";
import { LAYER } from "@grimoire/ui/lib/layers";
import { PRESS } from "@grimoire/ui/lib/motion";
import { cn } from "@grimoire/ui/lib/utils";
import { useHostUpdate } from "./useHostUpdate";

/**
 * **"A new version is ready", and the press that takes it** — the light-app spec §6. Phase 5,
 * step 5.3.
 *
 * **The host decides whether there is anything to say** (`useHostUpdate`): this draws only what
 * a host answered, in the host's words, and a host with no such command draws nothing. `LightApp`
 * mounts it above both faces, so a crossing keeps the one that is there.
 *
 * **The live region is mounted before it has anything to say.** A `role="status"` that first
 * appears with its sentence already inside announces nothing, so the region is here from the
 * first render, empty, and the sentence is put into it when the host answers.
 *
 * **It can be put away, for as long as the host says nothing new.** The bar is `fixed` over the
 * foot of whatever page is drawn, and a reader who means to finish what they are doing first
 * must be able to have that strip back: the last row of a wall is under it. *Not now* hides it
 * until the host next speaks of an update — a newer build still, or this one found again — or
 * until the next load, which asks afresh. **What is remembered is the answer that was put
 * away**, not a flag: every word from the host is a new answer (`useHostUpdate`), so a new one
 * is drawn without anything here having to notice that it is new. The waiting build is not
 * touched by it, and the face's boundary still offers it.
 */
export function UpdateNotice() {
  const { update, applying, apply } = useHostUpdate();
  const [putAway, setPutAway] = useState<HostUpdate | null>(null);
  const shown = update !== null && update !== putAway ? update : null;
  return (
    <UpdateNoticeBar
      update={shown}
      busy={applying}
      onApply={apply}
      onDismiss={() => setPutAway(update)}
    />
  );
}

/**
 * The bar itself, drawn from an answer it was handed — so a story and a test show it with no
 * host behind them.
 *
 * - **Not a modal, and that is the requirement rather than a preference.** A reader halfway
 *   through a deck must be able to leave this for the rest of the session and keep working on
 *   the build they opened. No scrim, no focus taken, no Escape rung: a control that appeared,
 *   not a question that has to be answered.
 * - **On `LAYER.header`, the highest rung a page itself draws on** — over a wall and its sticky
 *   header, and under everything a reader *opened*: a context menu or a picker (`popup`), the
 *   filter bar's tray, a drag's drop zones, a dialog. It was on `popup`, and being later in the
 *   document than either face it painted over a menu opened near the foot of the window; equal
 *   rungs are settled by document order, and this is mounted after the faces on purpose.
 * - **Along the bottom, clear of the phone face's tab bar** (3.25rem and the home indicator's
 *   inset), which is the one thing a face draws there. The strip it sits in takes no presses;
 *   only the bar does — and the bar has a way to be put away, because what lies under it takes
 *   none either while it is drawn.
 * - **The words are read from the live region and hidden where they are drawn**, so a screen
 *   reader meets the sentence once.
 */
export function UpdateNoticeBar({
  update,
  busy,
  onApply,
  onDismiss,
}: {
  update: HostUpdate | null;
  busy: boolean;
  onApply: () => void;
  /** Put the bar away without taking the update. */
  onDismiss: () => void;
}) {
  return (
    <div
      className={cn(
        "pointer-events-none fixed inset-x-0 flex justify-center px-3",
        "bottom-[calc(4rem+env(safe-area-inset-bottom))]",
        LAYER.header,
      )}
    >
      <p role="status" className="sr-only">
        {update?.title ?? ""}
      </p>
      {update && (
        <div
          className={cn(
            "pointer-events-auto flex max-w-full items-center gap-2 rounded-md border",
            "border-border bg-surface py-2 pr-1 pl-4 text-sm shadow-lg",
          )}
        >
          <p aria-hidden="true" className="min-w-0 text-text">
            {update.title}
          </p>
          <button
            type="button"
            aria-disabled={busy || undefined}
            onClick={busy ? undefined : onApply}
            className={cn(
              "flex h-11 shrink-0 items-center gap-2 rounded-md border border-accent px-3",
              "text-accent aria-disabled:opacity-40 aria-disabled:active:scale-100",
              PRESS,
              FOCUS,
            )}
          >
            <RefreshCw className="size-4" aria-hidden="true" />
            {update.action}
          </button>
          {/* Its words are its name: an ✕ on a bar that offers a reload could be read as
              refusing the update, and this only moves the offer out of the way. */}
          <button
            type="button"
            aria-label="Not now"
            onClick={onDismiss}
            className={cn(
              "flex size-11 shrink-0 items-center justify-center rounded-md text-dim",
              "hover:text-text",
              PRESS,
              FOCUS,
            )}
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  );
}
