// The bench's Worker: the scanner's module, and nothing else, on a thread that is not the page.
//
// One message in, one out, matched by `id`. Four operations:
//
//   init   { module }                    import and instantiate `pkg/<module>/scanner_bench.js`
//   load   { inputs, models }            fetch the bundle, the labels and — when `models` — the
//                                        two readers' models, and build the session
//   frame  { jpeg, options, detail? }    one frame; `jpeg` arrives transferred, not copied
//   reset  {}                            forget the card in frame
//   trap   {}                            panic inside the session, on purpose (`?trap=1`)
//
// **A reply with `error` is a failure the module survived** — a refused bundle, bad options.
// **A reply with `trapped` is one it did not**: with `panic = "abort"` a Rust panic is a trap,
// which surfaces here as a `WebAssembly.RuntimeError` thrown out of the export, and the
// instance's memory is left as it stood. Nothing is retried on it; the page says so and stops.

let scanner = null;

// The module's panic hook writes the panic's sentence here before the trap; kept, so the reply
// that reports the trap can carry the reason and not only `unreachable`.
const said = [];
const consoleError = console.error;
console.error = (...args) => {
  said.push(args.join(" "));
  consoleError(...args);
};

const bytesOf = async (url) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
};

const operations = {
  async init({ module }) {
    const started = performance.now();
    scanner = await import(`./pkg/${module}/scanner_bench.js`);
    // The glue fetches the `.wasm` beside itself and runs the module's start function, which
    // installs `performance.now()` as the crate's clock.
    await scanner.default();
    return { module_ms: performance.now() - started };
  },

  async load({ inputs, models }) {
    const fetching = performance.now();
    const bundle = await bytesOf(inputs.bundle);
    const labels = inputs.labels ? await (await fetch(inputs.labels)).text() : undefined;
    const detection = models ? await bytesOf(inputs.models.detection) : undefined;
    const recognition = models ? await bytesOf(inputs.models.recognition) : undefined;
    const fetch_ms = performance.now() - fetching;

    const loading = performance.now();
    const info = JSON.parse(scanner.load(bundle, labels, detection, recognition));
    return {
      ...info,
      fetch_ms,
      load_ms: performance.now() - loading,
      memory_bytes: scanner.memory_bytes(),
    };
  },

  async frame({ jpeg, options, detail }) {
    const started = performance.now();
    const verdict = scanner.frame(
      new Uint8Array(jpeg),
      options,
      detail ? new Uint8Array(detail) : undefined,
    );
    return { verdict, call_ms: performance.now() - started, memory_bytes: scanner.memory_bytes() };
  },

  async reset() {
    scanner.reset();
    return {};
  },

  async trap() {
    scanner.trap();
    return {};
  },
};

self.onmessage = async ({ data }) => {
  const { id, op, ...rest } = data;
  try {
    self.postMessage({ id, ...(await operations[op](rest)) });
  } catch (error) {
    const trapped = error instanceof WebAssembly.RuntimeError;
    const reason = trapped && said.length > 0 ? `${said.at(-1)}\n` : "";
    self.postMessage({
      id,
      [trapped ? "trapped" : "error"]: `${reason}${String(error?.stack ?? error)}`,
    });
  }
};
