import { useEffect, useLayoutEffect, useMemo, type ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { MotionConfig } from "motion/react";
import type { Decorator, Preview } from "@storybook/react-vite";
import { installWorld, type FakeParams, type FakeWorld } from "./fake/world";
import { setArtMode } from "./fake/images";
// The app's stylesheet *through* `preview.css`, never directly: that file adds `.storybook` as
// a Tailwind source, which is the one thing the shipped bundle must not inherit. See its header.
import "./preview.css";
import "mana-font/css/mana.css";
import "keyrune/css/keyrune.css";

/**
 * Point the fake at this story's world, once per commit, **before the story's own effects
 * run**.
 *
 * Rendered as the story's first sibling and returning `null`, which is what buys the ordering:
 * React fires effects in fiber-completion order, so a leaf rendered before a subtree runs its
 * effects before that subtree's. Put the same call in {@link FakeWorld}'s own effect instead
 * and it would run *after* the story's, because a parent completes after its children — and
 * the story's mount effects are where `useSyncProgress` subscribes, where `useSync` makes its
 * first poll and where `CollectionPage` prewarms its images.
 *
 * Both phases, with no dependency array, because both exist: `useSyncExternalStore`'s
 * subscribe — which is what starts TanStack Query's first fetch — runs in the layout phase,
 * and the app's own `useEffect`s run in the passive one. Neither call is conditional on
 * anything having changed; re-pointing at the world this story already had is free.
 *
 * `src/stories.test.tsx`'s `two stories with different seeds` block is what proves the order
 * holds; it fails if this element is moved after `{children}`.
 */
function Activate({ world }: { world: FakeWorld }) {
  useLayoutEffect(() => {
    world.activate();
  });
  useEffect(() => {
    world.activate();
  });
  return null;
}

/**
 * The fake backend, installed around one story.
 *
 * **A component rather than the decorator itself**, and that is not a style choice: a decorator
 * is a plain function and `react-hooks/rules-of-hooks` refuses hooks in one ("neither a React
 * function component nor a custom React Hook function" — measured, it fails `npm run lint`).
 * Storybook renders a decorator's result as a component anyway, so this is what was already
 * happening, named.
 *
 * **`useMemo`, not `useEffect`.** An effect runs after the first paint, so the story's opening
 * queries would fire against an empty dispatch table and fail before the handlers existed.
 *
 * **The world is an object now, and the memo is what makes it one per story rather than one
 * per page.** It used to overwrite module globals, which is correct on the canvas — Storybook
 * unmounts the previous tree before mounting the next — and wrong on an autodocs page, where
 * every story mounts at once and the last one to render owned the dispatch table, the listener
 * map and the store for the whole page. `scope.ts` has the four entry points that keep the
 * pointer right; this component supplies two of them (the memo, and {@link Activate}).
 *
 * `mount()` in an effect and not in the memo: it is what makes an emitted event reach this
 * story, and it is undone by React's own teardown, which is the only thing that knows when a
 * story on a docs page has gone.
 */
function FakeWorld({
  params,
  viewMode,
  children,
}: {
  params: FakeParams;
  /** `"docs"` when several stories share this page — and therefore share `useAppStore`. */
  viewMode: string | undefined;
  children: ReactNode;
}) {
  const { seed = "starter", fault = null } = params;
  const world = useMemo(
    () => installWorld({ seed, fault }, { resetStore: viewMode !== "docs" }),
    [seed, fault, viewMode],
  );

  useEffect(() => world.mount(), [world]);

  return (
    <QueryClientProvider client={world.client}>
      <Activate world={world} />
      {children}
    </QueryClientProvider>
  );
}

/**
 * Every story runs against a seeded fake backend of its own.
 *
 * `parameters: { fake: { seed: "empty", fault: "busy" } }` picks the world; saying nothing gets
 * `starter` with no fault. What a world owns lives in `fake/world.ts`, how the fake is kept
 * pointed at the right one lives in `fake/scope.ts`, and what is in each world lives in
 * `fake/seeds.ts`.
 *
 * **One global the fake cannot make per-story: `src/lib/store.ts`.** zustand's `create` does
 * not expose the initializer it was given, and the store's actions close over that one store's
 * `set`, so a second instance of it cannot be built from `.storybook/` — it would take an edit
 * to component source, which this branch does not have. So the store is reset per story on the
 * canvas and left alone on a docs page, and the four story files that **write** it during
 * render — `AppShell`, `CardDetailPane`, `SearchPage`, `CollectionPage` — carry
 * `docs.story.inline: false`, which gives each of their docs stories its own frame and with it
 * its own module graph. Everything else on every other docs page is isolated in-process, which
 * is what keeps the catalogue readable: **42 of the 50 story files still render inline** —
 * re-derived 2026-08-14 from the built index *and* from source, both terms at once, which is the
 * only way this figure has ever been right. It had rotted twice before that: it read "30 of 34"
 * against 44 files, and then "40 of 47" against 48 files with **eight** opt-outs, naming five of
 * them.
 *
 * The other four are not about the store at all. `CreateDeckDialog`, `DeckSettingsDialog` and
 * `ImportDeckDialog` each draw a `fixed inset-0` scrim, which rendered inline would cover the
 * whole docs page rather than its own block; `CardZoomIndicator` takes a frame so that pressing
 * Zoom in on the docs page cannot leave a pulse behind in the page's own store.
 */
const withFake: Decorator = (Story, context) => {
  // **Here and not in `installWorld`, and not inside `FakeWorld`'s memo either.** A global is
  // the thing that outlives a story change, so resetting it with the rest of the fakes' module
  // state would snap the art back to Synthetic on every story click while the toolbar still
  // said Live. And the memo only re-runs when the seed or the fault changes, so putting it
  // there would make flipping the toolbar do nothing until the reader also changed worlds.
  // A decorator body runs on every render, including the one Storybook triggers when a global
  // changes, which is exactly the schedule this needs.
  //
  // Narrowed rather than cast: `globals` is untyped, and a global is `undefined` in a context
  // that never saw `initialGlobals` (a docs render, a portable story). Synthetic is the safe
  // answer to anything that is not the literal `"live"` — it is the mode that needs no network.
  setArtMode(context.globals.art === "live" ? "live" : "synthetic");
  // `<MotionConfig reducedMotion="user">` stands in for the one `src/App.tsx` mounts, because a
  // story renders its component and never the app around it. Without it a workbench built to
  // check accessibility would be the one place in the project where reduced motion is ignored —
  // `motion`'s own default is `"never"`. It is a context provider and renders no DOM, so it
  // costs a story nothing. `src/lib/tokens.test.ts` counts these only under `src/`; this is a
  // second mount of the same rule, not a second rule.
  //
  // The suite's other half of the story wiring — `MotionGlobalConfig.skipAnimations` — is
  // deliberately *not* here: this file is also the real Storybook browser, where the reader is
  // meant to see the motion. It lives in `src/test-setup.ts`.
  return (
    <MotionConfig reducedMotion="user">
      <FakeWorld params={(context.parameters.fake ?? {}) as FakeParams} viewMode={context.viewMode}>
        <Story />
      </FakeWorld>
    </MotionConfig>
  );
};

const preview: Preview = {
  parameters: {
    controls: { matchers: { color: /(background|color)$/i, date: /Date$/i } },
    backgrounds: { disable: true },
  },
  /**
   * Where card art comes from, as a toolbar switch rather than a story parameter.
   *
   * A global because it is a property of the *session* and not of the story: the reader turns
   * it on to check a real crop against a real frame, and it has to stay on while they walk
   * through the wall. Synthetic is the default so a checkout with no network — CI, a plane —
   * renders every story exactly as a checkout with one does, and so that `storybook build`
   * produces a static site that draws card art without ever touching Scryfall.
   */
  globalTypes: {
    art: {
      description: "Where card art comes from",
      toolbar: {
        title: "Art",
        icon: "photo",
        items: [
          { value: "synthetic", title: "Synthetic (offline)" },
          { value: "live", title: "Live (Scryfall CDN)" },
        ],
        dynamicTitle: true,
      },
    },
  },
  initialGlobals: { art: "synthetic" },
  decorators: [withFake],
};

export default preview;
