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
//     node scripts/cdp.mjs press Enter "[aria-label='Add Sol Ring to Main deck']"
//     node scripts/cdp.mjs hover "<css>" --rest 400 --probe "expr"   # a real dwell
//     node scripts/cdp.mjs drag "<source css>" "<target css>"  # a real Chromium drag
//     node scripts/cdp.mjs size 1024 768 "expr"      # or `size reset`; expr runs in-session
//     node scripts/cdp.mjs media prefers-reduced-motion reduce "expr"  # measured in-session
//     node scripts/cdp.mjs shot out.png 1024 768     # sized and captured in one session
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

/**
 * Chromium's modifier bitmask, as `Input.dispatch*Event` takes it: Alt 1, Ctrl 2, Meta 4,
 * **Shift 8**.
 *
 * Only Shift is wired up, and it is here because a multi-key table sort is built by holding
 * it down. `dispatchEvent({shiftKey: true})` out of `eval` proves nothing about that — it
 * skips the browser's own input pipeline, which is where the modifier state a real hand
 * produces actually comes from.
 */
const SHIFT = 8;

/** A real user gesture, not `el.click()`: React's synthetic events and `:active` want one. */
async function clickSelector(cdp, selector, modifiers = 0) {
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
      modifiers,
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

/** The two keys that *activate* a control, with the `text` that makes Chromium act on them. */
const ACTIVATION_KEYS = {
  Enter: { windowsVirtualKeyCode: 13, key: "Enter", code: "Enter", text: "\r" },
  Space: { windowsVirtualKeyCode: 32, key: " ", code: "Space", text: " " },
};

/** An element's centre in viewport coordinates, or `null` when nothing matches. */
const boxOf = (selector) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
})()`;

async function main() {
  const [cmd, ...argv] = process.argv.slice(2);
  // `--shift` on `click`, `text` and `press`, because a multi-key sort is built with it held
  // down and there is no other way to say so through this script. Stripped before the
  // positional arguments are read, so it can be written anywhere after the command.
  const modifiers = argv.includes("--shift") ? SHIFT : 0;
  const args = argv.filter((a) => a !== "--shift");
  const cdp = await connect();
  try {
    switch (cmd) {
      case "eval":
        console.log(JSON.stringify(await evaluate(cdp, args.join(" ")), null, 2));
        break;

      case "click":
        await clickSelector(cdp, args[0], modifiers);
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
        await clickSelector(cdp, sel, modifiers);
        await evaluate(
          cdp,
          `document.querySelector("[data-cdp-hit]")?.removeAttribute("data-cdp-hit")`,
        );
        console.log("clicked");
        break;
      }

      // A key the page can *listen* for. `rawKeyDown` carries no text, which is right for
      // Escape and the arrows and wrong for Enter and Space: see `press`.
      case "key": {
        const k = KEYS[args[0]];
        if (!k) throw new Error(`unknown key ${args[0]}; known: ${Object.keys(KEYS).join(", ")}`);
        await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...k });
        await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...k });
        console.log("pressed");
        break;
      }

      // `press Enter|Space [selector]` — a key that *activates* the focused control.
      //
      // Chromium activates a focused `<button>` off the **keypress**, and it synthesises that
      // keypress itself from a `keyDown` that carries `text`. `key`'s `rawKeyDown` carries
      // none — so `key Enter` on a button is a keydown the page hears and an activation that
      // never happens. Whether that is what you want depends entirely on what you are testing,
      // which is why these are two commands and not one.
      //
      // **Two events, never three.** Adding an explicit `char` after a `keyDown` that already
      // carries text sends a *second* keypress, and a stepper pressed that way steps twice
      // while this command reports one press. Measured on a focused button: `keyDown(text)` +
      // `char` + `keyUp` = **2 clicks**; `keyDown(text)` + `keyUp` = **1**. Space hides the
      // fault — it activates on keyup — so a live check that only asks *whether* the control
      // fired will pass over it. Ask how many times.
      //
      // The injected `char` was wrong in a second way, which is why it is not merely
      // redundant: a page that `preventDefault()`s the keydown suppresses the keypress
      // Chromium would have synthesised, but not a char dispatched from here — so that path
      // could manufacture activations a real keyboard cannot produce.
      //
      // The optional selector focuses first, because "press Enter on this control" is what a
      // keyboard pass actually wants to say.
      case "press": {
        const k = ACTIVATION_KEYS[args[0]];
        if (!k) {
          throw new Error(
            `press takes ${Object.keys(ACTIVATION_KEYS).join(" or ")}; use \`key\` for the rest`,
          );
        }
        if (args[1]) {
          const focused = await evaluate(
            cdp,
            `(() => { const el = document.querySelector(${JSON.stringify(args[1])});
               if (!el) return false; el.scrollIntoView({ block: "center" }); el.focus();
               return document.activeElement === el; })()`,
          );
          if (!focused) throw new Error(`nothing focusable matches ${args[1]}`);
        }
        // `--shift` lands on the *click Chromium synthesises*, which is the keyboard half of
        // an additive press: one `onClick` handler reading `e.shiftKey` serves both hands.
        await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", ...k, modifiers });
        await cdp.send("Input.dispatchKeyEvent", {
          type: "keyUp",
          ...k,
          text: undefined,
          modifiers,
        });
        console.log("pressed");
        break;
      }

      // `drag <source> <target> [--press <css>] [--from x,y] [--cancel] [--probe <expr>]`
      //
      // A **real** drag: `Input.setInterceptDrags` puts Chromium's own drag pipeline in play
      // (the page gets a real `dragstart`, the drag data store is the platform's) and
      // `Input.dispatchDragEvent` delivers dragenter/dragover/drop in place of the OS drag
      // loop. `Input.dragIntercepted` confirms it started and carries the payload —
      // `application/vnd.pdnd` for this app's own draggables.
      //
      // Three things cost whole sessions before they were written down:
      //
      // * A run that dies mid-flight leaves **two** pieces of state behind, and both make
      //   every later drag fail with "the browser never started a drag": the drag controller
      //   (cleared here with `dragCancel` + `mouseReleased` + `setInterceptDrags:false`, in a
      //   `finally` whose four steps each get their own `try` — see there) and pdnd's **honey
      //   pot** (`[data-pdnd-honey-pot]`), left covering the pointer so the next
      //   `mousePressed` lands on it. Both are cleaned at both ends, including after a drag
      //   that never started — which is the case that matters, because that is the one that
      //   leaves the button down.
      // * The press must land on something **visible**. A row or tile inside a short scroller
      //   can have its geometric centre off-screen, and a press there starts nothing —
      //   `--from x,y` names a point instead, and `--press` names a different element.
      // * The target is measured **after** the drag starts, because the most interesting drop
      //   target in this app (the remove tray) does not exist until a card is in the air.
      case "drag": {
        const flag = (name) => {
          const i = args.indexOf(name);
          return i === -1 ? null : (args[i + 1] ?? "");
        };
        const cancel = args.includes("--cancel");
        // Positional arguments are what is left once the flags and their values are taken
        // out, not `args[0]` and `args[1]`: `drag --cancel <src> <tgt>` is a reasonable thing
        // to type, and reading positions blindly made "--cancel" the source selector.
        const flagsWithValues = ["--press", "--from", "--probe"];
        const positional = args.filter((arg, i) => {
          if (arg.startsWith("--")) return false;
          const before = args[i - 1];
          return !(before && flagsWithValues.includes(before));
        });
        const [source, target] = positional;
        if (!source || !target) throw new Error("drag takes a source and a target selector");
        let data = null;
        /** Whether the successful path already let the button go. */
        let released = false;
        cdp.on((m) => {
          if (m.method === "Input.dragIntercepted") data ??= m.params.data;
        });
        const honeyPot = `(document.querySelector('[data-pdnd-honey-pot]')?.remove(), "clean")`;
        try {
          await evaluate(cdp, honeyPot);
          const at = flag("--from");
          const from = at
            ? { x: Number(at.split(",")[0]), y: Number(at.split(",")[1]) }
            : await evaluate(cdp, boxOf(flag("--press") ?? source));
          if (!from) throw new Error(`no source matches ${flag("--press") ?? source}`);

          await cdp.send("Input.setInterceptDrags", { enabled: true });
          const mouse = (type, x, y, buttons) =>
            cdp.send("Input.dispatchMouseEvent", {
              type,
              x,
              y,
              button: "left",
              buttons,
              clickCount: 1,
            });
          await mouse("mousePressed", from.x, from.y, 1);
          for (const step of [4, 12, 24, 48]) {
            await mouse("mouseMoved", from.x + step, from.y + step, 1);
            await new Promise((r) => setTimeout(r, 40));
          }
          await new Promise((r) => setTimeout(r, 250));
          if (!data) throw new Error("the browser never started a drag");

          const to = await evaluate(cdp, boxOf(target));
          if (!to) throw new Error(`no target matches ${target}`);
          for (const type of ["dragEnter", "dragOver", "dragOver"]) {
            await cdp.send("Input.dispatchDragEvent", { type, x: to.x, y: to.y, data });
            await new Promise((r) => setTimeout(r, 80));
          }
          const probe = flag("--probe");
          const measured = probe ? await evaluate(cdp, probe) : undefined;
          await cdp.send("Input.dispatchDragEvent", {
            type: cancel ? "dragCancel" : "drop",
            x: to.x,
            y: to.y,
            data,
          });
          await mouse("mouseReleased", to.x, to.y, 0);
          released = true;
          const outcome = cancel ? "cancelled" : "dropped";
          console.log(
            JSON.stringify({ started: data.items, from, to, outcome, probe: measured }, null, 2),
          );
        } finally {
          // **Four independent steps, four `try`s.** One shared `catch` made this whole block
          // all-or-nothing, and the first step is the one most likely to fail — which is how
          // the cleanup came to fail in precisely the state it exists for. When the browser
          // never started a drag, `data` is null; the fallback then has to be a *valid*
          // `Input.DragData`, and `dragOperationsMask` is mandatory (without it the call is
          // rejected at deserialization). That rejection took `mouseReleased`,
          // `setInterceptDrags:false` and the honey-pot removal down with it, leaving the
          // button held and interception on — the exact poisoned window the `finally`
          // promises to close, reachable only from the failure it was written for.
          const steps = [
            () =>
              cdp.send("Input.dispatchDragEvent", {
                type: "dragCancel",
                x: 0,
                y: 0,
                data: data ?? { items: [], dragOperationsMask: 1 },
              }),
            // Only when the successful path did not already release: a second `mouseReleased`
            // with no press behind it is a stray event in the page's log.
            () =>
              released
                ? Promise.resolve()
                : cdp.send("Input.dispatchMouseEvent", {
                    type: "mouseReleased",
                    x: 0,
                    y: 0,
                    button: "left",
                    buttons: 0,
                    clickCount: 1,
                  }),
            () => cdp.send("Input.setInterceptDrags", { enabled: false }),
            () => evaluate(cdp, honeyPot),
          ];
          for (const step of steps) {
            try {
              await step();
            } catch {
              /* every one of these is worth attempting whatever the last one did */
            }
          }
        }
        break;
      }

      // `hover <css> [--from x,y] [--rest <ms>] [--probe <expr>]`
      //
      // A real pointer, resting: `Input.dispatchMouseEvent` `mouseMoved` events, which is what
      // puts Chromium's own hover pipeline in play — the page gets `mouseover`/`mouseout` with
      // real `relatedTarget`s, and React synthesises `onMouseEnter`/`onMouseLeave` from those
      // and from nothing else. A `dispatchEvent` out of `eval` proves nothing about hover.
      //
      // **It approaches from somewhere.** The browser remembers where the pointer was left, so
      // a move onto an element the pointer is already inside crosses no boundary and fires no
      // enter at all — which is a hover command that silently does nothing on its second run.
      // The default approach is 40px above the element's own top edge, held to at least y=2 so
      // a row near the top of the window still has somewhere to be approached from; `--from`
      // names a point when that lands somewhere unhelpful, which is also the answer for the
      // horizontal case — the approach shares the element's own x, so there is nothing to clamp.
      //
      // **The probe is read twice, in this session**: once the moment the pointer arrives, and
      // again after `--rest` milliseconds without moving. That pair is what a dwell timer looks
      // like from outside — `before` is what the page shows a pointer passing through, `after`
      // is what it shows one that stopped — and reading it from a second invocation would
      // measure a page whose pointer has been sitting still for however long the shell took.
      case "hover": {
        const flag = (name) => {
          const i = args.indexOf(name);
          return i === -1 ? null : (args[i + 1] ?? "");
        };
        const flagsWithValues = ["--from", "--rest", "--probe"];
        const positional = args.filter((arg, i) => {
          if (arg.startsWith("--")) return false;
          const before = args[i - 1];
          return !(before && flagsWithValues.includes(before));
        });
        const selector = positional[0];
        if (!selector) throw new Error("hover takes a selector");
        // `flag` answers `""` for a flag typed with no value at all — `hover "css" --rest` —
        // and `Number("")` is 0, which would silently turn a dwell measurement into a
        // measurement of nothing. A flag with no value is the flag not being given.
        const rest = Number(flag("--rest") || 400);
        const probe = flag("--probe");
        const at = await evaluate(
          cdp,
          `(() => {
            const el = document.querySelector(${JSON.stringify(selector)});
            if (!el) return null;
            el.scrollIntoView({ block: "center" });
            const r = el.getBoundingClientRect();
            return {
              x: Math.round(r.x + r.width / 2),
              y: Math.round(r.y + r.height / 2),
              approach: { x: Math.round(r.x + r.width / 2), y: Math.max(2, Math.round(r.top - 40)) },
            };
          })()`,
        );
        if (!at) throw new Error(`no element matches ${selector}`);
        const parked = flag("--from");
        const from = parked
          ? { x: Number(parked.split(",")[0]), y: Number(parked.split(",")[1]) }
          : at.approach;
        const move = (x, y) =>
          cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, buttons: 0 });
        await move(from.x, from.y);
        // A few steps rather than a teleport: a real pointer arrives, and a page that watches
        // `mousemove` (a drag threshold, an auto-scroller) sees the same thing a hand does.
        for (const t of [0.34, 0.67, 1]) {
          await move(
            Math.round(from.x + (at.x - from.x) * t),
            Math.round(from.y + (at.y - from.y) * t),
          );
          await new Promise((r) => setTimeout(r, 16));
        }
        const before = probe ? await evaluate(cdp, probe) : undefined;
        await new Promise((r) => setTimeout(r, rest));
        const after = probe ? await evaluate(cdp, probe) : undefined;
        console.log(
          JSON.stringify({ at: { x: at.x, y: at.y }, from, rest, before, after }, null, 2),
        );
        break;
      }

      case "type":
        for (const ch of args.join(" ")) {
          await cdp.send("Input.dispatchKeyEvent", { type: "char", text: ch });
        }
        console.log("typed");
        break;

      // The responsive pass every UI task owes (the direction's floor is 1024).
      //
      // Takes an optional trailing expression, and measuring through it is the discipline
      // rather than a convenience:
      //
      //     node scripts/cdp.mjs size 1024 768 "document.documentElement.scrollWidth"
      //
      // Not because the override would be gone by the next invocation — for *this* command
      // it would not (see below) — but because a separate `eval` cannot tell a viewport that
      // was overridden from one that never was, so a number read that way is a number nobody
      // proved anything about. The two overrides this script can set do not behave alike, and
      // measuring in-session is the one habit that is correct for both.
      //
      // **Two WebView2 behaviours, measured 2026-08-05.** This override *outlives* its
      // session — set 1024 from one invocation and the next one, and a page reload, still
      // measure 1024, where `setEmulatedMedia` is reverted the moment its socket closes. And
      // `clearDeviceMetricsOverride` is accepted and does **nothing**: neither it nor the
      // protocol's `width: 0, height: 0` restores the window. So `size reset` cannot get you
      // back, and the way back is to set the natural size explicitly — read it
      // (`innerWidth`/`innerHeight`) *before* the first override, and put it back when you
      // are done, or the app window stays that size for the rest of the session.
      case "size": {
        const reset = args[0] === "reset";
        if (reset) {
          await cdp.send("Emulation.clearDeviceMetricsOverride");
          console.error(
            "warning: WebView2 ignores clearDeviceMetricsOverride — pass the natural size " +
              "explicitly (e.g. `size 1280 800`) to get the window back.",
          );
        } else
          await cdp.send("Emulation.setDeviceMetricsOverride", {
            width: Number(args[0]),
            height: Number(args[1] ?? 800),
            deviceScaleFactor: 1,
            mobile: false,
          });
        const expression = reset ? args.slice(1).join(" ") : args.slice(2).join(" ");
        console.log(
          expression ? JSON.stringify(await evaluate(cdp, expression), null, 2) : "sized",
        );
        break;
      }

      // `prefers-reduced-motion`, `prefers-color-scheme` and friends, for the pass the
      // direction doc asks every UI task to make.
      //
      // Two things here are load-bearing, both measured 2026-08-05 and both silent when they
      // are missing — which is how this command spent two plans reporting on a page that was
      // never asked for less motion:
      //
      // * `media` has to be sent *with* the feature. WebView2 accepts a features-only
      //   override and ignores it, leaving `matchMedia("(prefers-reduced-motion: reduce)")
      //   .matches` at `false`. `"screen"` is what the page already is, so forcing it changes
      //   nothing else.
      // * **this** override belongs to the session and is reverted the moment the socket
      //   closes — and every invocation of this script is its own socket. So a `media`
      //   command followed by a separate `eval` measures a page with no override on it at
      //   all. Hence the third argument: an expression evaluated *inside* the same session,
      //   which is the only place the override is real. Not a general rule about emulation,
      //   and do not carry it to `size`: `setDeviceMetricsOverride` outlives its session in
      //   this WebView2 (and cannot be cleared at all). Per-command, measured, both ways.
      //
      //     node scripts/cdp.mjs media prefers-reduced-motion reduce \
      //       "getComputedStyle(document.querySelector('img')).transitionProperty"
      case "media": {
        const reset = args[0] === "reset";
        await cdp.send("Emulation.setEmulatedMedia", {
          media: reset ? "" : "screen",
          features: reset ? [] : [{ name: args[0], value: args[1] }],
        });
        const expression = args.slice(2).join(" ");
        console.log(
          expression ? JSON.stringify(await evaluate(cdp, expression), null, 2) : "emulated",
        );
        break;
      }

      // `shot out.png [width height]` — the size is set *in this session*, which is the only
      // place an emulation override is provably real (see `size`). A shot at a width some
      // earlier invocation asked for is a picture that cannot say what it is a picture of.
      //
      // The size is left in force afterwards rather than cleared, because clearing does not
      // work here and pretending otherwise is worse than saying so: put the window back with
      // an explicit `size <natural w> <natural h>` when the pass is over.
      case "shot": {
        const [file, width, height] = args;
        if (width) {
          await cdp.send("Emulation.setDeviceMetricsOverride", {
            width: Number(width),
            height: Number(height ?? 800),
            deviceScaleFactor: 1,
            mobile: false,
          });
        }
        const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
        const { writeFileSync } = await import("node:fs");
        writeFileSync(file, Buffer.from(data, "base64"));
        console.log(file);
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
          "usage: cdp.mjs <eval|click|text|key|press|hover|type|drag|size|media|shot|console> " +
            "[args]\n" +
            "  --shift on click/text/press holds Shift down for that gesture\n" +
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
