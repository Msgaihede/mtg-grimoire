import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderOpen, RefreshCw } from "lucide-react";
import { useId, useState, type JSX } from "react";
import { ipc, ipcError, type TabletopStatus } from "@/lib/ipc";
import { ago } from "@/lib/relativeTime";
import { cn } from "@/lib/utils";
import { writeFailure } from "@/lib/writes";
import { errorOutranks, passRanAt, passSummary, type Rebuilt } from "./BackupPanel";
import { PANEL_BUTTON, SWITCH, switchTone } from "./controls";
import { PanelAlert, SettingsSection } from "./panelChrome";

/** The integration's whole state, under one root — `MIRROR_KEY`'s shape and its reason: three
 *  writes invalidate it and nothing else reads it. `crossWindow.ts` follows it live, because its
 *  two stored rows are `app_meta` another window's Settings can write. */
export const TABLETOP_KEY = ["tabletop"];

/**
 * When the integration last wrote, and how it went — `BackupPanel`'s `lastPassLine` with the
 * integration's words.
 *
 * **`null` is its own sentence, for the mirror's reason**: `lastRunAt` is `null` until a pass has
 * finished *this session*, and `0 files written` there would claim a pass that wrote nothing.
 * Unlike the mirror's line it does not say to press Rebuild now: the integration is off by
 * default, and a reader who has not switched it on has not asked for any saves.
 *
 * @param nowMs the clock in milliseconds, a default parameter for `lastPassLine`'s reason.
 */
export function tabletopPassLine(status: TabletopStatus, nowMs: number = Date.now()): string {
  const at = passRanAt(status);
  if (at === null) return "Not run yet.";
  const when = ago(at, nowMs);
  return status.lastReport === null
    ? `Last updated ${when}.`
    : `Last updated ${when} — ${passSummary(status.lastReport)}.`;
}

/**
 * What to say about Tabletop Simulator's own `Saves` folder, or `null` when it is where it should
 * be.
 *
 * **Not found is not a failure, and it is drawn in the plain tone.** It is the state of every
 * reader who has not installed Tabletop Simulator, or never started it, or keeps their saves on
 * another drive — and a pass will not make TTS's folder for them (`tabletop/run.rs`: a folder
 * made for a program nobody installed would be litter). So the sentence says what was looked for
 * and what to press, and the switch stays usable: a reader may turn it on before installing.
 */
export function savesNote(status: TabletopStatus): string | null {
  if (status.savesFound) return null;
  return status.savesFolder === null
    ? "Tabletop Simulator's saves folder couldn't be found. Choose it with Change folder…"
    : `Tabletop Simulator's saves folder wasn't found at ${status.savesFolder}. ` +
        "If your saves are somewhere else, choose that folder with Change folder…";
}

/** The panel's one line of news, and how loudly it says it — `BackupPanel`'s `Note`. */
type Note = { tone: "problem" | "plain"; text: string } | null;

/**
 * The Tabletop Simulator integration (issue #1038): whether it runs, where it writes, and how the
 * last pass went. Desktop only — `edition.ts` keeps it off the light edition's page.
 *
 * **`BackupPanel`'s "Automatic text files" half, one program over, and deliberately the same
 * shape**: the same switch, folder row, last-pass line, Rebuild now and one line of news, ranked
 * by the same clock (`errorOutranks`). Both describe a background thread that writes files after
 * every change, and a reader who has learned one has learned the other.
 *
 * **What differs is the folder and the default.** The mirror writes into a folder this app
 * chose; this writes an `MTG Grimoire` folder into Tabletop Simulator's own `Saves`, which may not
 * exist ({@link savesNote}). And it is **off** until switched on, where the mirror is on: a
 * backup nobody remembered to enable is missing on the day it is needed, while saves written
 * into another program's folder are something a reader should ask for.
 */
