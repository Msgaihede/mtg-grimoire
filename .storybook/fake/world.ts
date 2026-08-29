/**
 * One story's world: the seed, the fault, the command table, the listener map, the query
 * client and the image corpus.
 *
 * This is the body of `preview.tsx`'s decorator, lifted out of it for one reason: a decorator
 * calls React hooks, so testing it means rendering it, and `vite.config.ts` collects
 * `.storybook/**\/*.test.ts` and deliberately not `.test.tsx` — the fakes are plain modules,
 * and a test needing JSX is testing a component. A plain function is testable where the
 * decorator is not, and `world.test.ts` is what proves the isolation this file exists for.
 *
 * **A world is now an object rather than a set of module globals overwritten in place, and
 * that is the whole of what Task F1 changed.** The old shape was correct on the canvas, where
 * Storybook unmounts one story before mounting the next, and wrong on a docs page, where every
 * story mounts at once and the last install won the backend for all of them. What each piece
 * is and how the fake is kept pointed at the right one is `scope.ts`'s header; what is in each
 * world is `seeds.ts`'s.
 *
 * Five things a world owns, and the last is the only one that is still shared:
 *
 * 1. Its **command table** — `core.ts` dispatches into whichever world is pointed at.
 * 2. Its **listener map**. A component unmounted by a story change does call its unlisten, but
 *    a story that subscribed by hand, or one whose component did not unmount cleanly, used to
 *    leave a subscriber behind for the next story to hear. A map per world means the
 *    subscription leaves with the story, and no sweep can reach across to another one.
 * 3. Its **`QueryClient`**. `src/lib/query.ts` exports a module singleton, and shared across
 *    stories it carries one story's cache into the next: a story seeded `empty` would render
 *    the previous story's rows from cache before its own (empty) query resolved, and look like
 *    a bug in the component.
 * 4. Its **image corpus**, handed to `images.ts` so a synthetic card gets a synthetic card's
 *    name and not "Unknown card".
 * 5. `useAppStore` — a zustand store created at module scope with no reset of its own, and the
 *    one thing here that **cannot** be made per-story from outside `src/`. It is restored from
 *    a snapshot taken once at module load, and only for a story rendered on its own; see
 *    {@link installWorld}.
 */
import { QueryClient } from "@tanstack/react-query";
import { allHandlers, applySupporterFault, errorLogSeed, mirrorFailedPass } from "./db";
import type { FakeDb, Fault } from "./db";
import { installCorpus } from "./images";
import {
  activateScope,
  bindTimers,
  createScope,
  mountScope,
  runInScope,
  unmountScope,
} from "./scope";
import type { FakeScope } from "./scope";
import { seed } from "./seeds";
import type { SeedName } from "./seeds";
import { resetWindow } from "./window";
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

/** What a story does with its world once it has one. */
export interface FakeWorld {
  /** The seeded rows. Mutated by the write handlers, and by nothing else. */
  readonly db: FakeDb;
  /** What `core.ts` and `event.ts` are pointed at while this story is being served. */
  readonly scope: FakeScope;
  /** This story's cache, with its `queryFn`s and `mutationFn`s bound to this world. */
  readonly client: QueryClient;
  /** Point the fake here. Called on every commit of the story's tree. */
  activate: () => void;
  /** Run something with the fake pointed here, and put the pointer back. */
  run: <T>(fn: () => T) => T;
  /** Register as mounted — which is what makes an emitted event reach it — and hand back the
   *  unmount. Called from the decorator's effect, so it pairs with React's own teardown. */
  mount: () => () => void;
}

export interface InstallOptions {
  /**
   * Restore `useAppStore` to the state it had before any story ran. **True on the canvas,
   * false on a docs page**, and that split is not a preference: the store is one object for
   * the whole page, so resetting it for the fifth story on a docs page would be reaching into
   * the four already mounted above it.
   */
  resetStore?: boolean;
}

/**
 * The store as it was before any story ran.
 *
 * Captured at module load rather than inside {@link installWorld}, because by the time a
 * decorator runs the first time a preview-level `play` or a docs page may already have written
 * to it — and a snapshot taken then would restore that instead of the app's own defaults.
 */
const PRISTINE_STORE = useAppStore.getState();


/** Wrappers this file put on a `queryFn`/`mutationFn`, so a second pass over an
 *  already-defaulted options object does not wrap one twice. */
const BOUND = new WeakSet<object>();

/**
 * Bind one of TanStack Query's two function slots to a world.
 *
 * The wrapper only has to cover the **synchronous** part of the call, and that is enough
 * because every `queryFn` and `mutationFn` in this app calls `ipc.*` as its first statement.
 * **26** of them in `src/` outside tests and stories, plus the two a story file defines for
 * itself (`Editor`'s `deckCreate` in `DeckEditor.stories.tsx`, `OrphanedCover`'s `deckUpdate`
 * in `DecksPage.stories.tsx` — named rather than cited by line, which is what went stale)
 * — re-counted 2026-08-10
 * after merging the update feature, which added none: `useUpdate` is plain hooks, for
 * `useSync`'s reason. `core.ts`'s `invoke` reads the pointer before its
 * own first `await` and re-points at the way out, so the rest of the chain — including the
 * awaited continuation — stays in this world without the wrapper having to still be on the
 * stack.
 */
function bindFn(holder: Record<string, unknown>, key: string, scope: FakeScope): void {
  const fn = holder[key];
  // `skipToken` is the other thing a `queryFn` can be, and it is not a function.
  if (typeof fn !== "function" || BOUND.has(fn)) return;
  const call = fn as (...args: unknown[]) => unknown;
  const bound = (...args: unknown[]) => runInScope(scope, () => call(...args));
  BOUND.add(bound);
  holder[key] = bound;
}

