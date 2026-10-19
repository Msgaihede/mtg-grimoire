import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DiscordStatus } from "@/lib/ipc";

const discordStatus = vi.hoisted(() => vi.fn());
const discordLinkBegin = vi.hoisted(() => vi.fn());
const discordLinkPoll = vi.hoisted(() => vi.fn());
const discordLinkCancel = vi.hoisted(() => vi.fn());
const discordEnable = vi.hoisted(() => vi.fn());
const discordDisable = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: {
    discordStatus,
    discordLinkBegin,
    discordLinkPoll,
    discordLinkCancel,
    discordEnable,
    discordDisable,
  },
}));
/** The app's one way out — mocked so a test can see the URL it was handed, and so nothing here
 *  reaches for a host. */
const openExternal = vi.hoisted(() => vi.fn());
vi.mock("@/lib/externalLinks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/externalLinks")>()),
  openExternal,
}));

import { DISCORD_COMMANDS, DiscordPanel, lastPullLine } from "./DiscordPanel";

const AUTHORIZE_URL = "https://discord.com/oauth2/authorize?state=abc";
const GATE =
  "Discord is for supporters, and no membership is connected to this group. Connect Patreon in Settings first.";

const UNLINKED: DiscordStatus = {
  linked: false,
  username: null,
  discordUserId: null,
  linking: false,
  linkExpiresAt: null,
  enrolled: false,
  botDeviceId: null,
  lastPullAt: null,
  gate: null,
};
const linking = (expiresAt = Date.now() + 10 * 60_000): DiscordStatus => ({
  ...UNLINKED,
  linking: true,
  linkExpiresAt: expiresAt,
});
const LINKED: DiscordStatus = {
  ...UNLINKED,
  linked: true,
  username: "giradeli",
  discordUserId: "1029384756473829101",
};
const ENROLLED: DiscordStatus = {
  ...LINKED,
  enrolled: true,
  botDeviceId: "bot-7f3a9c2e",
  lastPullAt: Date.now() - 2 * 60 * 60_000,
};

/** What `discord_status` answers — moved by the mocked writes, as the desktop's rows would be. */
let current: DiscordStatus;

function wrap(node: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{node}</QueryClientProvider>;
}

const theSwitch = () => screen.findByRole("switch", { name: /enable discord integration/i });
const addButton = () => screen.findByRole("button", { name: /add the bot to your sync group/i });

beforeEach(() => {
  vi.clearAllMocks();
  current = UNLINKED;
  discordStatus.mockImplementation(() => Promise.resolve(current));
  openExternal.mockResolvedValue(undefined);
  discordLinkCancel.mockImplementation(() => {
    current = UNLINKED;
    return Promise.resolve(current);
  });
  discordEnable.mockImplementation(() => {
    current = { ...ENROLLED, lastPullAt: null };
    return Promise.resolve(current);
  });
  discordDisable.mockImplementation(() => {
    current = UNLINKED;
    return Promise.resolve(current);
  });
});

