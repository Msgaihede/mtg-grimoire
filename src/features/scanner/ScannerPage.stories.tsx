import { useEffect, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { ipc } from "@/lib/ipc";
import { DEFAULT_SCANNER_PREFS, TRAY_ROWS } from "./fixtures";
import { ScannerPage } from "./ScannerPage";
import type { ScannerPrefs, ScannerTrayRow } from "./types";

/**
 * Denies the camera before `ScannerPage` ever asks for it, and undoes that on unmount.
 *
 * **Not a mock of anything this app owns** — `useCamera`'s `getUserMedia` call is the one
 * browser API neither jsdom nor a sandboxed Storybook grants a camera for, so both refuse it
 * one way or another; this makes the refusal the *specific* one (`NotAllowedError`) rather than
 * whichever one an environment happens to throw first, so every run of this file lands on the
 * same sentence. `QrScanner.stories.tsx` took the other fork of this same fact — it asserts
 * only `/camera/i`, because jsdom has no `mediaDevices` at all there and a literal wait for the
 * `NotAllowedError` wording would fail under `stories.test.tsx` while passing in a real
 * browser. Stubbing the API here is what lets this file assert the literal sentence in both.
 *
 * **`useState`'s initializer, not a plain `useEffect`**, for `SearchPage.stories.tsx`'s reason:
 * an effect runs after the first paint, and `useCamera`'s own effect has to see the stub before
 * it fires. The initializer runs during render, which is before any effect in the tree does.
 * The cleanup undoes it on unmount so a later story in the same `stories.test.tsx` run does not
 * inherit today's rejection — `QrScanner`'s own story depends on `mediaDevices` staying absent.
 */
function CameraDenied() {
  const restore = useState(() => {
    const saved = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: () => Promise.reject(new DOMException("x", "NotAllowedError")),
      },
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
 * {@link CameraDenied}, over a world whose scanner rows were written first.
 *
 * **Written through the commands, not seeded**, because the two rows are `app_meta` values the
 * fake keeps per world and no seed carries — `FakeDb.scannerTray`'s own doc says a story that
 * wants rows writes them. `useState`'s initializer for `CameraDenied`'s reason: the fake's
 * handlers run synchronously inside `invoke`, so the rows are stored before the page's first
 * query asks for them, and an effect would be one render too late.
 */
function Written({ tray, prefs }: { tray?: ScannerTrayRow[]; prefs?: Partial<ScannerPrefs> }) {
  useState(() => {
    if (tray !== undefined) void ipc.setScannerTray(tray);
    if (prefs !== undefined) void ipc.setScannerPrefs({ ...DEFAULT_SCANNER_PREFS, ...prefs });
  });
  return <CameraDenied />;
}

const meta = {
  title: "Scanner/Page",
  component: ScannerPage,
  tags: ["autodocs"],
  render: () => <CameraDenied />,
  decorators: [
    // 1032×640 is `SearchPage.stories.tsx`'s box: the content column at the app's narrow rung,
    // 1280 less the sidebar's `w-52` (208px) and less `main`'s `p-5` on both sides (40px).
    (Story) => (
      <div className="h-[640px] w-[1032px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ScannerPage>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The camera refused, which is every reader's first paint of this page until they press
 * Allow — no browser here grants one uninvited, so `NotAllowedError` is the one shape of
 * refusal every reader of this story actually meets, and `CameraDenied` above is what makes it
 * the shape jsdom meets too rather than a `TypeError` about a missing API.
 *
 * The bar and the tray beside the video are unaffected: prefs, the tray and `scanner_status` all
 * answer regardless of the camera, which is what lets the two halves of this view be tested apart.
 */
export const CameraRefused: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByText("MTG Grimoire needs camera access to scan a card."),
    ).toBeInTheDocument();
  },
};

/**
 * The three scanner assets absent, which is a build without them embedded until a reader places
 * them — `scannerHandlers`' `scanner_status` names the bundle's own path in the sentence, so
 * the fixture and the page agree on where "here" is without either hard-coding the other's copy.
 *
 * The sentence is drawn on the reader's view, under the status line, rather than only in the
 * Developer panels: a reader who cannot scan anything is owed the path without a switch to find.
 * With no bundle there are no labels either, so the Filters trigger is out of reach and says why.
 */
export const AssetsMissing: Story = {
  parameters: { fake: { fault: "scannerMissing" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText(/No reference bundle\. Put/)).toBeInTheDocument();
    await expect(
      await canvas.findByRole("status", { name: "Scanner status" }),
    ).toHaveTextContent("The scanner has no card hashes loaded");
  },
};

/**
 * A session mid-pile: four rows, newest first — a Lightning Bolt still waiting on one of three
 * printings, a playset-in-progress of Urza's Saga at ×3, a foil Ancient Tomb, and the Black Lotus
 * scanned first.
 *
 * The Add button counts copies rather than rows and is out of reach while the Bolt is unpicked —
 * one press files everything, so a press that quietly left a card behind is not one it may make.
 */
export const WithTray: Story = {
  render: () => <Written tray={TRAY_ROWS} />,
  parameters: { docs: { story: { inline: false, height: "640px" } } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const tray = await canvas.findByRole("region", { name: "Scanned cards" });
    await expect(await within(tray).findByText("Urza's Saga")).toBeInTheDocument();
    await expect(
      within(tray).getByRole("group", { name: "Printings of Lightning Bolt" }),
    ).toBeInTheDocument();
    await expect(within(tray).getByRole("button", { name: "Add 6 to collection" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  },
};

/**
 * The Developer switch on: today's panels and the Tiers panel, under the tray in the same column.
 *
 * Stored rather than pressed, which is the state a reader who left it on comes back to — the
 * switch is a pref, so the page opens with the panels already there.
 */
export const Developer: Story = {
  render: () => <Written prefs={{ developer: true }} />,
  parameters: { docs: { story: { inline: false, height: "640px" } } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole("region", { name: "Match" })).toBeInTheDocument();
    await expect(canvas.getByRole("region", { name: "Tiers" })).toBeInTheDocument();
    await expect(canvas.getByRole("region", { name: "Scanned cards" })).toBeInTheDocument();
    await expect(canvas.getByRole("switch", { name: "Developer" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  },
};

// **No `WebBuild` story.** `isWebTarget()` is `__CORE__ === "web"`, a define this workbench's
// Vite config folds to `"tauri"` exactly as `vite.config.ts` does for `stories.test.tsx` — so
// the web build's one-sentence view is compiled clean out of every bundle this file can run
// against, and there is no per-story hook here to override a `define` the way `parameters.fake`
// overrides the backend. Reaching it needs `vi.mock("@/pwa/target", …)`, which is `stories.test.tsx`'s
// own tool and not the workbench's — no module-mock addon is installed, so a story cannot
// declare one. `ScannerPage.test.tsx`'s "says the web build has no detector and asks for no
// camera" is where that state is proven, and it stays there.
