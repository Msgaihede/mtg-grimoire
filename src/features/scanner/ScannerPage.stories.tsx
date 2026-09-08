import { useEffect, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { ScannerPage } from "./ScannerPage";

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
 * The panels beside the video are unaffected: `scanner_status` and the fixture verdict answer
 * regardless of the camera, which is what lets the two halves of this view be tested apart.
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
 * The three scanner assets absent, which is every installation's state until a reader places
 * them — `scannerHandlers`' `scanner_status` names the bundle's own path in the sentence, so
 * the fixture and the panel agree on where "here" is without either hard-coding the other's copy.
 */
export const AssetsMissing: Story = {
  parameters: { fake: { fault: "scannerMissing" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText(/No reference bundle\. Put/)).toBeInTheDocument();
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
