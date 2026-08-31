import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { QueryKey } from "@tanstack/react-query";
import { Heart, Link2, LogOut, RefreshCw, ShieldCheck, X } from "lucide-react";
import { useEffect, useRef, useState, type JSX } from "react";
import { count, plural } from "@/lib/counts";
import { FOCUS } from "@/lib/focus";
import { openExternal } from "@/lib/externalLinks";
import {
  ipc,
  ipcError,
  type LiveState,
  type PairedDevice,
  type PairingOffer,
  type PairingStatus,
  type RelayOutcome,
  type RelayStatus,
  type SupporterStatus,
} from "@/lib/ipc";
import { PAIRING_KEY, RELAY_KEY, SYNC_KEY } from "@/lib/query";
import { ago } from "@/lib/relativeTime";
import { useDeviceSyncLive } from "@/lib/useDeviceSyncLive";
import { nowSeconds } from "@/lib/useMarketplace";
import { cn } from "@/lib/utils";
import { ConfirmDialog } from "./ConfirmDialog";
import { BUTTON } from "./controls";
import { PanelAlert, SettingsSection } from "./panelChrome";
import { QrCode } from "./QrCode";
import { QrScanner } from "./QrScanner";

/**
 * Where an in-flight pairing has got to — nested under {@link PAIRING_KEY}'s root rather than
 * exported, because only this file's own poll below ever reads it. Kept apart from `PAIRING_KEY`
 * itself rather than reusing it: that key is the roster read, and a poll ticking every 1.5 s
 * must not mark the roster stale on every tick it changes nothing.
 */
const PAIRING_POLL_KEY: QueryKey = ["sync", "pairing", "poll"];

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

/**
 * §2.1 and §2.3, and the two facts a reader cannot work out from the word *Leave*.
 *
 * **This wording is load-bearing and not copy**, for {@link REMOVAL_WARNING}'s reason arrived at
 * from the other side of the same act. Two things have to be in it:
 *
 * 1. **This device keeps its own collection.** Leaving is the one press on this panel that
 *    sounds like it throws something away, and what it actually throws away is a *membership in
 *    a group* — every row is still in this device's own SQLite afterwards. A dialog that said
 *    only "Leave group?" would be asking a reader to gamble their cards on a guess.
 * 2. **The others may not hear.** `leave_group_now` publishes best effort and clears locally
 *    whatever the relay answered, which is the whole of *"leaving is always possible"* — so a
 *    reader who leaves offline leaves for real while the remaining devices go on listing this
 *    one. That is the honest cost of the guarantee, and hiding it would let a reader believe the
 *    group had closed behind them when it had not. §5's first row, in the reader's words.
 *
 * The middle clause is the third consequence and the only *visible* one: `entitlement::clear`
 * runs unconditionally too, so a reader who pressed Connect on this device reads *Not connected*
 * a moment later. Nothing ended — `clear`, never `revoke` — which is why the sentence offers the
 * way back rather than apologising.
 */
export const LEAVE_WARNING =
  "Your collection stays on this device. Nothing here is deleted — what goes is this device's " +
  "place in the group, and the membership it was carrying with it. You can pair it again, or " +
  "connect a membership again, whenever you like. And if the relay cannot be reached right now, " +
  "your other devices will not hear that you have gone: they go on listing this one until " +
  "somebody removes it there.";

/**
 * What the panel says when a pairing attempt ran out of time.
 *
 * **The sentence is this file's and the fact is Rust's**, which is the boundary rather than a
 * preference: `pairing::poll` answers a `"expired"` *stage*, and the words a reader reads about
 * it are presentation. It used to be a `String` error thrown by that command — and the reader
 * never saw it, because clearing the pending offer made the refusal one call long while the
 * panel's query retries once, so the retry's `Ok(idle)` overwrote it. At ten minutes nothing on
 * screen changed and the panel polled a rendezvous that no longer existed for ever.
 *
 * It names the way forward, because there is one and it is the same press either side started
 * from: the flow returns to `"idle"`, where *Pair a device*, *Enter a code* and *Scan a code* all
 * are.
 */
export const EXPIRED_NOTE =
  "That pairing code timed out — codes are good for ten minutes. Start a new one, or read a " +
  "fresh code from the other device.";

/**
 * A pairing in flight on this screen, and which half of it this device is playing.
 *
 * **The relay carries the accept and the sealed key now**, so there is no `response` and no
 * `sealedKey` field left to hand-carry — the two blobs that used to live here are read off
 * {@link ipc.syncPairingPoll} instead. What is still hand-carried is the invite: the code or QR
 * that names *which* session to join, since that is the one thing neither device can already
 * see.
 */
type Flow =
  | { kind: "idle" }
  /** The reader chose to type a code from another device. Nothing has reached the backend yet. */
  | { kind: "reading" }
  /** The reader chose to scan a code with the camera instead. Same: nothing sent yet. */
  | { kind: "scanning" }
  /**
   * This device is offering. `sas` starts `null` and is filled in by the poll once the other
   * device has accepted — the offer's own answer used to carry it, but that answer no longer
   * comes back by hand.
   */
  | { kind: "offer"; offer: PairingOffer; sas: string | null }
  /**
   * This device is joining. `accept` already answers the six digits in one step, so there is
   * nothing here for the poll to fill in — only the move to `"complete"` still matters to it.
   */
  | { kind: "join"; sas: string };

/**
 * A box the reader pastes or types a blob into, and the one press that reads it.
 *
 * `aria-disabled` and a no-op-guarded `onClick`, never the `disabled` attribute —
 * `src/CLAUDE.md`'s rule for a control that greys as the reader types, which this button always
 * violated until now: a `disabled` submit button here left the tab order on every keystroke that
 * emptied the box.
 */
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
  const empty = text.trim() === "";
  const submit = () => {
    if (!empty && !pending) onSubmit(text.trim());
  };
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
        aria-disabled={pending || empty}
        onClick={submit}
        className={cn(
          BUTTON,
          "border-border hover:bg-bg",
          (pending || empty) && "cursor-not-allowed opacity-50 active:scale-100",
          FOCUS,
        )}
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

/**
 * The mark on the row for the machine the reader is sitting at.
 *
 * **It became a pill when the names became real.** While every install minted "This device" the
 * roster's rows were identical and this word was the only thing telling them apart. Now that
 * they read `MAIN-PC` and `OnePlus 12` it answers a different and still necessary question —
 * which of these real machines is *here* — and it has to be findable by shape rather than read
 * for.
 *
 * **One mark per row, and it is this one**, which is now a statement about the whole roster
 * rather than a ranking against a second mark. Every row drawn is a device still in the group,
 * so the only thing left for a mark to say is which of them is *here* — orientation, the thing
 * a reader scans a roster for and the question a real machine name leaves open.
 *
 * **No colour**, because the panel's own comment two lines down still holds: `border-border`
 * over `text-dim` is what this app uses for a fact stated beside a name (`LangBadge`, the card
 * pane's `In deck`), and `accent` in Settings means something you can press. What makes it a
 * token rather than a word is the `bg-bg` fill against the section's `bg-surface` and the full
 * round.
 */
