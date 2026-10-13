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

- **Toasts** — `components/Toaster.tsx`, mounted once per face (`AppShell` on the desktop,
  `PhoneFace` on the light app's phone), `fixed` in the window's bottom-right corner at `LAYER.toast` (above every dialog rung, below `menuOverDialog`, the tooltip
  and the sync gate). Newest at the bottom, at most `TOAST_CAP` (4) at once — the oldest closes
  first and stays in the inbox. Each has a ✕. The clock **pauses while the pointer or the caret
  is on the toast** and resumes with only the time it had left.
- **The inbox** — `components/NotificationsDialog.tsx`, opened from the rail's **Notifications**
  entry above the collapse toggle (the bell in the header on the phone). Every notice this device has kept, newest first, with when it
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
- Failure is `notify.error("Couldn't …", { body: ipcError(e) })`, never swallowed. A page banner
  that also hears the write seats it `toasted` so the refusal is said once (see
  [Page banners and the toast](#page-banners-and-the-toast-2026-10-13)).
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

## On the light app's phone face

Since 2026-10-13 the phone face (`apps/light/phone/PhoneApp.tsx`) mounts its own `Toaster` and
`NotificationsDialog`, once each, as siblings of its `Shell` — the store is module state, so the
same `notify` reaches both faces and no shared surface asks which one it is on.

- **Where the stack stands** is the face's `className` on `Toaster` (`PHONE_TOASTS`): across the
  width, 8px in from each side plus the side's safe-area inset, and **lifted over the tab bar
  (52px), one receipt line (48px) and the bottom inset**. Every card write on the phone also draws
  its receipt line (`phone/deck/receipt.tsx`) with that write's `Undo` at the foot of the page or
  sheet it came from, and a toast standing on the line would cover the `Undo` for its whole stay.
  Over a deck (`/decks/<id>`) it stands one strip higher again, over the deck page's action bar
  (`PHONE_TOASTS_OVER_DECK`). From 600px the tab bar is a rail on the left, so the stack goes back
  to a 320px column on the right, lifted over a receipt line and the bottom inset. The layer stays
  `LAYER.toast`, above every sheet.
- **A finger's floor**: the toast's ✕ and the inbox's row ✕ grow to `--target-min` under
  `coarse:` (`Dialog`'s ✕ recipe); *Clear all* is `PANEL_BUTTON`. Under a mouse nothing moves.
- **The inbox is the header's bell**, beside the Settings gear: a 44px button with the unread
  count as a pip and in its name (`Notifications, 2 unread`). The dialog is lent a Back step by the
  face's dialog host like any other sheet.
- **The receipt lines stay.** They are the phone's undo bars — the `UndoNotice` of this face — and
  the surfaces that draw them are still open. The toast is the receipt the inbox keeps.
- **What the phone's own write sites say** is the desktop's words for the same write, at the press
  (`phone/toasted.ts` hands the write back to the receipt line): the card sheet's adds to the
  collection, the wishlist and the deck below it; a copy or a wish removed or moved from its
  sheet; a deck row moved to another pile (a command-zone claim included), added to the other list,
  or removed; each press of the deck's *Add cards* search; and an import (`ImportSheet` passes
  `report={notify}`). A step of a stepper says nothing — but the last step down *is* the removal,
  closes the sheet, and toasts as the removal does. A grade, a finish, a printing or a label is an
  edit to the row in a sheet that stays open on it, and its line answers.

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
| Import (`features/transfer/import/`, `ImportDialog` and the phone's `ImportSheet` pass `report={notify}`) | One toast per import with counts, partial binder imports as one warning | The commit bar's refusal line stays too (the sheet is still open there); the phone deck page's receipt line is only the deck's undo after an import, no longer its sentence |
| Export | `Export saved` | `Copied` stays inline (the dialog stays open) |
| Scanner | One toast per tray Add (never per scan — the camera overlay already says each), tray clear, create deck from the tray, scan sent (inbox only) | Per-scan landings, pre-write tray refusals |
| Trade | Create, finish, delete, archive, duplicate | Rename, reopen, swap sides, line edits |
| Settings (`features/settings/`) | Complete backup save/restore, clear collection/wishlist/decks, clear cache, refresh combos, device paired/removed, leave group, delete label, clear error log, marketplace refresh, start view save failure | Switches and fields whose state is drawn; a pairing that ran out of time and a pairing step's refusal. The danger-zone, cache and *Paired* lines are gone (2026-10-13): they stood only because the phone face had no `Toaster` |
| Undo (`components/UndoNotice.tsx`) | `Undone` once an Undo lands | The bar and its refusal |
| Shared page, sticky notes, tag rail | Add to wishlist from a share, note deleted, tag hidden | — |
| Light app phone face (`apps/light/phone/`) | Card sheet adds (collection, wishlist, deck), copy/wish remove and move, deck row pile move/claim/add to other list/remove, *Add cards* presses, imports — see *On the light app's phone face* | Steppers (bar the last step down), grade/finish/printing/label edits, every receipt line and its `Undo` |

## Page banners and the toast (2026-10-13)

Five surfaces kept a red banner from before the toasts — `Couldn't change your decks`, `… your
collection`, `… your wishlist`, `… this deck`, and Deck settings' `Couldn't save that change` —
and the "failure is `notify.error`" rule made each say a refused edit twice. Every one of them is
**kept**, because each also speaks for writes the owner's rule exempts from toasts, which have no
other report. What changed is that a banner now draws **only** those: a write whose refusal a
toast has already said is seated in its list through `lib/writes.ts`' `toasted(write)`, which
keeps the write's timing (a newer toasted write still takes down an older refusal — the
newest-write rule) and drops its refusal.

| Banner | Still draws | Now the toast's alone |
| --- | --- | --- |
| Deck gallery (`DecksPage`) | A deck or folder renamed, a folder created in place (the field stays open for another try), a folder reordered within its level | Moves, duplicate, archive/restore, tags, delete, folder move/delete, a folder re-parented by a drop |
| Deck settings (`DeckSettingsDialog`) | Every autosaving field and switch, and the tags (the dialog stays open) | The Folder select and Clear list |
| Collection (`CollectionPage`) | Steppers, a copy dragged between shelves, folder create/rename/reorder | ✕ remove, bulk remove, Recently removed clear, the copy picker, a confirmed locked crossing, search-column drops, folder move/delete/lock |
| Wishlist (`WishlistPage`) | Steppers, `Any printing`, a wish dragged onto a shelf, folder create/rename/reorder | Remove, the Edit panel's move, search-column drops, folder move/delete/clear |
| Deck editor (`DeckEditor`) | Steppers and drags (cards, piles, the token rail), the name/bracket/band switches, pile rename, undo, and the token writes while the band is shut | Every card-menu row, Delete over a picked set, the quick category's filing, label/category/clear dialogs, the Collection submenu (its reads included) |

**Telling two kinds of press apart on one observer.** An observer knows only its newest call, so a
write that serves both a toasted press and an exempt one needs a way to say which it was:

- **By its variables**, where they differ — the gallery's `decks.update` (a patch naming a `name`
  is the rename field) and `folders.reorder` (a landing that moves no folder to another parent).
- **By a second observer** — the wishlist's `moveWish` and the collection's `moveCopy`, the same
  filing write as the drags' `setFolder` for the presses that toast.
- **By a record stamped after the press settles** — the deck editor's `reportToasted`, for
  `setQuantity`, `moveCard` and `update`, whose menu presses and steppers send the same shape.
  It shares `lastBatch` with the drags' `reportBatch`, marked `toasted`, and is newer than the
  observer's own call, so the banner reads it and says nothing.

**The token writes keep the editor's banner** while the Tokens & Emblems wall is shut: their
promises answer only whether they landed, so the toast says `Couldn't add the token to the deck`
without the reason, and the banner is where the backend's sentence is drawn.

**The Pull and Add-missing dialogs keep their own refusal line** beside the toast. The dialog does
not close on a refusal, and the line sits beside the button the reader will press again; it is
the `done` readout's arrangement for a success. Opening either dialog from the editor resets its
mutation, because the card menu's silent pull and picked-set quick add are calls on the same
observer and their refusal is already a toast.

Tests: `test-setup.ts` resets the store, and through it the stored copy, after every test
(`resetNotifications`).
