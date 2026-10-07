import { useEffect, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import {
  DEFAULT_SCANNER_PREFS,
  NEEDS_A_FINISH_ROW,
  TRAY_ROWS,
} from "@/features/scanner/fixtures";
import { SCANNER_OPEN_ELSEWHERE } from "@/features/scanner/verdictText";
import { ipc, type ScannerPrefs, type ScannerTrayRow } from "@/lib/ipc";
import { ScannerPage } from "./ScannerPage";

/**
 * The page with the camera refused before it ever asks, over a world whose scanner rows were
 * written first — the desktop page's stories' arrangement (`Scanner/Page`), for its two reasons.
 *
 * **The camera is refused in the browser's own way** (`NotAllowedError`), from a `useState`
 * initializer so the stub is in place before `useCamera`'s effect fires, and put back on unmount:
 * neither jsdom nor a sandboxed workbench grants a camera, and without the stub each refuses in a
 * way of its own, so the sentence would differ by where the story ran.
 *
 * **The tray and the prefs are written through the commands, not seeded**: they are two `app_meta`
 * values the fake keeps per world and no seed carries. The fake's handlers run synchronously inside
 * `invoke`, so the rows are stored before the page's first query asks for them.
 *
 * A camera that *does* open is answered by the fake's scripted pile — `npm run mobile:dev` and
 * `npm run mobile:scanner-smoke` are where that is watched; a story has no camera to open.
 */
function Refused({ tray, prefs }: { tray?: ScannerTrayRow[]; prefs?: Partial<ScannerPrefs> }) {
  const restore = useState(() => {
    if (tray !== undefined) void ipc.setScannerTray(tray);
    if (prefs !== undefined) void ipc.setScannerPrefs({ ...DEFAULT_SCANNER_PREFS, ...prefs });
    const saved = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: () => Promise.reject(new DOMException("x", "NotAllowedError")) },
    });
    return () => {
      if (saved === undefined) Reflect.deleteProperty(navigator, "mediaDevices");
      else Object.defineProperty(navigator, "mediaDevices", saved);
    };
  })[0];
  useEffect(() => restore, [restore]);
  return <ScannerPage />;
}

/**
 * The phone face's Scanner page, in a box as tall as the page between a phone's two bars.
 *
 * **As wide as the canvas, not boxed at 360**, where `Phone/Shell` is. The page lays itself out
 * by the *viewport's* width — below 720px one scrolling column over the footer, from 720px the
 * camera's column beside the tray's — so a 360px box in a wide
 * canvas would draw the wide arrangement squeezed into a phone's width, which is a picture of
 * nothing. Narrow the canvas with the workbench's viewport tool to see it as a phone held upright
 * draws it; the measurements at 360 and 412 are `npm run mobile:scanner-smoke`'s.
 *
 * **Each docs story has a frame of its own**: the page opens sheets and dialogs, which cover the
 * window they are in.
 */
const meta = {
  title: "Phone/Scanner",
  component: ScannerPage,
  tags: ["autodocs"],
  render: () => <Refused />,
  decorators: [
    (Story) => (
      <div className="flex h-[40rem] w-full flex-col overflow-hidden bg-bg text-text">
        <Story />
      </div>
    ),
  ],
  parameters: {
    docs: {
      story: { inline: false, height: "660px" },
      description: {
        component:
          "The desktop reader's parts in the phone's idioms: a bar with one Options press, the " +
          "camera shaped by its stream, the status line on two lines, the review tray as rows a " +
          "thumb can work, and a footer — the destination and Add — that stays put while the " +
          "rest scrolls. The tray and the prefs are the same two rows the desktop face reads.",
      },
    },
  },
} satisfies Meta<typeof ScannerPage>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The camera refused and nothing scanned: every reader's first paint until they press Allow.
 *
 * The bar, the tray and the footer are drawn regardless — the prefs, the tray and `scanner_status`
 * answer whatever the camera does. Add stays on the page, greyed, **with its reason in words under
 * it**: the desktop says that reason in a tooltip, which a finger never opens.
 */
export const CameraRefused: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByText("MTG Grimoire needs camera access to scan a card."),
    ).toBeInTheDocument();
    await expect(canvas.getByRole("status", { name: "Scanner status" })).toHaveTextContent(
      "Point the camera at a card",
    );
    await expect(await canvas.findByText("Cards you scan appear here.")).toBeInTheDocument();
    await expect(canvas.getByRole("button", { name: "Add 0 to collection" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await expect(canvas.getByText("Nothing scanned yet")).toBeInTheDocument();
  },
};

/**
 * A session mid-pile, newest first: a Lightning Bolt whose finish the scanner could not read, one
 * still waiting on a printing, a playset-in-progress, a foil, and the first card scanned.
 *
 * The two questions the tray asks are both here and both gold: the waiting row is its three
 * candidates, each a whole card to press, and the unread finish is a press reading `Unknown`. The
 * header's walk lands on each in turn. Add is refused while a printing is unpicked, and says so.
 */
export const WithTray: Story = {
  render: () => <Refused tray={[NEEDS_A_FINISH_ROW, ...TRAY_ROWS]} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const tray = await canvas.findByRole("region", { name: "Scanned cards" });
    await expect(await within(tray).findByText("Urza's Saga")).toBeInTheDocument();
    await expect(
      within(tray).getByRole("heading", { name: "Scanned cards, 7 copies" }),
    ).toBeInTheDocument();
    const question = within(tray).getByRole("group", { name: "Printings of Lightning Bolt" });
    await expect(within(question).getAllByRole("button")).toHaveLength(3);
    await expect(
      within(tray).getByRole("button", { name: "Finish of Lightning Bolt — STA 105: Unknown" }),
    ).toBeInTheDocument();
    await expect(
      canvas.getByRole("button", { name: "Add 6 to collection · 1 needs a finish" }),
    ).toHaveAttribute("aria-disabled", "true");
    await expect(canvas.getByText("Pick a printing for every card first")).toBeInTheDocument();
  },
};

