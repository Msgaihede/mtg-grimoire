import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { McpStatus } from "@/lib/ipc";

const mcpStatus = vi.hoisted(() => vi.fn());
const mcpEnable = vi.hoisted(() => vi.fn());
const mcpDisable = vi.hoisted(() => vi.fn());
const mcpRotateToken = vi.hoisted(() => vi.fn());
const mcpSetPort = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: { mcpStatus, mcpEnable, mcpDisable, mcpRotateToken, mcpSetPort },
}));
const copyText = vi.hoisted(() => vi.fn());
vi.mock("@/lib/clipboard", () => ({ copyText }));

import {
  clientSnippet,
  listeningLine,
  LocalMcpSection,
  MCP_OFF,
  MCP_SENTENCE,
  NOT_RUNNING,
  parsePort,
  PORT_RANGE,
} from "./LocalMcpSection";

const TOKEN = "0123456789abcdef".repeat(4);
const NEXT_TOKEN = "fedcba9876543210".repeat(4);

/** A whole status, typed — a bare literal would keep compiling after a field joined the mirror. */
function status(over: Partial<McpStatus> = {}): McpStatus {
  const port = over.port ?? 39147;
  return {
    enabled: false,
    running: false,
    port,
    url: `http://127.0.0.1:${port}/mcp`,
    token: TOKEN,
    error: null,
    ...over,
  };
}

const ON = status({ enabled: true, running: true });

function Harness({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
      }),
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function setup() {
  render(<LocalMcpSection />, { wrapper: Harness });
}

const theSwitch = () =>
  screen.findByRole("switch", { name: /^Let agents on this computer connect/ });
const portBox = () => screen.getByRole("textbox", { name: "Port" });

beforeEach(() => {
  mcpStatus.mockReset().mockResolvedValue(status());
  mcpEnable.mockReset();
  mcpDisable.mockReset();
  mcpRotateToken.mockReset();
  mcpSetPort.mockReset();
  copyText.mockReset().mockResolvedValue(undefined);
});

