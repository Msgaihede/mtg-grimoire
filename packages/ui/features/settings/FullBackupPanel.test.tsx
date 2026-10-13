import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { archiveExport, archiveImport } = vi.hoisted(() => ({
  archiveExport: vi.fn(),
  archiveImport: vi.fn(),
}));
vi.mock("@/lib/ipc", async (original) => ({
  ...(await original<typeof import("@/lib/ipc")>()),
  ipc: { archiveExport, archiveImport },
}));

import { FullBackupPanel } from "./FullBackupPanel";
import { useNotifications } from "@/lib/notifications";

const newest = () => useNotifications.getState().notices[0];

function setup() {
  const restored = vi.fn();
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}
    >
      <FullBackupPanel onRestored={restored} />
    </QueryClientProvider>,
  );
  return { user: userEvent.setup(), restored };
}

describe("complete backup", () => {
  beforeEach(() => {
    archiveExport.mockReset().mockResolvedValue(true);
    archiveImport.mockReset().mockResolvedValue(true);
  });

  it("warns that restore replaces current data and exports without reloading", async () => {
    const { user, restored } = setup();
    expect(screen.getByText(/Import replaces all current app data/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Export ZIP…" }));
    // A toast, since the ZIP is on disk where the panel cannot show it.
    await waitFor(() =>
      expect(newest()).toMatchObject({ tone: "success", title: "Complete backup saved" }),
    );
    expect(archiveExport).toHaveBeenCalledWith();
    expect(restored).not.toHaveBeenCalled();
  });

  it("reloads all frontend state only after a completed import", async () => {
    const { user, restored } = setup();
    await user.click(screen.getByRole("button", { name: "Import ZIP…" }));
    await waitFor(() => expect(restored).toHaveBeenCalledOnce());
    expect(archiveImport).toHaveBeenCalledWith();
    // Raised before the reload, so the inbox (kept in `localStorage`) still has it after.
    expect(newest()).toMatchObject({ tone: "success", title: "Backup restored" });
  });

  it.each(["export", "import"] as const)(
    "reports %s cancellation without reloading",
    async (action) => {
      (action === "export" ? archiveExport : archiveImport).mockResolvedValue(false);
      const { user, restored } = setup();
      await user.click(
        screen.getByRole("button", { name: action === "export" ? "Export ZIP…" : "Import ZIP…" }),
      );
      expect(await screen.findByRole("alert")).toHaveTextContent(/cancelled/);
      expect(restored).not.toHaveBeenCalled();
      // A closed picker changed nothing, so it is not news worth keeping.
      expect(useNotifications.getState().notices).toHaveLength(0);
    },
  );

  it("keeps both actions disabled until the picker and operation finish", async () => {
    let finish!: (value: boolean) => void;
    archiveImport.mockReturnValue(
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
    );
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: "Import ZIP…" }));
    expect(screen.getByRole("button", { name: "Importing…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Export ZIP…" })).toBeDisabled();
    finish(false);
    await waitFor(() => expect(screen.getByRole("button", { name: "Import ZIP…" })).toBeEnabled());
  });

  it("says a refused import in a toast and allows a retry", async () => {
    archiveImport
      .mockRejectedValueOnce("The backup is not a valid ZIP archive.")
      .mockResolvedValueOnce(true);
    const { user, restored } = setup();
    await user.click(screen.getByRole("button", { name: "Import ZIP…" }));
    await waitFor(() =>
      expect(newest()).toMatchObject({
        tone: "error",
        title: "Couldn't restore the backup",
        body: "The backup is not a valid ZIP archive.",
      }),
    );
    expect(restored).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Import ZIP…" }));
    await waitFor(() => expect(restored).toHaveBeenCalledOnce());
  });

  it("says a refused export in a toast", async () => {
    archiveExport.mockRejectedValueOnce("The disk is full.");
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: "Export ZIP…" }));
    await waitFor(() =>
      expect(newest()).toMatchObject({
        tone: "error",
        title: "Couldn't save the backup",
        body: "The disk is full.",
      }),
    );
  });
});
