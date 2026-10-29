import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { focusManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IntegrationFields, IntegrationsStatus, McpStatus } from "@/lib/ipc";

const integrationsStatus = vi.hoisted(() => vi.fn());
const integrationsEnable = vi.hoisted(() => vi.fn());
const integrationsSetFields = vi.hoisted(() => vi.fn());
const integrationsDisable = vi.hoisted(() => vi.fn());
// The local MCP server's read, which the panel's first part makes on mount. Its own suite is
// `LocalMcpSection.test.tsx`; here it answers Off so the cloud part's assertions stand alone.
const mcpStatus = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: {
    integrationsStatus,
    integrationsEnable,
    integrationsSetFields,
    integrationsDisable,
    mcpStatus,
  },
}));

import {
  checkedLine,
  CLOUD_HEADING,
  IntegrationsPanel,
  NOT_AVAILABLE,
  NOT_ENTITLED,
  PRIVACY_SENTENCE,
  PUBLISH_POLL_MS,
  SENDING,
  sentLine,
  STRANDED,
} from "./IntegrationsPanel";
import { MCP_HEADING } from "./LocalMcpSection";

/** A fixed instant every "2 hours ago" below is read against. */
const NOW = Math.floor(Date.now() / 1000);

const NONE: IntegrationFields = {
  condition: false,
  lang: false,
  value: false,
  tags: false,
  notes: false,
};

/**
 * A whole status, typed — `vi-fn-mocks-erase-the-ipc-mirror`'s repair: a bare literal handed to
 * `mockResolvedValue` would keep compiling after a field was added to the mirror.
 */
function status(over: Partial<IntegrationsStatus> = {}): IntegrationsStatus {
  return {
    available: true,
    entitled: true,
    enabled: false,
    fields: NONE,
    checkedAt: null,
    publishedAt: null,
    error: null,
    pending: false,
    ...over,
  };
}

/** Condition and value on, the other three off — **mixed**, so a write that sent only the box it
 *  changed, or crossed two columns, cannot pass for one that sent the whole set. */
const ON = status({
  enabled: true,
  fields: { condition: true, lang: false, value: true, tags: false, notes: false },
  checkedAt: NOW - 60,
  publishedAt: NOW - 7_200,
});

/** A promise the test settles by hand — a read or a press still out when the next thing happens. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

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
  render(<IntegrationsPanel />, { wrapper: Harness });
}

/** The switch, once the status has answered — its name is the line beside it and its own word. */
const theSwitch = () => screen.findByRole("switch", { name: /^Keep a copy for integrations/ });
const box = (name: string) => screen.getByRole("checkbox", { name });
const theQuestion = () => screen.getByRole("dialog", { name: "Turn off integrations" });

/** The local server off — typed, for `status`'s reason. */
const MCP_OFF: McpStatus = {
  enabled: false,
  running: false,
  port: 39147,
  url: "http://127.0.0.1:39147/mcp",
  token: "0123456789abcdef".repeat(4),
  error: null,
};

beforeEach(() => {
  mcpStatus.mockReset().mockResolvedValue(MCP_OFF);
  integrationsStatus.mockReset().mockResolvedValue(status());
  integrationsEnable.mockReset();
  integrationsSetFields.mockReset();
  integrationsDisable.mockReset();
});

afterEach(() => {
  // A test that played with the window's focus hands TanStack's own reading back.
  focusManager.setFocused(undefined);
});

