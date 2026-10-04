import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import { saveText } from "@/lib/core/files";

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
