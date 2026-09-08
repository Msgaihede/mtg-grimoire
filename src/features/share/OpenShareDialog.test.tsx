/**
 * Paste is the only way in.
 *
 * The app reads no launch intent and declares no URL scheme — `relay/src/pair.ts` carries the
 * argument for why adding one is a separate piece of work with an Android trap in it — so a
 * reader who was sent a link in a chat window arrives here with it on the clipboard.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

const shareOpen = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: { shareOpen },
}));

import golden from "../../../src-tauri/src/share/__golden__/snapshot.json?raw";
import publishRs from "../../../src-tauri/src/share/publish.rs?raw";
import { useAppStore } from "@/lib/store";
import { NOT_A_SHARE_LINK, OpenShareDialog, shareLinkFrom } from "./OpenShareDialog";

const LINK = "https://share.example/s/testshareid00000";

function mount(onOpened = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onClose = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <OpenShareDialog open onClose={onClose} onOpened={onOpened} />
    </QueryClientProvider>,
  );
  return { onClose, onOpened };
}

const field = () => screen.getByLabelText("Link to a shared collection");
const openButton = () => screen.getByRole("button", { name: "Open collection" });

beforeEach(() => {
  vi.clearAllMocks();
  shareOpen.mockResolvedValue(JSON.parse(golden));
  useAppStore.setState({ openedShares: [] });
});

describe("the link a reader pastes", () => {
  /**
   * The shape check, as a function, because every case below is one line of it and driving each
   * through the dialog would be five renders of the same refusal.
   */
  it("recognises a share link and nothing else", () => {
    expect(shareLinkFrom(LINK)).toBe(LINK);
    // Trimmed, and stripped of the angle brackets a chat window puts round a bare URL.
    expect(shareLinkFrom(`  <${LINK}>  `)).toBe(LINK);
    // The host is canonicalised so one link is one cache entry however it was typed.
    expect(shareLinkFrom("https://SHARE.example/s/testshareid00000")).toBe(LINK);

    expect(shareLinkFrom("")).toBeNull();
    expect(shareLinkFrom("testshareid00000")).toBeNull();
    expect(shareLinkFrom("share.example/s/abc")).toBeNull();
    // The app's own pairing links are not share links, and this is the paste most likely to be
    // made by mistake — both come off the same relay and both are handed over in a chat window.
    expect(shareLinkFrom("https://share.example/pair/abc")).toBeNull();
    // A scheme with no host behind it: `javascript:` and `file:` reach the same refusal.
    expect(shareLinkFrom("javascript:alert(1)")).toBeNull();
  });

  it("refuses a pasted link that is not a share URL, by sentence", async () => {
    mount();
    await userEvent.type(field(), "have you seen my binder");
    await userEvent.click(openButton());

    expect(await screen.findByText(NOT_A_SHARE_LINK)).toBeInTheDocument();
    // Nothing was fetched and nothing was remembered: a refusal is not a half-open.
    expect(shareOpen).not.toHaveBeenCalled();
    expect(useAppStore.getState().openedShares).toEqual([]);
  });

  it("opens a good link, remembers it and hands it to its caller", async () => {
    const { onClose, onOpened } = mount();
    await userEvent.type(field(), LINK);
    await userEvent.click(openButton());

    await waitFor(() => expect(onOpened).toHaveBeenCalledWith(LINK));
    expect(shareOpen).toHaveBeenCalledWith(LINK);
    expect(useAppStore.getState().openedShares).toEqual([LINK]);
    expect(onClose).toHaveBeenCalled();
  });

  /**
   * The refusals the crate returns are sentences a reader can act on — *withdrawn*, *no longer
   * available*, *has not finished publishing yet* — and they belong **here**, beside the box the
   * link was typed into, rather than on a page the reader would first have to be navigated to.
   * A link that never answered is also not a binder they have opened, so it is not remembered.
   */
  it("says why a link did not open, and does not remember it", async () => {
    shareOpen.mockRejectedValue("That shared collection is no longer available.");
    const { onClose, onOpened } = mount();
    await userEvent.type(field(), LINK);
    await userEvent.click(openButton());

    expect(
      await screen.findByText("That shared collection is no longer available."),
    ).toBeInTheDocument();
    expect(onOpened).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(useAppStore.getState().openedShares).toEqual([]);
  });

  /** An empty box has nothing to open, and the control says so without leaving the tab order. */
  it("greys the press until something has been typed", async () => {
    mount();
    expect(openButton()).toHaveAttribute("aria-disabled", "true");
    expect(openButton()).not.toBeDisabled();

    await userEvent.type(field(), "x");
    expect(openButton()).not.toHaveAttribute("aria-disabled", "true");
  });

  /**
   * The sentence goes away as soon as the reader edits, or it stands over a link they have
   * already fixed — which reads as a refusal the app will not take back.
   */
  it("clears the refusal when the reader types again", async () => {
    mount();
    await userEvent.type(field(), "not a link");
    await userEvent.click(openButton());
    expect(await screen.findByText(NOT_A_SHARE_LINK)).toBeInTheDocument();

    await userEvent.type(field(), "x");
    expect(screen.queryByText(NOT_A_SHARE_LINK)).not.toBeInTheDocument();
  });

  /**
   * **The one user-visible sentence this feature spells twice, fenced.**
   *
   * The same paste can be refused on either side of the boundary — this dialog checks the shape
   * before any round trip, `share::publish::open` checks the scheme again for callers that are
   * not this dialog — and a reader who typed one wrong thing must not be told two different
   * things depending on which half noticed. Everything else here is fenced by something: three
   * implementations of the format meet at a committed golden, and `share::publish` `include_str!`s
   * the Worker's own config to hold `SHARE_BASE` to it. This literal had nothing, in a feature
   * whose stated shape is *one format, N implementations, fenced*.
   *
   * `ipc.test.ts`'s trick, over one constant: read the crate as text and compare.
   */
  it("says exactly what the crate says, word for word", () => {
    const declared = /pub const NOT_A_LINK: &str = "([^"]*)";/.exec(publishRs);
    expect(declared, "share::publish::NOT_A_LINK is no longer a plain string literal").not.toBeNull();
    expect(declared?.[1]).toBe(NOT_A_SHARE_LINK);
  });
});
