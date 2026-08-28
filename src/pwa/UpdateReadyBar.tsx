import type { JSX } from "react";
import { AnimatePresence, motion } from "motion/react";
import { RefreshCw } from "lucide-react";
import { LAYER } from "@/lib/layers";
import { PRESS, scrim } from "@/lib/motion";
import { cn } from "@/lib/utils";

/**
 * "A new version is ready", and the press that takes it.
 *
 * **Non-modal, and that is the requirement rather than a preference** (spec §5.4). A reader
 * halfway through a deck must be able to ignore this for the rest of the session and keep
 * working on the build they started with. So: no scrim, no focus trap, no Escape rung, nothing
 * inert behind it — it is a control that appeared, not a question that has to be answered.
 *
 * Bottom-centre and `fixed`, at {@link LAYER.popup}. Above the view and below a dialog, which is
 * the right way round: a reader in the middle of a modal is in the middle of something.
 * {@link LAYER.caption} is not in play here — the custom caption is a desktop surface (spec §3's
 * seam table has no window-chrome row for web) and this bar is web-only.
 *
 * **A plain fade, from {@link scrim}.** That preset is named for the backdrop it was written for
 * and is nothing but an opacity tween in both directions; `SyncProgress` already borrows it on
 * exactly that argument. Nothing here should travel — the bar does not come from anywhere.
 */
export function UpdateReadyBar({
  ready,
  onApply,
}: {
  ready: boolean;
  onApply: () => void;
}): JSX.Element {
  return (
    <AnimatePresence>
      {ready && (
        <motion.div
          key="update-ready"
          {...scrim}
          role="status"
          className={cn(
            "fixed inset-x-0 bottom-4 mx-auto flex w-fit items-center gap-3 rounded-lg",
            "border border-border bg-surface px-4 py-2 text-sm shadow-lg",
            LAYER.popup,
          )}
        >
          <span className="text-text">A new version is ready.</span>
          <button
            type="button"
            onClick={onApply}
            className={cn(
              "inline-flex shrink-0 items-center gap-2 rounded-md border border-accent px-3 py-1.5",
              "text-sm text-accent focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none",
              PRESS,
            )}
          >
            <RefreshCw className="size-4" aria-hidden="true" />
            Reload to update
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
