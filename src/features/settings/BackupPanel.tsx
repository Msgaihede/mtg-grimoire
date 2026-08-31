import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { open as pickFolder, save as pickSaveFile } from "@tauri-apps/plugin-dialog";
import { Download, FolderOpen, RefreshCw } from "lucide-react";
import { useId, useState, type JSX } from "react";
import { count } from "@/lib/counts";
import { ipc, ipcError, type BackupZip, type MirrorStatus, type PassReport } from "@/lib/ipc";
import { isAndroid } from "@/lib/platform";
import { ago } from "@/lib/relativeTime";
import { cn } from "@/lib/utils";
import { writeFailure } from "@/lib/writes";
import { isWebTarget } from "@/pwa/target";
import {
  bytesFromBase64,
  downloadFile,
  fileSize,
  suggestedArchiveName,
  ZIP_MIME,
} from "./backupArchive";
import { BUTTON, SWITCH, switchTone } from "./controls";
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
  if (report.skipped > 0) parts.push(`${count(report.skipped)} left alone (yours)`);
  if (report.pruned > 0) parts.push(`${count(report.pruned)} removed`);
  if (report.failed > 0) parts.push(`${count(report.failed)} could not be written`);
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
  if (at === null) return "Not run yet — press Rebuild now to write one.";
  const when = ago(at, nowMs);
  return status.lastReport === null
    ? `Last written ${when}.`
    : `Last written ${when} — ${passSummary(status.lastReport)}.`;
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
 * Does this build get the archive rather than the folder?
 *
 * **A folder or a zip, and the answer is a fact about the platform rather than a setting.** The
 * mirror writes ~350 files so that *other programs* can read them — a text editor, `grep`, a
 * sync client — and neither of the two targets here has a folder that serves that. OPFS is
 * invisible to every program but this one, and an Android app's private directory is the same in
 * practice: `tauri-plugin-dialog`'s own manifest records Android as having no folder picker, so
 * the root could not even be chosen. A folder nothing else can open would be the feature's name
 * without the feature.
 *
 * **Two probes and they are not interchangeable.** `isWebTarget()` is a build-time constant, so
 * the whole folder panel folds away in the web bundle; `isAndroid()` is a user-agent read,
 * because the Android build *is* the Tauri build and nothing at compile time tells them apart.
 * Desktop answers `false` to both, which is what keeps jsdom and Storybook on the folder shape
 * without either of them having to say so.
 */
function archiveOnly(): boolean {
  return isWebTarget() || isAndroid();
}

/**
 * The backup, in whichever of its two shapes this platform can actually deliver.
 *
 * A dispatch rather than a branch inside one component, because the two halves read different
 * backends: {@link FolderBackupPanel} polls `mirror_status` every five seconds and
 * {@link ArchiveBackupPanel} must never call it — that command is not routed on the web target
 * at all, and on Android it answers about a mirror whose thread never starts. A conditional
 * `useQuery` is not a thing React allows, so the condition goes above the hooks.
 */
export function BackupPanel(): JSX.Element {
  return archiveOnly() ? <ArchiveBackupPanel /> : <FolderBackupPanel />;
}

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
 *
 * **Desktop only, and {@link archiveOnly} is where that is decided.** All four of the commands
 * below — `mirror_status`, `mirror_set_enabled`, `mirror_set_root`, `mirror_rebuild` — are the
 * *folder*, and the other two targets have no folder to describe.
 */
