/**
 * The preview wrapper, and the fake backend's one home in the bundle.
 *
 * `.storybook/preview.tsx`'s decorators cannot be bundled for this repo — the converter's
 * decorator bundler hardcodes its esbuild loaders to `.js`/`.json`, and `preview.tsx` reaches
 * `keyrune/css/keyrune.css`, whose `url()`s include a `.eot`. So the provider chain is declared
 * instead, which the skill calls for before upload anyway: the README and every `.prompt.md`
 * generate their wrap guidance from `cfg.provider`, never from a decorator bundle.
 *
 * **The re-exports below are the load-bearing half, not a convenience.** The fake backend keeps
 * its dispatch table, its listener map and its active-scope pointer in module scope. A story
 * that calls `emitFake` reaches the component's subscription only if both sides are looking at
 * the *same* module instance — and a preview compiles the story's imports from source unless
 * something redirects them. `cfg.storyImports.shim` redirects every `packages/fake/` import to
 * `window.MtgGrimoire`, and these re-exports are what put the fakes there to be found. Drop them
 * and `SyncProgress`'s stories emit progress events into a second, unobserved listener map:
 * every panel renders its "before any event" state and the previews look plausibly wrong.
 *
 * The same argument covers `QueryClientProvider`. It arrives here through the bundle, so the
 * client this file creates and the `useQuery` calls inside `AppShell` share one React context
 * object. A provider bundled separately would be a different context and every data-driven
 * component would render its "no QueryClient set" crash instead.
 */
import { useEffect, useLayoutEffect, useMemo, type ReactNode } from "react";

import { QueryClientProvider } from "@tanstack/react-query";
import { installWorld, type FakeParams } from "../packages/fake/world";
import { MotionConfig } from "motion/react";
import { ContextMenuProvider } from "../packages/ui/components/menu/ContextMenuProvider";
import { TooltipProvider } from "../packages/ui/components/tooltip/TooltipProvider";
import { CardToDeckProvider } from "../packages/ui/features/card/cardMenu";
import { installKeyboardModality } from "../packages/ui/lib/keyboardModality";
import { bundledArtRootFor, setArtMode, setBundledArtRoot } from "../packages/fake/images";

export * from "../packages/fake/core";
export * from "../packages/fake/scope";
export * from "../packages/fake/world";
export * from "../packages/fake/images";
export * from "../packages/fake/event";
export * from "../packages/fake/window";
export * from "../packages/fake/fixtures";
export * from "../packages/fake/cards";

/**
 * Point the fake at this world before the story's own effects run.
 *
 * A leaf rendered *before* the subtree, returning `null`, for the reason `.storybook/preview.tsx`
 * documents at length: React fires effects in fiber-completion order, so a leaf ordered first
 * runs its effect before the subtree it precedes — and the subtree's mount effects are where
 * `useSyncProgress` subscribes and `useSync` makes its first poll. Both phases, because
 * `useSyncExternalStore`'s subscribe runs in the layout phase and the app's own effects in the
 * passive one.
 */
function Activate({ world }: { world: { activate: () => void } }) {
  useLayoutEffect(() => {
    world.activate();
  });
  useEffect(() => {
    world.activate();
  });
  return null;
}

/**
 * One seeded fake backend around one subtree.
 *
 * Exported separately from {@link GrimoirePreviewProvider} because a handful of stories declare
 * their own world through `parameters.fake` — a Storybook channel the preview wrapper cannot
 * see, since it wraps the mounted element and never the story's metadata. An owned preview in
 * `.design-sync/previews/` wraps those cells in this component directly with the seed and fault
 * the story asked for, which is the only way their preview and their storybook render agree.
 */
