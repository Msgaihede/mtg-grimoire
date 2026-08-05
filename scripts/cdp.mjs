#!/usr/bin/env node
// Drive the running app's WebView2 over the Chrome DevTools Protocol.
//
// Four sessions in a row rebuilt this from scratch before it was checked in. It exists so
// that "verified in the real app" is a command rather than an afternoon.
//
// Launch the app with the debugging port open first (PowerShell):
//
//     $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9222"
//     npm run tauri dev
//
// Then, from another shell:
//
//     node scripts/cdp.mjs eval "document.title"
//     node scripts/cdp.mjs click "button[aria-label='Add Lightning Bolt to collection']"
//     node scripts/cdp.mjs text "Wishlist"            # click the first element with this text
//     node scripts/cdp.mjs key Escape
//     node scripts/cdp.mjs size 1024 768             # or `size reset`
//     node scripts/cdp.mjs shot out.png
//     node scripts/cdp.mjs console out.jsonl          # stays attached; Ctrl-C to stop
//
// No dependencies: Node 22+ has a global `WebSocket`, and the target list is plain HTTP.
// Everything here is `document`-scoped, so a query runs against the app's own DOM — the
// same thing a reader sees, which is the whole point of driving the real window.

const PORT = process.env.CDP_PORT ?? "9222";
const BASE = `http://127.0.0.1:${PORT}`;

/** The app's page target. WebView2 also lists workers and about:blank helpers. */
async function pageTarget() {
  let list;
  try {
    list = await (await fetch(`${BASE}/json/list`)).json();
  } catch {
    throw new Error(
      `nothing is listening on ${BASE}. Launch the app with ` +
        `$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=${PORT}" first.`,
    );
  }
  const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
  if (!page) throw new Error(`no page target among ${list.length} targets`);
  return page;
}

/** One connection, with `send` returning the matching reply and `on` for events. */
async function connect() {
  const { webSocketDebuggerUrl } = await pageTarget();
  const ws = new WebSocket(webSocketDebuggerUrl);
  const pending = new Map();
  const listeners = [];
  let id = 0;

  await new Promise((ok, fail) => {
    ws.addEventListener("open", ok, { once: true });
    ws.addEventListener("error", () => fail(new Error("could not open the CDP socket")), {
      once: true,
    });
  });

  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id !== undefined) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (!p) return;
      if (msg.error) p.fail(new Error(`${msg.error.message} (${JSON.stringify(msg.error.data)})`));
      else p.ok(msg.result);
      return;
    }
    for (const fn of listeners) fn(msg);
  });

  return {
    send: (method, params = {}) =>
      new Promise((ok, fail) => {
        const n = ++id;
        pending.set(n, { ok, fail });
        ws.send(JSON.stringify({ id: n, method, params }));
      }),
    on: (fn) => listeners.push(fn),
    close: () => ws.close(),
  };
}

/**
 * Evaluate in the page and return the value.
 *
 * `awaitPromise` so an async expression can be written directly, and a thrown exception
 * comes back as a failure here rather than as `undefined` two steps later.
 */
async function evaluate(cdp, expression) {
  const r = await cdp.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  }
  return r.result.value;
}

/** A real user gesture, not `el.click()`: React's synthetic events and `:active` want one. */
async function clickSelector(cdp, selector) {
  const box = await evaluate(
    cdp,
    `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      el.scrollIntoView({ block: "center" });
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`,
  );
  if (!box) throw new Error(`no element matches ${selector}`);
  for (const type of ["mousePressed", "mouseReleased"]) {
    await cdp.send("Input.dispatchMouseEvent", {
      type,
      x: box.x,
      y: box.y,
      button: "left",
      clickCount: 1,
    });
  }
  return box;
}

