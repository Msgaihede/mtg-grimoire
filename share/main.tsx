/**
 * The public viewer's entry point — **side effects only**.
 *
 * The three-way branch a stranger actually meets lives in `boot.tsx`, which takes its document,
 * its `fetch` and its renderer as arguments so a test can drive all three states. What is left
 * here is everything that can only be done to a real document: install the stylesheet, take the
 * shell's own out, add the dark class, arm the focus indicator, and own the React root.
 *
 * **It has no core**, and that is the design rather than an omission (spec §7): no `ipc`, no
 * `lib/core`, no worker, no OPFS, no wasm and no service worker. A stranger following a link from
 * Discord meets one JSON document and a wall of pictures. The web target's own boot would meet
 * them with a 2.6 MB wasm module, a 75 MB corpus ingest and an OPFS pool that refuses a second
 * tab.
 */
import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { TooltipProvider } from "@/components/tooltip/TooltipProvider";
import { installKeyboardModality } from "@/lib/keyboardModality";
import { boot } from "./boot";
import { ShareBoundary } from "./SharePage";
// `?inline` rather than a side-effect import: `share-worker/src/page.ts` renders the shell and
// links **one** file, `/assets/share.js` by a fixed name. There is no `<link rel="stylesheet">`
// for a bundler to fill in and there cannot be one — the shell is built from a D1 row and cannot
// learn a Vite manifest without a second Worker request. So the sheet travels inside the script.
import css from "./share.css?inline";

// Read before anything is added, because the loop below would otherwise find our own.
const shellStyles = Array.from(document.head.querySelectorAll("style"));

const sheet = document.createElement("style");
sheet.textContent = css;
document.head.appendChild(sheet);

// **The shell's own stylesheet, removed — and it is not tidiness.** Its `body`, `main`, `h1` and
// `p` rules are *unlayered*, and Tailwind's utilities live in `@layer utilities`: an unlayered
// declaration beats a layered one at any specificity, so those four selectors would repaint
// every paragraph and clamp every container on this page whatever class it carries. The sheet
// exists to style the sentence a reader sees before this bundle runs, and by now it has.
for (const style of shellStyles) style.remove();

// `<html class="dark">` is what `index.html` carries in the app and the Worker's shell does not.
// The palette applies at `:root` unconditionally; the class exists only to switch on the `dark:`
// variant the shadcn-derived components ship with.
document.documentElement.classList.add("dark");

// Every focus outline in this bundle is gated on `html[data-kbd]` (see `src/index.css`'s
// `focus-visible` variant), so a page that never installs this is a page where the keyboard
// draws no focus indicator at all — on a wall of controls a reader may only have a keyboard for.
installKeyboardModality(window);

const container = document.getElementById("root");
if (!container) throw new Error("the share shell is missing its #root element");
const root = createRoot(container);

function show(view: ReactNode) {
  // The shell's "not ready yet" sentence sits outside `#root` so React can render over the
  // container without erasing it. Once we have something of our own to say, it would be said
  // twice.
  document.getElementById("pending")?.remove();
  root.render(
    <StrictMode>
      <TooltipProvider>
        {/* Inside the provider so a caught error still draws the notice with the app's chrome,
            and around everything because a throw out of `root.render` is not something `boot`'s
            own `try` can reach — without this, one unguarded field is a blank page. */}
        <ShareBoundary>{view}</ShareBoundary>
      </TooltipProvider>
    </StrictMode>,
  );
}

void boot({ doc: document, fetch: (...args) => globalThis.fetch(...args), render: show });
