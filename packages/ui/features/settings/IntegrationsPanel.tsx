import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState, type JSX, type RefObject } from "react";
import { FOCUS } from "@/lib/focus";
import {
  ipc,
  ipcError,
  type IntegrationFields,
  type IntegrationsStatus,
  type IntentAutomatic,
  type IntentReview,
  type ParkedIntent,
} from "@/lib/ipc";
import { notify } from "@/lib/notifications";
import { INTEGRATIONS_KEY, INTEGRATIONS_REVIEW_KEY } from "@/lib/query";
import { ago } from "@/lib/relativeTime";
import { cn } from "@/lib/utils";
import { toasted, writeFailure } from "@/lib/writes";
import { ConfirmDialog } from "./ConfirmDialog";
import { PANEL_BUTTON, SWITCH, switchTone, TOUCH_FLOOR } from "./controls";
import { PanelAlert, SettingsSection } from "./panelChrome";

/** The panel's id stem — `SettingsSection`'s heading is `integrations-heading`. */
const ID = "integrations";

/**
 * What a server holding the reader's collection means, **verbatim from spec §4.B**
 * (`2026-10-24-integration-data-access-design.md`). Exported so the tests and the stories assert
 * the sentence the panel draws rather than a paraphrase of it.
 */
export const PRIVACY_SENTENCE =
  "If you enable an integration, our servers hold a copy of the parts of your collection you " +
  "chose, so integrations can answer when your devices are off. They cannot change your " +
  "collection; they can only propose changes that your own devices apply.";

/**
 * The five opt-ins, in the format's own order (plan §3.1: `condition`, `lang`, `value`, `tags`,
 * `notes`).
 *
 * **`Entry tags` and `Entry notes`, never `Tags` and `Notes`**: a *tag* in this app is one of
 * Scryfall's tagger datasets, and this column is the free text a reader typed on a collection
 * entry (`docs/agent/DOMAIN_VOCABULARY.md`); the note is the entry's own, not a deck's.
 */
export const FIELD_ROWS: readonly { key: keyof IntegrationFields; label: string }[] = [
  { key: "condition", label: "Condition" },
  { key: "lang", label: "Language" },
  { key: "value", label: "Market value" },
  { key: "tags", label: "Entry tags" },
  { key: "notes", label: "Entry notes" },
];

/** Every opt-in off — the panel's starting choice, and plan §1's default. */
const NO_FIELDS: IntegrationFields = {
  condition: false,
  lang: false,
  value: false,
  tags: false,
  notes: false,
};

/**
 * What reads the copy in this release: nothing yet. The store takes an integration's proposals
 * (plan `2026-10-29-integrations-intents.md`), but Discord and a remote MCP server — the first
 * integrations to connect — are later PRs of issue #1396.
 */
export const NONE_CONNECTED = "No integration is connected to this copy yet.";

/** Why the switch cannot be pressed in a build with no store address (plan §2). */
export const NOT_AVAILABLE = "This build can't reach the integrations service yet.";

/**
 * Why the switch cannot be pressed without a membership. **Patreon by name**, the way the
 * Sync panel and the Share control name it on the desktop — and this panel is the desktop's
 * alone (`LIGHT_SETTINGS`). The membership is the group's, so any device's will do.
 */
export const NOT_ENTITLED =
  "Integrations need a supporter membership, like sync. Connect Patreon under Sync — any " +
  "device in your group will do.";

/**
 * When this device last sent its copy — `Last sent from this device: 2 hours ago.`
 *
 * **Seconds in, as `IntegrationsStatus` carries them**, which is what {@link ago} takes.
 *
 * @param nowMs the clock — a default parameter, `BackupPanel`'s `lastPassLine`'s reason: the line
 * is a fact about the render, and a settings panel on a timer would be motion without information.
 */
export function sentLine(publishedAt: number | null, nowMs: number = Date.now()): string {
  if (publishedAt === null) return "Nothing sent from this device yet.";
  return `Last sent from this device: ${ago(publishedAt, nowMs)}.`;
}

/**
 * How often the panel asks again while a publish it asked for has not run — `pending`.
 *
 * **Nothing else re-reads this status while the panel is open**: the switch's press answers
 * `pending: true` and a `publishedAt` the press did not move (the round publishes, not the press),
 * so a panel that waited for a refocus would say "Nothing sent from this device yet." for as long
 * as the reader looked at it, and a first round's failure would never appear. Three seconds is
 * under the publish loop's own poll, so the line moves within a beat of the round; while nothing
 * is pending the panel asks nobody.
 */
