import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_DECKLIST_BYTES } from "../browserFiles";
import { STORAGE_CLEARED, STORAGE_CLEARED_DISMISS, STORAGE_PERSISTENCE } from "../hostStorage";
import type { Core } from "../types";
import { answeringFiles, suggestedName } from "./files";
import { createWebCore, type WorkerPort } from "./index";
import type { ToWorker } from "./protocol";

/** The Worker's `Core`, stood in for: it records what reached it and answers with a marker. */
function engine(): { core: Core; calls: unknown[][]; listened: string[] } {
  const calls: unknown[][] = [];
  const listened: string[] = [];
  const core: Core = {
    call: <T>(...args: unknown[]) => {
      calls.push(args);
      return Promise.resolve("from the engine" as T);
    },
    listen: (event) => {
      listened.push(event);
      return () => {};
    },
  };
  return { core, calls, listened };
}

/**
 * Every download the page made, by the name it was given. jsdom has no object URLs at all, so
 * both are written for the test — `afterEach` takes them back.
 */
function catchDownloads(): { name: string; blob: Blob }[] {
  const caught: { name: string; blob: Blob }[] = [];
  const blobs = new Map<string, Blob>();
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: (blob: Blob) => {
      const url = `blob:${blobs.size}`;
      blobs.set(url, blob);
      return url;
    },
  });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: () => undefined });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    const blob = blobs.get(this.getAttribute("href") ?? "");
    if (blob !== undefined) caught.push({ name: this.download, blob });
  });
  return caught;
}

/** The hidden input the page made for the picker that is open. */
const picker = (): HTMLInputElement | null => document.querySelector('input[type="file"]');

/** Answer the open picker as a browser does: the chosen file on the input, then `change`. */
function choose(file: File): void {
  const input = picker();
  if (input === null) throw new Error("no picker is open");
  Object.defineProperty(input, "files", { configurable: true, value: [file] });
  input.dispatchEvent(new Event("change"));
}

beforeEach(() => {
  // jsdom's `click()` on a file input opens nothing; the tests answer the picker themselves.
  vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(URL, "createObjectURL");
  Reflect.deleteProperty(URL, "revokeObjectURL");
  document.body.replaceChildren();
});

describe("suggestedName", () => {
  it("keeps the last component of what the page suggested, as the core's rule does", () => {
    // `grimoire_core::import::suggested_name`'s own cases.
    expect(suggestedName("Ramp.txt")).toBe("Ramp.txt");
    expect(suggestedName("Krenko, Mob Boss.csv")).toBe("Krenko, Mob Boss.csv");
    expect(suggestedName("..\\..\\Startup\\x.bat")).toBe("x.bat");
    expect(suggestedName("/etc/cron.d/deck.txt")).toBe("deck.txt");
    expect(suggestedName("a/b\\c.txt")).toBe("c.txt");
    for (const junk of ["", "  ", ".", "..", "decks/", "..\\..", "C:\\"]) {
      expect(suggestedName(junk), junk).toBeNull();
    }
  });
});

