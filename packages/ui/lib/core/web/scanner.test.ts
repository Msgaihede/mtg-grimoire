import { describe, expect, it, vi } from "vitest";
import type { ScannerStatus } from "@/lib/ipc";
import { HOST_SCANNER_UNAVAILABLE, SCANNER_NEEDS_SIMD } from "../hostScanner";
import type { Core } from "../types";
import {
  NEURAL_EVIDENCE_FILES,
  NEURAL_FILES,
  NEURAL_PREFIX,
  neuralPath,
  SCANNER_CACHE,
} from "./assets";
import { LABELS_COMMAND } from "./protocol";
import { NEURAL_OTHER_SET, NEURAL_UNREACHABLE, type NeuralSource } from "./scanNeural";
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
  REFUSAL_PACE_MS,
  RETRY_AFTER_MS,
  RETRY_MAX_MS,
  SIMD_PROBE,
  STOPPED,
  type ScanEnv,
  type ScanPort,
} from "./scanner";
import {
  answered,
  fakeBrowser,
  NEURAL_EVIDENCE_TEST_FILES,
  NEURAL_SOURCE,
  NEURAL_TEST_FILES,
  settle,
} from "./scanTesting";

const FACTS: LoadFacts = { labels: 7, unapplied_filters: null };

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
    if (message?.kind !== kind)
      throw new Error(`the last message is ${message?.kind}, not ${kind}`);
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

/** Everything posted to `port`, the evidence included. */
const allKinds = (port: FakePort): string[] => port.posted.map(({ message }) => message.kind);
/** What was posted, less the evidence — which goes in the background, whenever its fetch ends. */
const kinds = (port: FakePort): string[] =>
  allKinds(port).filter((kind) => kind !== "neural-evidence");
const lastKind = (port: FakePort): string | undefined => kinds(port)[kinds(port).length - 1];
/** The last message of `kind` posted to `port`. */
const latest = <K extends ToScanner["kind"]>(
  port: FakePort,
  kind: K,
): Extract<ToScanner, { kind: K }> => {
  const found = [...port.posted].reverse().find(({ message }) => message.kind === kind);
  if (!found) throw new Error(`nothing of kind ${kind} was posted`);
  return found.message as Extract<ToScanner, { kind: K }>;
};
/** Answer the last message of `kind` posted to `port` with `result`. */
const reply = (port: FakePort, kind: ToScanner["kind"], result: unknown): void =>
  port.say({ kind: "ok", id: latest(port, kind).id, result });
/** Let the page work until `check` holds — a fetch of four files is many turns deep. */
const until = async (check: () => boolean): Promise<void> => {
  for (let turn = 0; turn < 5_000 && !check(); turn += 1) await Promise.resolve();
  if (!check()) throw new Error("it never happened");
};

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
    neural: NEURAL_SOURCE,
    ...own,
  };
  const core = answeringScanner(inner, env);
  /** Build the session: ask the status, answer the load, hand back the status. */
  const built = async (facts: LoadFacts = FACTS): Promise<ScannerStatus> => {
    const status = core.call<ScannerStatus>("scanner_status");
    await settle();
    ports[ports.length - 1]?.answer(facts);
    return status;
  };
  /** One frame, a JPEG of two bytes. */
  const frame = (): Promise<unknown> => core.call("scanner_frame", new Uint8Array([1, 2]));
  const refusal = (work: Promise<unknown>): Promise<unknown> =>
    work.then(
      () => "it was not refused",
      (said) => said,
    );
  return { core, inner, innerCalls, browser, ports, built, frame, refusal };
}

/**
 * The first frame on `port`: the recogniser's files handed over and answered `ok`, the frame
 * answered — and then the evidence that follows them, answered `ok` too. After it, a frame on
 * this Worker is posted as it comes.
 */
async function firstFrame(h: ReturnType<typeof harness>, port: FakePort): Promise<void> {
  const verdict = h.frame();
  await until(() => kinds(port).includes("neural"));
  reply(port, "neural", null);
  await until(() => lastKind(port) === "frame");
  reply(port, "frame", { ok: true });
  expect(await verdict).toEqual({ ok: true });
  await until(() => allKinds(port).includes("neural-evidence"));
  reply(port, "neural-evidence", null);
}

/** A session built, and its Worker holding the recogniser — so a frame goes straight across. */
async function ready(...args: Parameters<typeof harness>) {
  const h = harness(...args);
  await h.built();
  await firstFrame(h, h.ports[0]);
  return h;
}

