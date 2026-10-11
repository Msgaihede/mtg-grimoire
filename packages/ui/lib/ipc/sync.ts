/**
 * Sync: a run and its status, live sync, pairing a device, the relay and the membership, and the review of what another device wrote.
 *
 * **One domain of `../ipc.ts`, split out on 2026-10-11 (issue #557).** Nothing outside
 * `packages/ui/lib/ipc*` imports this file: every page, hook, story and test goes through
 * `@/lib/ipc`, which re-exports these types and spreads `syncCommands` into `ipc`. That is what keeps
 * `vi.mock("@/lib/ipc", …)` the one seam a suite replaces — a component that imported a wrapper
 * from here would go around every mock in the repository. ESLint refuses the import, and
 * `ipc.test.ts` reads this file with its siblings, so the struct-parity and argument-name fences
 * cover it as they covered the single file.
 */
import { core } from "@/lib/core";
import { invoke, type Unlisten } from "./invoke";

/**
 * Result of a sync run.
 *
 * `updatedAt` is not a companion of `updated`: Scryfall can serve a bulk listing with
 * no `updated_at` at all, which is stored as absent and comes back `null` even though
 * cards were ingested. Read the two independently.
 */
export interface SyncOutcome {
  updated: boolean;
  cardCount: number;
  updatedAt: string | null;
}

/**
 * What the UI polls.
 *
 * `dataDir`, `syncing` and `imageStoreFailures` are always answered — none of them needs
 * the database. The five database-derived fields are `null` only when the read-only
 * connection could not be used at all; an ingest no longer blanks them. `null` there means
 * "not readable right now", never "zero" and never "cleared": a UI that renders it
 * literally reports an empty collection and throws away an error banner the user has not
 * read yet. See `mergeStatus` in `useSync.ts`, which is the one place that resolves this.
 */
export interface SyncStatus {
  cardCount: number | null;
  /** Unix seconds, as a string. */
  lastCheckAt: string | null;
  /** Scryfall's timestamp for the ingested bulk file, ISO-8601. */
  bulkUpdatedAt: string | null;
  /** Why the last run failed, still readable long after its event was dropped. */
  lastError: string | null;
  /**
   * Lines the last ingest could not read as cards (spec §8 requires the count be
   * surfaced, not swallowed). `null` before any ingest has run — which is not the same
   * as `0`, "the last ingest skipped nothing".
   */
  lastIngestSkipped: number | null;
  dataDir: string;
  syncing: boolean;
  /**
   * Card images this process fetched and then could not write to the cache — a read-only
   * data folder, a full disk. A number, never `null`: it is a counter in memory rather
   * than a database read, and the disk that would make the rest unreadable is the very
   * thing it reports on. Resets with the app.
   *
   * Non-zero is worth telling the reader about because nothing else shows it: the images
   * still display (the bytes were in hand), they are simply never cached, so the only
   * visible symptom is a grid that re-downloads itself forever.
   */
  imageStoreFailures: number;
}

/** The phases `sync.rs` emits, and the only values `SyncProgressEvent.phase` takes. */
export type SyncPhase =
  | "checking"
  | "downloading"
  | "ingesting"
  | "reclaiming"
  | "sets"
  | "compacting"
  | "done"
  | "error";

/**
 * Payload of the `sync:progress` event.
 *
 * Not a complete account of a sync: a run throttled by the 24 h check window emits
 * nothing at all, and events emitted before the webview registered its listener are
 * dropped by Tauri. Progress is the fast path; `SyncStatus` is the reliable one.
 */
export interface SyncProgressEvent {
  phase: SyncPhase;
  done: number;
  total: number;
  message: string | null;
}

/**
 * What the relay socket is doing. Mirrors `LiveState` in
 * `crates/grimoire-core/src/sync_engine/live.rs`.
 *
 * `"off"` is not a failure — it is every installation that has connected no membership and
 * paired no device, which is all of them until somebody does.
 */
export type LiveState = "off" | "connecting" | "live" | "offline";

/** Payload of the `sync:live` event. */
export interface SyncLiveEvent {
  state: LiveState;
}

