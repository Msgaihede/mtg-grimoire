/**
 * One story's world: the seed, the fault, the command table and the two module singletons that
 * would otherwise carry one story into the next.
 *
 * This is the body of `preview.tsx`'s decorator, lifted out of it for one reason: a decorator
 * calls React hooks, so testing it means rendering it, and `vite.config.ts` collects
 * `.storybook/**\/*.test.ts` and deliberately not `.test.tsx` — the fakes are plain modules,
 * and a test needing JSX is testing a component. A plain function is testable where the
 * decorator is not, and `world.test.ts` is what proves the isolation this file exists for.
 *
 * **Four pieces of module state outlive a story change. {@link installWorld} resets the first
 * three; the fourth is {@link freshQueryClient}, because it is replaced rather than cleared:**
 *
 * 1. `core.ts`'s dispatch table — it *merges* rather than replaces, so a story that registered
 *    an override would leave it behind for every story after it.
 * 2. `event.ts`'s listener map. A component unmounted by a story change does call its unlisten,
 *    but a story that subscribed by hand, or one whose component did not unmount cleanly,
 *    leaves a subscriber behind — and the next story's `sync:progress` reaches it. Invisible
 *    until something emits, which is why `world.test.ts` emits.
 * 3. `useAppStore` — a zustand store created at module scope, with no reset of its own. It is
 *    restored from a snapshot taken **once, at module load**, before any story has run.
 * 4. `src/lib/query.ts`'s `QueryClient` — see {@link freshQueryClient}.
 *
 * The store snapshot is replaced *wholesale* (`setState(…, true)`), which works because
 * `store.ts` keeps its actions in the state object: replacing state restores the actions along
 * with the fields. A partial `setState` would leave whatever a story had set on any key the
 * snapshot happens not to mention, and there is no key it does not mention.
 */
import { QueryClient } from "@tanstack/react-query";
import { registerCommands, resetCommands } from "./core";
import { resetListeners } from "./event";
import { allHandlers } from "./db";
import type { FakeDb, Fault } from "./db";
import { seed } from "./seeds";
import type { SeedName } from "./seeds";
import { useAppStore } from "@/lib/store";

/**
 * `parameters.fake`, and the whole of what a story may ask for.
 *
 * Both optional: the default is `starter` with no fault, which is the world a story that says
 * nothing gets.
 */
export interface FakeParams {
  seed?: SeedName;
  fault?: Fault | null;
}

/**
 * The store as it was before any story ran.
 *
 * Captured at module load rather than inside {@link installWorld}, because by the time a
 * decorator runs the first time a preview-level `play` or a docs page may already have written
 * to it — and a snapshot taken then would restore that instead of the app's own defaults.
 */
const PRISTINE_STORE = useAppStore.getState();

/**
 * A query client per story.
 *
 * `src/lib/query.ts` exports a **module singleton**, and shared across stories it carries one
 * story's cache into the next: a story seeded `empty` would render the previous story's rows
 * from cache before its own (empty) query resolved, and look like a bug in the component.
 *
 * `retry: false` where the app has `retry: 1`, and that is the only intentional difference: a
 * story about a refusal — `busy`, `gone`, a failed sync — should show the refusal at once
 * rather than after a silent retry. `staleTime` matches the app's, because it changes what the
 * component does rather than how fast a story settles.
 */
export function freshQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, retry: false } } });
}

/**
 * Put one story's world in place, and return the store it will read and write.
 *
 * Synchronous and total: everything a story could have changed is either reset here or is not
 * global. Call it *before* the story's first render — a query that fires against an empty
 * dispatch table gets "No fake handler registered", which is a real error message about a
 * problem the story does not have.
 */
export function installWorld(params: FakeParams | undefined): FakeDb {
  resetCommands();
  resetListeners();
  useAppStore.setState(PRISTINE_STORE, true);
  const db = seed(params?.seed ?? "starter");
  db.fault = params?.fault ?? null;
  registerCommands(allHandlers(db));
  return db;
}
