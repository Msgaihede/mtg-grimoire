import type {
  ScannerAsset,
  ScannerAssetDue,
  ScannerAssetsOwed,
  ScannerAssetsProgress,
  ScannerStatus,
} from "@/lib/ipc";
import { SCANNER_NEEDS_SIMD, SCANNER_NOT_SHIPPED } from "../hostScanner";
import type { CallArgs, CallOptions, Core } from "../types";
import { SCANNER_ASSETS_PREFIX } from "./assets";
import { webCore } from "./index";
import { LABELS_COMMAND } from "./protocol";
import {
  frameMessage,
  loadFactsOf,
  loadMessage,
  type FromScanner,
  type LoadFacts,
  type ScanOutgoing,
  type ToScanner,
} from "./scanProtocol";
import {
  ALREADY_FETCHING,
  createScanStore,
  EMPTY_BUNDLE,
  MODEL_SHA256,
  owedRows,
  PROGRESS_STEP,
  SCAN_FILES,
  UNREACHABLE,
  type Answered,
  type ScanKey,
  type ScanManifest,
  type StoreEnv,
} from "./scanStore";

/**
 * **The web host's card scanner: the page's half** (the light app's step 7.5).
 *
 * On the desktop and on Android the scanner's commands are answered by the engine
 * (`grimoire_core::scanner`). In a browser the session cannot live there — it is a Worker and
 * a module of its own (`scanWorker.ts` has the three reasons) — so **the session's commands
 * and the two for its files are answered here, in front of the engine's `Core`**, in the shapes
 * the engine answers them in. `src/lib/ipc.ts` calls the same names on every host, and nothing
 * above `@/lib/core` learns which host answered. What is a row or a mutex — the prefs, the
 * tray, its commit and the lease — passes through to the engine untouched.
 *
 * - **The Worker is made by the first command that needs a session, and only when there is
 *   something to load.** With none of the three files in this browser's store, no Worker is
 *   made and the scanner's module is never asked for: the status says all three are absent,
 *   the filters the page pushes are kept as owed, and a frame is refused in a sentence. So
 *   neither the module nor any of its three files is fetched until a reader has pressed
 *   Download. **The manifest is**: opening the Scanner asks `/scanner-assets/manifest.json`,
 *   six hundred bytes, to learn what an offer would cost — on every visit, past every cache.
 * - **A session build** reads the three files out of Cache Storage, asks the engine for every
 *   printing's label — the one thing this ever asks of the engine's Worker — and hands all four
 *   to the scanner's Worker, each buffer transferred. Nothing is cached between builds: the
 *   files are in the store and the labels are a second's work for the engine.
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
 *   that was eighteen megabytes read out of the store, every label asked of the engine, a
 *   Worker made and a module compiled, once a second, for as long as the Scanner stayed open.
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
 *   bytes of SIMD handed to `WebAssembly.validate` — and every session command and both file
 *   commands are refused there in `hostScanner.ts`'s sentence, which the page reads as no
 *   scanner at all.
 * - **A refusal that would repeat is paced.** The page's frame loop sends the next frame the
 *   moment the last is answered, so a frame refused at once — no files yet, a module that will
 *   not arrive — would be refused again as fast as a JPEG can be encoded. Those refusals are
 *   answered {@link REFUSAL_PACE_MS} late, which is the page's own heartbeat.
 */

/** The seven commands answered here, and the one this listens to on its way past. */
export const STATUS_COMMAND = "scanner_status";
export const FRAME_COMMAND = "scanner_frame";
export const RESET_COMMAND = "scanner_reset";
export const FILTERS_COMMAND = "scanner_set_filters";
export const CAPTURE_COMMAND = "scanner_capture";
export const ASSETS_COMMAND = "scanner_assets";
export const ASSETS_FETCH_COMMAND = "scanner_assets_fetch";
export const HOLD_COMMAND = "scanner_hold";