describe("the Discord panel's sign-in", () => {
  it("says what the integration does, and that it is a supporter's", async () => {
    render(wrap(<DiscordPanel />));

    expect(await theSwitch()).toHaveAttribute("aria-checked", "false");
    expect(screen.getByText(/slash commands/i)).toHaveTextContent(/supporter feature/i);
  });

  /**
   * The whole flow: the switch begins a link, Discord's page goes to the system browser through
   * `openExternal`, and the panel claims until the reader has approved. **Two claims, two
   * seconds apart**, so the interval is what this test waits on rather than a first fetch that
   * happened to answer linked.
   */
  it("begins a link, opens Discord in the browser, and polls until it is linked", async () => {
    discordLinkBegin.mockImplementation(() => {
      current = linking();
      return Promise.resolve({ authorizeUrl: AUTHORIZE_URL, expiresAt: current.linkExpiresAt });
    });
    discordLinkPoll
      .mockImplementationOnce(() => Promise.resolve(current))
      .mockImplementationOnce(() => {
        current = LINKED;
        return Promise.resolve(current);
      });
    render(wrap(<DiscordPanel />));

    await userEvent.click(await theSwitch());

    expect(discordLinkBegin).toHaveBeenCalledOnce();
    await waitFor(() => expect(openExternal).toHaveBeenCalledExactlyOnceWith(AUTHORIZE_URL));
    expect(await screen.findByText(/waiting for discord/i)).toBeInTheDocument();
    expect(await theSwitch()).toHaveAttribute("aria-checked", "true");

    await waitFor(() => expect(screen.getByText(/signed in as/i)).toHaveTextContent("giradeli"), {
      timeout: 4_000,
    });
    expect(discordLinkPoll).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(/waiting for discord/i)).toBeNull();
    // Linked and nothing more: the next step is offered, and no claim goes out after the link.
    expect(await addButton()).toBeEnabled();
    await new Promise((r) => setTimeout(r, 2_200));
    expect(discordLinkPoll).toHaveBeenCalledTimes(2);
  }, 10_000);

  it("forgets a pending sign-in on Cancel", async () => {
    current = linking();
    discordLinkPoll.mockImplementation(() => Promise.resolve(current));
    render(wrap(<DiscordPanel />));

    await userEvent.click(await screen.findByRole("button", { name: "Cancel" }));

    expect(discordLinkCancel).toHaveBeenCalledOnce();
    await waitFor(async () => expect(await theSwitch()).toHaveAttribute("aria-checked", "false"));
    expect(screen.queryByText(/waiting for discord/i)).toBeNull();
  });

  it("draws the refusal when the link cannot begin, and opens nothing", async () => {
    discordLinkBegin.mockRejectedValue("Couldn't reach the MTG Grimoire Discord service.");
    render(wrap(<DiscordPanel />));

    await userEvent.click(await theSwitch());

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Couldn't reach the MTG Grimoire Discord service.",
    );
    expect(openExternal).not.toHaveBeenCalled();
    expect(await theSwitch()).toHaveAttribute("aria-checked", "false");
  });

  /** A refused claim — denied, expired, mismatched — is said, and the poll stops asking. */
  it("draws a refused claim and stops polling", async () => {
    current = linking();
    discordLinkPoll.mockRejectedValue("You declined the sign-in in Discord.");
    render(wrap(<DiscordPanel />));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "You declined the sign-in in Discord.",
    );
    const asked = discordLinkPoll.mock.calls.length;
    await new Promise((r) => setTimeout(r, 2_500));
    expect(discordLinkPoll).toHaveBeenCalledTimes(asked);
  });

  /** Past its deadline the request cannot be claimed, so nothing is asked and the switch is off
   *  again — the way to start another. */
  it("asks nothing of a request past its deadline", async () => {
    current = linking(Date.now() - 1);
    render(wrap(<DiscordPanel />));

    expect(await screen.findByText(/the sign-in expired/i)).toBeInTheDocument();
    expect(await theSwitch()).toHaveAttribute("aria-checked", "false");
    expect(screen.queryByText(/waiting for discord/i)).toBeNull();
    expect(discordLinkPoll).not.toHaveBeenCalled();
  });

  it("stops polling when the panel unmounts", async () => {
    current = linking();
    discordLinkPoll.mockImplementation(() => Promise.resolve(current));
    const { unmount } = render(wrap(<DiscordPanel />));
    await waitFor(() => expect(discordLinkPoll).toHaveBeenCalled());

    unmount();
    const asked = discordLinkPoll.mock.calls.length;
    await new Promise((r) => setTimeout(r, 2_500));
    expect(discordLinkPoll).toHaveBeenCalledTimes(asked);
  });
});