describe("IntegrationsPanel", () => {
  it("says what the copy is, word for word, and what is never in it", async () => {
    setup();
    await theSwitch();

    expect(screen.getByText(PRIVACY_SENTENCE)).toBeInTheDocument();
    // Pinned in its own words as well as through the export: the export is the panel's own
    // constant, and an assertion reading only that would agree with a paraphrase.
    expect(
      screen.getByText(/^If you enable an integration, our servers hold a copy of the parts/),
    ).toBeInTheDocument();
    expect(screen.getByText("No integration reads this copy yet.")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Purchase price, purchase currency, acquired date and acquisition source are never included.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Locked folders are included — this copy is private to your integrations, not a public share.",
      ),
    ).toBeInTheDocument();
    // Any device of the group may be the one that refills it — never "every device".
    expect(
      screen.getByText(
        "Changing these while the copy is on deletes it from the server, and your devices send it again under the new choice.",
      ),
    ).toBeInTheDocument();
  });

  /**
   * **Two switches in one panel that must not read as one** — the local MCP server above, the
   * cloud copy below, each under its own heading, and the cloud copy's sentences inside its own
   * part: the local server reads the database, never the copy.
   */
  it("draws the local server and the cloud copy as two named parts, the local one first", async () => {
    setup();
    await theSwitch();

    const local = screen.getByRole("group", { name: MCP_HEADING });
    const cloud = screen.getByRole("group", { name: CLOUD_HEADING });
    expect(local.compareDocumentPosition(cloud) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(cloud).getByText(PRIVACY_SENTENCE)).toBeInTheDocument();
    expect(within(cloud).getByRole("switch")).toHaveAccessibleName(/^Keep a copy for integrations/);
    expect(within(local).queryByText(PRIVACY_SENTENCE)).toBeNull();
    expect(
      await within(local).findByRole("switch", { name: /^Let agents on this computer connect/ }),
    ).toHaveAttribute("aria-checked", "false");
  });

  it("opens off, with all five boxes clear and pressable", async () => {
    setup();

    const toggle = await theSwitch();
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(toggle).not.toHaveAttribute("aria-disabled");
    for (const name of ["Condition", "Language", "Market value", "Entry tags", "Entry notes"]) {
      expect(box(name)).not.toBeChecked();
      expect(box(name)).not.toHaveAttribute("aria-disabled");
    }
  });

  /**
   * The boxes ticked while off are the draft, and the switch's press is what sends them — two
   * of five, so a press that sent every box, or none, fails.
   *
   * **The press publishes nothing** (`settings.rs`: "the round publishes, not the press"): it
   * answers `pending` and a `publishedAt` it did not move, so the line says a send is on its way
   * rather than claiming one happened.
   */
  it("switches on with the boxes that were ticked, and says the copy is on its way", async () => {
    integrationsEnable.mockResolvedValue(
      status({ enabled: true, fields: { ...NONE, condition: true, notes: true }, pending: true }),
    );
    setup();
    const toggle = await theSwitch();

    await userEvent.click(box("Condition"));
    await userEvent.click(box("Entry notes"));
    // Ticking while off sends nothing: the store does not exist yet.
    expect(integrationsSetFields).not.toHaveBeenCalled();
    await userEvent.click(toggle);

    expect(integrationsEnable).toHaveBeenCalledTimes(1);
    expect(integrationsEnable).toHaveBeenCalledWith({
      condition: true,
      lang: false,
      value: false,
      tags: false,
      notes: true,
    });
    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "true"));
    expect(screen.getByText(SENDING)).toBeInTheDocument();
    expect(screen.queryByText(/^Last sent from this device/)).toBeNull();
    expect(screen.queryByText("Nothing sent from this device yet.")).toBeNull();
  });

  /**
   * **Nothing else re-reads the status while the panel is open**, so the panel asks again while a
   * publish it asked for is pending — and stops once it has run.
   *
   * **On a faked clock**, which is what keeps this test at milliseconds rather than two real
   * intervals under `verify`'s load. `setInterval` is faked beside the repo's usual two because
   * TanStack's `refetchInterval` is one; `Date` is not, so "just now" still reads the real clock.
   * No `userEvent` and no `findBy`/`waitFor` while it is faked — both wait on the clock this
   * replaces, and stall (`frontend-test-traps`) — so every step is an explicit advance inside
   * `act`, whose async form also lets the mocked reads settle and TanStack's `setTimeout(0)`
   * notifications fire before the next assertion.
   */
  it("asks again while a send is pending, draws the round's answer, and then stops asking", async () => {
    integrationsStatus
      .mockResolvedValueOnce(status({ ...ON, publishedAt: null, pending: true }))
      .mockResolvedValue(status({ ...ON, publishedAt: NOW, pending: false }));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    try {
      const advance = (ms: number) =>
        act(async () => {
          await vi.advanceTimersByTimeAsync(ms);
        });
      setup();
      // The first read, and the notification that draws it.
      await advance(10);
      expect(screen.getByText(SENDING)).toBeInTheDocument();
      expect(integrationsStatus).toHaveBeenCalledTimes(1);

      // Short of one interval: nobody asked yet. Past it: asked once, and the round's answer drawn.
      await advance(PUBLISH_POLL_MS - 100);
      expect(integrationsStatus).toHaveBeenCalledTimes(1);
      await advance(200);
      expect(integrationsStatus).toHaveBeenCalledTimes(2);
      expect(screen.getByText("Last sent from this device: just now.")).toBeInTheDocument();

      // Nothing is pending now: three more intervals pass and nobody is asked.
      await advance(PUBLISH_POLL_MS * 3);
      expect(integrationsStatus).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends the whole set when a box changes while on", async () => {
    integrationsStatus.mockResolvedValue(ON);
    integrationsSetFields.mockResolvedValue(
      status({ ...ON, fields: { ...ON.fields, lang: true }, pending: true }),
    );
    setup();
    await theSwitch();
    // The group's choice is what is drawn while on.
    expect(box("Condition")).toBeChecked();
    expect(box("Market value")).toBeChecked();

    await userEvent.click(box("Language"));

    expect(integrationsSetFields).toHaveBeenCalledTimes(1);
    expect(integrationsSetFields).toHaveBeenCalledWith({
      condition: true,
      lang: true,
      value: true,
      tags: false,
      notes: false,
    });
    await waitFor(() => expect(box("Language")).toBeChecked());
    expect(integrationsEnable).not.toHaveBeenCalled();
  });

  /** A refused change draws the store's columns again — not the box the reader pressed — says
   *  why, and asks the store what it holds now. */
  it("puts the boxes back, says why and re-reads when a change is refused", async () => {
    integrationsStatus.mockResolvedValue(ON);
    integrationsSetFields.mockRejectedValue("Integrations are off. Switch them on first.");
    setup();
    await theSwitch();

    await userEvent.click(box("Language"));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Integrations are off. Switch them on first.",
    );
    expect(box("Language")).not.toBeChecked();
    expect(box("Condition")).toBeChecked();
    expect(box("Market value")).toBeChecked();
    // Once on mount, once after the refusal.
    await waitFor(() => expect(integrationsStatus).toHaveBeenCalledTimes(2));
  });

  it("asks before switching off, and only the confirmation switches off", async () => {
    integrationsStatus.mockResolvedValue(ON);
    integrationsDisable.mockResolvedValue(status({ checkedAt: NOW }));
    setup();
    const toggle = await theSwitch();

    await userEvent.click(toggle);
    const dialog = theQuestion();
    // The question says what the press costs: the server's copy, for every device in the group —
    // and promises nothing about integrations answering, since none reads the copy yet.
    expect(dialog).toHaveTextContent(
      /deletes the copy our servers hold for every device in your sync group\./,
    );
    expect(dialog).not.toHaveTextContent(/stop answering/);
    expect(integrationsDisable).not.toHaveBeenCalled();

    await userEvent.click(within(dialog).getByRole("button", { name: "Delete the copy" }));

    expect(integrationsDisable).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "false"));
    // The choice that was on survives as the draft, so switching back on offers it again.
    expect(box("Condition")).toBeChecked();
    expect(box("Market value")).toBeChecked();
    expect(box("Language")).not.toBeChecked();
    // And the caret is back on the switch that asked — not on `<body>`.
    expect(toggle).toHaveFocus();
  });

  it("does nothing when the question is cancelled, and hands the caret back", async () => {
    integrationsStatus.mockResolvedValue(ON);
    setup();
    const toggle = await theSwitch();

    await userEvent.click(toggle);
    await userEvent.click(within(theQuestion()).getByRole("button", { name: "Cancel" }));

    expect(integrationsDisable).not.toHaveBeenCalled();
    expect(toggle).toHaveAttribute("aria-checked", "true");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(toggle).toHaveFocus();
  });

  it("hands the caret back to the switch when the question is escaped", async () => {
    integrationsStatus.mockResolvedValue(ON);
    setup();
    const toggle = await theSwitch();
    toggle.focus();

    await userEvent.keyboard("{Enter}");
    theQuestion();
    await userEvent.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(toggle).toHaveFocus();
    expect(integrationsDisable).not.toHaveBeenCalled();
  });

  it("says why, re-reads and stays on when the switch-off is refused", async () => {
    integrationsStatus.mockResolvedValue(ON);
    integrationsDisable.mockRejectedValue("The integrations service did not accept this device.");
    setup();
    const toggle = await theSwitch();

    await userEvent.click(toggle);
    await userEvent.click(within(theQuestion()).getByRole("button", { name: "Delete the copy" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The integrations service did not accept this device.",
    );
    expect(toggle).toHaveAttribute("aria-checked", "true");
    await waitFor(() => expect(integrationsStatus).toHaveBeenCalledTimes(2));
  });

  /**
   * **A read asked before a press must not land after it** — on any of the three presses. The
   * window regains focus, TanStack asks for the status, and the reader presses while that read is
   * out; the read then answers with the store as it was. Unless the press called it off, it writes
   * the old switch, or the old columns, back over the press's own answer.
   */
  it.each([
    {
      what: "a switch-on",
      before: status(),
      answer: status({ ...ON, pending: true }),
      press: async (toggle: HTMLElement) => {
        await userEvent.click(toggle);
      },
      landed: (toggle: HTMLElement) => expect(toggle).toHaveAttribute("aria-checked", "true"),
    },
    {
      what: "a change of columns",
      before: ON,
      answer: status({ ...ON, fields: { ...ON.fields, lang: true }, pending: true }),
      press: async () => {
        await userEvent.click(box("Language"));
      },
      landed: () => expect(box("Language")).toBeChecked(),
    },
    {
      what: "a switch-off",
      before: ON,
      answer: status({ checkedAt: NOW }),
      press: async (toggle: HTMLElement) => {
        await userEvent.click(toggle);
        await userEvent.click(
          within(theQuestion()).getByRole("button", { name: "Delete the copy" }),
        );
      },
      landed: (toggle: HTMLElement) => expect(toggle).toHaveAttribute("aria-checked", "false"),
    },
  ])(
    "keeps the answer to $what when a read from before it lands after it",
    async ({ before, answer, press, landed }) => {
      integrationsStatus.mockResolvedValue(before);
      integrationsEnable.mockResolvedValue(answer);
      integrationsSetFields.mockResolvedValue(answer);
      integrationsDisable.mockResolvedValue(answer);
      setup();
      const toggle = await theSwitch();
      const late = deferred<IntegrationsStatus>();
      integrationsStatus.mockImplementationOnce(() => late.promise);
      act(() => {
        focusManager.setFocused(false);
        focusManager.setFocused(true);
      });
      await waitFor(() => expect(integrationsStatus).toHaveBeenCalledTimes(2));

      await press(toggle);
      await waitFor(() => landed(toggle));

      await act(async () => {
        late.resolve(before);
        await late.promise;
      });
      // Past TanStack's notification tick, so a write the late read made would be on screen.
      await act(() => new Promise((done) => setTimeout(done, 20)));
      landed(toggle);
    },
  );

  describe("a switch that cannot be pressed", () => {
    /**
     * **`aria-disabled`, never `disabled`**: the controls stay in the tab order with the sentence
     * that says why, so every press is refused by the handler — by mouse and by key alike.
     */
    it.each([
      ["in a build with no store address", status({ available: false, entitled: false })],
      ["without a membership", status({ entitled: false })],
      ["while on, without a membership", status({ ...ON, entitled: false })],
    ])("refuses every press %s", async (_label, gated) => {
      integrationsStatus.mockResolvedValue(gated);
      setup();
      const toggle = await theSwitch();
      expect(toggle).toHaveAttribute("aria-disabled", "true");
      expect(toggle).toBeEnabled();

      toggle.focus();
      await userEvent.keyboard("{Enter}");
      await userEvent.keyboard(" ");
      await userEvent.click(toggle);
      const condition = box("Condition") as HTMLInputElement;
      expect(condition).toHaveAttribute("aria-disabled", "true");
      const before = condition.checked;
      condition.focus();
      await userEvent.keyboard(" ");
      await userEvent.click(box("Entry tags"));

      expect(screen.queryByRole("dialog")).toBeNull();
      expect(integrationsEnable).not.toHaveBeenCalled();
      expect(integrationsSetFields).not.toHaveBeenCalled();
      expect(integrationsDisable).not.toHaveBeenCalled();
      expect(condition.checked).toBe(before);
      expect(box("Entry tags")).not.toBeChecked();
      expect(toggle).toHaveAttribute("aria-checked", gated.enabled ? "true" : "false");
    });

    it("says why in a build with no store address, before the membership", async () => {
      integrationsStatus.mockResolvedValue(status({ available: false, entitled: false }));
      setup();

      const toggle = await theSwitch();
      // The build's reason outranks the reader's: no membership reaches a service with no address.
      expect(screen.getByText(NOT_AVAILABLE)).toBeInTheDocument();
      expect(screen.queryByText(NOT_ENTITLED)).toBeNull();
      expect(toggle).toHaveAccessibleDescription(NOT_AVAILABLE);
    });

    it("says why without a membership", async () => {
      integrationsStatus.mockResolvedValue(status({ entitled: false }));
      setup();

      const toggle = await theSwitch();
      expect(screen.getByText(NOT_ENTITLED)).toBeInTheDocument();
      // Off, there is nothing on the server to be stranded.
      expect(screen.queryByText(STRANDED)).toBeNull();
      expect(toggle).toHaveAccessibleDescription(NOT_ENTITLED);
    });

    /** On, but no longer entitled: deleting the store takes a token too, so the copy stays — and
     *  the panel says until when, rather than drawing an On nobody can turn off. */
    it("says where the copy stays when it is on and the membership has gone", async () => {
      integrationsStatus.mockResolvedValue(status({ ...ON, entitled: false }));
      setup();

      const toggle = await theSwitch();
      expect(toggle).toHaveAttribute("aria-checked", "true");
      expect(screen.getByText(STRANDED)).toBeInTheDocument();
      expect(toggle).toHaveAccessibleDescription(`${NOT_ENTITLED} ${STRANDED}`);
    });
  });

  it("shows the last round's failure", async () => {
    integrationsStatus.mockResolvedValue(
      status({ ...ON, error: "Couldn't send your collection: timed out after 10s." }),
    );
    setup();
    await theSwitch();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Couldn't send your collection: timed out after 10s.",
    );
  });

  it("shows a refused press in the backend's words, and re-reads the status", async () => {
    integrationsEnable.mockRejectedValue("The integrations service isn't available yet.");
    setup();
    await userEvent.click(await theSwitch());

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The integrations service isn't available yet.",
    );
    // Once on mount, once after the refusal.
    await waitFor(() => expect(integrationsStatus).toHaveBeenCalledTimes(2));
  });

  it("says when this device last sent the copy, and when the service was asked", async () => {
    integrationsStatus.mockResolvedValue(ON);
    setup();
    await theSwitch();

    expect(screen.getByText("Last sent from this device: 2 hours ago.")).toBeInTheDocument();
    expect(screen.getByText("Checked with the service 1 minute ago.")).toBeInTheDocument();
  });

  /**
   * While a press is out every control refuses another — **and keeps the caret**: a switch that
   * took `disabled` under the reader's press would drop it to `<body>` in Chromium.
   */
  it("holds every control still while a press is out, and keeps the caret where it was", async () => {
    // Never settles: the press is in flight for the rest of the test.
    integrationsEnable.mockReturnValue(new Promise(() => {}));
    setup();
    const toggle = await theSwitch();
    toggle.focus();

    await userEvent.keyboard("{Enter}");

    await waitFor(() => expect(toggle).toHaveAttribute("aria-disabled", "true"));
    expect(toggle).toHaveAttribute("aria-busy", "true");
    expect(toggle).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    await userEvent.click(box("Condition"));
    expect(integrationsEnable).toHaveBeenCalledTimes(1);
    expect(box("Condition")).toHaveAttribute("aria-disabled", "true");
    expect(box("Condition")).not.toBeChecked();
  });

  it("sends one switch-on for a double press", async () => {
    integrationsEnable.mockReturnValue(new Promise(() => {}));
    setup();

    await userEvent.dblClick(await theSwitch());

    expect(integrationsEnable).toHaveBeenCalledTimes(1);
  });
});

describe("the two time lines", () => {
  const nowMs = NOW * 1000;

  it("says nothing has been sent rather than a time for never", () => {
    expect(sentLine(null, nowMs)).toBe("Nothing sent from this device yet.");
    expect(sentLine(NOW - 30, nowMs)).toBe("Last sent from this device: just now.");
    expect(sentLine(NOW - 3 * 86_400, nowMs)).toBe("Last sent from this device: 3 days ago.");
  });

  it("draws no checked line for a store never asked", () => {
    expect(checkedLine(null, nowMs)).toBeNull();
    expect(checkedLine(NOW - 120, nowMs)).toBe("Checked with the service 2 minutes ago.");
  });
});
