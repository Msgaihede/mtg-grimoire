import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/tooltip/TooltipProvider";

/**
 * The one command this row reaches, and only once the Filters popover is open: `SetCombobox` asks
 * for the set list on mount. Answered empty — the picker's own rows are its own test file's
 * subject, and an `ipc` mock missing the command is a synchronous `TypeError` inside a hook.
 */
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: { listSets: vi.fn().mockResolvedValue([]) },
}));

import type { CameraDevice } from "../useCamera";
import { ScanDock, type ScanDockProps } from "./ScanDock";

/**
 * Three cameras in the order a driver might list them — deliberately not alphabetical, so a list
 * drawn in this order is a list that skipped `sortOptions`.
 */
const CAMERAS: readonly CameraDevice[] = [
  { deviceId: "cam-obs", label: "OBS Virtual Camera" },
  { deviceId: "cam-brio", label: "Logitech BRIO" },
  { deviceId: "cam-integrated", label: "Integrated Camera" },
];

function props(over: Partial<ScanDockProps> = {}): ScanDockProps {
  return {
    scanning: true,
    onScanning: vi.fn(),
    pointAndShoot: false,
    onPointAndShoot: vi.fn(),
    shooting: false,
    onShoot: vi.fn(),
    filters: { sets: [], released_from: null, released_to: null },
    onFilters: vi.fn(),
    filterError: null,
    filtersDisabled: null,
    finish: "detect",
    onFinish: vi.fn(),
    cameras: CAMERAS,
    cameraId: "cam-brio",
    onCamera: vi.fn(),
    ...over,
  };
}

/** Under the two providers the page mounts above it — a query client for the set picker, and the
 *  tooltip provider, without which the refusal's tooltip would be bound to nothing. */
function wrap(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const provided = (node: ReactElement) => (
    <QueryClientProvider client={client}>
      <TooltipProvider>{node}</TooltipProvider>
    </QueryClientProvider>
  );
  const result = render(provided(ui));
  return { ...result, rerender: (next: ReactElement) => result.rerender(provided(next)) };
}

