import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ReleaseNote, UpdateAsset, UpdateStatus } from "@/lib/ipc";
import type { ReleaseHistory } from "@/lib/useReleaseHistory";
import type { Update, UpdateAction } from "@/lib/useUpdate";
import { UpdatePanel } from "./UpdatePanel";

const asset: UpdateAsset = {
  name: "mtg-grimoire-0.3.0-windows-x64-portable.zip",
  url: "https://example.invalid/p.zip",
  size: 6_453_913,
  digest: "sha256:abc",
};

/**
 * A release body in release-please's shape, which is the only shape this panel ever gets.
 *
 * The duplicate is not a typo: the same commit message landing on two branches is what the
 * real changelog carries, and collapsing it is one of the three things `ReleaseNotes` does.
 */
const NOTES =
  "## [0.3.0](https://github.com/Msgaihede/mtg-grimoire/compare/v0.2.0...v0.3.0) (2026-08-09)\n\n" +
  "### Features\n\n" +
  "* **search:** sortable table headers ([23d15d5](https://github.com/o/r/commit/23d15d5aa))\n" +
  "* **search:** sortable table headers ([2f2af37](https://github.com/o/r/commit/2f2af37bb))\n" +
  "* **decks:** an undo journal ([b707a73](https://github.com/o/r/commit/b707a73cc))\n";

