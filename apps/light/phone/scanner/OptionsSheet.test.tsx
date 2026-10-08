import { fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("../../../../packages/fake/core"));
vi.mock("@tauri-apps/api/event", () => import("../../../../packages/fake/event"));
vi.mock("@tauri-apps/api/window", () => import("../../../../packages/fake/window"));

import { FILTERS_NEED_NAMES } from "@/features/scanner/useScannerStatus";
import type { ScanFilters } from "@/lib/ipc";
import { renderPhone } from "../testing";
import { OptionsSheet } from "./OptionsSheet";

const NO_FILTERS: ScanFilters = { sets: [], released_from: null, released_to: null };
const CAMERAS = [
  { deviceId: "rear", label: "Rear camera" },
  { deviceId: "front", label: "Front camera" },
];

function mount(over: Partial<Parameters<typeof OptionsSheet>[0]> = {}) {
  const props = {
    open: true,
    onClose: vi.fn(),
    onDismiss: vi.fn(),
    mode: "fast" as const,
    onMode: vi.fn(),
    filters: NO_FILTERS,
    onFilters: vi.fn(),
    filterError: null as string | null,
    filtersDisabled: null as string | null,
    finish: "detect" as const,
    onFinish: vi.fn(),
    condition: "NONE" as const,
    onCondition: vi.fn(),
    cameras: [] as typeof CAMERAS,
    cameraId: null as string | null,
    onCamera: vi.fn(),
    ...over,
  };
  renderPhone(<OptionsSheet {...props} />);
  return props;
}

const sheet = () => screen.findByRole("dialog", { name: "Scanner options" });
const open = async (row: RegExp) => {
  await userEvent.click(within(await sheet()).getByRole("button", { name: row }));
};

