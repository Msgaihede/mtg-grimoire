# Boundary A: The TS→Core Interface — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put one interface between the frontend and Tauri, so the same `ipc` object can be backed by `invoke` on desktop and by a wasm Worker in a browser.

**Architecture:** A new `src/lib/core/` exports a `Core` interface with two methods — `call` and `listen` — plus a Tauri implementation and a selector that picks one at module load. `src/lib/ipc.ts` changes **two import lines** and nothing else. Every one of its ~136 methods, every DTO type and every call site is untouched.

**Tech Stack:** TypeScript 6.0.x, React 19, Vitest. No new dependencies.

**Spec:** [`docs/superpowers/specs/2026-08-27-cross-platform-design.md`](../specs/2026-08-27-cross-platform-design.md) §3 — Boundary A.

## Why this is small, measured rather than assumed

- `invoke` is imported in **exactly one place in the entire frontend**: `src/lib/ipc.ts:80`.
- `listen` is imported in **two**: `src/lib/ipc.ts:81` and `src/lib/window.ts:20`.
- `src/lib/ipc.ts` exports **three** things: `AUTO_BRACKET`, `ipcError`, and one `ipc` object whose methods each call `invoke("command_name", { args })`.

So the command boundary is one object literal and two imports.

**Deliberately out of scope**, because they are platform *services* rather than the command boundary and each needs its own browser answer: `plugin-dialog` (4 components), `plugin-clipboard-manager`, `plugin-opener`, `api/window` and `src/lib/window.ts`. They get their own PR once the web target exists to implement against — abstracting them now would mean writing an interface with exactly one implementation and guessing at the second.

## Global Constraints

- `npm run verify` before every commit. It does **not** run `cargo fmt` or `clippy`.
- **Never install `@types/node`** — it retypes `setTimeout` and its absence is the only fence.
- **No new dependencies.** TypeScript stays on 6.0.x.
- No `setState` inside an effect — the lint only catches it at `npm run verify`.
- Commit messages use `feat:` / `fix:` / `chore:` / `test:` / `refactor:`.

---

### Task 1: The `Core` interface and its Tauri implementation

**Files:**
- Create: `src/lib/core/types.ts`
- Create: `src/lib/core/tauri.ts`
- Create: `src/lib/core/index.ts`
- Test: `src/lib/core/core.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `Core` (interface, from `@/lib/core`), `tauriCore` (a `Core`, from `@/lib/core/tauri`), and the default export `core: Core` from `@/lib/core`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/core/core.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
const listen = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));

import { tauriCore } from "@/lib/core/tauri";

beforeEach(() => {
  invoke.mockReset();
  listen.mockReset();
});

describe("the Tauri core", () => {
  it("forwards a command name and its named arguments to invoke, untouched", async () => {
    invoke.mockResolvedValue({ ok: 1 });
    const out = await tauriCore.call("search_cards", { req: { text: "bolt" } });
    expect(invoke).toHaveBeenCalledWith("search_cards", { req: { text: "bolt" } });
    expect(out).toEqual({ ok: 1 });
  });

  it("calls a no-argument command with no argument object", async () => {
    invoke.mockResolvedValue([]);
    await tauriCore.call("list_sets");
    expect(invoke).toHaveBeenCalledWith("list_sets", undefined);
  });

  it("hands the event payload to the handler, not the envelope", async () => {
    // Tauri wraps a payload in { event, id, payload }. Every caller in ipc.ts already
    // unwraps it; the Core interface makes that the boundary's job instead, so a browser
    // implementation does not have to fake an envelope it has no reason to have.
    let sink: ((e: { payload: unknown }) => void) | undefined;
    listen.mockImplementation((_name: string, cb: (e: { payload: unknown }) => void) => {
      sink = cb;
      return Promise.resolve(() => {});
    });
    const seen: unknown[] = [];
    tauriCore.listen("sync:progress", (p) => seen.push(p));
    await Promise.resolve();
    sink?.({ payload: { done: 3 } });
    expect(seen).toEqual([{ done: 3 }]);
  });

  it("returns a synchronous unsubscribe that survives being called before listen resolves", async () => {
    const off = vi.fn();
    let resolveListen: ((f: () => void) => void) | undefined;
    listen.mockReturnValue(new Promise<() => void>((r) => (resolveListen = r)));

    const stop = tauriCore.listen("sync:progress", () => {});
    // A component can unmount before Tauri's promise settles. Unsubscribing then must
    // still take effect once it does, or the handler outlives its component.
    stop();
    resolveListen?.(off);
    await Promise.resolve();
    await Promise.resolve();
    expect(off).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- src/lib/core/core.test.ts 2>&1 | tail -20`