/**
 * A row's finish, opened: the four answers as a sheet, the one it is in ticked.
 *
 * `Unknown` is offered on purpose — it is how a reader holds a card out of the next Add without
 * removing it — and says what choosing it does.
 */
export const FinishSheet: Story = {
  render: () => <Refused tray={TRAY_ROWS.filter((row) => row.choices.length === 0)} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      await canvas.findByRole("button", { name: "Finish of Ancient Tomb — TMP 315: Foil" }),
    );
    const sheet = await canvas.findByRole("dialog", { name: "Ancient Tomb" });
    const finishes = within(within(sheet).getByRole("list", { name: "Finishes" })).getAllByRole(
      "button",
    );
    await expect(finishes).toHaveLength(4);
    await expect(within(sheet).getByRole("button", { name: "Foil" })).toHaveAttribute(
      "aria-current",
      "true",
    );
  },
};

/**
 * Everything that is not on the bar, behind its one press: the mode again with each mode's
 * sentence, the filters, the tray's two defaults.
 *
 * No Camera row — this device has one camera or none, so there is no choice to draw — and no
 * Developer switch: the developer panels are the desktop's.
 */
export const Options: Story = {
  render: () => <Refused prefs={{ mode: "exact", finish: "foil", condition: "NM" }} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() =>
      expect(canvas.getByRole("button", { name: "Exact" })).toHaveAttribute("aria-pressed", "true"),
    );
    await userEvent.click(canvas.getByRole("button", { name: "Scanner options" }));
    const sheet = await canvas.findByRole("dialog", { name: "Scanner options" });
    const rows = within(sheet)
      .getAllByRole("button")
      .map((row) => row.textContent);
    await expect(rows).toContain("Scan modeExact");
    await expect(rows).toContain("FiltersAny set");
    await expect(rows).toContain("FinishFoil");
    await expect(rows).toContain("ConditionNear mint");
    await expect(within(sheet).queryByRole("switch")).toBeNull();
  },
};

/**
 * Where the tray files, opened from the footer: the Collection, then the reader's own folders,
 * nested — and nothing the app owns. A drawer set aside is offered, and marked.
 */
export const FolderSheet: Story = {
  render: () => <Refused tray={TRAY_ROWS.filter((row) => row.choices.length === 0)} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Folder: Collection" }));
    const sheet = await canvas.findByRole("dialog", { name: "Folder for scanned cards" });
    const folders = within(await within(sheet).findByRole("list", { name: "Folders" }))
      .getAllByRole("button")
      .map((row) => row.querySelector("span.truncate")?.textContent);
    await expect(folders).toEqual(["Collection", "Binder", "Trade binder", "Someday"]);
  },
};

/**
 * The scanner's data absent — the state a light install starts in, since it does not carry the
 * bundle and the reading models inside its binary.
 *
 * What is missing is said in the slot kept for it under the camera, in the status's own sentences;
 * a later step of phase 7 draws the offer to download the data there. The status line says cards
 * can be found and not named, and the Filters row in Options is refused, with its reason.
 */
export const AssetsMissing: Story = {
  parameters: { fake: { fault: "scannerMissing" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText(/No reference bundle\. Put/)).toBeInTheDocument();
    await expect(await canvas.findByText(/No OCR models\. Put/)).toBeInTheDocument();
    await waitFor(() =>
      expect(canvas.getByRole("status", { name: "Scanner status" })).toHaveTextContent(
        "Card hashes aren't loaded",
      ),
    );
  },
};

/**
 * Another window holds the scanner: two sentences, no camera, no tray.
 *
 * The tray is the other window's to write while it holds the lease, so it is not drawn here at
 * all. Its absence is asserted after the sentence has landed, since before the ask answers there
 * is no tray either.
 */
export const OpenElsewhere: Story = {
  parameters: { fake: { fault: "scannerElsewhere" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText(SCANNER_OPEN_ELSEWHERE)).toBeInTheDocument();
    await expect(canvas.queryByRole("region", { name: "Scanned cards" })).toBeNull();
    await expect(canvas.queryByRole("button", { name: "Stop scanning" })).toBeNull();
  },
};
