/**
 * Which story's world the fake is answering as.
 *
 * **This module exists because of autodocs.** On the canvas Storybook unmounts one story
 * before it mounts the next, so a single set of module globals is one story's world by
 * construction. **A docs page mounts every story on it at once**, and ten of this
 * repository's story files put differing seeds and faults on one page — so a fake whose
 * dispatch table is a module global answers every story on the page as whichever story
 * installed itself last. `ValidationPanel.stories.tsx` names that hazard in the doc above its
 * `chipRef()` and defends against it for one ref; nothing defended the backend.
 *
 * A module global is still what `src/lib/ipc.ts` reaches — it imports `invoke` as a bare
 * function, and no React context can travel down an import. So the global stays and stops
 * *being* a world: it becomes a **pointer at one**, and every way into the fake points it at
 * the right world first. There are four ways in, and every one of them is measured against a
 * real call site in this app:
 *
 * 1. **A `queryFn` or a `mutationFn`.** Every `ipc.*` call in the app is inside one, bar the
 *    three named below — measured 2026-08-10 by grepping `ipc\.[a-zA-Z]` across `src/`. The
 *    world's own `QueryClient` wraps both (see `world.ts`'s `worldQueryClient`), so a fetch
 *    is bound to its story whenever it runs: on mount, on a refetch, on a retry, on an
 *    invalidation after a mutation. This is the layer that matters most, because those later
 *    fetches happen at times no render phase can cover.
 * 2. **A mount effect.** `useSyncProgress`'s `listen`, `useSync`'s first poll
 *    (`useSync.ts:132`) and `CollectionPage.tsx:202`'s `prewarmCollection` all call straight
 *    into the fake from an effect. {@link runInScope} is applied around them by the
 *    `<Activate>` element `preview.tsx` renders as the story's **first sibling**: React fires
 *    effects in fiber-completion order, so a leaf rendered before the story runs its effect
 *    before the story's — which is what makes "the scope is right during this story's mount"
 *    true rather than hopeful.
 * 3. **The continuation after an `await`.** `useSync.ts:130` schedules its next poll *after*
 *    `await ipc.syncStatus()` has resolved, so the scope has to survive the microtask hop.
 *    `core.ts`'s `invoke` re-points the pointer at its own scope on the way out, which lands
 *    it before the caller's continuation runs.
 * 4. **A timer.** That next poll fires 30 s later from a bare `setTimeout`, with no render,
 *    no effect and no query behind it. {@link bindTimers} captures the scope at schedule time
 *    and restores it for the callback — the one monkey-patch in the fake, and the one call
 *    site in the app that needs it.
 *
 * What is deliberately **not** scoped: `src/lib/store.ts`'s zustand store. It is created by a
 * `create(...)` call whose initializer the module does not export, so a second instance of it
 * cannot be built from outside — and its actions close over the one store's `set`, so
 * patching the hook cannot redirect them either. Scoping it needs an edit to component
 * source. The four story files that write it during render (`AppShell`, `CardDetailPane`,
 * `SearchPage`, `CollectionPage`) therefore give each of their docs stories its own frame
 * instead; see `preview.tsx`.
 */

/**
 * A command handler. Defined here rather than in `core.ts` — which re-exports it, and is
 * where `db.ts` still imports it from — because a scope is a table of them and the module
 * that owns a type should be the one nothing else has to import to describe it.
 *
 * `never` in the argument position, not `unknown` and not `any`: it is what lets one
 * `registerCommands` call carry handlers with differently-shaped args. A parameter is checked
 * contravariantly and `never` is assignable to every type, so `(args: { n: number }) => number`
 * satisfies this while `(args: unknown) => …` would reject it. The price is one cast at the
 * single call site in `core.ts`'s `invoke`, which is the right side of the trade — the handler
 * maps are written once per fixture and read constantly.
 */
export type CommandHandler = (args: never) => unknown;

export type CommandTable = Record<string, CommandHandler>;

/** An event subscriber, as `event.ts` stores one. */
export type FakeListener = (event: { payload: unknown }) => void;

export type ListenerMap = Map<string, Set<FakeListener>>;

/**
 * One story's backend: the commands it answers and the events it has been subscribed to.
 *
 * The seeded `FakeDb` is not in here on purpose — it is closed over by the handlers in
 * `commands`, so a scope cannot be pointed at one world's handlers and another's rows.
 */