export function FolderBackupPanel(): JSX.Element {
  const id = useId();
  const client = useQueryClient();
  /** The picker itself could not be opened — a different failure from a setting the backend
   *  refused, and cleared by the next press so it cannot outlive the news it is about. */
  const [pickerFailure, setPickerFailure] = useState<string | null>(null);
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
  const setRoot = useMutation({
    mutationFn: (root: string) => ipc.mirrorSetRoot(root),
    onSuccess: invalidate,
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

  /**
   * The native folder picker.
   *
   * **A cancelled picker is not a failure.** `open` answers `null` when the reader closed it
   * without choosing, which is the most ordinary way to use a file dialog after changing your
   * mind — `DeckCoverPicker`'s rule, and the same trap in the same shape.
   *
   * `defaultPath` is the folder the mirror is already using, so Change folder… opens *there*
   * rather than wherever the OS last left this process — a reader moving a backup is nearly
   * always moving it to somewhere beside where it is.
   */
  const choose = async () => {
    setPickerFailure(null);
    try {
      const chosen = await pickFolder({
        directory: true,
        multiple: false,
        title: "Choose the backup folder",
        defaultPath: status?.root,
      });
      if (chosen !== null) setRoot.mutate(chosen);
    } catch (e) {
      // Framed rather than passed through, `DeckCoverPicker`'s wording one picker over: what
      // comes back from a dialog that would not open is plumbing ("undefined is not an
      // object"), and a reader needs the half of the sentence that says which control failed.
      setPickerFailure(`Could not open the folder picker — ${ipcError(e)}`);
    }
  };

  // The picker first, then the writes' own rule (`@/lib/writes`): the most recently *started*
  // write owns the banner. A picker failure is not a write, so it is cleared by every press
  // rather than ranked against them — which is what keeps it from outliving the news it is
  // about.
  const refusal = pickerFailure ?? writeFailure([setEnabled, setRoot, rebuild]);
  const note = noteFor(refusal, rebuilt, status, read);

  return (
    <SettingsSection id="backup" title="Backup">
      <p className="text-sm text-dim">
        Your decks, collection and wishlist, written out as plain text files in every format this
        app can export — so that the day it will not start, the cards are still yours. The app
        never reads these files back; the database stays the record and this is a copy of it.
      </p>

      {status === null ? (
        <p className="text-sm text-dim">
          {read.isError ? "The backup setting could not be read." : "Reading the backup setting…"}
        </p>
      ) : (
        <>
          <div className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <p id={`${id}-mirror`} className="text-sm">
                Back up my cards as text files
              </p>
              <p className="mt-0.5 text-xs leading-snug text-dim">
                Kept up to date in the background, a couple of seconds after each change. Turning
                it off leaves the files that are already there.
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
              onClick={() => {
                setPickerFailure(null);
                setEnabled.mutate(!status.enabled);
              }}
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
              onClick={() => void choose()}
              disabled={busy}
              className={cn(BUTTON, "border-border hover:bg-bg disabled:hover:bg-transparent")}
            >
              <FolderOpen className="size-4" aria-hidden="true" />
              Change folder…
            </button>
          </div>
          <p className="text-xs text-dim">
            Moving it writes a fresh copy at the new folder and leaves the old one exactly where
            it is. Deleting a folder of your cards is not a setting&rsquo;s decision to make, and
            a file the backup did not write is never overwritten either.
          </p>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="min-w-0 text-sm text-dim">{lastPassLine(status)}</p>
            <button
              type="button"
              onClick={() => {
                setPickerFailure(null);
                // The previous pass's note goes with the press that supersedes it, so a second
                // rebuild that fails cannot be read under the first one's success.
                setRebuilt(null);
                rebuild.mutate();
              }}
              disabled={busy}
              aria-busy={rebuild.isPending || undefined}
              className={cn(BUTTON, "border-border hover:bg-bg disabled:hover:bg-transparent")}
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
    return { tone: "problem", text: `The last backup could not be written. ${status.lastError}` };
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

/**
 * What one finished archive says — `142 files, 1.4 MB`, and what went missing if anything did.
 *
 * **`failed` is said out loud and it is the one number here that could not be left off.** The
 * folder's rule is that a file which would not write is one file and the pass carries on; the
 * archive keeps that rule and cannot keep its consequence. A reader looking at a folder sees the
 * gap; a reader who has already mailed the zip to themselves does not, and will find out on the
 * day they open it — which is the day this feature exists for.
 */
export function archiveSummary(zip: BackupZip): string {
  const parts = [
    `${count(zip.files)} ${zip.files === 1 ? "file" : "files"}`,
    fileSize(zip.byteLength),
  ];
  if (zip.failed > 0) parts.push(`${count(zip.failed)} could not be read`);
  return parts.join(", ");
}

/**
 * The line the panel draws after a successful press, in the words of the door it went out of.
 *
 * **The two doors end differently and the sentence has to.** In a browser the file is named by
 * {@link BackupZip.fileName}, because that is the name the download was given; on Android the
 * reader typed the name themselves in the save dialog, so quoting Rust's suggestion back at them
 * would name a file that may not exist. Saying "Saved" and the numbers is the whole of what this
 * side truthfully knows there.
 */
export function madeLine(zip: BackupZip, android: boolean): string {
  return android
    ? `Saved — ${archiveSummary(zip)}.`
    : `Downloaded ${zip.fileName} — ${archiveSummary(zip)}.`;
}

/**
 * The backup as one archive, on the two platforms that cannot have the folder.
 *
 * **A snapshot, and the panel says so in those words.** The desktop mirror is continuously
 * written — a couple of seconds after each change, for ever — and this is a file taken at the
 * moment of a press. Calling both of them "backup" without saying which is which is how a reader
 * ends up trusting a zip from March.
 *
 * **Two doors, one button, and the difference never reaches the reader.** In a browser the bytes
 * come back as base64 and the page starts a download; on Android the reader names the
 * destination first — which is a `content://` row `ACTION_CREATE_DOCUMENT` has already created,
 * not a path — and Rust writes into it, so a megabyte of archive never crosses the webview at
 * all. Both end with a file the reader keeps.
 *
 * **No poll and no status query.** `mirror_status` describes a thread that is not running here,
 * and on the web target it is not even routed; the whole of what this panel knows is what the
 * last press answered.
 */
export function ArchiveBackupPanel(): JSX.Element {
  const android = isAndroid();
  /** The last archive this window produced. `null` again after every press, so a second one
   *  that fails cannot be read under the first one's success — `FolderBackupPanel`'s rule for
   *  {@link Rebuilt}. */
  const [made, setMade] = useState<BackupZip | null>(null);
  /** A picker that would not open. Not a write, so it is cleared by every press rather than
   *  ranked against them — which is what keeps it from outliving the news it is about. */
  const [pickerFailure, setPickerFailure] = useState<string | null>(null);

  const make = useMutation({
    mutationFn: async (): Promise<BackupZip | null> => {
      if (!android) {
        const zip = await ipc.mirrorBackupZip();
        // `base64` is `null` only when Rust wrote the file itself, which this door never asks
        // it to — so an absent one is the backend answering the wrong shape, and handing `atob`
        // a null would be a `TypeError` that reads as "the download silently did nothing".
        if (zip.base64 === null) throw new Error("the backup came back without its contents");
        downloadFile(bytesFromBase64(zip.base64), zip.fileName, ZIP_MIME);
        return zip;
      }
      // Android. `save()` answers `null` on Cancel and writing at *that* is the bug the guard
      // exists for — `ExportDialog`'s rule, one dialog over. Nothing is rendered either: the
      // archive is built by the command below, after the reader has said where it goes, so a
      // cancelled picker costs nothing at all.
      const path = await pickSaveFile({ defaultPath: suggestedArchiveName() });
      return path === null ? null : await ipc.mirrorBackupSave(path);
    },
    onSuccess: (zip) => setMade(zip),
  });

  // The picker first, then the write's own rule (`@/lib/writes`) — `FolderBackupPanel`'s
  // precedence with one fewer write to rank.
  const refusal = pickerFailure ?? writeFailure([make]);
  const note = archiveNote(refusal, made, android);

  return (
    <SettingsSection id="backup" title="Backup">
      <p className="text-sm text-dim">
        Your decks, collection and wishlist, written out as plain text files in every format this
        app can export — so that the day it will not start, the cards are still yours. The app
        never reads these files back; the database stays the record and this is a copy of it.
      </p>
      <p className="text-sm text-dim">
        Here it is one archive you ask for, rather than a folder kept up to date in the
        background. {android ? "An app's own folder on Android" : "A browser's own storage"} is
        not somewhere another program can open, so a folder kept there would be a backup nothing
        else could read. The desktop app writes the folder.
      </p>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="min-w-0 text-sm text-dim">
          {made === null
            ? "It is built when you ask for it, from the cards as they are right now."
            : "Ask again whenever you want a fresher copy."}
        </p>
        <button
          type="button"
          onClick={() => {
            setPickerFailure(null);
            setMade(null);
            make.mutate();
          }}
          disabled={make.isPending}
          aria-busy={make.isPending || undefined}
          className={cn(BUTTON, "border-border hover:bg-bg disabled:hover:bg-transparent")}
        >
          <Download
            aria-hidden="true"
            className={cn("size-4", make.isPending && "animate-pulse")}
          />
          {android ? "Save backup…" : "Download backup"}
        </button>
      </div>

      <PanelAlert tone={note?.tone ?? "plain"}>{note?.text ?? null}</PanelAlert>
    </SettingsSection>
  );
}

/**
 * The one thing the archive panel has to say, picked from two candidates.
 *
 * {@link noteFor}'s shape with two of its four cases gone: there is no background thread to
 * report a failure from and no polled read to fail, so a refusal and a finished archive are the
 * whole list. **An archive that could not read every list is a problem rather than an outcome**,
 * for the reason {@link BackupZip.failed} gives: the reader cannot see the gap in a file they
 * have already put away.
 */
function archiveNote(refusal: string | null, made: BackupZip | null, android: boolean): Note {
  if (refusal !== null) return { tone: "problem", text: refusal };
  if (made === null) return null;
  return { tone: made.failed > 0 ? "problem" : "plain", text: madeLine(made, android) };
}