export const PUBLISH_POLL_MS = 3_000;

/** What the line beside the switch says while a publish this device asked for has not run. */
export const SENDING = "Sending this device's copy…";

/**
 * What an On switch says to a device that has lost its membership: it cannot switch the copy off,
 * because deleting the store takes a relay token like every other request to it. **The copy is
 * not stranded for good** — the Worker's lapse job removes a group's store when its membership
 * ends. The membership named the way the Sync panel names it on the desktop.
 */
export const STRANDED =
  "This device can't switch it off without sync: the copy stays on our servers until this " +
  "device is back in your sync group, or until it is removed when your group's membership ends.";

/** When the store was last asked whether it exists — the answer above is as of then, since
 *  another device in the group can switch it. `null` when it never has been. */
export function checkedLine(checkedAt: number | null, nowMs: number = Date.now()): string | null {
  return checkedAt === null ? null : `Checked with the service ${ago(checkedAt, nowMs)}.`;
}

/**
 * Settings → Integrations (issue #1396, plan §1 item 5): the group's switch for a copy of the
 * collection held on a server, and the five columns it may carry.
 *
 * **The switch is the group's, and so are the columns** (plan §2): the store's existence is what
 * every device reads as on or off, and two devices projecting under two choices would flap it.
 * So what is drawn while on is the status's `fields`, whatever device chose them; what is drawn
 * while off is this panel's own draft, which nothing reads until the switch is pressed and which
 * starts with every box clear.
 *
 * **Turning it on sends the ticked boxes; turning it off asks first**, because it deletes the
 * server's copy for every device in the group. A box changed while on sends the whole set — the
 * store drops every table at once and the devices send their copies again under the new choice.
 * **A press publishes nothing**: it asks for a round (`pending`), and the panel asks again every
 * {@link PUBLISH_POLL_MS} until the round has run, so *Last sent* and a round's failure appear
 * while the reader is looking.
 *
 * **`aria-disabled` and a guarded handler, never the attribute** — the app's rule (`controls.ts`,
 * `MarketplacePanel`'s rows, `SyncPanelBody`'s paste button): a control that takes `disabled`
 * under the reader's press drops the caret to `<body>` in Chromium with no `blur` (`Dialog.tsx`
 * records the measurement), and a gated control would leave the tab order with the sentence that
 * says why. So the switch and the boxes stay focusable and refuse the press, by mouse and by key.
 *
 * **It reaches the backend itself**, `BackupPanel`'s rule: nothing else in the window reads this
 * state. Every command answers a fresh status, written straight back under
 * {@link INTEGRATIONS_KEY}. A refusal re-reads it instead: whatever refused the press — a
 * membership that has since ended, a store another device deleted — is what the panel should
 * draw next.
 *
 * Desktop only: `LIGHT_SETTINGS` leaves it out (plan §2, the Share control's reason).
 */
