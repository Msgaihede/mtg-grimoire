import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Dialog } from "@grimoire/ui/components/Dialog";
import { core } from "@grimoire/ui/lib/core";
import { FOCUS } from "@grimoire/ui/lib/focus";
import { PRESS_SOFT } from "@grimoire/ui/lib/motion";
import { cn } from "@grimoire/ui/lib/utils";
import { HeldDownloadsContext } from "./heldDownloads";

/** One download the launch is holding, as the host's `light_downloads` answers it. */
export interface HeldDownload {
  key: string;
  label: string;
  bytes: number;
}

/** The host's answer: whether the launch is holding, and what it is holding. */
export interface DownloadsStatus {
  held: boolean;
  metered: boolean;
  due: HeldDownload[];
}

/** `47 MB` — decimal megabytes, rounded up, which is how the sizes were measured and quoted. */
export function megabytes(bytes: number): string {
  return `${Math.max(1, Math.ceil(bytes / 1_000_000))} MB`;
}

const BUTTON = cn(
  "flex h-11 min-w-0 flex-1 items-center justify-center rounded-md px-4 text-sm",
  PRESS_SOFT,
  FOCUS,
);

/**
 * **The mobile-data prompt** — the light-app spec §4: *"Any feed over 5 MB shows its measured
 * size and, where the connection reports itself metered, defaults to Not now."* Phase 4, step 4.4.
 *
 * **The host decides whether to ask, never this.** It asks `light_downloads` and draws itself only
 * when the host says its launch is holding downloads: the Android host holds them on a metered
 * link, and a host with no such command — the desktop binary under `mobile:tauri`, the Storybook
 * fake — refuses, which is nothing to ask about. So the page asks nothing about where it runs
 * (`phone/fence.test.ts`), and both faces draw the same prompt because `LightApp` mounts it
 * around them.
 *
 * **Not now is the default and sends nothing**: it is the footer's first button, and the ✕, Escape
 * and the scrim do the same. `Dialog` focuses its panel, never a button, so nothing is pressed by
 * an Enter meant for something else. **Download** starts exactly what the launch would have; with
 * the box ticked, a metered link does not ask again.
 *
 * **Not now is never the last word** (issue #1155). Android resumes this process rather than
 * launching it again, so "the next launch" may be days away. So:
 *
 * - **It asks again each time the page comes back to the front** (`visibilitychange`). The host
 *   looks at the link on each ask while it holds: back on an unmetered link it lets the hold go
 *   and starts the downloads itself, and the prompt stays shut; still metered, it opens again.
 * - **While the host holds, the faces keep an offer** — the phone's empty Search and Settings —
 *   through {@link HeldDownloadsContext}, which this provides to `children`; its press asks again
 *   and opens this.
 */
export function DownloadsPrompt({ children }: { children?: ReactNode }) {
  const [status, setStatus] = useState<DownloadsStatus | null>(null);
  const [shown, setShown] = useState(false);
  const [always, setAlways] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const live = useRef(true);

  const ask = useCallback(() => {
    core.call<DownloadsStatus>("light_downloads").then(
      (s) => {
        if (!live.current) return;
        setStatus(s);
        setShown(s.held && s.due.length > 0);
      },
      // A host without the command: nothing to ask.
      () => {},
    );
  }, []);

  useEffect(() => {
    live.current = true;
    ask();
    const onVisibility = () => {
      if (document.visibilityState === "visible") ask();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      live.current = false;
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [ask]);

  const held = status !== null && status.held && status.due.length > 0;
  const open = held && shown;
  const close = () => setShown(false);
  const total = status?.due.reduce((sum, d) => sum + d.bytes, 0) ?? 0;
  const heldDownloads = useMemo(() => ({ held, offer: ask }), [held, ask]);

  const start = () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    core.call("light_downloads_start", { always }).then(
      () => {
        if (!live.current) return;
        setBusy(false);
        // Nothing is held any more: the prompt and every offer go.
        setStatus(null);
        setShown(false);
      },
      (e: unknown) => {
        if (!live.current) return;
        setBusy(false);
        setError(`Couldn't start the downloads — ${e instanceof Error ? e.message : String(e)}`);
      },
    );
  };

  return (
    <HeldDownloadsContext.Provider value={heldDownloads}>
      {children}
      <Dialog
        open={open}
        title="Download on mobile data?"
        subtitle={`About ${megabytes(total)} in all`}
        closeLabel="Close"
        size="w-full self-end rounded-t-xl border-t border-border sm:w-[26rem] sm:self-center"
        onDismiss={close}
        onClose={close}
      >
        <div className="space-y-3 px-4 py-3 text-sm">
          <p className="text-dim">
            Your connection says it is metered. These downloads wait until you say so — this is
            asked again each time you come back to the app, and back on Wi-Fi they start by
            themselves. Until the card data arrives, search and the card pages have nothing to show.
          </p>
          <ul className="divide-y divide-border rounded-md border border-border">
            {status?.due.map((d) => (
              <li key={d.key} className="flex items-center justify-between gap-3 px-3 py-2">
                <span className="min-w-0">{d.label}</span>
                <span className="shrink-0 font-mono text-xs text-dim">
                  about {megabytes(d.bytes)}
                </span>
              </li>
            ))}
          </ul>
          <label className="flex min-h-11 items-center gap-3">
            <input
              type="checkbox"
              checked={always}
              onChange={(e) => setAlways(e.target.checked)}
              className={cn("size-4 accent-accent", FOCUS)}
            />
            Don't ask again on mobile data
          </label>
          <p role="alert" className="min-h-4 text-xs text-destructive">
            {error}
          </p>
        </div>
        <footer className="flex shrink-0 gap-2 border-t border-border px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          {/* First: the spec's default on a metered link, and what Escape and the scrim also do. */}
          <button type="button" onClick={close} className={cn(BUTTON, "border border-border")}>
            Not now
          </button>
          <button
            type="button"
            aria-disabled={busy || undefined}
            onClick={start}
            className={cn(BUTTON, "bg-accent font-medium text-accent-fg aria-disabled:opacity-40")}
          >
            Download
          </button>
        </footer>
      </Dialog>
    </HeldDownloadsContext.Provider>
  );
}