/**
 * Payload of `collection:reconciled` — what one pass of Scryfall's id-migration log did to
 * the user's own rows (`sync::reconcile_ids`, from `reconcile::ReconcileStats`).
 *
 * Emitted **only when something moved**: a pass that skipped every already-applied
 * migration, which is every pass after the first, is silent. So the event's arrival is the
 * fact worth acting on, and the three numbers are for a message about it.
 */
export interface ReconciledEvent {
  /** Rows whose `card_id` was moved to the id Scryfall merged the old one into. */
  repointed: number;
  /** Rows that collided with an existing one at the new id and became one row. */
  folded: number;
  /** Rows that could be neither repointed nor folded, and now carry a sentence. */
  flagged: number;
}

/**
 * A QR code as a grid, row-major, `width * width` long. `true` is a dark module.
 *
 * **A fact rather than a picture, which is why it crosses the boundary in this shape.** Rust
 * answers what the encoder produced; this side decides the colour, the module size and the
 * quiet zone, because all three are questions about a screen.
 */
export interface QrMatrix {
  width: number;
  modules: boolean[];
}

/** One device on the pairing roster. The public key is deliberately not sent. */
export interface PairedDevice {
  deviceId: string;
  name: string;
  addedAt: number;
  /**
   * A stamp means this device was removed.
   *
   * **The row is kept and the panel does not draw it.** `add_device` clears the stamp on a
   * re-pair and `baseline::peers_needing` reads it to skip a peer that will never answer, so the
   * roster keeps the mark for the crate's sake — not so a reader can be shown history they asked
   * to be rid of. It stays on this type because the column is still on the wire.
   */
  revokedAt: number | null;
}

/** What Settings draws when no pairing is in flight. `groupId` is null on an unpaired device. */
export interface PairingStatus {
  deviceId: string;
  deviceName: string;
  groupId: string | null;
  epoch: number | null;
  devices: PairedDevice[];
}

/** The invite, in both forms. */
export interface PairingOffer {
  code: string;
  qr: QrMatrix;
}

/**
 * The six digits to compare.
 *
 * **The digits are what the reader compares and the whole of what defeats a man in the middle**
 * (spec §7.5 step 3), so the panel must never auto-advance past them.
 */
export interface PairingHandshake {
  sas: string;
}

/** The wrapped group key, for the reader to carry to the joining device. */
export interface PairingSealedKey {
  sealedKey: string;
}

/** What `sync_pairing_poll` answers. `stage` drives the panel and nothing else does. */
export interface PairingProgress {
  /**
   * `"idle" | "waiting" | "compare" | "complete" | "expired"`
   *
   * **`"expired"` is an answer and not an error**, which is what makes the ten-minute timeout
   * reach the reader at all: the command clears its pending offer as it answers, so a refusal
   * would have been one call long and this query's `retry: 1` overwrote it with the next call's
   * `"idle"`. See `SyncPanel`'s `EXPIRED_NOTE`.
   */
  stage: string;
  /** The six digits, once both sides have them. */
  sas: string | null;
}

/**
 * What the Sync panel draws about the relay.
 *
 * **There is no `relayUrl` here and there is no longer a field to type one into.** The relay is
 * one hosted Worker whose address is compiled into the crate, so "sync is off" stopped being
 * *no URL* and became *no entitlement* — {@link SupporterStatus} is the field that answers it,
 * and this struct is only ever about what is waiting and how the last trip went.
 *
 * **There is no last-failure field either, and its absence is the change rather than an
 * omission.** It carried the newest `error_log` row with `source = 'relay'` — a row the Errors
 * panel further down the same page already draws — so one failure was rendered twice, in two
 * registers, under two headings. The record is untouched: the crate still logs every relay
 * failure, and this struct simply stops answering for it.
 */