describe("the Discord panel, linked", () => {
  /** The engine's sentence is drawn as it is, and the step it refuses is closed. */
  it("draws the gate's sentence and disables Add", async () => {
    current = { ...LINKED, gate: GATE };
    render(wrap(<DiscordPanel />));

    expect(await screen.findByText(/signed in as/i)).toHaveTextContent("Signed in as giradeli");
    expect(screen.getByText(GATE)).toBeInTheDocument();
    expect(await addButton()).toBeDisabled();
  });

  /**
   * Adding the bot asks first, and the question says what the reader is agreeing to: a device
   * that adds only after a Confirm in Discord and never changes or removes anything, the folder
   * its adds land in, a copy the operator can decrypt, a device slot, and that it can go (spec
   * §14.5).
   */
  it("asks before it adds the bot, then enables and draws the enrolled bot", async () => {
    current = LINKED;
    let release: (next: DiscordStatus) => void = () => {};
    discordEnable.mockImplementation(
      () =>
        new Promise<DiscordStatus>((resolve) => {
          release = resolve;
        }),
    );
    render(wrap(<DiscordPanel />));

    await userEvent.click(await addButton());
    const dialog = await screen.findByRole("dialog", { name: "Add the bot to your sync group" });
    expect(dialog).toHaveTextContent(/add cards to your collection and your wishlist/i);
    expect(dialog).toHaveTextContent(/only after you press Confirm in Discord/i);
    expect(dialog).toHaveTextContent(/never change or remove anything/i);
    expect(dialog).toHaveTextContent(/go to Added from Discord unless you name another folder/i);
    expect(dialog).toHaveTextContent(/collection, wishlist and decks/i);
    expect(dialog).toHaveTextContent(/can decrypt/i);
    expect(dialog).toHaveTextContent(/five device slots/i);
    expect(dialog).toHaveTextContent(/remove it at any time/i);
    expect(discordEnable).not.toHaveBeenCalled();

    await userEvent.click(within(dialog).getByRole("button", { name: "Add the bot" }));

    expect(discordEnable).toHaveBeenCalledOnce();
    const busy = await screen.findByRole("button", { name: /adding the bot/i });
    expect(busy).toBeDisabled();
    expect(busy).toHaveAttribute("aria-busy", "true");
    expect(await theSwitch()).toBeDisabled();

    release({ ...ENROLLED, lastPullAt: null });

    expect(await screen.findByText(/is in your sync group as/i)).toHaveTextContent("bot-7f3a9c2e");
    expect(screen.getByText("The bot hasn't fetched your cards yet.")).toBeInTheDocument();
  });

  it("keeps the bot out when the question is cancelled", async () => {
    current = LINKED;
    render(wrap(<DiscordPanel />));

    await userEvent.click(await addButton());
    const dialog = await screen.findByRole("dialog", { name: "Add the bot to your sync group" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

    expect(discordEnable).not.toHaveBeenCalled();
    expect(await addButton()).toBeEnabled();
  });

  it("draws a refused enable in the panel", async () => {
    current = LINKED;
    discordEnable.mockRejectedValue("Five devices are already in your sync group.");
    render(wrap(<DiscordPanel />));

    await userEvent.click(await addButton());
    const dialog = await screen.findByRole("dialog", { name: "Add the bot to your sync group" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Add the bot" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Five devices are already in your sync group.",
    );
    // The refusal re-reads the status, since a part-way enable may have moved it.
    await waitFor(() => expect(discordStatus).toHaveBeenCalledTimes(2));
  });
});

describe("the Discord panel, enrolled", () => {
  it("names the bot, when it last fetched, and every command", async () => {
    current = ENROLLED;
    render(wrap(<DiscordPanel />));

    expect(await screen.findByText(/is in your sync group as/i)).toHaveTextContent("bot-7f3a9c2e");
    expect(screen.getByText("The bot last fetched your changes 2 hours ago.")).toBeInTheDocument();
    for (const { command } of DISCORD_COMMANDS) {
      expect(screen.getByText(command)).toBeInTheDocument();
    }
    expect(screen.getByText(/an add waits for you to press confirm/i)).toBeInTheDocument();
    expect(screen.getByText("/collection add")).toBeInTheDocument();
    expect(screen.getByText("/wishlist add")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /add the bot/i })).toBeNull();
  });

  /**
   * Switching off asks first — it removes the bot and deletes its copy — and the question names
   * what the app cannot do for the reader: take itself off their Discord account.
   */
  it("asks before it disables, and disables on the answer", async () => {
    current = ENROLLED;
    render(wrap(<DiscordPanel />));

    await userEvent.click(await theSwitch());
    const dialog = await screen.findByRole("dialog", { name: "Turn off Discord integration" });
    expect(dialog).toHaveTextContent(/removes the bot from your sync group/i);
    expect(dialog).toHaveTextContent(/deletes its copy/i);
    expect(dialog).toHaveTextContent(/authorized apps/i);
    expect(discordDisable).not.toHaveBeenCalled();

    await userEvent.click(within(dialog).getByRole("button", { name: "Turn off" }));

    expect(discordDisable).toHaveBeenCalledOnce();
    await waitFor(async () => expect(await theSwitch()).toHaveAttribute("aria-checked", "false"));
    expect(screen.queryByText(/signed in as/i)).toBeNull();
  });

  it("keeps the bot when the question is cancelled", async () => {
    current = ENROLLED;
    render(wrap(<DiscordPanel />));

    await userEvent.click(await theSwitch());
    const dialog = await screen.findByRole("dialog", { name: "Turn off Discord integration" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

    expect(discordDisable).not.toHaveBeenCalled();
    expect(await theSwitch()).toHaveAttribute("aria-checked", "true");
  });

  it("draws a refused disable in the panel", async () => {
    current = ENROLLED;
    discordDisable.mockRejectedValue("Couldn't reach the sync relay.");
    render(wrap(<DiscordPanel />));

    await userEvent.click(await theSwitch());
    const dialog = await screen.findByRole("dialog", { name: "Turn off Discord integration" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Turn off" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't reach the sync relay.");
  });
});

describe("the panel's sentences", () => {
  /** Milliseconds in, `ago`'s seconds underneath — the one conversion on the panel. */
  it("reads the pull stamp as milliseconds", () => {
    const now = 1_760_700_000_000;
    expect(lastPullLine({ ...ENROLLED, lastPullAt: now - 90 * 60_000 }, now)).toBe(
      "The bot last fetched your changes 1 hour ago.",
    );
    expect(lastPullLine({ ...ENROLLED, lastPullAt: null }, now)).toBe(
      "The bot hasn't fetched your cards yet.",
    );
  });
});