describe("a browser that cannot run the scanner's module", () => {
  it("is told before anything is fetched or made, by every command of the session", async () => {
    const { core, refusal, ports, browser } = harness({}, { simd: () => false });
    for (const command of [
      "scanner_status",
      "scanner_set_filters",
      "scanner_reset",
      "scanner_frame",
    ]) {
      const args = command === "scanner_frame" ? new Uint8Array([1]) : { filters: {} };
      const said = refusal(core.call(command, args));
      await settle();
      browser.advance(REFUSAL_PACE_MS);
      expect(await said, command).toBe(SCANNER_NEEDS_SIMD);
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
    const { core, ports, refusal } = harness();
    const first = refusal(core.call("scanner_status"));
    await settle();
    ports[0].say({
      kind: "unloaded",
      id: ports[0].last("load").id,
      unsupported: true,
      message: "CompileError: Wasm SIMD unsupported",
    });
    expect(await first).toBe(SCANNER_NEEDS_SIMD);
    expect(ports[0].terminated).toBe(true);
    expect(await refusal(core.call("scanner_set_filters", { filters: {} }))).toBe(
      SCANNER_NEEDS_SIMD,
    );
    expect(await refusal(core.call("scanner_reset"))).toBe(SCANNER_NEEDS_SIMD);
    expect(ports).toHaveLength(1);
  });
});

describe("a session", () => {
  it("is built by the first command that needs one, from the engine's labels, handed over", async () => {
    const { built, ports, innerCalls, browser } = harness();
    const status = await built();
    expect(ports).toHaveLength(1);
    expect(innerCalls).toEqual([LABELS_COMMAND]);
    const { message, transfer } = ports[0].posted[0];
    if (message.kind !== "load") throw new Error("not a load");
    expect(message.filters).toBeNull();
    expect(message.labels).toEqual(LABELS);
    expect(transfer).toEqual([message.labels?.buffer]);
    expect(status).toEqual({
      neural: {
        path: "/scanner-neural/",
        present: false,
        loaded: false,
        error: null,
        source: "store",
      },
      labels: 7,
      scans_dir: "",
      unapplied_filters: null,
    });
    // Nothing of the recogniser's is fetched for a status: only a frame asks for it.
    expect(browser.asked).toEqual([]);
  });

  it("says what a load said of the filters it was owed", async () => {
    const owed = await harness().built({ ...FACTS, unapplied_filters: "no labels to filter by" });
    expect(owed.unapplied_filters).toBe("no labels to filter by");
  });

  it("builds from no labels when the engine gives up on them, and asks again on the next status", async () => {
    let refuse = true;
    const gaveUp =
      "the scanner's labels could not be read: the card database changed under each of 12 attempts";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const { core, built, ports } = harness({}, {}, () =>
        refuse ? Promise.reject(gaveUp) : Promise.resolve(LABELS.slice()),
      );
      const nameless = await built({ ...FACTS, labels: 0 });
      expect(ports[0].last("load").labels).toBeNull();
      expect(nameless.labels).toBe(0);
      expect(String(warn.mock.calls[0]?.[0])).toContain(gaveUp);
      refuse = false;
      const again = core.call<ScannerStatus>("scanner_status");
      await settle();
      expect(ports).toHaveLength(2);
      expect(ports[1].last("load").labels).toEqual(LABELS);
      ports[1].answer(FACTS);
      expect((await again).labels).toBe(7);
    } finally {
      warn.mockRestore();
    }
  });

  it("asks the engine for the names again when the one it has was built without any", async () => {
    const { core, built, ports } = harness();
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

  it("sends a frame's bytes across without a copy, and answers the verdict", async () => {
    const { core, ports } = await ready();
    const body = new Uint8Array([1, 2, 3, 8, 8]);
    const buffer = body.buffer;
    const verdict = core.call("scanner_frame", body);
    await settle();
    const { message, transfer } = ports[0].posted[ports[0].posted.length - 1]!;
    if (message.kind !== "frame") throw new Error("not a frame");
    expect(message).toEqual({ kind: "frame", id: message.id, jpeg: body });
    expect(transfer).toEqual([buffer]);
    ports[0].answer({ ok: true, decision_seq: 4 });
    expect(await verdict).toEqual({ ok: true, decision_seq: 4 });
  });

  it("refuses a frame that is not bytes, and passes the module's own refusal on", async () => {
    const { core, built, ports, refusal } = harness();
    await built();
    expect(await refusal(core.call("scanner_frame", { jpeg: [1] }))).toBe(
      "A scanner frame is bytes.",
    );
    const pushed = refusal(core.call("scanner_set_filters", { filters: { sets: ["XXX"] } }));
    await settle();
    ports[0].say({
      kind: "err",
      id: ports[0].last("filters").id,
      message: "these filters match no printing",
    });
    expect(await pushed).toBe("these filters match no printing");
  });

  it("keeps the filters the module accepted for the next session, and not the ones it refused", async () => {
    const { core, built, ports, browser } = harness();
    await built({ ...FACTS, unapplied_filters: "no labels to filter by" });
    const accepted = core.call("scanner_set_filters", { filters: { sets: ["MH2"] } });
    await settle();
    ports[0].answer(null);
    await accepted;
    // An accepted push settles what a reload owed.
    expect((await core.call<ScannerStatus>("scanner_status")).unapplied_filters).toBeNull();
    const refused = core
      .call("scanner_set_filters", { filters: { sets: ["XXX"] } })
      .catch(() => undefined);
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
    const { core, built, ports, browser, innerCalls } = harness();
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
    // The next command builds another, from the engine again.
    const again = core.call<ScannerStatus>("scanner_status");
    await settle();
    ports[1].answer(FACTS);
    expect((await again).labels).toBe(7);
    expect(innerCalls.filter((command) => command === LABELS_COMMAND)).toHaveLength(2);
  });

  it("is not ended under a frame it has not answered", async () => {
    const { frame, ports, browser } = await ready();
    const verdict = frame();
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
    const h = await ready();
    const { core, ports, refusal } = h;
    const frame = refusal(h.frame());
    const reset = refusal(core.call("scanner_reset"));
    await settle();
    ports[0].say({
      kind: "trapped",
      id: ports[0].last("reset").id,
      message: "RuntimeError: unreachable",
    });
    expect(await frame).toBe(STOPPED);
    expect(await reset).toBe(STOPPED);
    expect(ports[0].terminated).toBe(true);
    // What the dead Worker says after that is not heard.
    ports[0].say({ kind: "ok", id: 99, result: null });

    const next = h.frame();
    await until(() => ports.length === 2);
    ports[1].answer(FACTS);
    await until(() => kinds(ports[1]).includes("neural"));
    reply(ports[1], "neural", null);
    await until(() => lastKind(ports[1]) === "frame");
    reply(ports[1], "frame", { ok: true });
    expect(await next).toEqual({ ok: true });
  });

  it("ends a Worker that has not answered a frame by its deadline, and the next command builds another", async () => {
    // A Worker that hung, or that the browser ended without a word, raises nothing. Unsettled,
    // the frame held the page's loop for good and the idle rule could never fire.
    const h = await ready();
    const { core, ports, refusal, browser } = h;
    const frame = refusal(h.frame());
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
    const { core, ports, refusal, browser } = harness();
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
    // paced frame, that was the labels asked and a module compiled once a second.
    const { core, ports, refusal, browser, innerCalls } = harness();
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
      expect(await refusal(core.call("scanner_set_filters", { filters: {} }))).toBe(
        COULD_NOT_START,
      );
      let said: unknown;
      void core
        .call("scanner_frame", new Uint8Array([1]))
        .catch((sentence: unknown) => (said = sentence));
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
    const h = await ready();
    const { core, ports, refusal } = h;
    const frame = refusal(h.frame());
    await settle();
    ports[0].say({
      kind: "trapped",
      id: ports[0].last("frame").id,
      message: "RuntimeError: unreachable",
    });
    expect(await frame).toBe(STOPPED);
    void core.call("scanner_status").catch(() => undefined);
    await settle();
    expect(ports).toHaveLength(2);
  });

  it("posts nothing to a Worker another caller's turn has just ended", async () => {
    // A status that finds its session nameless builds again — between a frame's own wait for
    // the session and its post. The port the frame holds is terminated by then.
    const { core, built, ports, refusal, browser } = harness();
    await built({ ...FACTS, labels: 0 });
    const status = core.call<ScannerStatus>("scanner_status").catch(() => undefined);
    const frame = refusal(core.call("scanner_frame", new Uint8Array([1])));
    await settle();
    expect(ports[0].terminated).toBe(true);
    ports[1].answer(FACTS);
    await status;
    // The recogniser's files fetched for the old Worker go with it, unposted.
    await settle(600);
    browser.advance(REFUSAL_PACE_MS);
    expect(await frame).toBe(STOPPED);
    expect(ports[0].posted.map(({ message }) => message.kind)).toEqual(["load"]);
  });

  it("treats a message that would not deserialise as the Worker failing", async () => {
    const h = await ready();
    const frame = h.refusal(h.frame());
    await settle();
    h.ports[0].garble();
    expect(await frame).toBe(STOPPED);
    expect(h.ports[0].terminated).toBe(true);
  });

  it("ends on the Worker's own error too, and waits before making another", async () => {
    const { core, ports, refusal, browser } = harness();
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
    const { core, ports, refusal, browser } = harness();
    const status = refusal(core.call("scanner_status"));
    await settle();
    ports[0].say({
      kind: "unloaded",
      id: ports[0].last("load").id,
      unsupported: false,
      message: "TypeError: Failed to fetch",
    });
    expect(await status).toBe(COULD_NOT_LOAD);
    let said: unknown;
    void core
      .call("scanner_frame", new Uint8Array([1]))
      .catch((sentence: unknown) => (said = sentence));
    await settle();
    expect(said).toBeUndefined();
    browser.advance(REFUSAL_PACE_MS);
    await settle();
    expect(said).toBe(COULD_NOT_LOAD);
    expect(ports).toHaveLength(1);
  });
});

describe("the recogniser's files", () => {
  const PATHS = NEURAL_FILES.map((name) => neuralPath(NEURAL_SOURCE.set, name));
  const EVIDENCE_PATHS = NEURAL_EVIDENCE_FILES.map((name) => neuralPath(NEURAL_SOURCE.set, name));

  /** A session built, and a way to send it a frame. */
  async function scanning(over: Parameters<typeof harness>[0] = {}) {
    const h = harness(over);
    await h.built();
    const neuralFrame = h.frame;
    /** A frame that is refused: what it was refused with, a heartbeat late. */
    const refusedFrame = async (): Promise<unknown> => {
      let said: unknown = "it was not refused";
      neuralFrame().catch((sentence: unknown) => (said = sentence));
      await settle(600);
      h.browser.advance(REFUSAL_PACE_MS);
      await settle(50);
      return said;
    };
    /** The recogniser's four as they were asked for, and the evidence's. */
    const fetched = (): string[] => h.browser.asked.filter((path) => PATHS.includes(path));
    const evidenceFetched = (): string[] =>
      h.browser.asked.filter((path) => EVIDENCE_PATHS.includes(path));
    return { ...h, neuralFrame, refusedFrame, fetched, evidenceFetched };
  }

  const firstNeuralFrame = (
    s: Awaited<ReturnType<typeof scanning>>,
    port: FakePort,
  ): Promise<void> => firstFrame(s, port);

  it("are fetched by the first frame, handed over whole, and only then is the frame sent", async () => {
    const s = await scanning();
    const { core, ports, browser, fetched } = s;
    const verdict = s.neuralFrame();
    await until(() => kinds(ports[0]).includes("neural"));
    // One after another, in `load_neural`'s order, past nothing but the HTTP cache — and none of
    // the evidence, which is nothing without the recogniser.
    expect(fetched()).toEqual(PATHS);
    expect(s.evidenceFetched()).toEqual([]);
    const asked = browser.asked.map((path, at) => [path, browser.modes[at]]);
    expect(
      asked.filter(([path]) => path.startsWith(NEURAL_PREFIX)).map(([, mode]) => mode),
    ).toEqual(NEURAL_FILES.map(() => "default"));
    const { message, transfer } = ports[0].posted[1];
    if (message.kind !== "neural") throw new Error("not the Neural files");
    expect(message.detector).toEqual(NEURAL_TEST_FILES["detector.onnx"]);
    expect(message.embedder).toEqual(NEURAL_TEST_FILES["embedder.onnx"]);
    expect(message.gallery).toEqual(NEURAL_TEST_FILES["gallery.bin"]);
    expect(message.meta).toEqual(NEURAL_TEST_FILES["neural.json"]);
    // Every buffer handed over: the page keeps none of the four.
    expect(transfer).toEqual([
      message.detector.buffer,
      message.embedder.buffer,
      message.gallery.buffer,
      message.meta.buffer,
    ]);
    // The frame waits for the hand-over's answer.
    await settle();
    expect(kinds(ports[0])).toEqual(["load", "neural"]);
    reply(ports[0], "neural", null);
    await until(() => kinds(ports[0]).length === 3);
    reply(ports[0], "frame", { ok: true, decision_seq: 1 });
    expect(await verdict).toEqual({ ok: true, decision_seq: 1 });

    // Once a Worker: the next frame is sent as it comes.
    const next = s.neuralFrame();
    await settle();
    expect(kinds(ports[0])).toEqual(["load", "neural", "frame", "frame"]);
    reply(ports[0], "frame", { ok: true });
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
    reply(s.ports[0], "neural", null);
    await until(() => kinds(s.ports[0]).length === 4);
    expect(kinds(s.ports[0])).toEqual(["load", "neural", "frame", "frame"]);
    for (const { message } of s.ports[0].posted.filter(
      (posted) => posted.message.kind === "frame",
    )) {
      s.ports[0].say({ kind: "ok", id: message.id, result: { ok: true } });
    }
    await Promise.all([one, two]);
    expect(s.fetched()).toEqual(PATHS);
  });

  it("are posted again to a Worker made again, on its first frame", async () => {
    const s = await scanning();
    await firstNeuralFrame(s, s.ports[0]);
    // The reader left: the Worker, and the files in it, are gone.
    s.browser.advance(IDLE_MS + 1_000);
    expect(s.ports[0].terminated).toBe(true);
    // The next frame builds a Worker, and hands it the files again before it is sent.
    const verdict = s.neuralFrame();
    await until(() => s.ports.length === 2);
    s.ports[1].answer(FACTS);
    await until(() => kinds(s.ports[1]).includes("neural"));
    reply(s.ports[1], "neural", null);
    await until(() => lastKind(s.ports[1]) === "frame");
    reply(s.ports[1], "frame", { ok: true });
    expect(await verdict).toEqual({ ok: true });
    expect(kinds(s.ports[1])).toEqual(["load", "neural", "frame"]);
    expect(s.fetched()).toEqual([...PATHS, ...PATHS]);
    // And the evidence after them, as the first Worker was handed it.
    await until(() => allKinds(s.ports[1]).includes("neural-evidence"));
    expect(allKinds(s.ports[1])).toEqual(["load", "neural", "frame", "neural-evidence"]);
    expect(s.evidenceFetched()).toEqual([...EVIDENCE_PATHS, ...EVIDENCE_PATHS]);
  });

  it("are not posted to a Worker that was ended while they were on their way", async () => {
    let release!: () => void;
    const held = new Promise<void>((done) => (release = done));
    const slow = {
      [PATHS[0]]: () => held.then(() => answered(NEURAL_TEST_FILES["detector.onnx"])),
    };
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
      [PATHS[1]]: () =>
        down ? answered("no", { status: 503 }) : answered(NEURAL_TEST_FILES["embedder.onnx"]),
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

    down = false;
    s.browser.advance(RETRY_AFTER_MS);
    await firstNeuralFrame(s, s.ports[0]);
    expect((await s.core.call<ScannerStatus>("scanner_status")).neural).toMatchObject({
      loaded: true,
      error: null,
    });
  });

  it("refuses an origin that is gone, a set the server no longer has, a page and a file of another length", async () => {
    const gone = await scanning({
      [PATHS[0]]: () => Promise.reject(new TypeError("Failed to fetch")),
    });
    expect(await gone.refusedFrame()).toBe(NEURAL_UNREACHABLE);
    const redeployed = await scanning({ [PATHS[3]]: () => answered("Not found", { status: 404 }) });
    expect(await redeployed.refusedFrame()).toBe(NEURAL_OTHER_SET);
    const page = await scanning({
      [PATHS[2]]: () => answered("<!doctype html>", { type: "text/html" }),
    });
    expect(await page.refusedFrame()).toBe(
      "The Neural scanner's files could not be downloaded: the server answered a page, not the file.",
    );
    const longer = new Uint8Array(NEURAL_TEST_FILES["embedder.onnx"].byteLength + 1);
    const long = await scanning({ [PATHS[1]]: () => answered(longer) });
    expect(await long.refusedFrame()).toBe(
      "The Neural scanner's files could not be downloaded: embedder.onnx is longer than the 600 bytes this version expects.",
    );
    const short = await scanning({
      [PATHS[2]]: () => answered(NEURAL_TEST_FILES["gallery.bin"].slice(1)),
    });
    expect(await short.refusedFrame()).toBe(
      "The Neural scanner's files could not be downloaded: gallery.bin arrived as 899 bytes where 900 were expected.",
    );
    for (const s of [gone, redeployed, page, long, short])
      expect(kinds(s.ports[0])).toEqual(["load"]);
  });

  it("that the module refuses are the frame's refusal in its words, and the status's error", async () => {
    const s = await scanning();
    let said: unknown;
    s.neuralFrame().catch((sentence: unknown) => (said = sentence));
    await until(() => kinds(s.ports[0]).includes("neural"));
    s.ports[0].say({
      kind: "err",
      id: s.ports[0].last("neural").id,
      message: "gallery: bad magic",
    });
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
    s.ports[0].say({
      kind: "trapped",
      id: s.ports[0].last("neural").id,
      message: "RuntimeError: unreachable",
    });
    await settle(50);
    s.browser.advance(REFUSAL_PACE_MS);
    await settle(50);
    expect(said).toBe(STOPPED);
    expect(s.ports[0].terminated).toBe(true);
    // The next frame builds a Worker — a status needs one — and does not hand it the files a
    // phone's memory would not take a moment ago.
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
    expect((await s.core.call<ScannerStatus>("scanner_status")).neural.error).toBe(
      NEURAL_COULD_NOT_START,
    );
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

  it("kept by the service worker on an earlier visit are present before any frame — all eight", async () => {
    const { built, browser } = harness();
    const cache = await browser.caches.open(SCANNER_CACHE);
    for (const path of PATHS.slice(0, 3)) await cache.put(path, new Response("kept"));
    const three = await built();
    expect(three.neural).toMatchObject({ present: false, loaded: false });
    await cache.put(PATHS[3], new Response("kept"));
    const four = await harness({}, { caches: browser.caches }).built();
    expect(four.neural).toMatchObject({ present: false, loaded: false });
    for (const path of EVIDENCE_PATHS) await cache.put(path, new Response("kept"));
    const eight = await harness({}, { caches: browser.caches }).built();
    expect(eight.neural).toMatchObject({ present: true, loaded: false, error: null });
  });

  describe("and the printing evidence beside them", () => {
    it("is fetched once the recogniser has taken its four, and never holds up a frame", async () => {
      let release!: () => void;
      const held = new Promise<void>((done) => (release = done));
      const slow = {
        [EVIDENCE_PATHS[0]]: () =>
          held.then(() => answered(NEURAL_EVIDENCE_TEST_FILES["symbol.onnx"])),
      };
      const s = await scanning(slow);
      const port = s.ports[0];
      const verdict = s.neuralFrame();
      await until(() => kinds(port).includes("neural"));
      await settle(200);
      // Not before the recogniser has said it took its four: the evidence is nothing without it.
      expect(s.evidenceFetched()).toEqual([]);
      reply(port, "neural", null);
      await until(() => lastKind(port) === "frame");
      // The frame went while the evidence was still on its way.
      expect(s.evidenceFetched()).toEqual([EVIDENCE_PATHS[0]]);
      reply(port, "frame", { ok: true, decision_seq: 1 });
      expect(await verdict).toEqual({ ok: true, decision_seq: 1 });
      const next = s.neuralFrame();
      await settle();
      reply(port, "frame", { ok: true });
      await next;
      expect(allKinds(port)).toEqual(["load", "neural", "frame", "frame"]);

      release();
      await until(() => allKinds(port).includes("neural-evidence"));
      // One after another, in `load_neural_evidence`'s order, past nothing but the HTTP cache.
      expect(s.evidenceFetched()).toEqual(EVIDENCE_PATHS);
      const at = s.browser.asked.indexOf(EVIDENCE_PATHS[0]);
      expect(s.browser.modes.slice(at, at + 4)).toEqual(NEURAL_EVIDENCE_FILES.map(() => "default"));
      const { message, transfer } = port.posted[port.posted.length - 1];
      if (message.kind !== "neural-evidence") throw new Error("not the evidence");
      expect(message.symbolNet).toEqual(NEURAL_EVIDENCE_TEST_FILES["symbol.onnx"]);
      expect(message.bandNet).toEqual(NEURAL_EVIDENCE_TEST_FILES["band.onnx"]);
      expect(message.symbols).toEqual(NEURAL_EVIDENCE_TEST_FILES["symbols.bin"]);
      expect(message.bands).toEqual(NEURAL_EVIDENCE_TEST_FILES["bands.bin"]);
      // Every buffer handed over: the page keeps none of the four.
      expect(transfer).toEqual([
        message.symbolNet.buffer,
        message.bandNet.buffer,
        message.symbols.buffer,
        message.bands.buffer,
      ]);
      reply(port, "neural-evidence", null);

      // Once a Worker: the frames after it go as they come, and nothing more is fetched.
      const after = s.neuralFrame();
      await settle();
      reply(port, "frame", { ok: true });
      await after;
      expect(allKinds(port)).toEqual([
        "load",
        "neural",
        "frame",
        "frame",
        "neural-evidence",
        "frame",
      ]);
      expect(s.evidenceFetched()).toEqual(EVIDENCE_PATHS);
      expect((await s.core.call<ScannerStatus>("scanner_status")).neural).toMatchObject({
        loaded: true,
        error: null,
      });
    });

    it("that cannot be fetched is logged, and the scanner carries on without it", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      try {
        const s = await scanning({
          [EVIDENCE_PATHS[3]]: () => answered("Not found", { status: 404 }),
        });
        const port = s.ports[0];
        const verdict = s.neuralFrame();
        await until(() => kinds(port).includes("neural"));
        reply(port, "neural", null);
        await until(() => lastKind(port) === "frame");
        reply(port, "frame", { ok: true });
        await verdict;
        await until(() => warn.mock.calls.length > 0);
        expect(String(warn.mock.calls[0][0])).toContain(NEURAL_OTHER_SET);
        expect(s.evidenceFetched()).toEqual(EVIDENCE_PATHS);
        // Frames flow, this Worker does not ask for the evidence again, and nothing is wrong.
        for (let n = 0; n < 2; n += 1) {
          const more = s.neuralFrame();
          await settle();
          reply(port, "frame", { ok: true });
          expect(await more).toEqual({ ok: true });
        }
        expect(allKinds(port)).toEqual(["load", "neural", "frame", "frame", "frame"]);
        expect(s.evidenceFetched()).toEqual(EVIDENCE_PATHS);
        expect((await s.core.call<ScannerStatus>("scanner_status")).neural).toEqual({
          path: "/scanner-neural/",
          present: true,
          loaded: true,
          error: null,
          source: "store",
        });
      } finally {
        warn.mockRestore();
      }
    });

    it("that the module refuses is logged in its words, and the scanner carries on without it", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      try {
        const s = await scanning();
        const port = s.ports[0];
        const verdict = s.neuralFrame();
        await until(() => kinds(port).includes("neural"));
        reply(port, "neural", null);
        await until(() => lastKind(port) === "frame");
        reply(port, "frame", { ok: true });
        await verdict;
        await until(() => allKinds(port).includes("neural-evidence"));
        port.say({
          kind: "err",
          id: latest(port, "neural-evidence").id,
          message: "neural.json has no evidence section",
        });
        await until(() => warn.mock.calls.length > 0);
        expect(String(warn.mock.calls[0][0])).toContain("neural.json has no evidence section");
        expect(port.terminated).toBe(false);
        const more = s.neuralFrame();
        await settle();
        reply(port, "frame", { ok: true });
        expect(await more).toEqual({ ok: true });
        expect((await s.core.call<ScannerStatus>("scanner_status")).neural).toMatchObject({
          loaded: true,
          error: null,
        });
      } finally {
        warn.mockRestore();
      }
    });

    it("whose hand-over traps is not handed to the next Worker, which reads with the recogniser alone", async () => {
      const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        const s = await scanning();
        await firstNeuralFrameLeavingEvidence(s, s.ports[0]);
        s.ports[0].say({
          kind: "trapped",
          id: latest(s.ports[0], "neural-evidence").id,
          message: "RuntimeError: unreachable",
        });
        expect(s.ports[0].terminated).toBe(true);
        // A phone whose memory would not take the evidence is not handed it again, Worker after
        // Worker — and the recogniser, which took, is not waited out for it.
        const next = s.neuralFrame();
        await until(() => s.ports.length === 2);
        s.ports[1].answer(FACTS);
        await until(() => kinds(s.ports[1]).includes("neural"));
        reply(s.ports[1], "neural", null);
        await until(() => lastKind(s.ports[1]) === "frame");
        reply(s.ports[1], "frame", { ok: true });
        expect(await next).toEqual({ ok: true });
        await settle(600);
        expect(allKinds(s.ports[1])).toEqual(["load", "neural", "frame"]);
        expect(s.evidenceFetched()).toEqual(EVIDENCE_PATHS);
        expect((await s.core.call<ScannerStatus>("scanner_status")).neural).toMatchObject({
          loaded: true,
          error: null,
        });
      } finally {
        quiet.mockRestore();
      }
    });

    it("whose hand-over passes its deadline is not handed to the next Worker either", async () => {
      const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        const s = await scanning();
        await firstNeuralFrameLeavingEvidence(s, s.ports[0]);
        // A load's deadline, not a frame's: two networks are parsed and two galleries taken.
        s.browser.advance(FRAME_DEADLINE_MS + 1_000);
        expect(s.ports[0].terminated).toBe(false);
        s.browser.advance(LOAD_DEADLINE_MS);
        expect(s.ports[0].terminated).toBe(true);
        const next = s.neuralFrame();
        await until(() => s.ports.length === 2);
        s.ports[1].answer(FACTS);
        await until(() => kinds(s.ports[1]).includes("neural"));
        reply(s.ports[1], "neural", null);
        await until(() => lastKind(s.ports[1]) === "frame");
        reply(s.ports[1], "frame", { ok: true });
        expect(await next).toEqual({ ok: true });
        await settle(600);
        expect(allKinds(s.ports[1])).toEqual(["load", "neural", "frame"]);
        expect((await s.core.call<ScannerStatus>("scanner_status")).neural.error).toBeNull();
      } finally {
        quiet.mockRestore();
      }
    });

    it("whose hand-over hangs is dropped though the frame queued behind it is what goes overdue", async () => {
      const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        const s = await scanning();
        await firstNeuralFrameLeavingEvidence(s, s.ports[0]);
        // A reader scanning on: the next frame waits in the Worker behind the evidence, which
        // never answers — a phone that cannot take it, killed without a word.
        void s.neuralFrame().catch(() => undefined);
        await until(() => kinds(s.ports[0]).filter((kind) => kind === "frame").length === 2);
        expect(lastKind(s.ports[0])).toBe("frame");
        // The frame's deadline passes first: that is what ends the Worker.
        s.browser.advance(FRAME_DEADLINE_MS + 1_000);
        expect(s.ports[0].terminated).toBe(true);
        const next = s.neuralFrame();
        await until(() => s.ports.length === 2);
        s.ports[1].answer(FACTS);
        await until(() => kinds(s.ports[1]).includes("neural"));
        reply(s.ports[1], "neural", null);
        await until(() => lastKind(s.ports[1]) === "frame");
        reply(s.ports[1], "frame", { ok: true });
        expect(await next).toEqual({ ok: true });
        await settle(600);
        // The next Worker is not handed the evidence that hung the last one.
        expect(allKinds(s.ports[1])).toEqual(["load", "neural", "frame"]);
        expect(s.evidenceFetched()).toEqual(EVIDENCE_PATHS);
        expect((await s.core.call<ScannerStatus>("scanner_status")).neural).toMatchObject({
          loaded: true,
          error: null,
        });
      } finally {
        quiet.mockRestore();
      }
    });

    it("is asked for by no page whose build ships none, and is not looked for among what is kept", async () => {
      // A build made before the evidence existed names no length for it.
      const recogniserOnly: NeuralSource = {
        set: NEURAL_SOURCE.set,
        bytes: Object.fromEntries(
          NEURAL_FILES.map((name) => [name, NEURAL_TEST_FILES[name].byteLength]),
        ),
      };
      const h = harness({}, { neural: recogniserOnly });
      await h.built();
      const port = h.ports[0];
      const verdict = h.frame();
      await until(() => kinds(port).includes("neural"));
      reply(port, "neural", null);
      await until(() => lastKind(port) === "frame");
      reply(port, "frame", { ok: true });
      await verdict;
      await settle(600);
      expect(allKinds(port)).toEqual(["load", "neural", "frame"]);
      expect(h.browser.asked.filter((path) => EVIDENCE_PATHS.includes(path))).toEqual([]);
      // The recogniser's four kept are all there is to keep.
      const cache = await h.browser.caches.open(SCANNER_CACHE);
      for (const path of PATHS) await cache.put(path, new Response("kept"));
      const later = await harness({}, { caches: h.browser.caches, neural: recogniserOnly }).built();
      expect(later.neural).toMatchObject({ present: true, loaded: false, error: null });
    });
  });

  /** The first frame on `port`, answered, and the evidence posted after it left unanswered. */
  async function firstNeuralFrameLeavingEvidence(
    s: Awaited<ReturnType<typeof scanning>>,
    port: FakePort,
  ): Promise<void> {
    const verdict = s.neuralFrame();
    await until(() => kinds(port).includes("neural"));
    reply(port, "neural", null);
    await until(() => lastKind(port) === "frame");
    reply(port, "frame", { ok: true });
    await verdict;
    await until(() => allKinds(port).includes("neural-evidence"));
  }
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
  });

  it("refuses a capture: a page keeps no files", async () => {
    const { core, refusal } = harness();
    expect(await refusal(core.call("scanner_capture", new Uint8Array([1])))).toBe(CAPTURE_REFUSED);
  });

  it("leaves the scanner's cache alone when the picture cache is cleared", async () => {
    // `cache_clear` is the engine `Core`'s (`index.ts`), over `clearPictures`, which empties
    // one cache by name. This holds that name apart from the scanner's.
    const { browser } = harness();
    const cache = await browser.caches.open(SCANNER_CACHE);
    await cache.put(neuralPath(NEURAL_SOURCE.set, "gallery.bin"), new Response("kept"));
    const { clearPictures, PICTURE_CACHE } = await import("./sw/pictures");
    expect(PICTURE_CACHE).not.toBe(SCANNER_CACHE);
    await clearPictures(browser.caches);
    expect((await (await browser.caches.open(SCANNER_CACHE)).keys()).length).toBe(1);
  });
});
