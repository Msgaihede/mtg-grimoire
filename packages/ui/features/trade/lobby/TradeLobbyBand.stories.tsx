import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn } from "storybook/test";
import { TradeLobbyBand } from "./TradeLobbyBand";
import type { TradeLobby } from "./useTradeLobby";

function lobby(over: Partial<TradeLobby> = {}, accepted: [boolean, boolean] = [false, false]) {
  return {
    role: "host",
    kind: "trade",
    code: "K7QX2M",
    phase: "open",
    name: "Ada",
    hostName: "Ada",
    hostOnline: true,
    peers: [{ peer: "p1", name: "Bo", online: true, deck: null }],
    label: "",
    closedReason: null,
    trade: {
      tradeId: 7,
      unknown: 0,
      deal: {
        rev: 4,
        host: [],
        guest: [],
        hostAccepted: accepted[0],
        guestAccepted: accepted[1],
      },
    },
    ...over,
  } as TradeLobby;
}

const meta = {
  title: "Trade/TradeLobbyBand",
  component: TradeLobbyBand,
  tags: ["autodocs"],
  args: {
    lobby: lobby(),
    showing: true,
    onShow: fn(),
    onFinish: fn(),
    sendFailure: null,
  },
  decorators: [
    (Story) => (
      <div className="bg-bg p-6">
        <Story />
      </div>
    ),
  ],
  parameters: {
    docs: {
      description: {
        component:
          "A trade with another reader, over a lobby code: drawn by the Trade page above whichever " +
          "trade is shown. The code and its copy button, who the reader is trading with, where the " +
          "deal stands, **Accept trade** (or **Take back**), **Finish trade** once both have " +
          "accepted, and the way out. Each reader builds their own copy of the trade; their side " +
          "is what they give, and the other side is the other reader's offer, written in by the app.",
      },
    },
  },
} satisfies Meta<typeof TradeLobbyBand>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The host, before anybody has joined: nothing to accept yet. */
export const Waiting: Story = {
  args: { lobby: lobby({ peers: [] }) },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("button", { name: "Accept trade" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  },
};

/** Both readers are in and building the trade. */
export const Trading: Story = {};

/** The other reader has accepted; this one has not. */
export const TheyAccepted: Story = { args: { lobby: lobby({}, [false, true]) } };

/** A guest who has accepted, with one of the host's cards missing from this app's card data. */
export const YouAccepted: Story = {
  args: {
    lobby: lobby({ role: "guest", trade: { ...lobby().trade, unknown: 1 } }, [false, true]),
  },
};

/** Both have accepted: each finishes their own copy. */
export const Agreed: Story = {
  args: { lobby: lobby({ phase: "agreed" }, [true, true]) },
  play: async ({ canvas, args }) => {
    await canvas.getByRole("button", { name: "Finish trade" }).click();
    await expect(args.onFinish).toHaveBeenCalled();
  },
};

/** The lobby closed, with its reason, until the reader dismisses it. */
export const Closed: Story = {
  args: {
    lobby: lobby({ role: "guest", phase: "closed", closedReason: "The host closed the lobby." }),
  },
};
