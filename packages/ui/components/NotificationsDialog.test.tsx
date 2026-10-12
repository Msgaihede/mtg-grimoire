import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { TooltipProvider } from "@/components/tooltip/TooltipProvider";
import { notify, useNotifications } from "@/lib/notifications";
import { NotificationsDialog, noticeTime } from "./NotificationsDialog";

const mount = (open = true) =>
  render(
    <TooltipProvider>
      <NotificationsDialog open={open} onClose={() => {}} />
    </TooltipProvider>,
  );

describe("NotificationsDialog", () => {
  it("lists every notice newest first, and reads them by being open", () => {
    notify.success("first");
    notify.error("second", { body: "the reason" });

    mount();

    const rows = within(screen.getByRole("list", { name: "Notifications" })).getAllByRole(
      "listitem",
    );
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining("secondthe reason"),
      expect.stringContaining("first"),
    ]);
    expect(useNotifications.getState().notices.every((n) => n.read)).toBe(true);
  });

  it("reads a notice that arrives while it is open", () => {
    mount();
    act(() => {
      notify({ title: "late" });
    });

    expect(screen.getByText("late")).toBeInTheDocument();
    expect(useNotifications.getState().notices[0].read).toBe(true);
  });

  it("leaves notices unread while closed", () => {
    notify({ title: "unseen" });
    mount(false);

    expect(useNotifications.getState().notices[0].read).toBe(false);
  });

  it("removes one notice, or clears them all", async () => {
    notify({ title: "keep" });
    notify({ title: "drop" });
    mount();

    await userEvent.click(screen.getByRole("button", { name: "Remove “drop”" }));
    expect(screen.queryByText("drop")).not.toBeInTheDocument();
    expect(screen.getByText("keep")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Clear all" }));
    expect(screen.getByText(/Nothing yet/)).toBeInTheDocument();
  });
});

describe("noticeTime", () => {
  const now = new Date(2026, 9, 12, 15, 30).getTime();

  it("is relative for the last hour", () => {
    expect(noticeTime(now - 20_000, now)).toBe("Just now");
    expect(noticeTime(now - 5 * 60_000, now)).toBe("5 min ago");
  });

  it("is the clock for the rest of today, and the date before that", () => {
    const earlier = new Date(2026, 9, 12, 9, 5).getTime();
    expect(noticeTime(earlier, now)).toBe(
      new Date(earlier).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }),
    );
    const yesterday = new Date(2026, 9, 11, 9, 5).getTime();
    expect(noticeTime(yesterday, now)).toMatch(/,/);
  });
});
