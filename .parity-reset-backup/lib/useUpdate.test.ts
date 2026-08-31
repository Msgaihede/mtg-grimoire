import { describe, expect, it } from "vitest";
import type { UpdateAsset, UpdateStatus } from "@/lib/ipc";
import { formatBytes, formatChecked, nextAction } from "@/lib/useUpdate";

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
    notes: "",
    publishedAt: "2026-08-09T04:02:20Z",
    htmlUrl: "https://example.invalid",
    assets: [asset],
  },
  asset,
  lastCheckAt: "1800000000",
  busy: false,
  staged: false,
  ...over,
});

describe("nextAction", () => {
  it("offers a download, then an install, and nothing at all when there is no release", () => {
    expect(nextAction(status())).toBe("download");
    expect(nextAction(status({ staged: true }))).toBe("install");
    expect(nextAction(status({ available: null }))).toBe("none");
    expect(nextAction(null)).toBe("none");
  });

  /**
   * The MSI-install and Linux case: a release exists, and this copy of the app has no way to
   * install it. `unavailable` rather than `none`, because the reader should still be told —
   * what changes is the promise the button makes, not whether the news is shared.
   */
  it("is unavailable, not silent, when the release carries nothing this install can use", () => {
    expect(nextAction(status({ asset: null }))).toBe("unavailable");
    expect(nextAction(status({ asset: null, installKind: "other" }))).toBe("unavailable");
  });

  /**
   * A staged build outranks a missing asset. Once the bytes are on disk and verified, what
   * the release does or does not still offer cannot un-download them.
   */
  it("keeps offering the install once something is staged", () => {
    expect(nextAction(status({ staged: true, asset: null }))).toBe("install");
  });
});

describe("formatChecked", () => {
  const now = 1_800_000_000_000; // ms

  it("counts up through minutes, hours and days", () => {
    expect(formatChecked("1800000000", now)).toBe("Checked just now");
    expect(formatChecked(String(1_800_000_000 - 60), now)).toBe("Checked 1 minute ago");
    expect(formatChecked(String(1_800_000_000 - 1_800), now)).toBe("Checked 30 minutes ago");
    expect(formatChecked(String(1_800_000_000 - 7_200), now)).toBe("Checked 2 hours ago");
    expect(formatChecked(String(1_800_000_000 - 172_800), now)).toBe("Checked 2 days ago");
  });

  /**
   * It floors now, where it used to round (2026-08-16, when the arithmetic moved to
   * `lib/relativeTime`). Ninety minutes read `Checked 2 hours ago` here while
   * `ErrorLogPanel`'s already-flooring `formatWhen` called the same span `1 hour ago`, on
   * one page. None of the cases above moved, because every one of them is an exact multiple.
   */
  it("floors rather than rounding, so ninety minutes is one hour", () => {
    expect(formatChecked(String(1_800_000_000 - 5_400), now)).toBe("Checked 1 hour ago");
    expect(formatChecked(String(1_800_000_000 - 45), now)).toBe("Checked just now");
  });

  /** Past a week, "9 days ago" stops being easier to read than the day itself. */
  it("becomes a date once it is more than a week old", () => {
    expect(formatChecked(String(1_800_000_000 - 864_000), now)).toMatch(
      /^Checked on \d{4}-\d{2}-\d{2}$/,
    );
  });

  /**
   * The cut-off moved with the rounding rule: it is `daysSince`'s floored count, so the date
   * arm begins exactly where the relative arm would have said `8 days ago`. Seven and a half
   * days used to round to eight and print a date; it reads `7 days ago` now.
   */
  it("keeps the whole of the first week relative", () => {
    expect(formatChecked(String(1_800_000_000 - (7 * 86_400 + 43_200)), now)).toBe(
      "Checked 7 days ago",
    );
    expect(formatChecked(String(1_800_000_000 - 8 * 86_400), now)).toMatch(/^Checked on /);
  });

  /**
   * Never checked and unreadable are the same sentence, and neither is "just now" — this
   * line sits under a version number, where a wrong claim about freshness is the whole
   * failure.
   */
  it("says so plainly when there is nothing to report", () => {
    expect(formatChecked(null, now)).toBe("Not checked yet");
    expect(formatChecked("", now)).toBe("Not checked yet");
    expect(formatChecked("yesterday", now)).toBe("Not checked yet");
    expect(formatChecked("0", now)).toBe("Not checked yet");
  });

  /** A clock that moved backwards leaves a stamp in the future; "in -3 hours" helps nobody. */
  it("does not count backwards from a timestamp in the future", () => {
    expect(formatChecked(String(1_800_000_000 + 90_000), now)).toBe("Checked just now");
  });
});

describe("formatBytes", () => {
  it("reports megabytes to one decimal", () => {
    expect(formatBytes(6_453_913)).toBe("6.5 MB");
    expect(formatBytes(4_809_910)).toBe("4.8 MB");
    expect(formatBytes(0)).toBe("0.0 MB");
  });
});