/**
 * A query client per story, with every fetch it will ever make bound to that story's world.
 *
 * **`defaultQueryOptions` is the seam, and it is the only one that covers every fetch.**
 * `QueryCache.build` creates a `Query` once and hands it `client.defaultQueryOptions(options)`;
 * `QueryObserver.setOptions` runs the same call on **every render** and writes the result back
 * onto the query, so a wrapper installed anywhere else would be replaced by the raw `queryFn`
 * on the next render. Patching the instance rather than subclassing keeps the two casts at
 * this seam instead of restating six generic parameters that only exist to be forwarded.
 * It is safe to mutate what comes back: the method builds a fresh object, and the one path
 * that returns its argument unchanged (`options._defaulted`) returns an object this function
 * has already bound — which is what {@link BOUND} is for.
 *
 * `retry: false` where the app has `retry: 1`, and that is the only intentional difference: a
 * story about a refusal — `busy`, `gone`, a failed sync — should show the refusal at once
 * rather than after a silent retry. `staleTime` matches the app's, because it changes what the
 * component does rather than how fast a story settles.
 */
function worldQueryClient(scope: FakeScope): QueryClient {
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: 30_000, retry: false } },
  });

  // Through `unknown`, because the two methods' declared shapes are six generic parameters
  // deep and TypeScript will not narrow one to a plain record in a single step.
  type Defaulter = (options: unknown) => Record<string, unknown>;
  const baseQuery = client.defaultQueryOptions.bind(client) as unknown as Defaulter;
  const baseMutation = client.defaultMutationOptions.bind(client) as unknown as Defaulter;

  client.defaultQueryOptions = ((options: unknown) => {
    const defaulted = baseQuery(options);
    bindFn(defaulted, "queryFn", scope);
    return defaulted;
  }) as unknown as typeof client.defaultQueryOptions;

  client.defaultMutationOptions = ((options: unknown) => {
    const defaulted = baseMutation(options);
    bindFn(defaulted, "mutationFn", scope);
    return defaulted;
  }) as unknown as typeof client.defaultMutationOptions;

  return client;
}

/**
 * Build one story's world and point the fake at it.
 *
 * Synchronous and total: everything a story could change is either owned by the object this
 * returns or is `useAppStore`, which is named in this file's header. Call it *before* the
 * story's first render — a query that fires against an empty dispatch table gets "No fake
 * handler registered", which is a real error message about a problem the story does not have.
 *
 * The corpus goes to `images.ts` **here** rather than from the mount effect, because
 * `cardImageUrl` is called during render by components no decorator wraps; it is taken back
 * out when the story unmounts.
 */
export function installWorld(
  params: FakeParams | undefined,
  options: InstallOptions = {},
): FakeWorld {
  bindTimers();
  const db = seed(params?.seed ?? "starter");
  db.fault = params?.fault ?? null;
  // The two faults that change *rows* rather than how a handler answers, and they are opposite
  // halves of the same idea: `errorLog` fills a table, `oracleTagsMissing` empties one — the
  // never-ingested taxonomy, on a seed that has one. Both land here and not in `makeDb`,
  // because this is where a fault is applied at all: a seed is built before anyone has said
  // what has gone wrong with it. Emptying the rows rather than branching in the handlers is
  // what lets a story press Refresh in the first-launch state and watch the piles regroup.
  if (db.fault === "errorLog") db.errorLog = errorLogSeed();
  if (db.fault === "oracleTagsMissing") {
    db.oracleTags = [];
    db.oracleTagTaxonomy = [];
    db.oracleTagParents = [];
    db.oracleTagMeta = null;
  }
  // The same fault one taxonomy over, and **all four tables leave together** because one ingest
  // writes all four: a watermark with no taxonomy behind it is the state the backend goes out of
  // its way never to leave, and half-emptying it here would story a page against a world the app
  // cannot be in.
  if (db.fault === "artTagsMissing") {
    db.artTags = [];
    db.artTagTaxonomy = [];
    db.artTagParents = [];
    db.artTagMeta = null;
  }
  // The third fault that writes to the world rather than only branching in a handler, and the
  // only one that does **both**: a mirror root that has gone is a pass that has *already*
  // failed, so the Backup panel must be able to draw the sentence with nothing having been
  // pressed — and `mirror_rebuild` must still refuse, or pressing the button would clear an
  // error by succeeding into a folder that is not there.
  if (db.fault === "mirrorRootUnwritable") mirrorFailedPass(db);

  // The two supporter states no press can reach — a card Patreon is retrying, and a pledge that
  // has ended. Both write the world rather than branching in a handler, for the reason above:
  // neither is a refusal, and the panel has to draw the state with nothing having been pressed.
  applySupporterFault(db);

  const scope = createScope(allHandlers(db));
  activateScope(scope);

  // The window is a singleton and therefore not part of `scope` — see `fake/window.ts`. That
  // makes it the one piece of fake state a story could inherit from the story before it, so it
  // is cleared here, beside the store reset, for the same reason and at the same moment.
  resetWindow();

  // Replaced *wholesale* (`setState(…, true)`), which works because `store.ts` keeps its
  // actions in the state object: replacing state restores the actions along with the fields.
  // A partial `setState` would leave whatever a story had set on any key the snapshot happens
  // not to mention, and there is no key it does not mention.
  if (options.resetStore !== false) useAppStore.setState(PRISTINE_STORE, true);

  const removeCorpus = installCorpus(db.cards);
  const client = worldQueryClient(scope);

  return {
    db,
    scope,
    client,
    activate: () => activateScope(scope),
    run: (fn) => runInScope(scope, fn),
    mount: () => {
      mountScope(scope);
      return () => {
        unmountScope(scope);
        removeCorpus();
      };
    },
  };
}