export function TabletopPanel(): JSX.Element {
  const id = useId();
  const client = useQueryClient();
  /** The last rebuild this window watched finish, with its time — `BackupPanel`'s `rebuilt`. */
  const [rebuilt, setRebuilt] = useState<Rebuilt | null>(null);

  /** Polled for `BackupPanel`'s reason: the pass runs on a thread the page cannot hear from, and
   *  switching on starts one within a tick. Taken only while this panel is on screen. */
  const read = useQuery({
    queryKey: TABLETOP_KEY,
    queryFn: () => ipc.tabletopStatus(),
    refetchInterval: 5_000,
  });
  const status = read.data ?? null;

  const invalidate = () => void client.invalidateQueries({ queryKey: TABLETOP_KEY });
  const setEnabled = useMutation({
    mutationFn: (on: boolean) => ipc.tabletopSetEnabled(on),
    onSuccess: invalidate,
  });
  /** Change folder…: Rust opens the picker and saves the answer, so no path crosses IPC (issue
   *  #545's rule). `false` is Cancel, which changes nothing and needs no re-read. */
  const pickFolder = useMutation({
    mutationFn: () => ipc.tabletopPickFolder(),
    onSuccess: (moved) => {
      if (moved) invalidate();
    },
  });
  const rebuild = useMutation({
    mutationFn: () => ipc.tabletopRebuild(),
    onSuccess: (report) => {
      // Stamped when the pass answered, for `BackupPanel`'s reason: it is ranked against the
      // backend's `lastRunAt`, which is when the folder was last right.
      setRebuilt({ report, at: Math.floor(Date.now() / 1000) });
      invalidate();
    },
  });
  /** Store card images on this computer — an `app_meta` write like the switch above it. */
  const setLocalImages = useMutation({
    mutationFn: (on: boolean) => ipc.tabletopSetLocalImages(on),
    onSuccess: invalidate,
  });
  const busy =
    setEnabled.isPending || setLocalImages.isPending || pickFolder.isPending || rebuild.isPending;

  const refusal = writeFailure([setEnabled, setLocalImages, pickFolder, rebuild]);
  const note = noteFor(refusal, rebuilt, status, read);
  const missing = status === null ? null : savesNote(status);

  return (
    <SettingsSection id="tabletop" title="Tabletop Simulator">
      <p className="text-sm text-dim">
        Saves each of your decks as a Tabletop Simulator save in an &ldquo;MTG Grimoire&rdquo;
        folder in your Tabletop Simulator saves. In Tabletop Simulator, find them under Games &rarr;
        Save &amp; Load. A deck with a theory list gets a folder with both versions.
      </p>

      {status === null ? (
        <p className="text-sm text-dim">
          {read.isError ? "Couldn't load Tabletop Simulator settings." : "Loading…"}
        </p>
      ) : (
        <>
          <div className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <p id={`${id}-tabletop`} className="text-sm">
                Save my decks for Tabletop Simulator
              </p>
              <p className="mt-0.5 text-xs leading-snug text-dim">
                Updates automatically a few seconds after each change. Turning this off keeps
                existing saves.
              </p>
            </div>
            {/* Named by the line beside it and its own word, `BackupPanel`'s switch exactly. */}
            <button
              type="button"
              role="switch"
              aria-checked={status.enabled}
              aria-labelledby={`${id}-tabletop ${id}-tabletop-state`}
              disabled={busy}
              onClick={() => setEnabled.mutate(!status.enabled)}
              className={cn(SWITCH, switchTone(status.enabled))}
            >
              <span id={`${id}-tabletop-state`}>{status.enabled ? "On" : "Off"}</span>
            </button>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm">Folder</p>
              {/* A path is data, so Geist Mono; `break-all` because a path has nothing to break
                  at — `BackupPanel`'s folder row. */}
              <span className="mt-0.5 block break-all font-mono text-xs text-dim">
                {status.folder ?? "Not found"}
              </span>
            </div>
            <button
              type="button"
              onClick={() => pickFolder.mutate()}
              disabled={busy}
              className={cn(
                PANEL_BUTTON,
                "border-border hover:bg-bg disabled:hover:bg-transparent",
              )}
            >
              <FolderOpen className="size-4" aria-hidden="true" />
              Change folder…
            </button>
          </div>
          {missing !== null && <p className="break-words text-xs text-text">{missing}</p>}

          <div className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <p id={`${id}-images`} className="text-sm">
                Store card images on this computer
              </p>
              <p className="mt-0.5 text-xs leading-snug text-dim">
                Tabletop Simulator loads card images from Scryfall. If cards show up blank, turn
                this on and the app downloads the images into the MTG Grimoire folder instead. Other
                players at your table won&rsquo;t see images stored on your computer.
              </p>
            </div>
            {/* **Disabled rather than hidden while the integration is off**: the choice is still
                worth reading before switching on, and a control that appears on a press moves
                the rows below it under the reader's pointer. */}
            <button
              type="button"
              role="switch"
              aria-checked={status.localImages}
              aria-labelledby={`${id}-images ${id}-images-state`}
              disabled={busy || !status.enabled}
              onClick={() => setLocalImages.mutate(!status.localImages)}
              className={cn(SWITCH, switchTone(status.localImages))}
            >
              <span id={`${id}-images-state`}>{status.localImages ? "On" : "Off"}</span>
            </button>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="min-w-0 text-sm text-dim">{tabletopPassLine(status)}</p>
            <button
              type="button"
              onClick={() => {
                // The previous pass's note goes with the press that supersedes it.
                setRebuilt(null);
                rebuild.mutate();
              }}
              disabled={busy}
              aria-busy={rebuild.isPending || undefined}
              className={cn(
                PANEL_BUTTON,
                "border-border hover:bg-bg disabled:hover:bg-transparent",
              )}
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
 * The one thing the panel has to say — `BackupPanel`'s `noteFor`, in the same order: a refusal
 * the reader just earned, the integration's current recorded failure (ranked against the rebuild
 * by clock, `errorOutranks`), the rebuild they pressed, and the read that would not answer.
 */
function noteFor(
  refusal: string | null,
  rebuilt: Rebuilt | null,
  status: TabletopStatus | null,
  read: { isError: boolean; error: unknown },
): Note {
  if (refusal !== null) return { tone: "problem", text: refusal };
  if (status?.lastError && errorOutranks(status, rebuilt)) {
    return {
      tone: "problem",
      text: `Couldn't write the Tabletop Simulator saves. ${status.lastError}`,
    };
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
