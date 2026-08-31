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
const syncPairingConfirm = vi.hoisted(() => vi.fn());
const syncPairingPoll = vi.hoisted(() => vi.fn());
const syncPairingCancel = vi.hoisted(() => vi.fn());
const syncDeviceRename = vi.hoisted(() => vi.fn());
const syncDeviceRevoke = vi.hoisted(() => vi.fn());
const syncGroupLeave = vi.hoisted(() => vi.fn());
const syncRelayStatus = vi.hoisted(() => vi.fn());
const syncPatreonBegin = vi.hoisted(() => vi.fn());
const syncPatreonClaim = vi.hoisted(() => vi.fn());
const syncSupporterStatus = vi.hoisted(() => vi.fn());
const syncNow = vi.hoisted(() => vi.fn());
/**
 * **No `syncPairingRespond` and no `syncPairingComplete` — the relay carries the accept and the
 * sealed key now**, so there is nothing left for either to do. `syncPairingConfirm` survives:
 * it is still the offering device's one press, and it answers nothing the panel reads any more
 * (the sealed key travels to the relay from the backend, not back through this mutation). What
 * replaced both is `syncPairingPoll`, which is how the panel learns where the ceremony has got
 * to instead of waiting on a paste.
 */
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: {
    syncPairingStatus,
    syncPairingBegin,
    syncPairingAccept,
    syncPairingConfirm,
    syncPairingPoll,
    syncPairingCancel,
    syncDeviceRename,
    syncDeviceRevoke,
    syncGroupLeave,
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
  LEAVE_WARNING,
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

/**
 * A group of two, which is what `sync_pairing_status` answers.
 *
 * **No removed device, because the command cannot send one.** `pairing::status` filters
 * `revoked_at` out before answering, so a fixture carrying one would encode a state the backend
 * has no way to produce — and a panel written to survive it would be handling an impossible
 * input. The row still exists in `sync_devices`; that the command drops it is asserted in Rust
 * (`a_removed_device_is_not_on_the_panels_list`) and in the fake (`db.test.ts`'s roster tests),
 * which is where a filter can actually fail.
 */
const PAIRED: PairingStatus = {
  deviceId: ME,
  deviceName: "Desk",
  groupId: "bb".repeat(16),
  epoch: 2,
  devices: [
    { deviceId: ME, name: "Desk", addedAt: 1, revokedAt: null },
    { deviceId: PHONE, name: "Phone", addedAt: 2, revokedAt: null },
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
  reviewCount: 0,
};

/** A group, four changes waiting, and one trip already finished. */
const RELAY_ON: RelayStatus = {
  paired: true,
  pending: 4,
  lastSyncAt: 1_700_000_000,
  reviewCount: 0,
};

/**
 * A device that has never connected a membership. **`groupBound: false` is the whole of what
 * tells this apart from a membership that has ended** — `since` is null in both, because
 * `entitlement::revoke` deletes the date along with the refresh secret.
 *
 * ⚠️ **A device that has just paired and not yet synced reads exactly this**, and it is written
 * here rather than given a fixture of its own because a second object would be a lie about
 * there being a second state. Since spec §2.2 the pairing blob carries no refresh secret, so a
 * joiner holds no grant and no `supporter_status` — `entitled` is false and `membership_ended`
 * is false, which is a fresh install byte for byte. The panel cannot tell them apart and must
 * not pretend to; what resolves it is the round trip that mints on the group auth.
 */
const NOT_CONNECTED: SupporterStatus = {
  entitled: false,
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
  entitled: false,
  status: "dead",
  since: null,
  groupBound: true,
};

/**
 * A grant written with no status beside it — **entitled, and looking exactly like a lapse.**
 *
 * `store_grant` and `store_status` are two writes in a row with no transaction around them
 * (`entitlement::refresh_door`), so a process that stops between them leaves the refresh secret
 * live and no `supporter_status` row at all, which `entitlement::supporter_state` reads back as
 * the default `"dead"`. Every field but `entitled` therefore reads as a lapse, which is why it
 * is written out rather than spread from one of the two above.
 *
 * **This used to be device B and is not any more.** Until spec §2.2 the pairing blob carried the
 * offering device's refresh secret, so a phone paired to a paid-up desktop landed here on the
 * spot; it carries none now, and a joiner reads `NOT_CONNECTED` instead until its first round
 * trip. The *shape* still has to be handled and the reason has simply moved, which is the point
 * of renaming the fixture rather than deleting it.
 */
const GRANT_WITHOUT_STATUS: SupporterStatus = {
  entitled: true,
  status: "dead",
  since: null,
  groupBound: true,
};

/**
 * **The second device: entitled through its group, holding nothing of its own.**
 *
 * Spec §2.2 and the whole of the reader's item 3. No refresh secret ever reached this device —
 * `/token`'s group door mints on the group auth, which every device derives from the group key —
 * and the answer carries `status` and `since`, so the panel says *Supporting since …* dated.
 *
 * **`entitled: true` beside a `groupBound` that `membership_ended` also answers `true` for** is
 * exactly the collision `supporterState`'s ordering exists to resolve: this object is a
 * *supporter*, and asking `groupBound` first would draw *Membership ended* over a live pledge.
 */
const GROUP_ENTITLED: SupporterStatus = {
  entitled: true,
  status: "active",
  since: 1_740_000_000,
  groupBound: true,
};

/** Connected and paid up — this device pressed the button itself. */
const SUPPORTING: SupporterStatus = {
  entitled: true,
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
  // No `response` field — the relay carries this device's answer onward now, so there is
  // nothing left for a reader to copy back by hand.
  syncPairingAccept.mockReset().mockResolvedValue({ sas: "042913" });
  syncPairingConfirm.mockReset().mockResolvedValue({ sealedKey: "SEALEDKEY" });
  // `"idle"` is the safe default: a test that never advances the poll must not accidentally
  // read as a pairing already under way.
  syncPairingPoll.mockReset().mockResolvedValue({ stage: "idle", sas: null });
  syncPairingCancel.mockReset().mockResolvedValue(undefined);
  syncDeviceRename.mockReset().mockResolvedValue(undefined);
  syncDeviceRevoke.mockReset().mockResolvedValue(undefined);
  syncGroupLeave.mockReset().mockResolvedValue(undefined);
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

  it("lists the group's devices", async () => {
    render(<SyncPanel />, { wrapper: paired });
    expect(await screen.findByText("Phone")).toBeInTheDocument();
    expect(screen.getByText("Desk")).toBeInTheDocument();
    // Every row that is drawn is a device still in the group, so every row offers both presses
    // — except that this device has no Remove of its own, because the backend refuses that and
    // a press that cannot work is worse than no press at all.
    expect(screen.getAllByRole("button", { name: /rename/i })).toHaveLength(2);
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

  /**
   * **A — the offering device, from `waiting` to `compare`.** The relay carries the joiner's
   * answer now, so what used to be a paste ("what the other device answered", "Read their
   * answer") is the poll finding a peer instead. The QR and the typed code are `"waiting"`'s
   * alone and gone the moment `"compare"` starts — the invite has done its one job.
   */
  it("goes from waiting to compare once the poll finds the other device", async () => {
    syncPairingPoll.mockResolvedValueOnce({ stage: "waiting", sas: null });
    syncPairingPoll.mockResolvedValue({ stage: "compare", sas: "042913" });
    const user = userEvent.setup();
    render(<SyncPanel />, { wrapper: unpaired });

    await user.click(await screen.findByRole("button", { name: /pair a device/i }));
    // The ellipsis, not the period: "Nothing to compare yet — still waiting for the other
    // device." matches the same phrase and would make this assertion ambiguous otherwise.
    expect(await screen.findByText(/waiting for the other device…/i)).toBeInTheDocument();
    expect(screen.queryByTestId("pairing-sas")).not.toBeInTheDocument();

    // Real timers rather than faked ones: `refetchInterval` is a real 1.5 s clock the moment the
    // query is enabled, well before this test ever reaches a `vi.useFakeTimers()` call — mixing
    // the two let the interval already fire on the real clock, ahead of a later fake advance, and
    // reading it back afterwards was the flake. A longer `waitFor` budget rides out the real wait.
    await waitFor(
      () => expect(screen.getByTestId("pairing-sas")).toHaveTextContent("042913"),
      { timeout: 3000 },
    );
    // Gone the moment the digits arrive — a code still on screen would suggest the invite step
    // is somehow still live.
    expect(screen.queryByTestId("pairing-qr")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /codes match/i })).toHaveAttribute(
      "aria-disabled",
      "false",
    );
  });

  /**
   * **B — the joining device draws no Codes match button at all, and that is deliberate rather
   * than missing.** Under a man-in-the-middle the two screens show different numbers, so the
   * comparison is inherently a two-screen act; the press that matters is the one gating release
   * of the group key, and that is the offering device's alone. This screen's whole job is to say
   * where that press is.
   */
  it("shows the joining device's digits with no confirm button of its own", async () => {
    const user = userEvent.setup();
    render(<SyncPanel />, { wrapper: unpaired });

    await user.click(await screen.findByRole("button", { name: /enter a code/i }));
    await user.type(await screen.findByLabelText(/code the other device is showing/i), "CODE");
    await user.click(screen.getByRole("button", { name: /read the code/i }));

    expect(await screen.findByTestId("pairing-sas")).toHaveTextContent("042913");
    expect(screen.queryByRole("button", { name: /codes match/i })).not.toBeInTheDocument();
    expect(screen.getByText(/press codes match there/i)).toBeInTheDocument();
  });

  /**
   * `"complete"` is settled during render rather than in an effect (`SyncPanel`'s own doc
   * comment on the two guarded `if`s above its `return`). The flow returns to `"idle"`, the
   * success line takes its place, and the round trip a freshly paired device owes — the
   * assertion this test exists for — fires exactly once.
   */
  it("returns the panel to idle once the poll answers complete", async () => {
    syncPairingPoll.mockResolvedValueOnce({ stage: "waiting", sas: null });
    syncPairingPoll.mockResolvedValue({ stage: "complete", sas: null });
    const user = userEvent.setup();
    render(<SyncPanel />, { wrapper: unpaired });

    await user.click(await screen.findByRole("button", { name: /pair a device/i }));
    // The ellipsis, not the period: "Nothing to compare yet — still waiting for the other
    // device." matches the same phrase and would make this assertion ambiguous otherwise.
    expect(await screen.findByText(/waiting for the other device…/i)).toBeInTheDocument();

    // Real timers, `goes from waiting to compare`'s reason: `refetchInterval` is already a real
    // 1.5 s clock by the time a test could switch to a fake one, and reading the fake advance
    // back afterwards was the flake. `waitFor`'s own budget rides out the real wait instead.
    await waitFor(
      () =>
        expect(
          screen.getByText(/paired\. the other device is now part of this group/i),
        ).toBeInTheDocument(),
      { timeout: 3000 },
    );
    expect(screen.queryByRole("button", { name: /codes match/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /pair a device/i })).toBeInTheDocument();
    await waitFor(() => expect(syncNow).toHaveBeenCalled());
  });

  /**
   * **The stale-cache bug fixed in `db5698a`.** `PAIRING_POLL_KEY` is one query key for every
   * attempt in a session, and a *disabled* query keeps its last-known `data` rather than
   * clearing it. So once a first pairing reached `"complete"`, the cache went on holding
   * `{stage: "complete"}` — and starting a **second** pairing re-enabled that same query key onto
   * the stale answer, which React Query hands back **synchronously** on the very next render
   * (a refetch is a promise and cannot resolve mid-render). `SyncPanel`'s own render-time `if`
   * for `"complete"` fired again immediately, and the just-opened offer screen was put straight
   * back to `"idle"` before it ever painted: the reader pressed *Pair a device* a second time and
   * nothing happened, deterministically, every time. `startNewAttempt`'s
   * `client.removeQueries({ queryKey: PAIRING_POLL_KEY, exact: true })` is the fix — called from
   * both `begin`'s and `accept`'s `onMutate`, so the scan path is covered by the same one call.
   *
   * `pairing-qr` is the fence, per the panel's own contract: it is drawn only during
   * `"waiting"`, so its appearance after the second press is the offer screen actually having
   * painted rather than having been bounced straight back to idle.
   */
  it("shows a fresh offer screen when a second pairing is started after the first completed", async () => {
    syncPairingPoll.mockResolvedValueOnce({ stage: "waiting", sas: null });
    syncPairingPoll.mockResolvedValueOnce({ stage: "complete", sas: null });
    // The second attempt's own first read — reached only if the stale `"complete"` answer above
    // was cleared rather than replayed.
    syncPairingPoll.mockResolvedValue({ stage: "waiting", sas: null });
    const user = userEvent.setup();
    render(<SyncPanel />, { wrapper: unpaired });

    await user.click(await screen.findByRole("button", { name: /pair a device/i }));
    await waitFor(
      () =>
        expect(
          screen.getByText(/paired\. the other device is now part of this group/i),
        ).toBeInTheDocument(),
      { timeout: 3000 },
    );

    await user.click(await screen.findByRole("button", { name: /pair a device/i }));
    expect(await screen.findByTestId("pairing-qr")).toBeInTheDocument();
    // And the success line from the *first* attempt does not linger over the second offer.
    expect(
      screen.queryByText(/paired\. the other device is now part of this group/i),
    ).not.toBeInTheDocument();
  });

  /**
   * `pairing::poll`'s own TTL check — the relay's, read off this side's clock rather than the
   * reader's patience (`src-tauri/src/sync_pair/pairing.rs`'s `EXPIRED`). Without a sentence for
   * it a dropped offer polls silently forever: the reader sits at a `waiting` or `compare` screen
   * that will never change again, with nothing on it saying the code has died.
   *
   * **`poll.error` is in `SyncPanel`'s `error` fallback chain, right after `accept.error` and
   * ahead of `confirm.error`** — a rendezvous failing *while it runs* outranks a stale `confirm`
   * refusal from earlier in the same attempt, and it is not swallowed the way the effect's own
   * `syncNow` rejection is: that one hides a harmless failure *after* a success, and this is the
   * only signal the reader gets that the thing they are waiting for is never coming. `Cancel`
   * stays on screen regardless, which is what keeps the sentence from stranding anyone.
   */
  it("says so when a pairing has expired", async () => {
    syncPairingPoll.mockRejectedValue("That pairing code has expired. Start a new one.");
    const user = userEvent.setup();
    render(<SyncPanel />, { wrapper: unpaired });

    await user.click(await screen.findByRole("button", { name: /pair a device/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/expired/i);
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
 * Leaving — the press §2.1 added, and the sentence in front of it.
 *
 * **`identity::CANNOT_REMOVE_SELF` has said *"Use Leave group instead"* since it was written and
 * pointed at nothing**; this is what it now points at. The three claims worth asserting are the
 * two ends of the gate (drawn on a paired device, never on an unpaired one) and the confirmation
 * between them, and each is asserted so that the obvious mutation goes red rather than merely
 * looking different.
 */
describe("leaving the group", () => {
  it("offers Leave group on a paired device", async () => {
    render(<SyncPanel />, { wrapper: paired });

    expect(await screen.findByRole("button", { name: "Leave group" })).toBeInTheDocument();
  });

  /**
   * **The other end of the gate, and the half a mutation reaches first.** `leave_group_now`
   * refuses a device in no group in as many words, so a press drawn here could only ever be
   * refused — `DeviceRow`'s missing Remove one rung up. Dropping the `paired &&` guard is what
   * makes this red; nothing else in the file notices.
   */
  it("offers no Leave group to a device that is in no group", async () => {
    render(<SyncPanel />, { wrapper: unpaired });

    // Anchored on a press that *is* drawn here, so the absence below is about the guard rather
    // than about a render that has not happened yet.
    await screen.findByRole("button", { name: /pair a device/i });
    expect(screen.queryByRole("button", { name: "Leave group" })).not.toBeInTheDocument();
  });

  /**
   * **The confirmation, and the two things its copy has to carry.**
   *
   * A reader cannot guess either of them. That this device keeps its own collection is the
   * reassurance `REMOVAL_WARNING` gives from the other side of the same act — leaving is the one
   * press on this panel that sounds like it throws cards away. That the other devices may never
   * hear is the honest cost of *"always possible"*: `leave_group_now` publishes best effort and
   * clears locally whatever the relay answered, so a reader who leaves offline leaves for real
   * while their desktop goes on listing this phone.
   *
   * **Red three ways**: dropping the dialog (the first press would reach the command), dropping
   * the reassurance clause, or dropping the unreachable-relay clause.
   */
  it("asks first, and says what leaving does and does not do", async () => {
    const user = userEvent.setup();
    render(<SyncPanel />, { wrapper: paired });

    await user.click(await screen.findByRole("button", { name: "Leave group" }));
    expect(syncGroupLeave).not.toHaveBeenCalled();

    const body = await screen.findByText(/your collection stays on this device/i);
    // 1. Nothing local is deleted.
    expect(body).toHaveTextContent(/nothing here is deleted/i);
    // 2. The others may go on listing this device, because the relay may not have heard.
    expect(body).toHaveTextContent(/relay cannot be reached/i);
    expect(body).toHaveTextContent(/go on listing this one until somebody removes it there/i);
    // The two claims again against the exported string, so a rewrite that kept the shape and
    // lost a meaning names which meaning it lost — `REMOVAL_WARNING`'s pair, one act over.
    expect(LEAVE_WARNING).toMatch(/collection stays on this device/i);
    expect(LEAVE_WARNING).toMatch(/will not hear/i);

    await user.click(screen.getByRole("button", { name: "Leave the group" }));
    await waitFor(() => expect(syncGroupLeave).toHaveBeenCalled());
  });

  /**
   * **The re-read, and it is the sync *root* rather than the roster.**
   *
   * Leaving runs `entitlement::clear` as well as `identity::leave_group` (spec §2.3), so the
   * membership block is as stale as the roster the moment this answers — a panel that
   * invalidated `PAIRING_KEY` alone would drop the group and go on drawing *Supporting* over a
   * device with nothing to sync to.
   *
   * **Red if the invalidation is dropped**, and not vacuously so: the harness seeds
   * `PAIRING_KEY` with `staleTime: Infinity`, so nothing re-reads the pairing status on mount
   * and the call below can only come from the invalidation. Its answer is the sentence asserted
   * after it, so a refetch that happened and changed nothing on screen would fail too.
   */
  it("re-reads the whole sync root once the departure lands", async () => {
    const user = userEvent.setup();
    render(<SyncPanel />, { wrapper: paired });

    await user.click(await screen.findByRole("button", { name: "Leave group" }));
    expect(syncPairingStatus).not.toHaveBeenCalled();

    // What the backend answers after a departure: no group, no roster.
    syncPairingStatus.mockResolvedValue({ ...UNPAIRED, deviceName: "Desk" });
    await user.click(screen.getByRole("button", { name: "Leave the group" }));

    await waitFor(() => expect(syncPairingStatus).toHaveBeenCalled());
    expect(await screen.findByText(/not paired with anything yet/i)).toBeInTheDocument();
    expect(screen.queryByText("Phone")).not.toBeInTheDocument();
    // ...and the press that opened the dialog goes with the group it was about.
    expect(screen.queryByRole("button", { name: "Leave group" })).not.toBeInTheDocument();
  });

  /** A refusal is the panel's one line, exactly as every other press here reports one. The only
   *  refusal the command has is a device in no group — which this panel does not draw the press
   *  for, so it is reachable only by a race, and a press that answered nothing at all would look
   *  identical to one that worked. */
  it("says so when a departure is refused", async () => {
    const user = userEvent.setup();
    syncGroupLeave.mockRejectedValue("This device is not in a pairing group.");
    render(<SyncPanel />, { wrapper: paired });

    await user.click(await screen.findByRole("button", { name: "Leave group" }));
    await user.click(screen.getByRole("button", { name: "Leave the group" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/not in a pairing group/i);
    // Refused, so the reader is still where they were and can press again.
    expect(screen.getByRole("button", { name: "Leave group" })).toBeInTheDocument();
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

  it("draws what is waiting to go", async () => {
    syncRelayStatus.mockResolvedValue(RELAY_ON);
    syncSupporterStatus.mockResolvedValue(SUPPORTING);
    render(<SyncPanel />, { wrapper: unpaired });

    expect(await screen.findByText(/4 changes waiting to go/i)).toBeInTheDocument();
  });

  /**
   * **The Errors panel further down this page is the record, and one failure drawn twice in two
   * registers under two headings is the thing this asserts against.** `errors::record` still
   * writes every relay failure; nothing on the sync half reads it back.
   *
   * The waiting line is the anchor rather than a bare `findByText("Phone")`: it is driven by the
   * *relay* read, so it cannot be on screen until the answer the failure line would have been
   * drawn from has landed.
   */
  it("draws no relay-failure line, because the Errors panel holds the record", async () => {
    syncRelayStatus.mockResolvedValue(RELAY_ON);
    syncSupporterStatus.mockResolvedValue(SUPPORTING);
    render(<SyncPanel />, { wrapper: unpaired });

    await screen.findByText(/4 changes waiting to go/i);
    // Both halves of the line that used to be here — the heading it was found by and the
    // sentence that explained why it outlived a success — so a partial revert cannot pass.
    expect(screen.queryByText(/last relay failure/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/kept even after a later sync worked/i)).not.toBeInTheDocument();
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
      entitled: false, status: "dead", since: null, groupBound: false,
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
      entitled: false, status: "dead", since: null, groupBound: true,
    });
    render(<SyncPanel />, { wrapper: unpaired });

    expect(await screen.findByText(/membership ended/i)).toBeInTheDocument();
    expect(screen.queryByText(/could not|failed|error/i)).not.toBeInTheDocument();
  });

  it("tells a lapsed reader their own data is untouched", async () => {
    // The one sentence that stops a lapse reading as data loss.
    syncSupporterStatus.mockResolvedValue({
      entitled: false, status: "dead", since: null, groupBound: true,
    });
    render(<SyncPanel />, { wrapper: unpaired });

    expect(await screen.findByText(/stays on this device|nothing has been deleted/i))
      .toBeInTheDocument();
  });

  /** The reassurance belongs to the lapse and to nothing else: drawn under *Not connected* it
   *  would be an answer to a question a first-run reader has not asked. */
  it("does not offer that reassurance to a reader who never connected", async () => {
    syncSupporterStatus.mockResolvedValue({
      entitled: false, status: "dead", since: null, groupBound: false,
    });
    render(<SyncPanel />, { wrapper: unpaired });

    await screen.findByRole("button", { name: /connect patreon/i });
    expect(screen.queryByText(/stays on this device|nothing has been deleted/i)).toBeNull();
  });

  /**
   * **The other sentence with a placement rule, and it had none of these.**
   *
   * Connecting founds a group of one (§6.3's `ensure_group`) and `pairing::complete` refuses a
   * differing `group_id`, so a reader who connects on their phone can never afterwards *join*
   * their desktop's group — and this panel has no Leave to undo it. `CONNECT_ORDER` is drawn
   * inside the `offering` block for that reason: it belongs to the press that causes the trap.
   *
   * **Asserted both ways, exactly as `LAPSE_REASSURANCE` above is**, because the placement is the
   * whole claim. Moving the paragraph one level out — up beside `supporterNote`, where it would
   * also greet a paid-up supporter — leaves every other test in this file green.
   */
  it("tells a first-run reader which device to connect on", async () => {
    syncSupporterStatus.mockResolvedValue({
      entitled: false, status: "dead", since: null, groupBound: false,
    });
    render(<SyncPanel />, { wrapper: unpaired });

    expect(await screen.findByText(/pair this one to them first/i)).toBeInTheDocument();
  });

  /**
   * **The clause spec §2.2 added, asserted so a revert to the old copy goes red.**
   *
   * `CONNECT_ORDER` used to open "Connect on the device you want to pair from", which was advice
   * about a trap that has been removed: `refresh` travelled only inside the sealed pairing blob,
   * so pairing before anybody connected left the joiner with nothing it could ever get. The
   * group door ended that, and the sentence has to say so — a reader told only "pair this one to
   * them first" is left to guess whether they must then connect on some *particular* device.
   *
   * It is a second `getByText` rather than a longer regex on the first because the two clauses
   * are separate claims: the placement rule survives, the promise is new, and a copy edit that
   * dropped either should name which one it dropped.
   */
  it("promises a membership on any device covers the whole group", async () => {
    syncSupporterStatus.mockResolvedValue(NOT_CONNECTED);
    render(<SyncPanel />, { wrapper: unpaired });

    expect(await screen.findByText(/a membership on any of them covers all of them/i))
      .toBeInTheDocument();
    // ...and the advice it replaced is gone, or the panel is telling a reader that the order
    // matters in the same breath as telling them it does not.
    expect(screen.queryByText(/connect on the device you want to pair from/i)).toBeNull();
  });

  it("says it to a lapsed reader too, who is offered the same press", async () => {
    // `ended` is the second state with a Connect button on it, and reconnecting on the wrong
    // device strands them the same way a first connect would.
    syncSupporterStatus.mockResolvedValue({
      entitled: false, status: "dead", since: null, groupBound: true,
    });
    render(<SyncPanel />, { wrapper: unpaired });

    expect(await screen.findByText(/pair this one to them first/i)).toBeInTheDocument();
  });

  it("stops saying it once a membership is connected", async () => {
    // The advice is about a press that is no longer on screen. Left drawn, it reads as an
    // instruction to a reader with nothing left to do about it.
    syncSupporterStatus.mockResolvedValue({
      entitled: true, status: "active", since: 1_756_000_000, groupBound: true,
    });
    render(<SyncPanel />, { wrapper: unpaired });

    await screen.findByText(/supporting since/i);
    expect(screen.queryByText(/pair this one to them first/i)).toBeNull();
  });

  /**
   * **Spec §3's load-bearing sentence, and the only thing between a reader and a group they did
   * not mean to break.**
   *
   * `/claim` used to refuse a subject that already held a group with a 409, which stranded the
   * payer who had just left one — there was no press anywhere that re-bound their membership. So
   * a re-claim **moves** the binding now, and the devices left in the old group lose their relay
   * log and their rows with it. A reader who leaves first has already orphaned that group; a
   * reader who simply pastes a fresh code on a second machine can do it by accident, and this
   * paragraph is the only warning they get.
   *
   * **It is drawn at the claim field rather than at *Connect Patreon*** — opening a browser
   * moves nothing and pasting a code is the write — which is what the sibling assertion pins:
   * the block the field sits in is the paragraph's own next element, so a copy edit that hoisted
   * this one level out (where it would also greet a paid-up supporter) fails here rather than
   * merely reading oddly.
   */
  it("warns that a re-claim moves the membership off the group it is on", async () => {
    syncSupporterStatus.mockResolvedValue(NOT_CONNECTED);
    render(<SyncPanel />, { wrapper: unpaired });

    const line = await screen.findByText(/one membership covers one group/i);
    // The reversal itself, and what it costs the group that is left — both, because "it moves"
    // with no consequence attached is a sentence a reader skips.
    expect(line).toHaveTextContent(/claiming it here moves it/i);
    expect(line).toHaveTextContent(/stop syncing with each other/i);
    // ...and what it does *not* cost, which is the half that stops this reading as data loss.
    expect(line).toHaveTextContent(/own collections are untouched/i);

    expect(line.nextElementSibling?.contains(screen.getByLabelText(/claim code/i))).toBe(true);
  });

  it("says it to a lapsed reader too, whose re-claim is the likelier one", async () => {
    // `ended` is the second state with a claim field on it, and a reader reconnecting after a
    // lapse is exactly the one who may have claimed for a different group before.
    syncSupporterStatus.mockResolvedValue(REVOKED);
    render(<SyncPanel />, { wrapper: unpaired });

    expect(await screen.findByText(/one membership covers one group/i)).toBeInTheDocument();
  });

  it("stops warning about a re-claim once there is no claim to make", async () => {
    // The paragraph is about a press that is no longer on screen. Left drawn, it tells a
    // connected supporter their own group is at risk from a field they cannot see.
    syncSupporterStatus.mockResolvedValue(SUPPORTING);
    render(<SyncPanel />, { wrapper: unpaired });

    await screen.findByText(/supporting since/i);
    expect(screen.queryByText(/one membership covers one group/i)).toBeNull();
  });

  /**
   * **The second device — spec §2.2, and the whole reason this PR exists.**
   *
   * A phone paired to a desktop whose reader pays mints its own token through `/token`'s group
   * door, so it is entitled holding no Patreon-side secret at all, and the answer carries the
   * date. Every field but `entitled` is a lapse's, and the panel drew *Connect Patreon* at this
   * reader on every device but one for as long as it read a boolean called `connected` — which
   * `ipc.ts` went on declaring for a wave after the crate had renamed it, compiling and passing
   * while `status.connected` was `undefined` in the shipped window.
   *
   * **The button's absence is asserted, not just the sentence's presence.** *Supporting since …*
   * with a Connect Patreon under it would satisfy half of this and is precisely what the bug
   * looked like from one device.
   */
  it("offers no Connect button on a device entitled through its group", async () => {
    syncSupporterStatus.mockResolvedValue(GROUP_ENTITLED);
    render(<SyncPanel />, { wrapper: unpaired });

    expect(await screen.findByText(/supporting since/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /connect patreon/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/membership ended/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/not connected/i)).not.toBeInTheDocument();
    // ...and it can sync, which is what the group door was built to give it.
    expect(screen.getByRole("button", { name: /sync now/i })).toBeInTheDocument();
  });

  /**
   * **Entitled with no status row beside it** — and it still reads as supporting, dateless.
   *
   * `store_grant` and `store_status` are two writes with nothing around them, so a device can
   * hold a live refresh secret and no `supporter_status` at all, which reads back as the default
   * `"dead"`. Drawing an ending here would tell that reader their membership stopped at the
   * moment it started working, and the other three fields cannot tell you otherwise — only
   * `entitled` can.
   */
  it("draws an entitled device with no status yet as supporting rather than as a lapse", async () => {
    syncSupporterStatus.mockResolvedValue(GRANT_WITHOUT_STATUS);
    render(<SyncPanel />, { wrapper: unpaired });

    expect(await screen.findByText(/supporting/i)).toBeInTheDocument();
    expect(screen.queryByText(/membership ended/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/not connected/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /sync now/i })).toBeInTheDocument();
  });

  it("sends a pasted claim code and shows the connected state", async () => {
    syncSupporterStatus.mockResolvedValue({
      entitled: false, status: "dead", since: null, groupBound: false,
    });
    syncPatreonClaim.mockResolvedValue({
      entitled: true, status: "active", since: 1_756_000_000, groupBound: true,
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
      entitled: true, status: "grace", since: 1_756_000_000, groupBound: true,
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
      entitled: true, status: "grace", since: 1_756_000_000, groupBound: true,
    });
    render(<SyncPanel />, { wrapper: unpaired });

    expect(await screen.findByRole("button", { name: /sync now/i })).toBeInTheDocument();
  });
});

/**
 * Five states, and the two pairs that each share every field but one.
 *
 * `groupBound` is the whole of what tells *never connected* from *membership ended* — both are
 * `entitled: false, status: "dead"`, and both are `since: null`, because `entitlement::revoke`
 * deletes the date with the secret. So it is asserted here rather than only through a render.
 */
describe("supporterState", () => {
  it("tells a reader who never connected from one whose membership ended", () => {
    expect(supporterState(null)).toBe("unknown");
    expect(supporterState(NOT_CONNECTED)).toBe("never");
    expect(supporterState(REVOKED)).toBe("ended");
    expect(supporterState(SUPPORTING)).toBe("active");
    expect(supporterState({ ...SUPPORTING, status: "grace" })).toBe("grace");
    // **A `dead` status on an *entitled* device is a grant whose status write has not landed,
    // not a lapse.** `supporter_state` defaults an absent row to `"dead"`, so a device that
    // holds a live secret and nothing else lands exactly here, and drawing it as an ending
    // would tell that reader their membership stopped the moment it started working.
    expect(supporterState(GRANT_WITHOUT_STATUS)).toBe("active");
  });

  /**
   * **The second device, and the field that has to be read first for it to come out right.**
   *
   * `commands::supporter_status` computes `group_bound = entitled || membership_ended`, and
   * `membership_ended` is `refresh_secret.is_none() && SUPPORTER_STATUS.is_some()` — which a
   * device entitled through its group satisfies, because it holds a status and no secret. So
   * this object carries `groupBound: true` for a membership that has not ended at all, and the
   * *only* thing standing between it and *Membership ended* is `entitled` being asked first.
   *
   * **Swapping the two lines in `supporterState` is what makes this red**, which the mutation
   * for this task confirmed: `GROUP_ENTITLED` goes `"ended"` while every other fixture in this
   * file stays exactly where it was.
   */
  it("puts a group entitlement ahead of a groupBound that also answers true", () => {
    expect(supporterState(GROUP_ENTITLED)).toBe("active");
    expect(supporterState({ ...GROUP_ENTITLED, status: "grace" })).toBe("grace");
    // The mirror image, and the reason the first line is not vacuous: the same `groupBound`
    // with the entitlement gone *is* a lapse.
    expect(supporterState({ ...GROUP_ENTITLED, entitled: false, status: "dead", since: null }))
      .toBe("ended");
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

  it("says nothing while a read or a trip is in flight", () => {
    expect(relayNote("unknown", null, 0)).toBeNull();
    expect(relayNote("syncing", RELAY_ON, 0)).toBeNull();
    // The note a settled `synced` carries, kept here because it was the only other assertion in
    // the test this describe used to hold about the relay's stored error — that field is gone
    // and `relayState` never took it, so the claim was no longer reachable through the UI.
    expect(relayNote("synced", RELAY_ON, 1_700_000_060)).toBe("Last synced 1 minute ago.");
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

/**
 * The circle spec §2.2 opens, and the two things that break it.
 *
 * A device that has just paired is entitled through its **group** and does not know it yet: it
 * holds no `supporter_status` until a round trip asks `/token`'s group door. `ipc.syncNow` is
 * `client::run_once`'s only caller in the whole app — no launch sync, no timer — so if the one
 * control that calls it is drawn only for an entitled device, the press that would entitle this
 * device is the press it cannot reach. It sits on *Connect Patreon* for ever, which is the
 * reader's own item 3 reproduced one step further along.
 *
 * Both halves are asserted because either alone leaves a reader stranded: without the trip, a
 * reader who never opens Settings again is never entitled; without the button, a reader whose
 * relay was down at that exact moment has nothing to retry with.
 */
describe("a freshly paired device can reach the sync that entitles it", () => {
  /**
   * **The joining side, this time** — `returns the panel to idle once the poll answers complete`
   * above drives it from the offering side, and the doc comment on `SyncPanel`'s completed-
   * pairing effect is explicit that both sides fire this, not just the joiner: the offering
   * device wants the joiner's own rows just as much as the joiner wants the group's.
   */
  it("makes a round trip once a pairing this device joined completes", async () => {
    syncPairingPoll.mockResolvedValue({ stage: "complete", sas: null });
    const user = userEvent.setup();
    render(<SyncPanel />, { wrapper: unpaired });

    await user.click(await screen.findByRole("button", { name: /enter a code from another/i }));
    await user.type(await screen.findByLabelText(/code the other device is showing/i), "CODE");
    await user.click(screen.getByRole("button", { name: /read the code/i }));

    // The assertion the whole block exists for. Nothing else in the app calls this.
    await waitFor(() => expect(syncNow).toHaveBeenCalled());
    expect(
      await screen.findByText(/paired\. the other device is now part of this group/i),
    ).toBeInTheDocument();
  });

  it("still offers Sync now to a paired device its membership has not reached yet", async () => {
    // NOT_CONNECTED is what a joiner reads until that trip lands: no secret, no status, no date.
    // `paired: true` on the relay read is the only thing that may keep the button on screen.
    syncSupporterStatus.mockResolvedValue(NOT_CONNECTED);
    syncRelayStatus.mockResolvedValue({ ...RELAY_ON, paired: true });
    render(<SyncPanel />, { wrapper: paired });

    expect(await screen.findByRole("button", { name: /sync now/i })).toBeInTheDocument();
  });

  it("offers no Sync now to a device that is in no group and has no membership", async () => {
    // The other side of the same rule, and what stops the fix above from drawing a control that
    // can only ever report "there was nothing to do": `run_once` genuinely answers null here.
    syncSupporterStatus.mockResolvedValue(NOT_CONNECTED);
    syncRelayStatus.mockResolvedValue({ ...RELAY_OFF, paired: false });
    render(<SyncPanel />, { wrapper: unpaired });

    await screen.findByText(/not paired with anything yet/i);
    expect(screen.queryByRole("button", { name: /sync now/i })).not.toBeInTheDocument();
  });
});
