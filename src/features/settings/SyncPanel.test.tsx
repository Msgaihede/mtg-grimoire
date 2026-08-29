import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PairingStatus, RelayOutcome, RelayStatus } from "@/lib/ipc";

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
const syncRelaySetUrl = vi.hoisted(() => vi.fn());
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
    syncRelaySetUrl,
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
 * The relay switched off, which is what every installation is in until a reader types an
 * address. Empty is the whole of what "off" is — there is no second flag.
 */
const RELAY_OFF: RelayStatus = {
  relayUrl: "",
  paired: false,
  pending: 0,
  lastSyncAt: null,
  lastError: null,
  reviewCount: 0,
};

/** An address, a group, four changes waiting, and a failure still on the record. */
const RELAY_ON: RelayStatus = {
  relayUrl: "https://relay.example.workers.dev",
  paired: true,
  pending: 4,
  lastSyncAt: 1_700_000_000,
  lastError: "the relay answered 502 to a push",
  reviewCount: 0,
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
  syncRelaySetUrl.mockReset().mockResolvedValue(RELAY_OFF);
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
   * An empty address is sync being **off**, and the panel has to say so.
   *
   * A blank field with nothing beside it is unreadable in exactly the place it matters: a
   * reader cannot tell "off" from "not loaded yet", and off is the state every installation
   * is in.
   */
  it("says sync is off when there is no relay address", async () => {
    render(<SyncPanel />, { wrapper: unpaired });

    expect(await screen.findByText(/sync is off/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/relay address/i)).toHaveValue("");
    // No dead control: `sync_now` over an empty address answers `null` rather than refusing,
    // so the press would be harmless — and a button that can only ever report
    // "there was nothing to do" is one a reader learns to distrust.
    expect(screen.queryByRole("button", { name: /sync now/i })).not.toBeInTheDocument();
  });

  it("saves an address the reader types, and then shows what was stored", async () => {
    const user = userEvent.setup();
    syncRelaySetUrl.mockResolvedValue(RELAY_ON);
    render(<SyncPanel />, { wrapper: unpaired });

    const field = await screen.findByLabelText(/relay address/i);
    await user.type(field, "https://relay.example.workers.dev/");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(syncRelaySetUrl).toHaveBeenCalledWith("https://relay.example.workers.dev/"),
    );
    // The backend normalises, so the field goes back to showing what was *stored* rather than
    // what was typed — the trailing slash is gone.
    await waitFor(() =>
      expect(screen.getByLabelText(/relay address/i)).toHaveValue(
        "https://relay.example.workers.dev",
      ),
    );
  });

  /** A refusal is a sentence to show, never an error to swallow: the crate's own words say
   *  what to do about it, and "invalid URL" would not. */
  it("shows the crate's own sentence when an address is refused", async () => {
    const user = userEvent.setup();
    syncRelaySetUrl.mockRejectedValue(
      "A relay address has to start with https:// (or http:// for one on this machine).",
    );
    render(<SyncPanel />, { wrapper: unpaired });

    await user.type(await screen.findByLabelText(/relay address/i), "relay.example");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText(/has to start with https/i)).toBeInTheDocument();
  });

  it("draws what is waiting and the failure still on the record", async () => {
    syncRelayStatus.mockResolvedValue(RELAY_ON);
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
    syncNow.mockResolvedValue(null);
    render(<SyncPanel />, { wrapper: unpaired });

    await user.click(await screen.findByRole("button", { name: /sync now/i }));

    expect(await screen.findByText(/there was nothing to sync/i)).toBeInTheDocument();
    expect(screen.queryByText(/did not finish/i)).not.toBeInTheDocument();
  });

  it("reports what a round trip did, and points its two outcomes at the queue", async () => {
    const user = userEvent.setup();
    syncRelayStatus.mockResolvedValue(RELAY_ON);
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
    syncNow.mockRejectedValue("The database is busy right now.");
    render(<SyncPanel />, { wrapper: unpaired });

    await user.click(await screen.findByRole("button", { name: /sync now/i }));

    expect(await screen.findByText(/did not finish/i)).toBeInTheDocument();
    expect(screen.getByText(/busy/i)).toBeInTheDocument();
  });
});

/**
 * The ordering is the whole content of this state machine, so it is asserted directly rather
 * than through seven renders.
 */
describe("relayState", () => {
  it("puts off first, then a trip in flight, then a failure before never", () => {
    expect(relayState(null, false, false)).toBe("unknown");
    // Off outranks a stale failure: the address that error was about has been cleared.
    expect(relayState({ ...RELAY_ON, relayUrl: "" }, false, true)).toBe("off");
    expect(relayState(RELAY_ON, true, true)).toBe("syncing");
    expect(relayState(RELAY_ON, false, true)).toBe("failed");
    expect(relayState({ ...RELAY_ON, paired: false }, false, false)).toBe("unpaired");
    expect(relayState({ ...RELAY_ON, lastSyncAt: null }, false, false)).toBe("never");
    expect(relayState(RELAY_ON, false, false)).toBe("synced");
    // **The two cases the plan names, and the only ones that pin the order rather than the
    // arms.** Every assertion above is true of more than one ordering, because each fixture
    // reaches exactly one arm; these two reach `failed` *and* a later arm at once. A press that
    // failed on a device that has never finished a trip has to say so, because "we tried and it
    // did not work" is a different sentence from "nobody has tried" - and one on a device with
    // no group has to say so too, for the same reason one rung along.
    expect(relayState({ ...RELAY_ON, lastSyncAt: null }, false, true)).toBe("failed");
    expect(relayState({ ...RELAY_ON, paired: false }, false, true)).toBe("failed");
  });

  /** `lastError` is a record and survives a later success, so it must never drive the state —
   *  a panel that read its state off it would say "failed" forever. */
  it("does not read failed off the stored error", () => {
    expect(relayState(RELAY_ON, false, false)).toBe("synced");
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
    expect(outcomeText(null)).toMatch(/relay address and a paired device/i);
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