describe("LocalMcpSection", () => {
  it("says what it is, and opens off with nothing to configure yet", async () => {
    setup();
    const toggle = await theSwitch();

    expect(screen.getByText(MCP_SENTENCE)).toBeInTheDocument();
    // Pinned in its own words too: the export would agree with any paraphrase of itself.
    expect(screen.getByText(/Nothing leaves this computer, and it's free\.$/)).toBeInTheDocument();
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(toggle).toHaveAccessibleDescription(MCP_OFF);
    expect(screen.queryByText("Token")).toBeNull();
    expect(portBox()).toHaveValue("39147");
  });

  it("switches on, and says the address it is listening at", async () => {
    mcpEnable.mockResolvedValue(ON);
    setup();
    const toggle = await theSwitch();

    await userEvent.click(toggle);

    expect(mcpEnable).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "true"));
    expect(toggle).toHaveAccessibleDescription(listeningLine("http://127.0.0.1:39147/mcp"));
    expect(screen.getByText("Address")).toBeInTheDocument();
  });

  it("switches off without asking", async () => {
    mcpStatus.mockResolvedValue(ON);
    mcpDisable.mockResolvedValue(status());
    setup();
    const toggle = await theSwitch();
    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "true"));

    await userEvent.click(toggle);

    expect(mcpDisable).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "false"));
  });

  /**
   * **The token is the server's whole protection**, so it is not on screen until asked for — in
   * its own row or in a snippet — and Copy hands over the real one either way.
   */
  it("masks the token until asked, and copies the real one either way", async () => {
    mcpStatus.mockResolvedValue(ON);
    setup();
    await theSwitch();
    await screen.findByText("Token");

    expect(screen.queryByText(TOKEN)).toBeNull();
    expect(document.body.textContent).not.toContain(TOKEN);

    await userEvent.click(screen.getByRole("button", { name: "Copy the token" }));
    expect(copyText).toHaveBeenCalledWith(TOKEN);
    expect(await screen.findByRole("button", { name: "Copied the token" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Show the token" }));
    expect(screen.getByText(TOKEN)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Hide the token" }));
    expect(screen.queryByText(TOKEN)).toBeNull();
  });

  it("asks before replacing the token, and draws the new one", async () => {
    mcpStatus.mockResolvedValue(ON);
    mcpRotateToken.mockResolvedValue({ ...ON, token: NEXT_TOKEN });
    setup();
    await theSwitch();

    await userEvent.click(await screen.findByRole("button", { name: "New token" }));
    const question = screen.getByRole("dialog", { name: "Replace the token" });
    expect(question).toHaveTextContent(/stop working/);
    expect(mcpRotateToken).not.toHaveBeenCalled();

    await userEvent.click(within(question).getByRole("button", { name: "Replace token" }));
    expect(mcpRotateToken).toHaveBeenCalledTimes(1);
    // The caret goes back to the button that asked.
    expect(screen.getByRole("button", { name: "New token" })).toHaveFocus();

    await userEvent.click(screen.getByRole("button", { name: "Show the token" }));
    expect(await screen.findByText(NEXT_TOKEN)).toBeInTheDocument();
  });

  it("cancelling the question replaces nothing", async () => {
    mcpStatus.mockResolvedValue(ON);
    setup();
    await theSwitch();

    await userEvent.click(await screen.findByRole("button", { name: "New token" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(mcpRotateToken).not.toHaveBeenCalled();
  });

  it("copies the chosen client's configuration with the real token", async () => {
    mcpStatus.mockResolvedValue(ON);
    setup();
    await theSwitch();

    await userEvent.click(await screen.findByRole("radio", { name: "Claude Desktop" }));
    expect(screen.getByRole("radio", { name: "Claude Desktop" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Copy the Claude Desktop configuration" }),
    );

    expect(copyText).toHaveBeenCalledWith(clientSnippet("claude-desktop", ON.url, TOKEN));
  });

  it("says a clipboard refusal rather than claiming a copy", async () => {
    mcpStatus.mockResolvedValue(ON);
    copyText.mockRejectedValue("The clipboard is not available.");
    setup();
    await theSwitch();

    await userEvent.click(await screen.findByRole("button", { name: "Copy the address" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Couldn't copy: The clipboard is not available.",
    );
    expect(screen.queryByRole("button", { name: "Copied the address" })).toBeNull();
  });

  it("sends a new port, and draws the address it answers", async () => {
    mcpStatus.mockResolvedValue(ON);
    mcpSetPort.mockResolvedValue(status({ enabled: true, running: true, port: 40000 }));
    setup();
    const toggle = await theSwitch();

    await userEvent.clear(portBox());
    await userEvent.type(portBox(), "40000{Enter}");

    expect(mcpSetPort).toHaveBeenCalledWith(40000);
    await waitFor(() =>
      expect(toggle).toHaveAccessibleDescription(listeningLine("http://127.0.0.1:40000/mcp")),
    );
    expect(portBox()).toHaveValue("40000");
  });

  /** The desktop's refusal is the sentence drawn, and the reader's draft stays to be fixed. */
  it("shows a refused port in the desktop's words, keeping the draft", async () => {
    mcpStatus.mockResolvedValue(ON);
    mcpSetPort.mockRejectedValue(
      "Port 8080 is already in use by another program. Choose another port below.",
    );
    setup();
    await theSwitch();

    await userEvent.clear(portBox());
    await userEvent.type(portBox(), "8080");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Port 8080 is already in use by another program. Choose another port below.",
    );
    expect(portBox()).toHaveValue("8080");
  });

  it("refuses a port it would not send, without asking the desktop", async () => {
    setup();
    await theSwitch();

    for (const typed of ["80", "70000", "4e4", "port"]) {
      await userEvent.clear(portBox());
      await userEvent.type(portBox(), `${typed}{Enter}`);
      expect(await screen.findByRole("alert")).toHaveTextContent(PORT_RANGE);
    }
    expect(mcpSetPort).not.toHaveBeenCalled();
  });

  /** A launch that found the port taken: On, not listening, and the bind's sentence as the note. */
  it("draws an enabled server that is not running with its error", async () => {
    const error = "Port 39147 is already in use by another program. Choose another port below.";
    mcpStatus.mockResolvedValue(status({ enabled: true, running: false, error }));
    setup();
    const toggle = await theSwitch();

    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(toggle).toHaveAccessibleDescription(error);
    // The configuration is still offered: it is what the reader needs once the port is moved.
    expect(screen.getByText("Token")).toBeInTheDocument();
  });

  it("names the switch when an enabled server is not running and says nothing of why", async () => {
    mcpStatus.mockResolvedValue(status({ enabled: true, running: false, error: null }));
    setup();

    expect(await theSwitch()).toHaveAccessibleDescription(NOT_RUNNING);
  });
});

describe("parsePort", () => {
  it.each([
    ["39147", 39147],
    [" 1024 ", 1024],
    ["65535", 65535],
    ["1023", null],
    ["65536", null],
    ["", null],
    ["4e4", null],
    ["-1", null],
    ["3.5", null],
  ])("%j → %s", (text, port) => {
    expect(parsePort(text)).toBe(port);
  });
});

describe("clientSnippet", () => {
  const url = "http://127.0.0.1:39147/mcp";

  it("writes Claude Code's command", () => {
    expect(clientSnippet("claude-code", url, TOKEN)).toBe(
      `claude mcp add --transport http mtg-grimoire ${url} --header "Authorization: Bearer ${TOKEN}"`,
    );
  });

  it("writes the URL-and-headers JSON Cursor reads", () => {
    expect(JSON.parse(clientSnippet("cursor", url, TOKEN))).toEqual({
      mcpServers: {
        "mtg-grimoire": { url, headers: { Authorization: `Bearer ${TOKEN}` } },
      },
    });
  });

  /**
   * **`Authorization:${AUTH}` with no space, and the value in `env`** — `mcp-remote`'s workaround
   * for `npx` re-splitting arguments on spaces on Windows. A space here is three arguments there.
   */
  it("writes Claude Desktop's mcp-remote bridge, header without a space", () => {
    expect(JSON.parse(clientSnippet("claude-desktop", url, TOKEN))).toEqual({
      mcpServers: {
        "mtg-grimoire": {
          command: "npx",
          args: ["-y", "mcp-remote", url, "--header", "Authorization:${AUTH}"],
          env: { AUTH: `Bearer ${TOKEN}` },
        },
      },
    });
  });
});
