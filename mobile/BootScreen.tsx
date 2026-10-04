import { GrimoireMark } from "@/components/GrimoireMark";
import type { StartupStatus } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { ReloadLink } from "./ReloadLink";

/**
 * What the light app draws before there is an app: the mark, one sentence, and — where the host
 * says starting again can cure what went wrong — the way to start again.
 *
 * **Everything here is drawn from what the host answered**, never from where this is running:
 * the sentence is the host's own, and `reload` is the host saying a fresh document may find things
 * different. A second tab of a browser is the first that does — the first tab holds the database,
 * and only asking again says whether it has closed.
 */
export function BootScreen({ status }: { status: StartupStatus }) {
  return (
    <div className="flex h-dvh flex-col items-center justify-center gap-4 bg-bg px-6 text-text">
      <GrimoireMark size={48} className="text-accent" />
      {status.state === "failed" ? (
        <>
          {/* The host's own sentence, and it is several lines with a folder's path on one of
              them — `StartupScreen`'s two reasons, at a width where they matter more: without
              `whitespace-pre-line` the breaks are flattened, and without `break-words` a path is
              one unbreakable word wider than a phone.

              The destructive colour is for a start that failed and stays failed. One a reload
              can cure is told plainly: the reader did nothing wrong and neither did the app. */}
          <p
            role="alert"
            className={cn(
              "max-w-prose whitespace-pre-line break-words text-center text-sm",
              status.reload ? "text-text" : "text-destructive",
            )}
          >
            {status.message}
          </p>
          {status.reload && <ReloadLink />}
        </>
      ) : (
        <p role="status" className="text-sm text-dim">
          Opening your collection…
        </p>
      )}
    </div>
  );
}
