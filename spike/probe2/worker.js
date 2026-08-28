// The dedicated Worker the sahpool VFS requires. It is not a convenience: OPFS
// SyncAccessHandles are only obtainable off the main thread, so this file is where the
// entire database lives for the web target.
import init, { fill, verify } from "./pkg/probe2.js";

self.onmessage = async (e) => {
  try {
    await init();
    const report = e.data === "verify" ? await verify() : await fill();
    self.postMessage({ ok: true, report });
  } catch (err) {
    // A wasm trap surfaces here and nowhere in the DOM, so it has to be forwarded by hand
    // or the page just sits at "running…" forever with nothing to read.
    self.postMessage({ ok: false, report: "WORKER FAILURE\n" + (err?.stack ?? String(err)) });
  }
};
