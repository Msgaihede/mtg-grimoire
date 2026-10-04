import type { StorageCleared, StoragePersistence } from "../hostStorage";

/**
 * **What the web host remembers about the browser's storage, outside the database** — the page's
 * half of the light-app spec §6: *"The corpus can vanish while the shell survives…
 * `navigator.storage.persist()` is asked once and its answer recorded, not trusted;
 * `navigator.storage.estimate()` gates nothing."*
 *
 * Three small records, and **all three are kept in `localStorage`, on purpose**:
 *
 * - **They are facts about this browser profile, not about the reader's data.** None may sync to
 *   another device, and none belongs in a database that travels.
 * - **They must not live where the thing they describe lives.** The databases are in OPFS. A
 *   mark kept beside them would vanish with them, and "there has been a database here" is only
 *   worth knowing on the day there no longer is one.
 *
 * **What that choice costs, and it is the limit of the whole notice**: `localStorage` has to
 * *outlive* OPFS for a clearing to be seen. Where a browser takes the origin's storage as one
 * piece — a reader clearing site data, a browser whose eviction or idle purge empties the
 * origin whole — the mark goes with the database, the next launch is a first run as far as
 * anything here can tell, and nothing is said. So the notice fires only where the two are
 * cleared apart; which browsers do that has not been measured from this app, and an eviction
 * cannot be produced on demand to measure it.
 *
 * **Nothing here reads `estimate()`.** It reported 647 MB and then 7 MB for one unchanged
 * 532.8 MB file (round one, 2026-08-28), and 67 MB against 1.5 MB of files on the day this host
 * first opened a database (light-app.md §9.1). A number like that can refuse a sync that would
 * have worked.
 *
 * Everything takes its store and its clock as arguments, so the suite drives it with neither a
 * browser nor a date.
 */

/** As much of a `Storage` as this needs. The page's `localStorage` is assignable to it. */
export interface KeyStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** As much of `navigator.storage` as this needs — and either method may be missing from a browser. */
export interface PersistManager {
  /** Ask for persistent storage. May prompt the reader (Firefox does). */
  persist?: () => Promise<boolean>;
  /** Whether storage is persistent right now. Asks nobody and prompts nothing. */
  persisted?: () => Promise<boolean>;
}

/** Where {@link settlePersistence}'s answer is written down. */
export const PERSIST_KEY = "grimoire.storage.persist";

/**
 * How long a browser that has not granted persistence is left alone before it is asked again:
 * **a week**. Long enough that a browser which *prompts* is not prompting at every launch, short
 * enough that a reader who installed the app last weekend is asked again this one.
 */
export const PERSIST_ASK_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

/** The mark: this browser holds a database, and since when. See {@link noteOpened}. */
export const HELD_KEY = "grimoire.storage.held";

/** An occurrence of the storage having been cleared, kept until the reader dismisses it. */
export const CLEARED_KEY = "grimoire.storage.cleared";

/**
 * A store that never throws and still works for the life of the page when the real one does not.
 *
 * `localStorage` can refuse a read, a write, or being named at all — a private window in some
 * browsers, a profile with site data blocked. None of that may reach the database's open, which
 * is where these records are written from. So a failed write is kept in memory instead, which is
 * what makes a dismissed notice stay dismissed until the page is closed even where nothing can be
 * written down; what it cannot do is remember across a reload, and that browser is simply one
 * that is asked again and never told its storage was cleared.
 */
export function forgiving(store: KeyStore | undefined): KeyStore {
  /** What could not be written through: a value, or `null` for a removal that did not land. */
  const memory = new Map<string, string | null>();
  return {
    getItem(key) {
      if (memory.has(key)) return memory.get(key) ?? null;
      try {
        return store?.getItem(key) ?? null;
      } catch {
        return null;
      }
    },
    setItem(key, value) {
      try {
        if (!store) throw new Error("no store");
        store.setItem(key, value);
        memory.delete(key);
      } catch {
        memory.set(key, value);
      }
    },
    removeItem(key) {
      try {
        if (!store) throw new Error("no store");
        store.removeItem(key);
        memory.delete(key);
      } catch {
        // Remembered as gone: a read that still reaches the real store must not bring it back.
        memory.set(key, null);
      }
    },
  };
}

