import { describe, expect, it, vi } from "vitest";
import scannerAssetsRs from "../../../../../crates/grimoire-core/src/scanner_assets.rs?raw";
import type { ScannerAssetsOwed, ScannerAssetsProgress, ScannerStatus } from "@/lib/ipc";
import { HOST_SCANNER_UNAVAILABLE, SCANNER_NEEDS_SIMD, SCANNER_NOT_SHIPPED } from "../hostScanner";
import type { Core } from "../types";
import { NEURAL_FILES, NEURAL_PREFIX, neuralPath, SCANNER_ASSETS_PREFIX, SCANNER_CACHE } from "./assets";
import { LABELS_COMMAND } from "./protocol";
import { NEURAL_OTHER_SET, NEURAL_UNREACHABLE } from "./scanNeural";
import type { FromScanner, LoadFacts, ToScanner } from "./scanProtocol";
import {
  answeringScanner,
  CAPTURE_REFUSED,
  COULD_NOT_LOAD,
  COULD_NOT_START,
  FRAME_DEADLINE_MS,
  IDLE_MS,
  LOAD_DEADLINE_MS,
  MEMORY_COMMAND,
  NEURAL_COULD_NOT_START,
  NEURAL_REFUSED,
  NO_LABELS,
  NOT_DOWNLOADED,
  OTHER_FORMAT,
  REFUSAL_PACE_MS,
  RELOADING,
  RETRY_AFTER_MS,
  RETRY_MAX_MS,
  SIMD_PROBE,
  STOPPED,
  type ScanEnv,
  type ScanPort,
} from "./scanner";
import { ALREADY_FETCHING, UNREACHABLE } from "./scanStore";
import {
  answered,
  fakeBrowser,
  FILES,
  MANIFEST,
  NEURAL_SOURCE,
  NEURAL_TEST_FILES,
  settle,
} from "./scanTesting";

const FACTS: LoadFacts = {
  bundle: { loaded: true, entries: 2, error: null },
  labels: 7,
  models: { loaded: true, error: null },
  unapplied_filters: null,
};

/** A scanner Worker the test is the other end of. */
class FakePort implements ScanPort {
  posted: { message: ToScanner; transfer: ArrayBuffer[] }[] = [];
  terminated = false;
  private onMessage: ((event: { data: FromScanner }) => void) | undefined;
  private onError: ((event: { message?: string }) => void) | undefined;
  private onGarbled: ((event: unknown) => void) | undefined;

  postMessage(message: ToScanner, transfer: ArrayBuffer[]): void {
    this.posted.push({ message, transfer });
  }
  addEventListener(type: "message", listener: (event: { data: FromScanner }) => void): void;
  addEventListener(type: "error", listener: (event: { message?: string }) => void): void;
  addEventListener(type: "messageerror", listener: (event: unknown) => void): void;
  addEventListener(type: "message" | "error" | "messageerror", listener: unknown): void {
    if (type === "message") this.onMessage = listener as (event: { data: FromScanner }) => void;
    else if (type === "error") this.onError = listener as (event: { message?: string }) => void;
    else this.onGarbled = listener as (event: unknown) => void;
  }
  /** A message from the Worker that would not deserialise. */
  garble(): void {
    this.onGarbled?.({});
  }
  terminate(): void {
    this.terminated = true;
  }
  say(message: FromScanner): void {
    this.onMessage?.({ data: message });
  }
  crash(message?: string): void {
    this.onError?.({ message });
  }
  /** The last message posted, which must be of `kind`. */
  last<K extends ToScanner["kind"]>(kind: K): Extract<ToScanner, { kind: K }> {
    const message = this.posted[this.posted.length - 1]?.message;
    if (message?.kind !== kind) throw new Error(`the last message is ${message?.kind}, not ${kind}`);
    return message as Extract<ToScanner, { kind: K }>;
  }
  /** Answer the last message with `result`. */
  answer(result: unknown): void {
    const message = this.posted[this.posted.length - 1]?.message;
    if (!message) throw new Error("nothing was posted");
    this.say({ kind: "ok", id: message.id, result });
  }
}

const LABELS = new Uint8Array([9, 9, 9]);

function harness(
  over: Parameters<typeof fakeBrowser>[0] = {},
  own: Partial<ScanEnv> = {},
  /** What the engine answers the labels with; a rejection is a read it gave up on. */
  labels: () => Promise<Uint8Array> = () => Promise.resolve(LABELS.slice()),
) {
  const browser = fakeBrowser(over);
  const ports: FakePort[] = [];
  const innerCalls: string[] = [];
  const inner: Core = {
    call: vi.fn((command: string) => {
      innerCalls.push(command);
      // A copy each time: what is handed to the Worker is handed over.
      return command === LABELS_COMMAND ? labels() : Promise.resolve(null);
    }) as Core["call"],
    listen: vi.fn(() => () => undefined) as Core["listen"],
  };
  const env: ScanEnv = {
    ...browser.env,
    spawn: () => {
      const port = new FakePort();
      ports.push(port);
      return port;
    },
    simd: () => true,
    format: 3,
    pinned: {
      detectionModel: MANIFEST.files[1].sha256,
      recognitionModel: MANIFEST.files[2].sha256,
    },
    neural: NEURAL_SOURCE,
    ...own,
  };
  const core = answeringScanner(inner, env);
  const events: ScannerAssetsProgress[] = [];
  core.listen<ScannerAssetsProgress>("scanner:assets", (event) => events.push(event));
  /** Put the three files in the store, as a reader's press does. */
  const download = async (): Promise<ScannerAssetsOwed> => core.call("scanner_assets_fetch");
  /** Build the session: ask the status, answer the load, hand back the status. */
  const built = async (facts: LoadFacts = FACTS): Promise<ScannerStatus> => {
    const status = core.call<ScannerStatus>("scanner_status");
    await settle();
    ports[ports.length - 1]?.answer(facts);
    return status;
  };
  const refusal = (work: Promise<unknown>): Promise<unknown> => work.then(() => "it was not refused", (said) => said);
  return { core, inner, innerCalls, browser, ports, events, download, built, refusal };
}

