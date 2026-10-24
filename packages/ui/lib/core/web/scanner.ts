import type { ScannerAsset, ScannerStatus } from "@/lib/ipc";
import { SCANNER_NEEDS_SIMD } from "../hostScanner";
import type { CallArgs, CallOptions, Core } from "../types";
import { neuralBytesOf } from "./assets";
import { webCore } from "./index";
import { LABELS_COMMAND } from "./protocol";
import {
  fetchNeural,
  fetchNeuralEvidence,
  NEURAL_PATH,
  neuralKept,
  shipsEvidence,
  type Answered,
  type NeuralEnv,
  type NeuralSource,
} from "./scanNeural";
import {
  frameMessage,
  loadFactsOf,
  loadMessage,
  neuralEvidenceMessage,
  neuralMessage,
  type FromScanner,
  type LoadFacts,
  type ScanOutgoing,
  type ToScanner,
} from "./scanProtocol";

/**
 * **The web host's card scanner: the page's half** (the light app's step 7.5).
 *
 * On the desktop and on Android the scanner's commands are answered by the engine
 * (`grimoire_core::scanner`). In a browser the session cannot live there — it is a Worker and
 * a module of its own (`scanWorker.ts` has the three reasons) — so **the session's commands are
 * answered here, in front of the engine's `Core`**, in the shapes
 * the engine answers them in. `packages/ui/lib/ipc.ts` calls the same names on every host, and nothing
 * above `@/lib/core` learns which host answered. What is a row or a mutex — the prefs, the
 * tray, its commit and the lease — passes through to the engine untouched.
 *
 * - **The Worker is made by the first command that needs a session** — the status the Scanner
 *   asks as it opens. Nothing of the scanner is fetched before a reader has opened it.
 * - **A session build** asks the engine for every printing's label — the one thing this ever
 *   asks of the engine's Worker — and hands them to the scanner's Worker, transferred. Nothing is
 *   cached between builds: the labels are a second's work for the engine.
 * - **The Worker is ended when the reader has left the Scanner**, which is the only way its
 *   memory is given back — a WASM memory never shrinks. The mounted view sends `scanner_hold`
 *   once a second and stops when it unmounts or its window is parked; those calls pass through
 *   here on their way to the engine, so this hears them. {@link IDLE_MS} with no hold and no
 *   session command, and nothing in flight, ends it. The next command builds a new session and
 *   offers it the filters the last one held.
 * - **A trap ends the Worker too, and the next command builds another.** The module is built
 *   with `panic = "abort"`: an export that throws has left its memory as the panic found it.
 *   Whatever was in flight is refused in one sentence ({@link STOPPED}).
 * - **A build that fails is not tried again at once, and each failure waits longer.** A phone
 *   that cannot grow the module's memory traps on every load; built again by the next frame,
 *   that was every label asked of the engine, a Worker made and a module compiled, once a
 *   second, for as long as the Scanner stayed open.
 *   So a build that ends in a trap, an error or a deadline sets a wait — five seconds, then
 *   ten, to a minute ({@link RETRY_AFTER_MS}, {@link RETRY_MAX_MS}) — which a load that
 *   answers clears, and meanwhile says one sentence ({@link COULD_NOT_START}).
 * - **Nothing posted to the Worker is waited for without end.** A Worker that hangs, or that
 *   the browser ends without a word, answers nothing and raises nothing: the frame's promise
 *   would never settle, and the page's loop sends no second frame while one is in flight. Each
 *   ask is stamped with a deadline ({@link FRAME_DEADLINE_MS}; {@link LOAD_DEADLINE_MS} for a
 *   load), a watch ticks once a second for as long as there is a Worker, and one past its
 *   deadline ends the Worker as a trap does.
 * - **A browser that cannot run the module is told before anything is fetched** — thirty-one
 *   bytes of SIMD handed to `WebAssembly.validate` — and every session command is refused there
 *   in `hostScanner.ts`'s sentence, which the page reads as no scanner at all.
 * - **A refusal that would repeat is paced.** The page's frame loop sends the next frame the
 *   moment the last is answered, so a frame refused at once — a module that will not arrive,
 *   files that will not load — would be refused again as fast as a JPEG can be encoded. Those
 *   refusals are answered {@link REFUSAL_PACE_MS} late, which is the page's own heartbeat.
 * - **The recogniser's four files are fetched by the first frame, once per Worker.** That frame
 *   waits while the four are read from the app's origin (`scanNeural.ts`: the HTTP cache and the
 *   service worker keep them, the page keeps nothing) and handed to the Worker, transferred, then
 *   is sent. A Worker ended and made again has none, and its first frame posts them again. A
 *   fetch or a load that fails is that frame's refusal, paced, and is waited out as a build that
 *   failed is — five seconds doubling to a minute — so a phone whose memory will not take them is
 *   not handed twenty-seven megabytes a second; meanwhile a frame says the last failure's
 *   sentence.
 * - **The printing evidence follows them, and no frame waits for it.** Once a Worker's recogniser
 *   has answered that it took the four, the evidence's four (`assets.ts`' `NEURAL_EVIDENCE_FILES`)
 *   are fetched in the background and posted when they arrive; the frames meanwhile are sent as
 *   they come and decide without it. A fetch or a refusal that fails is logged and nothing else
 *   — no frame is refused and the status says nothing — and the next Worker asks again. A
 *   hand-over that traps or passes its deadline, which ends the Worker and the recogniser with
 *   it, is not tried again while this page lives: the scanner reads on with the recogniser
 *   alone. A build that ships no evidence is asked for none.
 */

