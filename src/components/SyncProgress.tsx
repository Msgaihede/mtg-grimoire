import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { GrimoireMark } from "@/components/GrimoireMark";
import { ManaLine } from "@/components/ManaLine";
import { syncActivity } from "@/lib/activity";
import type { SyncProgressEvent } from "@/lib/ipc";
import { LAYER } from "@/lib/layers";
import { scrim } from "@/lib/motion";
import { cn } from "@/lib/utils";
import type { CorpusState } from "@/pwa/corpusMark";

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
  /**
   * Why the database is empty - `"never-built"` on a genuine first run, `"evicted"` when this
   * browser has had a corpus and no longer does (spec 5.4: Cache Storage and OPFS are evicted
   * independently, so "shell loaded, corpus gone" is a real state). Desktop always passes
   * `"never-built"`: a file on disk does not vanish while the app around it stays.
   */
  reason: CorpusState;
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
export function SyncProgress({
  progress,
  cardCount,
  error,
  busy,
  onRetry,
  reason,
}: SyncProgressProps) {
  const takingOver = cardCount === 0 && progress?.phase !== "done";
  return (
    <AnimatePresence>
      {takingOver && (
        <FirstRun
          key="first-run"
          progress={progress}
          error={error}
          busy={busy}
          onRetry={onRetry}
          reason={reason}
        />
      )}
    </AnimatePresence>
  );
}

/**
 * First launch: 77 MB to download and ~117 k rows to import, with nothing usable behind
 * it. Taking the screen is honest about that — the alternative is an empty app that looks
 * broken. It is also the first thing anyone ever sees of this app, which is why it opens
 * with the mark drawn at full size over the name and then says, in one sentence, what the
 * wait buys — and why it is the one surface that draws the mark large enough to be read as
 * artwork rather than as a glyph.
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
function FirstRun({
  progress,
  error,
  busy,
  onRetry,
  reason,
}: Omit<SyncProgressProps, "cardCount">) {
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
      {/* **The mark and the name are one object, so they are one box.** The page's `gap-6` is
          the distance between the *things on this screen* — the lockup, the heading block, the
          line, the button — and 24px between a mark and the name printed directly under it
          would read as two unrelated objects that happen to be stacked rather than as one
          signature. Nesting is what buys the pairing distance without touching the page's
          rhythm: the column outside keeps its 24, the lockup keeps its own 12. Nothing in here
          animates on its own — both are static children of the surface's own fade, which is
          all the motion this screen has. */}
      <div className="flex flex-col items-center gap-3">
        {/* **64px, and this is the only surface in the app that earns it.** The mark picks its
            variant off the size it is drawn at, because below about 24px the casting circle
            and the clasp rivets fill in — so the small copy in the title bar is a silhouette,
            and everything the artwork actually says is drawn nowhere. Here there is a whole
            screen with four things on it: at 64px the dashed casting circle, the seven runes
            and the gradient burning through the diamond all resolve, which is the entire
            reason the full variant exists. The first thing anyone ever sees of this app is the
            one place the mark should be seen whole.

            **Gold, and that is not a contradiction of the `text-dim` on the name below.** That
            rule — "gold means 'you can act on this', and a name is not an action" — is about
            *type and controls*, where the accent is this app's one signal that a thing answers
            a press, and a heading painted in it is a button that never does. A mark is a
            picture rather than a word: nothing about it invites a press, and it is the app's
            own colour on the app's own emblem. The name stays dim underneath, so the pair
            reads as an emblem over its caption instead of two things competing to be loudest.

            **Its fills are `var(--color-surface)` and this screen is `bg-bg`, so one drawing
            gives two pictures on two grounds.** In the title bar, over `bg-surface`, the boards
            fill with the ground they sit on and the mark is pure line art. Here they fill one
            step *above* the ground, so the book reads as a faint raised plate with the gold
            drawn over it — the depth this screen has the room for, out of the token the logo
            package already specified, with no branch in `GrimoireMark` and no second file.

            **No `label`, so it stays out of the accessibility tree** — which is `GrimoireMark`'s
            own default and this is the case it was chosen for. The name below is `aria-hidden`
            for the reason given there, and both reasons still hold here: the window title bar
            says the name in full, and this dialog is named by `#first-run-title`. A mark that
            named itself would put the product name into the tree twice in a row, once as a
            graphic and once beside the heading. */}
        <GrimoireMark size={64} className="text-accent" />

        {/* The name in full, and one of the *two* places it is set in type rather than the
            only one — `TitleBar` says it at 13px a row above every other screen, and this is
            the one with room. **Both halves of what stood here had rotted**: it read "the only
            place in the app it is set in type — the ribbon shows the mark alone", and the
            ribbon's dim `MTG` was deleted on 2026-08-20 while `decorations: false` had already
            handed the wordmark to `TitleBar` before that. A prose-only edit routes to neither
            CI job, so nothing went red for either. Deliberately the ribbon's own
            treatment (`font-heading text-xl leading-none text-dim`, clear of Cinzel's 18px
            floor) with letterspacing for the one thing that differs: this is a wordmark rather
            than the first step of app › view. **The pairing is the point, so this size follows
            the ribbon's**: it went 18 → 20px with it on 2026-08-14, and a reader who watches
            this screen fill finds the same treatment in the ribbon a second later. Dim rather
            than gold — gold means "you can act on this", and a name is not an action. Hidden
            from the accname for the ribbon mark's reason: the window title bar already says it,
            and the dialog is named by the heading below. */}
        <p
          aria-hidden="true"
          className="font-heading text-xl leading-none tracking-[0.2em] text-dim"
        >
          MTG Grimoire
        </p>
      </div>

      <div className="max-w-md space-y-2">
        {/* **The heading and the sentence under it, and nothing else on this screen**, because
            nothing else about the situation is different: there is no card data, and the way
            out is the same download. What differs is what the reader is owed as an explanation.
            A reader who has used this app for a month must not be told this is their first run.

            **The eviction sentence stops short of promising the collection is safe, and that is
            deliberate.** `collection_entries`, `decks` and the rest live in the same SQLite file
            as `cards`, so an OPFS eviction takes them too — the promise only becomes true once
            sync exists and a paired device can restore the user tables (PR 7). Until then this
            says what it can stand behind and no more. */}
        <h2 id="first-run-title" className="font-heading text-2xl text-text">
          {reason === "evicted" ? "Your card data was cleared" : "Setting up your card database"}
        </h2>
        <p className="text-sm text-dim">
          {reason === "evicted"
            ? "This browser removed the card database to free up space. It has to be downloaded again."
            : "Downloading every Magic card from Scryfall. This happens once and takes a few minutes — after that the app works offline."}
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
