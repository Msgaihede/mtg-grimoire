/**
 * The Share control on the cabinet — publish a drawer, refresh it, withdraw it, and the one
 * visible way into somebody else's binder.
 *
 * ## Two halves of one idea, in one bordered group
 *
 * **The second half is here because spec decision 6 left it nowhere else to go.** The *Shared*
 * rail row is hidden until a reader has opened a share, and this control is for *publishing* —
 * so the in-app viewer shipped reachable by `Ctrl+6` and discoverable by nothing at all. Making
 * the rail row unconditional would fix discovery by spending the slot decision 6 exists to save,
 * on a feature most readers will never use. Beside the Share control is where the other half
 * belongs anyway: publish your binder, open somebody else's, one place.
 *
 * ## What is hidden and what is refused
 *
 * **Hidden for a reader who has connected nothing** (spec §9), and hidden rather than greyed
 * with a nag: a control whose only outcome is a sentence explaining that it does not work
 * teaches a reader nothing its absence would not have — `PinnedFolders`' rule — and the Settings
 * sync panel is where the connection story already lives. A membership that *ended* keeps the
 * control, because that reader has connected something and the publish is what refuses, in the
 * crate's own words (`share::publish::NOT_CONNECTED`), which name where to go.
 *
 * **Everything else is refused as a sentence rather than as a constraint failure.** A locked
 * folder greys the row with its reason; the backend's refusals are drawn as themselves. That
 * matters on every build today: `share::publish::SHARE_BASE` is still a placeholder, so
 * `share_create` answers *"Sharing a collection is not available in this build yet"* and this
 * surface has to read as a state rather than as a crash.
 *
 * ## The stale mark, and the press it is not
 *
 * A share whose folder was locked *after* it was published is **stale**: the next publish
 * refuses (`share::snapshot::FOLDER_IS_LOCKED`), so the snapshot on the relay is frozen rather
 * than wrong. It does **not** auto-revoke (spec §10) — a link somebody has in a chat window
 * going dead because its owner tidied a drawer would be the app taking a decision nobody asked
 * it to take. Withdrawing is the reader's own press, behind a confirmation, and terminal.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Link2, Link2Off, RefreshCw, Share2, TriangleAlert } from "lucide-react";
import { useCallback, useMemo, useRef, useState, type JSX, type MouseEvent } from "react";
import { Dialog } from "@/components/Dialog";
import { useContextMenu } from "@/components/menu/useContextMenu";
import type { MenuItem } from "@/components/menu/types";
import { ConfirmDialog } from "@/features/settings/ConfirmDialog";
import { BUTTON } from "@/features/settings/controls";
import { OpenShareDialog } from "@/features/share/OpenShareDialog";
import { SHARE_KEY, useShares } from "@/features/share/useShares";
import { copyText } from "@/lib/clipboard";
import { FOCUS } from "@/lib/focus";
import { ipc, ipcError, type CollectionFolder, type ShareFields, type ShareRow } from "@/lib/ipc";
import { SUPPORTER_KEY, supporterState } from "@/lib/query";
import { useAppStore } from "@/lib/store";
import { cn } from "@/lib/utils";

/**
 * What a Share press is *about* — the whole collection, or one drawer named by its sync uid.
 *
 * A discriminated union rather than a nullable uid, and the discriminant is load-bearing:
 * `share_create`'s `folderUid` is `null` for the **whole collection**, so "no folder" and "a
 * folder I cannot name" must never be the same value. See {@link folderShareUid}.
 */
export type ShareTarget =
  | { kind: "collection"; title: string }
  | { kind: "folder"; uid: string; title: string; locked: boolean };

/** `share::snapshot::WHOLE_COLLECTION_TITLE`, and what the viewer draws as the binder's name. */
export const WHOLE_COLLECTION_TITLE = "Collection";

/**
 * The phrase a greyed Share row carries.
 *
 * **A phrase and not `share::snapshot::FOLDER_IS_LOCKED`'s whole sentence** — *"That folder is
 * locked. Unlock it before sharing it."* — for the reason this page's `Delete…` row already
 * gives: a menu row is as wide as its widest content, so one long reason sets the width of the
 * entire panel. It is the same three words `Delete…` greys with, deliberately, because it points
 * at the same next thing to do.
 */