/** The five commands answered here, and the one this listens to on its way past. */
export const STATUS_COMMAND = "scanner_status";
export const FRAME_COMMAND = "scanner_frame";
export const RESET_COMMAND = "scanner_reset";
export const FILTERS_COMMAND = "scanner_set_filters";
export const CAPTURE_COMMAND = "scanner_capture";
export const HOLD_COMMAND = "scanner_hold";

/**
 * The scanner module's memory in bytes, or `null` when no Worker is alive. **Not a command**
 * (`protocol.ts`'s `LABELS_COMMAND` has the spelling's reason): the smoke run reads it to see a
 * session's cost and that leaving the Scanner gave it back, and no page asks.
 */
export const MEMORY_COMMAND = "host:scanner_memory";

/**
 * How long the scanner's Worker outlives the last sign that the Scanner is open: **fifteen
 * seconds.** Longer than the page's own grace for a minimised window (five) with a few
 * heartbeats to spare, so a window that was only glanced away from keeps its session and the
 * evidence for the card under the lens; short enough that a reader who has gone to their decks
 * gets a hundred megabytes back before they have opened one.
 */
export const IDLE_MS = 15_000;

/** How late a refusal that would repeat is answered — see the module's last point. */
export const REFUSAL_PACE_MS = 1_000;

/**
 * How long after a build failed before another Worker is made to try again — the first time.
 * Each failure in a row doubles it, to {@link RETRY_MAX_MS}; a load that answers resets it.
 */
export const RETRY_AFTER_MS = 5_000;
export const RETRY_MAX_MS = 60_000;

/** How often the watch looks, while there is a Worker: for an ask past its deadline, and for
 *  a Scanner that has been left. */
export const WATCH_MS = 1_000;

/**
 * How long a frame, a reset or a filter push may go unanswered before the Worker is ended:
 * **thirty seconds.** A read frame was 0.8–1.4 s on a desk (light-app.md §11.5), so this is
 * twenty times the slowest seen there — room for a phone an order of magnitude slower — and
 * still an end to a Scanner that would otherwise sit on one frame for good.
 */
export const FRAME_DEADLINE_MS = 30_000;