export function GrimoireWorld({
  seed = "starter",
  fault = null,
  children,
}: FakeParams & { children: ReactNode }) {
  // `useMemo`, not `useEffect`: an effect runs after the first paint, so the opening queries
  // would fire against an empty dispatch table and fail before the handlers existed.
  const world = useMemo(() => installWorld({ seed, fault }, { resetStore: true }), [seed, fault]);
  useEffect(() => world.mount(), [world]);

  // **The app's provider stack, mirrored from `.storybook/preview.tsx`'s `withFake`** — which
  // mirrors `packages/ui/App.tsx` in turn. Four of these joined storybook after this file was written,
  // and their absence is not a soft degradation: `AppShell` calls `useCardToDeckRefusal`, which
  // throws "A card menu needs <CardToDeckProvider>" outright, so all eleven of its cells died and
  // the card rendered an empty root until this stack was restored.
  //
  // Order is load-bearing and copied, not invented. `CardToDeckProvider` and `TooltipProvider`
  // sit ABOVE `ContextMenuProvider` because that provider draws its panel as a *sibling* of its
  // children: mounted inside it, a context reaches every view and none of the menu's own rows.
  // Both files write the reasoning out at length; read `packages/ui/App.tsx` before reordering these.
  //
  // Inside `QueryClientProvider` because `CardToDeckProvider` mounts `useDeck`, a query.
  return (
    <MotionConfig reducedMotion="user">
      <QueryClientProvider client={world.client}>
        <Activate world={world} />
        <TooltipProvider>
          <CardToDeckProvider>
            <ContextMenuProvider>{children}</ContextMenuProvider>
          </CardToDeckProvider>
        </TooltipProvider>
      </QueryClientProvider>
    </MotionConfig>
  );
}

/**
 * The page environment `.storybook/preview-head.html` and `index.css`'s base layer supply, and
 * the preview card does not.
 *
 * The generated card html ends its `<head>` with `body{…;background:#fff}` — converter chrome,
 * sized for the usual light design system. This app is dark-only: `index.css` paints
 * `body { @apply bg-bg text-text }` and every foreground token is chosen against
 * `oklch(0.16 0.01 270)`. On white, `--color-dim` body copy is very nearly invisible — measured
 * on RarityGem's first compare sheet, where storybook's dark surface and the preview's white one
 * made the same correct render look like two different components.
 *
 * A `<style>` appended at mount rather than a rule in a stylesheet: the card's own block is
 * inline in `<head>` and would otherwise win on order. **Scoped to the provider deliberately** —
 * this module ships inside `_ds_bundle.js`, which rendered designs also load, and a module-scope
 * side effect here would repaint the design agent's canvas the moment it imported a component.
 * Only preview cards mount the provider, so only preview cards get the surface.
 *
 * The `dark` class mirrors `preview-head.html` exactly, and for the reason recorded there: the
 * palette applies unconditionally, and the class exists only to switch on the `dark:` variant
 * that vendored shadcn components ship with.
 */
const SURFACE_STYLE_ID = "ds-grimoire-preview-surface";

