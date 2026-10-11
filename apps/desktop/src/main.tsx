import React from "react";
import ReactDOM from "react-dom/client";
import { DesktopBoot } from "./DesktopBoot";
import { installKeyboardModality } from "@grimoire/ui/lib/keyboardModality";
import { installNativeDragGuard } from "@grimoire/ui/lib/nativeDrag";
import "./desktop.css";
// Mana and set glyphs, as bundled icon fonts — no CDN, and the CSP has no remote source.
// Imported here rather than from `index.css` so Vite owns them as modules and the
// `woff2IconFonts` plugin can trim their `@font-face` rules to the one format WebView2
// will ask for; see `vite.base.ts`. Their own `--ms-mana-*` fills are a shade off the
// direction doc's, so chips are filled from our tokens and the font supplies the glyph.
import "mana-font/css/mana.css";
import "keyrune/css/keyrune.css";

// Named rather than cast: `index.html` is the only place this element comes from, and a
// missing `#root` should say so instead of failing inside React on a null container.
const root = document.getElementById("root");
if (!root) throw new Error("index.html is missing its #root element");

// Before React, and never torn down: every focus outline in the app is gated on the
// attribute this keeps on `<html>` (see `packages/ui/index.css`), so a window that has not
// installed it is a window where the keyboard draws no focus indicator at all. Outside React
// because it is a property of the *window* rather than of any tree — one listener set for the
// root below, and for whatever remounts under it.
installKeyboardModality(window);

// Before React for the same reason, and never torn down either: this app starts no native drag
// (every drag is dnd-kit's pointer gesture), so the only one the page could begin is a text
// selection pulled out of place — issue #473, which took the whole window with it. The guard is
// a property of the window, not of any view. `lib/nativeDrag.ts` has the reading.
installNativeDragGuard(window);

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    {/* **The root does not render `App` directly: its queries need a database that is not
        open yet.** Rust opens it on a background thread, so the window can paint while a
        migration runs — and until that thread finishes, every command `App` asks on its first
        render errors. `DesktopBoot` holds `App` back until `startup_status` says the folder is
        open, and draws the caption and a loader meanwhile. */}
    <DesktopBoot />
  </React.StrictMode>,
);
