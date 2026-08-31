import { useEffect, useLayoutEffect, useRef, useState, type JSX } from "react";
import jsQR from "jsqr";
import { FOCUS } from "@/lib/focus";
import { cn } from "@/lib/utils";
import { BUTTON } from "./controls";

/**
 * Camera to decoded string — the in-app reader for the other half of pairing's QR code.
 *
 * `getUserMedia({ video: { facingMode: "environment" } })` → `<video srcObject muted
 * playsInline>` → a `requestAnimationFrame` loop drawing each frame to an offscreen `<canvas>` →
 * `jsQR` over the pixels. **`onCode` is handed the decoded string exactly as `jsQR` returns it** —
 * this component does not look at what it says. `Invite::decode` on the Rust side accepts both
 * the bare code and the `https://…/pair#<code>` URL form, so parsing which shape it is belongs
 * there and nowhere in this file.
 *
 * **`jsQR` rather than `BarcodeDetector`, which is `undefined` in WebView2** (measured
 * 2026-08-31) — so a platform decoder is not on the table and a JS one is required whatever else
 * is decided. `jsQR` is a plain function over `ImageData`, which is also what makes this one
 * component serve the desktop scanner, Android's and a future web build's, with nothing native
 * underneath any of them.
 *
 * ⚠️ **`NotSupportedError` here does not mean the browser lacks the API.** Measured 2026-08-31:
 * in the Tauri WebView2, permissions policy allows `camera`, `permissions.query` answers
 * `granted`, a `videoinput` device is enumerated — and both `{video:true}` and `{audio:true}`
 * still fail with `NotSupportedError: Not supported`. It is an unhandled WebView2
 * `PermissionRequested`, which `src-tauri/src/camera.rs` handles. **The CSP is not involved**;
 * `sync.md` said it was, and `media-src` governs a `<video src>` fetch while `srcObject` is not
 * one. So a live run of this component against an unpatched build reads `NotSupportedError` in
 * the fallback below — that is the known state this file shipped into, not a bug in it.
 *
 * **Every track this component ever opens is stopped on every exit path** — unmount, a press of
 * Cancel, and a successful decode — and the stop happens through one function latched outside
 * React's render so a `Cancel` press can call it immediately rather than waiting on an unmount
 * that a closing animation might defer. A camera left running is a lit indicator light on the
 * reader's machine after they have moved on, which is worse than any error sentence below.
 *
 * **No vitest for the camera loop** — jsdom has neither `getUserMedia` nor real canvas pixels.
 * What the story file drives instead is the one path jsdom *can* reach: `getUserMedia` throws
 * synchronously here (no `navigator.mediaDevices` in jsdom), which lands this component on its
 * own error branch and the manual fallback below it — the same branch a real `NotSupportedError`
 * takes today. That fallback's textarea → `onCode` wiring is what the story exercises; the frame
 * loop and the decode are the live pass's to prove.
 */
export function QrScanner({
  onCode,
  onCancel,
}: {
  onCode: (text: string) => void;
  onCancel: () => void;
}): JSX.Element {
  const [state, setState] = useState<ScanState>({ kind: "starting" });
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // An offscreen canvas, made once and never re-created — the frame loop below owns it and no
  // render ever needs to see it.
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  if (canvasRef.current === null) canvasRef.current = document.createElement("canvas");

  // `onCode` latched in a layout effect, `useDismissOnEscape`'s reason and shape exactly: the
  // frame loop below mounts once and must not restart every time a parent re-renders with a
  // fresh inline callback, which is the ordinary shape of `onCode={(text) => …}` at a call site.
  // A layout effect rather than a plain assignment during render because the ref has to be
  // current before the *next* frame's tick can read it, and `useEffect` alone is not guaranteed
  // to run before that.
  const onCodeRef = useRef(onCode);
  useLayoutEffect(() => {
    onCodeRef.current = onCode;
  });

  // What `Cancel` calls, and what unmount's cleanup calls — the same function either way, so
  // there is exactly one place a track is ever stopped from. Starts as a no-op so a `Cancel`
  // pressed before the effect below has run (there is no such frame, but the type has to hold
  // something) does nothing rather than throwing.
  const stopRef = useRef<() => void>(() => {});

  useEffect(() => {
    let cancelled = false;
    let stream: MediaStream | null = null;
    let rafId: number | null = null;

    function stopAll() {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      stream?.getTracks().forEach((track) => track.stop());
      stream = null;
    }
    stopRef.current = stopAll;

    function tick() {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (video !== null && canvas !== null && video.readyState >= video.HAVE_ENOUGH_DATA) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (ctx !== null && canvas.width > 0 && canvas.height > 0) {
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const found = jsQR(frame.data, frame.width, frame.height);
          if (found !== null && found.data !== "") {
            // Stop before handing the string over: a caller's `onCode` may synchronously do
            // anything, including unmounting this component, and the camera must already be
            // off by the time that happens rather than depend on the unmount reaching it.
            stopAll();
            onCodeRef.current(found.data);
            return;
          }
        }
      }
      rafId = requestAnimationFrame(tick);
    }

    async function start() {
      try {
        const media = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment" },
        });
        if (cancelled) {
          media.getTracks().forEach((track) => track.stop());
          return;
        }
        stream = media;
        const video = videoRef.current;
        if (video === null) {
          stopAll();
          return;
        }
        video.srcObject = media;
        try {
          await video.play();
        } catch {
          // Some browsers reject an explicit `play()` even though the video is about to play
          // anyway (an `AbortError` from a request interrupted by a second one is the common
          // case) — the frame loop below gates on `readyState`, which is the real signal, so a
          // rejected promise here is not fatal on its own.
        }
        if (cancelled) {
          stopAll();
          return;
        }
        setState({ kind: "scanning" });
        rafId = requestAnimationFrame(tick);
      } catch (err) {
        if (!cancelled) setState({ kind: "error", ...describeError(err) });
      }
    }

    void start();

    return () => {
      cancelled = true;
      stopAll();
    };
    // Empty on purpose — see `onCodeRef` above. `onCancel` is read straight from the prop by the
    // button below, never from inside this effect.
  }, []);

  return (
    <div className="space-y-3">
      <div className="aspect-square w-64 max-w-full overflow-hidden rounded-md border border-border bg-bg">
        {/* Decorative: the status line below is the whole of what a screen reader needs, and a
            camera feed has nothing an `alt`-style description could usefully say. */}
        <video ref={videoRef} muted playsInline aria-hidden="true" className="size-full object-cover" />
      </div>

      {state.kind === "starting" && (
        <p className="text-sm text-dim">Asking for camera access…</p>
      )}

      {state.kind === "scanning" && (
        <p className="text-sm text-dim">Point the camera at the code on the other device.</p>
      )}

      {state.kind === "error" && (
        <div className="space-y-3">
          <p role="alert" className="text-sm text-destructive">
            {state.message}
          </p>
          <ManualEntry onSubmit={onCode} />
        </div>
      )}

      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => {
            // Stop first, cancel second — a reader who has already moved on must not leave a
            // camera lit for however long the surface that opened this takes to unmount it.
            stopRef.current();
            onCancel();
          }}
          className={cn(BUTTON, "border-border text-dim hover:bg-bg")}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/** Where this device's attempt to read a code currently stands. */
