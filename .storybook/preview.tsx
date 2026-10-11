import { useEffect, useLayoutEffect, useMemo, type ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { MotionConfig } from "motion/react";
import type { Decorator, Preview } from "@storybook/react-vite";
import { ContextMenuProvider } from "@grimoire/ui/components/menu/ContextMenuProvider";
import { TooltipProvider } from "@grimoire/ui/components/tooltip/TooltipProvider";
import { CardToDeckProvider } from "@grimoire/ui/features/card/cardMenu";
import { installKeyboardModality } from "@grimoire/ui/lib/keyboardModality";
import { installWorld, type FakeParams, type FakeWorld } from "@grimoire/fake/world";
import { CARD_ART_DIR, setArtMode, setBundledArtRoot, type ArtMode } from "@grimoire/fake/images";
// The app's stylesheet *through* `preview.css`, never directly: that file adds `.storybook` as
// a Tailwind source, which is the one thing the shipped bundle must not inherit. See its header.
import "./preview.css";
import "mana-font/css/mana.css";
import "keyrune/css/keyrune.css";

// **What `main.tsx` does for the app, done once for the preview frame.** Every focus outline in
// the app is gated on the `data-kbd` attribute this maintains, so a workbench without it is one
// where Tab draws nothing and a play that asserts a focus ring fails for a reason that has
// nothing to do with the component under test. Module scope, not a decorator: it is a property
// of the frame the stories share, and installing it per story would stack a listener set per
// remount. The uninstaller is dropped deliberately — the frame outlives every story in it.
installKeyboardModality(window);

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
 * `packages/ui/stories.test.tsx`'s `two stories with different seeds` block is what proves the order
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
 * function component nor a custom React Hook function" — measured, it fails `pnpm lint`).
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
 * **One global the fake cannot make per-story: `packages/ui/lib/store.ts`.** zustand's `create` does
 * not expose the initializer it was given, and the store's actions close over that one store's
 * `set`, so a second instance of it cannot be built from `.storybook/` — it would take an edit
 * to component source, which this branch does not have. So the store is reset per story on the
 * canvas and left alone on a docs page, and the story files that **write** it during render carry
 * `docs.story.inline: false`, which gives each of their docs stories its own frame and with it
 * its own module graph. Most of the catalogue is isolated in-process instead, which is what
 * keeps it readable.
 *
 * **Which files those are is a grep and not a list here**, and that is a correction: this
 * paragraph named five of them and the naming rotted exactly the way the count below did —
 * `CardDetailPane` was on it until the docked card surface was deleted on 2026-09-03, and by
 * then the real set was more than twice as long. `grep -rl "useAppStore" packages/ui/ --include=*.stories.tsx`
 * is the question; every answer needs the parameter.
 *
 * **There is no longer a count here, and its deletion is the fix rather than a gap.** This
 * paragraph used to carry "43 of the 51 story files still render inline" and it rotted three
 * times over — "30 of 34" against 44 files, then "40 of 47" against 48, where the 40 was right
 * and only the total was stale, which is the harder kind to notice. `.storybook/CLAUDE.md`'s rule
 * is the general form: **a count is a fact about a _tree_**, so every open branch has its own and
 * none is the one being shipped. Measure it at the moment of need — `pnpm build-storybook`,
 * then `storybook-static/index.json`.
 *
 * **The other files carrying the same parameter do so for reasons of their own**, and the reasons
 * are what is worth writing down: `DeckSettingsDialog`, `CreateDeckDialog`, `ImportDialog` and
 * `ExportDialog` each draw a `fixed inset-0` scrim that rendered inline would cover the whole docs
 * page rather than its own block; `ContextMenu` draws a `fixed` panel at `LAYER.popup` for the
 * same reason, and needs the frame twice over, since a per-story iframe is also a fake world per
 * story — which a press handler, unlike a `queryFn`, is not otherwise bound to; and
 * `CardZoomIndicator` declares it on **one story** rather than on the file, so that pressing Zoom
 * in on the docs page cannot leave a pulse behind in the page's own store.
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
  // answer to anything that is not the literal `"live"` or `"bundled"` — it is the mode that
  // needs no network and no folder.
  //
  // `bundled` also needs to know where its folder is, and this is the file that knows:
  // `main.ts` mounts `.design-sync/card-art/` at the Storybook root, which is the directory
  // `iframe.html` is served from, so the page's own base URI is the answer on a dev server and
  // in a static build alike. Every other mode clears the root, so a reader who flips the toolbar
  // back leaves nothing behind that a later `bundled` could mistake for its own.
  const art = context.globals.art;
  if (art === "bundled") {
    setBundledArtRoot(new URL(`${CARD_ART_DIR}/`, document.baseURI).href);
    setArtMode("bundled");
  } else {
    setBundledArtRoot(null);
    setArtMode(art === "live" ? "live" : "synthetic");
  }
  // `<MotionConfig reducedMotion="user">` stands in for the one `packages/ui/App.tsx` mounts, because a
  // story renders its component and never the app around it. Without it a workbench built to
  // check accessibility would be the one place in the project where reduced motion is ignored —
  // `motion`'s own default is `"never"`. It is a context provider and renders no DOM, so it
  // costs a story nothing. `packages/ui/lib/tokens.test.ts` counts these only under `packages/ui/`; this is a
  // second mount of the same rule, not a second rule.
  //
  // The suite's other half of the story wiring — `MotionGlobalConfig.skipAnimations` — is
  // deliberately *not* here: this file is also the real Storybook browser, where the reader is
  // meant to see the motion. It lives in `packages/ui/test-setup.ts`.
  //
  // The two menu providers stand in for `packages/ui/App.tsx`'s the same way, and in its order —
  // `CardToDeckProvider` outside `ContextMenuProvider`, because that provider draws its panel as
  // a **sibling** of its children, so a card-to-deck context mounted inside it would be around
  // every view and around none of the menu's own rows. **Inside `FakeWorld`**, which is what
  // supplies the `QueryClientProvider` both of them need.
  //
  // `AppShell` is what forced this rather than a menu story: it consumes the refusal hook
  // directly, so it *throws* without the outer provider and every one of its stories went red at
  // once. That is the contract working — but the workbench's job is to stand in for the app, so
  // the answer is to mount what the app mounts, not to soften the throw. `ContextMenuProvider`
  // comes along because a workbench where no story can open a menu is the wrong workbench;
  // `ContextMenu.stories.tsx` keeps its own local pair, which nests harmlessly and is that file's
  // actual subject.
  //
  // `TooltipProvider` stands in for `packages/ui/App.tsx`'s the same way and sits outside both, for the
  // reason that file gives: the menu provider draws its rows as a sibling of its children, so a
  // tooltip context mounted inside it would not reach them.
  return (
    <MotionConfig reducedMotion="user">
      <FakeWorld params={(context.parameters.fake ?? {}) as FakeParams} viewMode={context.viewMode}>
        <TooltipProvider>
          <CardToDeckProvider>
            <ContextMenuProvider>
              <Story />
            </ContextMenuProvider>
          </CardToDeckProvider>
        </TooltipProvider>
      </FakeWorld>
    </MotionConfig>
  );
};

