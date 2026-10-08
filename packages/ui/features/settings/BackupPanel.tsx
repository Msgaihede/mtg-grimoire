import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderOpen, RefreshCw } from "lucide-react";
import { useId, useState, type JSX } from "react";
import { count } from "@/lib/counts";
import { ipc, ipcError, type MirrorStatus, type PassReport } from "@/lib/ipc";
import { ago } from "@/lib/relativeTime";
import { cn } from "@/lib/utils";
import { writeFailure } from "@/lib/writes";
import { PANEL_BUTTON, SWITCH, switchTone } from "./controls";
import { FullBackupPanel } from "./FullBackupPanel";
import { PanelAlert, SettingsSection } from "./panelChrome";

/** The mirror's whole state, under one root — three writes invalidate it and nothing else
 *  reads it, so the key has no second level to grow into. */
export const MIRROR_KEY = ["mirror"];

/** `1 file` / `142 files`, with the thousands separator a four-figure pass needs.
 *
 *  Not `plural` from `@/lib/counts`: that one writes the number plainly and says so — every
 *  one of its callers counts cards or piles in a deck and none reaches four figures. A pass
 *  over fifty decks and a folder tree reaches four figures routinely, which is exactly the
 *  case its comment points at `count` for. */
const files = (n: number): string => `${count(n)} ${n === 1 ? "file" : "files"}`;

/**
 * What one pass did, in one line — `142 files written, 208 unchanged`.
 *
 * **Both numbers, always, and the second is the one that says the design is working.** A pass
 * that wrote nothing because nothing had changed and a pass that wrote nothing because it could
 * not are the same sentence with `written` alone; `unchanged` is what tells them apart at a
 * glance.
 *
 * `skipped`, `pruned` and `failed` are said only when they are not zero, which is the rule
 * {@link CacheCleared}'s panel already follows: a line ending "0 removed, 0 could not be
 * written" every day trains a reader to stop reading the line on the day it matters.
 *
 * **"left alone" is the reader's own file, and it needs the words rather than a number.** It is
 * a `README.txt` that was in the folder before the mirror was pointed at it: the pass will not
 * overwrite a file no manifest of ours has ever named, so the one thing the folder is missing
 * is the one thing this line has to be able to explain.
 */
export function passSummary(report: PassReport): string {
  const parts = [`${files(report.written)} written`, `${count(report.unchanged)} unchanged`];
  if (report.skipped > 0) parts.push(`${count(report.skipped)} skipped (not created by the app)`);
  if (report.pruned > 0) parts.push(`${count(report.pruned)} removed`);
  if (report.failed > 0) parts.push(`${count(report.failed)} couldn't be written`);
  return parts.join(", ");
}

/**
 * When the backend's recorded pass ran, in unix seconds — or `null` when there has not been one.
 *
 * **The only clock this panel gets**, which is why it is a function of its own rather than two
 * lines inside {@link lastPassLine}: it is also what ranks a background failure against a
 * rebuild this window watched finish (see {@link errorOutranks}), and a second reading of the
 * same field would let the sentence and the precedence disagree about which pass is newer.
 *
 * Three values collapse into `null` and it matters that they do: no pass has finished, the
 * stamp will not parse, and the stamp is not a time. **`Number("")` is `0`, not `NaN`** — and
 * so is `Number("  ")` — so a blank row would otherwise sail past a finiteness check and print
 * `Last written 20,600 days ago`. Nothing this app has ever written happened in 1970.
 */
function passRanAt(status: MirrorStatus): number | null {
  const at = status.lastRunAt === null ? Number.NaN : Number(status.lastRunAt.trim());
  return Number.isFinite(at) && at > 0 ? at : null;
}

