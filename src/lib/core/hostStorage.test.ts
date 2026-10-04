import { describe, expect, it, vi } from "vitest";
import { STORAGE_PERSISTENCE, storageIsLent, type StoragePersistence } from "./hostStorage";

/** A host that answers `storage_persistence` with `record`, and one that refuses the name. */
const answering = (record: StoragePersistence | null) => ({
  call: vi.fn().mockResolvedValue(record),
});
const refusing = () => ({
  call: vi.fn().mockRejectedValue("Command storage_persistence not found"),
});

describe("whether a host's storage is lent to it", () => {
  /**
   * **The kind of host, not what it was told.** A browser that granted persistence will not
   * evict the database by itself and a reader who clears the site's data clears it all the same;
   * one with no way to ask answers `null`. Each of them is a browser.
   */
  it.each<[string, StoragePersistence | null]>([
    ["was asked and refused", { askedAt: 1_700_000_000_000, granted: false }],
    ["granted persistence", { askedAt: 1_700_000_000_000, granted: true }],
    ["keeps its storage unasked", { askedAt: null, granted: true }],
    ["has no way to be asked", null],
  ])("is true of a host that %s", async (_what, record) => {
    const host = answering(record);
    await expect(storageIsLent(host)).resolves.toBe(true);
    expect(host.call).toHaveBeenCalledWith(STORAGE_PERSISTENCE);
  });

  /** A desktop and the Android host own their folder, and refuse the name in words. */
  it("is false of a host that refuses the name, and never a rejection", async () => {
    await expect(storageIsLent(refusing())).resolves.toBe(false);
  });
});
