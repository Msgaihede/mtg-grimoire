import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/tooltip/TooltipProvider";
import { notify, useNotifications } from "@/lib/notifications";
import { CLOSE_TOAST, Toaster } from "./Toaster";

const mount = () =>
  render(
    <TooltipProvider>
      <Toaster />
    </TooltipProvider>,
  );

afterEach(() => {
  vi.useRealTimers();
});

describe("Toaster", () => {
  it("draws a toast's sentence and second line in the corner's region", () => {
    mount();
    act(() => {
      notify.success("Added “Sol Ring”", { body: "to Atraxa" });
    });

    const region = screen.getByRole("region", { name: "Notifications" });
    expect(region).toHaveTextContent("Added “Sol Ring”");
    expect(region).toHaveTextContent("to Atraxa");
    expect(screen.getByRole("status")).toHaveAttribute("data-tone", "success");
  });

  it("says a refusal as an alert", () => {
    mount();
    act(() => {
      notify.error("Couldn't save");
    });

    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't save");
  });

  it("closes on its ✕, and the notice stays in the inbox", async () => {
    mount();
    act(() => {
      notify({ title: "Closable", duration: null });
    });

    await userEvent.click(screen.getByRole("button", { name: CLOSE_TOAST }));

    expect(useNotifications.getState().toasts).toEqual([]);
    expect(useNotifications.getState().notices).toHaveLength(1);
  });

  it("closes itself after the sender's stay", () => {
    vi.useFakeTimers();
    mount();
    act(() => {
      notify({ title: "Brief", duration: 1000 });
    });

    act(() => vi.advanceTimersByTime(999));
    expect(useNotifications.getState().toasts).toHaveLength(1);
    act(() => vi.advanceTimersByTime(1));
    expect(useNotifications.getState().toasts).toEqual([]);
  });

  it("holds while pointed at, and runs out only the time it had left", () => {
    vi.useFakeTimers();
    mount();
    act(() => {
      notify({ title: "Held", duration: 1000 });
    });
    const toast = screen.getByRole("status");

    act(() => vi.advanceTimersByTime(600));
    fireEvent.pointerEnter(toast);
    act(() => vi.advanceTimersByTime(5000));
    expect(useNotifications.getState().toasts).toHaveLength(1);

    fireEvent.pointerLeave(toast);
    act(() => vi.advanceTimersByTime(399));
    expect(useNotifications.getState().toasts).toHaveLength(1);
    act(() => vi.advanceTimersByTime(1));
    expect(useNotifications.getState().toasts).toEqual([]);
  });

  it("keeps a toast with no stay until it is closed", () => {
    vi.useFakeTimers();
    mount();
    act(() => {
      notify({ title: "Sticky", duration: null });
    });

    act(() => vi.advanceTimersByTime(60_000));
    expect(useNotifications.getState().toasts).toHaveLength(1);
  });
});
