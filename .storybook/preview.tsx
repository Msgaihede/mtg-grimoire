import { useMemo, type ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { Decorator, Preview } from "@storybook/react-vite";
import { freshQueryClient, installWorld, type FakeParams } from "./fake/world";
import "../src/index.css";
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
const withFake: Decorator = (Story, context) => (
  <FakeWorld params={(context.parameters.fake ?? {}) as FakeParams}>
    <Story />
  </FakeWorld>
);

const preview: Preview = {
  parameters: {
    controls: { matchers: { color: /(background|color)$/i, date: /Date$/i } },
    backgrounds: { disable: true },
  },
  decorators: [withFake],
};

export default preview;
