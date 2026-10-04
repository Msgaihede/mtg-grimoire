import { describe, expect, it, vi } from "vitest";
import {
  CLEARED_KEY,
  CLEARED_LINES,
  CLEARED_TITLE,
  dismissCleared,
  forgiving,
  HELD_KEY,
  noteOpened,
  PERSIST_ASK_INTERVAL_MS,
  PERSIST_KEY,
  persistenceLine,
  readCleared,
  readPersistence,
  settlePersistence,
  type KeyStore,
} from "./storage";

/** A `localStorage` the test owns. */
function fakeStore(initial: Record<string, string> = {}) {
  const kept = new Map(Object.entries(initial));
  const store: KeyStore = {
    getItem: (key) => kept.get(key) ?? null,
    setItem: (key, value) => void kept.set(key, value),
    removeItem: (key) => void kept.delete(key),
  };
  return { store, kept };
}

/** One that refuses everything, as a profile with site data blocked does. */
const refusing: KeyStore = {
  getItem: () => {
    throw new Error("SecurityError");
  },
  setItem: () => {
    throw new Error("QuotaExceededError");
  },
  removeItem: () => {
    throw new Error("SecurityError");
  },
};

const NOW = Date.UTC(2026, 9, 4, 12);

describe("the keys the web host writes outside its database", () => {
  it("are these three, by name", () => {
    // Read by a later build of this app out of the same browser, and by `web-smoke.mjs`: a
    // renamed key is a browser asked twice, or a clearing nobody is told about.
    expect([PERSIST_KEY, HELD_KEY, CLEARED_KEY]).toEqual([
      "grimoire.storage.persist",
      "grimoire.storage.held",
      "grimoire.storage.cleared",
    ]);
  });
});

describe("a store that cannot be relied on", () => {
  it("is read and written through when it works", () => {
    const { store, kept } = fakeStore({ a: "1" });
    const safe = forgiving(store);
    expect(safe.getItem("a")).toBe("1");
    safe.setItem("b", "2");
    expect(kept.get("b")).toBe("2");
    safe.removeItem("a");
    expect(kept.has("a")).toBe(false);
    expect(safe.getItem("a")).toBeNull();
  });

  it("never throws, and remembers for the life of the page what it could not write", () => {
    for (const safe of [forgiving(refusing), forgiving(undefined)]) {
      expect(safe.getItem("a")).toBeNull();
      expect(() => safe.setItem("a", "1")).not.toThrow();
      expect(safe.getItem("a")).toBe("1");
      expect(() => safe.removeItem("a")).not.toThrow();
      expect(safe.getItem("a")).toBeNull();
    }
  });

  it("keeps a removal that did not land from being read back", () => {
    // Readable and not writable: the store still holds the value, and the page has dismissed it.
    const { store } = fakeStore({ a: "1" });
    const safe = forgiving({ ...store, removeItem: refusing.removeItem });
    safe.removeItem("a");
    expect(safe.getItem("a")).toBeNull();
  });
});

