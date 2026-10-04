/**
 * **What a host answers about storage it does not own** — the commands, and the shape of each
 * answer (the light-app spec §6: "The corpus can vanish while the shell survives…
 * `navigator.storage.persist()` is asked once and its answer recorded, not trusted").
 *
 * A desktop and a phone keep their databases in a folder that is theirs. A browser lends its
 * storage and may take it back: it can clear what a site has kept while the page that kept it is
 * still installed and still opens. So the web host answers these three, **on the page, without
 * reaching the engine** — as it answers `startup_status` (`./web/index.ts`) — and no other host
 * answers them at all: the desktop's IPC and the engine's command table both refuse a name they
 * do not have, in words.
 *
 * **That refusal is the whole of how a page stays ignorant of where it runs.** A component asks,
 * and draws only if a host answered; a host without the command is nothing to draw. It is
 * `light_downloads`' arrangement (`mobile/DownloadsPrompt.tsx`), and the reason this file is
 * plain names and shapes with no host in it — it is read by the page and by the web host alike.
 */
import type { Core } from "./types";

/**
 * Asks whether the host found its storage cleared. Answers {@link StorageCleared}, or `null`
 * when there is nothing to say — which is the answer nearly always.
 */
export const STORAGE_CLEARED = "storage_cleared";

/** Says the reader has read {@link STORAGE_CLEARED}'s answer. Takes nothing, answers `null`. */
export const STORAGE_CLEARED_DISMISS = "storage_cleared_dismiss";

/**
 * Asks whether the host's storage is being kept, as far as the host was told. Answers
 * {@link StoragePersistence} — **the record as it stands** — or `null` where nothing has been
 * recorded: a host with no way to ask, or one whose database never opened.
 *
 * It waits for the launch to have looked (the host reads what its storage says, and decides
 * whether this is a launch that asks), and **never for a reader**: on a host that asks by
 * prompting, an ask still unanswered reads as asked just now and not granted.
 */
export const STORAGE_PERSISTENCE = "storage_persistence";

/**
 * Whether the reader's database is kept in storage that is **lent** to this host — storage
 * somebody other than the app can clear while the app still opens.
 *
 * **Answered by whether the host answers {@link STORAGE_PERSISTENCE} at all**, and not by what it
 * says: a browser that granted persistence, one that refused and one with no way to ask (the
 * `null`) are all the same kind of host, because a reader who clears a site's data clears it
 * whatever the browser promised about evicting it. A host that owns its folder refuses the name,
 * which is this file's whole arrangement, and that refusal is the `false`.
 *
 * It is the one question here with a second reader. `mobile/StorageNotice.tsx` speaks *after*
 * the storage has gone; the Sync panel asks this *before*, because what goes with a paired
 * browser's storage is its place in the group — a device identity the reader's other devices go
 * on counting until one of them removes it (the light-app spec §7: "Clearing site data mints a
 * new device and spends a slot. The panel says so before a reader presses anything that would").
 *
 * Takes the `Core` to ask rather than importing one: this file is plain names and shapes with no
 * host in it, and stays that way.
 */
export function storageIsLent(core: Pick<Core, "call">): Promise<boolean> {
  return core.call<StoragePersistence | null>(STORAGE_PERSISTENCE).then(
    () => true,
    () => false,
  );
}

/**
 * One occurrence of the host's storage having been cleared under the app, **in the host's own
 * words** — as a startup failure is (`StartupStatus.message`). The sentences are about a kind of
 * host, so they belong to the host that can be that kind; the page draws what it is handed.
 *
 * An occurrence stays the answer until it is dismissed, across reloads, and is then never the
 * answer again. A later clearing is a new occurrence.
 */
export interface StorageCleared {
  /** Unix **milliseconds**: when the host opened its database and found the old one gone. */
  at: number;
  /** One line: what happened. */
  title: string;
  /** What that means, a paragraph each: why, what is being rebuilt, and what is not coming back. */
  lines: string[];
}

/**
 * What the host was last told about keeping its storage. **A record, not a guarantee**: a
 * browser that said yes can still lose a database, which is why {@link StorageCleared} is found
 * by opening the database and never by reading this.
 *
 * The web host asks again while the answer is no, at most once a week, and stops at a yes
 * (`./web/storage.ts`'s `settlePersistence` has the rule and why it is not the spec's "once").
 */
export interface StoragePersistence {
  /**
   * Unix **milliseconds** of the last time the host asked — or `null` where it never did and
   * its storage was found persistent all the same (an install can do that by itself).
   */
  askedAt: number | null;
  /** What the host was last told, by an answer to its ask or by its storage unasked. */
  granted: boolean;
}