export function IntegrationsPanel(): JSX.Element {
  const client = useQueryClient();
  /** The opt-ins while the switch is off. Seeded by a disable with the choice that was on, so
   *  switching back on offers the same columns rather than a cleared form. */
  const [draft, setDraft] = useState<IntegrationFields>(NO_FIELDS);
  /** The question before switching off. */
  const [asking, setAsking] = useState(false);
  /** The switch, so the question can hand the caret back to the control that asked it. */
  const switchRef = useRef<HTMLButtonElement>(null);

  const read = useQuery({
    queryKey: INTEGRATIONS_KEY,
    queryFn: () => ipc.integrationsStatus(),
    refetchInterval: (query) => (query.state.data?.pending === true ? PUBLISH_POLL_MS : false),
  });
  const status = read.data ?? null;
  const settle = (next: IntegrationsStatus) =>
    client.setQueryData<IntegrationsStatus>(INTEGRATIONS_KEY, next);
  const reread = () => void client.invalidateQueries({ queryKey: INTEGRATIONS_KEY });
  /**
   * **A read already in flight is called off before a press goes out.** It was asked before the
   * press and answers what the store said then; landing after the press's own answer, it would
   * write the old switch back over the new one. Awaited by TanStack before the press is sent.
   */
  const holdReads = () => client.cancelQueries({ queryKey: INTEGRATIONS_KEY });

  const enable = useMutation({
    mutationFn: (fields: IntegrationFields) => ipc.integrationsEnable(fields),
    onMutate: holdReads,
    onSuccess: settle,
    onError: reread,
  });
  const setFields = useMutation({
    mutationFn: (fields: IntegrationFields) => ipc.integrationsSetFields(fields),
    onMutate: holdReads,
    onSuccess: settle,
    onError: reread,
  });
  const disable = useMutation({
    mutationFn: () => ipc.integrationsDisable(),
    onMutate: holdReads,
    onSuccess: settle,
    onError: reread,
  });
  const busy = enable.isPending || setFields.isPending || disable.isPending;

  const on = status?.enabled === true;
  /** Why nothing can be pressed, in the order a reader can act on it: the build first, since no
   *  membership makes a build with no address reach anything. */
  const gate =
    status === null
      ? null
      : !status.available
        ? NOT_AVAILABLE
        : !status.entitled
          ? NOT_ENTITLED
          : null;
  const pressable = status !== null && gate === null && !busy;

  /**
   * The boxes as drawn. While on, the group's choice — **or the one on its way**, the mutation's
   * own `variables`, so a ticked box stays ticked while the store answers instead of springing
   * back for a beat. While off, the draft.
   */
  const shown: IntegrationFields = on
    ? setFields.isPending && setFields.variables !== undefined
      ? setFields.variables
      : status.fields
    : draft;

  // Both handlers refuse a press the controls are drawn refusing — they carry `aria-disabled`,
  // not `disabled`, so a click or a key still arrives here.
  const toggle = () => {
    if (status === null || !pressable) return;
    if (status.enabled) setAsking(true);
    else enable.mutate(draft);
  };

  const tick = (key: keyof IntegrationFields, checked: boolean) => {
    // Nothing set: React puts a controlled box back to what it was drawn as.
    if (!pressable) return;
    const next = { ...shown, [key]: checked };
    if (on) setFields.mutate(next);
    else setDraft(next);
  };

  /** Escape, Cancel, the close control and the confirm itself: the caret goes back to the
   *  switch, which stays focusable whatever the press does to it next (`aria-disabled`). */
  const dismiss = () => {
    switchRef.current?.focus();
    setAsking(false);
  };

  const confirmDisable = () => {
    const before = status?.fields ?? NO_FIELDS;
    disable.mutate(undefined, { onSuccess: () => setDraft(before) });
  };

  /**
   * The panel's one line of bad news, under the switch. The newest press's refusal first
   * (`@/lib/writes`) — it is what the reader just did; then the last publish round's failure,
   * which the status carries; then a status that never loaded.
   */
  const problem =
    writeFailure([enable, setFields, disable]) ??
    status?.error ??
    (status === null && read.isError ? ipcError(read.error) : null);

  return (
    // A literal id, never `ID`: `nav.test.ts` holds every `SettingsSection` stem to a `PanelId`
    // by reading the source, and an expression is a stem no text sweep can read.
    <SettingsSection id="integrations" title="Integrations">
      <p className="text-sm">{PRIVACY_SENTENCE}</p>
      {/* True in this release: the store can take an integration's proposals, but Discord and a
          remote MCP server are later PRs (issue #1396), and a reader deciding whether to switch
          this on should know nothing is connected to it yet. */}
      <p className="text-sm text-dim">{NONE_CONNECTED}</p>

      {/* No switch until the status has answered: an Off drawn over a store that may exist would
          be a claim this panel has not checked. A read that failed says so below instead. */}
      {status === null ? (
        !read.isError && <p className="text-sm text-dim">Checking…</p>
      ) : (
        <SwitchRow
          status={status}
          note={
            gate ??
            (!on
              ? "Off. Our servers keep no copy."
              : status.pending
                ? SENDING
                : sentLine(status.publishedAt))
          }
          // On, in a build that can reach the store, on a device that can no longer ask it.
          stranded={on && status.available && !status.entitled}
          pressable={pressable}
          busy={enable.isPending || disable.isPending}
          onToggle={toggle}
          buttonRef={switchRef}
        />
      )}

      <PanelAlert tone="problem">{problem}</PanelAlert>

      {/* The rule is on a box around the fieldset, because a fieldset's own border is drawn
          through its legend. */}
      <div className="border-t border-border pt-4">
        <fieldset className="space-y-2">
          <legend className="text-sm">What the copy includes</legend>
          <p className="text-xs leading-snug text-dim">
            Always your cards, folders, wishlist and decks — names, printings, finishes and
            quantities. These are off until you tick them:
          </p>
          <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
            {FIELD_ROWS.map(({ key, label }) => (
              <label
                key={key}
                className={cn(
                  "flex items-center gap-2",
                  TOUCH_FLOOR,
                  !pressable && "cursor-not-allowed text-dim",
                )}
              >
                <input
                  type="checkbox"
                  checked={shown[key]}
                  aria-disabled={!pressable || undefined}
                  onChange={(e) => tick(key, e.target.checked)}
                  className={cn(
                    "size-4 accent-accent",
                    !pressable && "cursor-not-allowed opacity-50",
                    FOCUS,
                  )}
                />
                {label}
              </label>
            ))}
          </div>
          <p className="text-xs leading-snug text-dim">
            Changing these while the copy is on deletes it from the server, and your devices send it
            again under the new choice.
          </p>
          {/* Absent from the format rather than switched off in it (plan §3.1), so there is no
              box that could ever send one. Saying so is the point: a reader deciding about this
              copy is deciding about what they paid. */}
          <p className="text-xs leading-snug text-dim">
            Purchase price, purchase currency, acquired date and acquisition source are never
            included.
          </p>
          <p className="text-xs leading-snug text-dim">
            Locked folders are included — this copy is private to your integrations, not a public
            share.
          </p>
        </fieldset>
      </div>

      {status !== null && status.checkedAt !== null && (
        <p className="text-xs text-dim">{checkedLine(status.checkedAt)}</p>
      )}

      {/* Only while on: a store that does not exist holds no intents, and the policy rows would
          be switches about integrations that cannot write anything. */}
      {on && <ReviewSection pressable={pressable} />}

      <ConfirmDialog
        open={asking}
        title="Turn off integrations"
        confirmLabel="Delete the copy"
        typeToConfirm={false}
        pending={disable.isPending}
        onConfirm={confirmDisable}
        onDismiss={dismiss}
        onClose={() => setAsking(false)}
      >
        This deletes the copy our servers hold for every device in your sync group. Nothing on your
        devices changes, and you can switch it on again at any time.
      </ConfirmDialog>
    </SettingsSection>
  );
}

