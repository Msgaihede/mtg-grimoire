/**
 * The public viewer's entry point.
 *
 * **It has no core**, and that is the design rather than an omission (spec §7): no `ipc`, no
 * `lib/core`, no worker, no OPFS, no wasm and no service worker. A stranger following a link
 * from Discord meets one JSON document and a wall of pictures. The web target's own boot would
 * meet them with a 2.6 MB wasm module, a 75 MB corpus ingest and an OPFS pool that refuses a
 * second tab.
 *
 * What this file does, in order: install the stylesheet, take the shell's own out, find the
 * snapshot, fetch it, and render one of exactly three things — the binder, a sentence, or a
 * sentence with a reason.
 */
import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { TooltipProvider } from "@/components/tooltip/TooltipProvider";
import { installKeyboardModality } from "@/lib/keyboardModality";
import { parseSnapshot } from "@/lib/shareSnapshot";
import {
  SharePage,
  ShareNotice,
  snapshotHref,
  SNAPSHOT_OFFLINE,
  SNAPSHOT_PENDING,
} from "./SharePage";
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
      <TooltipProvider>{view}</TooltipProvider>
    </StrictMode>,
  );
}

/** A thrown sentence, or the generic one. `parseSnapshot` throws four the page can print. */
function sentence(error: unknown): string {
  return error instanceof Error && error.message !== "" ? error.message : SNAPSHOT_OFFLINE;
}

async function boot(): Promise<void> {
  const href = snapshotHref(document);
  if (href === null) {
    // Not an error: the row exists and its blob has not committed yet (spec §4.1). It resolves
    // within seconds, and the shell answers `no-store` so a reload really does re-ask.
    show(
      <ShareNotice
        sentence={SNAPSHOT_PENDING}
        detail="The collection is still uploading. Reload this page in a moment."
      />,
    );
    return;
  }

  show(<ShareNotice sentence="Opening the collection…" />);

  try {
    // ⚠️ **No `credentials` option, and that is what makes the preload count.** The shell's
    // `<link rel="preload" as="fetch" crossorigin>` requests the blob in credentials mode
    // `same-origin`, which is `fetch`'s own default; passing `"omit"` here made the modes
    // disagree and Chromium dropped the warmed response on the floor — *"a preload for … is
    // found, but is not used because the request credentials mode does not match"*, measured in
    // the running page 2026-09-08. The blob is then fetched twice on every cold view, which is
    // the whole of what inlining that link was for.
    const response = await fetch(href);
    if (!response.ok) throw new Error(SNAPSHOT_OFFLINE);
    show(<SharePage snapshot={parseSnapshot(await response.text())} />);
  } catch (error) {
    console.error(error);
    show(
      <ShareNotice
        sentence={sentence(error)}
        detail="If the link came from a chat, ask for it again — a collection can be republished."
      />,
    );
  }
}

void boot();
