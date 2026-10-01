import type { ReactElement } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { render, type RenderResult } from "@testing-library/react";
import { vi } from "vitest";
import { TooltipProvider } from "@/components/tooltip/TooltipProvider";
import { installWorld, type FakeParams } from "../../.storybook/fake/world";

/**
 * jsdom lays nothing out, so a virtualised wall mounts zero rows without a height to measure.
 * The numbers `src/stories.test.tsx` gives every story, for the same reason.
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
 */
export function renderPhone(
  ui: ReactElement,
  { path = "/", fake }: { path?: string; fake?: FakeParams } = {},
): RenderResult {
  window.history.replaceState(null, "", path);
  const world = installWorld(fake ?? { seed: "starter" });
  world.mount();
  return render(
    <QueryClientProvider client={world.client}>
      <TooltipProvider>{ui}</TooltipProvider>
    </QueryClientProvider>,
  );
}