/**
 * The same for a load, which is longer work: the module's compile and every label attached —
 * and for a hand-over of the recogniser's files, two networks parsed and a gallery taken.
 * **Two minutes.** With a full corpus's 118 601
 * labels a whole build — the labels' read included, which is not under this deadline — was
 * 1.4–1.8 s on a desk (light-app.md §11.5), so this is some seventy times the slowest seen.
 */
export const LOAD_DEADLINE_MS = 120_000;

/** What everything in flight is refused with when the Worker stopped under it. */
export const STOPPED =
  "The card scanner stopped unexpectedly. It starts again with the next frame.";

/** What a call in flight is refused with when the session was let go under it to be built again. */
export const RELOADING = "The card scanner is starting again.";

/** What a session command is refused with when the scanner's module did not arrive. */
export const COULD_NOT_LOAD = "The card scanner could not be loaded. Check your connection.";

/**
 * What a session command is refused with while a build that failed is waited out: the module
 * arrived and the session would not start — a trap in its load, an answer nobody can read, a
 * load that never ended. Not the reader's connection, and not theirs to fix: it says so.
 */
export const COULD_NOT_START =
  "The card scanner could not start on this device. It will try again in a moment.";

/**
 * What a frame is refused with when the Worker trapped, or passed its deadline, taking the
 * recogniser's files — and while that is waited out. Not the reader's connection: the files came.
 */
export const NEURAL_COULD_NOT_START =
  "The card recognizer could not start on this device. It will try again in a moment.";

/** The start of what a frame says when the module refused the recogniser's files, before its words. */
export const NEURAL_REFUSED = "The card recognizer's files would not load:";

/** `scanner_capture` on a page: the Developer panel's capture writes files, and a page has none. */
export const CAPTURE_REFUSED = "A browser keeps no files, so a frame cannot be captured here.";

/**
 * Thirty-one bytes: a module with one function that uses a SIMD instruction. `WebAssembly.validate`
 * answers whether this browser would compile it — the `wasm-feature-detect` project's probe.
 */
export const SIMD_PROBE = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15,
  253, 98, 11,
]);

/** As much of a `Worker` as this needs. The real one is assignable to it. */
export interface ScanPort {
  postMessage(message: ToScanner, transfer: ArrayBuffer[]): void;
  addEventListener(type: "message", listener: (event: { data: FromScanner }) => void): void;
  addEventListener(type: "error", listener: (event: { message?: string }) => void): void;
  /** A message that would not deserialise: an answer that is never coming, as an error is. */
  addEventListener(type: "messageerror", listener: (event: unknown) => void): void;
  terminate(): void;
}

/** What the scanner asks of the browser. Handed in, so the suite owns the Worker and the clock. */
export interface ScanEnv extends NeuralEnv {
  /** Make the scanner's Worker. Called once per session built, never at import. */
  spawn(): ScanPort;
  /** Whether this browser compiles WebAssembly SIMD. */
  simd(): boolean;
  /** The recogniser's files as this build serves them: their set, and their lengths. */
  neural: NeuralSource;
}

/** A session as built: a Worker, and what it said. */
interface Live {
  port: ScanPort;
  facts: LoadFacts;
  /** Whether a status has been answered from this session — see `status`. */
  reported: boolean;
  /**
   * The recogniser's files in this Worker: loaded, being fetched and handed over (the one
   * promise every frame meanwhile waits on), or neither. Each Worker starts with none.
   * `evidence` is whether the evidence has been asked for in it — once a Worker, whatever
   * became of it.
   */
  neural: { loaded: boolean; loading: Promise<void> | null; evidence: boolean };
}

/** What the page knows of the recogniser's files beside any one Worker — for the status. */
export interface NeuralFacts {
  /** The four are in this browser: fetched whole by this page, or kept from an earlier visit. */
  present: boolean;
  /** Why the last fetch or hand-over did not take, in the sentence a frame said. */
  error: string | null;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (sentence: string) => void;
  /** When this ask has gone unanswered too long, on the host's clock. */
  due: number;
  /** Whether it is a session's load: one that fails is a build that failed. */
  load: boolean;
  /** Whether it hands over the recogniser's files: one that fails is waited out before the next. */
  neural: boolean;
  /** Whether it hands over the evidence: one that ends the Worker is not tried again. */
  evidence: boolean;
}

