import { RefreshCw } from "lucide-react";
import type { HostUpdate } from "@/lib/core/hostUpdate";
import { FOCUS } from "@/lib/focus";
import { LAYER } from "@/lib/layers";
import { PRESS } from "@/lib/motion";
import { cn } from "@/lib/utils";
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
 */
export function UpdateNotice() {
  const { update, applying, apply } = useHostUpdate();
  return <UpdateNoticeBar update={update} busy={applying} onApply={apply} />;
}

/**
 * The bar itself, drawn from an answer it was handed — so a story and a test show it with no
 * host behind them.
 *
 * - **Not a modal, and that is the requirement rather than a preference.** A reader halfway
 *   through a deck must be able to leave this for the rest of the session and keep working on
 *   the build they opened. No scrim, no focus taken, no Escape rung: a control that appeared,
 *   not a question that has to be answered.
 * - **On `LAYER.popup`**: over a page, under a dialog — a reader inside a dialog is in the
 *   middle of something, and the bar is still there when they come out.
 * - **Along the bottom, clear of the phone face's tab bar** (3.25rem and the home indicator's
 *   inset), which is the one thing a face draws there. The strip it sits in takes no presses;
 *   only the bar does.
 * - **The words are read from the live region and hidden where they are drawn**, so a screen
 *   reader meets the sentence once.
 */
export function UpdateNoticeBar({
  update,
  busy,
  onApply,
}: {
  update: HostUpdate | null;
  busy: boolean;
  onApply: () => void;
}) {
  return (
    <div
      className={cn(
        "pointer-events-none fixed inset-x-0 flex justify-center px-3",
        "bottom-[calc(4rem+env(safe-area-inset-bottom))]",
        LAYER.popup,
      )}
    >
      <p role="status" className="sr-only">
        {update?.title ?? ""}
      </p>
      {update && (
        <div
          className={cn(
            "pointer-events-auto flex max-w-full items-center gap-3 rounded-md border",
            "border-border bg-surface py-2 pr-2 pl-4 text-sm shadow-lg",
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
        </div>
      )}
    </div>
  );
}