const status = (over: Partial<UpdateStatus> = {}): UpdateStatus => ({
  currentVersion: "0.2.0",
  installKind: "portable",
  available: {
    version: "0.3.0",
    tag: "v0.3.0",
    notes: NOTES,
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

const note = (version: string, notes = `### Features\n\n* what ${version} brought`): ReleaseNote => ({
  version,
  tag: `v${version}`,
  notes,
  publishedAt: "2026-08-01T00:00:00Z",
  htmlUrl: `https://github.com/Msgaihede/mtg-grimoire/releases/tag/v${version}`,
});

/** The history is empty by default: most tests here are about the update, not the past. */
const history = (over: Partial<ReleaseHistory> = {}): ReleaseHistory => ({
  releases: [],
  loading: false,
  error: null,
  ...over,
});

const panel = (u: Update = update(), h: ReleaseHistory = history()) => (
  <UpdatePanel update={u} history={h} />
);

const primary = (name: RegExp) => screen.getByRole("button", { name });

describe("UpdatePanel", () => {
  /**
   * The button label *is* the state machine, and the whole point of the two-step flow the
   * design settled on: downloading never restarts anything, and the restart is a separate,
   * deliberate press.
   */
  it("offers a sized download, and only then a restart", () => {
    const { rerender } = render(panel());
    expect(primary(/^Download 6\.5 MB$/)).toBeEnabled();
    expect(screen.queryByRole("button", { name: /restart/i })).not.toBeInTheDocument();

    rerender(panel(update({ status: status({ staged: true }), action: "install" })));
    expect(primary(/^Restart to finish$/)).toBeEnabled();
    expect(screen.queryByRole("button", { name: /^Download/ })).not.toBeInTheDocument();
    // What a restart costs, said before it is pressed rather than after.
    expect(screen.getByText(/close and reopen/i)).toBeInTheDocument();
  });

  it("runs the download and the install through the hook", async () => {
    const download = vi.fn();
    const install = vi.fn();
    const { rerender } = render(panel(update({ download })));
    await userEvent.click(primary(/^Download/));
    expect(download).toHaveBeenCalledOnce();

    rerender(
      panel(update({ status: status({ staged: true }), action: "install", install })),
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
      panel(
        update({
          status: status({ asset: null, installKind: "other" }),
          action: "unavailable",
          openReleasePage,
        }),
      ),
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
      panel(
        update({
          status: status({ available: null, asset: null, lastCheckAt: null }),
          action: "none",
        }),
      ),
    );
    expect(screen.getByText(/Checking for updates/i)).toBeInTheDocument();
    expect(screen.queryByText(/latest version/i)).not.toBeInTheDocument();
    expect(screen.getByText("Not checked yet")).toBeInTheDocument();

    rerender(
      panel(update({ status: status({ available: null, asset: null }), action: "none" })),
    );
    expect(screen.getByText(/latest version/i)).toBeInTheDocument();
  });

  it("shows the download bar with a real percentage while bytes are arriving", () => {
    render(panel(update({ busy: true, progress: { done: 3_226_956, total: 6_453_913 } })));
    const bar = screen.getByRole("progressbar", { name: /downloading/i });
    expect(bar).toHaveAttribute("aria-valuenow", "50");
    expect(screen.getByText("3.2 MB of 6.5 MB")).toBeInTheDocument();
    expect(primary(/Downloading/)).toBeDisabled();
  });

  /** A total of zero has no percentage, and `aria-valuenow="0"` would claim there was one. */
  it("omits the value rather than claiming zero when the size is unknown", () => {
    render(panel(update({ progress: { done: 0, total: 0 } })));
    expect(screen.getByRole("progressbar")).not.toHaveAttribute("aria-valuenow");
  });

  it("puts a failed download in an alert and leaves the button usable", async () => {
    const download = vi.fn();
    render(
      panel(
        update({ error: "the download did not match its published checksum.", download }),
      ),
    );
    expect(screen.getByRole("alert")).toHaveTextContent(/published checksum/);
    await userEvent.click(primary(/^Download/));
    expect(download).toHaveBeenCalledOnce();
  });

  it("re-checks on demand and reports the current version", async () => {
    const check = vi.fn();
    render(panel(update({ check })));
    expect(screen.getByText("0.2.0")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /check now/i }));
    expect(check).toHaveBeenCalledOnce();
  });

  /**
   * The mark is drawn beside the version, and the half worth pinning is that it is **not** in
   * the accessibility tree.
   *
   * `GrimoireMark` names itself only on a surface that draws it *instead of* the product name,
   * and this panel sets that name in type in the same sentence as the version — so the claim
   * here is a pair: the picture is drawn, and a screen reader is told `MTG Grimoire` once
   * rather than twice. Reversing either half is a change to the panel's argument and should
   * fail here.
   *
   * **Found by the gradient it ships, because the obvious query is the one that does not
   * work.** `svg[viewBox='0 0 64 64']` is the only thing in the markup that says *which*
   * picture was drawn — every other SVG on this panel is a lucide icon on a 24 unit grid — and
   * under jsdom it matches **nothing**, in either casing: nwsapi lowercases an attribute name
   * in a selector whatever namespace the element is in, and the parsed attribute is `viewBox`.
   * It fails as an empty query rather than as an error, which reads exactly like a mark that
   * was never drawn (probed here on 2026-08-22; a real browser matches it, so the same line in
   * a Storybook play would have passed and the two would have disagreed about the same panel).
   *
   * A **type** selector stays case-aware for a foreign element, so `linearGradient` is both the
   * query that works and the more interesting claim: that `<defs>` gradient is shipped by the
   * full variant alone, so finding one is the proof that 36 cleared the component's 24px detail
   * floor. A well-meant shrink into the chrome's size range would otherwise leave the width
   * merely looking different while quietly drawing the simplified mark instead.
   */
  it("draws the full mark beside the version and keeps it out of the name", () => {
    const { container } = render(panel());

    const gradient = container.querySelector("linearGradient");
    expect(gradient).toBeInTheDocument();
    const mark = gradient?.closest("svg");
    expect(mark).toHaveAttribute("width", "36");
    expect(mark).toHaveAttribute("aria-hidden", "true");

    // The words are what carry the name, which is the whole permission for hiding the mark.
    expect(screen.getByText(/MTG Grimoire/)).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: /MTG Grimoire/i })).not.toBeInTheDocument();
  });

  /**
   * **This assertion is the inverse of the one it replaced**, and the reversal is the whole
   * change: the panel used to show a release body in a `<pre>` and pin the absence of any
   * rendering, on the argument that half-rendered markdown reads worse than none. There is a
   * reader now, and the fallback it ends in — an unrecognised line becomes a paragraph — is
   * what answers that argument rather than abandoning it.
   */
  it("renders the release notes rather than printing their markup", () => {
    render(panel());

    expect(screen.queryByText(/### Features/)).not.toBeInTheDocument();
    expect(screen.getByText("Features")).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
  });

  /** Both display rules the reader asked for, on one real body. */
  it("drops the commit shas and collapses the bullets that repeat", () => {
    render(panel());
    const items = screen.getAllByRole("listitem").map((li) => li.textContent);

    expect(items).toEqual([
      "search: sortable table headers",
      "decks: an undo journal",
    ]);
    expect(screen.queryByText(/23d15d5/)).not.toBeInTheDocument();
    // The version heading too: the line above the notes already says 0.3.0 and the date.
    expect(screen.queryByText(/2026-08-09\)/)).not.toBeInTheDocument();
  });

  it.each<[UpdateAction, RegExp]>([
    ["download", /^Download/],
    ["install", /^Restart to finish$/],
    ["unavailable", /^Open the release page$/],
  ])("shows exactly one primary control for %s", (action, name) => {
    render(
      panel(
        update({
          status: status({
            staged: action === "install",
            asset: action === "unavailable" ? null : asset,
          }),
          action,
        }),
      ),
    );
    expect(screen.getAllByRole("button", { name })).toHaveLength(1);
  });

  describe("version history", () => {
    /**
     * **Every row starts closed**, which is what the reader asked for and what keeps the
     * panel answering the question most people open Settings with. The list is versions and
     * dates; a body appears only where one is asked for.
     */
    it("lists every release closed, and opens one on request", async () => {
      render(panel(update(), history({ releases: [note("0.2.0"), note("0.1.0")] })));

      const row = screen.getByRole("button", { name: /0\.2\.0/ });
      expect(row).toHaveAttribute("aria-expanded", "false");
      expect(screen.getByRole("button", { name: /0\.1\.0/ })).toHaveAttribute(
        "aria-expanded",
        "false",
      );
      expect(screen.queryByText("what 0.2.0 brought")).not.toBeInTheDocument();

      await userEvent.click(row);
      expect(row).toHaveAttribute("aria-expanded", "true");
      expect(await screen.findByText("what 0.2.0 brought")).toBeInTheDocument();
      // Opening one leaves the others alone — each row is its own disclosure.
      expect(screen.queryByText("what 0.1.0 brought")).not.toBeInTheDocument();
    });

    it("marks the running version and nothing else", () => {
      render(
        panel(update(), history({ releases: [note("0.3.0"), note("0.2.0"), note("0.1.0")] })),
      );
      const installed = screen.getByText("installed");
      // `currentVersion` is 0.2.0, and it is the *middle* row — a history reaches past the
      // running build, because the check caches the whole page it fetched.
      expect(within(installed.closest("button")!).getByText("0.2.0")).toBeInTheDocument();
      expect(screen.getAllByText("installed")).toHaveLength(1);
    });

    /**
     * An install that has never reached GitHub. Not an error and not an app with no past —
     * nothing has been cached to list, and the way out is the button at the top of the panel.
     */
    it("says the history has not been fetched rather than drawing an empty list", () => {
      // A world with nothing offered either, so the only `list` a query could find would be
      // the history's own — the notes above draw one too.
      render(
        panel(
          update({ status: status({ available: null, asset: null }), action: "none" }),
          history(),
        ),
      );
      expect(screen.getByText(/No releases have been read yet/)).toBeInTheDocument();
      expect(screen.queryByRole("list")).not.toBeInTheDocument();
    });

    it("says why the history could not be read, without disturbing the update above it", () => {
      render(panel(update(), history({ error: "the database is busy" })));
      expect(screen.getByText("the database is busy")).toBeInTheDocument();
      expect(primary(/^Download/)).toBeEnabled();
    });

    /** A release really can publish an empty body, and an empty box reads as a failure. */
    it("says so when a release published no notes", async () => {
      render(panel(update(), history({ releases: [note("0.1.0", "")] })));
      await userEvent.click(screen.getByRole("button", { name: /0\.1\.0/ }));
      expect(await screen.findByText("This release published no notes.")).toBeInTheDocument();
    });
  });
});