Expected: FAIL — `Failed to resolve import "@/lib/core/tauri"`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/core/types.ts`:

```ts
/**
 * The one interface between this frontend and whatever is answering its commands.
 *
 * Two methods, because that is all `src/lib/ipc.ts` has ever needed: a request/response
 * call and a subscription. Everything else about a platform — file pickers, the clipboard,
 * the window frame — is a *service* rather than the command boundary and is abstracted
 * separately, if at all.
 */
export interface Core {
  /**
   * Invoke a backend command by name.
   *
   * `args` is matched **by name** against the Rust command's parameters, so a misspelled
   * key is a runtime deserialization error with no type error anywhere. `ipc.test.ts` pins
   * the names that matter.
   */
  call<T>(command: string, args?: Record<string, unknown>): Promise<T>;

  /**
   * Subscribe to a backend event. The handler receives the **payload**, not an envelope.
   *
   * Returns a synchronous unsubscribe. Synchronous because a React effect's cleanup cannot
   * await, and a component can unmount before the subscription has finished being set up —
   * so the returned function has to be callable immediately and still take effect later.
   */
  listen<T>(event: string, handler: (payload: T) => void): () => void;
}
```

Create `src/lib/core/tauri.ts`:

```ts
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Core } from "./types";

/** The desktop and Android implementation: Tauri's own IPC. */
export const tauriCore: Core = {
  call: <T,>(command: string, args?: Record<string, unknown>) => invoke<T>(command, args),

  listen: <T,>(event: string, handler: (payload: T) => void) => {
    let stopped = false;
    let off: (() => void) | undefined;
    void listen<T>(event, (e) => handler(e.payload)).then((fn) => {
      // Unsubscribed before Tauri finished subscribing: honour it now rather than leaving
      // a handler attached to a component that is already gone.
      if (stopped) {
        fn();
        return;
      }
      off = fn;
    });
    return () => {
      stopped = true;
      off?.();
      off = undefined;
    };
  },
};
```

Create `src/lib/core/index.ts`:

```ts
import { tauriCore } from "./tauri";
import type { Core } from "./types";

export type { Core };

/**
 * The implementation this build talks to.
 *
 * One `const` today because there is one implementation. When the web target lands this
 * becomes the selection point — and it stays a module-level constant rather than a hook or
 * a context, because which core is answering is a fact about the *build*, not about a
 * component tree, and nothing should be able to re-render its way into a different one.
 */
export const core: Core = tauriCore;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test -- src/lib/core/core.test.ts 2>&1 | tail -12`
Expected: 4 passed.

- [ ] **Step 5: Mutate to prove the tests bite**

Temporarily change `tauri.ts`'s listen to `handler(e as T)` instead of `handler(e.payload)`. The envelope test must FAIL. Then temporarily delete the `if (stopped)` branch; the early-unsubscribe test must FAIL. Revert both. **Report either that survives.**

- [ ] **Step 6: Commit**

```bash
npm run verify > /tmp/verify.log 2>&1; grep -E "Test Files|Tests " /tmp/verify.log
git add src/lib/core/
git commit -m "feat(core): one interface between the frontend and whatever answers its commands