/** A rejection as the one sentence the pages above read (`ipcError`). */
const sentenceOf = (error: unknown): string =>
  typeof error === "string" ? error : error instanceof Error ? error.message : String(error);

/**
 * `scanner_status`' answer, **composed on the page from what the module's `load` said** — the
 * core's `ScannerStatus`, field for field. The recogniser is `store`: this host has no folder a
 * reader could put a file in, so it is never `absent` in the sense the page reads that word.
 *
 * **`neural` is the four files as one asset**, as the core's is: `present` when this browser
 * holds them, `loaded` when this session's Worker has taken them — which it does on its first
 * frame, so a session that has read none says `false` — and `error` the sentence the last fetch
 * or hand-over failed with.
 */
export function statusOf(
  built: Live,
  neural: NeuralFacts = { present: false, error: null },
): ScannerStatus {
  const loaded = built.neural.loaded;
  const asset: ScannerAsset = {
    path: NEURAL_PATH,
    present: neural.present || loaded,
    loaded,
    error: loaded ? null : neural.error,
    source: "store",
  };
  return {
    neural: asset,
    labels: built.facts.labels,
    scans_dir: "",
    unapplied_filters: built.facts.unapplied_filters,
  };
}

/**
 * `inner`, with the scanner's session answered on the page.
 *
 * `spawn` lives in `env` so that nothing is created at import: the module doc has when a
 * Worker is made, and when it is ended.
 */
