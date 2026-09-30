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
import { ScanBar, type ScanBarProps } from "./ScanBar";

/**
 * Three cameras in the order a driver might list them — deliberately not alphabetical, so a list
 * drawn in this order is a list that skipped `sortOptions`.
 */
const CAMERAS: readonly CameraDevice[] = [
  { deviceId: "cam-obs", label: "OBS Virtual Camera" },
  { deviceId: "cam-brio", label: "Logitech BRIO" },
  { deviceId: "cam-integrated", label: "Integrated Camera" },
];

function props(over: Partial<ScanBarProps> = {}): ScanBarProps {
  return {
    mode: "fast",
    onMode: vi.fn(),
    filters: { sets: [], released_from: null, released_to: null },
    onFilters: vi.fn(),
    filterError: null,
    filtersDisabled: null,
    finish: "nonfoil",
    onFinish: vi.fn(),
    condition: "NONE",
    onCondition: vi.fn(),
    cameras: CAMERAS,
    cameraId: "cam-brio",
    onCamera: vi.fn(),
    developer: false,
    onDeveloper: vi.fn(),
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

describe("ScanBar", () => {
  it("switches to Exact", async () => {
    const user = userEvent.setup();
    const onMode = vi.fn();
    wrap(<ScanBar {...props({ onMode })} />);
    expect(screen.getByRole("button", { name: "Fast" })).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "Exact" }));
    expect(onMode).toHaveBeenCalledWith("exact");
  });

  it("says any set on the Filters button for empty filters", () => {
    wrap(<ScanBar {...props()} />);
    const filters = screen.getByRole("button", { name: "Filters: Any set" });
    expect(filters).toHaveTextContent("Any set");
  });

  it("names the narrowing on the Filters button", () => {
    wrap(
      <ScanBar {...props({ filters: { sets: ["hob"], released_from: "2023-06-23", released_to: null } })} />,
    );
    expect(screen.getByRole("button", { name: "Filters: HOB · from 2023-06-23" })).toBeInTheDocument();
  });

  it("refuses the Filters popover with a reason, and keeps the button in reach", async () => {
    const user = userEvent.setup();
    wrap(<ScanBar {...props({ filtersDisabled: "Filters need card names, and none are loaded." })} />);
    const filters = screen.getByRole("button", { name: "Filters: Any set" });
    expect(filters).toHaveAttribute("aria-disabled", "true");
    expect(filters).not.toBeDisabled();
    await user.click(filters);
    expect(screen.queryByRole("dialog", { name: "Filters" })).not.toBeInTheDocument();
    expect(filters).toHaveAttribute("aria-expanded", "false");
  });

  it("closes the Filters popover when filters become unavailable, and does not reopen it after", async () => {
    const user = userEvent.setup();
    const { rerender } = wrap(<ScanBar {...props()} />);
    await user.click(screen.getByRole("button", { name: "Filters: Any set" }));
    expect(await screen.findByRole("dialog", { name: "Filters" })).toBeInTheDocument();

    rerender(<ScanBar {...props({ filtersDisabled: "Filters need card names, and none are loaded." })} />);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Filters" })).not.toBeInTheDocument());

    rerender(<ScanBar {...props()} />);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole("dialog", { name: "Filters" })).not.toBeInTheDocument();
  });

  it("turns the developer panels on", async () => {
    const user = userEvent.setup();
    const onDeveloper = vi.fn();
    wrap(<ScanBar {...props({ onDeveloper })} />);
    const toggle = screen.getByRole("switch", { name: "Developer" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    await user.click(toggle);
    expect(onDeveloper).toHaveBeenCalledWith(true);
  });

  it("clears every filter from the popover", async () => {
    const user = userEvent.setup();
    const onFilters = vi.fn();
    wrap(
      <ScanBar
        {...props({ onFilters, filters: { sets: ["hob", "ltr"], released_from: "2023-01-01", released_to: null } })}
      />,
    );
    await user.click(screen.getByRole("button", { name: /^Filters:/ }));
    const panel = await screen.findByRole("dialog", { name: "Filters" });
    await user.click(screen.getByRole("button", { name: "Clear" }));
    expect(onFilters).toHaveBeenCalledWith({ sets: [], released_from: null, released_to: null });
    expect(panel).toBeInTheDocument();
  });

  it("draws the last refusal inside the open popover as an alert", async () => {
    const user = userEvent.setup();
    wrap(<ScanBar {...props({ filterError: "No set is called ZZZ." })} />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Filters: Any set" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("No set is called ZZZ.");
  });

  it("closes the popover on Escape and hands the caret back to its trigger", async () => {
    const user = userEvent.setup();
    wrap(<ScanBar {...props()} />);
    const filters = screen.getByRole("button", { name: "Filters: Any set" });
    await user.click(filters);
    await screen.findByRole("dialog", { name: "Filters" });
    await user.keyboard("{Escape}");
    expect(filters).toHaveAttribute("aria-expanded", "false");
    expect(filters).toHaveFocus();
  });

  it("names the live camera on the Camera button", () => {
    wrap(<ScanBar {...props()} />);
    expect(screen.getByRole("button", { name: /^Camera:/ })).toHaveAccessibleName("Camera: Logitech BRIO");
  });

  it("reads Default when the open camera is not one the list knows", () => {
    wrap(<ScanBar {...props({ cameraId: null })} />);
    expect(screen.getByRole("button", { name: /^Camera:/ })).toHaveAccessibleName("Camera: Default");
  });

  it("lists the cameras alphabetically as radios, with the live one checked", async () => {
    const user = userEvent.setup();
    wrap(<ScanBar {...props()} />);
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
    wrap(<ScanBar {...props({ onCamera })} />);
    const trigger = screen.getByRole("button", { name: "Camera: Logitech BRIO" });
    await user.click(trigger);
    await user.click(await screen.findByRole("radio", { name: "Integrated Camera" }));
    expect(onCamera).toHaveBeenCalledExactlyOnceWith("cam-integrated");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Camera" })).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });

  it("switches camera on an arrow and keeps the list open to walk on", async () => {
    const user = userEvent.setup();
    const onCamera = vi.fn();
    wrap(<ScanBar {...props({ onCamera })} />);
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
    wrap(<ScanBar {...props({ cameras: [], cameraId: null })} />);
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
      <ScanBar {...props({ onFilters, filters: { sets: [], released_from: "2023-06-23", released_to: null } })} />,
    );
    await user.click(screen.getByRole("button", { name: /^Filters:/ }));
    // `fireEvent` rather than `user.clear`: a date field has no text selection for user-event to
    // drive, and what is under test is what the row does with the value the field reports.
    const from = await screen.findByLabelText("Released from");
    fireEvent.change(from, { target: { value: "" } });
    expect(onFilters).toHaveBeenLastCalledWith({ sets: [], released_from: null, released_to: null });
    fireEvent.change(screen.getByLabelText("Released to"), { target: { value: "2024-12-31" } });
    expect(onFilters).toHaveBeenLastCalledWith({
      sets: [],
      released_from: "2023-06-23",
      released_to: "2024-12-31",
    });
  });
});
