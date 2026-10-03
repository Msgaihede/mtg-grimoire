import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

import { DownloadsPrompt, megabytes, type DownloadsStatus } from "./DownloadsPrompt";

const HELD: DownloadsStatus = {
  held: true,
  metered: true,
  due: [
    { key: "cards", label: "Card data from Scryfall", bytes: 77_000_000 },
    { key: "combos", label: "Combos from Commander Spellbook", bytes: 27_500_000 },
  ],
};

function answer(status: DownloadsStatus | Error) {
  invoke.mockImplementation((command: string) => {
    if (command === "light_downloads") {
      return status instanceof Error ? Promise.reject(status) : Promise.resolve(status);
    }
    return Promise.resolve(null);
  });
}

beforeEach(() => invoke.mockReset());

describe("the mobile-data prompt", () => {
  it("lists what the launch is holding, each with its measured size, and the total", async () => {
    answer(HELD);
    render(<DownloadsPrompt />);

    const dialog = await screen.findByRole("dialog", { name: "Download on mobile data?" });
    expect(dialog).toHaveTextContent("Card data from Scryfall");
    expect(dialog).toHaveTextContent("about 77 MB");
    expect(dialog).toHaveTextContent("about 28 MB");
    expect(dialog).toHaveTextContent("About 105 MB in all");
  });

  it("puts Not now first, and Not now sends nothing", async () => {
    answer(HELD);
    render(<DownloadsPrompt />);
    await screen.findByRole("dialog");

    const buttons = screen
      .getAllByRole("button")
      .filter((b) => ["Not now", "Download"].includes(b.textContent ?? ""));
    expect(buttons.map((b) => b.textContent)).toEqual(["Not now", "Download"]);

    await userEvent.click(buttons[0]);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(invoke).not.toHaveBeenCalledWith("light_downloads_start", expect.anything());
  });

  it("starts the downloads on Download, remembering only when asked to", async () => {
    answer(HELD);
    render(<DownloadsPrompt />);
    await screen.findByRole("dialog");

    await userEvent.click(screen.getByRole("checkbox", { name: "Don't ask again on mobile data" }));
    await userEvent.click(screen.getByRole("button", { name: "Download" }));

    expect(invoke).toHaveBeenCalledWith("light_downloads_start", { always: true });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("draws nothing on a host that is not holding anything", async () => {
    answer({ held: false, metered: false, due: [] });
    render(<DownloadsPrompt />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("light_downloads"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("draws nothing on a host without the command — the desktop binary, the fake", async () => {
    answer(new Error("Command light_downloads not found"));
    render(<DownloadsPrompt />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("light_downloads"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("megabytes", () => {
  it("rounds up, so a reader on a metered link is never told less than it costs", () => {
    expect(megabytes(5_850_000)).toBe("6 MB");
    expect(megabytes(77_000_000)).toBe("77 MB");
    expect(megabytes(1)).toBe("1 MB");
  });
});