describe("the scanner's options sheet", () => {
  it("draws nothing while it is shut", () => {
    mount({ open: false });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("says what each option is set to", async () => {
    mount({
      mode: "exact",
      filters: { sets: ["hob", "ltr"], released_from: "2023-06-23", released_to: null },
      finish: "foil",
      condition: "NM",
    });
    const rows = within(await sheet())
      .getAllByRole("button")
      .map((b) => b.textContent);
    expect(rows).toContain("Scan modeExact");
    expect(rows).toContain("FiltersHOB, LTR · from 2023-06-23");
    expect(rows).toContain("FinishFoil");
    expect(rows).toContain("ConditionNear mint");
  });

  it("has no Developer switch, and no camera row for a device with one camera or none", async () => {
    mount({ cameras: [CAMERAS[0]], cameraId: "rear" });
    const dialog = await sheet();
    expect(within(dialog).queryByRole("button", { name: /^Camera/ })).toBeNull();
    expect(within(dialog).queryByText(/Developer/)).toBeNull();
    expect(within(dialog).queryByRole("switch")).toBeNull();
  });

  it("says each mode's sentence under its name, and writes the one pressed", async () => {
    const props = mount();
    await open(/^Scan mode/);
    const dialog = await sheet();
    const modes = within(within(dialog).getByRole("list", { name: "Scan modes" })).getAllByRole("button");
    expect(modes.map((m) => m.textContent)).toEqual([
      "FastRecognizes cards by their picture. Fastest for mixed piles.",
      "ExactAlso reads the name and collector number to identify the exact printing.",
    ]);
    expect(modes[0]).toHaveAttribute("aria-current", "true");
    await userEvent.click(modes[1]);
    expect(props.onMode).toHaveBeenCalledWith("exact");
    // Back on the first page.
    expect(within(dialog).getByRole("button", { name: /^Filters/ })).toBeInTheDocument();
  });

  it("refuses the filters, with the reason in the row's name, where the scanner has no card names", async () => {
    mount({ filtersDisabled: FILTERS_NEED_NAMES });
    // A greyed row's name includes its reason; the two are separate lines of one press.
    const row = within(await sheet()).getByRole("button", { name: /^Filters\s*Filters need the card database/ });
    expect(row).toHaveTextContent(FILTERS_NEED_NAMES);
    expect(row).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(row);
    expect(screen.queryByRole("group", { name: "Released" })).toBeNull();
  });

  it("sends a date as it is settled, and an emptied one as no bound", async () => {
    const props = mount({ filters: { sets: ["hob"], released_from: null, released_to: "2024-12-31" } });
    await open(/^Filters/);
    const from = screen.getByLabelText("Released from");
    fireEvent.change(from, { target: { value: "2023-06-23" } });
    expect(props.onFilters).toHaveBeenLastCalledWith({
      sets: ["hob"],
      released_from: "2023-06-23",
      released_to: "2024-12-31",
    });
    fireEvent.change(screen.getByLabelText("Released to"), { target: { value: "" } });
    expect(props.onFilters).toHaveBeenLastCalledWith({
      sets: ["hob"],
      released_from: null,
      released_to: null,
    });
    // Each end bounds the other.
    expect(from).toHaveAttribute("max", "2024-12-31");
  });

  it("says the session's refusal of a filter in words, and clears to everything", async () => {
    const props = mount({
      filters: { sets: ["zzz"], released_from: null, released_to: null },
      filterError: "No printing matches these filters.",
    });
    await open(/^Filters/);
    expect(screen.getByRole("alert")).toHaveTextContent("No printing matches these filters.");
    await userEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(props.onFilters).toHaveBeenCalledWith(NO_FILTERS);
  });

  it("offers Detect and the three finishes, each saying when it takes effect", async () => {
    const props = mount({ finish: "detect" });
    await open(/^Finish/);
    const choices = within(screen.getByRole("list", { name: "Default finishes" })).getAllByRole("button");
    expect(choices.map((c) => c.textContent?.replace(/\..*$/, ""))).toEqual([
      "DetectThe scanner reads each card's finish",
      "NonfoilEach new card starts in this finish",
      "FoilEach new card starts in this finish",
      "EtchedEach new card starts in this finish",
    ]);
    expect(choices[0]).toHaveAttribute("aria-current", "true");
    await userEvent.click(choices[2]);
    expect(props.onFinish).toHaveBeenCalledWith("foil");
  });

  it("offers the grade scale in its own order, not the alphabet's", async () => {
    const props = mount({ condition: "NONE" });
    await open(/^Condition/);
    const grades = within(screen.getByRole("list", { name: "Conditions" })).getAllByRole("button");
    expect(grades.map((g) => g.textContent)).toEqual([
      "Not set",
      "Near mint",
      "Lightly played",
      "Moderately played",
      "Heavily played",
      "Damaged",
    ]);
    expect(screen.getByText("Every card in the tray is added in this condition.")).toBeInTheDocument();
    await userEvent.click(grades[2]);
    expect(props.onCondition).toHaveBeenCalledWith("LP");
  });

  it("lists the cameras by name where there is a choice, ticking the one that is open", async () => {
    const props = mount({ cameras: CAMERAS, cameraId: "rear" });
    expect(within(await sheet()).getByRole("button", { name: /^Camera/ })).toHaveTextContent(
      "Rear camera",
    );
    await open(/^Camera/);
    const cameras = within(screen.getByRole("list", { name: "Cameras" })).getAllByRole("button");
    // Alphabetical: the order a driver answers in says nothing a reader could use.
    expect(cameras.map((c) => c.textContent)).toEqual(["Front camera", "Rear cameraLive"]);
    expect(cameras[1]).toHaveAttribute("aria-current", "true");
    await userEvent.click(cameras[0]);
    expect(props.onCamera).toHaveBeenCalledWith("front");
  });

  it("reads Default for a live camera the list has not caught up with", async () => {
    mount({ cameras: CAMERAS, cameraId: null });
    expect(within(await sheet()).getByRole("button", { name: /^Camera/ })).toHaveTextContent("Default");
  });

  it("tells Escape and the ✕ from a press on the scrim, so the page can hand the caret back", async () => {
    const props = mount();
    await open(/^Condition/);
    await userEvent.click(screen.getByRole("button", { name: "Close scanner options" }));
    expect(props.onDismiss).toHaveBeenCalledTimes(1);
    await userEvent.keyboard("{Escape}");
    expect(props.onDismiss).toHaveBeenCalledTimes(2);
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it("writes the camera note in words true of any device", async () => {
    mount({ cameras: CAMERAS, cameraId: "rear" });
    await open(/^Camera/);
    expect(
      screen.getByText("Switching restarts the camera. Your choice is remembered on this device."),
    ).toBeInTheDocument();
  });
});