/** A stored record's fields, or `null` for one that is absent or that nobody can parse. */
function read(store: KeyStore, key: string): Record<string, unknown> | null {
  const raw = store.getItem(key);
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// persist()
// ---------------------------------------------------------------------------------------------

/** What was written down, or `null` — including for a record that cannot be read. */
export function readPersistence(store: KeyStore): StoragePersistence | null {
  const record = read(store, PERSIST_KEY);
  if (record === null) return null;
  const { askedAt, granted } = record;
  if (typeof granted !== "boolean") return null;
  if (askedAt !== null && typeof askedAt !== "number") return null;
  return { askedAt, granted };
}

/**
 * How a launch came by its answer: it **asked** the browser, it stands on the **record** of an
 * earlier launch, the **browser** said so unasked, or there is **none** — no record and no way
 * to ask.
 */
export type PersistenceSource = "asked" | "record" | "browser" | "none";

/** What one launch settled about persistence, as far as it can be settled without waiting. */
export interface PersistenceLaunch {
  /**
   * The record as this launch found it or wrote it. **For a fresh ask this is the record written
   * before the browser answered** — asked now, not granted yet — and {@link answered} is the rest.
   */
  record: StoragePersistence | null;
  from: PersistenceSource;
  /**
   * Only when `from` is `"asked"`: the browser's answer, written down when it comes. Kept apart
   * because a browser that prompts answers when the reader does, which may be never, and nothing
   * that reads the record may wait on a reader.
   */
  answered?: Promise<StoragePersistence>;
}

/** Whether a browser last asked at `askedAt` is due another ask. Never asked is due; so is a
 *  stamp in the future — a clock that moved — rather than a wait nobody can see the end of. */
function due(askedAt: number | null, now: number): boolean {
  return askedAt === null || askedAt > now || now - askedAt >= PERSIST_ASK_INTERVAL_MS;
}

/**
 * Settle, for this launch, whether the browser is keeping this origin's storage — and write
 * down what it said.
 *
 * **This departs from the spec's "asked once", on purpose.** The light-app spec §6 says
 * `persist()` "is asked once and its answer recorded", and the first version of this file did
 * exactly that, on the premise that the answer does not change for the asking. **That premise is
 * wrong for Chromium**, which decides *at the moment of the call* from what it knows then — how
 * much the reader has used the site, whether it is bookmarked, whether it is installed. A first
 * visit to a site that is none of those is answered `false`; recorded for good, that `false`
 * stopped the app ever asking again, including after the reader installed it — which is the day
 * the answer would have been `true`. A `persist()` that threw was frozen the same way. So:
 *
 * - **Granted is final.** Once the browser has said yes there is nothing more to ask for.
 * - **Not granted is asked again, no more often than once a week**
 *   ({@link PERSIST_ASK_INTERVAL_MS}). Not at every launch: Firefox answers by *prompting the
 *   reader*, and a prompt at every launch is one they learn to refuse. The stamp is written
 *   **before** the browser is asked, so a prompt left unanswered, or a tab closed over it, still
 *   counts as this week's ask.
 * - **Each launch first reads `persisted()`, where the browser has it.** That asks nobody and
 *   prompts nothing, and storage can become persistent with no ask from this app at all — an
 *   install does it — which is worth recording the day it happens rather than a week later. It
 *   is also the one thing that takes a recorded yes back: a browser that says its storage is
 *   *not* persistent is believed over a record that says it was.
 * - **Asked when the database has opened**, which is when there is first something to keep. The
 *   card data can be downloaded again; a collection typed in here cannot, and it exists from the
 *   first write — so this does not wait for the card data, as round one's did when the card data
 *   was all a browser held.
 * - **Recorded, not trusted.** A `true` is the browser's intention and not a promise, and nothing
 *   reads this to decide whether the database is safe: that is found out by opening it
 *   ({@link noteOpened}). The record is for a reader, in Settings, and for a bug report.
 *
 * Nothing is written for a browser with neither method, so one that gains them later starts
 * clean. A `persist()` that rejects is recorded as not granted: it was asked, and did not say yes.
 */
export async function settlePersistence(
  manager: PersistManager | undefined,
  store: KeyStore,
  now: number,
): Promise<PersistenceLaunch> {
  const recorded = readPersistence(store);
  const write = (record: StoragePersistence): StoragePersistence => {
    store.setItem(PERSIST_KEY, JSON.stringify(record));
    return record;
  };

  // `true`, `false`, or `null` for a browser that cannot say (or threw saying it).
  const live =
    typeof manager?.persisted === "function"
      ? await manager.persisted().then(
          (answer) => answer === true,
          () => null,
        )
      : null;

  if (live === true) {
    if (recorded?.granted) return { record: recorded, from: "record" };
    // Persistent with no yes on record: the browser granted it by itself. The last ask's date is
    // kept, because it is still the last time this app asked — `null` if it never did.
    return { record: write({ askedAt: recorded?.askedAt ?? null, granted: true }), from: "browser" };
  }
  if (recorded?.granted && live === null) return { record: recorded, from: "record" };

  if (typeof manager?.persist !== "function" || !due(recorded?.askedAt ?? null, now)) {
    // A yes on record that the browser now denies is written down as what the browser says.
    if (recorded?.granted) return { record: write({ ...recorded, granted: false }), from: "browser" };
    return { record: recorded, from: recorded ? "record" : "none" };
  }

  // Stamped first: this is the week's ask whether or not an answer ever comes.
  const asking = write({ askedAt: now, granted: false });
  const answered = manager.persist().then(
    (answer) => (answer === true ? write({ askedAt: now, granted: true }) : asking),
    () => asking,
  );
  return { record: asking, from: "asked", answered };
}

/**
 * One line for the console, beside the line the database's open writes — where a bug report can
 * carry it: what the browser last said, when this app last asked, and **which of the two this
 * launch did** — asked afresh, or stood on what an earlier launch wrote down.
 */
export function persistenceLine(
  record: StoragePersistence | null,
  from: PersistenceSource,
): string {
  if (record === null) {
    return "MTG Grimoire: persistent storage not asked — this browser has no way to ask";
  }
  const asked =
    record.askedAt === null ? "never asked" : `asked ${new Date(record.askedAt).toISOString()}`;
  const how =
    from === "asked"
      ? "asked on this launch"
      : from === "browser"
        ? "the browser says so, unasked"
        : "from the record";
  return (
    `MTG Grimoire: persistent storage ${record.granted ? "granted" : "not granted"}, ` +
    `${asked} (${how})`
  );
}

// ---------------------------------------------------------------------------------------------
// Storage cleared under the app
// ---------------------------------------------------------------------------------------------

/** What the reader is told happened. */
export const CLEARED_TITLE = "Your browser cleared MTG Grimoire's saved data";

/**
 * Why, what is being rebuilt, and what is not coming back — a paragraph each, written for a
 * reader who opened the app and found it empty.
 *
 * **The third is the one this notice exists for.** An engine that opens an empty database starts
 * the card download by itself, so a silent app would look like a first run that is simply slow —
 * and a reader would go on waiting for a collection the download was never going to bring back.
 * It says so plainly, and names the one way back there is: a file they exported.
 *
 * **The fourth is about a place in a pairing group, and it is an *if*** (the light-app spec §7:
 * "Clearing site data mints a new device and spends a slot"). A browser's device identity and
 * its keys were rows of the database that went, so the app has opened on a new identity — and if
 * the old one was paired, it is still on the roster of every other device in its group, counted
 * against the group's five, until one of them removes it. **This page cannot know whether it
 * was**: the only record that it was paired is the record that was cleared, and the mark that
 * outlives the database (`HELD_KEY`) says a database was held and nothing about what was in it.
 * So the sentence is conditional, and it names where the press is rather than promising there
 * is something to press. Last, because it is the one of the four most readers have no use for.
 */
export const CLEARED_LINES: readonly string[] = [
  "Browsers can remove what a site has stored — when the device runs low on space, or when the " +
    "site's data is cleared. That has happened here since you last opened the app.",
  "The card data downloads again by itself.",
  "Anything you had added in this browser — your collection, wishlist and decks — was removed " +
    "with it, and this browser has nothing to restore it from. If you exported them, you can " +
    "import those files again.",
  "If this browser was paired with your other devices, it is a new device now, and its old " +
    "entry still counts toward the group's five. Remove the old entry in Settings, under Sync, " +
    "on one of the others, then pair this browser again.",
];

/**
 * What a browser that is in a pairing group is told about its own storage, **before** anything
 * clears it — the web host's answer to `storage_group_warning` (`../hostStorage.ts`), and the
 * other half of {@link CLEARED_LINES}' last paragraph: that one speaks after the storage has
 * gone and can only say *if*; this one stands in the Sync panel, under the roster, while there
 * is still a group to leave.
 *
 * **The press it warns about is not in the app.** A device's identity and its keys are rows of
 * `user.db`, and no command the app has deletes them — every clear on the Settings page was read
 * for it on 2026-10-04 (`reset.rs` names the collection, the wishlist, the decks and the picture
 * cache, and nothing of `sync_identity` or `sync_group`; *Leave group* is the one press that
 * touches the group, and it is the cure). What deletes them is the browser's own *clear site
 * data*. So there is no dialog for the sentence to live in, and it stands instead.
 *
 * **Here, with the host, because the words are a browser's**: "this browser", "site data".
 * Another host whose storage can be cleared from outside the app — a phone's system settings —
 * would answer the same name with its own, and the panel that draws this knows only that it was
 * handed a sentence.
 *
 * **Two sentences, because it stands on a phone.** It opened with a third — where the identity
 * is kept — and at a 360px window the three ran to seven lines of the panel for something most
 * readers never do. What is left is the consequence and the two ways out, in the order they cost
 * least: leaving first frees the place at once and needs nothing from another device; removing
 * the old entry afterwards is what is left to a reader who has already cleared. Five lines there.
 */
export const SITE_DATA_WARNING =
  "Clearing this browser's site data makes it a new device, and the old entry still counts " +
  "toward the group's five until it is removed. Leave the group here first, or remove the old " +
  "entry from another device afterwards.";

/**
 * The console's line for the same thing, where a bug report can carry it. What the open then
 * made of it is said after this, by whoever knows (`index.ts`).
 */
export const CLEARED_LINE =
  "MTG Grimoire: this browser cleared the app's storage since the database was last opened here";

/**
 * Record what an open found, and **whether it found the old database gone**.
 *
 * `existed` is whether this browser's OPFS already held the database's folder *before* the
 * engine opened it — asked by the Worker, ahead of the open, because opening is what creates the
 * folder (`engine.ts`). `null` is a browser that could not be asked. `opened` is whether the
 * open then succeeded.
 *
 * - **No folder and a mark** is storage cleared under the app: this browser has held a database
 *   and it is no longer there. The occurrence is written down, to be told once
 *   ({@link readCleared}).
 * - **No folder and no mark** is a first run, and says nothing. That is also what a browser that
 *   cleared *everything* looks like — the mark went with the rest (this file's header has what
 *   that costs) — and then a first run is the truth as far as this browser can tell it.
 * - **A folder** is the ordinary launch.
 *
 * **The occurrence is recorded whatever became of the open, and the mark only for one that
 * succeeded.** The pool's install creates the folder *before* anything can fail — so after a
 * clearing, an open that then runs out of quota, traps, or is cut off by the tab closing leaves
 * a folder behind, and the launch after it finds `existed: true` beside the mark and looks
 * ordinary. Noted only on success, the one launch that could see the clearing would say nothing
 * and the reader would never be told. Recorded here, it waits in `localStorage` for the launch
 * that gets far enough to draw it. **The mark is the other way round**: it says a database is
 * held, so it is written — and renewed, for a database just created — only when one opened.
 *
 * **Read from the folder and not from a count of cards**, as round one read it. An empty card
 * table has other causes that are not a browser's doing — a first download still running, one
 * that failed, a corpus the engine replaced, a reader who cleared the card data from Settings —
 * and each would have told a reader their decks were gone while their decks sat in the database
 * beside it.
 *
 * Call it once per page, for the first word the Worker has about its open; it answers whether
 * this call found a clearing.
 */
export function noteOpened(
  store: KeyStore,
  existed: boolean | null,
  now: number,
  opened: boolean,
): boolean {
  const held = read(store, HELD_KEY) !== null;
  const cleared = existed === false && held;
  if (cleared) store.setItem(CLEARED_KEY, JSON.stringify({ at: now }));
  if (opened && (existed === false || !held)) {
    store.setItem(HELD_KEY, JSON.stringify({ at: now }));
  }
  return cleared;
}

/** The occurrence the reader has not dismissed yet, in the host's words, or `null`. */
export function readCleared(store: KeyStore): StorageCleared | null {
  const at = read(store, CLEARED_KEY)?.at;
  return typeof at === "number" ? { at, title: CLEARED_TITLE, lines: [...CLEARED_LINES] } : null;
}

/** The reader has read it. It is never the answer again; a later clearing is a new occurrence. */
export function dismissCleared(store: KeyStore): void {
  store.removeItem(CLEARED_KEY);
}
