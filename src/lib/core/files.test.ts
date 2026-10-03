import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import { downloadText, saveText } from "@/lib/core/files";

beforeEach(() => invoke.mockReset());

describe("saveText on the light host", () => {
  const host = { __GRIMOIRE_CORE__: "table" };

  it("asks the host's save dialog by the desktop's command, and says whether it wrote", async () => {
    invoke.mockResolvedValue(true);
    await expect(saveText("Burn.txt", "4 Lightning Bolt\n", host)).resolves.toBe("saved");
    // The test's window carries no mark, so `core` here is the desktop's: the call is the
    // desktop's command by name, with its keys — which is what `core_call` forwards on Android.
    expect(invoke).toHaveBeenCalledWith("export_save_file", {
      fileName: "Burn.txt",
      contents: "4 Lightning Bolt\n",
    });
  });

  it("reports a cancelled dialog as cancelled, not as a failure", async () => {
    invoke.mockResolvedValue(false);
    await expect(saveText("Burn.txt", "x", host)).resolves.toBe("cancelled");
  });
});

describe("downloadText, the browser arm", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("hands the browser a Blob of the text under the name, and releases the URL", async () => {
    vi.useFakeTimers();
    let blob: Blob | undefined;
    // jsdom has no object URLs at all, so both are written for the test and taken back after.
    const created = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
    const revoked = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
    const revoke = vi.fn();
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: (b: Blob) => {
        blob = b;
        return "blob:export";
      },
    });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revoke });
    const pressed: { href: string; download: string }[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      pressed.push({ href: this.getAttribute("href") ?? "", download: this.download });
    });

    try {
      downloadText("Burn.txt", "4 Lightning Bolt\n");

      expect(pressed).toEqual([{ href: "blob:export", download: "Burn.txt" }]);
      expect(await blob?.text()).toBe("4 Lightning Bolt\n");
      // The anchor does not outlive the press, and the URL outlives it by one task.
      expect(document.querySelector("a[download]")).toBeNull();
      expect(revoke).not.toHaveBeenCalled();
      vi.runAllTimers();
      expect(revoke).toHaveBeenCalledWith("blob:export");
    } finally {
      for (const [name, was] of [
        ["createObjectURL", created],
        ["revokeObjectURL", revoked],
      ] as const) {
        if (was === undefined) Reflect.deleteProperty(URL, name);
        else Object.defineProperty(URL, name, was);
      }
    }
  });
});