describe("ScanDock", () => {
  /** The gold primary, worded as the spec words it: *Start* while stopped, *Stop* while running. */
  it("starts and stops the scanner from its gold primary", async () => {
    const user = userEvent.setup();
    const onScanning = vi.fn();
    const { rerender } = wrap(<ScanDock {...props({ scanning: false, onScanning })} />);
    await user.click(screen.getByRole("button", { name: "Start" }));
    expect(onScanning).toHaveBeenLastCalledWith(true);

    rerender(<ScanDock {...props({ scanning: true, onScanning })} />);
    expect(screen.queryByRole("button", { name: "Start" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Stop" }));
    expect(onScanning).toHaveBeenLastCalledWith(false);
  });

  /**
   * *How scanning runs*: a named pair of pressed buttons, the stored pref — and under point and
   * shoot the primary is one click, one card, with *Cancel scan* for a shot still looking.
   */
  it("trades Start and Stop for Scan card under point and shoot", async () => {
    const user = userEvent.setup();
    const onPointAndShoot = vi.fn();
    const onShoot = vi.fn();
    const { rerender } = wrap(<ScanDock {...props({ onPointAndShoot, onShoot })} />);
    const runs = screen.getByRole("group", { name: "How scanning runs" });
    const halves = within(runs).getAllByRole("button");
    expect(halves.map((b) => b.textContent)).toEqual(["Continuous", "Point & shoot"]);
    expect(within(runs).getByRole("button", { name: "Continuous" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
    await user.click(within(runs).getByRole("button", { name: "Point & shoot" }));
    expect(onPointAndShoot).toHaveBeenCalledExactlyOnceWith(true);

    rerender(<ScanDock {...props({ pointAndShoot: true, onPointAndShoot, onShoot })} />);
    expect(screen.getByRole("button", { name: "Point & shoot" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "Continuous" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(screen.queryByRole("button", { name: "Start" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Scan card" }));
    expect(onShoot).toHaveBeenLastCalledWith(true);

    rerender(
      <ScanDock {...props({ pointAndShoot: true, shooting: true, onPointAndShoot, onShoot })} />,
    );
    await user.click(screen.getByRole("button", { name: "Cancel scan" }));
    expect(onShoot).toHaveBeenLastCalledWith(false);
  });

  /** A press on the half already pressed is not a change — and must not stop a running scan. */
  it("calls nothing for the half of How scanning runs that is already pressed", async () => {
    const user = userEvent.setup();
    const onPointAndShoot = vi.fn();
    wrap(<ScanDock {...props({ onPointAndShoot })} />);
    await user.click(screen.getByRole("button", { name: "Continuous" }));
    expect(onPointAndShoot).not.toHaveBeenCalled();
  });

  /**
   * What the old bar also carried has gone where it is read: the condition to the tray's footer,
   * *History* and the Developer switch to the page's header. None of them is the dock's.
   */
  it("draws no Defaults popover, no condition, no History and no Developer switch", () => {
    wrap(<ScanDock {...props()} />);
    expect(screen.queryByRole("button", { name: /^Defaults/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /condition/i })).toBeNull();
    expect(screen.queryByRole("button", { name: "History" })).toBeNull();
    expect(screen.queryByRole("switch", { name: "Developer" })).toBeNull();
  });

  /**
   * **Detect leads the Finish menu and is the one it opens on by default** — the reader decided it
   * should be the default, and the order is the information (`FINISH_CHOICES`' comment). A fixed
   * finish is still one press away, and a press picks it, hands it up and closes the menu.
   */
  it("offers Detect first in the Finish menu, then the three finishes, and closes on a press", async () => {
    const user = userEvent.setup();
    const onFinish = vi.fn();
    wrap(<ScanDock {...props({ onFinish })} />);
    const trigger = screen.getByRole("button", { name: "Finish: Detect" });
    await user.click(trigger);
    const panel = await screen.findByRole("dialog", { name: "Finish" });
    expect(panel).toHaveTextContent("New cards land as");
    expect(
      within(panel).getByText(
        "A card printed in one finish takes it. One printed in several waits in the tray for you to pick.",
      ),
    ).toBeInTheDocument();
    const group = within(panel).getByRole("radiogroup", { name: "New cards land as" });
    const radios = within(group).getAllByRole("radio");
    expect(radios.map((r) => r.getAttribute("aria-label"))).toEqual([
      "Detect",
      "Nonfoil",
      "Foil",
      "Etched",
    ]);
    expect(within(group).getByRole("radio", { checked: true })).toHaveAccessibleName("Detect");
    // One Tab stop, and it is the checked radio's.
    expect(radios.map((r) => r.tabIndex)).toEqual([0, -1, -1, -1]);
    await user.click(within(group).getByRole("radio", { name: "Foil" }));
    expect(onFinish).toHaveBeenCalledExactlyOnceWith("foil");
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Finish" })).not.toBeInTheDocument(),
    );
    expect(trigger).toHaveFocus();
  });

  it("names a fixed finish on its trigger and says a new card starts in it", async () => {
    const user = userEvent.setup();
    wrap(<ScanDock {...props({ finish: "foil" })} />);
    await user.click(screen.getByRole("button", { name: "Finish: Foil" }));
    expect(await screen.findByText("Each new card starts in this finish.")).toBeInTheDocument();
    expect(screen.getByRole("radio", { checked: true })).toHaveAccessibleName("Foil");
  });

  it("chooses a finish on an arrow and keeps the menu open to walk on", async () => {
    const user = userEvent.setup();
    const onFinish = vi.fn();
    wrap(<ScanDock {...props({ onFinish })} />);
    await user.click(screen.getByRole("button", { name: "Finish: Detect" }));
    await screen.findByRole("dialog", { name: "Finish" });
    await user.tab();
    expect(screen.getByRole("radio", { name: "Detect" })).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(onFinish).toHaveBeenCalledExactlyOnceWith("nonfoil");
    expect(screen.getByRole("radio", { name: "Nonfoil" })).toHaveFocus();
    expect(screen.getByRole("dialog", { name: "Finish" })).toBeInTheDocument();
  });

  it("draws no mode switch: the scanner has one way of reading", () => {
    wrap(<ScanDock {...props()} />);
    expect(screen.queryByRole("group", { name: "Scan mode" })).toBeNull();
    for (const name of ["Fast", "Exact", "Neural"]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
  });

  it("says any set on the Filters button for empty filters", () => {
    wrap(<ScanDock {...props()} />);
    const filters = screen.getByRole("button", { name: "Filters: Any set" });
    expect(filters).toHaveTextContent("Any set");
  });

  it("names the narrowing on the Filters button", () => {
    wrap(
      <ScanDock
        {...props({ filters: { sets: ["hob"], released_from: "2023-06-23", released_to: null } })}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Filters: HOB · from 2023-06-23" }),
    ).toBeInTheDocument();
  });

  it("refuses the Filters popover with a reason, and keeps the button in reach", async () => {
    const user = userEvent.setup();
    wrap(
      <ScanDock {...props({ filtersDisabled: "Filters need card names, and none are loaded." })} />,
    );
    const filters = screen.getByRole("button", { name: "Filters: Any set" });
    expect(filters).toHaveAttribute("aria-disabled", "true");
    expect(filters).not.toBeDisabled();
    await user.click(filters);
    expect(screen.queryByRole("dialog", { name: "Filters" })).not.toBeInTheDocument();
    expect(filters).toHaveAttribute("aria-expanded", "false");
  });

  it("closes the Filters popover when filters become unavailable, and does not reopen it after", async () => {
    const user = userEvent.setup();
    const { rerender } = wrap(<ScanDock {...props()} />);
    await user.click(screen.getByRole("button", { name: "Filters: Any set" }));
    expect(await screen.findByRole("dialog", { name: "Filters" })).toBeInTheDocument();

    rerender(
      <ScanDock {...props({ filtersDisabled: "Filters need card names, and none are loaded." })} />,
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Filters" })).not.toBeInTheDocument(),
    );

    rerender(<ScanDock {...props()} />);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole("dialog", { name: "Filters" })).not.toBeInTheDocument();
  });

  it("clears every filter from the popover", async () => {
    const user = userEvent.setup();
    const onFilters = vi.fn();
    wrap(
      <ScanDock
        {...props({
          onFilters,
          filters: { sets: ["hob", "ltr"], released_from: "2023-01-01", released_to: null },
        })}
      />,
    );
    await user.click(screen.getByRole("button", { name: /^Filters:/ }));
    const panel = await screen.findByRole("dialog", { name: "Filters" });
    await user.click(screen.getByRole("button", { name: "Clear" }));
    expect(onFilters).toHaveBeenCalledWith({
      sets: [],
      released_from: null,
      released_to: null,
      exclude_promos: false,
    });
    expect(panel).toBeInTheDocument();
  });

  it("switches promos off beside the set picker, keeping the other filters, and says so on the bar", async () => {
    const user = userEvent.setup();
    const onFilters = vi.fn();
    const filters = { sets: ["hob"], released_from: null, released_to: null };
    const { rerender } = wrap(<ScanDock {...props({ onFilters, filters })} />);
    await user.click(screen.getByRole("button", { name: /^Filters:/ }));
    const toggle = await screen.findByRole("switch", { name: "Skip promos" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(toggle).toHaveAccessibleDescription(/Never match a promo printing/);
    await user.click(toggle);
    expect(onFilters).toHaveBeenLastCalledWith({ ...filters, exclude_promos: true });

    rerender(<ScanDock {...props({ onFilters, filters: { ...filters, exclude_promos: true } })} />);
    expect(screen.getByRole("switch", { name: "Skip promos" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByRole("button", { name: /^Filters:/ })).toHaveAccessibleName(
      /HOB · no promos/,
    );
    await user.click(screen.getByRole("switch", { name: "Skip promos" }));
    expect(onFilters).toHaveBeenLastCalledWith({ ...filters, exclude_promos: false });
  });

  it("draws the last refusal inside the open popover as an alert", async () => {
    const user = userEvent.setup();
    wrap(<ScanDock {...props({ filterError: "No set is called ZZZ." })} />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Filters: Any set" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("No set is called ZZZ.");
  });

  it("closes the popover on Escape and hands the caret back to its trigger", async () => {
    const user = userEvent.setup();
    wrap(<ScanDock {...props()} />);
    const filters = screen.getByRole("button", { name: "Filters: Any set" });
    await user.click(filters);
    await screen.findByRole("dialog", { name: "Filters" });
    await user.keyboard("{Escape}");
    expect(filters).toHaveAttribute("aria-expanded", "false");
    expect(filters).toHaveFocus();
  });

  it("names the live camera on the Camera button", () => {
    wrap(<ScanDock {...props()} />);
    expect(screen.getByRole("button", { name: /^Camera:/ })).toHaveAccessibleName(
      "Camera: Logitech BRIO",
    );
  });

  it("reads Default when the open camera is not one the list knows", () => {
    wrap(<ScanDock {...props({ cameraId: null })} />);
    expect(screen.getByRole("button", { name: /^Camera:/ })).toHaveAccessibleName(
      "Camera: Default",
    );
  });

  it("lists the cameras alphabetically as radios, with the live one checked", async () => {
    const user = userEvent.setup();
    wrap(<ScanDock {...props()} />);
    await user.click(screen.getByRole("button", { name: "Camera: Logitech BRIO" }));
    await screen.findByRole("dialog", { name: "Camera" });
    const group = screen.getByRole("radiogroup", { name: "Camera" });
    const radios = within(group).getAllByRole("radio");
    expect(radios.map((r) => r.getAttribute("aria-label"))).toEqual([
      "Integrated Camera",
      "Logitech BRIO",
      "OBS Virtual Camera",
    ]);
    const live = within(group).getByRole("radio", { checked: true });
    // The whole name, so a `Live` mark fused onto the label (`Logitech BRIOLive`) goes red here.
    expect(live).toHaveAccessibleName("Logitech BRIO");
    // One Tab stop, and it is the checked radio's.
    expect(radios.map((r) => r.tabIndex)).toEqual([-1, 0, -1]);
  });

  it("switches camera on a press, and closes the popover", async () => {
    const user = userEvent.setup();
    const onCamera = vi.fn();
    wrap(<ScanDock {...props({ onCamera })} />);
    const trigger = screen.getByRole("button", { name: "Camera: Logitech BRIO" });
    await user.click(trigger);
    await user.click(await screen.findByRole("radio", { name: "Integrated Camera" }));
    expect(onCamera).toHaveBeenCalledExactlyOnceWith("cam-integrated");
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Camera" })).not.toBeInTheDocument(),
    );
    expect(trigger).toHaveFocus();
  });

  it("switches camera on an arrow and keeps the list open to walk on", async () => {
    const user = userEvent.setup();
    const onCamera = vi.fn();
    wrap(<ScanDock {...props({ onCamera })} />);
    await user.click(screen.getByRole("button", { name: "Camera: Logitech BRIO" }));
    await screen.findByRole("dialog", { name: "Camera" });
    // Reached the way a reader reaches it — the caret is on the panel, and one Tab lands on the
    // group's single stop, which is the live camera.
    await user.tab();
    expect(screen.getByRole("radio", { name: "Logitech BRIO" })).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(onCamera).toHaveBeenCalledExactlyOnceWith("cam-obs");
    expect(screen.getByRole("radio", { name: "OBS Virtual Camera" })).toHaveFocus();
    expect(screen.getByRole("dialog", { name: "Camera" })).toBeInTheDocument();
  });

  it("refuses the Camera popover when there is no camera, and says why", async () => {
    const user = userEvent.setup();
    wrap(<ScanDock {...props({ cameras: [], cameraId: null })} />);
    const camera = screen.getByRole("button", { name: "Camera: Default" });
    expect(camera).toHaveAttribute("aria-disabled", "true");
    expect(camera).not.toBeDisabled();
    // The hover delay is the tooltip's own, so the wait is `AnchoredPopup.test.tsx`'s.
    await user.hover(camera);
    expect(await screen.findByRole("tooltip", undefined, { timeout: 2000 })).toHaveTextContent(
      "No camera found",
    );
    await user.click(camera);
    expect(screen.queryByRole("dialog", { name: "Camera" })).not.toBeInTheDocument();
    expect(camera).toHaveAttribute("aria-expanded", "false");
  });

  it("sends a release date as it is set, and a cleared one as no bound", async () => {
    const user = userEvent.setup();
    const onFilters = vi.fn();
    wrap(
      <ScanDock
        {...props({
          onFilters,
          filters: { sets: [], released_from: "2023-06-23", released_to: null },
        })}
      />,
    );
    await user.click(screen.getByRole("button", { name: /^Filters:/ }));
    // `fireEvent` rather than `user.clear`: a date field has no text selection for user-event to
    // drive, and what is under test is what the row does with the value the field reports.
    const from = await screen.findByLabelText("Released from");
    fireEvent.change(from, { target: { value: "" } });
    expect(onFilters).toHaveBeenLastCalledWith({
      sets: [],
      released_from: null,
      released_to: null,
    });
    fireEvent.change(screen.getByLabelText("Released to"), { target: { value: "2024-12-31" } });
    expect(onFilters).toHaveBeenLastCalledWith({
      sets: [],
      released_from: "2023-06-23",
      released_to: "2024-12-31",
    });
  });
});
