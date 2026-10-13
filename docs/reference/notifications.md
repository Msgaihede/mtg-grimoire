# Toasts and notifications

The app's one way to tell the reader what just happened (2026-10-12). Before it, every surface
that had something to say grew its own sentence — a line under a nav entry, a note in a menu, a
`Copied` beside a button — and a great many writes said nothing at all: a card copied from a
context menu, a card filed into a deck from one, an export saved to disk.

## The API

```ts
import { notify } from "@/lib/notifications";

notify({ title: "Export saved", body: "Atraxa.txt", tone: "success", duration: 4000 });
notify.success("Copied “Lightning Bolt”");
notify.error("Couldn't open Scryfall", { body: ipcError(e), duration: null });
notify.info("Prices refreshed", { toast: false }); // inbox only
```

| Option | Meaning |
| --- | --- |
| `title` | The sentence — the toast's first line and the inbox row's heading. |
| `body` | An optional second line, dimmer: the backend's refusal, the file written. |
| `tone` | `info` (default), `success`, `warning`, `error`. Picks the glyph and colour; `error` is announced as an `alert`, the rest as a polite `status`. |
| `duration` | Milliseconds before the toast closes itself — the **sender's** call. `null` keeps it until its ✕ is pressed. Absent: `DEFAULT_TOAST_MS` per tone (info 5s, success 4s, warning 7s, error 8s). |
| `toast` | `false` files the notice in the inbox without a toast. |

`notify` is a plain function over a zustand store, so it is callable from a component, a mutation
callback, a `then` handler or a module function alike — no hook and no provider.

## What the reader sees

- **Toasts** — `components/Toaster.tsx`, mounted once in `AppShell`, `fixed` in the window's
  bottom-right corner at `LAYER.toast` (above every dialog rung, below `menuOverDialog`, the tooltip
  and the sync gate). Newest at the bottom, at most `TOAST_CAP` (4) at once — the oldest closes
  first and stays in the inbox. Each has a ✕. The clock **pauses while the pointer or the caret
  is on the toast** and resumes with only the time it had left.
- **The inbox** — `components/NotificationsDialog.tsx`, opened from the rail's **Notifications**
  entry above the collapse toggle. Every notice this device has kept, newest first, with when it
  arrived; a row can be removed, or the whole list cleared. The entry carries an unread count
  (a pip on the bell when the rail is collapsed); opening the inbox reads everything in it.

## The rule for collection, wishlist and deck edits

**Every deliberate edit of the reader's cards publishes a toast, and so a notification** (the
owner's rule, 2026-10-12). That is any add, remove or move of cards into, out of or between the
collection, a wishlist or a deck, or their folders, from any surface: a context menu, a dialog
or confirm, a sidebar drop, a bulk action, an import, the scanner, a finished trade.

- Success says what changed and where, with a count when there is more than one card:
  `Added “Sol Ring” to “Atraxa”`, `Moved 4 cards to “Trade binder”`,
  `Removed 12 cards from the collection`.
- **One action is one toast.** A picked set moved, removed or added in one press (50 cards
  dragged to a deck, a multi-select `Move to`, a bulk remove) is a single toast with the count:
  `Moved 50 cards to “Trade binder”`. Never one toast per card. A loop of per-card writes reports
  once, after the loop. A partial failure is folded into that one toast:
  `notify.warning("Moved 47 of 50 cards to “Trade binder”", { body: firstRefusal })`, or
  `notify.error` when none landed. `useCardToDeck`'s `deckAddReceipt` is the pattern.
- Failure is `notify.error("Couldn't …", { body: ipcError(e) })`, never swallowed.
- The call goes at the **deliberate call site** (the menu row, the dialog's confirm, the drop
  handler), never in a shared mutation hook's `onSuccess`, which also runs for every stepper click.

**Exempt, by the owner's choice:** quantity steppers, Quick Add, and drags or reorders inside
the open deck editor or list. Those changes are drawn right where the reader is looking, and a
toast per click would fill the corner. Undo bars (`UndoNotice`) stay inline next to the receipt.

## What it is not

