import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SyncStatus } from "@/lib/ipc";
import type { Update } from "@/lib/useUpdate";

/**
 * Every panel on this page is stubbed, because what is under test is **which of them the page
 * renders** rather than what any of them draws. Each has its own suite already; mounting them
 * for real here would make this file fail for their reasons.
 */
function stub(name: string) {
  const Panel = () => <div>{name}</div>;
  return Panel;
}
vi.mock("@/features/settings/BackupPanel", () => ({ BackupPanel: stub("panel:backup") }));
vi.mock("@/features/settings/CachePanel", () => ({ CachePanel: stub("panel:cache") }));
vi.mock("@/features/settings/CombosPanel", () => ({ CombosPanel: stub("panel:combos") }));
vi.mock("@/features/settings/DangerZonePanel", () => ({
  DangerZonePanel: stub("panel:danger"),
}));
vi.mock("@/features/settings/ErrorLogPanel", () => ({ ErrorLogPanel: stub("panel:errors") }));
vi.mock("@/features/settings/HiddenTagsPanel", () => ({
  HiddenTagsPanel: stub("panel:hidden"),
}));
vi.mock("@/features/settings/MarketplacePanel", () => ({
  MarketplacePanel: stub("panel:prices"),
}));
vi.mock("@/features/settings/UpdatePanel", () => ({ UpdatePanel: stub("panel:update") }));
// `isWebTarget` reads `__CORE__`, a build-time constant vitest fixes at "tauri" — so the web
// answer is only reachable by mocking the module, which its own doc says.
vi.mock("@/pwa/target", () => ({ isWebTarget: vi.fn(() => false) }));
// **Stubbed for the same reason the other eight are, and it had never needed to be**: it is
// the one panel `SettingsPage` draws *only* when `isWebTarget()` is true, so before this file
// could say that, it never rendered here. Unstubbed it reaches `caches.open` on mount, which
// jsdom has no Cache Storage for — a failure about the environment rather than about the gate.
// The hook goes with it: `SettingsPage` calls `useWebStorage()` unconditionally, and the real
// one reaches `caches.open` as soon as `isWebTarget()` answers true.
vi.mock("@/features/settings/WebStoragePanel", () => ({
  WebStoragePanel: stub("panel:webstorage"),
  useWebStorage: () => null,
}));

/**
 * The one command this file answers for real, held in `vi.hoisted` because `vi.mock`'s factory
 * is hoisted above every other binding in the file. The Data folder section reads `sync_status`
 * itself — it is the only thing on this page not behind a stub — and both facts it draws come
 * out of that single answer.
 */
const backend = vi.hoisted(() => ({ syncStatus: null as SyncStatus | null }));

/**
 * The page's hooks all reach the backend through the one `ipc` object, so one mock covers
 * them. Every other command answers `null`: those results are only ever handed to the stubs
 * above, and a hook that resolves is a hook that does not leave React in a suspended state.
 */
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: new Proxy(
    {},
    {
      get: (_target, name) =>
        name === "syncStatus"
          ? vi.fn(() => Promise.resolve(backend.syncStatus))
          : vi.fn().mockResolvedValue(null),
    },
  ) as unknown as typeof import("@/lib/ipc").ipc,
}));

import { SettingsPage } from "./SettingsPage";

const NO_UPDATE = {
  status: null,
  action: "check",
  busy: false,
  check: vi.fn(),
  download: vi.fn(),
  apply: vi.fn(),
  openReleasePage: vi.fn(),
} as unknown as Update;

function wrap(node: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{node}</QueryClientProvider>;
}

/**
 * Redefine the agent `isAndroid()` reads by default, and put it back afterwards. A prop would
 * test a parameter nothing passes; the default is what both call sites use.
 */
function pretendAndroid() {
  Object.defineProperty(navigator, "userAgent", {
    value:
      "Mozilla/5.0 (Linux; Android 16; CPH2581 Build/BP2A.250605.015; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/150.0.7871.183 Mobile Safari/537.36",
    configurable: true,
  });
}

afterEach(() => {
  delete (navigator as unknown as Record<string, unknown>).userAgent;
  backend.syncStatus = null;
});

/**
 * A whole `sync_status` answer. Written out rather than partial: `dataDir`, `syncing` and
 * `imageStoreFailures` are always answered by the backend, and the five database-derived fields
 * are `null` only when the read-only connection could not be used at all — a fixture that left
 * any of them off would be a shape the command never sends.
 */
function syncStatus(over: Partial<SyncStatus> = {}): SyncStatus {
  return {
    cardCount: 116_568,
    lastCheckAt: "1756400000",
    bulkUpdatedAt: "2026-08-28T21:16:27.869+00:00",
    lastError: null,
    lastIngestSkipped: 0,
    dataDir: "D:\\MTG Grimoire\\data",
    syncing: false,
    imageStoreFailures: 0,
    ...over,
  };
}

const folderPanel = () => screen.getByRole("region", { name: "Data folder" });

describe("the Backup panel is on every platform", () => {
  it("is on the page under jsdom, which is the desktop shape", () => {
    render(wrap(<SettingsPage update={NO_UPDATE} />));

    expect(screen.getByText("panel:backup")).toBeInTheDocument();
  });

  /**
   * **This assertion was the opposite until 2026-08-31, and the reversal is the point.** The
   * panel used to be hidden outright on Android, because the mirror writes a folder a reader
   * opens in a text editor, syncs with Dropbox or greps — none of which an Android app's own
   * directory affords — and `tauri-plugin-dialog`'s manifest records the platform as having no
   * folder picker, so the root could not be chosen either. All of that is still true; hiding the
   * panel took the *backup* away along with the folder, which is more than the reason supported.
   *
   * `BackupPanel` now dispatches on the platform itself and draws the archive here, so the page
   * mounts it unconditionally. **`BackupArchivePanel.test.tsx` is where the two shapes are told
   * apart** — this file mocks the panel to a stub, so all it can see is whether it is on the
   * page at all.
   */
  it("stays on Android, where it draws the archive instead of the folder", () => {
    pretendAndroid();

    render(wrap(<SettingsPage update={NO_UPDATE} />));

    expect(screen.getByText("panel:backup")).toBeInTheDocument();
    // The rest of the page still rendered, so this is about the panel rather than a failed mount.
    expect(screen.getByText("panel:cache")).toBeInTheDocument();
    expect(screen.getByText("panel:update")).toBeInTheDocument();
  });
});