/**
 * When the mirror last wrote, and how it went.
 *
 * **`null` gets a sentence of its own rather than the report's zeroes.** `lastRunAt` is `null`
 * until a pass has *finished this session*, and drawing `0 files written` there would claim a
 * pass had happened and produced nothing — which is indistinguishable, on the face of it, from
 * a mirror that is already complete. So the panel says it has not run and says what to press.
 *
 * A stamp that will not parse takes the same arm, and that is the settings module's own rule
 * arriving here: a value this build cannot read is a fact about storage rather than a number to
 * print. {@link passRanAt} is where the three ways to `null` are collapsed.
 *
 * @param nowMs the clock in **milliseconds**, which is what {@link ago} takes. A **default
 * parameter** rather than a `Date.now()` in the panel body, which is `ErrorLogPanel`'s
 * `formatWhen` and `useMarketplace`'s `nowSeconds` arriving at the same shape: "2 hours ago" is
 * a fact about the render and deliberately not state — nothing here repaints when a minute
 * passes, and a settings panel on a timer would be motion without information.
 */
export function lastPassLine(status: MirrorStatus, nowMs: number = Date.now()): string {
  const at = passRanAt(status);
  if (at === null) return "Not run yet. Click Rebuild now to create one.";
  const when = ago(at, nowMs);
  return status.lastReport === null
    ? `Last backup ${when}.`
    : `Last backup ${when} — ${passSummary(status.lastReport)}.`;
}

/** The panel's one line of news, and how loudly it says it. */
type Note = { tone: "problem" | "plain"; text: string } | null;

/**
 * A pass this window watched finish, with the moment it did.
 *
 * **The time is the whole reason this is a record rather than `rebuild.data`.** A TanStack
 * mutation is `isSuccess` for the life of the component, so its result carries no sense of
 * having been superseded — and the panel has to be able to tell a rebuild that answered the
 * mirror's last failure from one that happened *before* the failure now being reported.
 * Unix seconds, because {@link MirrorStatus.lastRunAt} is the only clock the backend offers
 * and the two have to be comparable.
 */
type Rebuilt = { report: PassReport; at: number };

/**
 * The plain-text mirror: whether it runs, where it writes, and how the last pass went.
 *
 * **This panel reaches the backend itself, where its five neighbours take their state as a
 * prop, and the difference is that nothing else in the window reads `mirror_status`.** That is
 * `ErrorLogPanel`'s argument arrived at from one step further along: the page hooks up the
 * readers with no second caller to race, and this one has no second caller *and* no other
 * surface — the mirror is a background thread with no ribbon button and no view of its own — so
 * threading it down from `SettingsPage` would buy a prop and nothing else.
 *
 * **Four states, and the two absences are the ones worth getting right.** A read still in
 * flight draws no controls, because a switch drawn before its value has landed is a switch that
 * flips under the reader's eye. A pass that has never run says so rather than drawing its
 * report's zeroes — see {@link lastPassLine}.
 *
 * **A failed pass is news, not an alarm, and it blocks nothing.** An unplugged stick or a
 * revoked permission costs the reader a folder of text files and costs the database nothing: no
 * write ever waits on a mirror write, and no mirror failure is ever raised as a dialog. So the
 * sentence lives in this panel, in the destructive red its neighbours use for a refusal, and
 * the next pass tries again on its own.
 */
