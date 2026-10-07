import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ScannerAssetsOwed, ScannerAssetsProgress, ScannerStatus } from "@/lib/ipc";
import { STATUS } from "./fixtures";

const scannerAssets = vi.fn<() => Promise<ScannerAssetsOwed>>();
const scannerAssetsFetch = vi.fn<() => Promise<ScannerAssetsOwed>>();
let heard: ((e: ScannerAssetsProgress) => void) | null = null;

vi.mock("@/lib/ipc", async (original) => ({
  ...(await original<typeof import("@/lib/ipc")>()),
  ipc: {
    scannerAssets: () => scannerAssets(),
    scannerAssetsFetch: () => scannerAssetsFetch(),
    onScannerAssets: (cb: (e: ScannerAssetsProgress) => void) => {
      heard = cb;
      return () => {
        if (heard === cb) heard = null;
      };
    },
  },
}));

import { megabytes, offerSentence, ScannerAssets } from "./ScannerAssets";

const BUNDLE = { key: "bundle", label: "Card hashes", bytes: 5_874_752 };
const DETECTION = { key: "detectionModel", label: "Text detection model", bytes: 2_510_284 };
const RECOGNITION = { key: "recognitionModel", label: "Text recognition model", bytes: 9_716_568 };
const ALL: ScannerAssetsOwed = {
  owed: [BUNDLE, DETECTION, RECOGNITION],
  bytes: 18_101_604,
  fetching: false,
};
const NOTHING: ScannerAssetsOwed = { owed: [], bytes: 0, fetching: false };
const REFUSED = "There is no command named scanner_assets on this host.";
const NOT_PUBLISHED = "card-hashes.bin is not published for this version of the app (HTTP 404).";

function mount(status: ScannerStatus | null, onLoaded = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = (now: ScannerStatus | null) => (
    <QueryClientProvider client={qc}>
      <ScannerAssets status={now} onLoaded={onLoaded} />
    </QueryClientProvider>
  );
  const view = render(tree(status));
  /** The page handing down a status it has read again. */
  const withStatus = (now: ScannerStatus | null) => view.rerender(tree(now));
  return { ...view, onLoaded, withStatus };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  heard = null;
  scannerAssets.mockReset().mockResolvedValue(ALL);
  scannerAssetsFetch.mockReset().mockResolvedValue(NOTHING);
});

