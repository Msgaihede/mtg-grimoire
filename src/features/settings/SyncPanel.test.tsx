import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PairingStatus,
  RelayOutcome,
  RelayStatus,
  SupporterStatus,
} from "@/lib/ipc";

const syncPairingStatus = vi.hoisted(() => vi.fn());
const syncPairingBegin = vi.hoisted(() => vi.fn());
const syncPairingAccept = vi.hoisted(() => vi.fn());
const syncPairingRespond = vi.hoisted(() => vi.fn());
const syncPairingConfirm = vi.hoisted(() => vi.fn());
const syncPairingComplete = vi.hoisted(() => vi.fn());
const syncPairingCancel = vi.hoisted(() => vi.fn());
const syncDeviceRename = vi.hoisted(() => vi.fn());
const syncDeviceRevoke = vi.hoisted(() => vi.fn());
const syncRelayStatus = vi.hoisted(() => vi.fn());
const syncPatreonBegin = vi.hoisted(() => vi.fn());
const syncPatreonClaim = vi.hoisted(() => vi.fn());
const syncSupporterStatus = vi.hoisted(() => vi.fn());
const syncNow = vi.hoisted(() => vi.fn());
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
    syncRelayStatus,
    syncPatreonBegin,
    syncPatreonClaim,
    syncSupporterStatus,
    syncNow,
  },
}));

/** The clipboard is the operating system's, and jsdom has nothing behind Tauri's `invoke`. */
vi.mock("@/lib/clipboard", () => ({ copyText: vi.fn().mockResolvedValue(undefined) }));

import {
  PAIRING_KEY,
  REMOVAL_WARNING,
  SyncPanel,
  outcomeText,
  relayNote,
  relayState,
  supporterNote,
  supporterState,
} from "./SyncPanel";

const ME = "aa".repeat(16);
const PHONE = "cc".repeat(16);
const OLD = "dd".repeat(16);

/** A device that has never paired. `groupId` and `epoch` are both null, which is the state the
 *  panel must draw as an offer rather than as a group of one. */