export interface RelayStatus {
  paired: boolean;
  /** Changes this device has written and not yet handed over. */
  pending: number;
  /** Unix seconds, or null when no round trip has ever finished. */
  lastSyncAt: number | null;
  /** Rows carrying a `needs_review` sentence, across all six tables that can hold one. */
  reviewCount: number;
  /**
   * Whether a pull is stuck, and on what — the `sync_state` key `pull_hold` read back for the
   * panel. `"newer"` is a peer running a build ahead of this one: it stamped an op with a
   * `schema` this device's own `USER_SCHEMA_VERSION` cannot clear, so nothing releases it but an
   * update, however many pulls or how much time pass. `"waiting"` is a peer's own ordinary
   * ordering — an op arrived before the parent it names, which a later pull carrying that parent
   * clears on its own, or is skipped after the bound (three pulls and ten minutes on the same
   * blocks) when that parent never comes — and `null` is the ordinary case, where nothing is held
   * at all, and always the answer on a device in no group. `"clock"` is a peer whose clock runs
   * ahead: it stamped ops more than a day (`hlc::MAX_AHEAD_MS`) past this device's wall clock, and
   * applying them would drag this device's hybrid logical clock into that future for good — so
   * they wait, with the cursor, until this device's own clock comes within a day of them. Like
   * `"newer"` it is the reader's to fix, on whichever device has the wrong date.
   */
  pullHeld: "newer" | "waiting" | "clock" | null;
}

/**
 * The membership that unlocks the relay, as this device last heard it.
 *
 * **`entitled` and `status` are two different questions and the panel must never fold them
 * into one.** `entitled` says the relay will mint this device a token; `status` is the relay's
 * own last word about the membership behind it. A device that has never connected and a reader
 * whose pledge has ended are both `entitled: false, status: "dead"`, and they get different
 * sentences: *Not connected* points at a button, *Membership ended* points at a
 * renewal and has to say that nothing local was touched (spec §7.1).
 *
 * **`groupBound` is what tells them apart, and `since` cannot.** `entitlement::revoke` deletes the
 * start date along with the refresh secret, so a lapsed membership and a device out of the box
 * both read `since: null` — the field that survives a lapse is `groupBound`, which says an
 * entitlement was once bound to this device's group. `supporterState` therefore asks `entitled`
 * first and `groupBound` second, and a build that keyed the two silences on `since` showed every
 * lapsed reader *Not connected*.
 *
 * ⚠️ **This interface is hand-written and nothing type-checks it against the crate**, which is
 * exactly how the rename below arrived as a runtime bug rather than a red build: the field was
 * called `connected` until spec §2.5, and a build that kept the old spelling compiled, passed
 * every test, read `undefined` in the shipped window and drew *Connect Patreon* at a paid-up
 * supporter on every device but one. Assert the field **by name** — `toEqual` over the whole
 * object, never `toMatchObject` on the fields that did not move.
 *
 * **`grace` is a third thing again, not a softer `dead`** (spec §7.2): a card Patreon is still
 * retrying, where tokens are still minted and sync keeps working. Drawing it as a cancellation
 * would punish a reader for something they did not decide.
 */
export interface SupporterStatus {
  /**
   * **The relay will mint this device a token** — spec §2.5, and the field was `connected`
   * until then.
   *
   * Renamed rather than redefined, because it stopped being one device's fact. "Connected"
   * meant *this device holds a refresh secret*; entitlement is the **group's**, since any
   * device in a group with a live membership can mint through `/token`'s group door holding no
   * Patreon-side secret at all. So the crate answers this as that secret **or** a stored
   * `SUPPORTER_STATUS` of `active`/`grace`, which is the relay having answered this device's
   * group auth.
   */
  entitled: boolean;
  /** `"active"`, `"grace"` or `"dead"`, as the relay last answered. */
  status: string;
  /** Unix **seconds** the membership began; null for never having been told one **and for one
   *  that has ended**, because `revoke` deletes the date with the secret. */
  since: number | null;
  /** An entitlement was bound to this device's pairing group — and it outlives a lapse, which
   *  is what makes it and not `since` the discriminator above. */
  groupBound: boolean;
}

