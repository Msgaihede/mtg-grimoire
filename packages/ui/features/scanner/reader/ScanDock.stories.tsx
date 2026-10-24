import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import type { ScanFilters, ScannerFinishPref } from "@/lib/ipc";
import type { CameraDevice } from "../useCamera";
import { ScanDock, type ScanDockProps } from "./ScanDock";

/**
 * A desk with three cameras, listed in a driver's order rather than the alphabet's, so the panel
 * drawing them sorted is something the story shows rather than something it was handed.
 */
const CAMERAS: readonly CameraDevice[] = [
  { deviceId: "cam-obs", label: "OBS Virtual Camera" },
  { deviceId: "cam-brio", label: "Logitech BRIO" },
  { deviceId: "cam-integrated", label: "Integrated Camera" },
];

/**
 * The dock with its values held, so a press in the workbench moves what it would move in the app.
 *
 * `ScanDock` is controlled end to end — the page owns the prefs — so a story drawn straight from
 * `args` would be a dock whose Start never turns to Stop and whose Clear clears nothing. The args
 * seed the state and still receive every call, so the Actions panel reads exactly what the page
 * would be handed. A camera press is held as though the new stream opened at once — in the app the
 * tick waits for it.
 */
function Held(args: ScanDockProps) {
  const [scanning, setScanning] = useState(args.scanning);
  const [pointAndShoot, setPointAndShoot] = useState(args.pointAndShoot);
  const [shooting, setShooting] = useState(args.shooting);
  const [filters, setFilters] = useState<ScanFilters>(args.filters);
  const [finish, setFinish] = useState<ScannerFinishPref>(args.finish);
  const [cameraId, setCameraId] = useState<string | null>(args.cameraId);
  return (
    <ScanDock
      {...args}
      scanning={scanning}
      onScanning={(on) => {
        setScanning(on);
        args.onScanning(on);
      }}
      pointAndShoot={pointAndShoot}
      onPointAndShoot={(on) => {
        setPointAndShoot(on);
        setShooting(false);
        args.onPointAndShoot(on);
      }}
      shooting={shooting}
      onShoot={(on) => {
        setShooting(on);
        args.onShoot(on);
      }}
      filters={filters}
      onFilters={(f) => {
        setFilters(f);
        args.onFilters(f);
      }}
      finish={finish}
      onFinish={(f) => {
        setFinish(f);
        args.onFinish(f);
      }}
      cameraId={cameraId}
      onCamera={(id) => {
        setCameraId(id);
        args.onCamera(id);
      }}
    />
  );
}

const meta = {
  title: "Scanner/Reader/Scan dock",
  component: ScanDock,
  tags: ["autodocs"],
  render: (args) => <Held {...args} />,
  args: {
    scanning: true,
    onScanning: fn(),
    pointAndShoot: false,
    onPointAndShoot: fn(),
    shooting: false,
    onShoot: fn(),
    filters: { sets: [], released_from: null, released_to: null },
    onFilters: fn(),
    filterError: null,
    filtersDisabled: null,
    finish: "detect",
    onFinish: fn(),
    cameras: CAMERAS,
    cameraId: "cam-brio",
    onCamera: fn(),
  },
  decorators: [
    // The camera column at its 40rem, with the dock at its foot and room above it: every panel
    // opens upwards over the picture, and a canvas cut at the dock's own height would clip them.
    (Story) => (
      <div className="flex min-h-[30rem] w-[40rem] max-w-full flex-col justify-end p-2">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ScanDock>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * What a reader opens the view on, running: *Stop* gold, *Continuous* pressed, no narrowing, the
 * finish detected per card and the camera that opened named.
 */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("button", { name: "Stop" })).toBeInTheDocument();
    await expect(canvas.getByRole("button", { name: "Continuous" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(canvas.getByRole("button", { name: "Filters: Any set" })).toBeInTheDocument();
    await expect(canvas.getByRole("button", { name: "Finish: Detect" })).toBeInTheDocument();
    await expect(canvas.getByRole("button", { name: "Camera: Logitech BRIO" })).toBeInTheDocument();
  },
};

export const StartAndStop: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Stop" }));
    await userEvent.click(canvas.getByRole("button", { name: "Start" }));
    await expect(canvas.getByRole("button", { name: "Stop" })).toBeInTheDocument();
  },
};

/**
 * **Point and shoot**: *How scanning runs* trades Start and Stop for *Scan card* — one click, one
 * card. While a shot is looking the same press reads *Cancel scan*, drawn as a gold outline; in the
 * app the shot ends by itself once a card lands.
 */
export const PointAndShoot: Story = {
  args: { scanning: false },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const runs = canvas.getByRole("group", { name: "How scanning runs" });
    await userEvent.click(within(runs).getByRole("button", { name: "Point & shoot" }));
    await expect(args.onPointAndShoot).toHaveBeenCalledWith(true);
    await expect(canvas.queryByRole("button", { name: "Start" })).toBeNull();
    await userEvent.click(canvas.getByRole("button", { name: "Scan card" }));
    await expect(args.onShoot).toHaveBeenLastCalledWith(true);
    await userEvent.click(canvas.getByRole("button", { name: "Cancel scan" }));
    await expect(args.onShoot).toHaveBeenLastCalledWith(false);
    await expect(canvas.getByRole("button", { name: "Scan card" })).toBeInTheDocument();
  },
};

