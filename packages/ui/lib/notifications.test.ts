import { renderHook } from "@testing-library/react";
import { act } from "react";
import { describe, expect, it } from "vitest";
import {
  clearNotices,
  DEFAULT_TOAST_MS,
  dismissToast,
  markAllRead,
  notify,
  NOTICE_CAP,
  removeNotice,
  STORAGE_KEY,
  TOAST_CAP,
  useNotifications,
  useUnreadCount,
} from "./notifications";

const state = () => useNotifications.getState();

describe("notify", () => {
  it("raises a toast and an inbox entry together, unread, at the tone's default stay", () => {
    const id = notify({ title: "Saved", tone: "success" });

    expect(state().notices).toEqual([
      expect.objectContaining({ id, title: "Saved", tone: "success", read: false }),
    ]);
    expect(state().toasts).toEqual([{ id, duration: DEFAULT_TOAST_MS.success }]);
  });

  it("is info by default, and takes the sender's own stay — null keeps it up", () => {
    const a = notify({ title: "A" });
    const b = notify({ title: "B", duration: 1500 });
    const c = notify({ title: "C", duration: null });

    expect(state().notices.find((n) => n.id === a)?.tone).toBe("info");
    expect(state().toasts).toEqual([
      { id: a, duration: DEFAULT_TOAST_MS.info },
      { id: b, duration: 1500 },
      { id: c, duration: null },
    ]);
  });

  it("files a notice without a toast when asked to", () => {
    notify({ title: "Quiet", toast: false });

    expect(state().notices).toHaveLength(1);
    expect(state().toasts).toEqual([]);
  });

  it("keeps the inbox newest first, and the shorthands set the tone", () => {
    notify.success("one");
    notify.error("two", { body: "because" });
    notify.warning("three");

    expect(state().notices.map((n) => [n.title, n.tone])).toEqual([
      ["three", "warning"],
      ["two", "error"],
      ["one", "success"],
    ]);
    expect(state().notices[1].body).toBe("because");
  });

  it("caps the toasts on screen, closing the oldest — which stays in the inbox", () => {
    const ids = Array.from({ length: TOAST_CAP + 1 }, (_, i) => notify({ title: `n${i}` }));

    expect(state().toasts.map((t) => t.id)).toEqual(ids.slice(1));
    expect(state().notices).toHaveLength(TOAST_CAP + 1);
  });

  it("caps the inbox, keeping the newest", () => {
    for (let i = 0; i < NOTICE_CAP + 5; i++) notify({ title: `n${i}`, toast: false });

    expect(state().notices).toHaveLength(NOTICE_CAP);
    expect(state().notices[0].title).toBe(`n${NOTICE_CAP + 4}`);
  });
});

describe("the inbox", () => {
  it("keeps a dismissed toast's notice", () => {
    const id = notify({ title: "Kept" });
    dismissToast(id);

    expect(state().toasts).toEqual([]);
    expect(state().notices).toHaveLength(1);
  });

  it("counts unread notices until it is opened", () => {
    const { result } = renderHook(() => useUnreadCount());
    expect(result.current).toBe(0);

    act(() => {
      notify({ title: "a" });
      notify({ title: "b" });
    });
    expect(result.current).toBe(2);

    act(markAllRead);
    expect(result.current).toBe(0);
  });

  it("removes one notice and its toast, or empties everything", () => {
    const a = notify({ title: "a" });
    notify({ title: "b" });

    removeNotice(a);
    expect(state().notices.map((n) => n.title)).toEqual(["b"]);
    expect(state().toasts.map((t) => t.id)).not.toContain(a);

    clearNotices();
    expect(state()).toMatchObject({ notices: [], toasts: [] });
  });
});

/**
 * Per device and never synced (2026-10-12): the inbox lives in this webview's `localStorage` and
 * nowhere the device sync reads.
 */
describe("the stored inbox", () => {
  it("is written to this device's local storage, without the toasts", () => {
    notify.success("Export saved", { body: "Atraxa.txt" });

    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null");
    expect(stored).toEqual([
      expect.objectContaining({ title: "Export saved", body: "Atraxa.txt", tone: "success" }),
    ]);
  });

  it("is removed when the inbox is cleared", () => {
    notify({ title: "gone soon" });
    clearNotices();

    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("adopts what another window on this device wrote, dropping what it cannot read", () => {
    const local = notify({ title: "mine", duration: null });
    const other = [
      { id: 9, title: "from the other window", tone: "info", at: 1, read: false },
      { id: 10, title: "no tone" },
    ];

    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", { key: STORAGE_KEY, newValue: JSON.stringify(other) }),
      );
    });

    expect(state().notices.map((n) => n.title)).toEqual(["from the other window"]);
    // The other window's inbox no longer holds this one's notice, so its toast goes with it.
    expect(state().toasts.map((t) => t.id)).not.toContain(local);
  });

  it("gives every notice its own id, however fast they come", () => {
    const ids = Array.from({ length: 50 }, () => notify({ title: "x", toast: false }));
    expect(new Set(ids).size).toBe(50);
  });
});