/**
 * The switch and the lines beside it: what pressing it would do, or why it cannot be pressed.
 *
 * The lines are the switch's description as well as its caption, so a screen reader hears *why*
 * an out-of-reach switch refuses rather than only that it does.
 */
function SwitchRow({
  status,
  note,
  stranded,
  pressable,
  busy,
  onToggle,
  buttonRef,
}: {
  status: IntegrationsStatus;
  note: string;
  /** On, and this device can no longer ask the store to delete it — {@link STRANDED}. */
  stranded: boolean;
  pressable: boolean;
  /** The switch's own press is out — `aria-busy`, beside the refusal every press brings. */
  busy: boolean;
  onToggle: () => void;
  buttonRef: RefObject<HTMLButtonElement | null>;
}) {
  const on = status.enabled;
  const described = stranded ? `${ID}-switch-note ${ID}-switch-stranded` : `${ID}-switch-note`;
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="min-w-0 flex-1">
        <p id={`${ID}-switch`} className="text-sm">
          Keep a copy for integrations
        </p>
        <p id={`${ID}-switch-note`} className="mt-0.5 text-xs leading-snug text-dim">
          {note}
        </p>
        {stranded && (
          <p id={`${ID}-switch-stranded`} className="mt-1 text-xs leading-snug text-dim">
            {STRANDED}
          </p>
        )}
      </div>
      {/* Named by the line beside it *and* by its own word — `ScanSoundsPanel`'s switch, and
          WCAG 2.5.3's reason: an `aria-label` would replace the visible "On". Out of reach it
          keeps its tone without the hover that invites a press, and holds still under one. */}
      <button
        ref={buttonRef}
        type="button"
        role="switch"
        aria-checked={on}
        aria-labelledby={`${ID}-switch ${ID}-switch-state`}
        aria-describedby={described}
        aria-busy={busy || undefined}
        aria-disabled={!pressable || undefined}
        onClick={onToggle}
        className={cn(
          SWITCH,
          pressable
            ? switchTone(on)
            : cn(
                on ? "border-accent text-accent" : "border-border text-dim",
                "cursor-not-allowed opacity-50 active:scale-100",
              ),
        )}
      >
        <span id={`${ID}-switch-state`}>{on ? "On" : "Off"}</span>
      </button>
    </div>
  );
}

/**
 * The source's name as the review list draws it. **A word this page does not know is drawn as it
 * came** rather than refused: the device owns the list of sources and kinds (`integration::intents`),
 * and a later one must not blank a row.
 */