/** The fetch's progress — `scanner_assets::PROGRESS_EVENT`. Emitted here; the engine never does. */
export const ASSETS_EVENT = "scanner:assets";

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
 * The same for a load, which is longer work: the module's compile, a bundle parsed, every
 * label attached and both readers built. **Two minutes.** With a full corpus's 118 601
 * labels a whole build — the labels' read included, which is not under this deadline — was
 * 1.4–1.8 s on a desk (light-app.md §11.5), so this is some seventy times the slowest seen.
 */
export const LOAD_DEADLINE_MS = 120_000;

/** What everything in flight is refused with when the Worker stopped under it. */
export const STOPPED = "The card scanner stopped unexpectedly. It starts again with the next frame.";

/** What a frame in flight is refused with when a download ended and the session was let go. */
export const RELOADING = "The card scanner is loading the files that just arrived.";

/** What a session command is refused with when the scanner's module did not arrive. */
export const COULD_NOT_LOAD = "The card scanner could not be loaded. Check your connection.";

/**
 * What a session command is refused with while a build that failed is waited out: the module
 * arrived and the session would not start — a trap in its load, an answer nobody can read, a
 * load that never ended. Not the reader's connection, and not theirs to fix: it says so.
 */
export const COULD_NOT_START =
  "The card scanner could not start on this device. It will try again in a moment.";

/** What a frame is refused with while this browser holds none of the scanner's files. */
export const NOT_DOWNLOADED = "The scanner's card data has not been downloaded yet.";

/** `scanner_capture` on a page: the Developer panel's capture writes files, and a page has none. */
export const CAPTURE_REFUSED = "A browser keeps no files, so a frame cannot be captured here.";

/** What a bundle's `error` says beside `loaded: true` when the engine had no labels to give. */
export const NO_LABELS = "labels: the card database had no cards to name them from";

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
export interface ScanEnv extends StoreEnv {
  /** Make the scanner's Worker. Called once per session built, never at import. */
  spawn(): ScanPort;
  /** Whether this browser compiles WebAssembly SIMD. */
  simd(): boolean;
  /** `card_scanner::index::FORMAT_VERSION` as this build's scanner module reads a bundle. */
  format: number;
  /**
   * The digest each fixed file must have — the two models' (`scanStore.ts`'s `MODEL_SHA256`).
   * A field so the suite's small stand-ins can have digests of their own.
   */
  pinned: Readonly<Partial<Record<ScanKey, string>>>;
}

/** What a manifest for another build's bundle is refused with. A reload takes the update. */
export const OTHER_FORMAT =
  "The scanner's card data on the server is for another version of MTG Grimoire. " +
  "Reload to update, then try again.";

/** A session as built: none, because there was nothing to load — or a Worker and what it said. */
type Built =
  | { kind: "empty" }
  | {
      kind: "live";
      port: ScanPort;
      facts: LoadFacts;
      /** Which files the store held when this was built: the bundle, and both models. */
      had: { bundle: boolean; models: boolean };
      /** Whether a status has been answered from this session — see `status`. */
      reported: boolean;
      /**
       * Why this session has no card names, when the engine *refused* to hand them over — its
       * read failed, or gave up on a corpus that kept changing. `null` for names that came,
       * and for an empty corpus, which is an answer and has a sentence of its own.
       */
      nameless: string | null;
    };

interface Pending {
  resolve: (value: unknown) => void;
  reject: (sentence: string) => void;
  /** When this ask has gone unanswered too long, on the host's clock. */
  due: number;
  /** Whether it is a session's load: one that fails is a build that failed. */
  load: boolean;
}

/** A rejection as the one sentence the pages above read (`ipcError`). */
const sentenceOf = (error: unknown): string =>
  typeof error === "string" ? error : error instanceof Error ? error.message : String(error);

/** A file of the store as the status describes it. `path` is where a build serves it from. */
function asset(key: ScanKey, present: boolean, loaded: boolean, error: string | null): ScannerAsset {
  const name = SCAN_FILES.find((file) => file.key === key)?.name ?? key;
  return { path: `${SCANNER_ASSETS_PREFIX}${name}`, present, loaded, error, source: "store" };
}

/**
 * `scanner_status`' answer, **composed on the page from what the module's `load` said** — the
 * core's `ScannerStatus`, field for field. Every asset is `store`: this host has no folder a
 * reader could put a file in, so none is ever `absent` in the sense the page reads that word.
 */
