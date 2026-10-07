// What a bench run comes to, from its per-frame records — the one summariser for both hosts.
//
// The page imports it for a run in a browser, and `scripts/scanner-bench.mjs` imports it for
// the native runner's output (`scanner-bench-native <dir>` prints records and no summary). One piece
// of code, so a native figure and a browser figure were reduced the same way.
//
// A run's raw shape, which `src/bin/native.rs` prints and `page.js` builds:
//
//   { host, threads, inputs, module?,
//     configs: [{ ocr, load_ms, fetch_ms?, loaded_memory_bytes?, memory_bytes?, printings, labels,
//                 runs: [{ mode, run, frames: [record] }] }] }
//
// and a record is one frame: `{ ok, error, decision_seq, printing, named, outcome, title,
// title_matched, collector, collector_matched, ms: { path: n }, call_ms, round_trip_ms? }` —
// `recordOf` below, and `scanner_bench::record` in Rust.

/** A verdict reduced to what a measurement keeps: every `…_ms` in it by its dotted path. */
export function recordOf(verdict) {
  const ms = {};
  const walk = (value, path) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return;
    for (const [key, inner] of Object.entries(value)) {
      const at = path ? `${path}.${key}` : key;
      if (key.endsWith("_ms") && typeof inner === "number") ms[at] = inner;
      else walk(inner, at);
    }
  };
  walk(verdict, "");
  const label = verdict.decision?.label;
  return {
    ok: verdict.ok ?? null,
    error: verdict.error ?? null,
    decision_seq: verdict.decision_seq ?? null,
    printing: verdict.decision?.printing ?? null,
    named: label ? `${label.name} — ${label.set.toUpperCase()} ${label.number}` : null,
    outcome: verdict.resolution?.outcome ?? null,
    title: verdict.ocr?.raw ?? null,
    title_matched: verdict.ocr?.matched ?? null,
    collector: verdict.collector?.raw ?? null,
    collector_matched: verdict.collector?.matched ?? null,
    ms,
  };
}

const round = (n) => (n === null ? null : Math.round(n * 100) / 100);

