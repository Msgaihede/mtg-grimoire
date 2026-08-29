import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { QueryKey } from "@tanstack/react-query";
import { Copy, Link2, RefreshCw, ShieldCheck, X } from "lucide-react";
import { useState, type JSX } from "react";
import { copyText } from "@/lib/clipboard";
import { count, plural } from "@/lib/counts";
import { FOCUS } from "@/lib/focus";
import {
  ipc,
  ipcError,
  type PairedDevice,
  type PairingOffer,
  type PairingStatus,
  type RelayOutcome,
  type RelayStatus,
} from "@/lib/ipc";
import { RELAY_KEY, SYNC_KEY } from "@/lib/query";
import { ago } from "@/lib/relativeTime";
import { nowSeconds } from "@/lib/useMarketplace";
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
 * What the relay half of this panel is describing, in the seven words it has.
 *
 * `CombosPanel`'s `comboState` one feature over, and the ordering is again the whole content:
 *
 * * **`off` first among the settled states** — no address means nothing can run, so a stale
 *   `lastError` from an address the reader has since cleared must not out-shout it.
 * * **`syncing` before `failed`** — a round trip in flight is happening *now*, and a press over
 *   a previous failure is not "failed".
 * * **`failed` before `never`** — "we tried and it did not work" is a different sentence from
 *   "nobody has tried", and only one of them is worth a retry. This is the ordering the plan
 *   named and it is `comboState`'s and `feedState`'s before it.
 * * **`unpaired` after `failed`, before `never`** — an address with no group is a real state a
 *   reader can sit in for a whole session, and it has its own fix (pair a device) rather than
 *   being a sync that has not happened yet.
 *
 * `unknown` is the read still in flight or refused, and it is a state of its own rather than an
 * `off` in disguise: drawing "sync is off" over an unanswered read would tell a reader whose
 * devices are syncing perfectly that nothing is.
 *
 * **`failed` is the press this window made, never `RelayStatus.lastError`.** The stored error is
 * a *record* — it survives a later success on purpose, because the log is the record — so a
 * panel that read its state off it would say "failed" forever. It gets a line of its own
 * instead, in the error log's own quiet register.
 */
export type RelayState =
  | "unknown"
  | "off"
  | "syncing"
  | "failed"
  | "unpaired"
  | "never"
  | "synced";

export function relayState(
  status: RelayStatus | null,
  syncing: boolean,
  failed: boolean,
): RelayState {
  if (status === null) return "unknown";
  if (status.relayUrl === "") return "off";
  if (syncing) return "syncing";
  if (failed) return "failed";
  if (!status.paired) return "unpaired";
  if (status.lastSyncAt === null) return "never";
  return "synced";
}

/**
 * The one sentence beside the button, per state.
 *
 * Seven states and one sentence each rather than one sentence with a date in it — `comboNote`'s
 * shape and its reason: these are not degrees of the same thing. Two of the seven say nothing at
 * all, deliberately: a read in flight has the panel's own line and a sync in flight has the
 * button's, so a second sentence under either would be the panel talking over itself.
 *
 * **`off` is the sentence this whole half exists for.** An empty address field is not a form
 * waiting to be filled in — it is sync being *off*, which is the state every installation is in
 * and a perfectly good place to stay. A blank box that said nothing would leave a reader unable
 * to tell "off" from "not loaded".
 *
 * @param now unix **seconds**, passed rather than read so the panel and its stories agree about
 * the clock. {@link ago} takes milliseconds, which is what the conversion below is.
 */
export function relayNote(
  state: RelayState,
  status: RelayStatus | null,
  now: number,
): string | null {
  const at = status?.lastSyncAt ?? null;
  switch (state) {
    case "unknown":
    case "syncing":
      return null;
    case "off":
      return (
        "Sync is off. Nothing about your collection leaves this device until you give it a " +
        "relay address."
      );
    case "failed":
      return (
        "That sync did not finish. Nothing was lost — the changes are still here and go with " +
        "the next one."
      );
    case "unpaired":
      return (
        "There is nowhere to sync to yet. Pair a second device above, and this address starts " +
        "carrying changes between them."
      );
    case "never":
      return "Nothing has synced yet.";
    default:
      return at === null ? "Nothing has synced yet." : `Last synced ${ago(at, now * 1000)}.`;
  }
}

