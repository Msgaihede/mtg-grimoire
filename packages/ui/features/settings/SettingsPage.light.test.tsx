import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditionContext, LIGHT_EDITION } from "@/lib/edition";
import { useAppStore } from "@/lib/store";
import type { Update } from "@/lib/useUpdate";

/**
 * The desktop page under the light edition — the one page spec §3.1 lets read it.
 *
 * Every panel is stubbed, `SettingsPage.test.tsx`'s reason: what is under test is which of them
 * the page draws and which entries the rail offers, not what any of them draws.
 */
function stub(name: string) {
  const Panel = () => <div>{name}</div>;
  return Panel;
}
vi.mock("@/features/settings/BackupPanel", () => ({ BackupPanel: stub("panel:backup") }));
vi.mock("@/features/settings/CachePanel", () => ({ CachePanel: stub("panel:cache") }));
vi.mock("@/features/settings/DangerZonePanel", () => ({ DangerZonePanel: stub("panel:danger") }));
vi.mock("@/features/settings/ErrorLogPanel", () => ({ ErrorLogPanel: stub("panel:errors") }));
vi.mock("@/features/settings/HiddenTagsPanel", () => ({ HiddenTagsPanel: stub("panel:hidden") }));
vi.mock("@/features/settings/LabelsPanel", () => ({ LabelsPanel: stub("panel:labels") }));
vi.mock("@/features/settings/MarketplacePanel", () => ({
  MarketplacePanel: stub("panel:prices"),
}));
vi.mock("@/features/settings/ReviewPanel", () => ({ ReviewPanel: stub("panel:review") }));
vi.mock("@/features/settings/StartViewPanel", () => ({ StartViewPanel: stub("panel:start") }));
vi.mock("@/features/settings/SyncPanel", () => ({ SyncPanel: stub("panel:sync") }));
vi.mock("@/features/settings/TheoryMarksPanel", () => ({
  TheoryMarksPanel: stub("panel:theory"),
}));
vi.mock("@/features/settings/UpdatePanel", () => ({ UpdatePanel: stub("panel:update") }));

/** Every command answers `null`, except the one the page polls a number from. */
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: new Proxy(
    {},
    {
      get: (_target, name) => {
        if (name === "windowCount") return vi.fn(() => Promise.resolve(1));
        return vi.fn().mockResolvedValue(null);
      },
    },
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

function light(node: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return (
    <QueryClientProvider client={client}>
      <EditionContext.Provider value={LIGHT_EDITION}>{node}</EditionContext.Provider>
    </QueryClientProvider>
  );
}

const rail = () => screen.getByRole("navigation", { name: "Settings" });
const entries = () => within(rail()).getAllByRole("button").map((b) => b.textContent);

afterEach(() => useAppStore.setState({ pendingSettingsPanel: null }));

describe("Settings in the light edition", () => {
  it("offers only the groups that hold a light panel, in the rail's order", () => {
    render(light(<SettingsPage update={NO_UPDATE} />));
    expect(entries()).toEqual([
      "Card data",
      "Sync",
      "Tags",
      "Appearance",
      "Storage and data",
      "Errors",
    ]);
  });

  it("opens on its first entry, since it has no Updates to land on", () => {
    render(light(<SettingsPage update={NO_UPDATE} />));
    expect(within(rail()).getByRole("button", { name: "Card data" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByText("panel:prices")).toBeInTheDocument();
    expect(screen.queryByText("panel:update")).toBeNull();
  });

  it("draws each group's light panels and none of the desktop's own", async () => {
    render(light(<SettingsPage update={NO_UPDATE} />));

    await userEvent.click(within(rail()).getByRole("button", { name: "Sync" }));
    expect(screen.getByText("panel:sync")).toBeInTheDocument();
    expect(screen.getByText("panel:review")).toBeInTheDocument();

    await userEvent.click(within(rail()).getByRole("button", { name: "Appearance" }));
    expect(screen.getByText("panel:theory")).toBeInTheDocument();
    expect(screen.getByText("panel:labels")).toBeInTheDocument();
    expect(screen.queryByText("panel:start")).toBeNull();

    await userEvent.click(within(rail()).getByRole("button", { name: "Storage and data" }));
    expect(screen.getByText("panel:cache")).toBeInTheDocument();
    expect(screen.getByText("panel:danger")).toBeInTheDocument();
    expect(screen.queryByText("panel:backup")).toBeNull();
    expect(screen.queryByRole("region", { name: "Data folder" })).toBeNull();
  });

  it("finds by search only what it draws", async () => {
    render(light(<SettingsPage update={NO_UPDATE} />));
    await userEvent.type(screen.getByRole("searchbox", { name: "Search settings" }), "dropbox");
    expect(screen.getByText("No matching settings.")).toBeInTheDocument();
    expect(screen.queryByText("panel:backup")).toBeNull();
  });

  it("drops a hand-off naming a panel it does not draw", async () => {
    useAppStore.setState({ pendingSettingsPanel: "backup" });
    render(light(<SettingsPage update={NO_UPDATE} />));
    await waitFor(() => expect(useAppStore.getState().pendingSettingsPanel).toBeNull());
    expect(screen.getByText("panel:prices")).toBeInTheDocument();
    expect(screen.queryByText("panel:backup")).toBeNull();
  });

  it("still follows a hand-off naming one it does", async () => {
    useAppStore.setState({ pendingSettingsPanel: "review" });
    render(light(<SettingsPage update={NO_UPDATE} />));
    await waitFor(() => expect(useAppStore.getState().pendingSettingsPanel).toBeNull());
    expect(screen.getByText("panel:review")).toBeInTheDocument();
  });
});
