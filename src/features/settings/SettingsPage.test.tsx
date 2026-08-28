import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Update } from "@/lib/useUpdate";

/**
 * Every panel on this page is stubbed, because what is under test is **which of them the page
 * renders** rather than what any of them draws. Each has its own suite already; mounting them
 * for real here would make this file fail for their reasons.
 */
function stub(name: string) {
  const Panel = () => <div>{name}</div>;
  return Panel;
}
vi.mock("@/features/settings/BackupPanel", () => ({ BackupPanel: stub("panel:backup") }));
vi.mock("@/features/settings/CachePanel", () => ({ CachePanel: stub("panel:cache") }));
vi.mock("@/features/settings/CombosPanel", () => ({ CombosPanel: stub("panel:combos") }));
vi.mock("@/features/settings/DangerZonePanel", () => ({
  DangerZonePanel: stub("panel:danger"),
}));
vi.mock("@/features/settings/ErrorLogPanel", () => ({ ErrorLogPanel: stub("panel:errors") }));
vi.mock("@/features/settings/HiddenTagsPanel", () => ({
  HiddenTagsPanel: stub("panel:hidden"),
}));
vi.mock("@/features/settings/MarketplacePanel", () => ({
  MarketplacePanel: stub("panel:prices"),
}));
vi.mock("@/features/settings/UpdatePanel", () => ({ UpdatePanel: stub("panel:update") }));

/**
 * The page's five hooks all reach the backend through the one `ipc` object, so one mock covers
 * them. Every command answers `null`: the results are only ever handed to the stubs above, and
 * a hook that resolves is a hook that does not leave React in a suspended state.
 */
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: new Proxy(
    {},
    { get: () => vi.fn().mockResolvedValue(null) },
  ) as unknown as typeof import("@/lib/ipc").ipc,
}));

import { SettingsPage } from "./SettingsPage";

const NO_UPDATE = {
  status: null,
  action: "check",
  busy: false,
  check: vi.fn(),
  download: vi.fn(),
  apply: vi.fn(),
  openReleasePage: vi.fn(),
} as unknown as Update;

function wrap(node: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{node}</QueryClientProvider>;
}

/**
 * Redefine the agent `isAndroid()` reads by default, and put it back afterwards. A prop would
 * test a parameter nothing passes; the default is what both call sites use.
 */
function pretendAndroid() {
  Object.defineProperty(navigator, "userAgent", {
    value:
      "Mozilla/5.0 (Linux; Android 16; CPH2581) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151 Mobile Safari/537.36",
    configurable: true,
  });
}

afterEach(() => {
  delete (navigator as unknown as Record<string, unknown>).userAgent;
});

describe("the Backup panel is desktop-only", () => {
  it("is on the page under jsdom, which is the desktop shape", () => {
    render(wrap(<SettingsPage update={NO_UPDATE} />));

    expect(screen.getByText("panel:backup")).toBeInTheDocument();
  });

  /**
   * The mirror writes a folder a reader opens in a text editor, syncs with Dropbox or greps —
   * none of which an Android app's own directory affords — and `tauri-plugin-dialog`'s manifest
   * records Android as having no folder picker, so the root could not be chosen either. Rust
   * agrees from the other side: `lib.rs` installs neither the mirror's hook nor its thread on
   * mobile.
   */
  it("is gone on Android, while the rest of the page stays", () => {
    pretendAndroid();

    render(wrap(<SettingsPage update={NO_UPDATE} />));

    expect(screen.queryByText("panel:backup")).not.toBeInTheDocument();
    // The page itself still rendered, so this is the gate rather than a failed mount.
    expect(screen.getByText("panel:cache")).toBeInTheDocument();
    expect(screen.getByText("panel:update")).toBeInTheDocument();
  });
});
