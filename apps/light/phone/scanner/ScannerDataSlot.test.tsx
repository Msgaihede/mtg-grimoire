import { act, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("@grimoire/fake/core"));
vi.mock("@tauri-apps/api/event", () => import("@grimoire/fake/event"));
vi.mock("@tauri-apps/api/window", () => import("@grimoire/fake/window"));

import { STATUS } from "@grimoire/ui/features/scanner/fixtures";
import type { CommandTable } from "@grimoire/fake/scope";
import type { FakeParams } from "@grimoire/fake/world";
import type { ScannerStatus } from "@grimoire/ui/lib/ipc";
import { renderPhone } from "../testing";
import { ScannerDataSlot } from "./ScannerDataSlot";

/**
 * The slot over a world, with every ask of what the scanner owes counted — so a test of the
 * state that draws **nothing** has something to wait for before it says nothing was drawn.
 */
function mount(
  status: ScannerStatus | null,
  fake?: FakeParams,
  over?: (own: CommandTable) => CommandTable,
) {
  const asked = { owed: 0 };
  const view = renderPhone(<ScannerDataSlot status={status} />, {
    fake,
    commands: (own) => ({
      scanner_assets: () => {
        asked.owed += 1;
        return (own.scanner_assets as () => unknown)();
      },
      ...over?.(own),
    }),
  });
  const slot = () => view.container.querySelector("[data-scanner-data-slot]");
  return { asked, slot, view };
}

describe("the slot for the scanner's data", () => {
  it("draws nothing — no element at all — where the host owes nothing and the status has nothing to say", async () => {
    const { asked, slot, view } = mount(STATUS.present);
    await waitFor(() => expect(asked.owed).toBeGreaterThan(0));
    await act(async () => {});
    expect(slot()).toBeNull();
    expect(view.container.querySelector("section, p, button")).toBeNull();
  });

  /**
   * The offer, in place of the status's own sentences — which named a path to put files at and
   * told the reader to restart, an instruction nobody holding this page can follow.
   */
  it("offers the download with its measured size where the host owes the files", async () => {
    const { slot } = mount(STATUS.missing, { seed: "starter", fault: "scannerMissing" });
    const offer = await screen.findByRole("region", { name: "Scanner files" });
    expect(slot()).toContainElement(offer);
    expect(
      within(offer).getByText("The scanner needs its card data — about 19 MB."),
    ).toBeInTheDocument();
    expect(within(offer).getAllByRole("listitem")).toHaveLength(3);
    const download = within(offer).getByRole("button", { name: "Download" });
    // A finger's size under a coarse pointer.
    expect(download.classList.contains("coarse:min-h-[var(--target-min)]")).toBe(true);
    expect(slot()).not.toHaveTextContent("No reference bundle.");
    expect(slot()).not.toHaveTextContent("No OCR models.");
    expect(slot()).not.toHaveTextContent("Restart the app");
  });

  /**
   * A host that refuses the question has nothing to offer, and what is left is what the status
   * still has to say — drawn from what the host answered, never from what kind of host it is.
   */
  it("says what the status has to say where the host refuses the question", async () => {
    const { slot } = mount(STATUS.unlabelled, undefined, () => ({
      scanner_assets: () => {
        throw new Error("There is no command named scanner_assets on this host.");
      },
    }));
    await waitFor(() => expect(slot()).toHaveTextContent("Bundle loaded, but card names didn't"));
    expect(screen.queryByRole("region", { name: "Scanner files" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
