import { afterEach, describe, expect, it, vi } from "vitest";

const writeText = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const openUrl = vi.hoisted(() => vi.fn(() => Promise.resolve()));
// The plugin packages themselves, for `stories.test.tsx`'s reason: a mock of Tauri's core does
// not reach inside `node_modules`, so the wrappers are what a test stands in for.
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl }));

import { browserHost, NO_CLIPBOARD, NOT_OPENED, tableHost } from "@/lib/core/host";
import { tauriHost } from "@/lib/core/tauri";

afterEach(() => {
  vi.restoreAllMocks();
  writeText.mockClear();
  openUrl.mockClear();
});

/** `navigator.clipboard` for one test — jsdom has none of its own. */
function withClipboard(value: unknown): () => void {
  const was = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", { configurable: true, value });
  return () => {
    if (was === undefined) Reflect.deleteProperty(navigator, "clipboard");
    else Object.defineProperty(navigator, "clipboard", was);
  };
}

describe("a browser's host services", () => {
  it("copies through navigator.clipboard", async () => {
    const write = vi.fn(() => Promise.resolve());
    const restore = withClipboard({ writeText: write });
    try {
      await browserHost.copyText("1 Sol Ring\n");
      expect(write).toHaveBeenCalledWith("1 Sol Ring\n");
    } finally {
      restore();
    }
  });

  it("rejects where the browser offers no clipboard, rather than pretending it copied", async () => {
    const restore = withClipboard(undefined);
    try {
      await expect(browserHost.copyText("1 Sol Ring\n")).rejects.toThrow(NO_CLIPBOARD);
    } finally {
      restore();
    }
  });

  it("passes on a write the browser refused, in the browser's words", async () => {
    const restore = withClipboard({
      writeText: () => Promise.reject(new DOMException("Document is not focused.")),
    });
    try {
      await expect(browserHost.copyText("x")).rejects.toThrow("Document is not focused.");
    } finally {
      restore();
    }
  });

  it("opens a link in a new tab and cuts the way back", async () => {
    const tab = { opener: window as unknown };
    const open = vi.spyOn(window, "open").mockReturnValue(tab as Window);

    await browserHost.openUrl("https://scryfall.com/card/2x2/117");

    expect(open).toHaveBeenCalledWith("https://scryfall.com/card/2x2/117", "_blank");
    expect(tab.opener).toBeNull();
  });

  it("rejects when the browser made no tab, so the press can say so", async () => {
    // A pop-up blocker answers `null`. With the `noopener` feature it would answer `null` for a
    // tab that did open too, and this refusal could not be told from a success.
    vi.spyOn(window, "open").mockReturnValue(null);
    await expect(browserHost.openUrl("https://www.patreon.com/oauth2/authorize")).rejects.toThrow(
      NOT_OPENED,
    );
  });
});

describe("the desktop's host services", () => {
  it("are the two Tauri plugins", async () => {
    await tauriHost.copyText("Lightning Bolt");
    await tauriHost.openUrl("https://edhrec.com/route/?cc=Lightning%20Bolt");
    expect(writeText).toHaveBeenCalledWith("Lightning Bolt");
    expect(openUrl).toHaveBeenCalledWith("https://edhrec.com/route/?cc=Lightning%20Bolt");
  });
});

describe("the Android host's services", () => {
  it("copy as a browser does and open through Tauri's opener", async () => {
    // The host registers no clipboard plugin, and grants the page the opener's pair.
    const write = vi.fn(() => Promise.resolve());
    const restore = withClipboard({ writeText: write });
    const open = vi.spyOn(window, "open");
    try {
      await tableHost.copyText("Lightning Bolt");
      await tableHost.openUrl("https://scryfall.com/card/2x2/117");
    } finally {
      restore();
    }
    expect(write).toHaveBeenCalledWith("Lightning Bolt");
    expect(writeText).not.toHaveBeenCalled();
    expect(openUrl).toHaveBeenCalledWith("https://scryfall.com/card/2x2/117");
    expect(open).not.toHaveBeenCalled();
  });
});

describe("the host a build chooses", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  // Each test's modules are its own (`resetModules` above), so what a build chose is compared
  // with the implementations loaded beside it rather than with this file's static imports.
  it("is picked by the mark the light host sets, as the core is", async () => {
    const { pickHost } = await import("@/lib/core");
    const fresh = await import("@/lib/core/host");
    const { tauriHost: desktop } = await import("@/lib/core/tauri");
    expect(pickHost({ __GRIMOIRE_CORE__: "table" })).toBe(fresh.tableHost);
    expect(pickHost({})).toBe(desktop);
    expect(pickHost({ __GRIMOIRE_CORE__: "something else" })).toBe(desktop);
  });

  it("is the desktop's in every build but the web app's, this suite's included", async () => {
    const { host } = await import("@/lib/core");
    const { tauriHost: desktop } = await import("@/lib/core/tauri");
    expect(host).toBe(desktop);
  });

  it("is a browser's in a web build, whatever the window says", async () => {
    vi.stubEnv("MODE", "web");
    vi.resetModules();
    const { host } = await import("@/lib/core");
    const fresh = await import("@/lib/core/host");
    expect(host).toBe(fresh.browserHost);
  });
});