export const UNLOCK_FIRST = "unlock it first";

/**
 * The folder's `sync_uid`, or `null` where the list did not name one.
 *
 * **A folder is named to the share service by its uid and never by its row id**, because a share
 * outlives the device that made it and a row id names a row in a database no other device has
 * seen — `ShareRow.folderUid`'s rule, and `share_create`'s.
 *
 * **What this accessor must never do is fall back**, which is why it is a function with a
 * comment rather than an inline `??`. `null` reaching `share_create` as `folderUid` is not "no
 * folder" — it is *the whole collection*, so a fallback here publishes every card the reader
 * owns instead of the one binder they picked, succeeding silently. `ipc.ts` warns about exactly
 * that shape at `shareCreate`. {@link shareTargetFor} therefore answers **no target at all**,
 * and the control is absent rather than wrong. The column is nullable in the DDL, so this stays
 * a state to answer for even once every creation path mints one.
 *
 * **The empty string is folded in with the `null`**, which is not defensiveness: `""` is not a
 * name the relay can resolve, and it is what a half-written row would carry — so the one branch
 * that must not fall back covers both spellings of *no uid*.
 */
export function folderShareUid(folder: CollectionFolder): string | null {
  return folder.syncUid !== null && folder.syncUid !== "" ? folder.syncUid : null;
}

/**
 * Which level offers a Share control, and what it would publish.
 *
 * `null` in is the root of the cabinet — a destination rather than an omission, which is the
 * same distinction `share_create` draws on the wire.
 *
 * `null` out is *no control*, and there are two ways to earn it. A folder whose `kind` is not
 * `user` is a deck group or `Recently removed`: the app owns those, neither is a binder, and
 * `share::snapshot::FOLDER_NOT_SHAREABLE` refuses them on the other side — so the control is
 * absent here exactly as it is for every other folder write, which is `CollectionPage`'s
 * `userFolders` split said one more time. The other is a folder the list named no uid for; see
 * {@link folderShareUid} for why that is an absence rather than a fallback.
 *
 * `locked` is the **effective** lock — `lockedFolderIds`' answer, ancestry included — and never
 * the folder's own flag, because `share::snapshot` drops a folder with a locked ancestor exactly
 * as it drops a locked one.
 */
export function shareTargetFor(
  folder: CollectionFolder | null,
  locked: boolean,
): ShareTarget | null {
  if (folder === null) return { kind: "collection", title: WHOLE_COLLECTION_TITLE };
  if (folder.kind !== "user") return null;
  const uid = folderShareUid(folder);
  if (uid === null) return null;
  return { kind: "folder", uid, title: folder.name, locked };
}

/** The uid `share_create` is handed for this target — `null` is the whole collection. */
function uidOf(target: ShareTarget): string | null {
  return target.kind === "collection" ? null : target.uid;
}

/** Whether this target's folder is set aside. The root is never locked. */
function lockedOf(target: ShareTarget): boolean {
  return target.kind === "folder" && target.locked;
}

/**
 * The share this level already has, if any.
 *
 * A withdrawn row survives its own revocation until the next reconcile drops it, so the folder
 * can say *withdrawn* rather than having its badge vanish with no explanation — which means a
 * folder can hold two rows for a moment. The live one wins.
 */
export function shareFor(shares: readonly ShareRow[], target: ShareTarget): ShareRow | null {
  const uid = uidOf(target);
  const mine = shares.filter((row) => row.folderUid === uid);
  return mine.find((row) => row.state !== "revoked") ?? mine[0] ?? null;
}

/**
 * A live share whose folder has since been set aside.
 *
 * The relay still serves the snapshot it was given; what has stopped is the *updating*, because
 * the next publish is refused before it reads. Saying so is the whole of spec §10's row for this
 * state — and saying it is all the app does, because withdrawing is the reader's press.
 */
export function shareIsStale(share: ShareRow | null, target: ShareTarget): boolean {
  return share !== null && share.state === "live" && lockedOf(target);
}

/* ------------------------------------------------------------------- the control ---------- */

