// CDP driver for Chrome on a physical Android device, reached over `adb forward`.
//
// Different from drive.mjs in one way that matters: Android Chrome does NOT support
// `/json/new`, so a tab cannot be created over the protocol. This navigates an EXISTING
// target instead — and deliberately picks the new-tab page or one already on the probe
// origin, so a real browsing session's tabs are never touched.
//
// Usage: node drive-android.mjs <url> [waitMs] [port]
const url = process.argv[2];
const waitMs = Number(process.argv[3] ?? 900000);
const PORT = Number(process.argv[4] ?? 9444);

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const origin = new URL(url).origin;
// A tab already showing ANY spike page counts as ours to reuse: the ports differ per probe,
// so same-origin alone would refuse a tab this harness itself put there a moment ago.
const isSpike = (u) => /^http:[/][/]localhost:52[0-9][0-9](?:[/]|$)/.test(u ?? "");
const target =
  list.find((t) => t.type === "page" && (t.url ?? "").startsWith(origin)) ??
  list.find((t) => t.type === "page" && isSpike(t.url)) ??
  list.find((t) => t.type === "page" && (t.url ?? "").startsWith("chrome-native://newtab"));

if (!target) {
  console.error("No safe target to drive: expected a new-tab page or one already on " + origin);
  console.error("Open a fresh tab on the device and retry rather than reusing a browsing tab.");
  process.exit(2);
}
console.log("driving target:", target.type, target.url || "(blank)");

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
await send("Page.navigate", { url });

const started = Date.now();
let out = null;
while (Date.now() - started < waitMs) {
  try {
    const r = await send("Runtime.evaluate", {
      expression: `(() => { const e = document.getElementById('out'); return document.title === 'done' && e ? e.textContent : null; })()`,
      returnByValue: true,
    });
    if (r.result?.value) {
      out = r.result.value;
      break;
    }
  } catch {
    // A navigation tears the execution context down mid-poll; that is expected, not fatal.
  }
  await new Promise((r2) => setTimeout(r2, 1000));
}

if (logs.length) console.log("--- console ---\n" + logs.join("\n") + "\n");
if (out === null) {
  const dom = await send("Runtime.evaluate", {
    expression: "document.getElementById('out')?.textContent ?? document.body.innerText",
    returnByValue: true,
  }).catch(() => ({ result: { value: "(context gone)" } }));
  console.log("--- TIMED OUT after " + waitMs + "ms; page said ---\n" + dom.result.value);
  process.exit(1);
}
console.log("--- report ---\n" + out);
ws.close();
process.exit(0);
