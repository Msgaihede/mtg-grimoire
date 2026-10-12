/**
 * The app's one place to tell the reader what just happened: a **toast** in the bottom-right
 * corner for now, and a **notification** in the rail's inbox for later.
 *
 * **Every `notify` is both, by construction.** A toast is a notification that is still on screen;
 * there is no way to raise one without the other, so the inbox is a complete record of every
 * sentence a toast has shown — a reader who looked away while one timed out finds it there.
 *
 * **Callable from anywhere, React or not**, because the things that have something to say are
 * mutation callbacks, `then` handlers and module functions as often as components: a zustand store
 * is module state, and `notify` writes it through `getState()` with no hook and no provider. Only
 * the drawing side — `Toaster` and `NotificationsDialog` — subscribes.
 *
 * **Per device, and never synced** (the owner's decision, 2026-10-12). The inbox is kept in the
 * webview's own `localStorage` under {@link STORAGE_KEY} — `apps/light/phone/wallDensity.ts`'s
 * arrangement — and **never** in SQLite: `app_meta` and the user tables are what device sync
 * carries, and a notice is a fact about what *this* machine did ("Export saved" to a path on this
 * disk). So it outlives a restart on this device and reaches no other. Every access is inside a
 * `try`, because `localStorage` can refuse being named at all (a private window, a locked-down
 * webview); a refusal keeps the inbox for the session and says nothing.
 *
 * **Two windows on one device share it**: each writes its whole inbox on every change, and each
 * adopts the other's on the `storage` event, which the browser fires in every window *but* the
 * writer. Toasts are never stored — a toast is the window it was raised in.
 *
 * It is capped at {@link NOTICE_CAP}, newest kept, so a loop that notifies cannot grow it (or the
 * stored copy) without bound.
 */
import { create } from "zustand";

/** What a notice is about, which picks its glyph and its colour — and how long it stays by default. */
export type NoticeTone = "info" | "success" | "warning" | "error";

/** One entry in the inbox. */
export interface Notice {
  id: number;
  /** The sentence. Short — it is the toast's first line and the inbox row's heading. */
  title: string;
  /** An optional second line: the backend's refusal, the file that was written. */
  body?: string;
  tone: NoticeTone;
  /** `Date.now()` when it was raised — the inbox's order and its timestamp. */
  at: number;
  /** Whether the inbox has been opened since this arrived. Drives the rail's unread count. */
  read: boolean;
}

/** One toast on screen: a notice's id and how long it stays. */
export interface LiveToast {
  id: number;
  /** Milliseconds before it closes itself, or `null` to stay until its ✕ is pressed. */
  duration: number | null;
}

export interface NotifyOptions {
  title: string;
  body?: string;
  /** `"info"` when absent. */
  tone?: NoticeTone;
  /**
   * How long the toast stays, in milliseconds — the **sender's** call, since only it knows whether
   * the sentence is a receipt or a refusal worth reading twice. `null` keeps it until the reader
   * closes it. Absent, {@link DEFAULT_TOAST_MS} for the tone.
   *
   * The clock **pauses while the pointer or the caret is on the toast** (`Toaster`), so a reader
   * reaching for the ✕ never has it vanish under them.
   */
  duration?: number | null;
  /**
   * `false` records the notice in the inbox without a toast — for something worth keeping that the
   * surface it happened on already said out loud.
   */
  toast?: boolean;
}

/**
 * The default stay, by tone. A refusal is the one a reader most needs to read in full, so it stays
 * longest; a receipt for something the reader just did and can see is the shortest.
 */
export const DEFAULT_TOAST_MS: Record<NoticeTone, number> = {
  info: 5000,
  success: 4000,
  warning: 7000,
  error: 8000,
};

/**
 * How many toasts are on screen at once. The oldest is closed when a newer one would exceed it —
 * it is still in the inbox, so nothing is lost, and a column of toasts climbing the window is a
 * wall over the page the reader is working in.
 */
export const TOAST_CAP = 4;

/** How many notices the inbox keeps, newest first. */
export const NOTICE_CAP = 100;

interface NotificationState {
  /** Newest first — the inbox's order, so it draws without sorting. */
  notices: Notice[];
  /** Oldest first — the order they stack in, bottom-up from the corner. */
  toasts: LiveToast[];
}

const EMPTY: NotificationState = { notices: [], toasts: [] };

/** Where this device keeps its inbox. Local storage, never the synced database — see above. */
export const STORAGE_KEY = "grimoire.notifications";

/** Whether a stored value is a notice this build can draw — anything else is dropped. */
function isNotice(value: unknown): value is Notice {
  if (typeof value !== "object" || value === null) return false;
  const n = value as Record<string, unknown>;
  return (
    typeof n.id === "number" &&
    typeof n.title === "string" &&
    (n.body === undefined || typeof n.body === "string") &&
    (n.tone === "info" || n.tone === "success" || n.tone === "warning" || n.tone === "error") &&
    typeof n.at === "number" &&
    typeof n.read === "boolean"
  );
}

