import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { APP_VOLUME_KEY, useAppVolume } from "@/lib/volume";

const played = vi.hoisted(() => vi.fn());
vi.mock("@/features/scanner/sounds/player", () => ({ playScanSound: played }));

import { VolumePanel } from "./VolumePanel";

const slider = () => screen.getByRole("slider", { name: "App volume" });

afterEach(() => {
  played.mockReset();
  useAppVolume.getState().setVolume(100);
});

describe("VolumePanel", () => {
  it("draws the app's level, full for a reader who never moved it", () => {
    render(<VolumePanel />);
    const panel = screen.getByRole("region", { name: "Volume" });
    expect(within(panel).getByRole("slider", { name: "App volume" })).toHaveValue("100");
    expect(slider()).toHaveAttribute("aria-valuetext", "100%");
    expect(within(panel).getByText("100%")).toBeInTheDocument();
  });

  it("sets the level as the slider moves, and keeps it on this device", () => {
    render(<VolumePanel />);
    fireEvent.change(slider(), { target: { value: "45" } });
    expect(useAppVolume.getState().volume).toBe(45);
    expect(window.localStorage.getItem(APP_VOLUME_KEY)).toBe("45");
    expect(slider()).toHaveAttribute("aria-valuetext", "45%");
  });

  it("follows a level set anywhere else — another window, or the store itself", () => {
    render(<VolumePanel />);
    act(() => useAppVolume.getState().setVolume(0));
    expect(slider()).toHaveValue("0");
    expect(screen.getByText("0%")).toBeInTheDocument();
  });

  it("plays a test sound at the level, from a press", async () => {
    render(<VolumePanel />);
    await userEvent.click(screen.getByRole("button", { name: "Play a test sound" }));
    expect(played).toHaveBeenCalledExactlyOnceWith("ok");
  });
});
