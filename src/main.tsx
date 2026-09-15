import React from "react";
import ReactDOM from "react-dom/client";
import { DesktopBoot } from "./boot/DesktopBoot";
import { installKeyboardModality } from "./lib/keyboardModality";
import { captureInstallPrompt } from "./pwa/install";
import { PwaShell } from "./pwa/PwaShell";
import { WebBoot } from "./web/WebBoot";
import "./index.css";
// Mana and set glyphs, as bundled icon fonts — no CDN, and the CSP has no remote source.
// Imported here rather than from `index.css` so Vite owns them as modules and the
// `woff2IconFonts` plugin can trim their `@font-face` rules to the one format WebView2
// will ask for; see `vite.config.ts`. Their own `--ms-mana-*` fills are a shade off the
// direction doc's, so chips are filled from our tokens and the font supplies the glyph.
import "mana-font/css/mana.css";
import "keyrune/css/keyrune.css";

// Named rather than cast: `index.html` is the only place this element comes from, and a
// missing `#root` should say so instead of failing inside React on a null container.
const root = document.getElementById("root");
if (!root) throw new Error("index.html is missing its #root element");

// Before React, because `beforeinstallprompt` fires once and early and a page that has not
// called `preventDefault()` on it by then has lost it for good — there is no API to ask again.
// Inert on desktop.
captureInstallPrompt(window);

// Before React too, and never torn down: every focus outline in the app is gated on the
// attribute this keeps on `<html>` (see `src/index.css`), so a window that has not installed it
// is a window where the keyboard draws no focus indicator at all. Outside React because it is a
// property of the *window* rather than of any tree — one listener set for both roots below, and
// for whatever remounts under them.
installKeyboardModality(window);

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    {/* Which root a build gets is the same `define` that picks the core, and it folds away:
        a Tauri bundle carries no `WebBoot` and no Worker. **Neither build renders `App`
        directly, and for one reason told twice: its queries need a database that is not open
        yet.** The web build opens its own in a Worker, and opening it can answer "another tab
        already has it". Desktop and Android open theirs on a background thread in Rust, so
        the window can paint while a migration runs — and until that thread finishes, every
        command `App` asks on its first render errors. `DesktopBoot` holds `App` back until
        `startup_status` says the folder is open, and draws the caption and a loader meanwhile. */}
    {/* **The service worker's registration, around whichever root this build renders.** It
        is here rather than inside `App` because on the web target `App` is mounted only once
        a corpus exists - so a hook in there does not run until the reader has downloaded
        75 MB, which is the shell's whole purpose deferred behind the one download it exists
        to survive. Measured in a real browser: a first visit had zero registrations while
        the page showed "Build the card database". Inert on desktop. */}
    <PwaShell>{__CORE__ === "web" ? <WebBoot /> : <DesktopBoot />}</PwaShell>
  </React.StrictMode>,
);