/** The stored inbox, or empty when there is none, it cannot be read, or it is not one. */
function parseNotices(raw: string | null): Notice[] {
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isNotice).slice(0, NOTICE_CAP) : [];
  } catch {
    return [];
  }
}

function readNotices(): Notice[] {
  try {
    return parseNotices(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return [];
  }
}

function writeNotices(notices: Notice[]): void {
  try {
    if (notices.length === 0) window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, JSON.stringify(notices));
  } catch {
    // Kept for the session.
  }
}

export const useNotifications = create<NotificationState>(() => ({
  notices: readNotices(),
  toasts: [],
}));

/**
 * Ids are milliseconds times a thousand plus a per-window sequence: two notices raised in one
 * millisecond are still two (`AnimatePresence` keys a toast's exit on the id), a notice raised
 * after a restart never shares one with a stored notice, and two windows raising one in the same
 * instant collide only if they also land on the same sequence number. **Never behind the newest
 * id this window has seen**, so a clock stepped backwards cannot reuse one.
 */
let lastId = useNotifications.getState().notices.reduce((max, n) => Math.max(max, n.id), 0);
let sequence = 0;

function newId(): number {
  sequence = (sequence + 1) % 1000;
  lastId = Math.max(lastId + 1, Date.now() * 1000 + sequence);
  return lastId;
}

/**
 * **Written whenever the inbox changes, by identity** — a toast closing changes `toasts` alone and
 * writes nothing. A notice adopted from another window is written back unchanged, which fires no
 * `storage` event there (the value is equal), so the two windows never echo.
 */
useNotifications.subscribe((state, previous) => {
  if (state.notices !== previous.notices) writeNotices(state.notices);
});

/** Another window on this device changed the inbox: adopt it, keeping this window's toasts. */
function adopt(e: StorageEvent): void {
  if (e.key !== STORAGE_KEY && e.key !== null) return;
  const notices = parseNotices(e.newValue);
  lastId = notices.reduce((max, n) => Math.max(max, n.id), lastId);
  useNotifications.setState((s) => ({
    notices,
    toasts: s.toasts.filter((t) => notices.some((n) => n.id === t.id)),
  }));
}

try {
  window.addEventListener("storage", adopt);
} catch {
  // No window to listen on (a Worker importing this by accident): nothing to adopt.
}

/**
 * Raise a notice: a toast now and an inbox entry for later. Answers its id, which
 * {@link dismissToast} takes.
 */
export function notify(options: NotifyOptions): number {
  const id = newId();
  const tone = options.tone ?? "info";
  const notice: Notice = {
    id,
    title: options.title,
    ...(options.body !== undefined && { body: options.body }),
    tone,
    at: Date.now(),
    read: false,
  };
  const duration = options.duration === undefined ? DEFAULT_TOAST_MS[tone] : options.duration;
  useNotifications.setState((s) => ({
    notices: [notice, ...s.notices].slice(0, NOTICE_CAP),
    toasts: options.toast === false ? s.toasts : [...s.toasts, { id, duration }].slice(-TOAST_CAP),
  }));
  return id;
}

/** Shorthand for the four tones — `notify.success("Copied")`. */
notify.info = (title: string, rest?: Omit<NotifyOptions, "title" | "tone">) =>
  notify({ ...rest, title, tone: "info" });
notify.success = (title: string, rest?: Omit<NotifyOptions, "title" | "tone">) =>
  notify({ ...rest, title, tone: "success" });
notify.warning = (title: string, rest?: Omit<NotifyOptions, "title" | "tone">) =>
  notify({ ...rest, title, tone: "warning" });
notify.error = (title: string, rest?: Omit<NotifyOptions, "title" | "tone">) =>
  notify({ ...rest, title, tone: "error" });

/** Take a toast off the screen. Its notice stays in the inbox. */
export function dismissToast(id: number): void {
  useNotifications.setState((s) =>
    s.toasts.some((t) => t.id === id) ? { toasts: s.toasts.filter((t) => t.id !== id) } : s,
  );
}

/** The inbox has been opened: every notice in it has been seen. */
export function markAllRead(): void {
  useNotifications.setState((s) =>
    s.notices.some((n) => !n.read) ? { notices: s.notices.map((n) => ({ ...n, read: true })) } : s,
  );
}

/** Delete one notice from the inbox, and its toast if it is still up. */
export function removeNotice(id: number): void {
  useNotifications.setState((s) => ({
    notices: s.notices.filter((n) => n.id !== id),
    toasts: s.toasts.filter((t) => t.id !== id),
  }));
}

/** Empty the inbox. Toasts still on screen close with it — they are its newest entries. */
export function clearNotices(): void {
  useNotifications.setState(EMPTY);
}

/** How many notices arrived since the inbox was last opened — the rail's badge. */
export function useUnreadCount(): number {
  return useNotifications((s) => s.notices.reduce((n, notice) => n + (notice.read ? 0 : 1), 0));
}

/** For `test-setup.ts`: module state, so one test's toast is not the next test's. Empties the
 *  stored copy too, through the subscription above. */
export function resetNotifications(): void {
  useNotifications.setState(EMPTY);
}