/**
 * What one press of Sync now did, in the reader's terms.
 *
 * **`null` is not a failure and must never read as one.** It is what the backend answers when
 * there was nothing to do — no relay address, or no pairing group — which is the state every
 * existing installation is in. A sentence saying so is the whole difference between a button
 * that explains itself and one that looks broken.
 *
 * The rest is `RelayOutcome`'s counts, and only the ones that are true of this trip: a sentence
 * per non-zero clause rather than a table of eight numbers, because seven of the eight are zero
 * on almost every sync. **`resurrected` and `cyclesBroken` are §7.4's two surfaced outcomes**,
 * so their clause points at the panel that lists them rather than describing each row twice.
 *
 * `deferred` is the one worth reading twice: a peer's stream is stalled on an op whose parent
 * has not arrived, which self-heals on a later pull. Saying "waiting" rather than "failed" is
 * the difference between a reader pressing again in a minute and one filing a bug.
 *
 * **The baseline clause is the one that has to explain a number rather than report it** (baseline
 * spec §13). A first exchange moves every row this device holds — 1 069 on the measured pair,
 * against the four or nine an ordinary trip carries — and a figure three orders of magnitude off
 * the sentence above it reads as a fault unless something says what it is. `deck_audit` gets a
 * clause of its own for §7's reason: history is the one synced table with no ceiling, so it is
 * the part of the total that can surprise, and a reader told only the sum cannot tell a large
 * collection from a long one.
 *
 * **It is the one clause here that counts through `count` rather than `plural`.** Every other
 * number in this sentence is a handful of changes; this one reaches four digits, which is the
 * case `plural`'s own doc comment hands to `count`.
 */
export function outcomeText(outcome: RelayOutcome | null): string {
  if (outcome === null) {
    return (
      "There was nothing to sync. This device needs a relay address and a paired device " +
      "before anything can be sent."
    );
  }
  const parts = [
    `Sent ${plural(outcome.pushed, "change")} and received ${plural(outcome.pulled, "change")}.`,
  ];
  if (outcome.resurrected > 0) {
    parts.push(`Kept ${plural(outcome.resurrected, "row")} another device had deleted.`);
  }
  if (outcome.cyclesBroken > 0) {
    parts.push(
      `Moved ${plural(outcome.cyclesBroken, "folder")} to the top level to undo a loop.`,
    );
  }
  if (outcome.resurrected > 0 || outcome.cyclesBroken > 0) {
    parts.push("Needs review, just below, says which.");
  }
  if (outcome.baselineOps > 0) {
    parts.push(
      "This was the first exchange with a device that had not heard from this one, so " +
        `everything here went across — ${count(outcome.baselineOps)} rows.`,
    );
    // Nested rather than a clause of its own: history rows are *among* the baseline's, so a
    // count with no baseline behind it is a state the backend cannot produce, and drawing "0 of
    // those" on a routine trip is the noise every other clause here is guarded against.
    if (outcome.baselineHistory > 0) {
      parts.push(
        `${count(outcome.baselineHistory)} of those are deck history — a deck's story reads ` +
          "the same wherever it is opened, so it goes across too.",
      );
    }
  }
  if (outcome.deferred > 0) {
    parts.push(
      `${plural(outcome.deferred, "change")} arrived before the change they build on. They ` +
        "land on a later sync.",
    );
  }
  if (outcome.unreadable > 0) {
    parts.push(`${plural(outcome.unreadable, "change")} could not be read on this device.`);
  }
  return parts.join(" ");
}