function useAppSurface(): void {
  useLayoutEffect(() => {
    document.documentElement.classList.add("dark");
    if (document.getElementById(SURFACE_STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = SURFACE_STYLE_ID;
    style.textContent = [
      "body{background:var(--color-bg);color:var(--color-text)}",
      ".ds-cell{border-color:var(--color-border)}",
      ".ds-cell>h4{color:var(--color-dim)}",
    ].join("");
    document.head.appendChild(style);
  }, []);
}

/**
 * What `main.tsx` installs for the app and `.storybook/preview.tsx` for the workbench: the
 * `html[data-kbd]` attribute every focus ring in the app is gated on.
 *
 * `packages/ui/index.css` redefines the `focus-visible:` variant as `html[data-kbd] *:focus-visible` and
 * blanks `html:not([data-kbd]) :focus-visible`, so without this a design built from the bundle
 * shows **no keyboard focus ring anywhere** — Tab moves through it and nothing draws. Found on
 * 2026-09-27 grading `TooltipProvider`'s `OnFocus`, whose reference shows the ring.
 *
 * Mounted from the provider rather than at module scope for the same reason as
 * {@link useAppSurface}: the bundle is what rendered designs load, and a listener installed on
 * import would reach a canvas that never asked for one. Counted, because a card mounts one provider
 * per cell and the listeners only need to exist once per window.
 */
let modalityUsers = 0;
let uninstallModality: (() => void) | null = null;

function useKeyboardModality(): void {
  useLayoutEffect(() => {
    if (modalityUsers++ === 0) uninstallModality = installKeyboardModality(window);
    return () => {
      if (--modalityUsers === 0) {
        uninstallModality?.();
        uninstallModality = null;
      }
    };
  }, []);
}

/**
 * The art folder beside this bundle, worked out once from the URL the bundle was loaded from —
 * or `null` when there is no such URL.
 *
 * **Module scope, because `document.currentScript` only means anything now.** It names the
 * `<script>` being run for as long as that script's synchronous evaluation lasts, and is `null`
 * (or some other script) by the time a component renders. This module ships inside the bundle's
 * IIFE, so its top level runs during exactly that evaluation. `bundledArtRootFor` turns the URL
 * into the folder for both of the layouts the bundle ships in — `_ds_bundle.js` at a claude.ai
 * project's root, `components/bundle.js` in the Design System artifact and every canvas that
 * installs it.
 *
 * **A read, not a side effect** — which is what keeps it inside the rule {@link useAppSurface}
 * and {@link useKeyboardModality} are written around. That rule is about what this module does
 * to the page that imports it (a style, a listener), and reading which script is running does
 * nothing to it: a design that loads the bundle and never mounts the provider is left exactly as
 * it was. Guarded for no `document`, and for a `currentScript` that is not an HTML `<script>`
 * (an SVG one has no string `src`), and `null` for a script with no URL at all — an inline
 * script, or an ES module, for which `currentScript` is always `null` — and every one of those is
 * synthetic art.
 */
const BUNDLED_ART_ROOT = bundledArtRootFor(
  typeof document !== "undefined" && document.currentScript instanceof HTMLScriptElement
    ? document.currentScript.src
    : null,
);

/**
 * The default wrapper every preview card mounts inside — `cfg.provider`'s component.
 *
 * **Real card art whenever the bundle was loaded from a URL**, which is every place a design is
 * built: the claude.ai/design project, the Design System artifact, a canvas that installed it.
 * The fixture's own Scryfall JPGs, served from the `card-art/` folder beside the bundle
 * ({@link BUNDLED_ART_ROOT}) — never from Scryfall itself, which would draw nothing there, since
 * the page's CSP allows no remote image source. **Synthetic art when there is no script URL to
 * find the folder from**, which is the only state in which the folder cannot be found at all.
 *
 * **The folder has to ship beside the bundle**, and nothing in the bundle can check that it did:
 * `.design-sync/card-art.mjs --copy <bundle dir>` puts it there after the converter's build,
 * which wipes its output folder every time. A bundle uploaded without it draws every card as the
 * app's own no-image frame — the `<img>` 404s and the frame names the card — which is the
 * visible form of a missing folder rather than a silent fallback to placeholders.
 *
 * The reference storybook the sync compares against is built by `build-reference.mjs` with
 * `STORYBOOK_ART=bundled`, so both sides of every compare draw the same files.
 *
 * **`cardArt` names the folder outright, and it is there for the consumer that inlines the
 * bundle.** The Design System artifact's format says consumers may paste `bundle.js` into an
 * inline `<script>`, and an inline script has no URL — so {@link BUNDLED_ART_ROOT} is `null`
 * there and every card would fall back to synthetic art with the folder sitting right beside
 * it. A relative `cardArt` resolves against the page (`document.baseURI`), which is what a
 * preview card or a canvas artboard can state about itself: `../../card-art/` from
 * `components/<Name>/preview.html`, `ds/<folder>/card-art/` from an artboard. It wins over the
 * script's own URL when both exist, because the caller said where the folder is and the script
 * only implied it.
 */
export function GrimoirePreviewProvider({
  children,
  cardArt,
}: {
  children: ReactNode;
  /** The `card-art/` folder's address, absolute or relative to the page. Optional. */
  cardArt?: string;
}) {
  const root = cardArt ? explicitArtRoot(cardArt) : BUNDLED_ART_ROOT;
  setBundledArtRoot(root);
  setArtMode(root ? "bundled" : "synthetic");
  useAppSurface();
  useKeyboardModality();
  return <GrimoireWorld>{children}</GrimoireWorld>;
}

/** `cardArt` as an absolute folder URL, or `null` for one that does not parse. A trailing slash
 *  is added when missing: `bundledArtPath` answers `normal/<file>` to append to it. */
function explicitArtRoot(cardArt: string): string | null {
  try {
    return new URL(cardArt.endsWith("/") ? cardArt : `${cardArt}/`, document.baseURI).href;
  } catch {
    return null;
  }
}