type ScanState =
  | { kind: "starting" }
  | { kind: "scanning" }
  | { kind: "error"; name: string; message: string };

/**
 * The three sentences a failed `getUserMedia` can owe, keyed on `DOMException.name` — brief step
 * 4's table, and the fallback for everything that is not one of the two named cases.
 *
 * **The fallback textarea is drawn for all three**, not only the last: `NotFoundError`'s own
 * sentence already says "type the code instead", which only makes sense if the box offering to
 * do that is on screen beside it. A reader denied camera access is in exactly the same position —
 * nothing here can ask again for them, so the only way forward is the same box.
 */
function describeError(err: unknown): { name: string; message: string } {
  // `DOMException` checked on its own rather than folded into `instanceof Error`: whether it
  // sits in `Error`'s own prototype chain has disagreed across engines, and `.name` is the one
  // thing every implementation gives it regardless of where that chain lands.
  const name =
    err instanceof DOMException ? err.name : err instanceof Error ? err.name : "Error";
  switch (name) {
    case "NotAllowedError":
      return { name, message: "MTG Grimoire needs camera access to scan a code." };
    case "NotFoundError":
      return { name, message: "No camera on this device — type the code instead." };
    default:
      return { name, message: `Camera error: ${name}. Type the code instead.` };
  }
}

/**
 * The way through when the camera cannot be used — a blob pasted or typed by hand, exactly the
 * way pairing has always worked one hop over in `SyncPanel`'s own `Paste`. Not imported from
 * there: that component is unexported and this file does not touch `SyncPanel.tsx`, so the same
 * small shape is written out again rather than reached for across a task boundary mid-flight.
 *
 * `aria-disabled` and a no-op-guarded `onClick`, never the `disabled` attribute — `src/CLAUDE.md`'s
 * rule for a control that greys as the reader types, because a `disabled` submit button here would
 * leave the tab order on every keystroke that empties the box.
 */
function ManualEntry({ onSubmit }: { onSubmit: (text: string) => void }): JSX.Element {
  const [text, setText] = useState("");
  const empty = text.trim() === "";
  const submit = () => {
    if (!empty) onSubmit(text.trim());
  };
  return (
    <div className="space-y-2">
      <label className="block space-y-1">
        <span className="block text-[0.6875rem] text-dim">Or type the code</span>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          rows={3}
          spellCheck={false}
          autoComplete="off"
          className={cn(
            "w-full resize-y rounded-md border border-border bg-surface px-2 py-1.5",
            "font-mono text-xs leading-relaxed break-all",
            "focus:border-accent focus:outline-none",
          )}
        />
      </label>
      <button
        type="button"
        aria-disabled={empty}
        onClick={submit}
        className={cn(
          BUTTON,
          "border-border hover:bg-bg",
          empty && "cursor-not-allowed opacity-50 active:scale-100",
          FOCUS,
        )}
      >
        Use this code
      </button>
    </div>
  );
}