/**
 * The Finish menu open on **Detect**: the one choice that is not a finish, first in the list
 * under "New cards land as", and a caption that says what becomes of a card it cannot read — the
 * reader meets `Unknown` in the tray already knowing why.
 */
export const FinishDetect: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Finish: Detect" }));
    await expect(
      await canvas.findByText(
        "A card printed in one finish takes it. One printed in several waits in the tray for you to pick.",
      ),
    ).toBeInTheDocument();
    const group = canvas.getByRole("radiogroup", { name: "New cards land as" });
    await expect(
      within(group)
        .getAllByRole("radio")
        .map((r) => r.getAttribute("aria-label")),
    ).toEqual(["Detect", "Nonfoil", "Foil", "Etched"]);
  },
};

/**
 * The camera column at its 22rem floor beside a wide tray: the first row wraps, Filters on a line
 * of its own and still at the far end, rather than a scrollbar under the picture.
 */
export const Narrow: Story = {
  decorators: [
    (Story) => (
      <div className="w-[22rem]">
        <Story />
      </div>
    ),
  ],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("button", { name: "Filters: Any set" })).toBeInTheDocument();
  },
};

/**
 * Narrowed to two sets and a release window — the Filters trigger turns gold, which is the one
 * thing a reader has to be able to see without opening it: a filter left on from the last pile is
 * how the next pile fails to match.
 */
export const WithFilters: Story = {
  args: {
    filters: { sets: ["hob", "ltr"], released_from: "2023-06-23", released_to: "2024-12-31" },
    finish: "foil",
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.queryByRole("group", { name: "Scan mode" })).toBeNull();
    await expect(
      canvas.getByRole("button", { name: "Filters: HOB, LTR · 2023-06-23 – 2024-12-31" }),
    ).toBeInTheDocument();
  },
};

/**
 * The session refused the last filter, drawn where the reader made it — inside the open popover,
 * so the sentence is beside the field it is about rather than somewhere under the camera.
 */
export const FilterRefused: Story = {
  args: {
    filters: { sets: ["hob"], released_from: null, released_to: null },
    filterError: "Filters need card names, and this scanner could not read corpus.db.",
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Filters: HOB" }));
    await expect(await canvas.findByRole("alert")).toHaveTextContent(
      "Filters need card names, and this scanner could not read corpus.db.",
    );
  },
};

/**
 * Filters out of reach, with the reason as the trigger's tooltip — still in the tab order, still
 * reading what it would narrow to, and refusing the press rather than hiding.
 */
export const FiltersDisabled: Story = {
  args: { filtersDisabled: "Filters need card names, and none are loaded yet." },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const filters = canvas.getByRole("button", { name: "Filters: Any set" });
    await expect(filters).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(filters);
    await expect(canvas.queryByRole("dialog", { name: "Filters" })).not.toBeInTheDocument();
  },
};

/**
 * The Camera list open: the three cameras alphabetically, the open one ticked and marked `Live`,
 * and the line that says a switch restarts the stream and is remembered on this device.
 */
export const CameraOpen: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Camera: Logitech BRIO" }));
    const group = await canvas.findByRole("radiogroup", { name: "Camera" });
    await expect(within(group).getByRole("radio", { checked: true })).toHaveAccessibleName(
      "Logitech BRIO",
    );
    await expect(
      within(group)
        .getAllByRole("radio")
        .map((r) => r.getAttribute("aria-label")),
    ).toEqual(["Integrated Camera", "Logitech BRIO", "OBS Virtual Camera"]);
  },
};

/**
 * No camera on the machine: the trigger reads `Default`, refuses the press and says why in its
 * tooltip — in reach rather than hidden, as Filters is when it cannot be used.
 */
export const NoCamera: Story = {
  args: { cameras: [], cameraId: null },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const camera = canvas.getByRole("button", { name: "Camera: Default" });
    await expect(camera).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(camera);
    await expect(canvas.queryByRole("dialog", { name: "Camera" })).not.toBeInTheDocument();
  },
};
