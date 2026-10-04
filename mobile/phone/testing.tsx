import type { ReactElement } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { render, type RenderResult } from "@testing-library/react";
import { onTestFinished, vi } from "vitest";
import { TooltipProvider } from "@/components/tooltip/TooltipProvider";
import type { CommandTable } from "../../.storybook/fake/scope";
import { installWorld, type FakeParams } from "../../.storybook/fake/world";

/**
 * The layout jsdom does not have. **Any test that _mounts_ a wall calls this first** — not only
 * one that goes on to expect tiles.
 *
 * jsdom lays nothing out: every element measures 0, so a virtualised wall sizes its scroller at
 * 0px, computes an empty window and draws **no row at all** — and a test that then asserts
 * something is absent from the wall passes over a wall that is simply empty. Three things are
 * shimmed, on `HTMLElement.prototype`, for the life of the test file:
 *
 * - `offsetHeight` — **600**, which is what the virtualiser reads as its scroller's height;
 * - `offsetWidth` — **360**, a phone's;
 * - `scrollTo` — a `vi.fn()` that scrolls nothing, because jsdom implements none on an element. A
 *   test about scrolling gives its own scroller a real one (`CardWall.test.tsx` does).
 *
 * The first and the last are `src/stories.test.tsx`'s, for the same reason. What it does **not**
 * give a wall is a width: `ResizeObserver` never reports here, so a wall stays *unmeasured* and
 * draws the two columns `columnsFor(0)` answers.
 */
export function installLayout(): void {
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, value: 600 });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, value: 360 });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
}

/**
 * Render a piece of the phone face over the Storybook fake.
 *
 * The file calling this must mock Tauri's three API modules with the fake's, **in the file
 * itself** (a `vi.mock` is hoisted per file and cannot live in a helper):
 *
 * ```ts
 * vi.mock("@tauri-apps/api/core", () => import("../../.storybook/fake/core"));
 * vi.mock("@tauri-apps/api/event", () => import("../../.storybook/fake/event"));
 * vi.mock("@tauri-apps/api/window", () => import("../../.storybook/fake/window"));
 * ```
 *
 * **Never mock `@/lib/images`** — `.storybook/CLAUDE.md` records the symptom, a silent
 * 300-second hang.
 *
 * **Call it from inside a test.** The world it installs is unmounted when that test finishes —
 * `onTestFinished`, which has no test to hang on anywhere else. Left mounted, a world goes on
 * being offered every event a later test in the file emits.
 */
export function renderPhone(
  ui: ReactElement,
  {
    path = "/",
    state = null,
    fake,
    commands,
  }: {
    path?: string;
    /** The entry's history state — `routes.ts`'s marks, for a test about an entry the other face
     *  wrote. */
    state?: unknown;
    fake?: FakeParams;
    /** Handlers merged over the world's own **before the first render**, handed the world's own
     *  table so one can wrap a handler rather than restate it. For an answer the face asks for
     *  as it mounts — `sync_status`, the wall's first page — where a `registerCommands` after
     *  the render lands too late. */
    commands?: (own: CommandTable) => CommandTable;
  } = {},
): RenderResult {
  window.history.replaceState(state, "", path);
  const world = installWorld(fake ?? { seed: "starter" });
  if (commands) {
    world.scope.commands = { ...world.scope.commands, ...commands(world.scope.commands) };
  }
  // After the test's own `afterEach`, so the tree — and every subscription it holds in this
  // world — has gone by the time the world does.
  onTestFinished(world.mount());
  return render(
    <QueryClientProvider client={world.client}>
      <TooltipProvider>{ui}</TooltipProvider>
    </QueryClientProvider>,
  );
}
