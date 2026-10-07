import type { Meta, StoryObj } from "@storybook/react-vite";
import { useQuery } from "@tanstack/react-query";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import { ipc } from "@/lib/ipc";
import { ScannerAssets } from "./ScannerAssets";
import { SCANNER_STATUS_KEY } from "./useScannerAssets";

/**
 * {@link ScannerAssets} under the page's own status query, so a download that lands is seen to
 * change what the status says — the half of the component a fixed `status` could not show.
 *
 * The line above it is the story's, not the component's: it names what `scanner_status`
 * answered, so a story of the state that draws **nothing** has something to wait for before it
 * says nothing was drawn.
 */
function UnderTheStatus({ onLoaded }: { onLoaded?: () => void }) {
  const status = useQuery({
    queryKey: SCANNER_STATUS_KEY,
    queryFn: ipc.scannerStatus,
    staleTime: Infinity,
  });
  const bundle = status.data?.bundle;
  return (
    <div className="space-y-3">
      <p className="font-mono text-xs text-dim">
        scanner_status: {bundle === undefined ? "…" : bundle.loaded ? "bundle loaded" : "no bundle"}
      </p>
      <ScannerAssets status={status.data ?? null} onLoaded={onLoaded} />
    </div>
  );
}

const meta = {
  title: "Scanner/Assets",
  component: ScannerAssets,
  tags: ["autodocs"],
  args: { status: null, onLoaded: fn() },
  render: (args) => <UnderTheStatus onLoaded={args.onLoaded} />,
  decorators: [
    // The camera column's width at the app's narrow rung: the content column less the tray.
    (Story) => (
      <div className="w-[616px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ScannerAssets>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * An install without the scanner's files — a phone before its first scan, or a developer's
 * build with nothing embedded. The host lists the three files and what they cost, and the offer
 * says so in one sentence with the total: nothing is fetched until the press.
 *
 * It stands where the instruction to put a file at a path and restart used to, which a reader
 * with a button does not need and a phone's reader cannot follow.
 */
export const Owed: Story = {
  parameters: { fake: { fault: "scannerMissing" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const offer = await canvas.findByRole("region", { name: "Scanner files" });
    await expect(
      within(offer).getByText("The scanner needs its card data — about 19 MB."),
    ).toBeVisible();
    await expect(within(offer).getAllByRole("listitem")).toHaveLength(3);
    await expect(within(offer).getByText("Card hashes, about 6 MB")).toBeVisible();
    await expect(within(offer).getByRole("button", { name: "Download" })).toBeVisible();
    await expect(canvas.queryByText(/Restart the app/)).not.toBeInTheDocument();
  },
};

/**
 * The press: the button gives way to the bar, the bar follows the engine's own progress, and
 * when the files have landed the box goes — the status is read again, it says the bundle
 * loaded, and the page is told the engine's session is a new one.
 */
export const Downloads: Story = {
  parameters: { fake: { fault: "scannerMissing" } },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText("scanner_status: no bundle");
    await userEvent.click(await canvas.findByRole("button", { name: "Download" }));
    await expect(
      await canvas.findByRole("progressbar", { name: "Downloading the scanner's files" }),
    ).toBeInTheDocument();
    await expect(canvas.queryByRole("button", { name: "Download" })).not.toBeInTheDocument();

    await canvas.findByText("scanner_status: bundle loaded");
    await waitFor(() =>
      expect(canvas.queryByRole("region", { name: "Scanner files" })).not.toBeInTheDocument(),
    );
    // Not a count: the spy is the file's one, and a story before this one may have ended a
    // fetch of its own. That it is called exactly once per fetch is the hook's own suite's.
    await waitFor(() => expect(args.onLoaded).toHaveBeenCalled());
  },
};

/**
 * A download that could not get its files: the engine's sentence, and a Retry — the reader's
 * press, never a loop. What is still owed is read from the host again, so a file that did land
 * before the failure is not fetched twice.
 */
export const Fails: Story = {
  parameters: { fake: { fault: "scannerFetchFails" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Download" }));
    await expect(await canvas.findByRole("alert")).toHaveTextContent(
      "card-hashes.bin is not published for this version of the app (HTTP 404).",
    );
    await expect(await canvas.findByRole("button", { name: "Retry" })).toBeVisible();
    await expect(canvas.queryByRole("progressbar")).not.toBeInTheDocument();
  },
};

/**
 * A host that owes nothing — every desktop release build, whose binary carries the files, and
 * any install once they have landed. No box, no button, and no request: the component draws
 * nothing at all.
 */
export const NothingOwed: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText("scanner_status: bundle loaded");
    await expect(canvas.queryByRole("region", { name: "Scanner files" })).not.toBeInTheDocument();
    await expect(canvas.queryByRole("button")).not.toBeInTheDocument();
  },
};
