import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { WebStoragePanel, type WebStorageView } from "@/features/settings/WebStoragePanel";
import { DEFAULT_CAP_BYTES, MAX_CAP_BYTES } from "@/pwa/imageLedger";

function view(over: Partial<WebStorageView> = {}): WebStorageView {
  return {
    install: "unavailable",
    onInstall: vi.fn(),
    persistence: null,
    persisted: null,
    estimate: null,
    imageCap: DEFAULT_CAP_BYTES,
    imageBytes: null,
    onImageCap: vi.fn(),
    ...over,
  };
}

describe("the install row", () => {
  it("says so, honestly, when the browser has offered nothing", () => {
    render(<WebStoragePanel storage={view()} />);
    expect(screen.getByText(/has not offered an install/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Install app/ })).not.toBeInTheDocument();
  });

  it("offers the press when the browser has offered one", async () => {
    const onInstall = vi.fn();
    render(<WebStoragePanel storage={view({ install: "offered", onInstall })} />);
    await userEvent.click(screen.getByRole("button", { name: /Install app/ }));
    expect(onInstall).toHaveBeenCalledTimes(1);
  });

  it("goes quiet once it is installed", () => {
    render(<WebStoragePanel storage={view({ install: "installed" })} />);
    expect(screen.getByText(/^Installed\./)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Install app/ })).not.toBeInTheDocument();
  });
});

describe("the storage row", () => {
  it("says the data is kept when the browser agreed to keep it", () => {
    render(<WebStoragePanel storage={view({ persisted: true })} />);
    expect(screen.getByText(/has agreed to keep/)).toBeInTheDocument();
  });

  it("says it may be cleared when the browser refused", () => {
    render(
      <WebStoragePanel
        storage={view({ persisted: false, persistence: { askedAt: 1, granted: false } })}
      />,
    );
    expect(screen.getByText(/may clear this site's data/)).toBeInTheDocument();
  });

  /**
   * The spike's measurement is the reason: `estimate()` reported 647 MB during a fill and 7 MB
   * immediately after a restart, against a file that was 532.8 MB both times, and reported an
   * identical 10 887.0 MB quota on a desktop and on a phone. It is printed, and nothing is
   * decided by it.
   */
  it("prints the browser's estimate and lets nothing depend on it", () => {
    const { unmount } = render(
      <WebStoragePanel
        storage={view({ install: "offered", estimate: { usage: 7_000_000, quota: 10_887_000_000 } })}
      />,
    );
    expect(screen.getByText(/Browsers report this loosely/)).toBeInTheDocument();
    expect(screen.getByText(/estimates 7\.0 MB in use/)).toBeInTheDocument();
    // Nothing on the panel is disabled or hidden because the estimate is small.
    expect(screen.getByRole("button", { name: /Install app/ })).toBeEnabled();
    expect(
      screen.queryByRole("button", { name: /disabled|not enough space/i }),
    ).not.toBeInTheDocument();
    unmount();

    // And the same panel with a quota a hundred times larger draws exactly the same controls,
    // which is what "gates nothing" means when it is stated as a behaviour rather than a rule.
    render(
      <WebStoragePanel
        storage={view({
          install: "offered",
          estimate: { usage: 900_000_000, quota: 1_000_000_000 },
        })}
      />,
    );
    expect(screen.getByRole("button", { name: /Install app/ })).toBeEnabled();
  });

  it("says the browser reported nothing rather than printing a zero", () => {
    render(<WebStoragePanel storage={view()} />);
    expect(screen.getByText(/has not reported an estimate/)).toBeInTheDocument();
  });
});

/**
 * Spec §5.4: 256 MB by default, reader-adjustable to 1 GB. From the live cache — 519 MB over
 * 7 929 files — that is ~3 900 cards against ~15 000.
 */
describe("the image cache row", () => {
  it("says nothing has been cached rather than printing a zero", () => {
    render(<WebStoragePanel storage={view()} />);
    expect(screen.getByText(/Nothing has been cached yet/)).toBeInTheDocument();
  });

  it("prints what the ledger says is there", () => {
    render(<WebStoragePanel storage={view({ imageBytes: 190_000_000 })} />);
    expect(screen.getByText(/190\.0 MB cached/)).toBeInTheDocument();
  });

  it("opens on the cap in force", () => {
    render(<WebStoragePanel storage={view({ imageCap: MAX_CAP_BYTES })} />);
    expect(
      screen.getByRole("button", { name: /Card pictures kept on this device/ }),
    ).toHaveTextContent("1 GB");
  });

  it("hands the new ceiling back in bytes", async () => {
    const onImageCap = vi.fn();
    render(<WebStoragePanel storage={view({ imageCap: DEFAULT_CAP_BYTES, onImageCap })} />);
    await userEvent.click(
      screen.getByRole("button", { name: /Card pictures kept on this device/ }),
    );
    await userEvent.click(screen.getByRole("option", { name: /1 GB/ }));
    expect(onImageCap).toHaveBeenCalledWith(MAX_CAP_BYTES);
  });
});