describe("the record of asking to keep storage", () => {
  const DAY = 86_400_000;
  const recorded = (record: { askedAt: number | null; granted: boolean }) =>
    fakeStore({ [PERSIST_KEY]: JSON.stringify(record) });
  /** A launch's settling, with a fresh ask's answer awaited where there was one. */
  const settle = async (...args: Parameters<typeof settlePersistence>) => {
    const launch = await settlePersistence(...args);
    return { ...launch, final: launch.answered ? await launch.answered : launch.record };
  };

  it("is read back as it was written, and as nothing when it cannot be read", () => {
    const { store, kept } = fakeStore();
    expect(readPersistence(store)).toBeNull();

    kept.set(PERSIST_KEY, JSON.stringify({ askedAt: NOW, granted: true }));
    expect(readPersistence(store)).toEqual({ askedAt: NOW, granted: true });
    // Never asked, and persistent all the same: the one record with no date.
    kept.set(PERSIST_KEY, JSON.stringify({ askedAt: null, granted: true }));
    expect(readPersistence(store)).toEqual({ askedAt: null, granted: true });

    // Not JSON, not an object, and an object of the wrong shape: each is "nothing recorded", so
    // the launch looks again rather than a page drawing a record nobody wrote.
    for (const broken of ["{", "null", '"yes"', '{"askedAt":"today","granted":true}', "{}"]) {
      kept.set(PERSIST_KEY, broken);
      expect(readPersistence(store)).toBeNull();
    }
  });

  it("asks a browser with no record, and writes down what it said", async () => {
    const { store, kept } = fakeStore();
    const persist = vi.fn(() => Promise.resolve(true));

    const launch = await settle({ persist }, store, NOW);

    expect(launch.from).toBe("asked");
    expect(launch.final).toEqual({ askedAt: NOW, granted: true });
    expect(JSON.parse(kept.get(PERSIST_KEY) ?? "null")).toEqual({ askedAt: NOW, granted: true });
  });

  /**
   * **The interval, to the millisecond on both sides.** Not granted is asked again no more
   * often than once a week: often enough that a reader who has since installed the app is
   * granted, seldom enough that a browser which prompts is not prompting at every launch.
   */
  it("leaves a no alone for a week, and asks again when the week is up", async () => {
    expect(PERSIST_ASK_INTERVAL_MS).toBe(7 * DAY);
    const persist = vi.fn(() => Promise.resolve(true));

    const early = recorded({ askedAt: NOW - PERSIST_ASK_INTERVAL_MS + 1, granted: false });
    const waited = await settle({ persist }, early.store, NOW);
    expect(waited.from).toBe("record");
    expect(waited.final).toEqual({ askedAt: NOW - PERSIST_ASK_INTERVAL_MS + 1, granted: false });
    expect(persist).not.toHaveBeenCalled();

    const due = recorded({ askedAt: NOW - PERSIST_ASK_INTERVAL_MS, granted: false });
    const asked = await settle({ persist }, due.store, NOW);
    expect(asked.from).toBe("asked");
    expect(asked.final).toEqual({ askedAt: NOW, granted: true });
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it("asks again rather than waiting on a stamp from the future", async () => {
    // A clock that moved back: waiting for it to catch up is a wait nobody can see the end of.
    const { store } = recorded({ askedAt: NOW + 30 * DAY, granted: false });
    const persist = vi.fn(() => Promise.resolve(false));
    expect((await settle({ persist }, store, NOW)).from).toBe("asked");
  });

  it("takes a yes as final, however long ago it was given", async () => {
    const { store } = recorded({ askedAt: NOW - 1_000 * DAY, granted: true });
    const persist = vi.fn(() => Promise.resolve(false));

    const launch = await settle({ persist }, store, NOW);

    expect(launch.from).toBe("record");
    expect(launch.final).toEqual({ askedAt: NOW - 1_000 * DAY, granted: true });
    expect(persist).not.toHaveBeenCalled();
  });

  it("reads what the browser says before it asks anything, and records a yes it finds", async () => {
    const order: string[] = [];
    const manager = {
      persisted: () => {
        order.push("persisted");
        return Promise.resolve(true);
      },
      persist: () => {
        order.push("persist");
        return Promise.resolve(true);
      },
    };

    // Never asked: granted with no date, and nobody was asked to get it.
    const fresh = fakeStore();
    const found = await settle(manager, fresh.store, NOW);
    expect(found.from).toBe("browser");
    expect(found.final).toEqual({ askedAt: null, granted: true });
    expect(JSON.parse(fresh.kept.get(PERSIST_KEY) ?? "null")).toEqual(found.final);

    // Asked before and refused: the date stays the last ask's, the answer is the browser's.
    const refused = recorded({ askedAt: NOW - DAY, granted: false });
    expect((await settle(manager, refused.store, NOW)).final).toEqual({
      askedAt: NOW - DAY,
      granted: true,
    });

    // Already on record as granted: the browser agrees, and nothing is rewritten.
    const agreed = recorded({ askedAt: NOW - DAY, granted: true });
    expect((await settle(manager, agreed.store, NOW)).from).toBe("record");

    expect(order).toEqual(["persisted", "persisted", "persisted"]);
  });

  it("asks only after the browser has said it is not persistent", async () => {
    const order: string[] = [];
    const manager = {
      persisted: () => {
        order.push("persisted");
        return Promise.resolve(false);
      },
      persist: () => {
        order.push("persist");
        return Promise.resolve(true);
      },
    };
    const launch = await settle(manager, fakeStore().store, NOW);
    expect(order).toEqual(["persisted", "persist"]);
    expect(launch.final).toEqual({ askedAt: NOW, granted: true });
  });

  it("writes down a no the browser now gives over a yes on record, and asks again when due", async () => {
    const lost = { persisted: () => Promise.resolve(false), persist: vi.fn(() => Promise.resolve(true)) };

    const recent = recorded({ askedAt: NOW - DAY, granted: true });
    const denied = await settle(lost, recent.store, NOW);
    expect(denied.from).toBe("browser");
    expect(denied.final).toEqual({ askedAt: NOW - DAY, granted: false });
    expect(lost.persist).not.toHaveBeenCalled();
    expect(JSON.parse(recent.kept.get(PERSIST_KEY) ?? "null")).toEqual(denied.final);

    const old = recorded({ askedAt: NOW - 8 * DAY, granted: true });
    expect((await settle(lost, old.store, NOW)).from).toBe("asked");
    expect(lost.persist).toHaveBeenCalledTimes(1);
  });

  it("keeps a yes on record where the browser cannot say, or throws saying", async () => {
    const { store } = recorded({ askedAt: NOW - DAY, granted: true });
    const throwing = { persisted: () => Promise.reject(new Error("no")), persist: vi.fn() };
    expect((await settle(throwing, store, NOW)).final).toEqual({ askedAt: NOW - DAY, granted: true });
    expect((await settle({}, store, NOW)).final).toEqual({ askedAt: NOW - DAY, granted: true });
    expect(throwing.persist).not.toHaveBeenCalled();
  });

  /**
   * A browser that asks by prompting answers when the reader does, which may be never — and a
   * tab can close over the prompt. The week's ask is on record before the browser is asked.
   */
  it("stamps the ask before the browser answers it", async () => {
    const { store, kept } = fakeStore();
    let answer!: (granted: boolean) => void;
    const persist = vi.fn(() => new Promise<boolean>((resolve) => (answer = resolve)));

    const launch = await settlePersistence({ persist }, store, NOW);

    // Settled without the answer: asked now, not granted yet — and already written down.
    expect(launch.from).toBe("asked");
    expect(launch.record).toEqual({ askedAt: NOW, granted: false });
    expect(JSON.parse(kept.get(PERSIST_KEY) ?? "null")).toEqual({ askedAt: NOW, granted: false });
    // A launch a day later, the prompt still unanswered, does not prompt again.
    expect((await settlePersistence({ persist }, store, NOW + DAY)).from).toBe("record");
    expect(persist).toHaveBeenCalledTimes(1);

    // And the answer, when it comes, is the record.
    answer(true);
    expect(await launch.answered).toEqual({ askedAt: NOW, granted: true });
    expect(readPersistence(store)).toEqual({ askedAt: NOW, granted: true });
  });

  it("is not granted unless the browser said exactly yes", async () => {
    const rejecting = { persist: () => Promise.reject(new Error("no")) };
    expect((await settle(rejecting, fakeStore().store, NOW)).final).toEqual({
      askedAt: NOW,
      granted: false,
    });
    const odd = { persist: () => Promise.resolve(undefined as unknown as boolean) };
    expect((await settle(odd, fakeStore().store, NOW)).final).toEqual({
      askedAt: NOW,
      granted: false,
    });
  });

  it("is nothing, and writes nothing, where there is no way to ask", async () => {
    const { store, kept } = fakeStore();
    expect(await settlePersistence(undefined, store, NOW)).toEqual({ record: null, from: "none" });
    expect(await settlePersistence({}, store, NOW)).toEqual({ record: null, from: "none" });
    expect(kept.size).toBe(0);
  });

  it("is said in one line: the answer, the day it was asked, and how this launch came by it", () => {
    const asked = "asked 2026-10-04T12:00:00.000Z";
    expect(persistenceLine({ askedAt: NOW, granted: true }, "asked")).toBe(
      `MTG Grimoire: persistent storage granted, ${asked} (asked on this launch)`,
    );
    expect(persistenceLine({ askedAt: NOW, granted: false }, "record")).toBe(
      `MTG Grimoire: persistent storage not granted, ${asked} (from the record)`,
    );
    expect(persistenceLine({ askedAt: null, granted: true }, "browser")).toBe(
      "MTG Grimoire: persistent storage granted, never asked (the browser says so, unasked)",
    );
    expect(persistenceLine(null, "none")).toBe(
      "MTG Grimoire: persistent storage not asked — this browser has no way to ask",
    );
  });
});

describe("noting what an open found", () => {
  /**
   * `held` — whether the mark was there before; `existed` — what the Worker found in OPFS;
   * `opened` — whether the open then succeeded.
   */
  const found = (held: boolean, existed: boolean | null, opened = true) => {
    const { store, kept } = fakeStore(held ? { [HELD_KEY]: JSON.stringify({ at: 1 }) } : {});
    return { cleared: noteOpened(store, existed, NOW, opened), store, kept };
  };

  it("finds a clearing only where a database was held and its folder is gone", () => {
    // The whole table: two facts, one of them three-valued, and exactly one cell that speaks —
    // whether or not the open went on to succeed.
    for (const opened of [true, false]) {
      expect(found(false, false, opened).cleared).toBe(false);
      expect(found(false, true, opened).cleared).toBe(false);
      expect(found(false, null, opened).cleared).toBe(false);
      expect(found(true, true, opened).cleared).toBe(false);
      expect(found(true, null, opened).cleared).toBe(false);
      expect(found(true, false, opened).cleared).toBe(true);
    }
  });

  it("holds a mark after every open that succeeded, renewed only for a database just created", () => {
    for (const held of [false, true]) {
      for (const existed of [false, true, null]) {
        const { kept } = found(held, existed);
        const fresh = existed === false || !held;
        expect(JSON.parse(kept.get(HELD_KEY) ?? "null")).toEqual({ at: fresh ? NOW : 1 });
      }
    }
  });

  it("never touches the mark for an open that failed", () => {
    // The mark says a database is held. A failed open holds none — and a mark written for one
    // would make the next launch's empty folder a clearing of something that never was.
    for (const existed of [false, true, null]) {
      expect(found(false, existed, false).kept.has(HELD_KEY)).toBe(false);
      expect(JSON.parse(found(true, existed, false).kept.get(HELD_KEY) ?? "null")).toEqual({ at: 1 });
    }
  });

  /**
   * The sequence a note taken only on success misses: the open after a clearing creates the
   * folder and then fails, and the launch after it finds a folder beside the mark.
   */
  it("keeps a clearing seen by a failed open for the launch that can tell it", () => {
    const { store } = fakeStore({ [HELD_KEY]: JSON.stringify({ at: 1 }) });

    expect(noteOpened(store, false, NOW, false)).toBe(true);
    // The next launch: an ordinary one, as far as the folder and the mark can say.
    expect(noteOpened(store, true, NOW + 60_000, true)).toBe(false);

    expect(readCleared(store)).toMatchObject({ at: NOW, title: CLEARED_TITLE });
  });

  it("reads a mark nobody can parse as no mark", () => {
    // The cost of guessing the other way is telling a reader something untrue about their own
    // history.
    const { store } = fakeStore({ [HELD_KEY]: "not json" });
    expect(noteOpened(store, false, NOW, true)).toBe(false);
  });

  it("keeps the occurrence until it is dismissed, in the host's words", () => {
    const { store } = found(true, false);
    expect(readCleared(store)).toEqual({ at: NOW, title: CLEARED_TITLE, lines: [...CLEARED_LINES] });

    dismissCleared(store);
    expect(readCleared(store)).toBeNull();
  });

  it("does not throw, and invents nothing, in a browser that will not write", () => {
    // Nothing can be read there either, so no mark is ever found and nothing is ever told —
    // the honest limit. What must hold is that it does not throw on the way to the open.
    const safe = forgiving(refusing);
    expect(() => noteOpened(safe, false, NOW, true)).not.toThrow();
    expect(readCleared(safe)).toBeNull();
    // The mark it could not write is remembered in the page, so nothing is invented later.
    expect(noteOpened(safe, true, NOW, true)).toBe(false);
  });
});

describe("what a reader is told", () => {
  it("is written for someone who opened the app and found it empty", () => {
    const text = [CLEARED_TITLE, ...CLEARED_LINES].join(" ");
    // No code, no key, no API name — and nothing that blames the reader.
    expect(text).not.toMatch(/OPFS|localStorage|persist|evict|quota|error/i);
    // The three things it owes them: why, what comes back by itself, and what does not — and a
    // fourth for the reader whose browser was one of their paired devices.
    expect(CLEARED_LINES).toHaveLength(4);
    expect(CLEARED_LINES[1]).toMatch(/downloads again by itself/);
    expect(CLEARED_LINES[2]).toMatch(/nothing to restore it from/);
  });

  /**
   * The light-app spec §7: clearing site data mints a new device and spends one of the group's
   * five places. **The page cannot know it was paired** — the record that it was is the record
   * that went — so the sentence is an *if*, never a statement, and it names the press that frees
   * the place and where that press is.
   */
  it("tells a reader who may have been paired where the old device's entry is removed", () => {
    const line = CLEARED_LINES[3];
    expect(line).toMatch(/^If this browser was paired/);
    expect(line).toMatch(/new device now/);
    expect(line).toMatch(/still counts toward the group's five/);
    expect(line).toMatch(/Remove the old entry in Settings, under Sync, on one of the others/);
    expect(line).toMatch(/pair this browser again/);
    // Nothing that claims the pairing as a fact.
    expect(line).not.toMatch(/\byou were paired\b|\bwas removed from\b/i);
  });
});