describe("the web host's file commands", () => {
  it("saves an export as a download, and answers that a file was handed over", async () => {
    const caught = catchDownloads();
    const { core, calls } = engine();

    const wrote = await answeringFiles(core).call<boolean>("export_save_file", {
      fileName: "Burn.txt",
      contents: "4 Lightning Bolt\n",
    });

    // The desktop's answer for a file written. No dialog can be cancelled here, so never `false`.
    expect(wrote).toBe(true);
    expect(caught.map((c) => c.name)).toEqual(["Burn.txt"]);
    expect(await caught[0]?.blob.text()).toBe("4 Lightning Bolt\n");
    // Answered on the page: the Worker has no document, and its table has no such command.
    expect(calls).toEqual([]);
  });

  it("downloads under a name and never a path", async () => {
    const caught = catchDownloads();
    const files = answeringFiles(engine().core);
    await files.call("export_save_file", { fileName: "..\\..\\x.csv", contents: "a" });
    await files.call("export_save_file", { fileName: "decks/", contents: "b" });
    expect(caught.map((c) => c.name)).toEqual(["x.csv", "export.txt"]);
  });

  it("refuses a save with nothing to write, as a bare string", async () => {
    catchDownloads();
    await expect(
      answeringFiles(engine().core).call("export_save_file", { fileName: "x.txt" }),
    ).rejects.toBe("there was no text to save.");
  });

  it("answers a picked file's text and how it was read", async () => {
    const { core, calls } = engine();
    const asked = answeringFiles(core).call("import_pick_file");

    // Offered the phone picker's own list, and pressed for the reader.
    expect(picker()?.accept).toContain(".dek");
    expect(HTMLInputElement.prototype.click).toHaveBeenCalledTimes(1);
    // `1 S\xE9ance` as Excel writes it on a Western European Windows: not valid UTF-8.
    choose(new File([new Uint8Array([0x31, 0x20, 0x53, 0xe9, 0x61, 0x6e, 0x63, 0x65])], "x.csv"));

    await expect(asked).resolves.toEqual({ text: "1 Séance", encoding: "windows-1252" });
    // The input does not outlive its answer.
    expect(picker()).toBeNull();
    expect(calls).toEqual([]);
  });

  it("answers null for a cancelled picker, which is not a failure", async () => {
    const asked = answeringFiles(engine().core).call("import_pick_file");
    picker()?.dispatchEvent(new Event("cancel"));
    await expect(asked).resolves.toBeNull();
    expect(picker()).toBeNull();
  });

  it("answers the first ask with null when a second one opens", async () => {
    // A browser that reports no cancel leaves the first ask waiting; the next press must not.
    const files = answeringFiles(engine().core);
    const first = files.call("import_pick_file");
    const second = files.call("import_pick_file");

    await expect(first).resolves.toBeNull();
    expect(document.querySelectorAll('input[type="file"]')).toHaveLength(1);
    choose(new File(["4 Lightning Bolt\n"], "burn.txt"));
    await expect(second).resolves.toEqual({ text: "4 Lightning Bolt\n", encoding: "utf-8" });
  });

  it("refuses a file over the megabyte in import.rs's own sentence", async () => {
    const asked = answeringFiles(engine().core).call("import_pick_file");
    choose(new File(["x".repeat(MAX_DECKLIST_BYTES + 1)], "huge.txt"));
    await expect(asked).rejects.toBe(
      "That file is over 1 MB. A decklist is text; this reads at most 1 MB.",
    );
  });

  it("says a file that would not read could not be read, with the browser's reason", async () => {
    const asked = answeringFiles(engine().core).call("import_pick_file");
    const file = new File(["4 Lightning Bolt\n"], "gone.txt");
    vi.spyOn(file, "arrayBuffer").mockRejectedValue(new DOMException("The file was moved."));
    choose(file);
    await expect(asked).rejects.toBe("That file could not be read — The file was moved.");
  });

  it("sends every other command, and every subscription, to the engine", async () => {
    const { core, calls, listened } = engine();
    const files = answeringFiles(core);

    await expect(files.call("search_cards", { req: { text: "bolt" } })).resolves.toBe(
      "from the engine",
    );
    files.listen("sync:progress", () => {});

    expect(calls).toEqual([["search_cards", { req: { text: "bolt" } }, undefined]]);
    expect(listened).toEqual(["sync:progress"]);
  });
});

/**
 * The web host answers two kinds of command on the page: the gate and the browser's storage, in
 * `./index.ts`, and the two files, here in front of it. Each has to stay with its own answerer —
 * a storage command swallowed by this wrapper, or a file command sent on to the Worker, is a
 * page told nothing or told "no such command" by an engine that has no document.
 */
describe("the web host's two sets of page commands, composed as a build composes them", () => {
  /** The real web core over a Worker that only records, with a browser that keeps nothing. */
  function host() {
    const posted: ToWorker[] = [];
    let hear: ((event: { data: unknown }) => void) | undefined;
    const port = {
      postMessage: (message: ToWorker) => void posted.push(message),
      addEventListener: (type: string, listener: (event: { data: unknown }) => void) => {
        if (type === "message") hear = listener;
      },
    } as unknown as WorkerPort;
    const core = answeringFiles(createWebCore(() => port, "mtg-grimoire", { now: () => 0 }));
    const open = () =>
      hear?.({
        data: {
          kind: "opened",
          opened: { kind: "ready", journal: "delete", corpusJournal: "delete", schemaVersion: 59 },
        },
      });
    return { core, posted, open };
  }

  it("leaves the gate and the storage commands to the host behind it", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const { core, posted, open } = host();

    await expect(core.call("startup_status")).resolves.toEqual({ state: "loading" });
    open();
    await expect(core.call("startup_status")).resolves.toEqual({ state: "ready" });
    await expect(core.call(STORAGE_CLEARED)).resolves.toBeNull();
    await expect(core.call(STORAGE_CLEARED_DISMISS)).resolves.toBeNull();
    await expect(core.call(STORAGE_PERSISTENCE)).resolves.toBeNull();

    // Answered on the page, every one: the Worker was asked to open, and nothing else.
    expect(posted.map((message) => message.kind)).toEqual(["open"]);
  });

  it("answers the two files without the Worker, and sends an engine command to it", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const caught = catchDownloads();
    const { core, posted, open } = host();

    // Before anything has started the Worker: a file is the page's business, not the engine's.
    await expect(
      core.call("export_save_file", { fileName: "Burn.txt", contents: "x" }),
    ).resolves.toBe(true);
    expect(posted).toEqual([]);
    // The gate's first ask is what makes the Worker; then the database opens.
    await core.call("startup_status");
    open();
    const picked = core.call("import_pick_file");
    picker()?.dispatchEvent(new Event("cancel"));
    await expect(picked).resolves.toBeNull();
    void core.call("search_cards", { req: { text: "bolt" } });

    expect(caught).toHaveLength(1);
    expect(posted.filter((message) => message.kind === "call")).toEqual([
      expect.objectContaining({ command: "search_cards" }),
    ]);
  });
});