export function BackupPanel(): JSX.Element {
  const id = useId();
  const client = useQueryClient();
  /** The last rebuild this window watched finish. Held here rather than read off the mutation
   *  so that it carries a *time* — see {@link Rebuilt} and {@link errorOutranks}. */
  const [rebuilt, setRebuilt] = useState<Rebuilt | null>(null);

  /**
   * **The one panel here describing a *background* thread is the one that has to poll.** Its
   * five neighbours read state only this window changes, so an invalidation after each write is
   * the whole story; the mirror's pass runs on a thread nothing in the page can hear from. A
   * panel opened during the ~3 s startup pass said "Not run yet — press Rebuild now to write
   * one." and kept saying it until the query happened to remount.
   *
   * 5 s rather than anything faster: `DEBOUNCE` is 2 s and a measured pass is ~0.3 s, so the
   * longest a finished pass stays unreported is about one debounce plus one interval — and the
   * poll is one `app_meta` read and a clone of an in-memory record, taken only while this panel
   * is on screen.
   */
  const read = useQuery({
    queryKey: MIRROR_KEY,
    queryFn: () => ipc.mirrorStatus(),
    refetchInterval: 5_000,
  });
  const status = read.data ?? null;

  const invalidate = () => void client.invalidateQueries({ queryKey: MIRROR_KEY });
  const setEnabled = useMutation({
    mutationFn: (on: boolean) => ipc.mirrorSetEnabled(on),
    onSuccess: invalidate,
  });
  /**
   * **Change folder…, and the folder picker is the backend's rather than this panel's** (issue
   * #545). `mirror_pick_root` opens the OS picker at the folder the mirror already uses — a reader
   * moving a backup is nearly always moving it to somewhere beside where it is — and saves what
   * it answered, so no path crosses IPC and nothing on this side could aim the mirror's writes
   * at a folder. `false` is a cancelled picker, which is not a failure and changes nothing, so
   * there is nothing to re-read.
   *
   * **A picker that would not open is one more refusal in the backend's own words** — "The folder
   * picker could not be opened — …" — and joins the writes' banner below rather than a line of
   * its own. It used to be framed here, because what `open()` handed back was plumbing; the
   * sentence names the control now, and it is `mirror_pick_root` refusing like any other write.
   */
  const setRoot = useMutation({
    mutationFn: () => ipc.mirrorPickRoot(),
    onSuccess: (moved) => {
      if (moved) invalidate();
    },
  });
  const rebuild = useMutation({
    mutationFn: () => ipc.mirrorRebuild(),
    onSuccess: (report) => {
      // Stamped here, at the moment the pass answered, and not from `submittedAt`: a pass over
      // a large collection takes a measurable fraction of a second, and what has to be ranked
      // against the backend's `lastRunAt` is when the folder was last correct — not when
      // somebody pressed a button.
      setRebuilt({ report, at: Math.floor(Date.now() / 1000) });
      invalidate();
    },
  });
  const busy = setEnabled.isPending || setRoot.isPending || rebuild.isPending;

  // The writes' own rule (`@/lib/writes`): the most recently *started* write owns the banner —
  // and Change folder… is one of them, picker and all.
  const refusal = writeFailure([setEnabled, setRoot, rebuild]);
  const note = noteFor(refusal, rebuilt, status, read);

  return (
    <SettingsSection id="backup" title="Backup">
      <FullBackupPanel />
      <h3 className="border-t border-border pt-4 text-sm font-medium">Automatic text files</h3>
      <p className="text-sm text-dim">
        Saves your decks, collection and wishlist as text files. These are for backup only and
        can&rsquo;t be imported back.
      </p>

      {status === null ? (
        <p className="text-sm text-dim">
          {read.isError ? "Couldn't load backup settings." : "Loading…"}
        </p>
      ) : (
        <>
          <div className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <p id={`${id}-mirror`} className="text-sm">
                Back up my cards as text files
              </p>
              <p className="mt-0.5 text-xs leading-snug text-dim">
                Updates automatically a few seconds after each change. Turning this off keeps
                existing files.
              </p>
            </div>
            {/* Named by the heading beside it *and* by its own word, in that order — an
                `aria-label` would replace the visible "On" with something that does not contain
                it, which is the WCAG 2.5.3 failure a control labelled by its own text avoids. */}
            <button
              type="button"
              role="switch"
              aria-checked={status.enabled}
              aria-labelledby={`${id}-mirror ${id}-mirror-state`}
              disabled={busy}
              onClick={() => setEnabled.mutate(!status.enabled)}
              className={cn(SWITCH, switchTone(status.enabled))}
            >
              <span id={`${id}-mirror-state`}>{status.enabled ? "On" : "Off"}</span>
            </button>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm">Folder</p>
              {/* A path is data, and data is Geist Mono — the role prices, versions and
                  collector numbers already carry in this window. `break-all` because a path is
                  one unbreakable word to a browser and the settings column is 42rem wide. */}
              <span className="mt-0.5 block break-all font-mono text-xs text-dim">
                {status.root}
              </span>
            </div>
            <button
              type="button"
              onClick={() => setRoot.mutate()}
              disabled={busy}
              className={cn(PANEL_BUTTON, "border-border hover:bg-bg disabled:hover:bg-transparent")}
            >
              <FolderOpen className="size-4" aria-hidden="true" />
              Change folder…
            </button>
          </div>
          <p className="text-xs text-dim">
            Backups are copied to the new folder. The old folder isn&rsquo;t changed.
          </p>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="min-w-0 text-sm text-dim">{lastPassLine(status)}</p>
            <button
              type="button"
              onClick={() => {
                // The previous pass's note goes with the press that supersedes it, so a second
                // rebuild that fails cannot be read under the first one's success.
                setRebuilt(null);
                rebuild.mutate();
              }}
              disabled={busy}
              aria-busy={rebuild.isPending || undefined}
              className={cn(PANEL_BUTTON, "border-border hover:bg-bg disabled:hover:bg-transparent")}
            >
              <RefreshCw
                aria-hidden="true"
                className={cn("size-4", rebuild.isPending && "animate-spin")}
              />
              Rebuild now
            </button>
          </div>
        </>
      )}

      <PanelAlert tone={note?.tone ?? "plain"}>{note?.text ?? null}</PanelAlert>
    </SettingsSection>
  );
}

