import { useCallback, useEffect, useRef, useState } from "react";
import { ipc, ipcError, type UpdateProgressEvent, type UpdateStatus } from "@/lib/ipc";
import { ago, daysSince } from "@/lib/relativeTime";

/**
 * How often the status is re-read when nothing is happening.
 *
 * Slow on purpose. The only thing this catches that an action would not is the **check
 * spawned at startup**: it runs in Rust while the window is coming up, writes its answer to
 * `app_meta`, and emits nothing — deliberately, because Tauri drops events the webview is
 * not yet listening for, which at startup is all of them (`sync.rs` documents the same
 * trap). Everything else — a manual check, a download, a staged build — is the resolved
 * value of the call that caused it. So this is a safety net for one event, not a poll of a
 * moving number, and a minute is soon enough to notice a release that has been out for a
 * day.
 */
const POLL_MS = 60_000;

/** Bytes → `6.4 MB`. The unit a download is worth reporting in; nothing here is under a MB. */
export function formatBytes(n: number): string {
  return `${(n / 1_000_000).toFixed(1)} MB`;
}

/**
 * `1800000000` → `2 hours ago`.
 *
 * Relative rather than a timestamp because the only question this line answers is "is this
 * recent enough to trust?", and a reader should not have to subtract two dates to find out.
 * Past a week it becomes the date, where "9 days ago" stops being easier to read than the
 * day itself.
 *
 * **The two arms that stay here are the two that are this line's own**: the null/unreadable
 * arm, whose sentence is a claim about freshness printed under a version number, and the
 * week cut-off. Everything between is `lib/relativeTime`'s `ago`.
 *
 * **It floors now, where it used to round, and that is a real change** (2026-08-16). Ninety
 * minutes read `2 hours ago` here while `ErrorLogPanel`'s already-flooring `formatWhen`
 * called the same span `1 hour ago`, on one page. The cut-off moved with it: `daysSince` is
 * the same floored count `ago` prints, so the date arm now begins exactly where the relative
 * arm would have said `8 days ago`, instead of at the rounded seven-and-a-half days.
 */
export function formatChecked(unixSeconds: string | null, now: number = Date.now()): string {
  const at = Number(unixSeconds);
  if (!unixSeconds || !Number.isFinite(at) || at <= 0) return "Not checked yet";
  if (daysSince(at, now) > 7) return `Checked on ${new Date(at * 1000).toISOString().slice(0, 10)}`;
  // A clock that moved backwards, or a value from the future, reaches `ago`'s "just now".
  return `Checked ${ago(at, now)}`;
}

/**
 * What the update panel can do right now — one value, so no two controls can disagree about
 * which state the app is in.
 *
 * `unavailable` is not an error: it is the honest answer for an MSI install or a Linux
 * build, where a release exists and nothing in this window can install it.
 */
export type UpdateAction = "none" | "download" | "install" | "unavailable";

export interface Update {
  status: UpdateStatus | null;
  /** Bytes so far, while a download is running. `null` at every other moment. */
  progress: UpdateProgressEvent | null;
  /** This window started a check or a download and it has not settled. */
  busy: boolean;
  /** What the primary button should do. */
  action: UpdateAction;
  /** This session's failure. Cleared by the next action that gets anywhere. */
  error: string | null;
  check: () => void;
  download: () => void;
  install: () => void;
  openReleasePage: () => void;
}

/** What the panel's primary control does, given what the backend has answered. */
export function nextAction(status: UpdateStatus | null): UpdateAction {
  if (!status?.available) return "none";
  if (status.staged) return "install";
  return status.asset ? "download" : "unavailable";
}

/**
 * Owns the update status, the download and the install.
 *
 * Plain hooks rather than TanStack Query, for `useSync`'s reason: one endpoint, a bespoke
 * cadence, and a progress event that is not a cache entry.
 *
 * Mounted once, in `AppShell`, and passed down — the ribbon's button and the Settings panel
 * are two views of one state, and two `useUpdate()` calls would be two `update:progress`
 * listeners racing to describe the same download.
 */
export function useUpdate(): Update {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [progress, setProgress] = useState<UpdateProgressEvent | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const next = await ipc.updateStatus();
        if (!cancelled) setStatus(next);
      } catch {
        // Not worth a banner: the next poll is a minute away, and a status that cannot be
        // read says nothing about whether an update exists.
      }
      // Chained timeouts rather than an interval, so two reads can never overlap.
      timer = setTimeout(poll, POLL_MS);
    };
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [nonce]);

  // Registered for the life of the hook rather than only while downloading: a listener set
  // up at the moment the download starts can miss the first event, and the first event is
  // the one that puts a bar on screen.
  const downloading = useRef(false);
  useEffect(() => {
    return ipc.onUpdateProgress((e) => {
      if (downloading.current) setProgress(e);
    });
  }, []);

  const check = useCallback(() => {
    setBusy(true);
    setError(null);
    ipc
      .updateCheck(true)
      .then(setStatus)
      .catch((e: unknown) => setError(ipcError(e)))
      .finally(() => setBusy(false));
  }, []);

  const download = useCallback(() => {
    setBusy(true);
    setError(null);
    setProgress(null);
    downloading.current = true;
    ipc
      .updateDownload()
      .then(setStatus)
      .catch((e: unknown) => setError(ipcError(e)))
      .finally(() => {
        downloading.current = false;
        setBusy(false);
        setProgress(null);
      });
  }, []);

  const install = useCallback(() => {
    setBusy(true);
    setError(null);
    // No `finally` clearing `busy`: this call is answered and then the window closes. Were
    // it to fail, the app is still here — so only the failure path puts the button back.
    ipc.updateApply().catch((e: unknown) => {
      setError(ipcError(e));
      setBusy(false);
      // The staged file may be gone or the swap rolled back; re-read rather than assume.
      setNonce((n) => n + 1);
    });
  }, []);

  const openReleasePage = useCallback(() => {
    ipc.updateOpenReleasePage().catch((e: unknown) => setError(ipcError(e)));
  }, []);

  return {
    status,
    progress,
    busy: busy || status?.busy === true,
    action: nextAction(status),
    error,
    check,
    download,
    install,
    openReleasePage,
  };
}