/**
 * The bordered pair in the collection's figures band: **Share**, and the way into somebody
 * else's binder.
 *
 * `target` is `null` for a level that offers no Share control at all — the Open half is still
 * drawn there, because viewing is open to everyone and needs no membership, no account and no
 * token (spec §9).
 */
export function ShareFolderMenu({ target }: { target: ShareTarget | null }): JSX.Element {
  const client = useQueryClient();
  const { menuClick } = useContextMenu();
  const shares = useShares();
  const setActiveView = useAppStore((s) => s.setActiveView);

  /**
   * The membership, through the one key and the one reading of the four fields.
   *
   * **Imported rather than re-spelled**: `SUPPORTER_KEY` sits under `SYNC_KEY`, which is what
   * makes a finished round trip re-read it, and a second literal `["sync", "supporter"]` here
   * would be two features spelling one prefix two ways. `supporterState` comes with it because
   * `entitled` and `groupBound` have to be asked in that order — a build that asked `status`
   * first drew *Membership ended* at a paid-up supporter's second device. Both live in
   * `@/lib/query` beside `RELAY_KEY`, which is where `SyncPanel`'s own comment said they would
   * go the moment a second surface read them; this control is that surface.
   */
  const supporter = useQuery({ queryKey: SUPPORTER_KEY, queryFn: () => ipc.syncSupporterStatus() });
  const membership = supporterState(supporter.data ?? null);

  /**
   * `unknown` hides the control as surely as `never` does, and that is deliberate.
   *
   * They are different states and this is the one question both answer the same way: a read in
   * flight is not a membership, and drawing the control before the answer lands would flash a
   * Share button at every reader who has connected nothing — which is the one reader spec §9
   * says must not see it.
   */
  const connected = membership !== "unknown" && membership !== "never";

  const [publishing, setPublishing] = useState(false);
  const [withdrawing, setWithdrawing] = useState(false);
  const [opening, setOpening] = useState(false);
  /** The one line under the buttons: what the last press did, or why it did not. */
  const [note, setNote] = useState<string | null>(null);
  const shareRef = useRef<HTMLButtonElement | null>(null);

  /** The caret goes back to the button the layer was raised from — `Dialog` cannot know which
   *  control that was, and there is exactly one here. Declared above the writes because every
   *  one of them closes a layer. */
  const back = useCallback(() => shareRef.current?.focus(), []);

  const existing = useMemo(
    () => (target === null ? null : shareFor(shares.data ?? [], target)),
    [shares.data, target],
  );
  const stale = target !== null && shareIsStale(existing, target);
  const locked = target !== null && lockedOf(target);

  /** Every surface that reads a share is under one prefix, so one invalidation reaches the list
   *  and every fetched snapshot below it. */
  const settle = useCallback(
    (said: string) => {
      setNote(said);
      void client.invalidateQueries({ queryKey: SHARE_KEY });
    },
    [client],
  );

  const refresh = useMutation({
    mutationFn: (id: string) => ipc.shareRefresh(id),
    onSuccess: () => settle("Snapshot updated."),
    onError: (e: unknown) => setNote(ipcError(e)),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => ipc.shareRevoke(id),
    // **`back()` on both arms, because a confirmed press is still a layer closing.**
    // `ConfirmDialog` names `onDismiss` as the focus-return hook and *confirming* does not go
    // through it, so without this the caret lands on `<body>` and the reader's next Tab starts
    // at the top of the page. The publish path already did this; these two now agree with it.
    onSuccess: () => {
      setWithdrawing(false);
      back();
      settle("Sharing stopped. The link no longer answers.");
    },
    onError: (e: unknown) => {
      setWithdrawing(false);
      back();
      setNote(ipcError(e));
    },
  });

  /** A claim about the clipboard's contents, so it is made only once the write has resolved —
   *  and a refused write is reported rather than swallowed. `ExportDialog`'s rule. */
  const copy = useCallback((url: string) => {
    setNote(null);
    copyText(url).then(
      () => setNote("Link copied."),
      (e: unknown) => setNote(`Could not copy that link — ${ipcError(e)}`),
    );
  }, []);

  const rows = useCallback((): MenuItem[] => {
    if (target === null) return [];
    const publish: MenuItem = {
      kind: "action",
      id: "publish",
      label: target.kind === "collection" ? "Share your collection…" : "Share this folder…",
      Icon: Share2,
      disabled: locked ? true : undefined,
      reason: locked ? UNLOCK_FIRST : undefined,
      onSelect: () => setPublishing(true),
    };
    if (existing === null || existing.state === "revoked") {
      // A withdrawn row is kept until the next reconcile drops it, so the menu says so rather
      // than letting the link's death read as the app forgetting it was ever shared.
      return existing === null
        ? [publish]
        : [
            {
              kind: "action",
              id: "withdrawn",
              label: "Withdrawn",
              Icon: Link2Off,
              disabled: true,
              reason: "the link stopped answering",
              onSelect: () => {},
            },
            { kind: "separator", id: "after-withdrawn" },
            publish,
          ];
    }
    const state: MenuItem[] = [];
    if (stale) {
      state.push({
        kind: "action",
        id: "stale",
        label: "Stale",
        Icon: TriangleAlert,
        disabled: true,
        reason: "the folder is locked",
        onSelect: () => {},
      });
    }
    if (existing.state === "lapsed") {
      state.push({
        kind: "action",
        id: "lapsed",
        label: "Paused",
        Icon: TriangleAlert,
        disabled: true,
        reason: "your membership ended",
        onSelect: () => {},
      });
    }
    if (state.length > 0) state.push({ kind: "separator", id: "after-state" });
    return [
      ...state,
      {
        kind: "action",
        id: "copy",
        label: "Copy link",
        Icon: Copy,
        onSelect: () => copy(existing.url),
      },
      {
        kind: "action",
        id: "update",
        label: "Update now",
        Icon: RefreshCw,
        // The publish behind it refuses a locked folder before it reads, so the row that would
        // only ever produce that sentence greys instead — with the reason `Delete…` uses.
        disabled: locked ? true : undefined,
        reason: locked ? UNLOCK_FIRST : undefined,
        onSelect: () => refresh.mutate(existing.id),
      },
      { kind: "separator", id: "before-revoke" },
      {
        kind: "action",
        id: "revoke",
        label: "Stop sharing",
        Icon: Link2Off,
        onSelect: () => setWithdrawing(true),
      },
    ];
  }, [copy, existing, locked, refresh, stale, target]);

  const openMenu = useCallback(
    (e: MouseEvent<HTMLButtonElement>) => {
      setNote(null);
      menuClick(rows)(e);
    },
    [menuClick, rows],
  );

  const shareName =
    target === null
      ? ""
      : target.kind === "collection"
        ? "Share your collection"
        : `Share ${target.title}`;

  return (
    <div className="flex flex-col items-end gap-1">
      {/* The shape `ImportExportPair` beside it already draws: one bordered box with a hairline
          between, because these are one idea read in two directions rather than two loose
          buttons. The Share half is simply absent for a reader with nothing connected, which
          leaves a group of one — correct, since the remaining half needs no membership. */}
      <div
        role="group"
        aria-label="Sharing"
        className="flex shrink-0 overflow-hidden rounded-md border border-border bg-surface"
      >
        {target !== null && connected && (
          <button
            ref={shareRef}
            type="button"
            aria-label={shareName}
            // The popup *kind* is a fact about this button and is free; the expanded *state* is
            // a fact about `ContextMenuProvider`, which publishes only `openMenu`/`closeMenu` —
            // so a static `aria-expanded="false"` would be an assertion, wrong for exactly as
            // long as the menu is up. `CollectionFolderCard`'s `⋯` makes the same declaration.
            aria-haspopup="menu"
            onClick={openMenu}
            className={cn(SHARE_BUTTON, "gap-1.5 px-2.5")}
          >
            <Share2 className="size-4 shrink-0" aria-hidden="true" />
            Share
          </button>
        )}
        <button
          type="button"
          aria-haspopup="dialog"
          onClick={() => {
            setNote(null);
            setOpening(true);
          }}
          className={cn(
            SHARE_BUTTON,
            "gap-1.5 px-2.5",
            target !== null && connected && "border-l border-border",
          )}
        >
          <Link2 className="size-4 shrink-0" aria-hidden="true" />
          Open a shared collection
        </button>
      </div>

      {/* Mounted for the life of the control and the sentence swapped into it: a live region
          that appears together with its own text announces nothing, because there was no change
          for a screen reader to notice. `empty:hidden` keeps it from holding a gap open while it
          is saying nothing at all. */}
      <p role="status" className="max-w-72 text-right text-xs text-dim empty:hidden">
        {note}
      </p>

      {target !== null && (
        <PublishDialog
          open={publishing}
          target={target}
          suggestedName={shares.data?.[0]?.ownerName ?? ""}
          onPublished={() => {
            setPublishing(false);
            back();
            settle("Shared. The link is on the Share menu.");
          }}
          onClose={() => {
            setPublishing(false);
            back();
          }}
        />
      )}

      <ConfirmDialog
        open={withdrawing && existing !== null}
        title="Stop sharing"
        confirmLabel="Stop sharing"
        // Nothing typed: this deletes no card and no folder. What it costs is a link other
        // people may be holding, which is what the sentence below is for — and a typed word on
        // a question this size teaches readers to type it without reading.
        typeToConfirm={false}
        pending={revoke.isPending}
        onConfirm={() => existing !== null && revoke.mutate(existing.id)}
        onDismiss={() => {
          setWithdrawing(false);
          back();
        }}
        onClose={() => setWithdrawing(false)}
      >
        The link stops answering for everyone who has it, and it cannot be brought back. Your
        cards are not touched.
      </ConfirmDialog>

      <OpenShareDialog
        open={opening}
        onClose={() => setOpening(false)}
        // The dialog reports that a link answered and does not decide where the reader goes —
        // which is what lets it be drawn from inside the shared view as well as from here.
        onOpened={() => setActiveView("shared")}
      />
    </div>
  );
}

