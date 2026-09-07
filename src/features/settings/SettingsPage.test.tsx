import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SyncStatus } from "@/lib/ipc";
import type { Update } from "@/lib/useUpdate";

/**
 * Every panel on this page is stubbed, because what is under test is **which of them the page
 * renders** rather than what any of them draws. Each has its own suite already; mounting them
 * for real here would make this file fail for their reasons.
 *
 * **Since the rail landed (2026-09-03) "which of them" is two questions rather than one** — which
 * group a panel belongs to, and whether the reader has selected that group or typed something
 * that matches it. The first is `nav.ts`'s and is decided with no DOM at all in `nav.test.ts`;
 * what this file can see is the second, so most of its assertions now begin with a press.
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
 *
 * **`onSyncLive` is a third special case, beside `syncStatus`, and it has to be — not because
 * `SettingsPage` reads it, but because `SyncPanel` does now (Task 12's `useDeviceSyncLive()`
 * call), and `SyncPanel` is one of the two panels this page mounts for real rather than
 * stubbing.** The generic branch answers every command with `vi.fn().mockResolvedValue(null)`, a
 * function that *resolves to* a value — correct for a `Promise<T>` command, and wrong for
 * `onSyncLive`, whose contract is `Unlisten` returned **synchronously** so a mount effect can
 * hand it straight back as its own cleanup. Proxied through the generic branch, `ipc.onSyncLive(cb)`
 * returned a `Promise`, `useDeviceSyncLive`'s effect handed that back as its cleanup function, and
 * React threw `TypeError: destroy is not a function` unmounting every test that reaches
 * `SyncPanel`. `syncLiveState` is answered `"off"` rather than falling through to the generic
 * `null`, for the same reason `RelayStatus`'s own em-dash rule exists: a `LiveState` of `null` is
 * a value `liveNote`'s switch was never written to handle, and "off" is what the real command
 * answers when nothing is paired, which is every world this file renders.
 *
 * **Which tests need those two answers changed with the rail, and that is worth stating.** It
 * used to be all nine, because the page drew every panel at once; the two sync panels now mount
 * only while the `Sync` entry is selected or a query matches them, so it is the one test below
 * that presses `Sync` — which is exactly why that test is there. Delete it and these two branches
 * become dead code that nothing would notice.
 *
 * `syncReviewList` falls through to the generic `null` on purpose: the rail's `Sync` badge reads
 * `?? 0` off it, and "the query has not answered" is the state every test here renders in.
 */
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: new Proxy(
    {},
    {
      get: (_target, name) => {
        if (name === "syncStatus") return vi.fn(() => Promise.resolve(backend.syncStatus));
        if (name === "onSyncLive") return vi.fn(() => () => {});
        if (name === "syncLiveState") return vi.fn(() => Promise.resolve("off"));
        return vi.fn().mockResolvedValue(null);
      },
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

afterEach(async () => {
  delete (navigator as unknown as Record<string, unknown>).userAgent;
  backend.syncStatus = null;
  /**
   * **Put back, because two tests below set it and neither used to.** While the `false` case
   * happened to run last that cost nothing; it made the file order-dependent, and a new test
   * written between the two would have inherited `true` from its neighbour with no sign of it
   * anywhere. `false` is the module factory's own default and the shape jsdom stands for.
   */
  const { isWebTarget } = await import("@/pwa/target");
  vi.mocked(isWebTarget).mockReturnValue(false);
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

/**
 * Press a rail entry.
 *
 * **Matched as a prefix of the accessible name rather than as the whole of it**, because two of
 * the six entries carry a badge: a count in a second span folds into one accessible name with no
 * space between the label and the number — `Errors3` — which `src/CLAUDE.md` records as a thing
 * jsdom cannot referee, and a test hedging with `\s*` would pass either way.
 */
async function pickGroup(label: string) {
  await userEvent.click(screen.getByRole("button", { name: new RegExp(`^${label}`) }));
}

/**
 * The rail's search box.
 *
 * Every filter box in this app is an `<input type="search">` — `src/CLAUDE.md`'s rule, and the
 * reason `clearFieldOnEscape` exists — so `searchbox` is the role to ask for. The fallback is
 * for the one shape that would otherwise make this file fail with "unable to find role" and say
 * nothing about which role it did find; nothing else this page draws while a group is unselected
 * is a text entry.
 */
function searchBox(): HTMLElement {
  return screen.queryByRole("searchbox") ?? screen.getByRole("textbox");
}

describe("the Backup panel is on every platform", () => {
  it("is on the page under jsdom, which is the desktop shape", async () => {
    render(wrap(<SettingsPage update={NO_UPDATE} />));
    await pickGroup("Storage and data");

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
   *
   * The "the rest of the page still rendered" witness is now taken in **two** places rather than
   * one, because the two panels it named no longer share a group: the Updates panel is read
   * before the press and the cache after it. That is the same assertion — this is about the
   * Backup panel and not about a mount that failed — asked of a page that draws one group at a
   * time.
   */
  it("stays on Android, where it draws the archive instead of the folder", async () => {
    pretendAndroid();

    render(wrap(<SettingsPage update={NO_UPDATE} />));
    expect(screen.getByText("panel:update")).toBeInTheDocument();

    await pickGroup("Storage and data");

    expect(screen.getByText("panel:backup")).toBeInTheDocument();
    expect(screen.getByText("panel:cache")).toBeInTheDocument();
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
   *
   * `Updates` is also the group the page opens on, so neither of these two needs a press to
   * reach the panel — the second one does, for its witness, and that press is the same
   * two-places move the Android test above explains.
   */
  it("is on the page on the web build, as it is everywhere else", async () => {
    const { isWebTarget } = await import("@/pwa/target");
    vi.mocked(isWebTarget).mockReturnValue(true);

    render(wrap(<SettingsPage update={NO_UPDATE} />));

    expect(screen.getByText("panel:update")).toBeInTheDocument();
    // The page itself still rendered, so this is the panel and not a failed mount — and on this
    // build the browser panel is in the group too, which is the only place `panelsOn`'s web
    // answer is visible from here.
    await pickGroup("Storage and data");
    expect(screen.getByText("panel:cache")).toBeInTheDocument();
    expect(screen.getByText("panel:webstorage")).toBeInTheDocument();
  });

  it("is on the page when the build is not the web one", async () => {
    const { isWebTarget } = await import("@/pwa/target");
    vi.mocked(isWebTarget).mockReturnValue(false);

    render(wrap(<SettingsPage update={NO_UPDATE} />));

    expect(screen.getByText("panel:update")).toBeInTheDocument();
  });

  /** The other half of the gate, and the one that costs a desktop reader nothing. */
  it("does not draw the browser panel where there is no browser to describe", async () => {
    render(wrap(<SettingsPage update={NO_UPDATE} />));
    await pickGroup("Storage and data");

    expect(screen.getByText("panel:cache")).toBeInTheDocument();
    expect(screen.queryByText("panel:webstorage")).not.toBeInTheDocument();
  });
});

/**
 * **9a's touch census found both of these reached the UI at exactly one place each, and that
 * place was a hover tooltip** on the ribbon's status line — `Ribbon.tsx:96` for the folder,
 * `:97–98` for the count. A phone reader has no hover, and there was no second door to either:
 * re-verified by grep on 2026-08-29, which found `imageStoreFailures` drawn in no other string
 * and `dataDir` in no other expression. This section is that second door, and the tooltip is
 * untouched — a pointer reader loses nothing.
 *
 * Every test here now opens `Storage and data` first: the section is the first panel of that
 * group, which is where `nav.ts` files the page's three panels about the folder on disk.
 */
describe("the data folder gets a home on the page", () => {
  it("names the folder the app keeps everything in", async () => {
    backend.syncStatus = syncStatus({ dataDir: "E:\\Grimoire\\data" });

    render(wrap(<SettingsPage update={NO_UPDATE} />));
    await pickGroup("Storage and data");

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
    await pickGroup("Storage and data");

    expect(
      await screen.findByText(
        "12 card images could not be saved there this session — the folder may be read-only or full.",
      ),
    ).toBeInTheDocument();
  });

  it("does not print “1 card images”", async () => {
    backend.syncStatus = syncStatus({ imageStoreFailures: 1 });

    render(wrap(<SettingsPage update={NO_UPDATE} />));
    await pickGroup("Storage and data");

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
    await pickGroup("Storage and data");

    expect(
      await screen.findByText("No card images have failed to save this session."),
    ).toBeInTheDocument();
  });

  /**
   * The blurb promised the folder; the section above it delivers now. Import still does not.
   *
   * **What this can assert changed with the rail and the intent did not.** The `Not here yet`
   * block has left the page for the rail, so the heading is `SettingsNav`'s to draw and its own
   * suite's to test; what is still this page's to answer is that the folder is a *panel* rather
   * than a promise, which is what these two lines say — the path is on screen, and nothing on
   * the page files the folder under things still to come.
   */
  it("no longer promises the folder as something still to come", async () => {
    backend.syncStatus = syncStatus();

    render(wrap(<SettingsPage update={NO_UPDATE} />));
    await pickGroup("Storage and data");

    expect(await screen.findByText("D:\\MTG Grimoire\\data")).toBeInTheDocument();
    expect(screen.queryByText(/Data folder and import/)).not.toBeInTheDocument();
  });
});

/**
 * The rail, from the pane's side.
 *
 * `nav.test.ts` owns *which* panels a group holds and which a query matches — decidable with no
 * DOM, and tested there as a function. What is only answerable here is that the page actually
 * asks: that it opens on a group rather than on everything, that a press moves it, that a query
 * outranks the press, and that the two states are never both live at once.
 */
describe("the rail decides what the pane draws", () => {
  it("opens on Updates, with the other groups' panels off the page", () => {
    render(wrap(<SettingsPage update={NO_UPDATE} />));

    expect(screen.getByText("panel:update")).toBeInTheDocument();
    // One panel from three other groups, so this is about the grouping rather than about one
    // component failing to mount.
    expect(screen.queryByText("panel:prices")).not.toBeInTheDocument();
    expect(screen.queryByText("panel:hidden")).not.toBeInTheDocument();
    expect(screen.queryByText("panel:danger")).not.toBeInTheDocument();
  });

  it("draws a group's panels, and only that group's, once its entry is pressed", async () => {
    render(wrap(<SettingsPage update={NO_UPDATE} />));

    await pickGroup("Card data");

    expect(screen.getByText("panel:prices")).toBeInTheDocument();
    expect(screen.getByText("panel:combos")).toBeInTheDocument();
    // The group it came from is gone, which is the half a `shown()` stuck at `true` would fail.
    expect(screen.queryByText("panel:update")).not.toBeInTheDocument();
  });

  /**
   * **The two panels this file does not stub, mounted for real, and that is the point of the
   * test rather than a side effect.** `SyncPanel` and `ReviewPanel` are the only ones the page
   * draws unmocked here, so the `onSyncLive`/`syncLiveState` branches of the `ipc` proxy above
   * are reachable from this test and from no other. Before the rail every test mounted them;
   * now exactly one does.
   */
  it("mounts the sync panels for real when the Sync entry is pressed", async () => {
    render(wrap(<SettingsPage update={NO_UPDATE} />));

    await pickGroup("Sync");

    expect(screen.getByRole("region", { name: "Sync" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Needs review" })).toBeInTheDocument();
  });

  /**
   * **A query outranks the group**, which is `nav.ts`'s one rule stated from this side: a reader
   * standing on `Updates` who types "dropbox" is asking Settings a question, not asking the
   * `Updates` group one. The word is one of `Backup`'s keywords and appears in no other panel's,
   * so the answer is a single panel from a group nobody selected.
   */
  it("finds a panel in a group that is not selected", async () => {
    render(wrap(<SettingsPage update={NO_UPDATE} />));

    await userEvent.type(searchBox(), "dropbox");

    expect(screen.getByText("panel:backup")).toBeInTheDocument();
    // The selected group's own panel is gone while the query stands, because the query is
    // answering instead of the group — not alongside it.
    expect(screen.queryByText("panel:update")).not.toBeInTheDocument();
  });

  it("says so when nothing matches", async () => {
    render(wrap(<SettingsPage update={NO_UPDATE} />));

    await userEvent.type(searchBox(), "xyzzy");

    expect(screen.getByText("Nothing in Settings matches that.")).toBeInTheDocument();
    expect(screen.queryByText("panel:update")).not.toBeInTheDocument();
    expect(screen.queryByText("panel:backup")).not.toBeInTheDocument();
  });

  /**
   * **Picking a group clears the query, and the page does it rather than the rail.** Without it
   * the two states would both apply and the query would keep winning, so pressing an entry would
   * appear to do nothing at all — the worst shape this bug could take, because the rail would
   * still mark the new entry as current while drawing the old answer.
   */
  it("clears the query when a group is picked", async () => {
    render(wrap(<SettingsPage update={NO_UPDATE} />));

    await userEvent.type(searchBox(), "dropbox");
    expect(screen.getByText("panel:backup")).toBeInTheDocument();

    await pickGroup("Card data");

    expect(searchBox()).toHaveValue("");
    expect(screen.getByText("panel:prices")).toBeInTheDocument();
    expect(screen.queryByText("panel:backup")).not.toBeInTheDocument();
  });
});