const THIS_DEVICE_PILL =
  "shrink-0 rounded-full border border-border bg-bg px-2 py-px text-[0.6875rem] leading-4 text-dim";

/** One row of the roster — a device that is still in the group. */
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

  return (
    <li className="flex flex-wrap items-center gap-2 border-t border-border py-2 first:border-t-0">
      {/* **The name and its marks are one group, and the group is what takes `flex-1`.** The
          name carried it until the names became real, which ate the row's free space and pushed
          both marks to the far edge against the buttons — so the word that says "this is the
          machine you are at" read as part of the controls rather than as part of the name.
          Here the name sizes to its content, the marks sit directly against the end of it, and
          the presses stay right-aligned however short the name is.

          **`min-w-0` is on the group *and* on the name.** `min-width: auto` is the flex default,
          so a long hostname refuses to shrink and pushes the buttons off the row instead of
          truncating; one of the two alone is not enough.

          One fact a name cannot carry: which of these is the machine you are looking at. There
          used to be a second — which one was taken off — and it went with the rows that carried
          it, because a reader who removed a device asked for it to be gone rather than struck
          through. */}
      <span className="flex min-w-0 flex-1 items-center gap-2">
        {editing === null ? (
          <span className="min-w-0 truncate text-sm">{device.name}</span>
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
        {isThisDevice && <span className={THIS_DEVICE_PILL}>This device</span>}
      </span>

      {/* **Rename stays on every row, this device's own included, and it matters more now than
          it did.** The name a device mints is its hostname, which travels to every device in the
          group at the next pairing — so this press is the reader's way out of sending one they
          would rather not. The pill does not replace it and must not crowd it out. */}
      <button
        type="button"
        onClick={() => setEditing(device.name)}
        className={cn(BUTTON, "h-7 border-border px-2 text-xs hover:bg-bg")}
      >
        Rename
      </button>
      {/* **No Remove on this device's own row**, because the backend refuses it and offering a
          press that cannot work is worse than not offering it: leaving a group throws this
          device's own key away, which is a different act with different consequences. */}
      {!isThisDevice && (
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
 * * **`off` first among the settled states** — no membership means nothing can run, so a failed
 *   press from before it lapsed must not out-shout it.
 * * **`syncing` before `failed`** — a round trip in flight is happening *now*, and a press over
 *   a previous failure is not "failed".
 * * **`failed` before `never`** — "we tried and it did not work" is a different sentence from
 *   "nobody has tried", and only one of them is worth a retry. This is the ordering the plan
 *   named and it is `comboState`'s and `feedState`'s before it.
 * * **`unpaired` after `failed`, before `never`** — a membership with no group is a real state a
 *   reader can sit in for a whole session, and it has its own fix (pair a device) rather than
 *   being a sync that has not happened yet.
 *
 * `unknown` is **either** read still in flight or refused, and it is a state of its own rather
 * than an `off` in disguise: drawing "sync is off" over an unanswered read would tell a reader
 * whose devices are syncing perfectly that nothing is.
 *
 * **`failed` is a press this window made, and it is news rather than a record.** It says a trip
 * the reader just asked for did not finish, and it is forgotten the moment the next one does —
 * which is what makes it safe to draw as a *state*. The record is the Errors panel further down
 * this page, where the log survives a later success on purpose and where it is cleared; a panel
 * that read its state off a log would say "failed" for ever.
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
  supporter: SupporterState,
  syncing: boolean,
  failed: boolean,
): RelayState {
  // **Two reads, and either one still in flight is `unknown`.** Drawing "sync is off" over an
  // unanswered membership would tell a reader whose devices are syncing perfectly that nothing
  // is — and the membership answers a moment after the figures do, so that flash is reachable
  // rather than theoretical.
  if (status === null || supporter === "unknown") return "unknown";
  if (supporter === "ended" || supporter === "never") return "off";
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
        "Sync is off. Nothing about your collection leaves this device until a membership is " +
        "connected above."
      );
    case "failed":
      return (
        "That sync did not finish. Nothing was lost — the changes are still here and go with " +
        "the next one."
      );
    case "unpaired":
      return (
        "There is nowhere to sync to yet. Pair a second device above, and the relay starts " +
        "carrying changes between them."
      );
    case "never":
      return "Nothing has synced yet.";
    default:
      return at === null ? "Nothing has synced yet." : `Last synced ${ago(at, now * 1000)}.`;
  }
}

/**
 * One sentence about the socket, or none — a third sentence function beside {@link relayNote}
 * and {@link supporterNote}, not an eighth {@link RelayState} arm.
 *
 * **A connection state is not mutually exclusive with `relayState`'s seven rungs.** "The socket
 * is live" and "last synced three minutes ago" are both true at once — a device can be `synced`
 * from its last round trip and have the socket drop a second later, with nothing about that in
 * `RelayStatus`. So this reads {@link LiveState} on its own, the way `supporterNote` already
 * reads {@link SupporterState} on its own beside `relayState`.
 *
 * Same rule as its two neighbours: **one sentence per state, never one sentence with a status
 * interpolated into it.** Only the failing state says anything — a working socket is not news —
 * and the state this exists for is the one automatic sync introduces: a device that looks synced
 * while its socket has quietly been down for hours. `off` and `connecting` say nothing for
 * `relayNote`'s `off`/`syncing` reason: sync being off has its own sentence already, and a
 * connection attempt in progress is not a failure to report on.
 */
export function liveNote(state: LiveState): string | null {
  switch (state) {
    case "offline":
      return (
        "Not connected to the relay. Changes are still being kept and go across as soon as " +
        "it comes back."
      );
    case "off":
    case "connecting":
    case "live":
      return null;
  }
}

/**
 * What one press of Sync now did, in the reader's terms.
 *
 * **`null` is not a failure and must never read as one.** It is what the backend answers when
 * there was nothing to do — no connected membership, or no pairing group — which is the state
 * every existing installation is in. A sentence saying so is the whole difference between a button
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
      "There was nothing to sync. This device needs a connected membership and a paired " +
      "device before anything can be sent."
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
 * This device's membership, under one key.
 *
 * Local for {@link PAIRING_KEY}'s reason and under the same standing offer: nothing else in the
 * window reads it, and the moment a second surface does the literal moves to `@/lib/query`, so
 * that two features cannot spell one prefix two ways. It sits **under** `SYNC_KEY`, which is
 * what makes a finished round trip re-read it — a trip refused with a 401 is how a lapse
 * reaches a reader who never opened Patreon.
 */
export const SUPPORTER_KEY: QueryKey = ["sync", "supporter"];

/**
 * The membership in one word — and the three that must never be spelled the same way.
 *
 * `never` and `ended` arrive from the backend as the **same two fields**: `entitled: false`
 * with `status: "dead"`. They are not the same state and they do not get the same sentence. A
 * reader who has not connected is looking at a button; a reader whose pledge stopped is looking
 * at a renewal and at a paragraph saying their collection is untouched (spec §7.1), and telling
 * them *Not connected* would be this panel forgetting they were ever here.
 *
 * **`groupBound` is the whole of what separates them, and `since` cannot do it.** That is the
 * trap the Rust names at `SupporterStatus::group_bound` and it was worth one bug here before
 * this comment existed: `entitlement::revoke` stores `("dead", None)`, so a lapsed device and a
 * device out of the box read the *same three fields* — `entitled: false`, `status: "dead"`,
 * `since: null`. `group_bound` is `entitlement::membership_ended` crossing the wire, and it is
 * the only signal that remembers this device was ever bound to an entitlement.
 *
 * **A `"dead"` status on an *entitled* device is not an ending either**, and that is the second
 * trap. It is reachable from both sides of the grant: the device that pressed Connect holds a
 * refresh secret, and `store_grant` and `store_status` are separate calls, so a status row can
 * be absent while the secret is live — and an absent row defaults to `"dead"`. It is
 * supporting; it simply has not been told a date yet, which is what {@link supporterNote}'s
 * dateless *Supporting* line is for.
 *
 * **`grace` is a third thing and not a gentler `dead`** (spec §7.2). Patreon is retrying a card;
 * tokens are still minted and sync still works. Drawn as a cancellation it would punish a reader
 * for something they did not decide, and hiding *Sync now* would make that punishment real.
 *
 * `unknown` is the read in flight or refused, and it is why {@link relayState} takes this rather
 * than a boolean: `false` for "not answered yet" and `false` for "not a supporter" are the same
 * value and very different sentences.
 */
export type SupporterState = "unknown" | "active" | "grace" | "ended" | "never";

export function supporterState(status: SupporterStatus | null): SupporterState {
  if (status === null) return "unknown";
  // **`entitled` is asked first, and the order is load-bearing rather than tidy.** It is the
  // question the relay's own answer settles — will it mint this device a token — and a device
  // it will mint for has not ended anything. A build that asked `status` first read the second
  // device as lapsed: `store_grant` and `store_status` are separate calls, `supporter_state`
  // defaults an absent row to `"dead"`, and a phone whose desktop had just paid drew
  // *Membership ended*. The order matters more now, not less: `entitlement::membership_ended`
  // is `refresh_secret.is_none() && SUPPORTER_STATUS.is_some()`, which a device entitled
  // through its *group* satisfies — so `groupBound` below reads `true` for a membership that
  // has not ended at all, and this line is the whole of what stops it being drawn as one.
  if (status.entitled) return status.status === "grace" ? "grace" : "active";
  // `groupBound`, never `since` — see above. A revoked grant deletes the date with the secret.
  return status.groupBound ? "ended" : "never";
}

/** A date rather than "3 days ago": a start date is a fact about a subscription, where `ago`'s
 *  coarsest-unit-still-true rule is about freshness. `en-US` is `DeckHistoryDialog`'s stamp. */
const SINCE_FORMAT = new Intl.DateTimeFormat("en-US", { dateStyle: "long" });

/**
 * The one line above the buttons, per state.
 *
 * One sentence each rather than one sentence with a status in it, which is {@link relayNote}'s
 * shape and its reason: these are not degrees of the same thing, and the whole job of this
 * function is that no two of them can be reached by the same fixture.
 *
 * **The grace sentence says what is still true, not only what went wrong.** "Payment problem"
 * on its own is a reader cancelling something that has not stopped working; the second clause
 * is the half that stops them.
 *
 * `unknown` says nothing at all — the block draws its own reading line, and a second sentence
 * under it would be the panel talking over itself.
 */
export function supporterNote(
  state: SupporterState,
  status: SupporterStatus | null,
): string | null {
  switch (state) {
    case "unknown":
      return null;
    case "active":
      return status?.since == null
        ? "Supporting. Thank you."
        : `Supporting since ${SINCE_FORMAT.format(status.since * 1000)}.`;
    case "grace":
      return "Payment problem — Patreon is retrying, and sync keeps working for now.";
    case "ended":
      return "Membership ended.";
    default:
      return "Not connected.";
  }
}

/**
 * The sentence a lapse owes, and the one this whole block is worth having for.
 *
 * §7.1: cancelling drops the relay's log at once — and the relay's log is a transport buffer
 * with a 30-day tail, not anybody's collection. Every device already holds the whole thing in
 * its own SQLite. A panel that said "Membership ended" and stopped there would leave a reader to
 * guess which of those two it meant, and the wrong guess is that their cards are gone.
 *
 * **Drawn beside `ended` and never beside `never`.** A reader who has not connected has lost
 * nothing and has not asked; a reassurance there answers a question they did not have, and
 * teaches them there is something to worry about.
 */
const LAPSE_REASSURANCE =
  "Your collection stays on this device. Nothing has been deleted, and connecting again picks " +
  "up where you left off — your devices stay paired.";

/**
 * The one dead end this press can still walk a reader into, and the reassurance beside it.
 *
 * **Connecting founds a group of one when this device is in none** (§6.3, `ensure_group`), and
 * `pairing::complete` refuses a `group_id` that differs from the one this device already holds. So
 * a device that has connected can still *invite* others into its group, but can never *join* a
 * group that already exists — and there is no Leave and no Disconnect in this panel to undo it.
 * A reader who connects on their phone and then tries to join their desktop's group meets
 * *"This device is already in a different pairing group. Leave that one first."* with nothing to
 * press, which is the one way this panel can strand somebody.
 *
 * **What this paragraph no longer says is that the *order* costs anything, because since spec
 * §2.2 it does not.** It used to open "Connect on the device you want to pair from", which was
 * advice about a second trap that has been removed: `refresh` travelled only inside the sealed
 * pairing blob, so a device paired *before* anybody connected got nothing and could never get
 * anything. `/token`'s group door ended that — any device in the group mints on the group auth —
 * so pairing first and connecting second now leaves every device entitled, and the last clause
 * is there to say so rather than to leave a reader guessing which device has to hold the
 * membership. The sentence that survives is the one about *groups*, not about order.
 *
 * **Drawn beside the press that causes it**, not in the pairing half above: the trap belongs to
 * this button, and a reader whose devices are already paired has nothing here to avoid. That
 * placement is a claim, so it is asserted both ways — present on `never` and on `ended`, absent
 * once a membership is connected — in `SyncPanel.test.tsx` and in the `NotConnected` and
 * `Supporting` plays, exactly as {@link LAPSE_REASSURANCE} above is. Moving this paragraph one
 * level out of the `offering` block leaves the rest of the file green.
 */
const CONNECT_ORDER =
  "Connecting puts this device in a sync group of its own if it is not in one yet, and a " +
  "device can only be in one group. If your other devices already sync together, pair this " +
  "one to them first — then a membership on any of them covers all of them.";

/**
 * The cost of a *re-claim*, said beside the field that makes one — spec §3, and its own words:
 * **"the panel says so before the press, and that copy is load-bearing."**
 *
 * `/claim` used to refuse a subject that already held a group with a 409, which stranded the one
 * reader it was worst for: the paying device leaves, and there is then no press anywhere that
 * re-binds its membership. So a re-claim **moves** the binding instead — and the price is paid
 * by whoever is still in the old group. Their relay log is dropped and their `group_devices`
 * rows go with it, so they stop syncing with each other and fail their next key check.
 *
 * **The reader this is for has not left anything.** A payer who leaves first has already
 * orphaned that group and this sentence tells them nothing new; a reader who simply pastes a
 * fresh code on a second machine can take down a working group without any press ever saying so.
 * That reader is the whole audience, which is why it is drawn at the claim field rather than at
 * *Connect Patreon* — opening a browser costs nothing, and the claim is the write.
 *
 * **What it must not do is offer a way to keep both**, because there is not one: one
 * subscription serves exactly one group, which is the invariant the 409 was protecting and the
 * rebinding keeps. So the sentence names what the old group loses and what it does not, and
 * stops.
 */
const RECLAIM_WARNING =
  "One membership covers one group. If this membership was last claimed for a different group " +
  "of devices, claiming it here moves it — and the devices left in that group stop syncing with " +
  "each other, because the relay drops what it was holding for them. Their own collections are " +
  "untouched, but they have no way back until they pair again.";

/**
 * The membership, the relay it pays for, and the one press that makes a round trip.
 *
 * **The relay is one hosted server now and its address is compiled into the crate**, which
 * reverses what this file said until 2026-08-29 — there *is* a relay in this repository, under
 * `relay/`, and the reader no longer types anything to reach it. What replaced the address field
 * is a membership: press Connect Patreon, consent on Patreon's own page, and paste back the code
 * its landing page shows. "Sync is off" stopped meaning *no URL* and started meaning *no
 * entitlement*.
 *
 * **Nothing here reads what the relay stores, because nothing can.** The group key never leaves
 * the paired devices (§7.5), so what that server holds is ciphertext and who sent it — which is
 * the sentence the opening paragraph spends its length on, because it is the only reason a
 * server somebody else runs is a reasonable thing to sync through. It is also why the membership
 * is an account with **Patreon** and never one with the relay: the relay is told a subject and a
 * group, and is never told a person.
 *
 * **Only one device ever opens a browser, and since spec §2.2 that is a fact about the
 * *group* rather than about a secret that travelled.** The refresh secret no longer rides
 * inside the sealed pairing blob — it stays on the device that pressed Connect, which is what
 * makes a removal stick — and every other device in the group mints its own token on the group
 * auth through `/token`'s second door. So a phone paired to a connected desktop is entitled
 * without meeting any of this, in either pairing order, and it draws *Supporting since …* after
 * its first round trip rather than instantly: the status and the date arrive with the token.
 *
 * **Sync now is drawn only once this device is entitled**, which is `DeviceRow`'s rule about
 * the missing Remove button in a friendlier case: `sync_now` with no entitlement answers `null`
 * rather than refusing, so the press would be harmless — and a control that can only ever report
 * "there was nothing to do" is a control that teaches a reader to distrust it. On a `grace`
 * membership it *is* drawn, and that is the whole of §7.2 in one control: the card is being
 * retried, so the sync still works.
 *
 * **So the gate is `entitled` OR `paired`, and the second half is what breaks a circle.** A
 * device that has just paired holds no `supporter_status` until its first round trip — spec
 * §2.2's one-sync window — so `entitled` is false; and `ipc.syncNow` is `client::run_once`'s
 * **only** caller in the app, with no launch sync and no timer behind it. Gated on `entitled`
 * alone, the one press that would entitle the device is the one press it cannot reach, and the
 * second device sits on *Connect Patreon* for ever. That is the reader's own bug reproduced one
 * step further along, which is what makes the extra clause load-bearing rather than generous.
 *
 * **A paired device always has a trip worth making**, whatever its membership says: it may be
 * behind a key rotation, it may be owed a baseline, and — the case this is for — it may be
 * entitled through its group and not know yet. A device in **no** group and with no membership
 * still sees nothing, because there `run_once` genuinely answers `null` and a control that can
 * only ever report "there was nothing to do" teaches a reader to distrust it.
 *
 * **The press is still the fallback rather than the mechanism** — `SyncPanel`'s own completed-
 * pairing effect fires `ipc.syncNow().catch(() => undefined)` the moment the poll notices
 * `"complete"`, on both sides of a pairing, so the ordinary reader still never has to press
 * anything here. What changed is where that trip is driven from: it used to hang off the
 * `complete` mutation's own `.then()`, and now the relay carries the accept and the sealed key,
 * so there is no such mutation left to hang it off — the poll's own effect is what drives it
 * instead, and swallows its failure the same way the old code did.
 *
 * **`live` is a prop rather than a second `useDeviceSyncLive()` call here**, so that this
 * component and `SyncPanel` around it agree about the socket's state on the same render — the
 * hook's own guard against a stale seed overwriting a real transition is per-call, not
 * per-process, so two independent subscriptions could momentarily disagree.
 */
function SupporterSection({ live }: { live: LiveState }): JSX.Element {
  const client = useQueryClient();
  /** The code the reader is pasting back from the relay's landing page. Cleared by a claim that
   *  worked, and deliberately not by one that was refused — a refused code may be retypable. */
  const [code, setCode] = useState("");
  /** The last round trip's report, kept until the next press. `undefined` is "no press yet" and
   *  `null` is the backend's own "there was nothing to do", which are different sentences. */
  const [outcome, setOutcome] = useState<RelayOutcome | null | undefined>(undefined);

  const read = useQuery({ queryKey: RELAY_KEY, queryFn: () => ipc.syncRelayStatus() });
  const status: RelayStatus | null = read.data ?? null;

  const supporterRead = useQuery({
    queryKey: SUPPORTER_KEY,
    queryFn: () => ipc.syncSupporterStatus(),
  });
  const supporter: SupporterStatus | null = supporterRead.data ?? null;
  const membership = supporterState(supporter);

  const connect = useMutation({
    // **Both halves in one `mutationFn`, so a browser that refuses to open is a refusal this
    // panel reports.** Split across `onSuccess` the open would be a floating promise, and the
    // press would look like it had worked while nothing happened on screen or off it.
    mutationFn: async () => {
      await openExternal(await ipc.syncPatreonBegin());
    },
  });

  const claim = useMutation({
    mutationFn: (pasted: string) => ipc.syncPatreonClaim(pasted),
    onSuccess: (next) => {
      client.setQueryData(SUPPORTER_KEY, next);
      setCode("");
      // A claim founds a group of one if this device is in none, and switches sync on either
      // way, so both of the other reads on this panel are stale the moment it answers.
      void client.invalidateQueries({ queryKey: RELAY_KEY });
      void client.invalidateQueries({ queryKey: PAIRING_KEY });
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
  const state = relayState(status, membership, syncing, sync.isError);
  // One clock for the whole render — `CombosPanel`'s rule and its reason: a settings panel that
  // repainted on a timer to keep a relative date current would be motion without information,
  // and `react-hooks/purity` refuses a bare `Date.now()` in a render body.
  const note = relayNote(state, status, nowSeconds());
  const liveText = liveNote(live);
  /** Connected enough for the relay to answer: `grace` counts, which is §7.2's whole point. */
  const on = membership === "active" || membership === "grace";
  /**
   * Whether to offer a round trip: entitled, **or merely paired**.
   *
   * See this component's doc for why the second half exists — a freshly paired device is not
   * entitled until it has synced once, and this button is the only thing in the app that syncs.
   * `RelayStatus.paired` rather than the pairing query, because this half of the panel already
   * reads it and a second source for one fact is a second thing to disagree.
   */
  const canSync = on || status?.paired === true;
  /** The two states with a press to offer. `unknown` has none — a Connect button drawn over an
   *  unanswered read is one a connected reader would see flash on every visit. */
  const offering = membership === "never" || membership === "ended";
  const submit = () => {
    if (code.trim() !== "" && !claim.isPending) claim.mutate(code.trim());
  };

  return (
    <div className="space-y-3 border-t border-border pt-4">
      <h3 className="font-heading text-sm leading-none">Membership</h3>

      <p className="text-sm text-dim">
        Your devices hand changes to each other through one small server. It never gets the key
        the group shares, so what it holds is unreadable to it &mdash; which is why none of this
        needs an account with the server itself. What it does need is somebody to pay for it, so
        it is open to supporters on Patreon.
      </p>

      {/* **No controls at all while the read is unanswered**, which is the pairing half's rule
          one rung up and is load-bearing here rather than tidy: a Connect Patreon button drawn
          over an answer nobody has yet is one a supporter sees flash on every visit to this
          page, and it invites a second claim that would be refused. */}
      {supporter === null ? (
        <p className="text-sm text-dim">
          {supporterRead.isError
            ? "Your membership could not be read."
            : "Reading your membership…"}
        </p>
      ) : (
        <div className="space-y-3">
          <p className="text-sm">{supporterNote(membership, supporter)}</p>

          {membership === "ended" && <p className="text-sm text-dim">{LAPSE_REASSURANCE}</p>}

          {offering && (
            <div className="space-y-3">
              <p className="text-sm text-dim">{CONNECT_ORDER}</p>

              <button
                type="button"
                onClick={() => connect.mutate()}
                disabled={connect.isPending}
                className={cn(BUTTON, "border-accent text-accent hover:bg-bg")}
              >
                <Heart aria-hidden="true" className="size-4" />
                Connect Patreon
              </button>

              {/* **The re-claim warning, at the field that makes a re-claim** — spec §3, and
                  the placement is the claim rather than the paragraph's subject: pressing
                  Connect Patreon opens a browser and moves nothing, while pasting a code is the
                  write that re-binds. Above the field rather than under it, so it is read on the
                  way to the press instead of after it. */}
              <p className="text-sm text-dim">{RECLAIM_WARNING}</p>

              <div className="space-y-1">
                {/* A written `id` rather than `useId()`, `SettingsSection`'s rule: a generated
                    `:r7:` moves with the render order of the page, and these are readable in
                    the shipped window. */}
                <label htmlFor="patreon-claim" className="block text-[0.6875rem] text-dim">
                  Claim code
                </label>
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    id="patreon-claim"
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") submit();
                    }}
                    spellCheck={false}
                    autoComplete="off"
                    placeholder="XXXX-XXXX-XXXX"
                    className={cn(
                      "h-8 min-w-0 flex-1 rounded-md border border-border bg-bg px-2.5",
                      // A code is data, and data is Geist Mono — the role prices, versions and
                      // collector numbers already carry in this window.
                      "font-mono text-xs tracking-[0.1em] uppercase",
                      "focus:border-accent focus:outline-none",
                    )}
                  />
                  {/* `aria-disabled` and a no-op handler, not `disabled`: this button greys as
                      the reader *types*, and the app's rule is that such a control keeps its
                      place in the tab order rather than vanishing from under a caret. */}
                  <button
                    type="button"
                    aria-disabled={code.trim() === "" || claim.isPending}
                    onClick={submit}
                    className={cn(
                      BUTTON,
                      "border-border hover:bg-bg",
                      code.trim() === "" && "cursor-not-allowed opacity-50 active:scale-100",
                      FOCUS,
                    )}
                  >
                    Connect
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* **An unanswered relay read is not "nothing is waiting".** The two reads are separate
          queries over one write connection, so a refused one leaves `status` null while the
          membership answers perfectly — and "Nothing is waiting to go." over an answer nobody
          has is the pairing half's blank-field trap in a sentence. */}
      {on && (
        <p className="text-sm text-dim">
          {status === null
            ? read.isError
              ? "What is waiting to go could not be read."
              : "Reading the relay…"
            : status.pending === 0
              ? "Nothing is waiting to go."
              : `${plural(status.pending, "change")} waiting to go.`}
        </p>
      )}

      {/* **`liveText !== null` on top of `on`, not `on` alone.** `liveNote` says nothing for
          three of its four states, and this panel's other `on`-gated line above always has a
          sentence to draw — so gating on `on` alone would open an empty paragraph, spending the
          `space-y-3` gap either side of it, on every visit where the socket is doing its job. */}
      {on && liveText !== null && <p className="text-sm text-dim">{liveText}</p>}

      <div className="flex flex-wrap items-center justify-between gap-3">
        {/* `min-w-0` so the sentence gives way rather than the button: a flex item cannot shrink
            below its own min-content unless it is told it may. */}
        <p className="min-w-0 flex-1 text-sm text-dim">{note}</p>
        {canSync && (
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
          happen. One line, because only one of the three is ever in flight here. */}
      <PanelAlert tone="problem">
        {connect.error
          ? ipcError(connect.error)
          : claim.error
            ? ipcError(claim.error)
            : sync.error
              ? ipcError(sync.error)
              : null}
      </PanelAlert>
    </div>
  );
}

/**
 * Pairing: what this device is, which group it is in, and how another device joins it.
 *
 * **The six digits are still the whole security argument.** Both readers are shown the same
 * number in the same size and the offering device cannot move past it without saying so: its
 * *Codes match* button carries `aria-disabled` until the digits exist, and its handler refuses
 * the press until they do too. A panel that advanced on its own would look completely normal
 * and defend nothing.
 *
 * **Only the invite is carried by hand now.** The relay carries the accept and the sealed group
 * key — the two blobs a reader used to retype between the two screens, one of them 224
 * characters and one of them the hard phone→PC direction — so this panel learns both by polling
 * {@link ipc.syncPairingPoll} rather than by waiting on a paste. What is still hand-carried is
 * the code or QR that starts the exchange, because that is the one thing neither device can
 * already see: it names *which* pairing session to join. The QR now encodes a URL the joining
 * device's camera app can open directly, not a bare number it would have to be typed in or
 * googled.
 *
 * **Only the offering device gets a *Codes match* button, and that is correct rather than an
 * oversight.** Under a man-in-the-middle the two screens show different numbers, so the
 * comparison is inherently a two-screen act; the press that matters is the one gating release of
 * the group key, and that is the offering device's press alone. The joining device's screen says
 * so instead of drawing a second button that would do nothing.
 *
 * **{@link SupporterSection} is the second half**, under a rule of its own: the membership
 * that unlocks the relay, what is waiting, and the one press that makes a round trip now. It is a separate query and a
 * separate set of presses — the two halves share only the `["sync"]` root, which is what makes
 * a finished trip refresh the roster as well as the figures.
 *
 * **This panel reaches the backend itself**, where four of its neighbours take their state as a
 * prop — `BackupPanel`'s argument exactly: nothing else in the window reads `sync_pairing_status`,
 * so `SettingsPage` would be holding a hook only to hand its answer straight back down.
 *
 * **This is also the second call to `useDeviceSyncLive()` in the app, and that is fine** —
 * `AppShell`'s own is the app-lifetime one the hook's doc warns about, and this one is
 * panel-scoped: it unmounts, and takes its `sync:live` listener with it, the moment the reader
 * leaves Settings. {@link liveNote} needs the same {@link LiveState} the ribbon's marker draws,
 * and prop-drilling it down through `SettingsPage` was rejected: that page reaches nothing else
 * in this window and would only be holding a hook to hand its answer straight back down, which
 * is worse than a bounded second subscription — one listener for as long as this page is open,
 * never for the life of the process.
 */
export function SyncPanel(): JSX.Element {
  const client = useQueryClient();
  const live = useDeviceSyncLive();
  const [flow, setFlow] = useState<Flow>({ kind: "idle" });
  const [removing, setRemoving] = useState<PairedDevice | null>(null);
  /** The Leave dialog is open. A bare boolean where {@link removing} carries a device, because
   *  the device leaving is always this one — there is nothing to name. */
  const [leaving, setLeaving] = useState(false);
  /**
   * The one line a finished pairing leaves behind. Neither {@link Flow} nor a mutation's own
   * state survives the return to `"idle"` that draws it, so it needs a home of its own — cleared
   * the moment a *new* pairing starts, so a second pairing never opens under the first one's
   * success line.
   */
  const [pairedNote, setPairedNote] = useState<string | null>(null);
  /**
   * The one line an attempt that ended *without* pairing leaves behind — {@link EXPIRED_NOTE}.
   *
   * Its own state rather than {@link pairedNote}'s, because the two are drawn in different tones
   * and one must never be mistaken for the other: a reader who reads *Paired.* after a timeout
   * would go looking for a device that is not in the group. It is cleared wherever a new attempt
   * starts, so a second attempt never opens under the first one's obituary.
   */
  const [endedNote, setEndedNote] = useState<string | null>(null);
  /**
   * Guards the completed-pairing effect below so its two side effects — the sync trip and the
   * cache invalidation — fire **exactly once** per pairing, not once per render while the poll
   * goes on answering `"complete"` (it keeps answering that until `enabled` below actually turns
   * it off). A ref rather than `useState`, `usePopupPlacement`'s reason exactly: a write in here
   * must be readable from inside the effect without becoming a second `setState` for the lint
   * rule to flag, and this value is never drawn. Reset wherever a *new* pairing starts.
   */
  const completedRef = useRef(false);

  const read = useQuery({ queryKey: PAIRING_KEY, queryFn: () => ipc.syncPairingStatus() });
  const status: PairingStatus | null = read.data ?? null;

  const refresh = () => void client.invalidateQueries({ queryKey: PAIRING_KEY });

  /**
   * Everything a *new* pairing attempt has to forget before it starts, so it can never read a
   * previous attempt's answer. Called from both `begin`'s and `accept`'s `onMutate` — the two
   * places an attempt actually starts, whichever side of it this device is on (`accept` covers
   * the scan path too: `QrScanner`'s `onCode` and the typed-code `Paste` both call it).
   *
   * **`removeQueries` on `PAIRING_POLL_KEY` is the one that matters and the one the first pass
   * of this fix was missing.** A *disabled* query keeps its last-fetched `data` sitting in the
   * cache rather than clearing it — so a second pairing in one session re-enables the very same
   * query key, and the render that follows reads the *previous* pairing's cached answer, because
   * a synchronous cache read cannot wait on the fresh fetch's promise to resolve. Two render-time
   * blocks above read that cache, and a stale read breaks both: the `"complete"` one would settle
   * a just-opened offer screen straight back to `"idle"` before it ever painted, and the
   * `"compare"` one could prefill a brand-new offer with an *old* six-digit code — right at the
   * moment the reader is asked to trust that number against the other screen. `exact: true`
   * scopes the removal to this one key rather than TanStack's default partial match — nothing
   * else is nested under it today, but this is a cache the panel must never over-clear by
   * accident, and `refresh()` above already owns invalidating `PAIRING_KEY` itself.
   */
  const startNewAttempt = () => {
    setPairedNote(null);
    setEndedNote(null);
    completedRef.current = false;
    client.removeQueries({ queryKey: PAIRING_POLL_KEY, exact: true });
  };

  const begin = useMutation({
    mutationFn: () => ipc.syncPairingBegin(),
    onMutate: startNewAttempt,
    onSuccess: (offer) => setFlow({ kind: "offer", offer, sas: null }),
  });
  const accept = useMutation({
    mutationFn: (code: string) => ipc.syncPairingAccept(code),
    onMutate: startNewAttempt,
    onSuccess: (shake) => setFlow({ kind: "join", sas: shake.sas }),
    /**
     * **A refused `accept` from the camera has to leave the reader something to press.**
     * `QrScanner` stops its tracks the moment it decodes, and its effect has `[]` deps, so a
     * scan whose `accept` then fails — a 409 on a code somebody else answered, a bent code, an
     * unreachable relay — leaves a frozen frame under *Point the camera at the code* with the
     * error sentence below it and nothing that starts the camera again. The paste path has
     * always left its box on screen for a second try; this gives the scan path the same box.
     *
     * **Remounting the scanner instead was the other candidate and is worse.** The camera would
     * come straight back up pointed at the same QR code, decode it again within a frame or two,
     * and call `accept` again — a request loop against the relay for exactly the failure
     * (`ALREADY_USED`) that a retry can never fix. Stepping back to the typed box is the state
     * a reader can act from, and *Scan a code* is one Cancel away.
     */
    onError: () => setFlow((f) => (f.kind === "scanning" ? { kind: "reading" } : f)),
  });
  /**
   * The reader says the digits matched. Answers nothing the reader carries any more — the relay
   * is what moves the sealed key from here, and this device learns the pairing is done from the
   * poll below rather than from this mutation's own result.
   */
  const confirm = useMutation({
    mutationFn: () => ipc.syncPairingConfirm(),
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
  const leave = useMutation({
    mutationFn: () => ipc.syncGroupLeave(),
    onSuccess: () => {
      setLeaving(false);
      // **`SYNC_KEY` rather than `refresh()`, and the difference is the membership.** Leaving
      // runs `entitlement::clear` as well as `identity::leave_group` (spec §2.3), so the
      // supporter block and the relay figures are as stale as the roster the moment this
      // answers — `paired` goes false, *Sync now* leaves with it, and the block below has to
      // stop saying *Supporting*. All three sit under this root, which is the completed-pairing
      // effect's argument below, one press over.
      void client.invalidateQueries({ queryKey: SYNC_KEY });
    },
  });

  /**
   * Where an in-flight pairing has got to. **`staleTime: 0`**, against `query.ts`'s 30 s
   * default — a poll answering from cache would sit on `"waiting"` after the other device had
   * already moved on, for up to half a minute. Enabled only while there is a session on the
   * backend to poll: `"reading"` and `"scanning"` have not reached it yet (nothing has been
   * accepted), and `"idle"` has nothing running.
   */
  const polling = flow.kind === "offer" || flow.kind === "join";
  const poll = useQuery({
    queryKey: PAIRING_POLL_KEY,
    queryFn: () => ipc.syncPairingPoll(),
    enabled: polling,
    refetchInterval: 1500,
    staleTime: 0,
  });

  /**
   * The offering device's digits, filled in during render rather than in an effect.
   *
   * **This is React's own "adjust state while rendering" recipe, not a `useEffect`** —
   * `useDelayedFlag`'s shape and its reason: `flow.sas` is computable from `poll.data` the
   * instant both are in scope, so writing it from an effect would be a synchronisation for
   * something render can settle itself, and `react-hooks/set-state-in-effect` refuses the
   * functional-updater form that would otherwise read `flow` back out of its own setter. The
   * guard (`flow.sas === null`) is what keeps this from looping: the write below changes
   * `flow.sas` to non-null on the very re-render it causes, so the condition is false the next
   * time through.
   */
  if (flow.kind === "offer" && flow.sas === null && poll.data?.stage === "compare") {
    const sas = poll.data.sas;
    if (sas !== null) setFlow({ ...flow, sas });
  }

  /**
   * The pairing's own end — also settled during render, for the same reason as the digits
   * above: ending the flow and posting the success line are both React state and nothing
   * external, so both belong here rather than in the effect below. **`polling` is the guard
   * that stops this looping**: it reads `flow.kind`, which the write just changed to `"idle"`,
   * so the condition is false on the render right after.
   */
  if (polling && poll.data?.stage === "complete") {
    setFlow({ kind: "idle" });
    setPairedNote("Paired. The other device is now part of this group.");
  }

  /**
   * The pairing's other end: the attempt ran out of time. Settled during render for the two
   * blocks above's reason — a flow and a sentence are both React state and nothing external.
   *
   * ⚠️ **`"expired"` and deliberately *not* `"idle"`, which was the other candidate.** `idle` is
   * what the backend answers for anything that is not in flight — including the moment right
   * after a **cancel**, whose own `onSettled` has not landed yet, and the poll that follows an
   * expiry this block has already handled. Reading it as the timeout would put *That pairing code
   * timed out* in front of a reader who had just pressed Cancel, which is a sentence about
   * something that did not happen. So the reason is a stage of its own: `poll` answers it exactly
   * once, on the call that crosses the ten minutes, and one answer is enough because a mounted
   * enabled query renders every answer it gets — the old expiry was invisible because it was an
   * *error* that the query's own retry then overwrote, not because a stage could be missed.
   *
   * `polling` is the loop guard, exactly as above: it reads `flow.kind`, which this write has
   * just changed to `"idle"`.
   */
  if (polling && poll.data?.stage === "expired") {
    setFlow({ kind: "idle" });
    setEndedNote(EXPIRED_NOTE);
  }

  useEffect(() => {
    // **The two things that genuinely have to be an effect**: `invalidateQueries` and
    // `syncNow` are both writes outside this component (a cache, and a round trip to the
    // relay), which render must never do. Nothing here calls a `useState` setter, so
    // `react-hooks/set-state-in-effect` has nothing to flag — `completedRef` is a ref, not
    // state, and it is what stops this firing twice: the poll goes on answering `"complete"`
    // until `enabled` above actually turns it off, and this effect's own dependency
    // (`poll.data`) can therefore run its body more than once for the same completed pairing.
    if (poll.data?.stage !== "complete" || completedRef.current) return;
    completedRef.current = true;
    // `PAIRING_KEY` rather than `SYNC_KEY`: what this side of the panel promises is the
    // roster, and that is what a finished pairing changed. The membership and the relay
    // figures are `SupporterSection`'s own reads.
    void client.invalidateQueries({ queryKey: PAIRING_KEY });
    // **The trip a completed pairing still owes.** A device that has just joined holds the
    // group key and none of the group's data; the offering device wants the joiner's own rows
    // — so both sides fire this, not just the joiner. Swallowed rather than surfaced: the
    // pairing genuinely succeeded, and a failed first sync must not turn that success into an
    // error banner over a ceremony that completed. `error_log` already has the reason if there
    // is one, and *Sync now* below is the retry — one press, not a failure to explain here.
    void ipc.syncNow().catch(() => undefined);
  }, [poll.data, client]);

  /**
   * Whichever press last refused — or, now, whichever *poll* did. One line, because only one
   * thing is ever in flight here.
   *
   * **`poll.error` sits right after `begin`/`accept`, ahead of `confirm` and the roster
   * mutations.** `begin` and `accept` are how an attempt can fail to *start*; `poll` is that same
   * attempt failing *while it is running* — an unreachable relay, or a rendezvous answer that
   * will not parse. That is a more fundamental failure than a stale `confirm` refusal from
   * earlier in the same attempt, so it is asked first. It is **not** swallowed, unlike the
   * `syncNow` rejection in the effect above: that one hides a harmless failure *after* a success,
   * and this is the only signal the reader gets that the thing they are waiting for is never
   * coming. `Cancel` stays rendered on both those screens regardless of this line, which is what
   * stops the sentence stranding anyone: reading it still leaves a press that gets back to
   * `idle`.
   *
   * ⚠️ **The ten-minute expiry is not one of these and used to be.** `pairing::poll` answered
   * `Err(EXPIRED)` and cleared the pending offer in the same breath, so the refusal was exactly
   * one call long — and this query inherits `query.ts`'s `retry: 1`, so TanStack re-ran it a
   * second later, found nothing in flight and answered `Ok(idle)`. `poll.error` was never
   * populated for the expiry case at all: at ten minutes nothing on screen changed and the panel
   * polled a dead rendezvous for ever. It is a `"expired"` **stage** now, settled by the block
   * above into {@link EXPIRED_NOTE}, because a stage survives a retry where the absence of an
   * answer does not.
   */
  const error =
    begin.error ??
    accept.error ??
    poll.error ??
    confirm.error ??
    rename.error ??
    revoke.error ??
    leave.error ??
    null;

  const paired = status !== null && status.groupId !== null;

  // **`status.devices` is the devices still in the group, and this panel does not check.**
  // `pairing::status` filters `revoked_at` out before answering, and the Storybook fake filters
  // the same way because it exists to mimic that command — one contract, two implementations,
  // which is the arrangement the whole workbench runs on. A third filter here would be the
  // consumer re-deriving its own input's contract, and three copies of one rule is what drifts:
  // the layer that stopped filtering would be covered by the other two until all three were
  // wrong. `sync_devices` still keeps the removed row — `add_device` clears the mark on a
  // re-pair, `baseline::peers_needing` reads it to skip a peer that will never answer — but that
  // is the backend's record and never reaches this list.

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
        sitting in between joining the group, so it is the one step that is never skipped. The
        other device needs to be online too, now that pairing goes through the relay rather than
        being carried between the two screens by hand.
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
                onClick={() => {
                  setPairedNote(null);
                  setEndedNote(null);
                  setFlow({ kind: "reading" });
                }}
                className={cn(BUTTON, "border-border hover:bg-bg")}
              >
                Enter a code from another device
              </button>
              <button
                type="button"
                onClick={() => {
                  setPairedNote(null);
                  setEndedNote(null);
                  setFlow({ kind: "scanning" });
                }}
                className={cn(BUTTON, "border-border hover:bg-bg")}
              >
                Scan a code
              </button>
              {/* **Drawn on a paired device and on no other**, which is `DeviceRow`'s missing
                  Remove one rung up and the same rule: `leave_group_now` refuses a device in no
                  group in as many words, and a press that can only ever be refused is worse than
                  no press at all.

                  **Beside the two pairing presses rather than on the roster.** Leaving is not a
                  row's action — the row for this device is the one row that has no Remove — it
                  is the group's, and this is the row where the group's presses live.

                  `text-dim` and no accent: this is `Cancel`'s treatment, for a press that steps
                  back where its two neighbours step forward. The red belongs to the dialog's own
                  confirm button, exactly as Remove's does. */}
              {paired && (
                <button
                  type="button"
                  onClick={() => setLeaving(true)}
                  className={cn(BUTTON, "border-border text-dim hover:bg-bg")}
                >
                  <LogOut aria-hidden="true" className="size-4" />
                  Leave group
                </button>
              )}
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

          {/* `QrScanner` draws its own Cancel — the same button this file's `Cancel` is, one
              component over — so nothing is added beside it here. `onCode` runs the same
              `accept.mutate` the paste box above does: `Invite::decode` on the Rust side takes
              both the bare code and the `https://…/pair#<code>` URL form, so no parsing happens
              in this file for either path. */}
          {flow.kind === "scanning" && (
            <div className="space-y-3 rounded-md border border-border p-3">
              <QrScanner
                onCode={(code) => accept.mutate(code)}
                onCancel={() => cancel.mutate()}
              />
            </div>
          )}

          {flow.kind === "offer" && (
            <div className="space-y-3 rounded-md border border-border p-3">
              {/* **The QR and the typed code are `"waiting"`'s alone, and gone the moment
                  `"compare"` starts.** Once the other device has accepted, the invite has done
                  its one job — the pairing is now mid-handshake — and a code still sitting on
                  screen suggests that step is somehow still live. It also invites a bystander to
                  scan an offer already spoken for, which `ALREADY_USED` would refuse, but the
                  screen's own job here is clarity rather than that refusal. */}
              {flow.sas === null ? (
                <>
                  <p className="text-sm">
                    Point the other device&rsquo;s camera at this, or type the code into it.
                  </p>
                  <div className="flex flex-wrap items-start gap-3">
                    <QrCode matrix={flow.offer.qr} label="Pairing code as a QR code" />
                    <p className="min-w-0 flex-1 font-mono text-xs leading-relaxed break-all">
                      {flow.offer.code}
                    </p>
                  </div>
                  <p className="text-sm text-dim">Waiting for the other device&hellip;</p>
                </>
              ) : (
                <div className="space-y-2">
                  <p className="text-sm">
                    Both devices should now be showing these six digits. Check them against the
                    other screen before you go on.
                  </p>
                  <Digits sas={flow.sas} />
                </div>
              )}

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
                    Nothing to compare yet &mdash; still waiting for the other device.
                  </span>
                )}
                <Cancel onCancel={() => cancel.mutate()} />
              </div>
            </div>
          )}

          {/* **The joining side draws no Codes match button, and that is deliberate rather than
              missing.** Under a man-in-the-middle the two screens show different numbers, so the
              comparison is inherently a two-screen act — and the press that actually gates
              anything is the offering device's, since that is the press that releases the group
              key. This screen's whole job is to tell the reader where that press is. */}
          {flow.kind === "join" && (
            <div className="space-y-3 rounded-md border border-border p-3">
              <p className="text-sm">
                The other device should now be showing these six digits too. Check them against
                that screen.
              </p>
              <Digits sas={flow.sas} />
              <p className="text-sm text-dim">
                Compare these with the other device, then press Codes match there.
              </p>
              <Cancel onCancel={() => cancel.mutate()} />
            </div>
          )}
        </>
      )}

      <PanelAlert tone="plain">{pairedNote}</PanelAlert>
      {/* **One problem line, and a live refusal outranks the obituary.** `error` is whatever
          just failed; `endedNote` is an attempt that quietly ran out of time. Both are the same
          kind of thing to a reader — *the thing you were doing is not happening* — so they share
          a box rather than stacking two red sentences, and the fresher one wins. */}
      <PanelAlert tone="problem">{error ? ipcError(error) : endedNote}</PanelAlert>

      <SupporterSection live={live} />

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

      {/* **`confirmLabel` is deliberately not the trigger's own words.** Two buttons reading
          *Leave group* — one on the panel, one in the dialog over it — is an ambiguity for a
          reader scanning back to check what they pressed, and for every `getByRole` that has to
          tell them apart. Remove's pair makes the same split (*Remove Phone* / *Remove device*).

          `typeToConfirm={false}`, which is this dialog's documented rule rather than laxness:
          the word is for a clear whose subject is the reader's only copy of something, and
          leaving deletes nothing at all — a typed word here would teach readers to type it
          without reading the sentence, which is what would make it useless on the clears that
          need it. */}
      <ConfirmDialog
        open={leaving}
        title="Leave this group?"
        confirmLabel="Leave the group"
        typeToConfirm={false}
        pending={leave.isPending}
        onConfirm={() => leave.mutate()}
        onDismiss={() => setLeaving(false)}
        onClose={() => setLeaving(false)}
      >
        {LEAVE_WARNING}
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