/**
 * What one round trip did.
 *
 * The five counts after `unreadable` are `ApplyReport`'s, so a page can invalidate the right
 * query keys once rather than per op. `deferred` is the one worth reading twice, and its meaning
 * widened with the two holds below it: it is every op **held for re-delivery** — a newer-schema
 * group's held ops and their collateral, plus an ordinary peer's ops still waiting on a parent
 * that has not arrived — so `deferred - heldNewer` is the waiting half alone.
 *
 * `heldNewer` and `dropped` are new — a newer device's held ops named apart from `deferred`
 * because they have **no bound**: a waiting hold self-heals once its parent's pull arrives, where
 * a newer hold clears only when this device updates, however many pulls or how much time pass.
 * `dropped` is neither: an op consumed because it can never apply (its group is recorded once in
 * the error log, in the committed pass), which is a third and permanent outcome distinct from
 * both a hold that might still clear and `unreadable`'s envelope that never opened.
 *
 * The last two are the **first-contact baseline** (baseline spec §13). They are not part of
 * `pushed`: a baseline is built in memory and posted without ever entering `sync_ops`, so the
 * outbox count cannot see it. Both are zero on every sync after the first with a given peer,
 * which is every sync a reader ever presses but one.
 */
export interface RelayOutcome {
  pushed: number;
  pulled: number;
  unreadable: number;
  applied: number;
  resurrected: number;
  cyclesBroken: number;
  skipped: number;
  deferred: number;
  /**
   * Ops in groups held because a newer schema wrote them — this device cannot parse them yet.
   * Counted separately from the rest of {@link RelayOutcome.deferred} because it has no bound:
   * nothing releases it but updating this device, where the waiting half of `deferred` clears on
   * its own once the parent it is missing arrives on a later pull, or is skipped after the bound.
   */
  heldNewer: number;
  /**
   * Ops consumed because they could never apply — a table this build does not sync, a row it
   * cannot build, or a released wait — each group recorded once in the error log rather than
   * silently discarded. Distinct from `unreadable` (an envelope that failed to open), from a
   * hold (which might still clear), and from a moot child of a parent deleted here, which is
   * consumed too but neither counted here nor recorded: the delete took it.
   */
  dropped: number;
  /**
   * Ops consumed because they name a parent a delete has already taken — and a row this device
   * held under such an op's uid is deleted with it, so a trip can change what a screen shows while
   * {@link RelayOutcome.applied} stays at nought.
   */
  moot: number;
  /**
   * Whether this trip changed a row a screen reads: it applied or mooted an op, brought a row back,
   * broke a folder cycle, or one of the conversions that run behind a pull wrote a row. `false` for
   * a trip that only pushed, skipped, held or dropped. `useDeviceSyncInvalidation` gates its wide
   * refresh on this and not on `pulled`, which missed the moot arm's deletes and the conversions.
   */
  changed: boolean;
  /**
   * Rows handed to a device that had not heard from this one before.
   *
   * Larger than any other number here by orders of magnitude — 1 069 on the measured pair —
   * which is why the panel says what it is rather than letting it read as a hang.
   */
  baselineOps: number;
  /**
   * The `deck_audit` rows among {@link RelayOutcome.baselineOps}, named separately.
   *
   * Baseline spec §7: history is the one synced table with no ceiling, so it is the part of a
   * first exchange that can surprise. A reader who is told only the total has no way to tell a
   * large collection from a long one.
   */
  baselineHistory: number;
  /**
   * How many pages this trip's pull asked the relay for: one for an ordinary sync, and for a
   * relay that does not page; one a half-mebibyte of log for a device catching up.
   */
  pullPages: number;
  /**
   * Whether the pull evaluated everything it fetched as one answer, because a baseline from a
   * build before v0.40.0 was in it — the cost of the unpaged pull, for that catch-up only. No
   * face reads it; it is what says, in a measurement or a bug report, which way a catch-up was
   * applied.
   */
  pullWhole: boolean;
}

