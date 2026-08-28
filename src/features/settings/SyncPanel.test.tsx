import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PairingStatus } from "@/lib/ipc";

const syncPairingStatus = vi.hoisted(() => vi.fn());
const syncPairingBegin = vi.hoisted(() => vi.fn());
const syncPairingAccept = vi.hoisted(() => vi.fn());
const syncPairingRespond = vi.hoisted(() => vi.fn());
const syncPairingConfirm = vi.hoisted(() => vi.fn());
const syncPairingComplete = vi.hoisted(() => vi.fn());
const syncPairingCancel = vi.hoisted(() => vi.fn());
const syncDeviceRename = vi.hoisted(() => vi.fn());
const syncDeviceRevoke = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: {
    syncPairingStatus,
    syncPairingBegin,
    syncPairingAccept,
    syncPairingRespond,
    syncPairingConfirm,
    syncPairingComplete,
    syncPairingCancel,
    syncDeviceRename,
    syncDeviceRevoke,
  },
}));

/** The clipboard is the operating system's, and jsdom has nothing behind Tauri's `invoke`. */
vi.mock("@/lib/clipboard", () => ({ copyText: vi.fn().mockResolvedValue(undefined) }));

import { PAIRING_KEY, REMOVAL_WARNING, SyncPanel } from "./SyncPanel";

const ME = "aa".repeat(16);
const PHONE = "cc".repeat(16);
const OLD = "dd".repeat(16);

/** A device that has never paired. `groupId` and `epoch` are both null, which is the state the
 *  panel must draw as an offer rather than as a group of one. */
const UNPAIRED: PairingStatus = {
  deviceId: ME,
  deviceName: "This device",
  groupId: null,
  epoch: null,
  devices: [],
};

/** A group of three, one of which was taken off — the row that is kept rather than deleted, so
 *  the roster can still say who went and when. */
const PAIRED: PairingStatus = {
  deviceId: ME,
  deviceName: "Desk",
  groupId: "bb".repeat(16),
  epoch: 2,
  devices: [
    { deviceId: ME, name: "Desk", addedAt: 1, revokedAt: null },
    { deviceId: PHONE, name: "Phone", addedAt: 2, revokedAt: null },
    { deviceId: OLD, name: "Old laptop", addedAt: 3, revokedAt: 99 },
  ],
};

/** A 21×21 matrix with a third of its modules dark — enough for the drawing test to count. */
const MODULES = Array.from({ length: 441 }, (_, i) => i % 3 === 0);
const OFFER = { code: "ABCDE-FGHJK", qr: { width: 21, modules: MODULES } };