const UNPAIRED: PairingStatus = {
  deviceId: ME,
  // A hostname, because `identity::ensure` mints one — `COMPUTERNAME` on Windows, the model on
  // Android, a user-agent label in a browser. "This device" was every install's name until
  // 2026-08-29 and is now only ever the **pill**, so a fixture still carrying it as a *name*
  // would make `getByText("This device")` ambiguous in exactly the test that matters.
  deviceName: "MAIN-PC",
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

/**
 * No group, nothing waiting, nothing ever synced — what a device that has done none of this
 * answers. **It no longer says anything about whether sync is on**: that moved to
 * {@link SupporterStatus} with the address field, so a fixture here cannot switch it either way.
 */
const RELAY_OFF: RelayStatus = {
  paired: false,
  pending: 0,
  lastSyncAt: null,
  lastError: null,
  reviewCount: 0,
};

/** A group, four changes waiting, and a failure still on the record. */
const RELAY_ON: RelayStatus = {
  paired: true,
  pending: 4,
  lastSyncAt: 1_700_000_000,
  lastError: "the relay answered 502 to a push",
  reviewCount: 0,
};

/** A device that has never connected a membership. `since` is null, and that is the whole of
 *  what tells this apart from a membership that has ended. */
const NOT_CONNECTED: SupporterStatus = {
  connected: false,
  status: "dead",
  since: null,
  groupBound: false,
};

/**
 * A membership that has ended, in the shape `entitlement::revoke` actually leaves.
 *
 * **Three of its four fields are `NOT_CONNECTED`'s**, which is the whole point: the revoke
 * clears the date along with the refresh secret, so `groupBound` is the only thing on this
 * object that remembers the reader was ever a supporter.
 */
const REVOKED: SupporterStatus = {
  connected: false,
  status: "dead",
  since: null,
  groupBound: true,
};

/**
 * A device that was paired to a connected one, before its first token refresh.
 *
 * `store_grant` and `store_status` are two calls and pairing makes only the first (§6.2), so
 * this device holds a live refresh secret with **no status row at all** — which
 * `entitlement::supporter_state` reads back as the default `"dead"`. Every field but `connected`
 * therefore looks like a lapse, which is why it is written out rather than derived from one of
 * the two above.
 */
const PAIRED_IN: SupporterStatus = {
  connected: true,
  status: "dead",
  since: null,
  groupBound: true,
};

/** Connected and paid up. */
const SUPPORTING: SupporterStatus = {
  connected: true,
  status: "active",
  since: 1_756_000_000,
  groupBound: true,
};

/** What one round trip did. Zero everywhere the panel says nothing about. */
const OUTCOME: RelayOutcome = {
  pushed: 4,
  pulled: 9,
  unreadable: 0,
  applied: 9,
  resurrected: 0,
  cyclesBroken: 0,
  skipped: 0,
  deferred: 0,
  // An ordinary trip, which is every trip but the first with a given device — so both baseline
  // counts are zero and the panel must say nothing at all about a first exchange.
  baselineOps: 0,
  baselineHistory: 0,
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
  syncRelayStatus.mockReset().mockResolvedValue(RELAY_OFF);
  syncPatreonBegin.mockReset().mockResolvedValue("https://patreon.example/oauth2/authorize");
  syncPatreonClaim.mockReset().mockResolvedValue(SUPPORTING);
  syncSupporterStatus.mockReset().mockResolvedValue(NOT_CONNECTED);
  syncNow.mockReset().mockResolvedValue(null);
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
   * **The marker that says which machine you are at is a pill, and there is exactly one.**
   * While every install minted the name "This device" this word was the only thing telling two
   * rows apart; now that the rows read `MAIN-PC` and `OnePlus 12` it answers the other half of
   * the question, and it has to be findable by shape rather than read for.
   */
  it("marks this device with a pill, on its own row and no other", async () => {
    render(<SyncPanel />, { wrapper: paired });

    const pill = await screen.findByText("This device");
    expect(screen.getAllByText("This device")).toHaveLength(1);
    // A token rather than a word: bordered, filled, and fully rounded.
    expect(pill.classList.contains("rounded-full")).toBe(true);
    expect(pill.classList.contains("border")).toBe(true);
    expect(pill.classList.contains("bg-bg")).toBe(true);

    const row = pill.closest("li");
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByText("Desk")).toBeInTheDocument();
  });

  /**
   * **The pill sits against the end of the name, not at the far edge beside the buttons.**
   * The name span carried `flex-1` and ate the row's free space, which put the one word that
   * orients the reader down among the controls. Asserting the *grouping* rather than a pixel is
   * what jsdom can see: name and pill are siblings, the group takes the row's stretch, and no
   * button is inside it.
   */
  it("keeps the pill in one group with the name, and the buttons out of it", async () => {
    render(<SyncPanel />, { wrapper: paired });

    const pill = await screen.findByText("This device");
    const group = pill.parentElement as HTMLElement;
    expect(group.classList.contains("flex-1")).toBe(true);
    expect(group.classList.contains("min-w-0")).toBe(true);
    expect(within(group).queryByRole("button")).toBeNull();

    const name = within(group).getByText("Desk");
    // The name sizes to its content now. `flex-1` here is what pushed the pill away.
    expect(name.classList.contains("flex-1")).toBe(false);
    // And a long hostname must truncate rather than shove the presses off the row.
    expect(name.classList.contains("truncate")).toBe(true);
    expect(name.classList.contains("min-w-0")).toBe(true);
  });

  /**
   * **`Removed` stays a word.** Two tokens of equal weight in one row would make history read
   * as status; the removed row already says what it is through the struck-through name and the
   * two presses it no longer offers.
   */
  it("leaves Removed as plain text rather than a second pill", async () => {
    render(<SyncPanel />, { wrapper: paired });

    const removed = await screen.findByText(/^removed$/i);
    expect(removed.classList.contains("rounded-full")).toBe(false);
    expect(removed.classList.contains("border")).toBe(false);
    expect(removed.classList.contains("text-dim")).toBe(true);
  });

  /**
   * **Rename survives on this device's own row, and it matters more now than it did.** The name
   * a device mints is its hostname, and `sync_identity.name` is the copy every pairing sends —
   * so this press is the reader's way out of putting `MAIN-PC` on their phone. The pill must not
   * have replaced it.
   */
  it("still offers Rename on this device's own row", async () => {
    render(<SyncPanel />, { wrapper: paired });

    const row = (await screen.findByText("This device")).closest("li") as HTMLElement;
    expect(within(row).getByRole("button", { name: "Rename" })).toBeInTheDocument();
    expect(within(row).queryByRole("button", { name: /^remove/i })).toBeNull();
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

/**
 * The relay half. **Every one of these mounts the `unpaired` wrapper on purpose**: the relay
 * section is a query of its own and draws nothing off the pairing one, so a fixture that
 * disagreed with `RelayStatus.paired` would be testing a coincidence rather than the panel.
 */
describe("the relay half", () => {
  /**
   * No membership is sync being **off**, and the panel has to say so.
   *
   * A block with nothing beside it is unreadable in exactly the place it matters: a reader
   * cannot tell "off" from "not loaded yet", and off is the state every installation is in.
   */
  it("says sync is off when no membership is connected", async () => {
    render(<SyncPanel />, { wrapper: unpaired });

    expect(await screen.findByText(/sync is off/i)).toBeInTheDocument();
    // No dead control: `sync_now` with no entitlement answers `null` rather than refusing, so
    // the press would be harmless — and a button that can only ever report
    // "there was nothing to do" is one a reader learns to distrust.
    expect(screen.queryByRole("button", { name: /sync now/i })).not.toBeInTheDocument();
  });

  it("draws what is waiting and the failure still on the record", async () => {
    syncRelayStatus.mockResolvedValue(RELAY_ON);
    syncSupporterStatus.mockResolvedValue(SUPPORTING);
    render(<SyncPanel />, { wrapper: unpaired });

    expect(await screen.findByText(/4 changes waiting to go/i)).toBeInTheDocument();
    expect(screen.getByText(/answered 502 to a push/i)).toBeInTheDocument();
    // The record survives a later success on purpose, and the line says so rather than letting
    // a reader read it as "sync is broken right now".
    expect(screen.getByText(/kept even after a later sync worked/i)).toBeInTheDocument();
  });

  /**
   * `null` is the backend's "there was nothing to do" — no relay address, or no
   * pairing group — and it is the state every existing installation is in. A panel
   * that drew it as a refusal would report a fault on the first press of every fresh install.
   */
  it("reports a null answer as nothing to do rather than as a failure", async () => {
    const user = userEvent.setup();
    syncRelayStatus.mockResolvedValue({ ...RELAY_ON, paired: false, pending: 0 });
    syncSupporterStatus.mockResolvedValue(SUPPORTING);
    syncNow.mockResolvedValue(null);
    render(<SyncPanel />, { wrapper: unpaired });

    await user.click(await screen.findByRole("button", { name: /sync now/i }));

    expect(await screen.findByText(/there was nothing to sync/i)).toBeInTheDocument();
    expect(screen.queryByText(/did not finish/i)).not.toBeInTheDocument();
  });

  it("reports what a round trip did, and points its two outcomes at the queue", async () => {
    const user = userEvent.setup();
    syncRelayStatus.mockResolvedValue(RELAY_ON);
    syncSupporterStatus.mockResolvedValue(SUPPORTING);
    syncNow.mockResolvedValue({ ...OUTCOME, resurrected: 1, cyclesBroken: 2 });
    render(<SyncPanel />, { wrapper: unpaired });

    await user.click(await screen.findByRole("button", { name: /sync now/i }));

    const line = await screen.findByText(/sent 4 changes and received 9 changes/i);
    expect(line).toHaveTextContent(/kept 1 row another device had deleted/i);
    expect(line).toHaveTextContent(/moved 2 folders to the top level/i);
    expect(line).toHaveTextContent(/needs review, just below/i);
  });

  it("says a refused sync lost nothing", async () => {
    const user = userEvent.setup();
    syncRelayStatus.mockResolvedValue(RELAY_ON);
    syncSupporterStatus.mockResolvedValue(SUPPORTING);
    syncNow.mockRejectedValue("The database is busy right now.");
    render(<SyncPanel />, { wrapper: unpaired });

    await user.click(await screen.findByRole("button", { name: /sync now/i }));

    expect(await screen.findByText(/did not finish/i)).toBeInTheDocument();
    expect(screen.getByText(/busy/i)).toBeInTheDocument();
  });
});

/**
 * The supporter half — the block that replaced the address field.
 *
 * **Three sentences, and the whole value of this describe is that they cannot be swapped.** A
 * reader who never connected, one whose pledge ended, and one whose card was declined are three
 * states the relay deliberately separates, and each has a different fix: a button, a renewal, and
 * nothing at all. Every test below asserts one sentence is present *and* another is absent,
 * because a panel that drew a single generic line would satisfy any one of them alone.
 */
describe("the supporter half", () => {
  it("offers Connect Patreon when nothing is connected", async () => {
    syncSupporterStatus.mockResolvedValue({
      connected: false, status: "dead", since: null, groupBound: false,
    });
    render(<SyncPanel />, { wrapper: unpaired });

    expect(await screen.findByRole("button", { name: /connect patreon/i })).toBeInTheDocument();
    // ...and it says *Not connected*, which is the sentence a lapsed reader must never see.
    expect(screen.getByText(/not connected/i)).toBeInTheDocument();
    expect(screen.queryByText(/membership ended/i)).not.toBeInTheDocument();
  });

  it("says the membership ended without saying sync is broken", async () => {
    // Spec 10: a lapse is a state, not a failure. "Could not reach the relay" points a reader
    // at their network when the fix is their pledge.
    syncSupporterStatus.mockResolvedValue({
      connected: false, status: "dead", since: null, groupBound: true,
    });
    render(<SyncPanel />, { wrapper: unpaired });

    expect(await screen.findByText(/membership ended/i)).toBeInTheDocument();
    expect(screen.queryByText(/could not|failed|error/i)).not.toBeInTheDocument();
  });

  it("tells a lapsed reader their own data is untouched", async () => {
    // The one sentence that stops a lapse reading as data loss.
    syncSupporterStatus.mockResolvedValue({
      connected: false, status: "dead", since: null, groupBound: true,
    });
    render(<SyncPanel />, { wrapper: unpaired });

    expect(await screen.findByText(/stays on this device|nothing has been deleted/i))
      .toBeInTheDocument();
  });

  /** The reassurance belongs to the lapse and to nothing else: drawn under *Not connected* it
   *  would be an answer to a question a first-run reader has not asked. */
  it("does not offer that reassurance to a reader who never connected", async () => {
    syncSupporterStatus.mockResolvedValue({
      connected: false, status: "dead", since: null, groupBound: false,
    });
    render(<SyncPanel />, { wrapper: unpaired });

    await screen.findByRole("button", { name: /connect patreon/i });
    expect(screen.queryByText(/stays on this device|nothing has been deleted/i)).toBeNull();
  });

  /**
   * **Device B, which never opens a browser** (§6.2) — and whose three fields read as a lapse.
   *
   * A phone paired to a paid-up desktop is handed the refresh secret and nothing else, so it
   * holds a live grant with no status row and no date. It is supporting; it has simply not been
   * told when since. Drawing an ending here would tell that reader their membership stopped at
   * the moment it started working, and the fields cannot tell you otherwise — only `connected`
   * can.
   */
  it("draws a just-paired device as supporting rather than as a lapse", async () => {
    syncSupporterStatus.mockResolvedValue({
      connected: true, status: "dead", since: null, groupBound: true,
    });
    render(<SyncPanel />, { wrapper: unpaired });

    expect(await screen.findByText(/supporting/i)).toBeInTheDocument();
    expect(screen.queryByText(/membership ended/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/not connected/i)).not.toBeInTheDocument();
    // ...and it can sync, which is the whole of what pairing carried the secret across for.
    expect(screen.getByRole("button", { name: /sync now/i })).toBeInTheDocument();
  });

  it("sends a pasted claim code and shows the connected state", async () => {
    syncSupporterStatus.mockResolvedValue({
      connected: false, status: "dead", since: null, groupBound: false,
    });
    syncPatreonClaim.mockResolvedValue({
      connected: true, status: "active", since: 1_756_000_000, groupBound: true,
    });
    render(<SyncPanel />, { wrapper: unpaired });
    const field = await screen.findByLabelText(/claim code/i);

    await userEvent.type(field, "ABCD-EFGH-JKMN");
    await userEvent.click(screen.getByRole("button", { name: /^connect$/i }));

    await waitFor(() => expect(syncPatreonClaim).toHaveBeenCalledWith("ABCD-EFGH-JKMN"));
    // The answer is the new state, so the block changes without a second read.
    expect(await screen.findByText(/supporting since/i)).toBeInTheDocument();
  });

  /**
   * **`aria-disabled` is a claim to a screen reader; the handler is the fence.** This is the
   * pairing half's *Codes match* assertion one section down, and it survived a mutation that
   * removed the guard: a press on an empty field would otherwise spend a claim on an empty
   * string, and the far end's code is one-time.
   *
   * The trim is the other half of the same press. A code arrives on the clipboard from a web
   * page, which is where a trailing space comes from, and a code that fails because of one is
   * a reader who has to go back to Patreon for a second one.
   */
  it("sends nothing for an empty field, and trims what it does send", async () => {
    syncSupporterStatus.mockResolvedValue(NOT_CONNECTED);
    render(<SyncPanel />, { wrapper: unpaired });

    const field = await screen.findByLabelText(/claim code/i);
    const connect = screen.getByRole("button", { name: /^connect$/i });
    expect(connect).toHaveAttribute("aria-disabled", "true");

    await userEvent.click(connect);
    expect(syncPatreonClaim).not.toHaveBeenCalled();

    await userEvent.type(field, "  PQRS-TVWX-YZ01  ");
    await userEvent.click(connect);
    await waitFor(() => expect(syncPatreonClaim).toHaveBeenCalledWith("PQRS-TVWX-YZ01"));
  });

  it("says a card was declined without saying the membership ended", async () => {
    syncSupporterStatus.mockResolvedValue({
      connected: true, status: "grace", since: 1_756_000_000, groupBound: true,
    });
    render(<SyncPanel />, { wrapper: unpaired });

    expect(await screen.findByText(/payment/i)).toBeInTheDocument();
    expect(screen.queryByText(/membership ended/i)).not.toBeInTheDocument();
  });

  /** A declined card still mints tokens (spec 7.2), so the press that makes a round trip has to
   *  stay on screen — hiding it would be the punishment the grace window exists to avoid. */
  it("keeps sync working through a declined card", async () => {
    syncRelayStatus.mockResolvedValue(RELAY_ON);
    syncSupporterStatus.mockResolvedValue({
      connected: true, status: "grace", since: 1_756_000_000, groupBound: true,
    });
    render(<SyncPanel />, { wrapper: unpaired });

    expect(await screen.findByRole("button", { name: /sync now/i })).toBeInTheDocument();
  });
});

/**
 * Four states, and the pair that share every field but one.
 *
 * `since` is the whole of what tells *never connected* from *membership ended* — both are
 * `connected: false, status: "dead"` — so it is asserted here rather than only through a render.
 */
describe("supporterState", () => {
  it("tells a reader who never connected from one whose membership ended", () => {
    expect(supporterState(null)).toBe("unknown");
    expect(supporterState(NOT_CONNECTED)).toBe("never");
    expect(supporterState(REVOKED)).toBe("ended");
    expect(supporterState(SUPPORTING)).toBe("active");
    expect(supporterState({ ...SUPPORTING, status: "grace" })).toBe("grace");
    // **A `dead` status on a *connected* device is device B, not a lapse.** Pairing carries the
    // refresh secret across with no status row beside it (§6.2), and `supporter_state` defaults
    // an absent row to `"dead"` — so a phone paired to a paid-up desktop lands exactly here, and
    // drawing it as an ending would tell that reader their membership stopped the moment it
    // started working.
    expect(supporterState(PAIRED_IN)).toBe("active");
  });

  /**
   * **`groupBound` is the discriminator and `since` is not, and only a fixture that disagrees
   * with itself can say so.** Every other lapsed fixture in this file carries both fields set,
   * which is what a *live* membership leaves behind — so either field would satisfy them and
   * the assertion would be about nothing. `entitlement::revoke` clears the date with the
   * secret, so the shape a real lapse produces is `REVOKED`: dead, unbound-looking, and only
   * `groupBound` remembering the reader was ever here.
   */
  it("reads a lapse off groupBound, not off since", () => {
    // The shape the crate actually stores after a revoke — no date at all.
    expect(supporterState({ ...NOT_CONNECTED, groupBound: true })).toBe("ended");
    // ...and the mirror image: a date with nothing bound behind it is still nobody.
    expect(supporterState({ ...NOT_CONNECTED, since: 1_756_000_000 })).toBe("never");
  });

  it("says nothing at all while the read is in flight", () => {
    expect(supporterNote("unknown", null)).toBeNull();
  });
});

/**
 * The ordering is the whole content of this state machine, so it is asserted directly rather
 * than through seven renders.
 */
describe("relayState", () => {
  it("puts off first, then a trip in flight, then a failure before never", () => {
    expect(relayState(null, "active", false, false)).toBe("unknown");
    // A membership still being read is unknown too, and not an "off" in disguise.
    expect(relayState(RELAY_ON, "unknown", false, false)).toBe("unknown");
    // Off outranks a stale failure: whatever that error was about, nothing can run now.
    expect(relayState(RELAY_ON, "never", false, true)).toBe("off");
    expect(relayState(RELAY_ON, "ended", false, true)).toBe("off");
    expect(relayState(RELAY_ON, "active", true, true)).toBe("syncing");
    expect(relayState(RELAY_ON, "active", false, true)).toBe("failed");
    expect(relayState({ ...RELAY_ON, paired: false }, "active", false, false)).toBe("unpaired");
    expect(relayState({ ...RELAY_ON, lastSyncAt: null }, "active", false, false)).toBe("never");
    expect(relayState(RELAY_ON, "active", false, false)).toBe("synced");
    // A declined card is not off: tokens are still minted, so the panel still draws a trip.
    expect(relayState(RELAY_ON, "grace", false, false)).toBe("synced");
    // **The two cases the plan names, and the only ones that pin the order rather than the
    // arms.** Every assertion above is true of more than one ordering, because each fixture
    // reaches exactly one arm; these two reach `failed` *and* a later arm at once. A press that
    // failed on a device that has never finished a trip has to say so, because "we tried and it
    // did not work" is a different sentence from "nobody has tried" - and one on a device with
    // no group has to say so too, for the same reason one rung along.
    expect(relayState({ ...RELAY_ON, lastSyncAt: null }, "active", false, true)).toBe("failed");
    expect(relayState({ ...RELAY_ON, paired: false }, "active", false, true)).toBe("failed");
  });

  /** `lastError` is a record and survives a later success, so it must never drive the state —
   *  a panel that read its state off it would say "failed" forever. */
  it("does not read failed off the stored error", () => {
    expect(relayState(RELAY_ON, "active", false, false)).toBe("synced");
    expect(relayNote("synced", RELAY_ON, 1_700_000_060)).toBe("Last synced 1 minute ago.");
  });

  it("says nothing while a read or a trip is in flight", () => {
    expect(relayNote("unknown", null, 0)).toBeNull();
    expect(relayNote("syncing", RELAY_ON, 0)).toBeNull();
  });
});

describe("outcomeText", () => {
  /** Not a failure, and the sentence has to say what is missing rather than what went wrong. */
  it("explains a null answer instead of reporting an error", () => {
    expect(outcomeText(null)).toMatch(/nothing to sync/i);
    // The two things it needs, and neither of them is an address any more: a reader who is told
    // to type one has been sent after a field this build does not have.
    expect(outcomeText(null)).toMatch(/membership/i);
    expect(outcomeText(null)).toMatch(/paired device/i);
    expect(outcomeText(null)).not.toMatch(/relay address/i);
  });

  it("names only the clauses that are true of this trip", () => {
    expect(outcomeText(OUTCOME)).toBe("Sent 4 changes and received 9 changes.");
  });

  it("points the two surfaced outcomes at the panel that lists them", () => {
    const text = outcomeText({ ...OUTCOME, resurrected: 1, cyclesBroken: 1, deferred: 3 });
    expect(text).toMatch(/Kept 1 row another device had deleted\./);
    expect(text).toMatch(/Moved 1 folder to the top level/);
    expect(text).toMatch(/Needs review, just below, says which\./);
    expect(text).toMatch(/3 changes arrived before the change they build on/);
  });

  /**
   * Baseline spec §13, and the numbers measured on the real pair. **The thousands separator is
   * the assertion that is not decoration**: `plural` writes its number plainly, which is right
   * for the four clauses that count changes in a sync and wrong here — a baseline is the one
   * figure in this sentence that reaches four digits, so it goes through `count`.
   */
  it("says a first exchange is a first exchange, and names the history separately", () => {
    const text = outcomeText({ ...OUTCOME, baselineOps: 1069, baselineHistory: 240 });
    expect(text).toMatch(/first exchange/i);
    expect(text).toMatch(/1,069/);
    expect(text).toMatch(/240 .*(history|deck)/i);
  });

  /** Zero is the state of every sync but one, so the clause has to be absent rather than
   *  drawn empty — "0 rows went across" on a routine trip is the whole of what §13 is against. */
  it("says nothing about a baseline on an ordinary sync", () => {
    expect(outcomeText(OUTCOME)).not.toMatch(/first exchange/i);
  });
});