/**
 * The six tables that can hold a `needs_review` sentence.
 *
 * A closed union, like {@link ErrorSource} and for the same reason: `Record<ReviewTable, string>`
 * in `ReviewPanel.tsx` is total, so a seventh table added on the Rust side is a **type error**
 * here rather than a heading nobody wrote. The crate's own
 * `no_table_with_the_column_is_missing_from_the_list` catches a table the *crate* forgot; this
 * catches one the crate remembered and the page did not.
 */
export type ReviewTable =
  | "collection_entries"
  | "deck_cards"
  | "wishlist_entries"
  | "collection_folders"
  | "deck_folders"
  | "wishlist_folders";

/**
 * One row asking to be looked at — spec §7.4's two surfaced outcomes, plus whatever the
 * reconciler has already written about a printing that left Scryfall.
 *
 * `sentence` is shown **verbatim**. It was written in Rust, which is `reconcile.rs`'s
 * convention for this column and deliberately not `deck_audit`'s: one column with two
 * conventions is worse than either.
 */
export interface ReviewRow {
  /** Which table it is in. The panel groups by this and clearing needs it. */
  table: ReviewTable;
  /** The row's `sync_uid`, never a rowid — a rowid means nothing on the other device. */
  uid: string;
  title: string;
  sentence: string;
}