/**
 * The art a session opens on: synthetic, unless the build was started with
 * `STORYBOOK_ART=bundled`.
 *
 * `.design-sync/build-reference.mjs` is what sets it, for the reference storybook the design
 * sync compares every preview against — the previews draw the bundle's shipped JPGs, so a
 * reference opening on synthetic art would make every card-bearing component a mismatch. Read
 * through `import.meta.env` because Storybook's Vite builder adds `STORYBOOK_` to Vite's
 * `envPrefix` (`storybook:config-plugin`), and Vite inlines a variable with a listed prefix into
 * the preview and keeps the rest of the environment out of it. `vite/client`, listed in this
 * program's `tsconfig.json`, types the read — as an `any`, hence a comparison and never a cast.
 *
 * **`packages/ui/stories.test.tsx` sees synthetic, and has to**: it runs every story through
 * `setProjectAnnotations` with this file, and nothing sets the variable for Vitest. `live` is
 * deliberately not honoured here — no build has a reason to open on the network.
 */
const OPENING_ART: ArtMode = import.meta.env.STORYBOOK_ART === "bundled" ? "bundled" : "synthetic";

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
   *
   * **Bundled is the third, and it is the design system's art**: the fixture's own JPGs, which
   * `.design-sync/card-art.mjs` downloads into a gitignored folder and `main.ts` serves at
   * `/card-art` — only when the build was started with `STORYBOOK_ART=bundled` and the folder
   * exists. It is the picture a design built from the bundle shows on claude.ai, where no page
   * may load a remote image, so this is where a reader checks that picture. Chosen on a session
   * with no folder mounted, every card draws the app's own no-image frame rather than falling
   * back quietly: a missing download should look like one.
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
          { value: "bundled", title: "Bundled (design-system art)" },
        ],
        dynamicTitle: true,
      },
    },
  },
  initialGlobals: { art: OPENING_ART },
  decorators: [withFake],
};

export default preview;