describe("a browser with none of the scanner's files", () => {
  it("makes no Worker and asks for no module: the status says so, and the filters are owed", async () => {
    const { core, ports, browser, innerCalls } = harness();
    const status = await core.call<ScannerStatus>("scanner_status");
    expect(status).toEqual({
      bundle: { path: "/scanner-assets/card-hashes.bin", present: false, loaded: false, error: null, source: "store" },
      detection_model: { path: "/scanner-assets/text-detection.rten", present: false, loaded: false, error: null, source: "store" },
      recognition_model: { path: "/scanner-assets/text-recognition.rten", present: false, loaded: false, error: null, source: "store" },
      neural: { path: "/scanner-neural/", present: false, loaded: false, error: null, source: "store" },
      labels: 0,
      scans_dir: "",
      unapplied_filters: null,
    });
    expect(await core.call("scanner_set_filters", { filters: { sets: ["LTR"] } })).toBeNull();
    expect(await core.call("scanner_reset")).toBeNull();
    expect(ports).toEqual([]);
    // Only the manifest, to learn whether there is anything to fetch — and no engine either.
    expect(new Set(browser.asked)).toEqual(new Set([`${SCANNER_ASSETS_PREFIX}manifest.json`]));
    expect(innerCalls).toEqual([]);
  });

  it("refuses a frame in a sentence, a heartbeat late, so a loop of them is not a storm", async () => {
    const { core, browser, ports } = harness();
    let said: unknown;
    void core.call("scanner_frame", new Uint8Array([1])).catch((sentence: unknown) => (said = sentence));
    await settle();
    expect(said).toBeUndefined();
    browser.advance(REFUSAL_PACE_MS);
    await settle();
    expect(said).toBe(NOT_DOWNLOADED);
    expect(ports).toEqual([]);
  });

  it("offers all three with what they cost, and is told when the server has another build's", async () => {
    const { core } = harness();
    expect(await core.call("scanner_assets")).toEqual({
      owed: [
        { key: "bundle", label: "Card hashes", bytes: 700 },
        { key: "detectionModel", label: "Text detection model", bytes: 300 },
        { key: "recognitionModel", label: "Text recognition model", bytes: 500 },
      ],
      bytes: 1500,
      fetching: false,
    });
    const other = harness({}, { format: 4 });
    expect(await other.refusal(other.core.call("scanner_assets"))).toBe(OTHER_FORMAT);
    expect(await other.refusal(other.core.call("scanner_assets_fetch"))).toBe(OTHER_FORMAT);
  });

  it("says a build made without the files has no scanner, in the sentence the page stays quiet on", async () => {
    const missing = { [`${SCANNER_ASSETS_PREFIX}manifest.json`]: () => answered("Not found", { status: 404 }) };
    const { core, refusal, ports } = harness(missing);
    for (const command of ["scanner_status", "scanner_set_filters", "scanner_assets", "scanner_assets_fetch"]) {
      expect(await refusal(core.call(command, { filters: {} })), command).toBe(SCANNER_NOT_SHIPPED);
    }
    expect(HOST_SCANNER_UNAVAILABLE).toContain(SCANNER_NOT_SHIPPED);
    expect(ports).toEqual([]);
  });
});

describe("a browser that cannot run the scanner's module", () => {
  it("is told before anything is fetched or made, by every command of the session and its files", async () => {
    const { core, refusal, ports, browser } = harness({}, { simd: () => false });
    for (const command of ["scanner_status", "scanner_set_filters", "scanner_reset", "scanner_assets", "scanner_assets_fetch"]) {
      expect(await refusal(core.call(command, { filters: {} })), command).toBe(SCANNER_NEEDS_SIMD);
    }
    expect(HOST_SCANNER_UNAVAILABLE).toContain(SCANNER_NEEDS_SIMD);
    expect(ports).toEqual([]);
    expect(browser.asked).toEqual([]);
  });

  it("probes with a module real engines validate", () => {
    // Node's V8 has SIMD, as every browser this app's engine runs in does.
    expect(WebAssembly.validate(SIMD_PROBE)).toBe(true);
  });

  it("is never asked twice once a Worker has said the module will not compile", async () => {
    const { core, download, ports, refusal } = harness();
    await download();
    const first = refusal(core.call("scanner_status"));
    await settle();
    ports[0].say({ kind: "unloaded", id: ports[0].last("load").id, unsupported: true, message: "CompileError: Wasm SIMD unsupported" });
    expect(await first).toBe(SCANNER_NEEDS_SIMD);
    expect(ports[0].terminated).toBe(true);
    expect(await refusal(core.call("scanner_set_filters", { filters: {} }))).toBe(SCANNER_NEEDS_SIMD);
    expect(await refusal(core.call("scanner_assets"))).toBe(SCANNER_NEEDS_SIMD);
    expect(ports).toHaveLength(1);
  });
});

