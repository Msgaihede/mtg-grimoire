import { useMemo, type ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { Decorator, Preview } from "@storybook/react-vite";
import { freshQueryClient, installWorld, type FakeParams } from "./fake/world";
import { setArtMode } from "./fake/images";
// The app's stylesheet *through* `preview.css`, never directly: that file adds `.storybook` as
// a Tailwind source, which is the one thing the shipped bundle must not inherit. See its header.
import "./preview.css";
import "mana-font/css/mana.css";
import "keyrune/css/keyrune.css";

/**
 * The fake backend, installed around one story.
 *
 * **A component rather than the decorator itself**, and that is not a style choice: a decorator
 * is a plain function and `react-hooks/rules-of-hooks` refuses hooks in one ("neither a React
 * function component nor a custom React Hook function" — measured, it fails `npm run lint`).
 * Storybook renders a decorator's result as a component anyway, so this is what was already
 * happening, named.
 *
 * **`useMemo`, not `useEffect`, and one of them rather than two.** An effect runs after the
 * first paint, so the story's opening queries would fire against an empty dispatch table and
 * fail before the handlers existed. And the two jobs share one memo because they share one
 * answer: the query client is only fresh if the world it will cache was installed first, and
 * splitting them would put the same two dependencies on both hooks — which `exhaustive-deps`
 * reads as an unnecessary dependency on the half that does not name them.
 */
function FakeWorld({ params, children }: { params: FakeParams; children: ReactNode }) {
  const { seed = "starter", fault = null } = params;
  const client = useMemo(() => {
    installWorld({ seed, fault });
    return freshQueryClient();
  }, [seed, fault]);

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

/**
 * Every story runs against a seeded fake backend, torn down between stories.
 *
 * `parameters: { fake: { seed: "empty", fault: "busy" } }` picks the world; saying nothing gets
 * `starter` with no fault. What is reset and why lives in `fake/world.ts`, and what is in each
 * world lives in `fake/seeds.ts`.
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
  return (
    <FakeWorld params={(context.parameters.fake ?? {}) as FakeParams}>
      <Story />
    </FakeWorld>
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