export function statusOf(built: Built): ScannerStatus {
  if (built.kind === "empty") {
    return {
      bundle: asset("bundle", false, false, null),
      detection_model: asset("detectionModel", false, false, null),
      recognition_model: asset("recognitionModel", false, false, null),
      labels: 0,
      scans_dir: "",
      unapplied_filters: null,
    };
  }
  const { facts, had } = built;
  // **A bundle that parses and holds no card did not load**, as the core refuses one at its
  // fetch: put to use it would name nothing, and say nothing was wrong.
  const empty = facts.bundle.loaded && facts.bundle.entries === 0;
  // A bundle that loaded with no names is its own state, and the page has a sentence for it:
  // the module says nothing of labels it was never handed, so this says it.
  const unnamed = facts.bundle.loaded && facts.labels === 0 && facts.bundle.error === null;
  const bundleError = empty
    ? EMPTY_BUNDLE
    : unnamed
      ? (built.nameless ?? NO_LABELS)
      : facts.bundle.error;
  return {
    bundle: asset("bundle", had.bundle, facts.bundle.loaded && !empty, bundleError),
    detection_model: asset("detectionModel", had.models, facts.models.loaded, facts.models.error),
    recognition_model: asset("recognitionModel", had.models, facts.models.loaded, facts.models.error),
    labels: facts.labels,
    scans_dir: "",
    unapplied_filters: facts.unapplied_filters,
  };
}

/**
 * `inner`, with the scanner's session and its files answered on the page.
 *
 * `spawn` lives in `env` so that nothing is created at import: the module doc has when a
 * Worker is made, and when it is ended.
 */