/** The sync commands — spread into `ipc` by `../ipc.ts`, which is the only reader of this object. */
export const syncCommands = {
  /** `force` skips the 24 h throttle. Rejects if a sync is already running. */
  syncRun: (force: boolean) => invoke<SyncOutcome>("sync_run", { force }),
  syncStatus: () => invoke<SyncStatus>("sync_status"),
  onSyncProgress: (cb: (e: SyncProgressEvent) => void): Unlisten =>
    core.listen<SyncProgressEvent>("sync:progress", cb),

  /** A device sync applied or sent something. Call this once — see `useSyncProgress`. */
  onSyncApplied: (cb: (e: RelayOutcome) => void): Unlisten =>
    core.listen<RelayOutcome>("sync:applied", cb),

  /** The relay socket's state. Call this once. */
  onSyncLive: (cb: (e: SyncLiveEvent) => void): Unlisten =>
    core.listen<SyncLiveEvent>("sync:live", cb),

  /** A reconcile pass that moved user rows. See {@link ReconciledEvent}. */
  onCollectionReconciled: (cb: (e: ReconciledEvent) => void): Unlisten =>
    core.listen<ReconciledEvent>("collection:reconciled", cb),

  /**
   * This device, the group it is in, and the roster — the pairing panel's only read.
   *
   * A **write** path at the far end despite the name: a database that has never paired has no
   * identity row, and reading the panel is what mints one. So it answers `BUSY` if the write
   * connection is held past five seconds, like every other write here — which a sync trip no
   * longer does: it holds the connection only while it reads or writes, never across a request.
   */
  syncPairingStatus: () => invoke<PairingStatus>("sync_pairing_status"),
  /** Start offering a pairing. Replaces any offer already in flight. */
  syncPairingBegin: () => invoke<PairingOffer>("sync_pairing_begin"),
  /** Read an offer on the joining device. Answers the six digits. */
  syncPairingAccept: (code: string) => invoke<PairingHandshake>("sync_pairing_accept", { code }),
  /**
   * The reader says the digits matched. Answers the sealed group key.
   *
   * **Nothing may call this on the reader's behalf.** The comparison is the whole of §7.5
   * step 3, and a panel that pressed it once the digits arrived would have no
   * man-in-the-middle defence at all while looking completely normal.
   */
  syncPairingConfirm: () => invoke<PairingSealedKey>("sync_pairing_confirm"),
  /** Throw away whatever is in flight. The code that was on screen stops working. */
  syncPairingCancel: () => invoke<void>("sync_pairing_cancel"),
  /** Where a pairing has got to. Polled while one is in flight; answers `idle` when none is. */
  syncPairingPoll: () => invoke<PairingProgress>("sync_pairing_poll"),
  /**
   * The relay, what is waiting to be sent, and what wants looking at.
   *
   * A **write** path at the far end, like {@link ipc.syncPairingStatus}: it counts unpushed
   * ops on the write connection, so it answers `BUSY` if that is held past five seconds — which
   * a sync trip, holding it only while it reads or writes, no longer does.
   */
  syncRelayStatus: () => invoke<RelayStatus>("sync_relay_status"),
  /**
   * Start connecting a membership. Answers the Patreon authorize URL to open.
   *
   * **Nothing has happened when this returns.** The URL is a string until something opens it,
   * and the reader consents on Patreon's own page — so a panel that merely *offers* to connect
   * has visited nothing.
   */
  syncPatreonBegin: () => invoke<string>("sync_patreon_begin"),
  /**
   * Hand over the code the relay's landing page showed, and become connected.
   *
   * One-time and short-lived at the far end, so a refusal is ordinary rather than exceptional —
   * a code pasted twice, or ten minutes late, is the commonest thing that goes wrong here.
   */
  syncPatreonClaim: (code: string) => invoke<SupporterStatus>("sync_patreon_claim", { code }),
  /** The membership as this device last heard it. Local read; it opens no connection. */
  syncSupporterStatus: () => invoke<SupporterStatus>("sync_supporter_status"),
  /**
   * One round trip now: push, then pull, then ack.
   *
   * Answers `null` when there is nothing to do — no connected membership, or no pairing group.
   * That is not an error, it is the state every existing installation is in.
   */
  syncNow: () => invoke<RelayOutcome | null>("sync_now"),
  /** The relay socket's state right now. Seeds a listener that mounts after the last transition.
   *
   * The Rust manager **deduplicates** `sync:live` — it emits only on a transition, because
   * otherwise `"off"` would be re-emitted every five seconds forever on every installation that
   * has paired nothing, which is all of them today. So a listener that mounts *after* the last
   * transition never learns the state by listening alone: Tauri also drops events emitted before
   * the webview registered a listener, which makes that the common case at launch rather than a
   * rare race. A later task seeds its hook from this command and then subscribes for changes.
   */
  syncLiveState: (): Promise<LiveState> => invoke<LiveState>("sync_live_state"),
  /** Every row carrying a sentence, from all six tables that can hold one. */
  syncReviewList: () => invoke<ReviewRow[]>("sync_review_list"),
  /**
   * "Looks fine": clear one row's sentence, and answer what is left.
   *
   * Clearing is a write like any other, so it is captured and travels — a row one device has
   * looked at stops asking on the others too, which is why the sentence is on the row rather
   * than in a notification.
   */
  syncReviewClear: (table: ReviewTable, uid: string) =>
    invoke<ReviewRow[]>("sync_review_clear", { table, uid }),
  /**
   * Rename a device on the roster.
   *
   * Renaming **this** device also changes the name every later pairing sends, which is what
   * stops the next press of Pair putting the old one back.
   */
  syncDeviceRename: (deviceId: string, name: string) =>
    invoke<void>("sync_device_rename", { deviceId, name }),
  /**
   * Remove a device and rotate the group key.
   *
   * **The rotation is the removal** — see §7.6. What it cannot do is reach the removed device:
   * whatever that device already synced, it keeps, and no server can take it back. The panel
   * says so in those words rather than implying a lost phone has been cleaned.
   */
  syncDeviceRevoke: (deviceId: string) => invoke<void>("sync_device_revoke", { deviceId }),
  /**
   * Leave the group this device is in — and **always succeed**, short of being in no group.
   *
   * The far end plans a departure, publishes it **best effort**, and then clears this device's
   * group *and* its grant whatever the relay answered (spec §2.1). So a reader on a plane leaves
   * too; what they lose is the courtesy, never the departure — the other devices go on listing
   * this one until somebody removes it there, which is why the dialog in front of this press
   * says so. The one refusal is a device that is in no group, which has nothing to leave.
   *
   * **The grant goes with the group, and `clear` is not `revoke`** (§2.3): a leaver keeping its
   * refresh secret keeps a working credential for the group it walked out of. Nothing *ended*,
   * so no lapse is recorded — this device reads *Not connected* afterwards, not
   * *Membership ended*.
   */
  syncGroupLeave: () => invoke<void>("sync_group_leave"),
};
