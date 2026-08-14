import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ManaLine } from "@/components/ManaLine";
import { syncActivity } from "@/lib/activity";
import type { SyncProgressEvent } from "@/lib/ipc";
import { LAYER } from "@/lib/layers";
import { scrim } from "@/lib/motion";
import { cn } from "@/lib/utils";

export interface SyncProgressProps {
  /**
   * The latest `sync:progress` event, or `null` if none has arrived.
   *
   * Passed in rather than subscribed to here: `AppShell` already listens for the ribbon's
   * mana line, and a second `useSyncProgress()` would be a second `listen` registration
   * on the same event for the life of the app.
   */
  progress: SyncProgressEvent | null;
  /** From `sync_status`. `0` means an empty database; `null` means "could not read". */
  cardCount: number | null;
  /** The banner's message — this session's rejection, else the persisted `lastError`. */
  error: string | null;
  /** A sync is in flight, or a forced one has been asked for and has not answered yet. */
  busy: boolean;
  /** Start a forced sync. The same action the ribbon's Refresh button runs. */
  onRetry: () => void;
}

/**
 * The first run, and nothing else.
 *
 * `cardCount === 0` — and only `0` — means an empty database, so the app has nothing to
 * show and the first sync gets the whole screen. `null` means the poll could not read
 * the count, which is the normal state *during* every sync; treating it as empty would
 * black out a working 116 k-card app once a day.
 *
 * Every other sync is reported by the ribbon's mana line, which is why there is no
 * second, slimmer bar here.
 *
 * **The `AnimatePresence` is in here rather than at the mount site**, which is `AppShell`. A
 * component that returns `null` for "not now" cannot be given an exit by its parent — the
 * parent sees a child that is always there — so the presence has to be expressed where the
 * condition is, and that is this function. It is also the only reason this is two components:
 * the branch is the presence, and {@link FirstRun} is what is present.
 */
export function SyncProgress({ progress, cardCount, error, busy, onRetry }: SyncProgressProps) {
  const takingOver = cardCount === 0 && progress?.phase !== "done";
  return (
    <AnimatePresence>
      {takingOver && (
        <FirstRun key="first-run" progress={progress} error={error} busy={busy} onRetry={onRetry} />
      )}
    </AnimatePresence>
  );
}

/**
 * First launch: 77 MB to download and ~117 k rows to import, with nothing usable behind
 * it. Taking the screen is honest about that — the alternative is an empty app that looks
 * broken. It is also the first thing anyone ever sees of this app, which is why it opens
 * with the name and then says, in one sentence, what the wait buys.
 *
 * **It draws the mana line rather than a bar of its own**, and that is not a repetition of
 * the app's one signature — it is the signature standing in the one place it cannot be. This
 * surface covers the ribbon, so while it is up there is exactly one mana line on screen, in
 * the same role it plays everywhere else, and the reader who has just watched it fill finds
 * it under the ribbon a second later. The label and the count come from {@link syncActivity},
 * the same fold the ribbon uses, so the two surfaces cannot drift apart on the wording of a
 * phase or the unit it counts.
 *
 * Because it covers the ribbon, the ribbon's Refresh button is unreachable underneath,
 * so this carries its own. Every way a first run can stall ends here: a failure that
 * arrived as an event, one that only ever reached `lastError` (the startup sync fails
 * before the webview is listening, and Tauri drops the event), and a run throttled by the
 * 24 h check window, which says nothing at all. `busy` is the one thing that separates
 * "working on it" from "stopped", so it — not the presence of an event — decides.
 *
 * **Retry appears only when it can do something.** A download that is running cannot be
 * restarted (`sync_run` refuses a second concurrent run), so a button offering it for the
 * ~90 s of the happy path is dead chrome on a screen with four things on it. The three
 * states that need a way out are exactly the three where nothing is running.
 *
 * Not `aria-modal`: the app behind is not inert, and claiming otherwise would hide it
 * from assistive technology while it is still perfectly reachable by keyboard.
 *
 * **A plain fade, and {@link scrim} is the vocabulary's plain fade.** The preset is named for
 * the backdrop it was written for and is nothing but an opacity tween at the interaction tier
 * in both directions, which is exactly what this wants: no travel, because this surface does
 * not arrive from anywhere — it *is* the ground until there is an app behind it. Nothing else
 * here animates, and there is deliberately no scrim of its own to pair with, no focus trap and
 * no Escape rung: an opaque `bg-bg` takeover has nothing to be dismissed *to*.
 */