export function answeringScanner(inner: Core, env: ScanEnv = pageScanEnv()): Core {
  const store = createScanStore(env);
  let nextId = 1;
  const pending = new Map<number, Pending>();
  /** The Worker there is — one being loaded, or one loaded. */
  let port: ScanPort | undefined;
  /** The build in flight or done. Unset whenever the next command must build afresh. */
  let building: Promise<Built> | undefined;
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
  /** Whether a fetch of the files is running, and what it has still to bring. */
  let fetching = false;
  let stillOwed: ScannerAssetDue[] = [];
  const listeners = new Set<(payload: never) => void>();

  const emit = (payload: ScannerAssetsProgress): void => {
    for (const handler of [...listeners]) {
      try {
        handler(payload as never);
      } catch (error) {
        console.error(`A subscriber to ${ASSETS_EVENT} threw.`, error);
      }
    }
  };

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
        return end(STOPPED);
    }
  }

  /**
   * Post one message and wait for its answer — until its deadline, which the watch keeps. A
   * post that throws is that call's failure.
   *
   * **Never to a Worker that is no longer the one.** A caller holds the session it awaited,
   * and another caller's turn can end that session in between — a status that builds again, a
   * download landing — so the port in hand may already be terminated, and a message posted to
   * it is one nobody answers.
   */
  function ask(to: ScanPort, { message, transfer }: ScanOutgoing): Promise<unknown> {
    if (to !== port) return Promise.reject(STOPPED);
    const load = message.kind === "load";
    return new Promise<unknown>((resolve, reject) => {
      const due = env.now() + (load ? LOAD_DEADLINE_MS : FRAME_DEADLINE_MS);
      pending.set(message.id, { resolve, reject, due, load });
      try {
        to.postMessage(message, transfer);
      } catch (error) {
        pending.delete(message.id);
        reject(sentenceOf(error));
      }
    });
  }

  async function build(mine: number): Promise<Built> {
    // A model kept under a digest that is not the pinned one is not the model: not read, and
    // so not handed to the module. (What is kept was checked against its digest as it landed.)
    const kept = await store.kept();
    const model = (key: ScanKey): Promise<Uint8Array | null> =>
      env.pinned[key] !== undefined && kept[key]?.sha256 !== env.pinned[key]
        ? Promise.resolve(null)
        : store.read(key);
    const [bundle, detection, recognition] = await Promise.all([
      store.read("bundle"),
      model("detectionModel"),
      model("recognitionModel"),
    ]);
    if (bundle === null && detection === null && recognition === null) {
      // Nothing to load, so no Worker — and no module asked for. Whether there is anything to
      // fetch is the origin's to say: a build made without the files has no scanner at all.
      if ((await store.manifest()).kind === "missing") throw SCANNER_NOT_SHIPPED;
      return { kind: "empty" };
    }
    // The names are the engine's: it holds the corpus. No labels is an answer — a corpus still
    // on its way — and so, here, is an engine that would not say: the session then answers ids.
    // **A refusal is not an empty corpus**: the engine's read failed, or gave up on a corpus
    // that kept changing under it (a launch's feeds). The names are there to be had a moment
    // later, so the session says why it has none and the next status asks again.
    let nameless: string | null = null;
    const labels =
      bundle === null
        ? null
        : await inner.call<Uint8Array>(LABELS_COMMAND).catch((error: unknown) => {
            nameless = `labels: ${sentenceOf(error)}`;
            console.warn(`MTG Grimoire: the card scanner got no card names. ${sentenceOf(error)}`);
            return null;
          });
    // Let go while the files were being read — a download ended, or the reader left.
    if (mine !== generation) throw RELOADING;
    const made = env.spawn();
    port = made;
    made.addEventListener("message", (event) => heard(made, event.data));
    const broke = (what: string) => (): void => {
      if (made !== port) return;
      console.error(`MTG Grimoire: the card scanner's Worker failed. ${what}`);
      backOff(COULD_NOT_LOAD);
      end(STOPPED);
    };
    // The script never loaded, or threw where no call could catch it — or sent an answer that
    // would not deserialise, which is an answer that is never coming.
    made.addEventListener("error", (event) => broke(event.message ?? "")());
    made.addEventListener("messageerror", broke("A message from it could not be read."));
    // From now, not from the load's answer: a load that never ends is what the watch is for.
    watch();
    const files = { bundle, labels, detection, recognition };
    const facts = loadFactsOf(await ask(made, loadMessage(nextId++, filters, files)));
    if (facts === null) {
      backOff(COULD_NOT_START);
      end(STOPPED);
      throw COULD_NOT_START;
    }
    failures = 0;
    return {
      kind: "live",
      port: made,
      facts,
      had: { bundle: bundle !== null, models: detection !== null && recognition !== null },
      reported: false,
      nameless,
    };
  }

  /** The session, built on first use. Rejects with one sentence. */
  function ensure(): Promise<Built> {
    if (unsupported || !env.simd()) return Promise.reject(SCANNER_NEEDS_SIMD);
    if (building !== undefined) return building;
    if (env.now() < retryAt) return Promise.reject(waiting);
    const mine = generation;
    const made = build(mine).catch((error: unknown) => {
      if (building === made) building = undefined;
      return Promise.reject<Built>(sentenceOf(error));
    });
    building = made;
    return made;
  }

  async function status(): Promise<ScannerStatus> {
    touch();
    let built = await ensure();
    // A session built while the card database was empty names nothing, and would for as long
    // as it lived. So a status asked of one that has already said so — the next visit to the
    // Scanner — builds again, and asks the engine for the names again.
    const unnamed = (now: Built): boolean =>
      now.kind === "live" && now.facts.bundle.loaded && now.facts.labels === 0;
    // (An empty corpus and a read the engine gave up on alike: `nameless` only says which.)
    if (built.kind === "live" && built.reported && unnamed(built)) {
      end(RELOADING);
      built = await ensure();
    }
    if (built.kind === "live") built.reported = true;
    return statusOf(built);
  }

  async function frame(args: CallArgs | undefined, options: CallOptions | undefined): Promise<unknown> {
    touch();
    if (!(args instanceof Uint8Array)) return Promise.reject("A scanner frame is bytes.");
    let built: Built;
    try {
      built = await ensure();
    } catch (error) {
      return paced(sentenceOf(error));
    }
    if (built.kind === "empty") return paced(NOT_DOWNLOADED);
    const outgoing = frameMessage(nextId++, args, options?.headers);
    if (typeof outgoing === "string") return Promise.reject(outgoing);
    return ask(built.port, outgoing);
  }

  async function reset(): Promise<null> {
    // Refused where every other session command is: a host with no scanner has no reset.
    if (unsupported || !env.simd()) throw SCANNER_NEEDS_SIMD;
    touch();
    // Nothing is built for a reset: with no session there is no card to forget.
    const built = await building?.catch(() => undefined);
    if (built?.kind === "live") await ask(built.port, { message: { kind: "reset", id: nextId++ }, transfer: [] });
    return null;
  }

  async function setFilters(args: CallArgs | undefined): Promise<null> {
    touch();
    const pushed = args instanceof Uint8Array ? undefined : args?.filters;
    const text = JSON.stringify(pushed ?? {});
    const built = await ensure();
    if (built.kind === "empty") {
      // No session to ask. Owed to the first one built, which says what became of them.
      filters = text;
      return null;
    }
    // The crate's own sentence when it refuses, and then the filters in force stand.
    await ask(built.port, { message: { kind: "filters", id: nextId++, filters: text }, transfer: [] });
    filters = text;
    built.facts.unapplied_filters = null;
    return null;
  }

  /**
   * What the store lacks, and the manifest it lacks it by — or a rejection in one sentence.
   *
   * **With no manifest to be had, the store alone answers**, and `manifest` is `null`: a
   * reader offline with all three in hand owes nothing and scans; one with a file missing is
   * owed it at the size the core writes down for it ({@link SCAN_FILES}' `about`), so the offer
   * is drawn and its press is what says the files cannot be reached. Refused, the page drew
   * no offer and no reason — an offline reader who had never downloaded was shown a camera and
   * a sentence about data, with nothing to press.
   */
  async function owedNow(): Promise<{
    manifest: ScanManifest | null;
    rows: ScannerAssetDue[];
    unreachable: string | null;
  }> {
    const [answer, kept] = await Promise.all([store.manifest(), store.kept()]);
    if (answer.kind === "missing") throw SCANNER_NOT_SHIPPED;
    if (answer.kind === "unreachable") {
      const held = (key: ScanKey): boolean =>
        kept[key] !== null && (env.pinned[key] === undefined || kept[key]?.sha256 === env.pinned[key]);
      const rows = SCAN_FILES.filter((file) => !held(file.key)).map((file) => ({
        key: file.key,
        label: file.label,
        bytes: file.about,
      }));
      return { manifest: null, rows, unreachable: answer.message };
    }
    if (answer.manifest.formatVersion !== env.format) throw OTHER_FORMAT;
    // The models are fixed files with digests written down. A manifest naming another for
    // either describes files this version does not read, whatever length they are.
    for (const file of answer.manifest.files) {
      const pinned = env.pinned[file.key];
      if (pinned !== undefined && file.sha256 !== pinned) throw OTHER_FORMAT;
    }
    return { manifest: answer.manifest, rows: owedRows(answer.manifest, kept), unreachable: null };
  }

  const owedOf = (rows: ScannerAssetDue[], running: boolean): ScannerAssetsOwed => ({
    owed: rows,
    bytes: rows.reduce((sum, row) => sum + row.bytes, 0),
    fetching: running,
  });

  async function assets(): Promise<ScannerAssetsOwed> {
    if (unsupported || !env.simd()) throw SCANNER_NEEDS_SIMD;
    // While a fetch runs it is the one that knows: the store is changing under any other look.
    if (fetching) return owedOf(stillOwed, true);
    return owedOf((await owedNow()).rows, false);
  }

  async function assetsFetch(): Promise<ScannerAssetsOwed> {
    if (unsupported || !env.simd()) throw SCANNER_NEEDS_SIMD;
    if (fetching) throw ALREADY_FETCHING;
    fetching = true;
    stillOwed = [];
    let done = 0;
    let total = 0;
    try {
      const now = await owedNow();
      const rows = now.rows;
      stillOwed = rows;
      // Something is owed and there is no manifest to fetch it by: the press is where the
      // reader is told the files cannot be reached.
      if (now.manifest === null && rows.length > 0) throw now.unreachable ?? UNREACHABLE;
      total = rows.reduce((sum, row) => sum + row.bytes, 0);
      let said = 0;
      let landed = 0;
      /** The models this run brought, in order: the pair is checked once more when it has. */
      const models: string[] = [];
      const say = (phase: ScannerAssetsProgress["phase"], file: string | null): void =>
        emit({ phase, file, done, total, message: null });
      try {
        for (const row of rows) {
          const file = now.manifest?.files.find((entry) => entry.key === row.key);
          if (file === undefined) continue;
          say("downloading", row.key);
          await store.fetch(
            file,
            (bytes) => {
              done += bytes;
              if (done - said >= PROGRESS_STEP) {
                said = done;
                say("downloading", row.key);
              }
            },
            () => say("checking", row.key),
          );
          landed += 1;
          if (row.key !== "bundle") models.push(row.key);
          stillOwed = stillOwed.filter((left) => left.key !== row.key);
        }
        // The core's sequence, so the offer's bar reads the same on every host: after each
        // file's own check, one more for the pair of models, named for the last of them. There
        // the pair is loaded as a reader; here the next session's load is what says so.
        if (models.length > 0) say("checking", models[models.length - 1] ?? null);
      } finally {
        // The session there is was built from the store as it was. Let go, so the next command
        // builds from what has landed — a file that arrived before a later one failed included.
        if (landed > 0) end(RELOADING);
      }
      done = total;
      say("done", null);
    } catch (error) {
      const message = sentenceOf(error);
      // Said on the console, where a bug report can carry it. **Not in the error log**, where a
      // host with a folder writes one: that log is the engine's, and its table has a command
      // to read it and one to clear it and none a page could write a row through.
      console.warn(`MTG Grimoire: the scanner's files were not fetched. ${message}`);
      // Nothing counted and no file named, as the core's own failure event is.
      emit({ phase: "error", file: null, done: 0, total: 0, message });
      throw message;
    } finally {
      fetching = false;
      stillOwed = [];
    }
    return assets().catch(() => owedOf([], false));
  }

  async function memory(): Promise<number | null> {
    const built = await building?.catch(() => undefined);
    if (built?.kind !== "live") return null;
    const bytes = await ask(built.port, { message: { kind: "memory", id: nextId++ }, transfer: [] });
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
          return said(frame(args, options));
        case RESET_COMMAND:
          return said(reset());
        case FILTERS_COMMAND:
          return said(setFilters(args));
        case CAPTURE_COMMAND:
          return Promise.reject(CAPTURE_REFUSED);
        case ASSETS_COMMAND:
          return said(assets());
        case ASSETS_FETCH_COMMAND:
          return said(assetsFetch());
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
      if (event !== ASSETS_EVENT) return inner.listen(event, handler);
      const entry = handler as (payload: never) => void;
      listeners.add(entry);
      return () => void listeners.delete(entry);
    },
  };
}

