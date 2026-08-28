// Minimal CDP driver for the spike pages. Node 24 has a global WebSocket, so this needs
// no dependency and runs in a worktree that has never had `npm install`.
//
// Usage: node drive.mjs <url> [waitMs]
// Prints whatever the page put in #out, plus every console message, and exits non-zero if
// the page never reported. Console capture matters: a wasm trap surfaces there and nowhere
// in the DOM, so a page that silently stays "running…" is otherwise unreadable.
const url = process.argv[2];
const waitMs = Number(process.argv[3] ?? 120000);
const PORT = 9333;

const res = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(url)}`, {
  method: "PUT",
});
const target = await res.json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const msgId = ++id;
    pending.set(msgId, { resolve, reject });
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });

const logs = [];
await new Promise((r) => ws.addEventListener("open", r));
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
  } else if (m.method === "Runtime.consoleAPICalled") {
    logs.push(`[${m.params.type}] ` + m.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
  } else if (m.method === "Runtime.exceptionThrown") {
    logs.push("[exception] " + (m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text));
  }
});
await send("Runtime.enable");
await send("Page.enable");

const started = Date.now();
let out = null;
while (Date.now() - started < waitMs) {
  const r = await send("Runtime.evaluate", {
    expression: `(() => { const e = document.getElementById('out'); return (document.title === 'probe1-done' || document.title === 'done') && e ? e.textContent : null; })()`,
    returnByValue: true,
  });
  if (r.result.value) { out = r.result.value; break; }
  await new Promise((r2) => setTimeout(r2, 250));
}

if (logs.length) console.log("--- console ---\n" + logs.join("\n") + "\n");
if (out === null) {
  const dom = await send("Runtime.evaluate", {
    expression: "document.getElementById('out')?.textContent ?? document.body.innerText",
    returnByValue: true,
  });
  console.log("--- TIMED OUT after " + waitMs + "ms; page said ---\n" + dom.result.value);
  process.exit(1);
}
console.log("--- report ---\n" + out);
ws.close();
process.exit(0);
