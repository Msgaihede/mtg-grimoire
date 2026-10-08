/**
 * The light app's entry point — side effects only.
 *
 * `LightApp` is where the app begins; what is left here is what can only be done to a real
 * document, in the order `apps/desktop/src/main.tsx` does it and for its reasons.
 */
import React from "react";
import ReactDOM from "react-dom/client";
import { installKeyboardModality } from "@/lib/keyboardModality";
import { installNativeDragGuard } from "@/lib/nativeDrag";
import { LightApp } from "./LightApp";
import "./mobile.css";
// Mana and set glyphs, imported here rather than from the stylesheet so Vite owns them as
// modules and the `woff2IconFonts` plugin can trim their `@font-face` rules.
import "mana-font/css/mana.css";
import "keyrune/css/keyrune.css";

/** `npm run mobile:dev`: the Storybook fake answers every command and there is no Rust. */
const FAKE = import.meta.env.MODE === "fake";

async function start(): Promise<void> {
  const root = document.getElementById("root");
  if (!root) throw new Error("apps/light/index.html is missing its #root element");

  // Every focus outline is gated on the attribute this keeps on `<html>`.
  installKeyboardModality(window);
  installNativeDragGuard(window);

  // Before React, and a dynamic import so a production build carries none of the fake: Vite
  // replaces `MODE` at build time and the branch is dropped. **The comparison is written out
  // here rather than read from `FAKE`**, so that dropping it rests on a literal the bundler
  // sees at the `if`, not on it folding a `const` — a production bundle has no alias for the
  // fake, and a branch that survived would ship `fakeBoot` and the fake's whole card table as a chunk.
  if (import.meta.env.MODE === "fake") (await import("./fakeBoot")).bootFake();

  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      {/* The fake does not answer `startup_status` — a story never mounts the boot gate — and a
          gate reads a rejected ask as "still loading". So fake mode has no gate. */}
      <LightApp gate={!FAKE} />
    </React.StrictMode>,
  );
}

void start();
