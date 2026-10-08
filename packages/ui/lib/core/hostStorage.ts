/**
 * **What a host answers about storage it does not own** — the commands, and the shape of each
 * answer (the light-app spec §6: "The corpus can vanish while the shell survives…
 * `navigator.storage.persist()` is asked once and its answer recorded, not trusted").
 *
 * A desktop and a phone keep their databases in a folder that is theirs. A browser lends its
 * storage and may take it back: it can clear what a site has kept while the page that kept it is
 * still installed and still opens. So the web host answers these four, **on the page, without
 * reaching the engine** — as it answers `startup_status` (`./web/index.ts`) — and no other host
 * answers them at all: the desktop's IPC and the engine's command table both refuse a name they
 * do not have, in words.
 *
 * **That refusal is the whole of how a page stays ignorant of where it runs.** A component asks,
 * and draws only if a host answered; a host without the command is nothing to draw. It is
 * `light_downloads`' arrangement (`apps/light/DownloadsPrompt.tsx`), and the reason this file is
 * plain names and shapes with no host in it — it is read by the page and by the web host alike.
 */

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
 * Asks what the host has to say, **to a device that is in a pairing group**, about the storage
 * its identity is kept in. Answers one sentence **in the host's own words** — as
 * {@link StorageCleared} is — or `null` when it has nothing to say. Takes nothing.
 *
 * What goes with a host's storage is the device's identity and its keys, which are rows of the
 * database. A host whose storage can be cleared from outside the app then opens as a new device,
 * and the old one is still on every other device's roster, counted against the group's five,
 * until one of them removes it (the light-app spec §7: "Clearing site data mints a new device and
 * spends a slot. The panel says so before a reader presses anything that would"). {@link
 * STORAGE_CLEARED} speaks *after* the storage has gone; this is the half that can still be acted
 * on, and the Sync panel draws its answer under the roster while there is a group to leave.
 *
 * **A name of its own, and the answer is the sentence** — not a yes the page words for itself.
 * For one commit the panel asked {@link STORAGE_PERSISTENCE} and read *any* answer as "this is a
 * browser", then drew a sentence about "this browser's site data" that lived in the panel. That
 * name allows `null` from "a host with no way to ask", so the day another host answered it — the
 * Android table, say — a phone would have been told about a browser. Here the kind of host is
 * never inferred: the web host answers its wording (`./web/storage.ts`, beside the cleared
 * notice's lines), a host with a different way of losing its storage answers its own, and a host
 * that owns its folder refuses the name. The page knows a sentence, or nothing.
 *
 * **Whether the device is in a group is the page's half**, because it is the engine's fact and
 * the page already has it: the host answers as if asked by a paired device, and the panel draws
 * the answer only while that is true.
 */
export const STORAGE_GROUP_WARNING = "storage_group_warning";

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