const SOURCE_LABELS: Record<string, string> = {
  discord: "Discord",
  mcp: "MCP",
  trade: "A trade",
};

/** What a kind asks for, as the policy rows name it. */
const KIND_LABELS: Record<string, string> = {
  "collection.add": "Add to your collection",
  "wishlist.add": "Add to your wishlist",
};

export const sourceLabel = (source: string): string => SOURCE_LABELS[source] ?? source;
export const kindLabel = (kind: string): string => KIND_LABELS[kind] ?? kind;

/** What the review list says with nothing parked. */
export const NOTHING_WAITING = "Nothing is waiting for your review.";

/** Why Discord's two rows cannot be switched off: the reader already confirmed each one. */
export const DISCORD_FIXED = "Always — you confirm each one in Discord.";

/**
 * Where a parked intent's copies go, as a phrase after "to": the folder by name in curly quotes,
 * or the wishlist's (or, defensively, the collection's) root.
 */
export function destination(intent: Pick<ParkedIntent, "kind" | "folder">): string {
  if (intent.folder !== null) return `“${intent.folder}”`;
  return intent.kind === "wishlist.add" ? "your wishlist" : "your collection";
}

/**
 * One parked intent as a line — `2× Lightning Bolt (2X2 #117), foil → “Binder”`. The printing
 * only where the intent names one (an any-printing wish names none), and the finish only where it
 * is not the ordinary one.
 */
export function intentLine(intent: ParkedIntent): string {
  const printing =
    intent.set === null
      ? ""
      : ` (${intent.set.toUpperCase()}${intent.cn === null ? "" : ` #${intent.cn}`})`;
  const finish = intent.finish !== null && intent.finish !== "nonfoil" ? `, ${intent.finish}` : "";
  return `${intent.quantity}× ${intent.name}${printing}${finish} → ${destination(intent)}`;
}

/** Who proposed it and when — `From Discord (discord:123), 5 minutes ago.` `createdAt` is ms. */
export function originLine(intent: ParkedIntent, nowMs: number = Date.now()): string {
  const who = intent.confirmedBy === null ? "" : ` (${intent.confirmedBy})`;
  return `From ${sourceLabel(intent.source)}${who}, ${ago(Math.floor(intent.createdAt / 1000), nowMs)}.`;
}

/** The toast an applied intent raises — the owner's rule: every deliberate add says what moved
 *  where, with a count. */
export function appliedTitle(intent: ParkedIntent): string {
  return `Added ${intent.quantity}× ${intent.name} to ${destination(intent)}`;
}

/**
 * **The review list** (plan `2026-10-29-integrations-intents.md` §1 item 6, §3.5): the changes an
 * integration proposed that this device parks rather than applies, each with Apply and Decline,
 * and the policy that decides what is parked — one row per `(source, kind)`.
 *
 * **It reaches the backend itself**, as the panel does, under its own key: every command answers
 * a fresh {@link IntentReview}, written straight back. A refusal re-reads the list — whatever
 * refused it (another device applied the intent first, the store was switched off) is what the
 * list should draw next.
 *
 * **Apply is a collection or wishlist add and toasts** (the owner's rule, 2026-10-12): success
 * says what went where, a refusal is `notify.error` — so the banner here seats it `toasted` and
 * says it once. Decline and the policy are not edits to the collection; their refusals are the
 * banner's.
 *
 * `pressable` is the panel's: no press while the build or the membership refuses, or while the
 * switch's own press is out.
 */