/** One button of the pair. `ImportExportPair`'s box, so the two groups read as one row. */
const SHARE_BUTTON = cn(
  "inline-flex h-9 shrink-0 items-center justify-center whitespace-nowrap text-xs text-dim",
  "transition-colors duration-150 hover:text-text motion-reduce:transition-none",
  FOCUS,
);

/* ------------------------------------------------------------------ the publish ---------- */

/**
 * The publish form.
 *
 * **A component of its own so its draft dies with the dialog.** `Dialog` mounts nothing while
 * it is closed, so a name half-typed and cancelled is gone on the next open with no effect to
 * reset it — the rule `ConfirmDialog` states about its typed word, applied to three switches and
 * a name.
 */
function PublishDialog({
  open,
  target,
  suggestedName,
  onPublished,
  onClose,
}: {
  open: boolean;
  target: ShareTarget;
  /** What this group already publishes under — spec §4.3, so the second device inherits the
   *  name from `share_list` rather than asking the reader to type it again. */
  suggestedName: string;
  onPublished: () => void;
  onClose: () => void;
}): JSX.Element {
  return (
    <Dialog
      open={open}
      title={target.kind === "collection" ? "Share your collection" : `Share ${target.title}`}
      subtitle="Anyone with the link sees a read-only snapshot. It needs no account."
      closeLabel="Close share"
      size="w-[32rem]"
      onDismiss={onClose}
      onClose={onClose}
    >
      <PublishForm
        target={target}
        suggestedName={suggestedName}
        onPublished={onPublished}
        onClose={onClose}
      />
    </Dialog>
  );
}