function median(values) {
  const sorted = values.filter((v) => typeof v === "number").sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Whether a reader ran on this frame — its time is in the record only then. */
const read = (f) => "ocr.elapsed_ms" in f.ms || "collector.elapsed_ms" in f.ms;

/**
 * One run of one mode. **Four kinds of frame, kept apart**: the first, which pays for whatever
 * a session builds lazily; the frame an Exact resolve landed on, which carries the resolve;
 * a frame a reader ran on, which carries a read; and the rest — the steady state, and the
 * figure a frame rate is made of.
 */
function summariseRun(frames) {
  const resolved = frames.filter((f) => f.outcome !== null);
  const reads = frames.slice(1).filter((f) => f.outcome === null && read(f));
  const steady = frames.slice(1).filter((f) => f.outcome === null && !read(f));
  const base = frames[0]?.decision_seq ?? 0;
  const decidedAt = frames.findIndex((f) => (f.decision_seq ?? 0) > base);
  // Each decision once, by the frame its number first appeared on.
  const decided = frames
    .filter((f, i) => (f.decision_seq ?? 0) > (i ? (frames[i - 1].decision_seq ?? 0) : base))
    .map((f) => f.named ?? f.printing);
  const said = (key) => frames.map((f) => f[key]).filter((text) => text);
  const paths = new Set(frames.flatMap((f) => Object.keys(f.ms)));
  const stages = {};
  for (const path of [...paths].sort()) {
    // A reader's and a resolve's time exist only on the frames that ran one; every other
    // stage is read off the steady frames, like the frame's own cost.
    const once = /^(ocr|collector|resolution)\./.test(path);
    stages[path] = median((once ? frames : steady).map((f) => f.ms[path]));
  }
  return {
    first_ms: frames[0]?.call_ms ?? null,
    steady_ms: median(steady.map((f) => f.call_ms)),
    steady_max_ms: steady.length ? Math.max(...steady.map((f) => f.call_ms)) : null,
    round_trip_ms: median(steady.map((f) => f.round_trip_ms)),
    resolve_frame_ms: median(resolved.map((f) => f.call_ms)),
    read_frame_ms: median(reads.map((f) => f.call_ms)),
    read_frames: reads.length,
    ok_frames: frames.filter((f) => f.ok).length,
    decisions: (frames.at(-1)?.decision_seq ?? base) - base,
    decided_at: decidedAt < 0 ? null : decidedAt + 1,
    decided,
    titles: { read: said("title").length, matched: [...new Set(said("title_matched"))] },
    collectors: {
      read: said("collector").length,
      matched: [...new Set(said("collector_matched"))],
    },
    errors: [...new Set(frames.map((f) => f.error).filter(Boolean))],
    stages,
  };
}

/** A mode's runs as one row: each figure the median of its runs, with the runs beside it. */
function summariseMode(mode, runs) {
  const each = runs.map((run) => summariseRun(run.frames));
  const across = (key) => ({
    median: round(median(each.map((r) => r[key]))),
    runs: each.map((r) => round(r[key])),
  });
  const stages = {};
  for (const path of Object.keys(each[0]?.stages ?? {})) {
    stages[path] = round(median(each.map((r) => r.stages[path])));
  }
  return {
    mode,
    runs: runs.length,
    frames: runs[0]?.frames.length ?? 0,
    first_ms: across("first_ms"),
    steady_ms: across("steady_ms"),
    steady_max_ms: across("steady_max_ms"),
    round_trip_ms: across("round_trip_ms"),
    resolve_frame_ms: across("resolve_frame_ms"),
    read_frame_ms: across("read_frame_ms"),
    read_frames: each.map((r) => r.read_frames),
    ok_frames: each.map((r) => r.ok_frames),
    decisions: each.map((r) => r.decisions),
    decided_at: each.map((r) => r.decided_at),
    // What was decided and read, by the first run: the runs are the same frames again.
    decided: each[0]?.decided ?? [],
    titles: each[0]?.titles ?? null,
    collectors: each[0]?.collectors ?? null,
    errors: [...new Set(each.flatMap((r) => r.errors))],
    stages_ms: stages,
  };
}

/** The whole run: its inputs, and per configuration — readers or none — one row a mode. */
export function summarise(raw) {
  return {
    host: raw.host,
    threads: raw.threads,
    target: raw.target ?? null,
    inputs: raw.inputs,
    module: raw.module ?? null,
    trap: raw.trap ?? null,
    configs: raw.configs.map((config) => ({
      ocr: config.ocr,
      printings: config.printings,
      labels: config.labels,
      fetch_ms: round(config.fetch_ms ?? null),
      load_ms: round(config.load_ms),
      loaded_memory_bytes: config.loaded_memory_bytes ?? null,
      memory_bytes: config.memory_bytes ?? null,
      modes: [...new Set(config.runs.map((run) => run.mode))].map((mode) =>
        summariseMode(
          mode,
          config.runs.filter((run) => run.mode === mode),
        ),
      ),
    })),
  };
}

const show = (n, unit = " ms") => (n === null || n === undefined ? "—" : `${n}${unit}`);
const mb = (bytes) => (bytes ? `${(bytes / 1048576).toFixed(1)} MB` : "—");

/** A summary as lines of text — what the page shows, and what a phone's screen is read from. */
export function textOf(summary) {
  const lines = [
    `host: ${summary.host}${summary.target ? ` (${summary.target})` : ""} — ` +
      `${summary.threads ? "threads" : "one thread"}`,
    `inputs: ${summary.inputs.frames} frames, bundle ${mb(summary.inputs.bundle_bytes)}, ` +
      `labels ${mb(summary.inputs.labels_bytes)}, models ${mb(summary.inputs.models_bytes)}`,
  ];
  if (summary.module) {
    lines.push(
      `module: ${mb(summary.module.wasm_bytes)}, fetched and instantiated in ` +
        show(round(summary.module.module_ms)),
    );
  }
  for (const config of summary.configs) {
    lines.push(
      "",
      `${config.ocr ? "with the readers" : "no readers"} — ${config.printings} printings, ` +
        `${config.labels} labels; fetch ${show(config.fetch_ms)}, load ${show(config.load_ms)}, ` +
        `memory ${mb(config.loaded_memory_bytes)} loaded, ${mb(config.memory_bytes)} after the run`,
    );
    for (const mode of config.modes) {
      lines.push(
        `  ${mode.mode}: first ${show(mode.first_ms.median)}, steady ${show(mode.steady_ms.median)} ` +
          `(max ${show(mode.steady_max_ms.median)}; runs ${mode.steady_ms.runs.join(", ")}), ` +
          `round trip ${show(mode.round_trip_ms.median)}, ` +
          `resolve frame ${show(mode.resolve_frame_ms.median)}, ` +
          `read frame ${show(mode.read_frame_ms.median)} (${mode.read_frames.join("/")} of them)`,
        `    ok ${mode.ok_frames.join("/")} of ${mode.frames}; decisions ${mode.decisions.join("/")}; ` +
          `first decided at frame ${mode.decided_at.map((at) => at ?? "—").join("/")}`,
        `    ${Object.entries(mode.stages_ms)
          .map(([path, ms]) => `${path.replace(/_ms$/, "")} ${show(ms, "")}`)
          .join(" · ")}`,
      );
      if (mode.decided.length) lines.push(`    decided: ${mode.decided.join(" · ")}`);
      if (mode.titles?.read || mode.collectors?.read) {
        lines.push(
          `    titles read on ${mode.titles.read} frames → ` +
            `${mode.titles.matched.join(" · ") || "no card"}; collector lines on ` +
            `${mode.collectors.read} → ${mode.collectors.matched.join(" · ") || "no printing"}`,
        );
      }
      if (mode.errors.length) lines.push(`    said: ${mode.errors.join(" | ")}`);
    }
  }
  if (summary.trap) {
    lines.push(
      "",
      `a panic on purpose: ${summary.trap.panicked}`,
      `the next frame, same instance: ${summary.trap.next}`,
    );
  }
  return lines.join("\n");
}
