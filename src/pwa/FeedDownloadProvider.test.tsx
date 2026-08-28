import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FeedDownloadProvider, useFeedDownload } from "@/pwa/FeedDownloadProvider";
import { clearFeedSizeCache, type FeedId } from "@/pwa/feedSize";
import { isWebTarget } from "@/pwa/target";
import type { NetworkInformation } from "@/pwa/connection";

vi.mock("@/pwa/target", () => ({ isWebTarget: vi.fn(() => true) }));

beforeEach(() => {
  clearFeedSizeCache();
  vi.mocked(isWebTarget).mockReturnValue(true);
});
afterEach(() => vi.clearAllMocks());

/** A bulk descriptor answering one size. */
const descriptor = (bytes: number) =>
  vi.fn(() =>
    Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ compressed_size: bytes }),
    } as unknown as Response),
  );

function Refresh({ feed, run }: { feed: FeedId; run: () => void }) {
  const askFirst = useFeedDownload();
  return (
    <button type="button" onClick={() => askFirst(feed, run)}>
      Refresh
    </button>
  );
}

function show({
  run,
  bytes = 77_972_714,
  connection,
  feed = "corpus" as FeedId,
}: {
  run: () => void;
  bytes?: number;
  connection?: NetworkInformation;
  feed?: FeedId;
}) {
  return render(
    <FeedDownloadProvider fetchFn={descriptor(bytes)} connection={() => connection}>
      <Refresh feed={feed} run={run} />
    </FeedDownloadProvider>,
  );
}

describe("on desktop", () => {
  it("runs the download immediately, in the same tick, with no dialog", async () => {
    vi.mocked(isWebTarget).mockReturnValue(false);
    const run = vi.fn();
    show({ run });
    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
    // Synchronous: three existing suites drive Refresh and assert in the same tick, and a
    // deferred pass-through would make every desktop Refresh a frame slower.
    expect(run).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

describe("on the web target", () => {
  it("does not ask about a feed under 5 MB", async () => {
    const run = vi.fn();
    show({ run, bytes: 4_000_000 });
    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("asks about a large one, and says what it costs", async () => {
    const run = vi.fn();
    show({ run });
    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent(/the card database/);
    expect(dialog).toHaveTextContent(/78\.0 MB/);
    expect(run).not.toHaveBeenCalled();
  });

  it("runs it on Download", async () => {
    const run = vi.fn();
    show({ run });
    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await userEvent.click(await screen.findByRole("button", { name: "Download" }));
    expect(run).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  /** The refusal is the whole point: nothing is queued and nothing is retried behind the back. */
  it("runs nothing at all on Not now", async () => {
    const run = vi.fn();
    show({ run });
    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await userEvent.click(await screen.findByRole("button", { name: "Not now" }));
    expect(run).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("says the link is metered and opens on Not now", async () => {
    const run = vi.fn();
    show({ run, connection: { saveData: true } });
    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent(/Data Saver is on/);
    await waitFor(() => expect(screen.getByRole("button", { name: "Not now" })).toHaveFocus());
  });

  it("opens on Download when nothing says the link costs anything", async () => {
    const run = vi.fn();
    show({ run, connection: { type: "wifi", effectiveType: "4g" } });
    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await screen.findByRole("dialog");
    await waitFor(() => expect(screen.getByRole("button", { name: "Download" })).toHaveFocus());
  });

  /**
   * Card Kingdom's feed cannot be sized — its HEAD answers `text/html` with no `Content-Length`
   * and the feed is paginated — so the dialog says so rather than reprinting a figure measured
   * once in August. An unknown size always asks.
   */
  it("asks about a feed it cannot size, and says it cannot", async () => {
    const run = vi.fn();
    show({ run, feed: "card-kingdom" });
    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent(/size is not published/);
    expect(run).not.toHaveBeenCalled();
  });
});
