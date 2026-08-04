import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
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

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