Two methods, because that is all ipc.ts has ever needed. The listen contract deliberately
hands over the payload rather than Tauri's envelope, so a browser implementation does not
have to fake a shape it has no reason to have, and returns a SYNCHRONOUS unsubscribe
because a React cleanup cannot await and a component can unmount mid-subscribe."
```

---

### Task 2: Route `ipc.ts` through the boundary

**Files:**
- Modify: `src/lib/ipc.ts:80-81` (the two imports) and every `listen<T>(...)` call in the file
- Test: `src/lib/ipc.test.ts` — **unchanged**, and that is the point

**Interfaces:**
- Consumes: `core` from `@/lib/core` (Task 1).
- Produces: nothing new. `ipc`, `AUTO_BRACKET` and `ipcError` keep their exact exported shapes.

> **The pre-existing `ipc.test.ts` is the assertion here.** It mocks `@tauri-apps/api/core` and `@tauri-apps/api/event` directly. After this change those mocks are still reached — through `core/tauri.ts` — so the file passing **unmodified** is what proves nothing about desktop behaviour moved. Do not edit it.

- [ ] **Step 1: Confirm the baseline is green before touching anything**

Run: `npm run test -- src/lib/ipc.test.ts 2>&1 | tail -8`
Expected: all pass. **Write down the test count** — the same number must appear at Step 4. A suite that silently stops collecting is the failure this guards.

- [ ] **Step 2: Replace the imports**

In `src/lib/ipc.ts`, replace lines 80–81:

```ts
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
```

with:

```ts
import { core } from "@/lib/core";
```

Then add, immediately below the import block, the two shims that let every existing call site stay exactly as it is:

```ts
/**
 * The ~136 methods below are written as `invoke("name", { args })` and stay that way.
 * Only where the call goes has changed — {@link core} decides that, per build.
 */
const invoke = <T,>(command: string, args?: Record<string, unknown>): Promise<T> =>
  core.call<T>(command, args);

/**
 * Tauri's `listen` resolved to an unsubscribe and delivered an *envelope*; {@link Core} is
 * synchronous and delivers the payload. This keeps the old call shape — `listen<T>(name,
 * (evt) => cb(evt.payload))` — working unchanged by re-wrapping the payload, so this task
 * touches two import lines rather than six subscription bodies.
 */
const listen = <T,>(event: string, handler: (evt: { payload: T }) => void): Promise<UnlistenFn> => {
  const off = core.listen<T>(event, (payload) => handler({ payload }));
  return Promise.resolve(off);
};

type UnlistenFn = () => void;
```

Move the `type UnlistenFn` declaration above its first use if TypeScript complains about ordering; it is a type alias, so hoisting is safe.

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit 2>&1 | tail -15`
Expected: no errors. If `UnlistenFn` is re-exported from `ipc.ts`, keep the local alias exported with the same name so no consumer breaks.

- [ ] **Step 4: Run the untouched ipc tests**

Run: `npm run test -- src/lib/ipc.test.ts 2>&1 | tail -8`
Expected: the **same count** as Step 1, all passing, with `ipc.test.ts` unmodified. Confirm with `git diff --stat src/lib/ipc.test.ts` printing nothing.

- [ ] **Step 5: Mutate to prove the routing is real**

Temporarily change `core/index.ts` to `export const core: Core = { call: () => Promise.reject(new Error("nope")), listen: () => () => {} };`. Run `npm run test -- src/lib/ipc.test.ts`. It must FAIL — proving `ipc.ts` genuinely goes through the boundary rather than still reaching Tauri directly. Revert.

**If it still passes, the import swap did not take** — check for a leftover `invoke` import.

- [ ] **Step 6: Commit**

```bash
npm run verify > /tmp/verify.log 2>&1; grep -E "Test Files|Tests " /tmp/verify.log
git add src/lib/ipc.ts
git commit -m "refactor(ipc): route the 136 commands through the core boundary

Two import lines and two local shims; every method body, every DTO type and every call site
is untouched. ipc.test.ts is deliberately NOT modified — it mocks the Tauri modules, which
are still reached through core/tauri.ts, so that file passing unchanged is what proves
desktop behaviour did not move."
```