function FirstRun({ progress, error, busy, onRetry }: Omit<SyncProgressProps, "cardCount">) {
  /**
   * The failure the reader has already answered by pressing Retry.
   *
   * **The press has to be remembered, because nothing else will forget for it.** A
   * `sync:progress` error is the last thing this window heard and stays the last thing
   * until a *new* run says something — so a screen reading the event alone goes on
   * reporting a run the reader replaced seconds ago, with the button as the only thing
   * that ever moved. Holding the event that was dismissed rather than a "retrying" flag is
   * what keeps that honest with no staleness of its own: a new failure is a new object, so
   * it is never the dismissed one, and the screen reports it.
   *
   * It is the whole of the feedback, and it needs no sentence of its own: `useSync.refresh`
   * sets `refreshing` synchronously, so the press that clears this is the same press that
   * makes `busy` true — and with the failure out of the way the mana line comes up sweeping
   * under "Syncing card data" in the same frame the button was let go.
   */
  const [retriedOver, setRetriedOver] = useState<SyncProgressEvent | null>(null);

  // An `error` event outranks `busy`: the status poll is up to a second behind it, and a
  // failure must not sit hidden behind a progress bar for that second.
  const failed = progress?.phase === "error" && progress !== retriedOver;
  const running = busy && !failed;

  // Non-null only while something is running, which is what makes it the whole of the
  // "is there anything to report" question below.
  const activity = running ? syncActivity(progress, busy) : null;
  // Only ever the *stopped* screen's sentence. A persisted `lastError` outlives the run it
  // describes — it is cleared by the poll, not by the retry — so printing it beside a bar
  // that is moving again would be this screen reporting two runs at once. `AppShell`'s
  // banner still carries it underneath.
  const failure = running ? null : failed ? (progress?.message ?? error) : error;

  /**
   * What this screen says, and the one thing on it that is announced.
   *
   * Mounted for the life of the overlay and `sr-only` when empty, because a live region
   * that first appears with its sentence already inside it announces nothing — the
   * ribbon's status line and the sidebar's drop report, for their reason.
   *
   * **A failure is deliberately not in here.** `AppShell`'s banner is the app's one
   * `role="alert"` and it announces the same string; two live regions saying one thing is
   * one thing said twice. It renders below as plain text instead.
   */
  const said = activity
    ? activity.label
    : failure
      ? ""
      : "No download is running, and there is no card data yet.";

  return (
    <motion.div
      {...scrim}
      role="dialog"
      aria-labelledby="first-run-title"
      className={cn(
        "fixed inset-0 flex flex-col items-center justify-center gap-6 bg-bg px-8 text-center",
        LAYER.gate,
      )}
    >
      {/* The name in full, and the only place in the app it is set in type — the ribbon
          shows the mark alone, because 48px of chrome is not where a two-word name earns
          its keep, and this screen is nothing but room. Deliberately the ribbon's own
          treatment (`font-heading text-lg leading-none text-dim`, Cinzel's 18px floor)
          with letterspacing for the one thing that differs: this is a wordmark rather than
          the first step of app › view. Dim rather than gold — gold means "you can act on
          this", and a name is not an action. Hidden from the accname for the ribbon mark's
          reason: the window title bar already says it, and the dialog is named by the
          heading below. */}
      <p
        aria-hidden="true"
        className="font-heading text-lg leading-none tracking-[0.2em] text-dim"
      >
        MTG Grimoire
      </p>

      <div className="max-w-md space-y-2">
        <h2 id="first-run-title" className="font-heading text-2xl text-text">
          Setting up your card database
        </h2>
        <p className="text-sm text-dim">
          Downloading every Magic card from Scryfall. This happens once and takes a few minutes —
          after that the app works offline.
        </p>
      </div>

      <div className="w-full max-w-md space-y-2">
        {/* Drawn even when nothing is running, where it is the plain five-colour rule and
            carries no `progressbar` at all: the signature belongs on this screen whether or
            not there is a fraction to put on it, and a stalled first run with the line
            simply *gone* would read as an app that had lost a piece of itself. */}
        <ManaLine sync={activity} />
        {/* Two shapes, and which one it is follows `running` rather than the presence of a
            number — so the row settles once, when the run starts, instead of re-aligning
            itself the first time a phase happens to count something. Running, it is a
            caption on a bar: the phase at the line's left end and the count at its right.
            Stopped, it is not a caption at all but the only sentence on the screen, so it
            takes the hero's own centre and the size the rest of the prose is set in. */}
        <div
          className={cn(
            "flex min-h-4 items-start gap-3",
            running ? "justify-between text-xs" : "justify-center text-sm",
          )}
        >
          <p role="status" className={said ? "min-w-0 text-dim" : "sr-only"}>
            {said}
          </p>
          {/* Hidden from the announcement, not from the eye — the ribbon's arrangement, for
              the ribbon's reason: the label changes about four times in a sync while this
              number changes fifty-eight times during the ingest alone. Geist Mono because
              the direction's third type role is data, and a count that reflows its own width
              every 200 ms is exactly what it is for. */}
          {activity?.detail && (
            <span aria-hidden="true" className="shrink-0 font-mono tabular-nums text-dim">
              {activity.detail}
            </span>
          )}
        </div>
      </div>

      {failure && <p className="max-w-md text-sm text-destructive">{failure}</p>}

      {!running && (
        <button
          type="button"
          onClick={() => {
            setRetriedOver(progress);
            onRetry();
          }}
          className={cn(
            "inline-flex items-center rounded-md border border-border px-4 py-2 text-sm",
            "transition-colors duration-150 hover:bg-surface motion-reduce:transition-none",
            // The only control on screen while a first run is stuck, so its focus ring is
            // the one that matters most — same gold as the ribbon's.
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
          )}
        >
          Retry download
        </button>
      )}
    </motion.div>
  );
}
