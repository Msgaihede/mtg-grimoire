import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { WebStoragePanel, type WebStorageView } from "./WebStoragePanel";

function view(over: Partial<WebStorageView> = {}): WebStorageView {
  return {
    install: "unavailable",
    onInstall: fn(),
    persistence: null,
    persisted: null,
    estimate: null,
    ...over,
  };
}

const meta = {
  title: "Settings/WebStoragePanel",
  component: WebStoragePanel,
  tags: ["autodocs"],
  args: { storage: view() },
  decorators: [
    (Story) => (
      <div className="max-w-2xl p-2">
        <Story />
      </div>
    ),
  ],
  parameters: {
    docs: {
      description: {
        component:
          "The panel that exists only on the web target, and the one on this page that " +
          "deliberately refuses to draw a conclusion.\n\n" +
          "**The estimate is printed and gates nothing.** `navigator.storage.estimate()` " +
          "reported 647 MB during a fill and 7 MB immediately after a restart, against a file " +
          "that was 532.8 MB both times, and reported an identical 10,887 MB quota on a " +
          "desktop workstation and on a phone. A pre-flight built on it would refuse a sync " +
          "that would have worked and allow one that could not — so the sentence under it says " +
          "so in the reader's own words.\n\n" +
          "**`persist()` is a record and not a guarantee** either. It is asked once, when the " +
          "corpus exists rather than at boot, and a `true` would still not mean the data is " +
          "safe: Cache Storage and OPFS are evicted independently, which is what makes 'shell " +
          "loaded, corpus gone' a state the app has to handle whatever this row says.\n\n" +
          "**The install row's honest state is the common one.** Chrome gates its offer behind " +
          "an engagement heuristic nobody can query and Firefox on desktop offers none at all.",
      },
    },
  },
} satisfies Meta<typeof WebStoragePanel>;

export default meta;
type Story = StoryObj<typeof meta>;

/** What most readers meet: no offer, no grant, no numbers. Every sentence is still true. */
export const NothingOffered: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(/has not offered an install/)).toBeInTheDocument();
    await expect(canvas.getByText(/may clear this site's data/)).toBeInTheDocument();
  },
};

/** Chrome has decided the reader is engaged enough. The press hands them its own dialog. */
export const InstallOffered: Story = {
  args: { storage: view({ install: "offered" }) },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: /Install app/ }));
    await expect(args.storage.onInstall).toHaveBeenCalledTimes(1);
  },
};

/**
 * After an install, which is the thing most likely to turn `persist()` into a `true`. The
 * button is gone rather than greyed: the browser refuses a second prompt outright.
 */
export const InstalledAndPersisted: Story = {
  args: {
    storage: view({
      install: "installed",
      persisted: true,
      persistence: { askedAt: 1_700_000_000_000, granted: true },
      estimate: { usage: 561_000_000, quota: 10_887_000_000 },
    }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(/has agreed to keep/)).toBeInTheDocument();
    await expect(canvas.queryByRole("button", { name: /Install app/ })).not.toBeInTheDocument();
  },
};

/**
 * The reading that made the sentence necessary: 7 MB reported immediately after a restart,
 * against a database that was 532.8 MB. Nothing on the panel changes because of it.
 */
export const TheEstimateIsWrong: Story = {
  args: {
    storage: view({
      install: "offered",
      persisted: true,
      estimate: { usage: 7_000_000, quota: 10_887_000_000 },
    }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(/estimates 7\.0 MB in use/)).toBeInTheDocument();
    await expect(canvas.getByRole("button", { name: /Install app/ })).toBeEnabled();
  },
};