function PublishForm({
  target,
  suggestedName,
  onPublished,
  onClose,
}: {
  target: ShareTarget;
  suggestedName: string;
  onPublished: () => void;
  onClose: () => void;
}): JSX.Element {
  /**
   * The reader's own answer, and `null` until they have typed one.
   *
   * ⚠️ **`useState(suggestedName)` is what this must not be**, and the bug is a race rather than
   * a style: `Dialog` mounts nothing while it is closed, so the seed is read once — on the open —
   * and `share_list` reaches the *relay* before it answers. A reader who opened this dialog
   * before that round trip landed would have got an empty *Your name* **for good**, and re-typed
   * a name their group already publishes under (spec §4.3). Harmless only while
   * `publish.rs`'s placeholder base short-circuits every publish; a real bug on deploy day.
   *
   * `null` rather than a `key` on this component, which was the other fix on the table: re-keying
   * remounts the form, so an answer landing *while the reader is typing* would throw their draft
   * away. Here the first keystroke wins permanently and a deliberately emptied field stays empty
   * — the suggestion is a suggestion, never a value that comes back.
   */
  const [typed, setTyped] = useState<string | null>(null);
  const name = typed ?? suggestedName;
  const [fields, setFields] = useState<ShareFields>({
    condition: false,
    lang: false,
    value: false,
  });
  const [refusal, setRefusal] = useState<string | null>(null);
  const publish = useMutation({
    mutationFn: () => ipc.shareCreate(uidOf(target), name.trim(), fields),
    onSuccess: onPublished,
    onError: (e: unknown) => setRefusal(ipcError(e)),
  });

  const ready = name.trim() !== "" && !publish.isPending;

  return (
    <form
      className="flex flex-col gap-4 p-5"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) {
          setRefusal(null);
          publish.mutate();
        }
      }}
    >
      <div className="flex flex-col gap-1.5">
        <label htmlFor="share-owner" className="text-sm text-dim">
          Your name
        </label>
        <input
          id="share-owner"
          type="text"
          value={name}
          onChange={(e) => {
            setTyped(e.target.value);
            setRefusal(null);
          }}
          placeholder="The name on the page"
          autoComplete="off"
          className={cn(
            "h-9 rounded-md border border-border bg-surface px-3 text-sm text-text",
            "placeholder:text-dim",
            FOCUS,
          )}
        />
        {/* Never anything Patreon supplied — spec §4.3. The relay holds a Patreon id in exactly
            one column of one table, and a display name pulled from the OAuth profile would put a
            reader's legal name on a public page because they once pressed Connect. */}
        <p className="text-xs text-dim">Shown at the top of the page. Nothing else identifies you.</p>
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm text-dim">Also send</legend>
        <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
          {FIELD_ROWS.map(({ key, label }) => (
            <label key={key} className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={fields[key]}
                onChange={(e) => setFields((f) => ({ ...f, [key]: e.target.checked }))}
                className={cn("size-4 accent-accent", FOCUS)}
              />
              {label}
            </label>
          ))}
        </div>
        {/* Spec decision 3: these six are absent from the format rather than switched off in it,
            so there is no switch that could ever turn one on. Saying so is the point — a reader
            deciding whether to publish a binder is deciding about their notes and what they
            paid. */}
        <p className="text-xs text-dim">
          Purchase price, where you got a card, when, and your notes never leave this device.
        </p>
      </fieldset>

      {refusal !== null && (
        // `alert`, not `status`: this region is mounted only when there is something to say, and
        // announcing on insertion is what the role is for.
        <p role="alert" className="text-sm text-destructive">
          {refusal}
        </p>
      )}

      <div className="flex justify-end gap-2">
        <button type="button" onClick={onClose} className={cn(BUTTON, "border-border")}>
          Cancel
        </button>
        <button
          type="submit"
          // `aria-disabled`, never the attribute: a `disabled` button leaves the tab order, and
          // this one greys as the reader types.
          aria-disabled={!ready}
          onClick={(e) => {
            if (!ready) e.preventDefault();
          }}
          className={cn(BUTTON, "border-accent/50 text-accent", !ready && "opacity-50")}
        >
          {publish.isPending ? "Publishing…" : "Publish"}
        </button>
      </div>
    </form>
  );
}

/**
 * The three switches, by name.
 *
 * ⚠️ **Each field is `#[serde(default)]` on the far side, so a misspelling here is not a
 * refusal** — it arrives `false`, the publish succeeds, and the column the reader ticked is
 * missing from every card in the snapshot. `ipc.test.ts` pins all three against the crate.
 */
const FIELD_ROWS: readonly { key: keyof ShareFields; label: string }[] = [
  { key: "condition", label: "Condition" },
  { key: "lang", label: "Language" },
  { key: "value", label: "Value" },
];
