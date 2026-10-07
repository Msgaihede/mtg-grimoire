// The bench's page: it holds the frames, posts each to the Worker as a camera page would, and
// times the whole round trip as well as the call inside it.
//
//   ?runs=3        bursts per mode, each from a reset session
//   ?frames=30     frames per burst, from the front of `inputs/frames/`
//   ?module=ocr    which build to load: `ocr` (the readers compiled in), `lean` (without) or
//                  `simd` (the readers, built with WebAssembly's 128-bit SIMD)
//   ?auto=0        wait for the button instead of starting at once
//   ?trap=1        after the run, panic inside the module on purpose and say what is left of it
//
// **Dependency-free on purpose, and nothing here assumes a desktop**: a phone opens the same
// page over `adb reverse`, and the numbers it shows as text are the ones
// `scripts/scanner-bench.mjs` reads out of a headless Chrome as JSON
// (`window.__scannerBench`). Everything it needs is a module Worker and WebAssembly.
//
// **The frames are posted from here, transferred.** A page that scans owns the camera, so the
// frame's bytes start on this thread and cross to the Worker's; a transferred `ArrayBuffer`
// crosses without a copy, and the page's own copy is gone afterwards — which is why each frame
// is sliced off the bytes kept here before it is sent.

import { recordOf, summarise, textOf } from "./summary.js";

const params = new URLSearchParams(location.search);
const RUNS = Number(params.get("runs") ?? 3);
const FRAMES = Number(params.get("frames") ?? 30);
const MODULE = params.get("module") ?? "ocr";
const MODES = ["fast", "exact"];

const out = document.getElementById("out");
const status = document.getElementById("status");
const button = document.getElementById("run");
const say = (line) => (status.textContent = line);

/** One Worker, spoken to one message at a time. */
function connect() {
  const worker = new Worker("worker.js", { type: "module" });
  let next = 0;
  const waiting = new Map();
  worker.onmessage = ({ data }) => {
    const waiter = waiting.get(data.id);
    waiting.delete(data.id);
    if (data.trapped) waiter.reject(new Error(`the module trapped: ${data.trapped}`));
    else if (data.error) waiter.reject(new Error(data.error));
    else waiter.resolve(data);
  };
  worker.onerror = (event) => {
    for (const waiter of waiting.values())
      waiter.reject(new Error(event.message || "the Worker failed to start"));
    waiting.clear();
  };
  return (op, payload = {}, transfer = []) =>
    new Promise((resolve, reject) => {
      const id = ++next;
      waiting.set(id, { resolve, reject });
      worker.postMessage({ id, op, ...payload }, transfer);
    });
}

async function run() {
  const inputs = await (await fetch("inputs/manifest.json")).json();
  const at = (path) => new URL(`inputs/${path}`, location.href).href;
  const names = inputs.frames.slice(0, FRAMES);
  if (names.length === 0) throw new Error("inputs/frames/ holds no frames");
  say(`fetching ${names.length} frames…`);
  const frames = await Promise.all(
    names.map(async (name) => (await fetch(at(name))).arrayBuffer()),
  );

  const call = connect();
  say(`loading the ${MODULE} module…`);
  const { module_ms } = await call("init", { module: MODULE });
  const wasm = await fetch(`pkg/${MODULE}/scanner_bench_bg.wasm`, { method: "HEAD" });

  const where = {
    bundle: at(inputs.bundle),
    labels: inputs.labels ? at(inputs.labels) : null,
    models: inputs.models
      ? { detection: at(inputs.models.detection), recognition: at(inputs.models.recognition) }
      : null,
  };
  // Without the readers always; with them when there are models and a build that has readers.
  const setups = [false, ...(inputs.models && MODULE !== "lean" ? [true] : [])];
  const configs = [];
  let threads = false;
  for (const models of setups) {
    say(`building the session${models ? " with the readers" : ""}…`);
    const loaded = await call("load", { inputs: where, models });
    threads = loaded.threads;
    const runs = [];
    let memory = loaded.memory_bytes;
    for (const mode of MODES) {
      const options = JSON.stringify({ mode });
      for (let n = 0; n < RUNS; n += 1) {
        say(`${models ? "readers" : "no readers"} · ${mode} · run ${n + 1} of ${RUNS}`);
        await call("reset");
        const records = [];
        for (const frame of frames) {
          const jpeg = frame.slice(0);
          const posted = performance.now();
          const reply = await call("frame", { jpeg, options }, [jpeg]);
          const round_trip_ms = performance.now() - posted;
          memory = reply.memory_bytes;
          records.push({
            ...recordOf(JSON.parse(reply.verdict)),
            call_ms: reply.call_ms,
            round_trip_ms,
          });
        }
        runs.push({ mode, run: n, frames: records });
      }
    }
    configs.push({
      ocr: loaded.readers,
      fetch_ms: loaded.fetch_ms,
      load_ms: loaded.load_ms,
      printings: loaded.printings,
      labels: loaded.labels,
      // The module's memory only grows: the first reading is what a loaded session holds
      // (and whatever loading it peaked at), the second what the frames added to that.
      loaded_memory_bytes: loaded.memory_bytes,
      memory_bytes: memory,
      runs,
    });
  }

  // **What a panic leaves behind**, seen rather than reasoned about: the module is built with
  // `panic = "abort"`, so the crate's own guard catches nothing. One panic inside the session,
  // then one more frame asked of the same instance.
  let trap = null;
  if (params.get("trap") === "1") {
    const outcome = (promise) =>
      promise.then(
        (reply) => `answered: ${String(reply.verdict ?? "").slice(0, 120)}`,
        (error) => String(error.message).split("\n").slice(0, 2).join(" | "),
      );
    const panicked = await outcome(call("trap"));
    const jpeg = frames[0].slice(0);
    const next = await outcome(call("frame", { jpeg, options: "{}" }, [jpeg]));
    trap = { panicked, next };
  }

  return {
    trap,
    host: `wasm (${MODULE} module)`,
    threads,
    target: navigator.userAgent,
    inputs: {
      bundle_bytes: inputs.bundle_bytes,
      labels_bytes: inputs.labels_bytes,
      models_bytes: inputs.models_bytes,
      frames: frames.length,
      frame_bytes: frames.reduce((sum, frame) => sum + frame.byteLength, 0),
    },
    module: { module_ms, wasm_bytes: Number(wasm.headers.get("Content-Length") ?? 0) },
    configs,
  };
}

async function start() {
  button.disabled = true;
  out.textContent = "";
  try {
    const raw = await run();
    const summary = summarise(raw);
    out.textContent = textOf(summary);
    say("done");
    window.__scannerBench = { done: true, summary };
  } catch (error) {
    say("failed");
    out.textContent = String(error?.stack ?? error);
    window.__scannerBench = { done: true, error: String(error?.message ?? error) };
  }
  button.disabled = false;
}

button.addEventListener("click", start);
if (params.get("auto") !== "0") start();