const KEYS = {
  Escape: { windowsVirtualKeyCode: 27, key: "Escape", code: "Escape" },
  Enter: { windowsVirtualKeyCode: 13, key: "Enter", code: "Enter" },
  Tab: { windowsVirtualKeyCode: 9, key: "Tab", code: "Tab" },
  ArrowDown: { windowsVirtualKeyCode: 40, key: "ArrowDown", code: "ArrowDown" },
  ArrowUp: { windowsVirtualKeyCode: 38, key: "ArrowUp", code: "ArrowUp" },
};

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const cdp = await connect();
  try {
    switch (cmd) {
      case "eval":
        console.log(JSON.stringify(await evaluate(cdp, args.join(" ")), null, 2));
        break;

      case "click":
        await clickSelector(cdp, args[0]);
        console.log("clicked");
        break;

      // By visible text, because most controls here are named rather than id'd — the same
      // way `getByRole(name)` finds them in the tests.
      case "text": {
        const sel = await evaluate(
          cdp,
          `(() => {
            const want = ${JSON.stringify(args[0])};
            const all = [...document.querySelectorAll("button,a,[role=button],[role=tab],label")];
            const hit = all.find((e) => (e.textContent ?? "").trim() === want)
                     ?? all.find((e) => (e.textContent ?? "").includes(want))
                     ?? [...document.querySelectorAll("[aria-label]")].find(
                          (e) => e.getAttribute("aria-label").includes(want));
            if (!hit) return null;
            hit.setAttribute("data-cdp-hit", "1");
            return "[data-cdp-hit='1']";
          })()`,
        );
        if (!sel) throw new Error(`nothing on screen reads "${args[0]}"`);
        await clickSelector(cdp, sel);
        await evaluate(
          cdp,
          `document.querySelector("[data-cdp-hit]")?.removeAttribute("data-cdp-hit")`,
        );
        console.log("clicked");
        break;
      }

      case "key": {
        const k = KEYS[args[0]];
        if (!k) throw new Error(`unknown key ${args[0]}; known: ${Object.keys(KEYS).join(", ")}`);
        await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...k });
        await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...k });
        console.log("pressed");
        break;
      }

      case "type":
        for (const ch of args.join(" ")) {
          await cdp.send("Input.dispatchKeyEvent", { type: "char", text: ch });
        }
        console.log("typed");
        break;

      case "size":
        if (args[0] === "reset") await cdp.send("Emulation.clearDeviceMetricsOverride");
        else
          await cdp.send("Emulation.setDeviceMetricsOverride", {
            width: Number(args[0]),
            height: Number(args[1] ?? 800),
            deviceScaleFactor: 1,
            mobile: false,
          });
        console.log("sized");
        break;

      // `prefers-reduced-motion`, `prefers-color-scheme` and friends, for the pass the
      // direction doc asks every UI task to make.
      case "media":
        await cdp.send("Emulation.setEmulatedMedia", {
          features: args[0] === "reset" ? [] : [{ name: args[0], value: args[1] }],
        });
        console.log("emulated");
        break;

      case "shot": {
        const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
        const { writeFileSync } = await import("node:fs");
        writeFileSync(args[0], Buffer.from(data, "base64"));
        console.log(args[0]);
        break;
      }

      // Stays attached and appends JSONL. `Log.entryAdded` is where CSP violations and
      // network failures arrive; `Runtime.consoleAPICalled` is where React's warnings do.
      // Both are needed — a run that watches only one of them will report a clean console
      // it never looked at.
      case "console": {
        const { appendFileSync } = await import("node:fs");
        const out = args[0];
        const write = (rec) => {
          const line = JSON.stringify({ at: new Date().toISOString(), ...rec });
          if (out) appendFileSync(out, line + "\n");
          else console.log(line);
        };
        cdp.on((msg) => {
          if (msg.method === "Log.entryAdded") {
            const e = msg.params.entry;
            write({ kind: "log", level: e.level, source: e.source, text: e.text, url: e.url });
          } else if (msg.method === "Runtime.consoleAPICalled") {
            write({
              kind: "console",
              level: msg.params.type,
              text: msg.params.args.map((a) => a.value ?? a.description ?? "").join(" "),
            });
          } else if (msg.method === "Runtime.exceptionThrown") {
            write({
              kind: "exception",
              level: "error",
              text:
                msg.params.exceptionDetails.exception?.description ??
                msg.params.exceptionDetails.text,
            });
          }
        });
        await cdp.send("Log.enable");
        await cdp.send("Runtime.enable");
        write({ kind: "attached", level: "info", text: "console recorder attached" });
        await new Promise(() => {}); // until killed
        break;
      }

      default:
        console.error(
          "usage: cdp.mjs <eval|click|text|key|type|size|media|shot|console> [args]\n" +
            "  the app must be running with --remote-debugging-port=9222",
        );
        process.exitCode = 2;
    }
  } finally {
    if (cmd !== "console") cdp.close();
  }
}

main().catch((e) => {
  console.error(String(e.message ?? e));
  process.exit(1);
});
