import { describe, expect, it } from "vitest";
import type { PlaytestStage } from "@/lib/ipc";
import { sandboxEditsAt } from "./sandbox";

describe("sandboxEditsAt", () => {
  it("takes the sandbox's moves wherever the reader plays or declares (issue #1522)", () => {
    const at: PlaytestStage[] = ["main", "respond", "attack", "block"];
    for (const stage of at) expect(sandboxEditsAt(stage), stage).toBe(true);
  });

  it("takes none in a question, before the keep, or when the game is not the reader's", () => {
    const not: PlaytestStage[] = ["prompt", "mulligan", "waiting", "watching", "over"];
    for (const stage of not) expect(sandboxEditsAt(stage), stage).toBe(false);
  });
});
