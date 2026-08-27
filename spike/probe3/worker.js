// Dedicated Worker for probe 3. The ingest runs entirely off the main thread — which is
// not only an OPFS requirement but the right shape anyway: a 77 MB download and 116k JSON
// parses on the main thread would freeze the page for the whole run.
import init, { ingest } from "./pkg/probe3.js";

self.onmessage = async () => {
  try {
    await init();
    self.postMessage({ ok: true, report: await ingest() });
  } catch (err) {
    self.postMessage({ ok: false, report: "WORKER FAILURE" + String.fromCharCode(10) + (err?.stack ?? String(err)) });
  }
};
