import { GrimoireMark } from "@/components/GrimoireMark";
import { ManaLine } from "@/components/ManaLine";
import { TitleBar } from "@/components/TitleBar";
import { ACTIVITY_DELAY_MS } from "@/lib/activity";
import type { StartupStatus } from "@/lib/ipc";
import { isAndroid } from "@/lib/platform";
import { useDelayedFlag } from "@/lib/useDelayedFlag";
import { cn } from "@/lib/utils";
import { isWebTarget } from "@/pwa/target";

/**
 * The two states that are not the app. `ready` is never drawn here — `DesktopBoot` mounts `App`
 * instead. Derived from the mirror rather than restated, so a new state there is a type error here.
 */
export type StartupScreenStatus = Exclude<StartupStatus, { state: "ready" }>;

export interface StartupScreenProps {
  status: StartupScreenStatus;
}

/** The loading sentence, and the progressbar's name, spelled once so the two cannot drift. */
export const STARTUP_LOADING_LABEL = "Opening your collection…";

/**
 * What the window shows while the native side opens the data folder, and what it shows if that
 * never happens.
 *
 * **The caption is drawn here too, and for the reason `AppShell` draws it.** The window is
 * `decorations: false`, so without {@link TitleBar} a reader cannot move, minimise or close a
 * window that is migrating a database — which on a cold start is the whole of what they are
 * looking at. The gate is `AppShell`'s own, copied rather than reinvented: not on Android, where
 * the OS owns the frame, and not on the web, which never renders this component anyway.
 *
 * **Loading says nothing for its first {@link ACTIVITY_DELAY_MS}**, and the number is the
 * ribbon's on purpose. That constant is this app's answer to "how long must a wait run before it
 * deserves words", and a warm start usually settles inside it — so the common case is an empty
 * ground under a caption for a moment, then the app, rather than a mark and a sentence that
 * blink past before anyone can read them. It is a timer and not a CSS delay: the words are
 * *inserted* when it fires rather than faded in from invisible, so the live region below
 * announces them exactly when a sighted reader sees them, and a start too short to show is a
 * start too short to announce. No animation is involved, so reduced motion has nothing to opt
 * out of — except the mana line's sweep, which drops itself (`ManaLine`'s own rule).
 *
 * **The mana line is here because a cold start is long and a still screen reads as hung.** That
 * is the exact complaint this screen exists to answer — the window used to be "Not responding"
 * — and the indeterminate sweep is the app's one sanctioned way of saying "working, length
 * unknown". Nothing else on screen draws the line while this is up, which is the condition
 * `SyncProgress` states for drawing it off the ribbon.
 *
 * **A failure shows at once and is never delayed** — it is the end state, and hiding the only
 * account of why the app will not open behind a timer would be a blank window for no reason.
 */
export function StartupScreen({ status }: StartupScreenProps) {
  const failed = status.state === "failed" ? status : null;
  // `useDelayedFlag` drops the instant `loading` stops, so this is never true beside a failure.
  const talking = useDelayedFlag(status.state === "loading", ACTIVITY_DELAY_MS);

  return (
    <div
      className="flex h-dvh flex-col overflow-hidden bg-bg text-text"
      // `AppShell`'s three insets, for `AppShell`'s reason — on a phone the ground runs under the
      // status bar and the cut-out. An inline style because a mistyped arbitrary value emits no rule.
      style={{
        paddingTop: "var(--safe-t)",
        paddingLeft: "var(--safe-l)",
        paddingRight: "var(--safe-r)",
      }}
    >
      {!isAndroid() && !isWebTarget() && <TitleBar />}

      {/* `m-auto` on the column rather than `justify-center` on the scroller: a centred flex
          column that outgrows its box overflows off *both* ends, and the top end cannot be
          scrolled to — which on a short window would be the failure's heading. An auto margin
          centres while there is room and collapses to nothing when there is not. */}
      <main className="flex min-h-0 flex-1 overflow-y-auto px-8 py-10">
        <div className="m-auto flex w-full flex-col items-center gap-6 text-center">
          {(talking || failed) && (
            // `SyncProgress`'s lockup at `SyncProgress`'s size, so a first run that follows this
            // screen opens on the same emblem in the same gold. The mark is hidden from the accname
            // and so is the wordmark, for that component's reason: the caption already says the name.
            <div className="flex flex-col items-center gap-3">
              {/* Dim once nothing is starting: gold is the app alive, and a failure is the one
                state on this screen where it is not. */}
              <GrimoireMark size={64} className={failed ? "text-dim" : "text-accent"} />
              {!failed && (
                <p
                  aria-hidden="true"
                  className="font-heading text-xl leading-none tracking-[0.2em] text-dim"
                >
                  MTG Grimoire
                </p>
              )}
            </div>
          )}

          {failed && (
            <div className="w-full max-w-lg space-y-3">
              {/* Not "MTG Grimoire could not start": every message Rust writes here already opens
                  with "MTG Grimoire could not …", so the heading names the thing instead —
                  `WebBoot`'s "The card database would not open", one folder wider. */}
              <h1 className="font-heading text-2xl text-text">The data folder would not open</h1>
              {/* Verbatim. The native side wrote this for a reader — it names the folder and what
                to do about it — and it is multi-line, so `whitespace-pre-line` keeps its breaks.
                Left-aligned because a paragraph ragged on both edges is hard to follow, and
                `break-words` because a Windows path inside a sentence is one unbreakable word.
                An alert because it replaces a screen that was saying something else. */}
              <p
                role="alert"
                className="whitespace-pre-line break-words text-left text-sm leading-relaxed text-dim"
              >
                {failed.message}
              </p>
            </div>
          )}

          {/* **Mounted from the first frame and filled when the delay ends**, because a live
            region that arrives with its sentence already inside announces nothing. Kept mounted
            in the failed state too, empty, so the switch does not remount it. */}
          <div className={cn("w-full max-w-xs space-y-3", !talking && "sr-only")}>
            {talking && <ManaLine sync={{ label: STARTUP_LOADING_LABEL, value: null }} />}
            <p role="status" className="text-sm text-dim">
              {talking ? STARTUP_LOADING_LABEL : ""}
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}
