import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { UpdateAsset, UpdateStatus } from "@/lib/ipc";
import type { Update, UpdateAction } from "@/lib/useUpdate";
import { UpdatePanel } from "./UpdatePanel";

const asset: UpdateAsset = {
  name: "mtg-grimoire-0.3.0-windows-x64-portable.zip",
  url: "https://example.invalid/p.zip",
  size: 6_453_913,
  digest: "sha256:abc",
};

const status = (over: Partial<UpdateStatus> = {}): UpdateStatus => ({
  currentVersion: "0.2.0",
  installKind: "portable",
  available: {
    version: "0.3.0",
    tag: "v0.3.0",
    notes: "### Features\n* sortable table headers",
    publishedAt: "2026-08-09T04:02:20Z",
    htmlUrl: "https://github.com/Msgaihede/mtg-grimoire/releases/tag/v0.3.0",
    assets: [asset],
  },
  asset,
  lastCheckAt: String(Math.round(Date.now() / 1000)),
  busy: false,
  staged: false,
  ...over,
});

const update = (over: Partial<Update> = {}): Update => ({
  status: status(),
  progress: null,
  busy: false,
  action: "download",
  error: null,
  check: vi.fn(),
  download: vi.fn(),
  install: vi.fn(),
  openReleasePage: vi.fn(),
  ...over,
});

const primary = (name: RegExp) => screen.getByRole("button", { name });

describe("UpdatePanel", () => {
  /**
   * The button label *is* the state machine, and the whole point of the two-step flow the
   * design settled on: downloading never restarts anything, and the restart is a separate,
   * deliberate press.
   */
  it("offers a sized download, and only then a restart", () => {
    const { rerender } = render(<UpdatePanel update={update()} />);
    expect(primary(/^Download 6\.5 MB$/)).toBeEnabled();
    expect(screen.queryByRole("button", { name: /restart/i })).not.toBeInTheDocument();

    rerender(
      <UpdatePanel
        update={update({ status: status({ staged: true }), action: "install" })}
      />,
    );
    expect(primary(/^Restart to finish$/)).toBeEnabled();
    expect(screen.queryByRole("button", { name: /^Download/ })).not.toBeInTheDocument();
    // What a restart costs, said before it is pressed rather than after.
    expect(screen.getByText(/close and reopen/i)).toBeInTheDocument();
  });

  it("runs the download and the install through the hook", async () => {
    const download = vi.fn();
    const install = vi.fn();
    const { rerender } = render(<UpdatePanel update={update({ download })} />);
    await userEvent.click(primary(/^Download/));
    expect(download).toHaveBeenCalledOnce();

    rerender(
      <UpdatePanel
        update={update({ status: status({ staged: true }), action: "install", install })}
      />,
    );
    await userEvent.click(primary(/^Restart to finish$/));
    expect(install).toHaveBeenCalledOnce();
  });

  /**
   * An MSI install or a Linux build. The news is still delivered — a reader should know a
   * new version exists — but nothing here promises to install it, and the sentence says why
   * and what happens to their collection.
   */
  it("sends an install it cannot update to the release page, and says why", async () => {
    const openReleasePage = vi.fn();
    render(
      <UpdatePanel
        update={update({
          status: status({ asset: null, installKind: "other" }),
          action: "unavailable",
          openReleasePage,
        })}
      />,
    );

    expect(screen.getByText(/is available/)).toHaveTextContent("0.3.0 is available");
    expect(screen.queryByRole("button", { name: /^Download/ })).not.toBeInTheDocument();
    expect(screen.getByText(/can.t update on its own/i)).toBeInTheDocument();
    expect(screen.getByText(/collection stays where it is/i)).toBeInTheDocument();

    await userEvent.click(primary(/^Open the release page$/));
    expect(openReleasePage).toHaveBeenCalledOnce();
  });

  /**
   * "Up to date" is a claim, and before the first check has answered the app has not earned
   * it. `lastCheckAt` is the only thing that tells "nothing newer" from "haven't looked".
   */
  it("does not claim to be up to date before the first check has answered", () => {
    const { rerender } = render(
      <UpdatePanel
        update={update({
          status: status({ available: null, asset: null, lastCheckAt: null }),
          action: "none",
        })}
      />,
    );
    expect(screen.getByText(/Checking for updates/i)).toBeInTheDocument();
    expect(screen.queryByText(/latest version/i)).not.toBeInTheDocument();
    expect(screen.getByText("Not checked yet")).toBeInTheDocument();

    rerender(
      <UpdatePanel
        update={update({ status: status({ available: null, asset: null }), action: "none" })}
      />,
    );
    expect(screen.getByText(/latest version/i)).toBeInTheDocument();
  });

  it("shows the download bar with a real percentage while bytes are arriving", () => {
    render(
      <UpdatePanel update={update({ busy: true, progress: { done: 3_226_956, total: 6_453_913 } })} />,
    );
    const bar = screen.getByRole("progressbar", { name: /downloading/i });
    expect(bar).toHaveAttribute("aria-valuenow", "50");
    expect(screen.getByText("3.2 MB of 6.5 MB")).toBeInTheDocument();
    expect(primary(/Downloading/)).toBeDisabled();
  });

  /** A total of zero has no percentage, and `aria-valuenow="0"` would claim there was one. */
  it("omits the value rather than claiming zero when the size is unknown", () => {
    render(<UpdatePanel update={update({ progress: { done: 0, total: 0 } })} />);
    expect(screen.getByRole("progressbar")).not.toHaveAttribute("aria-valuenow");
  });

  it("puts a failed download in an alert and leaves the button usable", async () => {
    const download = vi.fn();
    render(
      <UpdatePanel
        update={update({ error: "the download did not match its published checksum.", download })}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(/published checksum/);
    await userEvent.click(primary(/^Download/));
    expect(download).toHaveBeenCalledOnce();
  });

  it("re-checks on demand and reports the current version", async () => {
    const check = vi.fn();
    render(<UpdatePanel update={update({ check })} />);
    expect(screen.getByText("0.2.0")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /check now/i }));
    expect(check).toHaveBeenCalledOnce();
  });

  /** Release notes are the release's own text — shown as written, never interpreted. */
  it("shows the release notes verbatim rather than rendering them", () => {
    render(<UpdatePanel update={update()} />);
    expect(screen.getByText(/### Features/)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Features" })).not.toBeInTheDocument();
  });

  it.each<[UpdateAction, RegExp]>([
    ["download", /^Download/],
    ["install", /^Restart to finish$/],
    ["unavailable", /^Open the release page$/],
  ])("shows exactly one primary control for %s", (action, name) => {
    render(
      <UpdatePanel
        update={update({
          status: status({ staged: action === "install", asset: action === "unavailable" ? null : asset }),
          action,
        })}
      />,
    );
    expect(screen.getAllByRole("button", { name })).toHaveLength(1);
  });
});
