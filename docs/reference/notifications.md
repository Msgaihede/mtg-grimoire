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
  store — but `PhoneApp` mounts no `Toaster`, so nothing is drawn.

## Who calls it today

| Where | Says |
| --- | --- |
| `features/card/cardMenu.tsx` `run` | Copy card name / image: a receipt, or the clipboard's refusal; `Open on …`: a refused open. |
| `features/card/cardMenu.tsx` `useCardToDeck` | `Added “Sol Ring” to “Atraxa”` / `Added 3 cards to …` once a menu or card-modal add lands. The refusal stays the rail's alert line. |
| `features/transfer/export/ExportDialog.tsx` | `Export saved` with the file name, once the native save dialog's write lands. |

Tests: `test-setup.ts` resets the store, and through it the stored copy, after every test
(`resetNotifications`).