export function answeringScanner(inner: Core, env: ScanEnv = pageScanEnv()): Core {
  let nextId = 1;
  const pending = new Map<number, Pending>();
  /** The Worker there is — one being loaded, or one loaded. */
  let port: ScanPort | undefined;
  /** The build in flight or done. Unset whenever the next command must build afresh. */
  let building: Promise<Live> | undefined;
  /** Moves each time the session is let go, so a build that was overtaken installs nothing. */
  let generation = 0;
  /**
   * The filters the session is searching under, or is owed: the last the module accepted, or
   * the last pushed while there was no session to ask. Handed to every session built.
   */
  let filters: string | null = null;
  /** This browser will not compile the module. Said once by a Worker; never asked again. */
  let unsupported = false;
  /** A build failed: no Worker is made to try again before this moment. */
  let retryAt = 0;
  /** How many builds in a row have failed, and what is said while the last is waited out. */
  let failures = 0;
  let waiting = COULD_NOT_LOAD;
  /** When the Scanner was last known to be open, and whether a look at that is scheduled. */
  let seen = env.now();
  let watching = false;
  /**
   * The recogniser's files beside any one Worker: whether this browser holds them, and why the last
   * fetch or hand-over did not take. A Worker's own are on its session (`Live`'s `neural`).
   */
  let neuralHeld = false;
  let neuralError: string | null = null;
  /** A fetch or hand-over of the recogniser's files failed: none is tried again before this moment. */
  let neuralRetryAt = 0;
  let neuralFailures = 0;
  /** A hand-over of the evidence ended its Worker: no Worker is handed it again. */
  let evidenceDropped = false;

  const paced = <T>(sentence: string): Promise<T> =>
    new Promise<T>((_, reject) => env.after(REFUSAL_PACE_MS, () => reject(sentence)));

  /** End the Worker and refuse whatever it had not answered. The next command builds another. */
  function end(sentence: string): void {
    generation += 1;
    port?.terminate();
    port = undefined;
    building = undefined;
    const waiting = [...pending.values()];
    pending.clear();
    for (const call of waiting) call.reject(sentence);
  }

  /** A build failed. The next is not tried before a wait that doubles with each in a row. */
  function backOff(sentence: string): void {
    retryAt = env.now() + Math.min(RETRY_AFTER_MS * 2 ** failures, RETRY_MAX_MS);
    failures += 1;
    waiting = sentence;
  }

  /** A fetch or hand-over of the recogniser's files failed. Waited out as a build is. */
  function neuralBackOff(sentence: string): void {
    neuralRetryAt = env.now() + Math.min(RETRY_AFTER_MS * 2 ** neuralFailures, RETRY_MAX_MS);
    neuralFailures += 1;
    neuralError = sentence;
  }

  /**
   * The Worker failed under what was pending — a trap, its own error, a deadline. A hand-over of
   * the recogniser's files among it is those files' failure: a phone whose memory will not take
   * them would otherwise be handed them again by the next frame's new Worker, and again.
   *
   * **The evidence when it is to blame** — `evidenceFailed`: a trap names its call by id, and
   * then only that call is; a deadline or the Worker's own error names none, and then any
   * evidence still pending is. A Worker is serial, so a frame posted behind a hand-over that
   * hangs is stuck with it, and goes overdue first on its shorter deadline. Blamed, the evidence
   * is not handed to a Worker again: each one it ended took the recogniser with it.
   */
  function failedUnder(evidenceFailed: boolean): void {
    if ([...pending.values()].some((waiter) => waiter.neural))
      neuralBackOff(NEURAL_COULD_NOT_START);
    if (evidenceFailed && !evidenceDropped) {
      evidenceDropped = true;
      console.warn(
        "MTG Grimoire: the card scanner goes on without its printing evidence, which ended its Worker.",
      );
    }
  }

  /** Whether a hand-over of the evidence is among what the Worker has not answered. */
  const evidencePending = (): boolean => [...pending.values()].some((waiter) => waiter.evidence);

  /** The Scanner is open. Start watching for it not to be, if there is a Worker to end. */
  function touch(): void {
    seen = env.now();
    watch();
  }

  /** One look a second, for as long as there is a Worker: is an ask overdue, is anybody here. */
  function watch(): void {
    if (watching || port === undefined) return;
    watching = true;
    env.after(WATCH_MS, () => {
      watching = false;
      if (port === undefined) return;
      const now = env.now();
      for (const call of pending.values()) {
        if (now < call.due) continue;
        // A Worker that hung, or that the browser ended without a word: nothing else says so.
        console.error("MTG Grimoire: the card scanner did not answer in time, and was ended.");
        if (call.load) backOff(COULD_NOT_START);
        failedUnder(evidencePending());
        return end(STOPPED);
      }
      // Never under a call: a read frame runs for a second, and a load for longer.
      if (now - seen >= IDLE_MS && pending.size === 0) return end(STOPPED);
      watch();
    });
  }

  function heard(from: ScanPort, message: FromScanner): void {
    // A Worker that is no longer the one is not heard: it was ended, and this is its echo.
    if (from !== port) return;
    const call = pending.get(message.id);
    switch (message.kind) {
      case "ok":
        pending.delete(message.id);
        return call?.resolve(message.result);
      case "err":
        pending.delete(message.id);
        return call?.reject(message.message);
      case "unloaded":
        console.warn(`MTG Grimoire: the card scanner's module did not load. ${message.message}`);
        if (message.unsupported) unsupported = true;
        else backOff(COULD_NOT_LOAD);
        return end(message.unsupported ? SCANNER_NEEDS_SIMD : COULD_NOT_LOAD);
      case "trapped":
        console.error(`MTG Grimoire: the card scanner stopped. ${message.message}`);
        // A trap under the load is a build that failed, and the next would fail the same way:
        // waited out. A trap under a frame is that frame's, and the next command builds anew.
        if ([...pending.values()].some((waiter) => waiter.load)) backOff(COULD_NOT_START);
        failedUnder(call?.evidence === true);
        return end(STOPPED);
    }
  }

  /**
   * Post one message and wait for its answer — until its deadline, which the watch keeps. A
   * post that throws is that call's failure.
   *
   * **Never to a Worker that is no longer the one.** A caller holds the session it awaited,
   * and another caller's turn can end that session in between — a status that builds again, the
   * reader leaving — so the port in hand may already be terminated, and a message posted to it
   * is one nobody answers.
   */
  function ask(to: ScanPort, { message, transfer }: ScanOutgoing): Promise<unknown> {
    if (to !== port) return Promise.reject(STOPPED);
    const load = message.kind === "load";
    // Two networks parsed and a gallery taken: a load's work, and a load's deadline — the
    // evidence's two and two as well.
    const neural = message.kind === "neural";
    const evidence = message.kind === "neural-evidence";
    return new Promise<unknown>((resolve, reject) => {
      const due = env.now() + (load || neural || evidence ? LOAD_DEADLINE_MS : FRAME_DEADLINE_MS);
      pending.set(message.id, { resolve, reject, due, load, neural, evidence });
      try {
        to.postMessage(message, transfer);
      } catch (error) {
        pending.delete(message.id);
        reject(sentenceOf(error));
      }
    });
  }

  async function build(mine: number): Promise<Live> {
    // The names are the engine's: it holds the corpus. No labels is an answer — a corpus still
    // on its way — and so, here, is an engine that would not say: the session then answers ids.
    // **A refusal is not an empty corpus**: the engine's read failed, or gave up on a corpus
    // that kept changing under it (a launch's feeds). The names are there to be had a moment
    // later, and the next status asks again (see `status`).
    const labels = await inner.call<Uint8Array>(LABELS_COMMAND).catch((error: unknown) => {
      console.warn(`MTG Grimoire: the card scanner got no card names. ${sentenceOf(error)}`);
      return null;
    });
    // Let go while the names were being read — the reader left.
    if (mine !== generation) throw RELOADING;
    const made = env.spawn();
    port = made;
    made.addEventListener("message", (event) => heard(made, event.data));
    const broke = (what: string) => (): void => {
      if (made !== port) return;
      console.error(`MTG Grimoire: the card scanner's Worker failed. ${what}`);
      backOff(COULD_NOT_LOAD);
      failedUnder(evidencePending());
      end(STOPPED);
    };
    // The script never loaded, or threw where no call could catch it — or sent an answer that
    // would not deserialise, which is an answer that is never coming.
    made.addEventListener("error", (event) => broke(event.message ?? "")());
    made.addEventListener("messageerror", broke("A message from it could not be read."));
    // From now, not from the load's answer: a load that never ends is what the watch is for.
    watch();
    const facts = loadFactsOf(await ask(made, loadMessage(nextId++, filters, labels)));
    if (facts === null) {
      backOff(COULD_NOT_START);
      end(STOPPED);
      throw COULD_NOT_START;
    }
    failures = 0;
    return {
      port: made,
      facts,
      reported: false,
      neural: { loaded: false, loading: null, evidence: false },
    };
  }

  /**
   * The recogniser's files in `built`'s Worker: there already, on their way — the one promise
   * every frame meanwhile waits on — or fetched now and handed over. Rejects with one sentence,
   * and a failure that is not the Worker ending under it is waited out ({@link neuralBackOff}).
   */
  function neuralIn(built: Live): Promise<void> {
    const held = built.neural;
    if (held.loaded) return Promise.resolve();
    if (held.loading !== null) return held.loading;
    if (env.now() < neuralRetryAt) return Promise.reject(neuralError ?? NEURAL_COULD_NOT_START);
    const handOver = async (): Promise<void> => {
      const files = await fetchNeural(env, env.neural);
      neuralHeld = true;
      // Into the Worker they were fetched for — which `ask` refuses as `STOPPED` when it was
      // ended meanwhile, and then the four go with this promise, unposted.
      await ask(built.port, neuralMessage(nextId++, files)).catch((error: unknown) => {
        const sentence = sentenceOf(error);
        if (sentence === STOPPED || sentence === RELOADING) throw sentence;
        // The module's own refusal: files it could not make a recogniser of.
        console.warn(`MTG Grimoire: the card recognizer's files would not load. ${sentence}`);
        throw `${NEURAL_REFUSED} ${sentence}`;
      });
    };
    held.loading = handOver()
      .then(
        () => {
          held.loaded = true;
          neuralError = null;
          neuralFailures = 0;
          evidenceInto(built);
        },
        (error: unknown) => {
          const sentence = sentenceOf(error);
          // A Worker ended under it is the Worker's: the next frame asks afresh. (A
          // trap or a deadline has already set the wait — `failedUnder`.)
          if (sentence !== STOPPED && sentence !== RELOADING) neuralBackOff(sentence);
          return Promise.reject(sentence);
        },
      )
      .finally(() => {
        held.loading = null;
      });
    return held.loading;
  }

  /**
   * The printing evidence into `built`'s Worker, whose recogniser has taken the four: fetched and
   * posted in the background, once a Worker. **Nothing waits on it** — the frames meanwhile are
   * sent as they come — and a failure is logged and nothing else: the scanner reads on without it.
   */
  function evidenceInto(built: Live): void {
    if (evidenceDropped || built.neural.evidence || !shipsEvidence(env.neural)) return;
    // A Worker ended since its recogniser answered fetches nothing: its successor asks for itself.
    if (built.port !== port) return;
    built.neural.evidence = true;
    const handOver = async (): Promise<void> => {
      const files = await fetchNeuralEvidence(env, env.neural);
      // Into the Worker they were fetched for — `STOPPED` when it was ended meanwhile.
      await ask(built.port, neuralEvidenceMessage(nextId++, files));
    };
    handOver().catch((error: unknown) => {
      const sentence = sentenceOf(error);
      // A Worker ended under it is the Worker's, and a trap or a deadline has said so already.
      if (sentence === STOPPED || sentence === RELOADING) return;
      console.warn(
        `MTG Grimoire: the card scanner goes on without its printing evidence. ${sentence}`,
      );
    });
  }

  /** The session, built on first use. Rejects with one sentence. */
  function ensure(): Promise<Live> {
    if (unsupported || !env.simd()) return Promise.reject(SCANNER_NEEDS_SIMD);
    if (building !== undefined) return building;
    if (env.now() < retryAt) return Promise.reject(waiting);
    const mine = generation;
    const made = build(mine).catch((error: unknown) => {
      if (building === made) building = undefined;
      return Promise.reject<Live>(sentenceOf(error));
    });
    building = made;
    return made;
  }

  async function status(): Promise<ScannerStatus> {
    touch();
    let built = await ensure();
    // A session built while the card database was empty — or while the engine would not read
    // it — names nothing, and would for as long as it lived. So a status asked of one that has
    // already said so — the next visit to the Scanner, or a sync that brought the names —
    // builds again, and asks the engine for the names again.
    if (built.reported && built.facts.labels === 0) {
      end(RELOADING);
      built = await ensure();
    }
    built.reported = true;
    // Kept by the service worker on an earlier visit counts: they are in this browser.
    if (!neuralHeld && (await neuralKept(env, env.neural))) neuralHeld = true;
    return statusOf(built, { present: neuralHeld, error: neuralError });
  }

  async function frame(args: CallArgs | undefined): Promise<unknown> {
    touch();
    if (!(args instanceof Uint8Array)) return Promise.reject("A scanner frame is bytes.");
    let built: Live;
    try {
      built = await ensure();
    } catch (error) {
      return paced(sentenceOf(error));
    }
    // Every frame waits for the recogniser's files in this Worker — fetched and handed over by
    // the first, once. Nothing is posted until they are: the frame's bytes are only handed over
    // by its own post.
    try {
      await neuralIn(built);
    } catch (error) {
      return paced(sentenceOf(error));
    }
    return ask(built.port, frameMessage(nextId++, args));
  }

  async function reset(): Promise<null> {
    // Refused where every other session command is: a host with no scanner has no reset.
    if (unsupported || !env.simd()) throw SCANNER_NEEDS_SIMD;
    touch();
    // Nothing is built for a reset: with no session there is no card to forget.
    const built = await building?.catch(() => undefined);
    if (built !== undefined)
      await ask(built.port, { message: { kind: "reset", id: nextId++ }, transfer: [] });
    return null;
  }

  async function setFilters(args: CallArgs | undefined): Promise<null> {
    touch();
    const pushed = args instanceof Uint8Array ? undefined : args?.filters;
    const text = JSON.stringify(pushed ?? {});
    const built = await ensure();
    // The crate's own sentence when it refuses, and then the filters in force stand.
    await ask(built.port, {
      message: { kind: "filters", id: nextId++, filters: text },
      transfer: [],
    });
    filters = text;
    built.facts.unapplied_filters = null;
    return null;
  }

  async function memory(): Promise<number | null> {
    const built = await building?.catch(() => undefined);
    if (built === undefined) return null;
    const bytes = await ask(built.port, {
      message: { kind: "memory", id: nextId++ },
      transfer: [],
    });
    return typeof bytes === "number" ? bytes : null;
  }

  /** Every rejection out of here is a bare sentence, as a Tauri command's is. */
  const said = <T>(answer: Promise<unknown>): Promise<T> =>
    answer.catch((error: unknown) => Promise.reject(sentenceOf(error))) as Promise<T>;

  return {
    call<T>(command: string, args?: CallArgs, options?: CallOptions): Promise<T> {
      switch (command) {
        case STATUS_COMMAND:
          return said(status());
        case FRAME_COMMAND:
          return said(frame(args));
        case RESET_COMMAND:
          return said(reset());
        case FILTERS_COMMAND:
          return said(setFilters(args));
        case CAPTURE_COMMAND:
          return Promise.reject(CAPTURE_REFUSED);
        case MEMORY_COMMAND:
          return said(memory());
        case HOLD_COMMAND:
          // The mounted view's heartbeat, on its way to the engine's lease: the Scanner is open.
          touch();
          return inner.call<T>(command, args, options);
        default:
          return inner.call<T>(command, args, options);
      }
    },

    listen<T>(event: string, handler: (payload: T) => void): () => void {
      return inner.listen(event, handler);
    },
  };
}

