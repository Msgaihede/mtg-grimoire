import { useEffect, useId, useState } from "react";
import { core } from "@/lib/core";
import {
  STORAGE_CLEARED,
  STORAGE_CLEARED_DISMISS,
  type StorageCleared,
} from "@/lib/core/hostStorage";
import { FOCUS } from "@/lib/focus";
import { LAYER } from "@/lib/layers";
import { PRESS } from "@/lib/motion";
import { cn } from "@/lib/utils";

/**
 * **The notice that the host's storage was cleared under the app** — the light-app spec §6: *"The
 * corpus can vanish while the shell survives."* Phase 5, step 5.2.
 *
 * Some hosts keep the database in storage that is lent to them and can be taken back while the
 * app still opens. The engine then opens an empty database and downloads the card data again by
 * itself — and an app that says nothing about it reads as a first run, to a reader waiting for a
 * collection no download will bring back.
 *
 * **The host decides whether there is anything to say, and says it in its own words.** This asks
 * `storage_cleared` once and draws only an answer: a host that found its storage gone answers
 * what happened, what is being rebuilt and what is not coming back, and a host with no such
 * command — one that owns its folder, the Storybook fake — refuses, which is nothing to draw. So
 * the page asks nothing about where it runs (`phone/fence.test.ts`), the sentences are written
 * once by the host that can be in that state, and both faces show the same notice because
 * `LightApp` mounts it above them. `DownloadsPrompt` is the same arrangement one file over.
 *
 * **The last paragraph is about a pairing group, and it is an *if*** (phase 6, step 6.4). What
 * went with the storage included this install's device identity, so a browser that was paired
 * has come back as a new device and its old entry still holds one of its group's five places.
 * The host cannot know whether it was — the record that it was paired is the record that was
 * cleared — so its sentence says *if*, and says where the old entry is removed. The Sync panel
 * says the same thing beforehand, standing, on a host of this kind that is in a group
 * (`SITE_DATA_WARNING`): that is the half a reader can still act on by leaving the group first.
 *
 * **Once per occurrence**: the host goes on answering until it is told the reader has read it,
 * across reloads — a reader who reloads because the app looks empty is still told why — and
 * never after. The press closes it here whatever the host then says: a notice that could not be
 * put away would be worse than one shown twice.
 */
export function StorageNotice() {
  const [notice, setNotice] = useState<StorageCleared | null>(null);

  useEffect(() => {
    let live = true;
    core.call<StorageCleared | null>(STORAGE_CLEARED).then(
      (answer) => {
        if (live) setNotice(readable(answer));
      },
      // A host without the command: nothing to say.
      () => {},
    );
    return () => {
      live = false;
    };
  }, []);

  if (notice === null) return null;

  const dismiss = () => {
    setNotice(null);
    core.call(STORAGE_CLEARED_DISMISS).catch(() => {});
  };
  return <StorageNoticeCard notice={notice} onDismiss={dismiss} />;
}

/** An answer this can draw, or `null`: a title and at least the shape of its paragraphs. */
function readable(answer: StorageCleared | null | undefined): StorageCleared | null {
  return answer && typeof answer.title === "string" && Array.isArray(answer.lines) ? answer : null;
}

/**
 * The notice itself, drawn from an answer it was handed — which is what lets a story and a test
 * show it with no host behind them.
 *
 * - **Not a modal.** Nothing here is a decision and nothing behind it is unsafe to use: the
 *   reader may go on to search while the card data comes back. So there is no scrim, no focus
 *   taken and no trap — a card at the top of the window, read and put away.
 * - **`role="alert"` on the words, mounted with them.** Announcing on insertion is what that
 *   role is for, and this arrives a moment after the app does, in answer to a question the page
 *   asked — never with the document itself. The button is outside the alert, so what is
 *   announced is the host's paragraphs and not the control beneath them.
 * - **Drawn on the first-run screen's own rung, after it in the document.** At 1024px and wider
 *   an empty card database is the desktop face's full-window "Setting up your card database",
 *   which is `LAYER.gate` and covers everything the app draws — and that is the screen this
 *   notice explains, for the whole of the download. `LightApp` mounts this after both faces, and
 *   equal rungs are resolved by document order, so it is read over that screen rather than
 *   after it.
 * - **The strip it sits in takes no presses**, only the card does: the strip spans the window's
 *   width and would otherwise lie over whatever each face draws along its top edge.
 */
export function StorageNoticeCard({
  notice,
  onDismiss,
}: {
  notice: StorageCleared;
  onDismiss: () => void;
}) {
  const id = useId();
  return (
    <section
      aria-labelledby={`${id}-title`}
      className={cn(
        "pointer-events-none fixed inset-x-0 top-0 flex justify-center px-3",
        "pt-[max(0.75rem,env(safe-area-inset-top))]",
        LAYER.gate,
      )}
    >
      <div
        className={cn(
          // `relative` because it scrolls: a scroller is the containing block for what is in it.
          "pointer-events-auto relative flex max-h-[90dvh] w-full max-w-lg flex-col gap-3",
          "overflow-y-auto rounded-md border border-border bg-surface p-4 text-sm shadow-lg",
        )}
      >
        <div role="alert" className="space-y-2">
          <h2 id={`${id}-title`} className="text-base font-medium text-text">
            {notice.title}
          </h2>
          {notice.lines.map((line) => (
            <p key={line} className="text-dim">
              {line}
            </p>
          ))}
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className={cn(
            "flex h-11 shrink-0 items-center justify-center self-end rounded-md border",
            "border-border px-4 text-sm text-text hover:bg-bg",
            PRESS,
            FOCUS,
          )}
        >
          Got it
        </button>
      </div>
    </section>
  );
}