/**
 * The relay: the address, what is waiting, and the one press that makes a round trip.
 *
 * **The address is the whole switch.** There is no relay in this repository and there must never
 * be one — it is a small server the reader runs themselves, and it lives in their own
 * `sync_state`. Empty means off, and the panel says so in words rather than leaving a blank box
 * to be read as a form nobody filled in.
 *
 * **Nothing here reads what the relay stores, because nothing can.** The group key never leaves
 * the paired devices (§7.5), so what that server holds is ciphertext and who sent it — which is
 * the sentence the opening paragraph spends its length on, because it is the only reason typing
 * a URL into a settings panel is a reasonable thing to ask of anyone.
 *
 * **Sync now is drawn only once there is an address**, which is `DeviceRow`'s rule about the
 * missing Remove button in a friendlier case: `sync_now` over an empty address answers `null`
 * rather than refusing, so the press would be harmless — and a control that can only ever
 * report "there was nothing to do" is a control that teaches a reader to distrust it. With an
 * address and no group it *is* drawn, because that reader is one pairing away and the sentence
 * is worth having.
 */
function RelaySection(): JSX.Element {
  const client = useQueryClient();
  /** What the reader has typed, or `null` while the field is showing what is stored. Not
   *  seeded from the query: a field initialised once from an answer that arrives later would
   *  stay empty on the render that matters. */
  const [draft, setDraft] = useState<string | null>(null);
  /** The last round trip's report, kept until the next press. `undefined` is "no press yet" and
   *  `null` is the backend's own "there was nothing to do", which are different sentences. */
  const [outcome, setOutcome] = useState<RelayOutcome | null | undefined>(undefined);

  const read = useQuery({ queryKey: RELAY_KEY, queryFn: () => ipc.syncRelayStatus() });
  const status: RelayStatus | null = read.data ?? null;

  const save = useMutation({
    mutationFn: (url: string) => ipc.syncRelaySetUrl(url),
    onSuccess: (next) => {
      // The backend trims and normalises, so the field goes back to showing what was *stored*
      // rather than what was typed — `https://relay.example/` saved is `https://relay.example`.
      client.setQueryData(RELAY_KEY, next);
      setDraft(null);
    },
  });

  const sync = useMutation({
    mutationFn: () => ipc.syncNow(),
    onSettled: (result) => {
      // **`onSettled`, not `onSuccess`.** A refused trip still moved `last_error` and may have
      // applied part of a pull before it stopped, so the figures have to be re-read either way.
      // `result` is `undefined` on the failure path, which is neither of the two states the
      // outcome line draws — hence the explicit `undefined` check rather than `?? null`.
      if (result !== undefined) setOutcome(result);
      void client.invalidateQueries({ queryKey: SYNC_KEY });
    },
  });

  const syncing = sync.isPending;
  const state = relayState(status, syncing, sync.isError);
  // One clock for the whole render — `CombosPanel`'s rule and its reason: a settings panel that
  // repainted on a timer to keep a relative date current would be motion without information,
  // and `react-hooks/purity` refuses a bare `Date.now()` in a render body.
  const note = relayNote(state, status, nowSeconds());
  const value = draft ?? status?.relayUrl ?? "";
  const dirty = draft !== null && draft.trim() !== (status?.relayUrl ?? "");
  const submit = () => {
    if (dirty && !save.isPending) save.mutate(draft ?? "");
  };

  return (
    <div className="space-y-3 border-t border-border pt-4">
      <h3 className="font-heading text-sm leading-none">Relay</h3>

      <p className="text-sm text-dim">
        Your devices hand changes to each other through one small server you run yourself. It
        never gets the key the group shares, so what it holds is unreadable to it &mdash; and
        with no address here, nothing is sent anywhere at all.
      </p>

      {/* **No field at all while the read is unanswered, which is the pairing half's rule one
          rung up and is load-bearing here rather than tidy.** An address box drawn empty over an
          answer nobody has is indistinguishable from sync being off — and worse, Save over it
          would write that empty string and switch off a relay the reader had set. */}
      {status === null ? (
        <p className="text-sm text-dim">
          {read.isError ? "The relay could not be read." : "Reading the relay…"}
        </p>
      ) : (
        <div className="space-y-1">
          {/* A written `id` rather than `useId()`, `SettingsSection`'s rule: a generated `:r7:`
              moves with the render order of the page, and these are readable in the shipped
              window. */}
          <label htmlFor="relay-url" className="block text-[0.6875rem] text-dim">
            Relay address
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <input
              id="relay-url"
              value={value}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
              }}
              spellCheck={false}
              autoComplete="off"
              inputMode="url"
              placeholder="https://"
              className={cn(
                "h-8 min-w-0 flex-1 rounded-md border border-border bg-bg px-2.5",
                // An address is data, and data is Geist Mono — the role prices, versions and
                // collector numbers already carry in this window.
                "font-mono text-xs",
                "focus:border-accent focus:outline-none",
              )}
            />
            <button
              type="button"
              onClick={submit}
              disabled={!dirty || save.isPending}
              className={cn(BUTTON, "border-border hover:bg-bg disabled:hover:bg-transparent")}
            >
              Save
            </button>
          </div>
        </div>
      )}

      {status !== null && status.relayUrl !== "" && (
        <p className="text-sm text-dim">
          {status.pending === 0
            ? "Nothing is waiting to go."
            : `${plural(status.pending, "change")} waiting to go.`}
        </p>
      )}

      {status?.lastError != null && (
        // The record, in the error log's own quiet register rather than the destructive red: it
        // is not news about a press the reader just made, and it stands after a later sync
        // worked because the log is the record.
        <p className="text-xs text-dim">
          {`Last relay failure: ${status.lastError} It is kept even after a later sync ` +
            "worked — Errors, further down this page, is where the log is cleared."}
        </p>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        {/* `min-w-0` so the sentence gives way rather than the button: a flex item cannot shrink
            below its own min-content unless it is told it may. */}
        <p className="min-w-0 flex-1 text-sm text-dim">{note}</p>
        {status !== null && status.relayUrl !== "" && (
          // `disabled` rather than `aria-disabled` — `controls.ts`'s family, and correct here
          // for its reason: a trip already in flight has genuinely nothing for a second press
          // to do, and `disabled:active:scale-100` holds the box at full size so a greyed
          // control cannot answer a press with a dip.
          <button
            type="button"
            onClick={() => sync.mutate()}
            disabled={syncing}
            aria-busy={syncing || undefined}
            className={cn(BUTTON, "border-border hover:bg-bg disabled:hover:bg-transparent")}
          >
            <RefreshCw aria-hidden="true" className={cn("size-4", syncing && "animate-spin")} />
            Sync now
          </button>
        )}
      </div>

      {/* What the press did, in the plain tone the error log argues for: a round trip that found
          nothing to do is news rather than an alarm, and it is the commonest thing this button
          reports. */}
      <PanelAlert tone="plain">
        {outcome === undefined || syncing ? null : outcomeText(outcome)}
      </PanelAlert>

      {/* The refusal itself, in the app's destructive red — a press the reader made did not
          happen. One line, because only one of the two is ever in flight here. */}
      <PanelAlert tone="problem">
        {save.error ? ipcError(save.error) : sync.error ? ipcError(sync.error) : null}
      </PanelAlert>
    </div>
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
 * **Nothing in the pairing half touches a network.** The two blobs are carried by hand — a QR a
 * phone's camera app reads, or 105 characters typed into the other window — which is what makes
 * the whole protocol testable before the relay exists. The relay landed without moving any of
 * it: the crypto, the digits, the roster and the rotation are all still the hand-carried
 * exchange's.
 *
 * **{@link RelaySection} is the second half**, under a rule of its own: the address changes go,
 * what is waiting, and the one press that makes a round trip now. It is a separate query and a
 * separate set of presses — the two halves share only the `["sync"]` root, which is what makes
 * a finished trip refresh the roster as well as the figures.
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
    <SettingsSection id="sync" title="Sync">
      {/* **The panel is "Sync" and "Devices" is its first half**, because a second half arrived:
          pairing says *who* is in the group and the relay below says *how* their changes reach
          each other. Neither is the other's setting, and a panel called "Devices" with a server
          address in it would be a heading that had stopped describing its own contents. */}
      <h3 className="font-heading text-sm leading-none">Devices</h3>

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

      <RelaySection />

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