/**
 * The page's own: Cache Storage, `fetch`, `crypto.subtle`, and the scanner's Worker.
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
  const subtle = reach(() => globalThis.crypto.subtle);
  return {
    caches: reach(() => globalThis.caches),
    fetch: (path, init): Promise<Answered> => globalThis.fetch(path, init),
    digest: subtle
      ? async (bytes) =>
          [...new Uint8Array(await subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>))]
            .map((byte) => byte.toString(16).padStart(2, "0"))
            .join("")
      : undefined,
    after: (ms, run) => void setTimeout(run, ms),
    now: () => Date.now(),
    spawn: () => new Worker(new URL("./scanWorker.ts", import.meta.url), { type: "module" }),
    simd: () => reach(() => WebAssembly.validate(SIMD_PROBE)) === true,
    format: Number(import.meta.env.VITE_SCANNER_FORMAT),
    pinned: MODEL_SHA256,
  };
}

/**
 * The page's one: the engine's `Core` with the scanner answered in front of it. **A module
 * singleton**, like `webCore` and for its reason — one scanner Worker per page whatever mounts
 * or unmounts above it — and nothing is made here but the closure: the Worker is `spawn`'s, on
 * the first command that has something to load.
 */
export const scanningCore: Core = answeringScanner(webCore);