---

### Task 3: Route the six event subscribers through the boundary

**Files:**
- Modify: `src/lib/useSyncProgress.ts`, `src/lib/useSyncInvalidation.ts`, `src/lib/useMarketplace.ts`, `src/lib/useOracleTagProgress.ts`, `src/features/tags/TagsPage.tsx`, `src/features/settings/CombosPanel.tsx`
- Test: their existing test files — unchanged

**Interfaces:**
- Consumes: `core` from `@/lib/core`.
- Produces: nothing new.

> `src/lib/window.ts` is **not** in this task. It uses `@tauri-apps/api/window` as well as `event`, and the window frame has no browser equivalent at all — it is one of the seams the spec marks absent on web. It stays Tauri-only and is compiled out of the web build later.

- [ ] **Step 1: Confirm the baseline**

Run: `npm run test -- src/lib src/features/tags src/features/settings 2>&1 | tail -8`
Expected: green. Record the counts.

- [ ] **Step 2: Rewrite each subscriber**

For each of the six files, replace the `@tauri-apps/api/event` import with `import { core } from "@/lib/core";` and change the subscription. The existing shape is an effect that awaits a promise and returns a cleanup; the new one does not await:

```ts
// before
useEffect(() => {
  let off: UnlistenFn | undefined;
  void listen<SyncProgressEvent>("sync:progress", (e) => setProgress(e.payload)).then((f) => {
    off = f;
  });
  return () => off?.();
}, []);

// after
useEffect(() => core.listen<SyncProgressEvent>("sync:progress", setProgress), []);
```

Adapt the payload handler per file — some do more than call a setter, and those bodies stay as they are; only the envelope unwrap disappears, because `core.listen` already delivers the payload.

> ⚠️ **Do not introduce a `setState` inside the effect body** while restructuring. The lint that catches it only runs at `npm run verify`, not at `npm run test`, so a mistake here surfaces at the commit gate rather than in the loop.

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit 2>&1 | tail -15`
Expected: no errors.

- [ ] **Step 4: Run their tests**

Run: `npm run test -- src/lib src/features/tags src/features/settings 2>&1 | tail -8`
Expected: the same counts as Step 1, all passing. These files' tests mock `@tauri-apps/api/event`, which `core/tauri.ts` still calls, so they should pass unmodified.

**If a test mocks the event module and now sees no calls**, that test was asserting on the transport rather than the behaviour — change the mock to `vi.mock("@/lib/core", ...)` and say so in the commit, rather than restoring the direct import.

- [ ] **Step 5: Confirm the seam count actually dropped**

Run:
```bash
grep -rn 'from "@tauri-apps' src --include='*.ts' --include='*.tsx' | grep -vE '\.test\.|\.stories\.' | wc -l
```
Expected: **9**, down from 15 — the six event subscribers are gone; what remains is `plugin-dialog` ×4, `plugin-clipboard-manager`, `plugin-opener`, and `window.ts` ×2, all deliberately out of scope.

- [ ] **Step 6: Commit**

```bash
npm run verify > /tmp/verify.log 2>&1; grep -E "Test Files|Tests " /tmp/verify.log
git add src/lib/useSyncProgress.ts src/lib/useSyncInvalidation.ts src/lib/useMarketplace.ts src/lib/useOracleTagProgress.ts src/features/tags/TagsPage.tsx src/features/settings/CombosPanel.tsx
git commit -m "refactor(events): six subscribers go through the core boundary

