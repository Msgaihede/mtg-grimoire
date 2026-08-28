import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { QueryKey } from "@tanstack/react-query";
import { Copy, Link2, ShieldCheck, X } from "lucide-react";
import { useState, type JSX } from "react";
import { copyText } from "@/lib/clipboard";
import { FOCUS } from "@/lib/focus";
import {
  ipc,
  ipcError,
  type PairedDevice,
  type PairingOffer,
  type PairingStatus,
} from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { ConfirmDialog } from "./ConfirmDialog";
import { BUTTON } from "./controls";
import { PanelAlert, SettingsSection } from "./panelChrome";
import { QrCode } from "./QrCode";

/**
 * This device's pairing state, under one key.
 *
 * Declared here rather than in `@/lib/query`, which is `BackupPanel`'s `MIRROR_KEY` and its
 * reason: nothing else in the window reads it. The moment a second surface does — PR 7's sync
 * indicator will — the literal moves to `@/lib/query` for `COMBOS_KEY`'s reason, so that two
 * features cannot spell one prefix two ways.
 */
export const PAIRING_KEY: QueryKey = ["sync", "pairing"];

/**
 * §7.6, in the reader's words.
 *
 * **This wording is load-bearing and not copy.** Rotating the key stops the removed device
 * reading anything new; it cannot reach into that device and take back what it already has, and
 * no server anywhere can. A dialog that said only "Remove" would imply a lost phone had been
 * wiped, which is the opposite of what happens.
 */
export const REMOVAL_WARNING =
  "Removing a device changes the key your devices share, so it can read nothing new from now " +
  "on. It keeps whatever it already synced — this app cannot reach into it and take that " +
  "back, and no server has a copy to delete.";

/** A pairing in flight on this screen, and which half of it this device is playing. */
type Flow =
  | { kind: "idle" }
  /** The reader typed a code in. Nothing has been sent yet. */
  | { kind: "reading" }
  /** This device is offering. `sas` arrives with the other device's answer. */
  | { kind: "offer"; offer: PairingOffer; sas: string | null; sealedKey: string | null }
  /**
   * This device is joining. `sas` is known immediately — the joiner does the whole exchange in
   * one step — and `compared` is the reader saying they have looked at it.
   */
  | { kind: "join"; sas: string; response: string; compared: boolean };

/** A blob the reader carries by hand: shown whole, monospaced, and selectable. */
function Blob({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[0.6875rem] text-dim">{label}</span>
        <button
          type="button"
          onClick={() => void copyText(value)}
          className={cn(BUTTON, "h-7 border-border px-2 text-xs hover:bg-bg")}
        >
          <Copy aria-hidden="true" className="size-3.5" />
          Copy
        </button>
      </div>
      <textarea
        readOnly
        value={value}
        rows={3}
        spellCheck={false}
        aria-label={label}
        className={cn(
          "w-full resize-y rounded-md border border-border bg-surface px-2 py-1.5",
          "font-mono text-xs leading-relaxed break-all",
          "focus:border-accent focus:outline-none",
        )}
      />
    </div>
  );
}

/** A box the reader pastes a blob into, and the one press that reads it. */
function Paste({
  label,
  action,
  pending,
  onSubmit,
}: {
  label: string;
  action: string;
  pending: boolean;
  onSubmit: (text: string) => void;
}): JSX.Element {
  const [text, setText] = useState("");
  return (
    <div className="space-y-2">
      <label className="block space-y-1">
        <span className="block text-[0.6875rem] text-dim">{label}</span>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={3}
          spellCheck={false}
          className={cn(
            "w-full resize-y rounded-md border border-border bg-surface px-2 py-1.5",
            "font-mono text-xs leading-relaxed break-all",
            "focus:border-accent focus:outline-none",
          )}
        />
      </label>
      <button
        type="button"
        onClick={() => onSubmit(text.trim())}
        disabled={pending || text.trim() === ""}
        className={cn(BUTTON, "border-border hover:bg-bg disabled:hover:bg-transparent")}
      >
        {action}
      </button>
    </div>
  );
}

/**
 * The six digits, drawn the same size on both devices.
 *
 * **Both readers are comparing characters, so the two screens have to make that easy**: one
 * size, one face, one letter-spacing, and the number never abbreviated. `tabular-nums` is what
 * keeps `042913` and `111111` the same width, so a glance can compare shapes rather than
 * counting.
 */