export interface FakeScope {
  commands: CommandTable;
  readonly listeners: ListenerMap;
}

export function createScope(commands: CommandTable = {}): FakeScope {
  return { commands, listeners: new Map() };
}

/**
 * The scope every call into the fake reads, and the whole of the module state this file has.
 *
 * It starts as an empty scope rather than `null` so that `core.ts`'s `invoke` and
 * `event.ts`'s `listen` have somewhere to work before any world is installed — which is the
 * state `core.test.ts` exercises, and the state a story that forgot its decorator would be
 * in. An empty command table answers "No fake handler registered", which is the error that
 * says what actually went wrong.
 */
let active: FakeScope = createScope();

/** Scopes whose story is **mounted**. Only {@link import("./event").emitFake} reads this: an
 *  event goes to every story on the page that has a listener for it, because a `play` holds
 *  no handle on a scope and nothing else could choose between them. */
const mounted = new Set<FakeScope>();

export function activeScope(): FakeScope {
  return active;
}

/** Point the fake at this world. Called on install, on every commit of the story's tree, and
 *  from {@link runInScope}. */
export function activateScope(scope: FakeScope): void {
  active = scope;
}

/**
 * Run `fn` with the fake pointed at `scope`, and put the pointer back afterwards.
 *
 * **Synchronous restore, deliberately.** It covers the call itself and not what the call's
 * promise does later — that half is `invoke`'s (see this file's header, entry 3), because
 * only the fake's own async boundary knows when a continuation is about to run.
 */
export function runInScope<T>(scope: FakeScope, fn: () => T): T {
  const previous = active;
  active = scope;
  try {
    return fn();
  } finally {
    active = previous;
  }
}

export function mountScope(scope: FakeScope): void {
  mounted.add(scope);
}

export function unmountScope(scope: FakeScope): void {
  mounted.delete(scope);
}

/**
 * Every scope an emitted event should reach: the mounted ones, and the active one when
 * nothing is mounted.
 *
 * The second half is what keeps `world.test.ts` honest — a unit test installs a world and
 * never mounts it, and an event there must reach that world and no earlier one.
 */
export function listeningScopes(): FakeScope[] {
  return mounted.size > 0 ? [...mounted] : [active];
}

/** Forget every scope. `core.test.ts`'s `beforeEach` and nothing else. */
export function resetScopes(): void {
  active = createScope();
  mounted.clear();
}

/* ---------------------------------------------------------------------- timers ------- */

let timersBound = false;

/**
 * Make a `setTimeout` scheduled inside a world fire inside that same world.
 *
 * **The one monkey-patch in the fake, and it has exactly one call site behind it.**
 * `useSync.ts:130` polls `sync_status` on a chain of `setTimeout`s — 30 s apart when idle —
 * and that callback runs with no render, no effect and no query around it. Without this, the
 * eleven `AppShell` stories on one docs page each poll correctly on mount and then, thirty
 * seconds in, all eleven read whichever world was pointed at last: the first-run overlay of
 * the `empty` seed would quietly disappear, on a page nobody was touching.
 *
 * Narrow on purpose. It wraps a **function** handler only (a string one is `eval`, and is
 * nobody's poll), it wraps nothing at all when no world is installed — so a checkout that
 * never renders a story is untouched — and it does not patch `setInterval`, because no code
 * this fake serves uses one. `clearTimeout` needs no patch: the raw timer id is what comes
 * back.
 *
 * Installed once, on the first {@link import("./world").installWorld}, and never undone: the
 * wrapper is a no-op when no scope is active, so removing it would buy nothing. Under Vitest
 * that is per test file, because each file gets its own jsdom environment.
 */
export function bindTimers(): void {
  if (timersBound) return;
  timersBound = true;
  const raw = globalThis.setTimeout;
  const patched = (handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
    if (typeof handler !== "function") {
      return (raw as (h: TimerHandler, t?: number, ...a: unknown[]) => number)(
        handler,
        timeout,
        ...args,
      );
    }
    const scope = active;
    const call = handler as (...a: unknown[]) => void;
    return raw(() => {
      runInScope(scope, () => call(...args));
    }, timeout);
  };
  globalThis.setTimeout = patched as unknown as typeof globalThis.setTimeout;
}
