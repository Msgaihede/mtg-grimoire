import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
/** The host's events: each subscription, by event name, so a test can be the host saying one. */
const events = vi.hoisted(() => new Map<string, (event: { payload: unknown }) => void>());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((event: string, handler: (event: { payload: unknown }) => void) => {
    events.set(event, handler);
    return Promise.resolve(() => events.delete(event));
  }),
}));

import type { HostUpdate } from "@/lib/core/hostUpdate";
import { LAYER } from "@/lib/layers";
import { UpdateNotice, UpdateNoticeBar } from "./UpdateNotice";

/** What a host holding a newer build answers, in that host's own words. */
const READY: HostUpdate = { title: "A new version is ready.", action: "Reload to update" };

function answer(update: HostUpdate | null | Error, apply: "taken" | "refused" = "taken") {
  invoke.mockImplementation((command: string) => {
    if (command === "host_update") {
      return update instanceof Error ? Promise.reject(update) : Promise.resolve(update);
    }
    if (command === "host_update_apply" && apply === "refused") return Promise.reject("refused");
    return Promise.resolve(null);
  });
}

beforeEach(() => {
  invoke.mockReset();
  events.clear();
});

describe("the update notice", () => {
  it("says what the host answered, and offers the host's own control", async () => {
    answer(READY);
    render(<UpdateNotice />);

    expect(await screen.findByRole("button", { name: "Reload to update" })).toBeInTheDocument();
    // Announced from the region that was there before the sentence was.
    expect(screen.getByRole("status")).toHaveTextContent("A new version is ready.");
  });

  it("draws nothing on a host with no newer build", async () => {
    answer(null);
    render(<UpdateNotice />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("host_update"));
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  });

  it("draws nothing on a host without the command — one that something else updates, the fake", async () => {
    answer(new Error("Command host_update not found"));
    render(<UpdateNotice />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("host_update"));
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("draws nothing for an answer that is not an update", async () => {
    answer({ waiting: true } as unknown as HostUpdate);
    render(<UpdateNotice />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("host_update"));
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("appears when the host says a build has started waiting, with the app already open", async () => {
    answer(null);
    render(<UpdateNotice />);
    await waitFor(() => expect(events.has("host-update:changed")).toBe(true));
    expect(screen.queryByRole("button")).toBeNull();

    act(() => events.get("host-update:changed")?.({ payload: READY }));
    expect(screen.getByRole("button", { name: "Reload to update" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("A new version is ready.");

    // And goes when the host says it is no longer waiting — it took over, or was replaced.
    act(() => events.get("host-update:changed")?.({ payload: null }));
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("tells the host on the press, and on nothing else", async () => {
    answer(READY);
    render(<UpdateNotice />);
    const button = await screen.findByRole("button", { name: "Reload to update" });
    expect(invoke).not.toHaveBeenCalledWith("host_update_apply");

    await userEvent.click(button);
    expect(invoke).toHaveBeenCalledWith("host_update_apply");
    // Greyed while the host starts the app again, and still in the tab order.
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).not.toBeDisabled();

    await userEvent.click(button);
    expect(invoke.mock.calls.filter(([command]) => command === "host_update_apply")).toHaveLength(1);
  });

  it("gives the control back when the host refuses the press", async () => {
    answer(READY, "refused");
    render(<UpdateNotice />);
    const button = await screen.findByRole("button", { name: "Reload to update" });
    await userEvent.click(button);
    await waitFor(() => expect(button).not.toHaveAttribute("aria-disabled"));
  });
});

describe("the notice's bar", () => {
  it("is not a modal: it takes no focus and claims nothing about the page behind it", () => {
    render(<UpdateNoticeBar update={READY} busy={false} onApply={() => {}} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(document.body);
  });

  it("is drawn over a page and under a dialog, and only the bar takes a press", () => {
    // jsdom stacks nothing, so the classes are what can be pinned: the rung, and a strip that
    // lets presses through to the tab bar and the page on either side of the bar.
    render(<UpdateNoticeBar update={READY} busy={false} onApply={() => {}} />);
    const strip = screen.getByRole("status").parentElement;
    expect(strip?.classList.contains(LAYER.popup)).toBe(true);
    expect(strip?.classList.contains("pointer-events-none")).toBe(true);
    expect(screen.getByRole("button").parentElement?.classList.contains("pointer-events-auto")).toBe(
      true,
    );
  });

  it("says the sentence once to a screen reader: in the live region, not where it is drawn", () => {
    render(<UpdateNoticeBar update={READY} busy={false} onApply={() => {}} />);
    const said = screen.getAllByText("A new version is ready.");
    expect(said).toHaveLength(2);
    expect(said.filter((el) => el.getAttribute("aria-hidden") === "true")).toHaveLength(1);
  });
});