describe("ScannerAssets", () => {
  it("rounds a size up to whole megabytes, as the launch downloads' sizes are", () => {
    expect(megabytes(18_101_604)).toBe("19 MB");
    expect(megabytes(5_874_752)).toBe("6 MB");
    expect(megabytes(2_510_284)).toBe("3 MB");
    expect(megabytes(9_716_568)).toBe("10 MB");
    expect(megabytes(1)).toBe("1 MB");
  });

  /**
   * **A desktop release build**: the binary carries the files, the host owes nothing, the
   * status has nothing to say — and nothing at all is drawn, no box and no button.
   */
  it("draws nothing where the files are embedded and nothing is owed", async () => {
    scannerAssets.mockResolvedValue(NOTHING);
    const { container } = mount(STATUS.embedded);
    await waitFor(() => expect(scannerAssets).toHaveBeenCalled());
    await act(async () => {});
    expect(container).toBeEmptyDOMElement();
    expect(scannerAssetsFetch).not.toHaveBeenCalled();
  });

  /**
   * **A host that refuses the command is a host with nothing to offer**, and what it is left
   * with is what it had before there was an offer: the status's own sentences, the path and the
   * restart among them — a developer's build with a file to place by hand.
   */
  it("draws the status's own sentences where the host refuses, and no offer", async () => {
    scannerAssets.mockRejectedValue(REFUSED);
    mount(STATUS.missing);
    expect(await screen.findByText(/^No reference bundle\. Put/)).toBeInTheDocument();
    expect(screen.getByText(/^No OCR models\. Put/)).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Scanner files" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  /**
   * **The offer, in words with the measured size** — and in place of the instruction to put a
   * file at a path and restart, which a reader with a button does not need and a phone's reader
   * cannot follow.
   */
  it("offers the download with its size where files are owed, in place of the path", async () => {
    mount(STATUS.missing);
    const offer = await screen.findByRole("region", { name: "Scanner files" });
    expect(
      within(offer).getByText("The scanner needs its card data — about 19 MB."),
    ).toBeInTheDocument();
    const rows = within(offer).getAllByRole("listitem");
    expect(rows.map((row) => row.textContent)).toEqual([
      "Card hashes, about 6 MB",
      "Text detection model, about 3 MB",
      "Text recognition model, about 10 MB",
    ]);
    expect(within(offer).getByRole("button", { name: "Download" })).toBeInTheDocument();
    expect(screen.queryByText(/Put .card-hashes\.bin./)).not.toBeInTheDocument();
    expect(screen.queryByText(/No OCR models/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Restart the app/)).not.toBeInTheDocument();
    // Asking is all that has happened.
    expect(scannerAssetsFetch).not.toHaveBeenCalled();
  });

  /**
   * **An offer replaces only the sentences for the files it offers.** The bundle is owed and
   * the models are not — a file somebody placed that will not load — so the models' own
   * sentence still says why, beside the offer for the bundle.
   */
  it("keeps the sentence for a file the host did not offer", async () => {
    scannerAssets.mockResolvedValue({ owed: [BUNDLE], bytes: BUNDLE.bytes, fetching: false });
    mount(STATUS.corrupt);
    const offer = await screen.findByRole("region", { name: "Scanner files" });
    expect(
      within(offer).getByText("The scanner needs its card data — about 6 MB."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/card-hashes\.bin. at .* did not load/)).not.toBeInTheDocument();
    expect(screen.getByText(/text-detection\.rten. at .* did not load/)).toBeInTheDocument();
  });

  /** Card names that did not load are `corpus.db`'s, not a file to fetch: said either way. */
  it("still says card names did not load beside a bundle that did", async () => {
    scannerAssets.mockResolvedValue(NOTHING);
    mount(STATUS.unlabelled);
    expect(await screen.findByText(/^Bundle loaded, but card names didn't/)).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Scanner files" })).not.toBeInTheDocument();
  });

  /**
   * **The press**: the button gives way to the bar, the bar follows the event, and when the
   * fetch ends the box goes and the page is told — once.
   */
  it("downloads on the press, shows how far it has got, and tells the page when it lands", async () => {
    const user = userEvent.setup();
    const going = deferred<ScannerAssetsOwed>();
    scannerAssetsFetch.mockReturnValue(going.promise);
    const { onLoaded, withStatus, container } = mount(STATUS.missing);
    await user.click(await screen.findByRole("button", { name: "Download" }));

    const bar = await screen.findByRole("progressbar", {
      name: "Downloading the scanner's files",
    });
    expect(scannerAssetsFetch).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    // Before the first word there is no fraction to claim.
    expect(bar).not.toHaveAttribute("aria-valuenow");
    expect(screen.getByRole("status")).toHaveTextContent("Starting the download…");

    act(() =>
      heard?.({
        phase: "downloading",
        file: "bundle",
        done: 5_874_752,
        total: 18_101_604,
        message: null,
      }),
    );
    expect(bar).toHaveAttribute("aria-valuenow", "32");
    expect(screen.getByRole("status")).toHaveTextContent("Downloading — 5 of 19 MB");
    // The last byte in: the count is the total the offer named, not a megabyte short of it.
    act(() =>
      heard?.({
        phase: "downloading",
        file: "recognitionModel",
        done: 18_101_604,
        total: 18_101_604,
        message: null,
      }),
    );
    expect(screen.getByRole("status")).toHaveTextContent("Downloading — 19 of 19 MB");
    act(() =>
      heard?.({
        phase: "checking",
        file: "recognitionModel",
        done: 18_101_604,
        total: 18_101_604,
        message: null,
      }),
    );
    expect(screen.getByRole("status")).toHaveTextContent("Checking what arrived…");
    // Nothing about a missing file is drawn from a status that predates the download.
    expect(screen.queryByText(/No reference bundle/)).not.toBeInTheDocument();
    expect(onLoaded).not.toHaveBeenCalled();

    await act(async () => going.resolve(NOTHING));
    await waitFor(() => expect(onLoaded).toHaveBeenCalledTimes(1));
    // The page re-reads the status and hands the new one down; with it there is nothing left
    // to say, and the box is gone.
    withStatus(STATUS.present);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
    expect(onLoaded).toHaveBeenCalledTimes(1);
  });

  /**
   * **A failure is the engine's sentence and a Retry** — which is a press like the first, for
   * whatever the host says is still owed.
   */
  it("shows why a download failed and retries on the reader's press", async () => {
    const user = userEvent.setup();
    scannerAssetsFetch.mockRejectedValueOnce(NOT_PUBLISHED);
    mount(STATUS.missing);
    await user.click(await screen.findByRole("button", { name: "Download" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(NOT_PUBLISHED);
    const retry = await screen.findByRole("button", { name: "Retry" });
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(scannerAssetsFetch).toHaveBeenCalledTimes(1);

    const again = deferred<ScannerAssetsOwed>();
    scannerAssetsFetch.mockReturnValue(again.promise);
    await user.click(retry);
    expect(await screen.findByRole("progressbar")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(scannerAssetsFetch).toHaveBeenCalledTimes(2);
    await act(async () => again.resolve(NOTHING));
  });

  /** The button is a finger's size under a coarse pointer, and only there. */
  it("gives the button the touch floor", async () => {
    mount(STATUS.missing);
    const button = await screen.findByRole("button", { name: "Download" });
    expect(button.classList.contains("coarse:min-h-[var(--target-min)]")).toBe(true);
  });
});

describe("an offer for data the scanner is already running on", () => {
  // A release that rebuilt the bundle owes it again while the old copy still loads and scans.
  it("reads as an update that can wait, not as a need", async () => {
    scannerAssets.mockResolvedValue({ owed: [BUNDLE], bytes: BUNDLE.bytes, fetching: false });
    mount(STATUS.present);
    const offer = await screen.findByRole("region", { name: "Scanner files" });
    expect(within(offer).getByText("Newer card data is available — about 6 MB.")).toBeInTheDocument();
    expect(within(offer).queryByText(/needs/)).not.toBeInTheDocument();
    expect(within(offer).getByRole("button", { name: "Download" })).toBeInTheDocument();
  });

  it("still reads as a need when anything owed is not loaded", () => {
    expect(offerSentence(STATUS.missing, [BUNDLE], BUNDLE.bytes)).toBe(
      "The scanner needs its card data — about 6 MB.",
    );
    // The bundle loaded and a model that did not: the scanner lacks something.
    expect(offerSentence(STATUS.noModels, [BUNDLE, RECOGNITION], 15_591_320)).toBe(
      "The scanner needs its card data — about 16 MB.",
    );
    // Before the status has answered, nothing is known to be loaded.
    expect(offerSentence(null, [BUNDLE], BUNDLE.bytes)).toMatch(/^The scanner needs/);
    expect(offerSentence(STATUS.present, [BUNDLE, DETECTION], 8_385_036)).toBe(
      "Newer card data is available — about 9 MB.",
    );
  });
});