describe("the download", () => {
  it("fetches what is owed, says how far it has got, and owes nothing afterwards", async () => {
    const { core, download, events, browser } = harness();
    expect(await download()).toEqual({ owed: [], bytes: 0, fetching: false });
    // The core's sequence: each file, then the pair of models once more, then done.
    expect(events.map((event) => `${event.phase}:${event.file}`)).toEqual([
      "downloading:bundle",
      "checking:bundle",
      "downloading:detectionModel",
      "checking:detectionModel",
      "downloading:recognitionModel",
      "checking:recognitionModel",
      "checking:recognitionModel",
      "done:null",
    ]);
    expect(events[events.length - 1]).toEqual({ phase: "done", file: null, done: 1500, total: 1500, message: null });
    expect(events.every((event) => event.total === 1500)).toBe(true);
    const fetched = browser.asked.filter((path) => !path.endsWith("manifest.json"));
    expect(fetched).toEqual(Object.keys(FILES).map((name) => SCANNER_ASSETS_PREFIX + name));
    expect(await core.call("scanner_assets")).toEqual({ owed: [], bytes: 0, fetching: false });
  });

  it("says the four words the core says, and no fifth", async () => {
    const core = [...scannerAssetsRs.matchAll(/pub const PHASE_\w+: &str = "(\w+)";/g)].map((m) => m[1]);
    expect(core.sort()).toEqual(["checking", "done", "downloading", "error"]);
    const landed = harness();
    await landed.download();
    const broken = harness({ [`${SCANNER_ASSETS_PREFIX}card-hashes.bin`]: () => answered("no", { status: 503 }) });
    await broken.download().catch(() => undefined);
    const said = new Set([...landed.events, ...broken.events].map((event) => event.phase));
    expect([...said].sort()).toEqual(core);
  });

  it("is one at a time, and says it is running to whoever asks meanwhile", async () => {
    let release!: () => void;
    const held = new Promise<void>((done) => (release = done));
    const slow = { [`${SCANNER_ASSETS_PREFIX}card-hashes.bin`]: () => held.then(() => answered(FILES["card-hashes.bin"])) };
    const { core, download, refusal } = harness(slow);
    const first = download();
    await settle();
    expect(await refusal(core.call("scanner_assets_fetch"))).toBe(ALREADY_FETCHING);
    expect(await core.call<ScannerAssetsOwed>("scanner_assets")).toMatchObject({ fetching: true, bytes: 1500 });
    release();
    expect((await first).fetching).toBe(false);
    expect(await core.call<ScannerAssetsOwed>("scanner_assets")).toMatchObject({ fetching: false, owed: [] });
  });

  it("keeps a file that landed before a later one failed, and says the failure once", async () => {
    const broken = { [`${SCANNER_ASSETS_PREFIX}text-recognition.rten`]: () => answered("no", { status: 503 }) };
    const { core, download, refusal, events } = harness(broken);
    const said = await refusal(download());
    expect(said).toMatch(/Text recognition model could not be downloaded: the server answered 503/);
    expect(events[events.length - 1]).toEqual({ phase: "error", file: null, done: 0, total: 0, message: said });
    expect((await core.call<ScannerAssetsOwed>("scanner_assets")).owed.map((row) => row.key)).toEqual(["recognitionModel"]);
  });

  it("owes nothing it can say when the origin is gone and all three are in hand", async () => {
    const { core, download, browser, refusal } = harness();
    await download();
    const gone = () => Promise.reject(new TypeError("Failed to fetch"));
    const offline = harness({ [`${SCANNER_ASSETS_PREFIX}manifest.json`]: gone }, { caches: browser.caches });
    expect(await offline.core.call("scanner_assets")).toEqual({ owed: [], bytes: 0, fetching: false });
    expect(await core.call("scanner_assets")).toMatchObject({ owed: [] });
    void refusal;
  });

  it("still offers the files when the origin cannot be reached, and the press says why", async () => {
    // Refused, the page drew no offer and no reason: a reader offline who had never downloaded
    // had nothing to press. The sizes are the core's own figures, the manifest's being out of reach.
    const gone = () => Promise.reject(new TypeError("Failed to fetch"));
    const bare = harness({ [`${SCANNER_ASSETS_PREFIX}manifest.json`]: gone });
    expect(await bare.core.call("scanner_assets")).toEqual({
      owed: [
        { key: "bundle", label: "Card hashes", bytes: 5_874_752 },
        { key: "detectionModel", label: "Text detection model", bytes: 2_510_284 },
        { key: "recognitionModel", label: "Text recognition model", bytes: 9_716_568 },
      ],
      bytes: 18_101_604,
      fetching: false,
    });
    expect(await bare.refusal(bare.download())).toBe(UNREACHABLE);
    expect(bare.events).toEqual([{ phase: "error", file: null, done: 0, total: 0, message: UNREACHABLE }]);
    // Nothing but the manifest was asked for: there was nothing to fetch a file by.
    expect(new Set(bare.browser.asked)).toEqual(new Set([`${SCANNER_ASSETS_PREFIX}manifest.json`]));
    // With one file in hand and the origin gone, only the others are offered.
    const some = harness({ [`${SCANNER_ASSETS_PREFIX}text-recognition.rten`]: () => answered("no", { status: 503 }) });
    await some.download().catch(() => undefined);
    const later = harness({ [`${SCANNER_ASSETS_PREFIX}manifest.json`]: gone }, { caches: some.browser.caches });
    expect((await later.core.call<ScannerAssetsOwed>("scanner_assets")).owed.map((row) => row.key)).toEqual(["recognitionModel"]);
  });
});