- **Not synced — per device** (the owner's decision, 2026-10-12). The inbox is kept in the
  webview's own `localStorage` (`STORAGE_KEY`, `grimoire.notifications`), the arrangement
  `apps/light/phone/wallDensity.ts` uses, and **never** in SQLite: `app_meta` and the user tables
  are what device sync carries, and a notice is a fact about what this machine did ("Export saved"
  to a path on this disk). It survives a restart on this device and reaches no other. Capped at
  `NOTICE_CAP` (100) newest. Toasts are never stored.
- **Shared by the windows of one device.** Each window writes its whole inbox on a change and
  adopts another's on the `storage` event. Two windows changing it in the same instant: the last
  write wins.
- **Fails quiet.** Every `localStorage` access is in a `try`; a refusal (private window,
  locked-down webview) keeps the inbox for the session.
- **Not a replacement for an inline answer** where the reader is still looking at the control:
  a dialog's own refusal line (`ExportDialog`, `UndoNotice`) stays where it is. A toast is for an
  answer whose surface has closed (a context menu) or is somewhere else (a deck on another page),
  and for the receipt a write never gave.
- **Not on the light app's phone face yet.** `notify` is safe to call there — it only writes the
  store — but `PhoneApp` mounts no `Toaster`, so nothing is drawn. Shared surfaces that the phone
  also draws keep an inline line beside the toast until it does.

## Who calls it today

The sweep of 2026-10-12 put every surface on it. By area:

| Area | Toasts | Stays inline / no toast |
| --- | --- | --- |
| Card menu, card modal, All printings (`features/card/`) | Adds to collection / wishlist / deck (one per press, picked sets batched by `menuReceipts.ts`'s `filingBatcher`), moves, printing swaps and splits, copy name/image, set deck image; refused `Open on …` links (`refusedOpen.ts`) | Steppers; category/label/printing pickers inside the open modal |
| Sidebar drops (`components/useSidebarDrops.ts`) | `Added N cards to “Deck”` / `… to the wishlist`, one per drop, partials folded | — (the rail's self-clearing report line is gone) |
| Collection (`features/collection/`, wording in `collectionReceipts.ts`) | Removes (row, menu, bulk confirm), Recently removed clear, copy-picker moves, drops from the search column, folder create/rename/move/delete/lock, Edit copy save, share link copy / publish / stop | Steppers, Quick Add popup, drags between shelves of the open wall, folder reorders. `UndoNotice` stays beside the receipt |
| Wishlist (`features/wishlist/`) | Removes, panel moves, search-column drops, folder move/delete/clear | Steppers, drags inside the list, folder reorders, rename/create in place |
| Deck gallery (`features/decks/` gallery side, `useDecks.ts`'s `receipt`) | Deck/folder move, duplicate, archive/restore, delete, menu tags, create (`CreateDeckDialog`, one receipt for every host — `receipt` prop to override), settings folder move, Clear list | Autosaving settings fields, renames, folder reorders |
| Deck editor (`features/decks/`, wording and bulk folding in `receipts.ts`) | Card menu category/label/finish/commander/deck image/remove/add-to-other-list (one per press over a picked set), Delete key over a picked set, missing-copies quick add and pull, Clear stack, quick unwish, delete category, auto-categorize, label remove/delete, pull and add-missing dialogs, Compare sends, Stats send-missing, note/to-do deletes, token add/swap/remove, docked search panel adds, Collection tab moves; Quick zones' `already in` line is now an info toast | Steppers, Quick Add, drags/reorders in the open deck |
| Import (`features/transfer/import/`, `ImportDialog` passes `report={notify}`) | One toast per import with counts, partial binder imports as one warning | The commit bar's refusal line stays too; the phone's `ImportSheet` keeps its own receipt line |
| Export | `Export saved` | `Copied` stays inline (the dialog stays open) |
| Scanner | One toast per tray Add (never per scan — the camera overlay already says each), tray clear, create deck from the tray, scan sent (inbox only) | Per-scan landings, pre-write tray refusals |
| Trade | Create, finish, delete, archive, duplicate | Rename, reopen, swap sides, line edits |
| Settings (`features/settings/`) | Complete backup save/restore, clear collection/wishlist/decks, clear cache, refresh combos, device paired/removed, leave group, delete label, clear error log, marketplace refresh, start view save failure | Switches and fields whose state is drawn. Danger-zone, cache and pairing lines stay inline too, because the phone face draws those panels with no `Toaster` |
| Undo (`components/UndoNotice.tsx`) | `Undone` once an Undo lands | The bar and its refusal |
| Shared page, sticky notes, tag rail | Add to wishlist from a share, note deleted, tag hidden | — |

**Inline failure banners that a toast now repeats.** The gallery's, collection's and wishlist's
page banners and Deck settings' banner still draw a refusal under the owner's "failure is
`notify.error`" rule, so a refused write there says so twice. Retiring them is a follow-up.

Tests: `test-setup.ts` resets the store, and through it the stored copy, after every test
(`resetNotifications`).