function Digits({ sas }: { sas: string }): JSX.Element {
  return (
    <p className="font-mono text-3xl tracking-[0.3em] tabular-nums" data-testid="pairing-sas">
      {sas}
    </p>
  );
}

/** One row of the roster. */
function DeviceRow({
  device,
  isThisDevice,
  onRename,
  onRemove,
}: {
  device: PairedDevice;
  isThisDevice: boolean;
  onRename: (name: string) => void;
  onRemove: () => void;
}): JSX.Element {
  const [editing, setEditing] = useState<string | null>(null);
  const removed = device.revokedAt !== null;

  return (
    <li className="flex flex-wrap items-center gap-2 border-t border-border py-2 first:border-t-0">
      {editing === null ? (
        <span className={cn("min-w-0 flex-1 text-sm", removed && "text-dim line-through")}>
          {device.name}
        </span>
      ) : (
        <input
          value={editing}
          autoFocus
          onChange={(e) => setEditing(e.target.value)}
          onBlur={() => setEditing(null)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && editing.trim() !== "") {
              onRename(editing.trim());
              setEditing(null);
            }
            if (e.key === "Escape") setEditing(null);
          }}
          aria-label={`Name for ${device.name}`}
          className={cn(
            "h-8 min-w-0 flex-1 rounded-md border border-border bg-bg px-2.5 text-sm",
            "focus:border-accent focus:outline-none",
          )}
        />
      )}

      {/* Two facts a name cannot carry: which of these is the machine you are looking at, and
          which one was taken off. Words rather than colour — a removed device is not an error,
          it is a row of history. */}
      {isThisDevice && <span className="text-[0.6875rem] text-dim">This device</span>}
      {removed && <span className="text-[0.6875rem] text-dim">Removed</span>}

      {!removed && (
        <button
          type="button"
          onClick={() => setEditing(device.name)}
          className={cn(BUTTON, "h-7 border-border px-2 text-xs hover:bg-bg")}
        >
          Rename
        </button>
      )}
      {/* **No Remove on this device's own row**, because the backend refuses it and offering a
          press that cannot work is worse than not offering it: leaving a group throws this
          device's own key away, which is a different act with different consequences. */}
      {!removed && !isThisDevice && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${device.name}`}
          className={cn(BUTTON, "h-7 border-border px-2 text-xs hover:bg-bg")}
        >
          <X aria-hidden="true" className="size-3.5" />
          Remove
        </button>
      )}
    </li>
  );
}

/**
 * Pairing: what this device is, which group it is in, and the five presses that join another
 * one to it.
 *
 * **The six digits are the whole security argument and the panel is built around them**
 * (spec §7.5 step 3). Both readers are shown the same number in the same size and neither side
 * can move past it without saying so: the offering device's *Codes match* button carries
 * `aria-disabled` until the digits exist, and the joining device does not reveal the blob it has
 * to carry back until the reader has said the numbers agree. A panel that advanced on its own
 * would look completely normal and defend nothing.
 *
 * **Nothing here touches a network.** The two blobs are carried by hand — a QR a phone's camera
 * app reads, or 105 characters typed into the other window — which is what makes the whole
 * protocol testable before the relay exists. PR 7 replaces the second hop and changes none of
 * the crypto, the digits, the roster or the rotation.
 *
 * **This panel reaches the backend itself**, where four of its neighbours take their state as a
 * prop — `BackupPanel`'s argument exactly: nothing else in the window reads `sync_pairing_status`,
 * so `SettingsPage` would be holding a hook only to hand its answer straight back down.
 */
export function SyncPanel(): JSX.Element {
  const client = useQueryClient();
  const [flow, setFlow] = useState<Flow>({ kind: "idle" });
  const [removing, setRemoving] = useState<PairedDevice | null>(null);

  const read = useQuery({ queryKey: PAIRING_KEY, queryFn: () => ipc.syncPairingStatus() });
  const status: PairingStatus | null = read.data ?? null;

  const refresh = () => void client.invalidateQueries({ queryKey: PAIRING_KEY });

  const begin = useMutation({
    mutationFn: () => ipc.syncPairingBegin(),
    onSuccess: (offer) => setFlow({ kind: "offer", offer, sas: null, sealedKey: null }),
  });
  const accept = useMutation({
    mutationFn: (code: string) => ipc.syncPairingAccept(code),
    onSuccess: (shake) =>
      setFlow({ kind: "join", sas: shake.sas, response: shake.response, compared: false }),
  });
  const respond = useMutation({
    mutationFn: (response: string) => ipc.syncPairingRespond(response),
    onSuccess: (shake) =>
      setFlow((f) => (f.kind === "offer" ? { ...f, sas: shake.sas } : f)),
  });
  const confirm = useMutation({
    mutationFn: () => ipc.syncPairingConfirm(),
    onSuccess: (sealed) => {
      setFlow((f) => (f.kind === "offer" ? { ...f, sealedKey: sealed.sealedKey } : f));
      refresh();
    },
  });
  const complete = useMutation({
    mutationFn: (sealedKey: string) => ipc.syncPairingComplete(sealedKey),
    onSuccess: () => {
      setFlow({ kind: "idle" });
      refresh();
    },
  });
  const cancel = useMutation({
    mutationFn: () => ipc.syncPairingCancel(),
    // The offer is gone whether or not the backend answered — a cancel that failed still means
    // the reader is done with this screen, and the code on it stops working when the process
    // does. Settling the flow in `onSettled` is what stops a refusal stranding the panel mid-step.
    onSettled: () => setFlow({ kind: "idle" }),
  });
  const rename = useMutation({
    mutationFn: ({ deviceId, name }: { deviceId: string; name: string }) =>
      ipc.syncDeviceRename(deviceId, name),
    onSuccess: refresh,
  });
  const revoke = useMutation({
    mutationFn: (deviceId: string) => ipc.syncDeviceRevoke(deviceId),
    onSuccess: () => {
      setRemoving(null);
      refresh();
    },
  });

  /** Whichever press last refused. One line, because only one thing is ever in flight here. */
  const error =
    begin.error ??
    accept.error ??
    respond.error ??
    confirm.error ??
    complete.error ??
    rename.error ??
    revoke.error ??
    null;

  const paired = status !== null && status.groupId !== null;

  return (
    <SettingsSection id="sync" title="Devices">
      <p className="text-sm text-dim">
        Pairing joins two of your devices into one group so they can share a collection. There is
        no account and no password: one device shows a code, the other reads it, and both then
        show the same six digits for you to compare. Comparing them is what stops anything
        sitting in between joining the group, so it is the one step that is never skipped.
      </p>

      {status === null ? (
        <p className="text-sm text-dim">
          {read.isError ? "The pairing state could not be read." : "Reading this device…"}
        </p>
      ) : (
        <>
          {/* The sentence first and the id under it, rather than the other way round. The id is
              the more precise fact and the less useful one: it is what two devices compare when
              something has gone wrong, and 32 characters of hex at the top of a panel is a wall
              the sentence has to be read around. */}
          <div className="space-y-1">
            <p className="text-sm">
              {paired
                ? `${status.deviceName} — in a group of ${status.devices.length}, at key version ${status.epoch}.`
                : `${status.deviceName} — not paired with anything yet.`}
            </p>
            <p className="font-mono text-xs break-all text-dim tabular-nums">{status.deviceId}</p>
          </div>

          {paired && (
            <ul className="rounded-md border border-border px-3">
              {status.devices.map((d) => (
                <DeviceRow
                  key={d.deviceId}
                  device={d}
                  isThisDevice={d.deviceId === status.deviceId}
                  onRename={(name) => rename.mutate({ deviceId: d.deviceId, name })}
                  onRemove={() => setRemoving(d)}
                />
              ))}
            </ul>
          )}

          {flow.kind === "idle" && (
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => begin.mutate()}
                disabled={begin.isPending}
                className={cn(BUTTON, "border-border hover:bg-bg disabled:hover:bg-transparent")}
              >
                <Link2 aria-hidden="true" className="size-4" />
                Pair a device
              </button>
              <button
                type="button"
                onClick={() => setFlow({ kind: "reading" })}
                className={cn(BUTTON, "border-border hover:bg-bg")}
              >
                Enter a code from another device
              </button>
            </div>
          )}

          {flow.kind === "reading" && (
            <div className="space-y-3 rounded-md border border-border p-3">
              <Paste
                label="The code the other device is showing"
                action="Read the code"
                pending={accept.isPending}
                onSubmit={(code) => accept.mutate(code)}
              />
              <Cancel onCancel={() => cancel.mutate()} />
            </div>
          )}

          {flow.kind === "offer" && (
            <div className="space-y-3 rounded-md border border-border p-3">
              <p className="text-sm">
                Point the other device&rsquo;s camera at this, or type the code into it.
              </p>
              <div className="flex flex-wrap items-start gap-3">
                <QrCode matrix={flow.offer.qr} label="Pairing code as a QR code" />
                <p className="min-w-0 flex-1 font-mono text-xs leading-relaxed break-all">
                  {flow.offer.code}
                </p>
              </div>

              {flow.sas === null ? (
                <Paste
                  label="What the other device answered"
                  action="Read their answer"
                  pending={respond.isPending}
                  onSubmit={(text) => respond.mutate(text)}
                />
              ) : (
                <div className="space-y-2">
                  <p className="text-sm">
                    Both devices should now be showing these six digits. Check them against the
                    other screen before you go on.
                  </p>
                  <Digits sas={flow.sas} />
                </div>
              )}

              {flow.sealedKey === null ? (
                <div className="flex flex-wrap items-center gap-2">
                  {/*
                   * ⚠️ **`aria-disabled` and a no-op handler, not `disabled`.** This is the
                   * app's usual rule rather than `controls.ts`'s reversal, and here it is
                   * load-bearing: the button has to stay reachable so the sentence beside it
                   * can say *why* it is not ready. A confirm that went live the moment the
                   * digits arrived — or worse, before — would be a panel with no
                   * man-in-the-middle defence that looked completely normal.
                   */}
                  <button
                    type="button"
                    aria-disabled={flow.sas === null || confirm.isPending}
                    onClick={() => {
                      if (flow.sas !== null && !confirm.isPending) confirm.mutate();
                    }}
                    className={cn(
                      BUTTON,
                      "border-accent text-accent hover:bg-bg",
                      flow.sas === null && "cursor-not-allowed opacity-50 active:scale-100",
                      FOCUS,
                    )}
                  >
                    <ShieldCheck aria-hidden="true" className="size-4" />
                    Codes match
                  </button>
                  {flow.sas === null && (
                    <span className="text-xs text-dim">
                      Nothing to compare yet &mdash; read the other device&rsquo;s answer first.
                    </span>
                  )}
                  <Cancel onCancel={() => cancel.mutate()} />
                </div>
              ) : (
                <div className="space-y-2">
                  <p className="text-sm">
                    Last step: carry this back to the other device and paste it there.
                  </p>
                  <Blob label="The wrapped key for the other device" value={flow.sealedKey} />
                  <button
                    type="button"
                    onClick={() => setFlow({ kind: "idle" })}
                    className={cn(BUTTON, "border-border hover:bg-bg")}
                  >
                    Done
                  </button>
                </div>
              )}
            </div>
          )}

          {flow.kind === "join" && (
            <div className="space-y-3 rounded-md border border-border p-3">
              <p className="text-sm">
                The other device should now be showing these six digits too. Check them against
                that screen.
              </p>
              <Digits sas={flow.sas} />

              {/* The joining side's own gate. It changes no protocol — the answer below is
                  already computed — but a reader who has not looked at the digits has not
                  compared them, and this is the press that says they have. */}
              {!flow.compared ? (
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setFlow({ ...flow, compared: true })}
                    className={cn(BUTTON, "border-accent text-accent hover:bg-bg")}
                  >
                    <ShieldCheck aria-hidden="true" className="size-4" />
                    Codes match
                  </button>
                  <Cancel onCancel={() => cancel.mutate()} />
                </div>
              ) : (
                <div className="space-y-3">
                  <Blob label="Your answer, for the other device" value={flow.response} />
                  <Paste
                    label="The wrapped key the other device gave you"
                    action="Finish pairing"
                    pending={complete.isPending}
                    onSubmit={(text) => complete.mutate(text)}
                  />
                  <Cancel onCancel={() => cancel.mutate()} />
                </div>
              )}
            </div>
          )}
        </>
      )}

      <PanelAlert tone="problem">{error ? ipcError(error) : null}</PanelAlert>

      <ConfirmDialog
        open={removing !== null}
        title={removing === null ? "" : `Remove ${removing.name}?`}
        confirmLabel="Remove device"
        typeToConfirm={false}
        pending={revoke.isPending}
        onConfirm={() => {
          if (removing !== null) revoke.mutate(removing.deviceId);
        }}
        onDismiss={() => setRemoving(null)}
        onClose={() => setRemoving(null)}
      >
        {REMOVAL_WARNING}
      </ConfirmDialog>
    </SettingsSection>
  );
}

/** The way out of every step, spelled once. */
function Cancel({ onCancel }: { onCancel: () => void }): JSX.Element {
  return (
    <button
      type="button"
      onClick={onCancel}
      className={cn(BUTTON, "border-border text-dim hover:bg-bg")}
    >
      Cancel
    </button>
  );
}