function ReviewSection({ pressable: panelPressable }: { pressable: boolean }) {
  const client = useQueryClient();
  const read = useQuery({
    queryKey: INTEGRATIONS_REVIEW_KEY,
    queryFn: () => ipc.integrationsReview(),
  });
  const review = read.data ?? null;
  const settle = (next: IntentReview) =>
    client.setQueryData<IntentReview>(INTEGRATIONS_REVIEW_KEY, next);
  const reread = () => void client.invalidateQueries({ queryKey: INTEGRATIONS_REVIEW_KEY });
  // The panel's reason: a read already out would land after the press's answer and undo it.
  const holdReads = () => client.cancelQueries({ queryKey: INTEGRATIONS_REVIEW_KEY });

  const apply = useMutation({
    mutationFn: (intent: ParkedIntent) => ipc.integrationsReviewApply(intent.id),
    onMutate: holdReads,
    onSuccess: (next, intent) => {
      settle(next);
      notify.success(appliedTitle(intent));
    },
    onError: (e, intent) => {
      notify.error(`Couldn't add ${intent.name}`, { body: ipcError(e) });
      reread();
    },
  });
  const decline = useMutation({
    mutationFn: (intent: ParkedIntent) => ipc.integrationsReviewDecline(intent.id),
    onMutate: holdReads,
    onSuccess: settle,
    onError: reread,
  });
  const setAutomatic = useMutation({
    mutationFn: (row: IntentAutomatic) =>
      ipc.integrationsSetAutomatic(row.source, row.kind, !row.on),
    onMutate: holdReads,
    onSuccess: settle,
    onError: reread,
  });
  const busy = apply.isPending || decline.isPending || setAutomatic.isPending;
  const pressable = panelPressable && review !== null && !busy;

  const problem =
    writeFailure([toasted(apply), decline, setAutomatic]) ??
    (review === null && read.isError ? ipcError(read.error) : null);

  return (
    <div className="space-y-3 border-t border-border pt-4">
      <div>
        <h3 id="integrations-review-heading" className="text-sm">
          Waiting for your review
        </h3>
        <p className="mt-0.5 text-xs leading-snug text-dim">
          Changes an integration proposed that this device waits for you to approve.
        </p>
      </div>

      {review === null ? (
        !read.isError && <p className="text-sm text-dim">Checking…</p>
      ) : review.intents.length === 0 ? (
        <p className="text-sm text-dim">{NOTHING_WAITING}</p>
      ) : (
        <ul aria-labelledby="integrations-review-heading" className="space-y-2">
          {review.intents.map((intent) => (
            <li
              key={intent.id}
              className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1"
            >
              <div className="min-w-0 flex-1">
                <p className="text-sm">{intentLine(intent)}</p>
                <p className="text-xs leading-snug text-dim">{originLine(intent)}</p>
              </div>
              <div className="flex shrink-0 gap-2">
                <button
                  type="button"
                  aria-label={`Apply: ${intentLine(intent)}`}
                  aria-disabled={!pressable || undefined}
                  aria-busy={(apply.isPending && apply.variables?.id === intent.id) || undefined}
                  onClick={() => pressable && apply.mutate(intent)}
                  className={cn(PANEL_BUTTON, !pressable && "cursor-not-allowed opacity-50")}
                >
                  Apply
                </button>
                <button
                  type="button"
                  aria-label={`Decline: ${intentLine(intent)}`}
                  aria-disabled={!pressable || undefined}
                  aria-busy={
                    (decline.isPending && decline.variables?.id === intent.id) || undefined
                  }
                  onClick={() => pressable && decline.mutate(intent)}
                  className={cn(PANEL_BUTTON, !pressable && "cursor-not-allowed opacity-50")}
                >
                  Decline
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <PanelAlert tone="problem">{problem}</PanelAlert>

      {review !== null && review.automatic.length > 0 && (
        <fieldset className="space-y-2">
          <legend className="text-sm">Apply automatically on this device</legend>
          {review.automatic.map((row) => {
            const locked = row.fixed || !pressable;
            return (
              <div key={`${row.source}:${row.kind}`}>
                <label
                  className={cn(
                    "flex items-center gap-2 text-sm",
                    TOUCH_FLOOR,
                    locked && "cursor-not-allowed",
                    !pressable && !row.fixed && "text-dim",
                  )}
                >
                  <input
                    type="checkbox"
                    checked={row.on}
                    aria-disabled={locked || undefined}
                    aria-describedby={
                      row.fixed ? `integrations-auto-${row.source}-${row.kind}-why` : undefined
                    }
                    // Nothing set on a refused press: React puts a controlled box back.
                    onChange={() => !locked && setAutomatic.mutate(row)}
                    className={cn(
                      "size-4 accent-accent",
                      locked && "cursor-not-allowed opacity-50",
                      FOCUS,
                    )}
                  />
                  {sourceLabel(row.source)} — {kindLabel(row.kind).toLowerCase()}
                </label>
                {row.fixed && (
                  <p
                    id={`integrations-auto-${row.source}-${row.kind}-why`}
                    className="ml-6 text-xs leading-snug text-dim"
                  >
                    {DISCORD_FIXED}
                  </p>
                )}
              </div>
            );
          })}
          <p className="text-xs leading-snug text-dim">
            Anything else waits here. Your other devices keep their own choice.
          </p>
        </fieldset>
      )}
    </div>
  );
}