describe("a session", () => {
  it("is built from the store and the engine's labels, every buffer handed over, the owed filters first", async () => {
    const { core, download, built, ports, innerCalls } = harness();
    await core.call("scanner_set_filters", { filters: { sets: ["LTR"] } });
    await download();
    const status = await built();
    expect(ports).toHaveLength(1);
    expect(innerCalls).toEqual([LABELS_COMMAND]);
    const { message, transfer } = ports[0].posted[0];
    if (message.kind !== "load") throw new Error("not a load");
    expect(message.filters).toBe('{"sets":["LTR"]}');
    expect(message.bundle).toEqual(FILES["card-hashes.bin"]);
    expect(message.labels).toEqual(LABELS);
    expect(message.detection).toEqual(FILES["text-detection.rten"]);
    expect(message.recognition).toEqual(FILES["text-recognition.rten"]);
    expect(transfer).toHaveLength(4);
    expect(status).toMatchObject({
      bundle: { present: true, loaded: true, error: null, source: "store" },
      detection_model: { present: true, loaded: true, source: "store" },
      recognition_model: { present: true, loaded: true, source: "store" },
      labels: 7,
      unapplied_filters: null,
    });
  });

  it("composes the status from each thing a load can say", async () => {
    const said = async (facts: LoadFacts): Promise<ScannerStatus> => {
      const { download, built } = harness();
      await download();
      return built(facts);
    };
    const unread = await said({ ...FACTS, bundle: { loaded: false, entries: 0, error: "bad version" }, labels: 0 });
    expect(unread.bundle).toMatchObject({ present: true, loaded: false, error: "bad version" });
    const unnamed = await said({ ...FACTS, labels: 0 });
    expect(unnamed.bundle).toMatchObject({ loaded: true, error: NO_LABELS });
    const garbled = await said({ ...FACTS, bundle: { loaded: true, entries: 2, error: "labels: cut short" }, labels: 0 });
    expect(garbled.bundle.error).toBe("labels: cut short");
    const blind = await said({ ...FACTS, models: { loaded: false, error: "not a model" } });
    expect(blind.detection_model).toMatchObject({ present: true, loaded: false, error: "not a model" });
    expect(blind.recognition_model).toMatchObject({ present: true, loaded: false, error: "not a model" });
    const owed = await said({ ...FACTS, unapplied_filters: "no labels to filter by" });
    expect(owed.unapplied_filters).toBe("no labels to filter by");
  });

  it("does not call a bundle with no card in it loaded", async () => {
    const { download, built } = harness();
    await download();
    const status = await built({ ...FACTS, bundle: { loaded: true, entries: 0, error: null }, labels: 0 });
    expect(status.bundle).toMatchObject({ present: true, loaded: false, error: "it holds no cards" });
  });

  it("offers nothing from a manifest whose models are not the ones written down", async () => {
    const other = harness({}, { pinned: { detectionModel: "0".repeat(64), recognitionModel: MANIFEST.files[2].sha256 } });
    expect(await other.refusal(other.core.call("scanner_assets"))).toBe(OTHER_FORMAT);
    expect(await other.refusal(other.core.call("scanner_assets_fetch"))).toBe(OTHER_FORMAT);
  });

  it("hands the module no model that was kept under another digest", async () => {
    const { download, browser } = harness();
    await download();
    // The same store, read by a version that pins another detection model.
    const later = harness({}, { caches: browser.caches, pinned: { detectionModel: "0".repeat(64) } });
    void later.core.call("scanner_status").catch(() => undefined);
    await settle();
    const load = later.ports[0].last("load");
    expect(load.detection).toBeNull();
    expect(load.recognition).toEqual(FILES["text-recognition.rten"]);
    expect(load.bundle).toEqual(FILES["card-hashes.bin"]);
  });

  it("tells a read of the names the engine gave up on from an empty corpus, and asks again", async () => {
    let refuse = true;
    const gaveUp = "the scanner's labels could not be read: the card database changed under each of 12 attempts";
    const { core, download, built, ports } = harness({}, {}, () =>
      refuse ? Promise.reject(gaveUp) : Promise.resolve(LABELS.slice()),
    );
    await download();
    const nameless = await built({ ...FACTS, labels: 0 });
    expect(ports[0].last("load").labels).toBeNull();
    // Not "the card database had no cards": it has, and they are a moment away.
    expect(nameless.bundle).toMatchObject({ loaded: true, error: `labels: ${gaveUp}` });
    expect(nameless.bundle.error).not.toBe(NO_LABELS);
    refuse = false;
    const again = core.call<ScannerStatus>("scanner_status");
    await settle();
    expect(ports).toHaveLength(2);
    expect(ports[1].last("load").labels).toEqual(LABELS);
    ports[1].answer(FACTS);
    expect((await again).bundle.error).toBeNull();
  });

  it("asks the engine for the names again when the one it has was built without any", async () => {
    const { core, download, built, ports } = harness();
    await download();
    await built({ ...FACTS, labels: 0 });
    // The mount's own second ask is not a reason: only a status this session already gave.
    const again = core.call<ScannerStatus>("scanner_status");
    await settle();
    expect(ports).toHaveLength(2);
    expect(ports[0].terminated).toBe(true);
    ports[1].answer(FACTS);
    expect((await again).labels).toBe(7);
    await core.call("scanner_status");
    expect(ports).toHaveLength(2);
  });

  it("sends a frame's bytes across without a copy, split at the detail header, and answers the verdict", async () => {
    const { core, download, built, ports } = harness();
    await download();
    await built();
    const body = new Uint8Array([1, 2, 3, 8, 8]);
    const buffer = body.buffer;
    const verdict = core.call("scanner_frame", body, {
      headers: { "x-scanner-options": '{"mode":"fast"}', "x-scanner-detail": "3" },
    });
    await settle();
    const { message, transfer } = ports[0].posted[ports[0].posted.length - 1]!;
    if (message.kind !== "frame") throw new Error("not a frame");
    expect([...message.jpeg]).toEqual([1, 2, 3]);
    expect([...(message.detail ?? [])]).toEqual([8, 8]);
    expect(message.options).toBe('{"mode":"fast"}');
    expect(transfer).toEqual([buffer]);
    ports[0].answer({ ok: true, decision_seq: 4 });
    expect(await verdict).toEqual({ ok: true, decision_seq: 4 });
  });

  it("refuses a frame it cannot split in the engine's words, and passes the module's own refusal on", async () => {
    const { core, download, built, ports, refusal } = harness();
    await download();
    await built();
    const bad = refusal(core.call("scanner_frame", new Uint8Array(4), { headers: { "x-scanner-detail": "9" } }));
    expect(await bad).toMatch(/the frame's detail length is 9 bytes but the body is 4/);
    const pushed = refusal(core.call("scanner_set_filters", { filters: { sets: ["XXX"] } }));
    await settle();
    ports[0].say({ kind: "err", id: ports[0].last("filters").id, message: "these filters match no printing" });
    expect(await pushed).toBe("these filters match no printing");
  });

  it("keeps the filters the module accepted for the next session, and not the ones it refused", async () => {
    const { core, download, built, ports, browser } = harness();
    await download();
    await built({ ...FACTS, unapplied_filters: "no labels to filter by" });
    const accepted = core.call("scanner_set_filters", { filters: { sets: ["MH2"] } });
    await settle();
    ports[0].answer(null);
    await accepted;
    // An accepted push settles what a reload owed.
    expect((await core.call<ScannerStatus>("scanner_status")).unapplied_filters).toBeNull();
    const refused = core.call("scanner_set_filters", { filters: { sets: ["XXX"] } }).catch(() => undefined);
    await settle();
    ports[0].say({ kind: "err", id: ports[0].last("filters").id, message: "no" });
    await refused;

    browser.advance(IDLE_MS);
    expect(ports[0].terminated).toBe(true);
    void core.call("scanner_status");
    await settle();
    expect(ports[1].last("load").filters).toBe('{"sets":["MH2"]}');
  });
});

describe("the Worker's life", () => {
  it("ends when the Scanner has been left, and not while its heartbeat is heard", async () => {
    const { core, download, built, ports, browser, innerCalls } = harness();
    await download();
    await built();
    for (let beat = 0; beat < 40; beat += 1) {
      browser.advance(1000);
      await core.call("scanner_hold");
    }
    expect(ports[0].terminated).toBe(false);
    expect(innerCalls.filter((command) => command === "scanner_hold")).toHaveLength(40);
    const memory = core.call(MEMORY_COMMAND);
    await settle();
    ports[0].answer(86_000_000);
    expect(await memory).toBe(86_000_000);

    browser.advance(IDLE_MS - 1);
    expect(ports[0].terminated).toBe(false);
    browser.advance(REFUSAL_PACE_MS);
    expect(ports[0].terminated).toBe(true);
    expect(await core.call(MEMORY_COMMAND)).toBeNull();
    // The next command builds another, from the store and the engine again.
    const again = core.call<ScannerStatus>("scanner_status");
    await settle();
    ports[1].answer(FACTS);
    expect((await again).labels).toBe(7);
    expect(innerCalls.filter((command) => command === LABELS_COMMAND)).toHaveLength(2);
  });

  it("is not ended under a frame it has not answered", async () => {
    const { core, download, built, ports, browser } = harness();
    await download();
    await built();
    const verdict = core.call("scanner_frame", new Uint8Array([1]));
    await settle();
    // Past the idle rule, and short of the frame's own deadline.
    browser.advance(IDLE_MS + 5_000);
    expect(ports[0].terminated).toBe(false);
    ports[0].answer({ ok: true });
    await verdict;
    browser.advance(IDLE_MS + REFUSAL_PACE_MS);
    expect(ports[0].terminated).toBe(true);
  });

  it("ends on a trap, refuses what was in flight in one sentence, and builds a new one for the next command", async () => {
    const { core, download, built, ports, refusal } = harness();
    await download();
    await built();
    const frame = refusal(core.call("scanner_frame", new Uint8Array([1])));
    const reset = refusal(core.call("scanner_reset"));
    await settle();
    ports[0].say({ kind: "trapped", id: ports[0].posted[1].message.id, message: "RuntimeError: unreachable" });
    expect(await frame).toBe(STOPPED);
    expect(await reset).toBe(STOPPED);
    expect(ports[0].terminated).toBe(true);
    // What the dead Worker says after that is not heard.
    ports[0].say({ kind: "ok", id: 99, result: null });

    const next = core.call("scanner_frame", new Uint8Array([2]));
    await settle();
    expect(ports).toHaveLength(2);
    ports[1].answer(FACTS);
    await settle();
    ports[1].answer({ ok: true });
    expect(await next).toEqual({ ok: true });
  });

  it("ends a Worker that has not answered a frame by its deadline, and the next command builds another", async () => {
    // A Worker that hung, or that the browser ended without a word, raises nothing. Unsettled,
    // the frame held the page's loop for good and the idle rule could never fire.
    const { core, download, built, ports, refusal, browser } = harness();
    await download();
    await built();
    const frame = refusal(core.call("scanner_frame", new Uint8Array([1])));
    const reset = refusal(core.call("scanner_reset"));
    await settle();
    browser.advance(FRAME_DEADLINE_MS - 1_000);
    expect(ports[0].terminated).toBe(false);
    browser.advance(1_000);
    expect(ports[0].terminated).toBe(true);
    expect(await frame).toBe(STOPPED);
    expect(await reset).toBe(STOPPED);
    // A frame's deadline is a frame's: nothing is waited out before the next build.
    void core.call("scanner_status").catch(() => undefined);
    await settle();
    expect(ports).toHaveLength(2);
  });

  it("gives a load longer, ends it too, and counts it as a build that failed", async () => {
    const { core, download, ports, refusal, browser } = harness();
    await download();
    const status = refusal(core.call("scanner_status"));
    await settle();
    // The watch ticks from the moment the Worker is made, not from the load's answer.
    browser.advance(LOAD_DEADLINE_MS - 1_000);
    expect(ports[0].terminated).toBe(false);
    expect(LOAD_DEADLINE_MS).toBeGreaterThan(FRAME_DEADLINE_MS);
    browser.advance(1_000);
    expect(ports[0].terminated).toBe(true);
    expect(await status).toBe(STOPPED);
    expect(await refusal(core.call("scanner_status"))).toBe(COULD_NOT_START);
    expect(ports).toHaveLength(1);
  });

  it("waits longer after each build that traps, says one sentence meanwhile, and starts over once one loads", async () => {
    // A phone that cannot grow the module's memory traps on every load. Built again by each
    // paced frame, that was the store read, the labels asked and a module compiled once a second.
    const { core, download, ports, refusal, browser, innerCalls } = harness();
    await download();
    const trapOnLoad = async (): Promise<unknown> => {
      const before = ports.length;
      const status = refusal(core.call("scanner_status"));
      await settle();
      expect(ports).toHaveLength(before + 1);
      const port = ports[ports.length - 1];
      port.say({ kind: "trapped", id: port.last("load").id, message: "RuntimeError: unreachable" });
      return status;
    };
    const waits = [RETRY_AFTER_MS, RETRY_AFTER_MS * 2, RETRY_AFTER_MS * 4];
    for (const wait of waits) {
      expect(await trapOnLoad()).toBe(STOPPED);
      const made = ports.length;
      const labelled = innerCalls.length;
      // Waited out: one sentence, and nothing read, asked or made.
      browser.advance(wait - 1_000);
      expect(await refusal(core.call("scanner_status"))).toBe(COULD_NOT_START);
      expect(await refusal(core.call("scanner_set_filters", { filters: {} }))).toBe(COULD_NOT_START);
      let said: unknown;
      void core.call("scanner_frame", new Uint8Array([1])).catch((sentence: unknown) => (said = sentence));
      await settle();
      expect(said).toBeUndefined();
      expect(ports).toHaveLength(made);
      expect(innerCalls).toHaveLength(labelled);
      browser.advance(1_000);
      await settle();
      expect(said).toBe(COULD_NOT_START);
    }
    // Never past the ceiling, however many in a row.
    expect(RETRY_AFTER_MS * 2 ** 10).toBeGreaterThan(RETRY_MAX_MS);
    // A load that answers starts the count over: the next failure waits the first wait again.
    const status = core.call<ScannerStatus>("scanner_status");
    await settle();
    ports[ports.length - 1].answer(FACTS);
    await status;
    browser.advance(IDLE_MS + 1_000);
    expect(await trapOnLoad()).toBe(STOPPED);
    browser.advance(RETRY_AFTER_MS);
    void core.call("scanner_status").catch(() => undefined);
    await settle();
    expect(ports).toHaveLength(waits.length + 3);
  });

  it("does not wait out a trap under a frame: that is the frame's, and the next command builds", async () => {
    const { core, download, built, ports, refusal } = harness();
    await download();
    await built();
    const frame = refusal(core.call("scanner_frame", new Uint8Array([1])));
    await settle();
    ports[0].say({ kind: "trapped", id: ports[0].last("frame").id, message: "RuntimeError: unreachable" });
    expect(await frame).toBe(STOPPED);
    void core.call("scanner_status").catch(() => undefined);
    await settle();
    expect(ports).toHaveLength(2);
  });

  it("posts nothing to a Worker another caller's turn has just ended", async () => {
    // A status that finds its session nameless builds again — between a frame's own wait for
    // the session and its post. The port the frame holds is terminated by then.
    const { core, download, built, ports, refusal } = harness();
    await download();
    await built({ ...FACTS, labels: 0 });
    const status = core.call<ScannerStatus>("scanner_status").catch(() => undefined);
    const frame = refusal(core.call("scanner_frame", new Uint8Array([1])));
    await settle();
    expect(ports[0].terminated).toBe(true);
    expect(ports[0].posted.map(({ message }) => message.kind)).toEqual(["load"]);
    expect(await frame).toBe(STOPPED);
    ports[1].answer(FACTS);
    await status;
  });

  it("treats a message that would not deserialise as the Worker failing", async () => {
    const { core, download, built, ports, refusal } = harness();
    await download();
    await built();
    const frame = refusal(core.call("scanner_frame", new Uint8Array([1])));
    await settle();
    ports[0].garble();
    expect(await frame).toBe(STOPPED);
    expect(ports[0].terminated).toBe(true);
  });

  it("ends on the Worker's own error too, and waits before making another", async () => {
    const { core, download, ports, refusal, browser } = harness();
    await download();
    const status = refusal(core.call("scanner_status"));
    await settle();
    ports[0].crash("Script error.");
    expect(await status).toBe(STOPPED);
    expect(await refusal(core.call("scanner_status"))).toBe(COULD_NOT_LOAD);
    expect(ports).toHaveLength(1);
    browser.advance(RETRY_AFTER_MS);
    void core.call("scanner_status").catch(() => undefined);
    await settle();
    expect(ports).toHaveLength(2);
  });

  it("does not make a Worker a frame for a module that will not arrive", async () => {
    const { core, download, ports, refusal, browser } = harness();
    await download();
    const status = refusal(core.call("scanner_status"));
    await settle();
    ports[0].say({ kind: "unloaded", id: ports[0].last("load").id, unsupported: false, message: "TypeError: Failed to fetch" });
    expect(await status).toBe(COULD_NOT_LOAD);
    let said: unknown;
    void core.call("scanner_frame", new Uint8Array([1])).catch((sentence: unknown) => (said = sentence));
    await settle();
    expect(said).toBeUndefined();
    browser.advance(REFUSAL_PACE_MS);
    await settle();
    expect(said).toBe(COULD_NOT_LOAD);
    expect(ports).toHaveLength(1);
  });

  it("lets the session go when a download lands, so the next command reads what arrived", async () => {
    let healed = false;
    const flaky = {
      [`${SCANNER_ASSETS_PREFIX}text-recognition.rten`]: () =>
        healed ? answered(FILES["text-recognition.rten"]) : answered("no", { status: 503 }),
    };
    const { core, download, built, ports, refusal } = harness(flaky);
    await download().catch(() => undefined);
    const partial = await built({ ...FACTS, models: { loaded: false, error: "one model without the other" } });
    expect(partial.recognition_model.present).toBe(false);
    expect(ports[0].last("load").recognition).toBeNull();

    const frame = refusal(core.call("scanner_frame", new Uint8Array([1])));
    await settle();
    healed = true;
    expect((await download()).owed).toEqual([]);
    expect(ports[0].terminated).toBe(true);
    expect(await frame).toBe(RELOADING);
    const whole = await built();
    expect(ports[1].last("load").recognition).toEqual(FILES["text-recognition.rten"]);
    expect(whole.recognition_model).toMatchObject({ present: true, loaded: true });
  });
});

describe("the Neural mode's files", () => {
  const NEURAL_OPTIONS = { "x-scanner-options": '{"mode":"neural","previews":false}' };
  const PATHS = NEURAL_FILES.map((name) => neuralPath(NEURAL_SOURCE.set, name));
  const kinds = (port: FakePort): string[] => port.posted.map(({ message }) => message.kind);
  const lastKind = (port: FakePort): string | undefined => port.posted[port.posted.length - 1]?.message.kind;
  /** Let the page work until `check` holds — a fetch of four files is many turns deep. */
  const until = async (check: () => boolean): Promise<void> => {
    for (let turn = 0; turn < 5_000 && !check(); turn += 1) await Promise.resolve();
    if (!check()) throw new Error("it never happened");
  };

  /** A session built from the store, and a way to send it a Neural frame. */
  async function scanning(over: Parameters<typeof harness>[0] = {}) {
    const h = harness(over);
    await h.download();
    await h.built();
    const neuralFrame = (): Promise<unknown> =>
      h.core.call("scanner_frame", new Uint8Array([1, 2]), { headers: NEURAL_OPTIONS });
    /** A Neural frame that is refused: what it was refused with, a heartbeat late. */
    const refusedFrame = async (): Promise<unknown> => {
      let said: unknown = "it was not refused";
      neuralFrame().catch((sentence: unknown) => (said = sentence));
      await settle(600);
      h.browser.advance(REFUSAL_PACE_MS);
      await settle(50);
      return said;
    };
    const fetched = (): string[] => h.browser.asked.filter((path) => path.startsWith(NEURAL_PREFIX));
    return { ...h, neuralFrame, refusedFrame, fetched };
  }

  /** The first Neural frame on `port`, the hand-over answered `ok` and the frame answered. */
  async function firstNeuralFrame(s: Awaited<ReturnType<typeof scanning>>, port: FakePort): Promise<void> {
    const verdict = s.neuralFrame();
    await until(() => kinds(port).includes("neural"));
    port.answer(null);
    await until(() => lastKind(port) === "frame");
    port.answer({ ok: true, mode: "neural" });
    expect(await verdict).toEqual({ ok: true, mode: "neural" });
  }

  it("are never asked for by a Fast or an Exact frame, and the status says none are here", async () => {
    const { core, ports, browser, fetched } = await scanning();
    for (const options of ['{"mode":"fast"}', '{"mode":"exact"}', "{}", undefined]) {
      const headers = options === undefined ? undefined : { "x-scanner-options": options };
      const verdict = core.call("scanner_frame", new Uint8Array([1]), { headers });
      await settle();
      ports[0].answer({ ok: true });
      await verdict;
    }
    expect(kinds(ports[0])).toEqual(["load", "frame", "frame", "frame", "frame"]);
    expect(fetched()).toEqual([]);
    // What was fetched was the Download's, and nothing since.
    expect(browser.asked.every((path) => path.startsWith(SCANNER_ASSETS_PREFIX))).toBe(true);
    expect((await core.call<ScannerStatus>("scanner_status")).neural).toEqual({
      path: "/scanner-neural/",
      present: false,
      loaded: false,
      error: null,
      source: "store",
    });
  });

  it("are fetched by the first Neural frame, handed over whole, and only then is the frame sent", async () => {
    const s = await scanning();
    const { core, ports, browser, fetched } = s;
    const verdict = s.neuralFrame();
    await until(() => kinds(ports[0]).includes("neural"));
    // One after another, in `load_neural`'s order, past nothing but the HTTP cache.
    expect(fetched()).toEqual(PATHS);
    const asked = browser.asked.map((path, at) => [path, browser.modes[at]]);
    expect(asked.filter(([path]) => path.startsWith(NEURAL_PREFIX)).map(([, mode]) => mode)).toEqual(
      NEURAL_FILES.map(() => "default"),
    );
    const { message, transfer } = ports[0].posted[1];
    if (message.kind !== "neural") throw new Error("not the Neural files");
    expect(message.detector).toEqual(NEURAL_TEST_FILES["detector.onnx"]);
    expect(message.embedder).toEqual(NEURAL_TEST_FILES["embedder.onnx"]);
    expect(message.gallery).toEqual(NEURAL_TEST_FILES["gallery.bin"]);
    expect(message.meta).toEqual(NEURAL_TEST_FILES["neural.json"]);
    // Every buffer handed over: the page keeps none of the four.
    expect(transfer).toEqual([message.detector.buffer, message.embedder.buffer, message.gallery.buffer, message.meta.buffer]);
    // The frame waits for the hand-over's answer.
    await settle();
    expect(kinds(ports[0])).toEqual(["load", "neural"]);
    ports[0].answer(null);
    await until(() => kinds(ports[0]).length === 3);
    expect(ports[0].last("frame").options).toBe(NEURAL_OPTIONS["x-scanner-options"]);
    ports[0].answer({ ok: true, decision_seq: 1 });
    expect(await verdict).toEqual({ ok: true, decision_seq: 1 });

    // Once a Worker: the next Neural frame is sent as it comes.
    const next = s.neuralFrame();
    await settle();
    expect(kinds(ports[0])).toEqual(["load", "neural", "frame", "frame"]);
    ports[0].answer({ ok: true });
    await next;
    expect(fetched()).toEqual(PATHS);
    expect((await core.call<ScannerStatus>("scanner_status")).neural).toEqual({
      path: "/scanner-neural/",
      present: true,
      loaded: true,
      error: null,
      source: "store",
    });
  });

  it("are fetched once for frames that arrive while they are on their way", async () => {
    let release!: () => void;
    const held = new Promise<void>((done) => (release = done));
    const slow = { [PATHS[2]]: () => held.then(() => answered(NEURAL_TEST_FILES["gallery.bin"])) };
    const s = await scanning(slow);
    const one = s.neuralFrame();
    const two = s.neuralFrame();
    await settle(200);
    release();
    await until(() => kinds(s.ports[0]).includes("neural"));
    s.ports[0].answer(null);
    await until(() => kinds(s.ports[0]).length === 4);
    expect(kinds(s.ports[0])).toEqual(["load", "neural", "frame", "frame"]);
    s.ports[0].say({ kind: "ok", id: s.ports[0].posted[2].message.id, result: { ok: true } });
    s.ports[0].say({ kind: "ok", id: s.ports[0].posted[3].message.id, result: { ok: true } });
    await Promise.all([one, two]);
    expect(s.fetched()).toEqual(PATHS);
  });

  it("are posted again to a Worker made again, on its first Neural frame", async () => {
    const s = await scanning();
    await firstNeuralFrame(s, s.ports[0]);
    // The reader left: the Worker, and the files in it, are gone.
    s.browser.advance(IDLE_MS + 1_000);
    expect(s.ports[0].terminated).toBe(true);
    // The next Neural frame builds a Worker, and hands it the files again before it is sent.
    const verdict = s.neuralFrame();
    await until(() => s.ports.length === 2);
    s.ports[1].answer(FACTS);
    await until(() => kinds(s.ports[1]).includes("neural"));
    s.ports[1].answer(null);
    await until(() => lastKind(s.ports[1]) === "frame");
    s.ports[1].answer({ ok: true });
    expect(await verdict).toEqual({ ok: true });
    expect(kinds(s.ports[1])).toEqual(["load", "neural", "frame"]);
    expect(s.fetched()).toEqual([...PATHS, ...PATHS]);
  });

  it("are not posted to a Worker that was ended while they were on their way", async () => {
    let release!: () => void;
    const held = new Promise<void>((done) => (release = done));
    const slow = { [PATHS[0]]: () => held.then(() => answered(NEURAL_TEST_FILES["detector.onnx"])) };
    const s = await scanning(slow);
    let said: unknown;
    s.neuralFrame().catch((sentence: unknown) => (said = sentence));
    await settle(100);
    s.browser.advance(IDLE_MS + 1_000);
    expect(s.ports[0].terminated).toBe(true);
    release();
    await settle(600);
    s.browser.advance(REFUSAL_PACE_MS);
    await settle(50);
    expect(said).toBe(STOPPED);
    expect(kinds(s.ports[0])).toEqual(["load"]);
    // The Worker's ending is no failure of the files: the next frame's Worker is handed them.
    const status = s.core.call<ScannerStatus>("scanner_status");
    await until(() => s.ports.length === 2);
    s.ports[1].answer(FACTS);
    expect((await status).neural.error).toBeNull();
    await firstNeuralFrame(s, s.ports[1]);
  });

  it("that cannot be fetched are the frame's refusal, waited out, and asked for again after", async () => {
    let down = true;
    const flaky = {
      [PATHS[1]]: () => (down ? answered("no", { status: 503 }) : answered(NEURAL_TEST_FILES["embedder.onnx"])),
    };
    const s = await scanning(flaky);
    const sentence = "The Neural scanner's files could not be downloaded: the server answered 503.";
    expect(await s.refusedFrame()).toBe(sentence);
    expect(kinds(s.ports[0])).toEqual(["load"]);
    expect((await s.core.call<ScannerStatus>("scanner_status")).neural).toMatchObject({
      present: false,
      loaded: false,
      error: sentence,
    });
    // Waited out: the same sentence, and nothing asked of the origin.
    const asked = s.fetched().length;
    expect(await s.refusedFrame()).toBe(sentence);
    expect(s.fetched()).toHaveLength(asked);
    // A Fast frame meanwhile is a Fast frame.
    const fast = s.core.call("scanner_frame", new Uint8Array([1]), { headers: { "x-scanner-options": '{"mode":"fast"}' } });
    await settle();
    s.ports[0].answer({ ok: true });
    expect(await fast).toEqual({ ok: true });

    down = false;
    s.browser.advance(RETRY_AFTER_MS);
    await firstNeuralFrame(s, s.ports[0]);
    expect((await s.core.call<ScannerStatus>("scanner_status")).neural).toMatchObject({ loaded: true, error: null });
  });

  it("refuses an origin that is gone, a set the server no longer has, a page and a file of another length", async () => {
    const gone = await scanning({ [PATHS[0]]: () => Promise.reject(new TypeError("Failed to fetch")) });
    expect(await gone.refusedFrame()).toBe(NEURAL_UNREACHABLE);
    const redeployed = await scanning({ [PATHS[3]]: () => answered("Not found", { status: 404 }) });
    expect(await redeployed.refusedFrame()).toBe(NEURAL_OTHER_SET);
    const page = await scanning({ [PATHS[2]]: () => answered("<!doctype html>", { type: "text/html" }) });
    expect(await page.refusedFrame()).toBe(
      "The Neural scanner's files could not be downloaded: the server answered a page, not the file.",
    );
    const longer = new Uint8Array(NEURAL_TEST_FILES["embedder.onnx"].byteLength + 1);
    const long = await scanning({ [PATHS[1]]: () => answered(longer) });
    expect(await long.refusedFrame()).toBe(
      "The Neural scanner's files could not be downloaded: embedder.onnx is longer than the 600 bytes this version expects.",
    );
    const short = await scanning({ [PATHS[2]]: () => answered(NEURAL_TEST_FILES["gallery.bin"].slice(1)) });
    expect(await short.refusedFrame()).toBe(
      "The Neural scanner's files could not be downloaded: gallery.bin arrived as 899 bytes where 900 were expected.",
    );
    for (const s of [gone, redeployed, page, long, short]) expect(kinds(s.ports[0])).toEqual(["load"]);
  });

  it("that the module refuses are the frame's refusal in its words, and the status's error", async () => {
    const s = await scanning();
    let said: unknown;
    s.neuralFrame().catch((sentence: unknown) => (said = sentence));
    await until(() => kinds(s.ports[0]).includes("neural"));
    s.ports[0].say({ kind: "err", id: s.ports[0].last("neural").id, message: "gallery: bad magic" });
    await settle(50);
    s.browser.advance(REFUSAL_PACE_MS);
    await settle(50);
    expect(said).toBe(`${NEURAL_REFUSED} gallery: bad magic`);
    expect(s.ports[0].terminated).toBe(false);
    expect((await s.core.call<ScannerStatus>("scanner_status")).neural).toMatchObject({
      present: true,
      loaded: false,
      error: `${NEURAL_REFUSED} gallery: bad magic`,
    });
  });

  it("whose hand-over traps end the Worker, and are waited out before the next Worker is handed them", async () => {
    const s = await scanning();
    let said: unknown;
    s.neuralFrame().catch((sentence: unknown) => (said = sentence));
    await until(() => kinds(s.ports[0]).includes("neural"));
    s.ports[0].say({ kind: "trapped", id: s.ports[0].last("neural").id, message: "RuntimeError: unreachable" });
    await settle(50);
    s.browser.advance(REFUSAL_PACE_MS);
    await settle(50);
    expect(said).toBe(STOPPED);
    expect(s.ports[0].terminated).toBe(true);
    // The next Neural frame builds a Worker — a Fast reader needs one — and does not hand it the
    // files a phone's memory would not take a moment ago.
    let next: unknown;
    s.neuralFrame().catch((sentence: unknown) => (next = sentence));
    await until(() => s.ports.length === 2);
    s.ports[1].answer(FACTS);
    await settle(100);
    s.browser.advance(REFUSAL_PACE_MS);
    await settle(50);
    expect(next).toBe(NEURAL_COULD_NOT_START);
    expect(kinds(s.ports[1])).toEqual(["load"]);
    expect(s.fetched()).toEqual(PATHS);
    expect((await s.core.call<ScannerStatus>("scanner_status")).neural.error).toBe(NEURAL_COULD_NOT_START);
  });

  it("whose hand-over passes its deadline end the Worker, and are waited out too", async () => {
    const s = await scanning();
    let said: unknown;
    s.neuralFrame().catch((sentence: unknown) => (said = sentence));
    await until(() => kinds(s.ports[0]).includes("neural"));
    // A load's deadline, not a frame's: two networks are parsed and a gallery taken.
    s.browser.advance(FRAME_DEADLINE_MS + 1_000);
    expect(s.ports[0].terminated).toBe(false);
    s.browser.advance(LOAD_DEADLINE_MS);
    expect(s.ports[0].terminated).toBe(true);
    await settle(50);
    s.browser.advance(REFUSAL_PACE_MS);
    await settle(50);
    expect(said).toBe(STOPPED);
    const status = s.core.call<ScannerStatus>("scanner_status");
    await until(() => s.ports.length === 2);
    s.ports[1].answer(FACTS);
    expect((await status).neural).toMatchObject({ loaded: false, error: NEURAL_COULD_NOT_START });
  });

  it("kept by the service worker on an earlier visit are present before any Neural frame", async () => {
    const { download, built, browser } = harness();
    await download();
    const cache = await browser.caches.open(SCANNER_CACHE);
    for (const path of PATHS.slice(0, 3)) await cache.put(path, new Response("kept"));
    const three = await built();
    expect(three.neural).toMatchObject({ present: false, loaded: false });
    await cache.put(PATHS[3], new Response("kept"));
    const later = harness({}, { caches: browser.caches });
    const four = await later.built();
    expect(four.neural).toMatchObject({ present: true, loaded: false, error: null });
  });
});

describe("what is not the scanner's", () => {
  it("passes every other command and event through to the engine", async () => {
    const { core, inner } = harness();
    await core.call("scanner_prefs");
    await core.call("set_scanner_tray", { rows: [] });
    await core.call("scanner_elsewhere");
    await core.call("search_cards", { req: {} });
    expect(vi.mocked(inner.call).mock.calls.map(([command]) => command)).toEqual([
      "scanner_prefs",
      "set_scanner_tray",
      "scanner_elsewhere",
      "search_cards",
    ]);
    const handler = (): void => undefined;
    core.listen("sync:progress", handler);
    expect(inner.listen).toHaveBeenCalledWith("sync:progress", handler);
    expect(inner.listen).not.toHaveBeenCalledWith("scanner:assets", expect.anything());
  });

  it("refuses a capture: a page keeps no files", async () => {
    const { core, refusal } = harness();
    expect(await refusal(core.call("scanner_capture", new Uint8Array([1])))).toBe(CAPTURE_REFUSED);
  });

  it("stops telling a listener that has gone", async () => {
    const { core, download } = harness();
    const heard: unknown[] = [];
    const stop = core.listen("scanner:assets", (event) => heard.push(event));
    stop();
    await download();
    expect(heard).toEqual([]);
  });

  it("leaves the scanner's cache alone when the picture cache is cleared", async () => {
    // `cache_clear` is the engine `Core`'s (`index.ts`), over `clearPictures`, which empties
    // one cache by name. This holds that name apart from the scanner's.
    const { download, browser } = harness();
    await download();
    const { clearPictures, PICTURE_CACHE } = await import("./sw/pictures");
    expect(PICTURE_CACHE).not.toBe(SCANNER_CACHE);
    await clearPictures(browser.caches);
    expect((await (await browser.caches.open(SCANNER_CACHE)).keys()).length).toBe(MANIFEST.files.length);
  });
});
