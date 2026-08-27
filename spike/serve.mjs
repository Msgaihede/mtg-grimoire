// Throwaway static server for the spike. Node's built-in http only — no dependency, so it
// runs in a worktree that has never had `npm install`.
//
// Two things it exists to do that `python -m http.server` cannot:
//   * `--coi` toggles the COOP/COEP pair on and off, which is the A/B for spike question 2.
//     The brief assumed the OPFS VFS requires cross-origin isolation; sqlite-wasm-rs's own
//     README says none of its three VFSes do. That disagreement is settled by serving the
//     same page both ways, not by reading either claim.
//   * correct `application/wasm`, without which the browser refuses the streaming compile
//     and the failure looks like a wasm bug.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const root = process.argv[2] ?? ".";
const port = Number(process.argv[3] ?? 5173);
const coi = process.argv.includes("--coi");

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".wasm": "application/wasm",
  ".json": "application/json",
};

createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\])+/, "");
  const path = join(root, rel === "" ? "index.html" : rel);
  const headers = { "Content-Type": TYPES[extname(path)] ?? "application/octet-stream" };
  if (coi) {
    headers["Cross-Origin-Opener-Policy"] = "same-origin";
    headers["Cross-Origin-Embedder-Policy"] = "require-corp";
  }
  try {
    const body = await readFile(path);
    res.writeHead(200, headers);
    res.end(body);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found: " + path);
  }
}).listen(port, () => {
  console.log(`spike server: http://localhost:${port}  root=${root}  cross-origin-isolated=${coi}`);
});