/**
 * The page's own: Cache Storage, `fetch`, and the scanner's Worker.
 *
 * **Each global is reached inside a `try`**, as `index.ts`'s `pageBrowser` does and for its
 * reason. **The `new Worker(new URL(…))` is here and nowhere else**, which is what puts the
 * scanner Worker's chunk in the web build and in no other: this file is reached by the same
 * dynamic import that reaches `./index.ts` (`../index.ts`).
 */
function pageScanEnv(): ScanEnv {
  const reach = <T>(get: () => T): T | undefined => {
    try {
      return get();
    } catch {
      return undefined;
    }
  };
  return {
    caches: reach(() => globalThis.caches),
    fetch: (path, init): Promise<Answered> => globalThis.fetch(path, init),
    after: (ms, run) => void setTimeout(run, ms),
    now: () => Date.now(),
    spawn: () => new Worker(new URL("./scanWorker.ts", import.meta.url), { type: "module" }),
    simd: () => reach(() => WebAssembly.validate(SIMD_PROBE)) === true,
    // The set's id and the files' lengths, as `apps/light/vite.config.ts` found them.
    neural: {
      set: String(import.meta.env.VITE_NEURAL_SET),
      bytes: neuralBytesOf(import.meta.env.VITE_NEURAL_BYTES),
    },
  };
}

/**
 * The page's one: the engine's `Core` with the scanner answered in front of it. **A module
 * singleton**, like `webCore` and for its reason — one scanner Worker per page whatever mounts
 * or unmounts above it — and nothing is made here but the closure: the Worker is `spawn`'s, on
 * the first command that needs a session.
 */
export const scanningCore: Core = answeringScanner(webCore);