Each loses its await-then-assign-then-cleanup dance: core.listen is synchronous and hands
over the payload, so an effect becomes one line. window.ts is deliberately left alone — it
also reaches api/window, and the window frame has no browser equivalent at all."
```

---

## Self-Review

**Spec coverage.** Implements spec §3's command and event rows. The `plugin-dialog`, clipboard, opener and window-chrome rows are explicitly deferred, with the reason stated at the top: each needs a browser implementation to be designed against, and an interface with one implementation and a guess is worse than no interface.

**Placeholders.** None. Task 3 says "adapt the payload handler per file" and immediately shows the before/after, which is the transformation rather than a deferral.

**Type consistency.** `Core.call<T>(command: string, args?: Record<string, unknown>): Promise<T>` and `Core.listen<T>(event: string, handler: (payload: T) => void): () => void` are defined in Task 1 and used with those exact signatures in Tasks 2 and 3. `ipc.ts`'s local `invoke` shim keeps the `(command, args?)` shape its ~136 call sites already use, and its local `listen` shim keeps the `Promise<UnlistenFn>` return those call sites already await.

**One risk worth naming.** Task 2 shadows `invoke` and `listen` with local consts of the same names. That is deliberate — it is what makes the diff two lines instead of hundreds — but it means a reader of `ipc.ts` sees `invoke(...)` and must look up to find it is local. The doc comments on both shims say so explicitly, and that is the whole mitigation.

---

## Executed 2026-08-27 — what the plan got wrong

Commits `fef1b2e` → `3912c40` on `boundary-a-core`. **5497 tests passing**; `ipc.ts` names
Tauri nowhere; the 8 remaining imports are exactly the deferred ones. All six mutations bit.

**1. A real defect in the plan's own test.** `Core.call` as written always passed two
arguments, so `ipc.mirrorRebuild()` reached the mock as `("mirror_rebuild", undefined)` while
the test asserts `toHaveBeenCalledWith("mirror_rebuild")` — **vitest compares argument lists**.
That broke 20 tests. `call` now does `args === undefined ? invoke(command) : invoke(command,
args)`, and this plan's Task 1 assertion was corrected with it.

**2. "Do not modify `ipc.test.ts`" was the wrong constraint, and it was mine.** Three
assertions (`:1396`, `:1429`, `:1458`) read `expect(stop).toBe(unlisten)` — `Object.is` against
Tauri's own unlisten. A synchronous `Core.listen` can never satisfy that, because the
underlying handle does not exist when it returns. **That assertion pins transport identity,
which is exactly what the boundary exists to hide**, so honouring it would have meant not doing
the refactor. Replaced with `stop(); expect(unlisten).toHaveBeenCalledTimes(1)` — relaxed in
one direction, tightened in the other.

**3. Task 3's "before" snippet did not exist, and its design was wrong.** None of the
subscribers imported `listen`; all went through `ipc.onX`. The plan's version called
`core.listen` directly, which would have orphaned six tested methods and moved the event-name
strings out of the one file whose doc comments say it owns them. What shipped instead: `ipc.onX`
returns the synchronous unsubscribe, and each effect becomes
`useEffect(() => ipc.onSyncProgress(setProgress), [])`.

**4. There is a seventh subscriber, and no grep for `@tauri-apps` finds it.**
`src/lib/useUpdate.ts` holds no such import but awaited
`ipc.onUpdateProgress(...).then(off => off())`. Against a synchronous API that compiles and
ships a **dead cleanup**. *Enumerate by who calls the API, not by who imports the platform.*

**5. "Their existing test files — unchanged" was wrong by 158 tests.** Eight files mock the
subscriptions as promise-returning; against a synchronous `onX`, React throws *"useEffect must
not return anything besides a function"*. Most of the fix was mechanical
(`mockResolvedValue` → `mockReturnValue`), but six tests encoded behaviour that had moved: two
"handle arrives after unmount" tests were deleted with a pointer to `core.test.ts`, and four
"registration never succeeds" tests kept their names and assertions but dropped
`mockRejectedValue` — that state is unreachable at the hook now, and a mock asserting an
impossible state stays green forever.

**6. Step 5's counts were wrong twice over.** Baseline is **16**, not 15; the enumeration listed
8 while claiming 9; and the grep did not exclude `src/lib/core/tauri.ts`, which is by design the
one file that *should* import Tauri. Final: **10 raw, 8 excluding `core/tauri.ts`**.