function harness(status: PairingStatus) {
  return function Harness({ children }: { children: ReactNode }) {
    const [client] = useState(() => {
      const c = new QueryClient({
        defaultOptions: {
          queries: { retry: false, staleTime: Infinity },
          mutations: { retry: false },
        },
      });
      c.setQueryData(PAIRING_KEY, status);
      return c;
    });
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

const unpaired = harness(UNPAIRED);
const paired = harness(PAIRED);

beforeEach(() => {
  syncPairingStatus.mockReset().mockResolvedValue(UNPAIRED);
  syncPairingBegin.mockReset().mockResolvedValue(OFFER);
  syncPairingAccept.mockReset().mockResolvedValue({ sas: "042913", response: "THEIRBLOB" });
  syncPairingRespond.mockReset().mockResolvedValue({ sas: "042913", response: "" });
  syncPairingConfirm.mockReset().mockResolvedValue({ sealedKey: "SEALEDKEY" });
  syncPairingComplete.mockReset().mockResolvedValue(undefined);
  syncPairingCancel.mockReset().mockResolvedValue(undefined);
  syncDeviceRename.mockReset().mockResolvedValue(undefined);
  syncDeviceRevoke.mockReset().mockResolvedValue(undefined);
});

describe("SyncPanel", () => {
  it("offers to pair when this device is in no group", async () => {
    render(<SyncPanel />, { wrapper: unpaired });
    expect(await screen.findByRole("button", { name: /pair a device/i })).toBeInTheDocument();
    expect(screen.getByText(/not paired with anything yet/i)).toBeInTheDocument();
  });

  it("lists the group's devices, and marks a removed one as removed", async () => {
    render(<SyncPanel />, { wrapper: paired });
    expect(await screen.findByText("Phone")).toBeInTheDocument();
    expect(screen.getByText(/old laptop/i)).toBeInTheDocument();
    expect(screen.getByText(/^removed$/i)).toBeInTheDocument();
    // A removed device has no Remove button of its own — it is already off — and neither does
    // this device, because the backend refuses that and a press that cannot work is worse than
    // no press at all.
    expect(screen.queryByRole("button", { name: /remove old laptop/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /remove desk/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /remove phone/i })).toBeInTheDocument();
  });

  /**
   * The six digits are the whole security argument. They must be *shown*, and the confirm
   * button must not be pressable before they are — a panel that let a reader confirm a code
   * they had not seen would be a panel with no man-in-the-middle defence at all.
   */
  it("shows the six digits and refuses to confirm before they exist", async () => {
    const user = userEvent.setup();
    render(<SyncPanel />, { wrapper: unpaired });

    await user.click(await screen.findByRole("button", { name: /pair a device/i }));
    const confirm = await screen.findByRole("button", { name: /codes match/i });
    expect(confirm).toHaveAttribute("aria-disabled", "true");
    expect(screen.queryByTestId("pairing-sas")).not.toBeInTheDocument();

    // Pressing it anyway must reach nothing. This is the assertion `aria-disabled` alone does
    // not make: the attribute is a claim to a screen reader, and the handler is the fence.
    await user.click(confirm);
    expect(syncPairingConfirm).not.toHaveBeenCalled();
  });

  it("shows the digits once the other device has answered, and only then confirms", async () => {
    const user = userEvent.setup();
    render(<SyncPanel />, { wrapper: unpaired });

    await user.click(await screen.findByRole("button", { name: /pair a device/i }));
    await user.type(
      await screen.findByLabelText(/what the other device answered/i),
      "THEIRBLOB",
    );
    await user.click(screen.getByRole("button", { name: /read their answer/i }));

    expect(await screen.findByTestId("pairing-sas")).toHaveTextContent("042913");
    const confirm = screen.getByRole("button", { name: /codes match/i });
    expect(confirm).toHaveAttribute("aria-disabled", "false");

    await user.click(confirm);
    await waitFor(() => expect(syncPairingConfirm).toHaveBeenCalled());
    expect(await screen.findByLabelText(/wrapped key for the other device/i)).toHaveValue(
      "SEALEDKEY",
    );
  });

  /**
   * The joining side compares too, and the blob it has to carry back is not on screen until it
   * has said so. This changes no protocol — the answer is already computed — but a reader who
   * has not looked at the digits has not compared them.
   */
  it("makes the joining device compare before it hands anything back", async () => {
    const user = userEvent.setup();
    render(<SyncPanel />, { wrapper: unpaired });

    await user.click(await screen.findByRole("button", { name: /enter a code/i }));
    await user.type(await screen.findByLabelText(/code the other device is showing/i), "CODE");
    await user.click(screen.getByRole("button", { name: /read the code/i }));

    expect(await screen.findByTestId("pairing-sas")).toHaveTextContent("042913");
    expect(screen.queryByLabelText(/your answer/i)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /codes match/i }));
    expect(await screen.findByLabelText(/your answer/i)).toHaveValue("THEIRBLOB");
  });

  /**
   * §7.6, in the reader's own words. A removal dialog that does not say this implies a lost
   * phone has been wiped, which is the opposite of what happens.
   */
  it("says what removing a device cannot do", async () => {
    const user = userEvent.setup();
    render(<SyncPanel />, { wrapper: paired });

    await user.click(await screen.findByRole("button", { name: /remove phone/i }));
    expect(
      await screen.findByText(/keeps? (whatever|what) it (has )?already/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/cannot/i)).toBeInTheDocument();
    // And the three things §7.6 says the removal *is*, so a rewrite that kept the shape and
    // lost the meaning goes red: the key changes, this app cannot take back what was synced,
    // and no server holds a copy to delete.
    expect(REMOVAL_WARNING).toMatch(/changes the key/i);
    expect(REMOVAL_WARNING).toMatch(/no server has a copy/i);
  });

  it("removes a device only after the dialog is confirmed", async () => {
    const user = userEvent.setup();
    render(<SyncPanel />, { wrapper: paired });

    await user.click(await screen.findByRole("button", { name: /remove phone/i }));
    expect(syncDeviceRevoke).not.toHaveBeenCalled();

    await user.click(await screen.findByRole("button", { name: /remove device/i }));
    await waitFor(() => expect(syncDeviceRevoke).toHaveBeenCalledWith(PHONE));
  });

  /** A matrix of `width * width` booleans draws one `<rect>` per dark module and none per
   *  light one — a code drawn in both colours is twice the nodes for a background `fill`
   *  already answers. */
  it("draws every dark module of the matrix and no light one", async () => {
    const user = userEvent.setup();
    render(<SyncPanel />, { wrapper: unpaired });

    await user.click(await screen.findByRole("button", { name: /pair a device/i }));
    const svg = await screen.findByTestId("pairing-qr");
    expect(svg.querySelectorAll("rect")).toHaveLength(MODULES.filter(Boolean).length);
  });

  it("renames a device by name", async () => {
    const user = userEvent.setup();
    render(<SyncPanel />, { wrapper: paired });

    const rows = await screen.findAllByRole("button", { name: "Rename" });
    await user.click(rows[1]);
    const field = await screen.findByLabelText(/name for phone/i);
    await user.clear(field);
    await user.type(field, "Kitchen{Enter}");

    await waitFor(() =>
      expect(syncDeviceRename).toHaveBeenCalledWith(PHONE, "Kitchen"),
    );
  });

  it("says so when a press is refused, and stays where it was", async () => {
    const user = userEvent.setup();
    syncPairingBegin.mockRejectedValue("The database is busy right now.");
    render(<SyncPanel />, { wrapper: unpaired });

    await user.click(await screen.findByRole("button", { name: /pair a device/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/busy/i);
    expect(screen.queryByTestId("pairing-qr")).not.toBeInTheDocument();
  });
});