/**
 * Whether the failure the backend is reporting is newer than the rebuild this window watched.
 *
 * **The whole of the precedence decision, in one predicate**, and it is a decision rather than
 * an ordering that fell out of the code. `MirrorStatus.lastError` describes the pass at
 * `lastRunAt`; a {@link Rebuilt} describes a pass that finished at its own `at`. So "which is
 * newer" is knowable from what the backend already returns, and the two cases are genuinely
 * different news:
 *
 * * **The error is the newer pass** — a background pass has failed *since* the rebuild, so the
 *   mirror is broken now. That outranks a success from before it, and saying otherwise would
 *   make this panel silent about the one thing it exists to report.
 * * **The rebuild is newer** — the reader has fixed whatever it was (plugged the stick back in,
 *   moved the folder) and pressed the button, and it worked. The recorded error is about a pass
 *   that has since been superseded, so reporting it would be telling them their repair did not
 *   take.
 *
 * A tie goes to the **error**, and an error whose pass carries no readable time is treated as
 * current: when the clock cannot settle it, the conservative answer is the one that says
 * something is wrong.
 *
 * This is what a naive `rebuild.isSuccess` ranking could not express. A TanStack mutation stays
 * `isSuccess` for the life of the component, so one successful press would have hidden **every**
 * later failure until the reader navigated away — the panel showing a stale "Rebuilt — 350 files
 * written" while the mirror was quietly failing.
 */
function errorOutranks(status: MirrorStatus, rebuilt: Rebuilt | null): boolean {
  if (rebuilt === null) return true;
  const at = passRanAt(status);
  return at === null || at >= rebuilt.at;
}

/**
 * The one thing the panel has to say, picked from four candidates.
 *
 * In order of how new the news is: a refusal the reader just earned, the mirror's current
 * recorded failure, the rebuild they pressed, and the read that would not answer. Only one line
 * is drawn, so this is a precedence rather than a list — and it is the same most-recent-news
 * rule `@/lib/writes` applies within a set of writes, extended over the three things on this
 * panel that are not writes.
 *
 * **The middle two are ranked by clock rather than by position**, which is {@link errorOutranks}
 * and is the fix for a real defect: with the rebuild ranked above the error unconditionally, one
 * successful press silenced the panel for the rest of the session.
 *
 * **A rebuild that could not write every file is a problem rather than an outcome**, which is
 * why that tone is read off `failed` instead of off success: `mirror_rebuild` answers `Ok` for
 * a pass that ran, and a pass that ran and dropped 350 files is not good news drawn in grey.
 */
function noteFor(
  refusal: string | null,
  rebuilt: Rebuilt | null,
  status: MirrorStatus | null,
  read: { isError: boolean; error: unknown },
): Note {
  if (refusal !== null) return { tone: "problem", text: refusal };
  if (status?.lastError && errorOutranks(status, rebuilt)) {
    return { tone: "problem", text: `Couldn't write the last backup. ${status.lastError}` };
  }
  if (rebuilt) {
    return {
      tone: rebuilt.report.failed > 0 ? "problem" : "plain",
      text: `Rebuilt — ${passSummary(rebuilt.report)}.`,
    };
  }
  if (status === null && read.isError) return { tone: "problem", text: ipcError(read.error) };
  return null;
}