describe("the Updates panel is drawn on every target", () => {
  /**
   * **This reverses PR #315, and the history is why the reversal is not a regression.**
   *
   * Driving the phone on 2026-08-30 found `update_history` printing `unknown command` on this
   * page — the last one left in the app after PR 10 routed 114 commands — so #315 hid the
   * whole panel behind `!isWebTarget()`. That was right while none of the five updater
   * commands answered. Two of them answer now: `update_status` and `update_history` are
   * routed by `web::route`, and a browser gets `installKind: "web"`.
   *
   * **So the decision moved out of this file**, and that is the point rather than a
   * refactor. #315's own write-up named the general lesson — *a feature gated on a backend
   * answer is ungated wherever the backend cannot answer* — and a build-time constant
   * standing in for an answer the backend could not give is the other half of the same
   * mistake. What each install kind draws is now `UpdatePanel`'s, tested against a real
   * `installKind` in `UpdatePanel.test.tsx`; all this page decides is that the panel exists.
   *
   * The panel is stubbed here, so these two assert reachability and nothing about content —
   * which is the whole of what this file can honestly say about it.
   */
  it("is on the page on the web build, as it is everywhere else", async () => {
    const { isWebTarget } = await import("@/pwa/target");
    vi.mocked(isWebTarget).mockReturnValue(true);

    render(wrap(<SettingsPage update={NO_UPDATE} />));

    expect(screen.getByText("panel:update")).toBeInTheDocument();
    // The page itself still rendered, so this is the panel and not a failed mount.
    expect(screen.getByText("panel:cache")).toBeInTheDocument();
  });

  it("is on the page when the build is not the web one", async () => {
    const { isWebTarget } = await import("@/pwa/target");
    vi.mocked(isWebTarget).mockReturnValue(false);

    render(wrap(<SettingsPage update={NO_UPDATE} />));

    expect(screen.getByText("panel:update")).toBeInTheDocument();
  });
});

/**
 * **9a's touch census found both of these reached the UI at exactly one place each, and that
 * place was a hover tooltip** on the ribbon's status line — `Ribbon.tsx:96` for the folder,
 * `:97–98` for the count. A phone reader has no hover, and there was no second door to either:
 * re-verified by grep on 2026-08-29, which found `imageStoreFailures` drawn in no other string
 * and `dataDir` in no other expression. This section is that second door, and the tooltip is
 * untouched — a pointer reader loses nothing.
 */
describe("the data folder gets a home on the page", () => {
  it("names the folder the app keeps everything in", async () => {
    backend.syncStatus = syncStatus({ dataDir: "E:\\Grimoire\\data" });

    render(wrap(<SettingsPage update={NO_UPDATE} />));

    expect(await screen.findByText("E:\\Grimoire\\data")).toBeInTheDocument();
    // In this section rather than merely somewhere on the page.
    expect(within(folderPanel()).getByText("E:\\Grimoire\\data")).toBeInTheDocument();
  });

  /**
   * The failure sentence is **one text node**, count and words together, and this asserts it as
   * one whole string for that reason: a number in a span beside a word computes to a single
   * accessible name with no space between them (`Missing2`), and jsdom cannot referee it — a
   * test hedging with `\s*` would pass either way.
   */
  it("states how many card images could not be saved", async () => {
    backend.syncStatus = syncStatus({ imageStoreFailures: 12 });

    render(wrap(<SettingsPage update={NO_UPDATE} />));

    expect(
      await screen.findByText(
        "12 card images could not be saved there this session — the folder may be read-only or full.",
      ),
    ).toBeInTheDocument();
  });

  it("does not print “1 card images”", async () => {
    backend.syncStatus = syncStatus({ imageStoreFailures: 1 });

    render(wrap(<SettingsPage update={NO_UPDATE} />));

    expect(
      await screen.findByText(
        "1 card image could not be saved there this session — the folder may be read-only or full.",
      ),
    ).toBeInTheDocument();
  });

  /**
   * **The line is drawn at zero too, and that is where this deliberately says more than the
   * tooltip**, which appends its sentence only when the count is non-zero. Settings is where a
   * reader comes to *ask*, and the symptom is invisible — every image still displays, the cache
   * simply never fills — so a line that vanished when the answer was "none" could not be told
   * from a page that never knew.
   */
  it("answers the question even when the answer is none", async () => {
    backend.syncStatus = syncStatus({ imageStoreFailures: 0 });

    render(wrap(<SettingsPage update={NO_UPDATE} />));

    expect(
      await screen.findByText("No card images have failed to save this session."),
    ).toBeInTheDocument();
  });

  /** The blurb promised the folder; the section above it delivers now. Import still does not. */
  it("no longer promises the folder as something still to come", async () => {
    backend.syncStatus = syncStatus();

    render(wrap(<SettingsPage update={NO_UPDATE} />));

    await screen.findByText("D:\\MTG Grimoire\\data");
    expect(screen.getByRole("heading", { name: "Not here yet" })).toBeInTheDocument();
    expect(screen.queryByText(/Data folder and import/)).not.toBeInTheDocument();
  });
});
