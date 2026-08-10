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
 * something redirects them. `cfg.storyImports.shim` redirects every `.storybook/fake/` import to
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
import { installWorld, type FakeParams } from "../.storybook/fake/world";
import { setArtMode } from "../.storybook/fake/images";

export * from "../.storybook/fake/core";
export * from "../.storybook/fake/scope";
export * from "../.storybook/fake/world";
export * from "../.storybook/fake/images";
export * from "../.storybook/fake/event";
export * from "../.storybook/fake/fixtures";
export * from "../.storybook/fake/cards";

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

  return (
    <QueryClientProvider client={world.client}>
      <Activate world={world} />
      {children}
    </QueryClientProvider>
  );
}

/**
 * The default wrapper every preview card mounts inside — `cfg.provider`'s component.
 *
 * Synthetic art rather than live: it is what a checkout with no network renders, it is what the
 * reference storybook is built with (`initialGlobals.art`), and a card that reached out to
 * Scryfall would draw nothing at all on claude.ai/design, where the page's CSP allows no remote
 * source.
 */
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

export function GrimoirePreviewProvider({ children }: { children: ReactNode }) {
  setArtMode("synthetic");
  useAppSurface();
  return <GrimoireWorld>{children}</GrimoireWorld>;
}
