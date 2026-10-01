import { GrimoireMark } from "@/components/GrimoireMark";
import type { StartupStatus } from "@/lib/ipc";

/** What the light app draws before there is an app: the mark, and one sentence. */
export function BootScreen({ status }: { status: StartupStatus }) {
  return (
    <div className="flex h-dvh flex-col items-center justify-center gap-4 bg-bg px-6 text-text">
      <GrimoireMark size={48} className="text-accent" />
      {status.state === "failed" ? (
        // The native side's own sentence, and it is several lines with a folder's path on one of
        // them — `StartupScreen`'s two reasons, at a width where they matter more: without
        // `whitespace-pre-line` the breaks are flattened, and without `break-words` a path is one
        // unbreakable word wider than a phone.
        <p
          role="alert"
          className="max-w-prose whitespace-pre-line break-words text-center text-sm text-destructive"
        >
          {status.message}
        </p>
      ) : (
        <p role="status" className="text-sm text-dim">
          Opening your collection…
        </p>
      )}
    </div>
  );
}
