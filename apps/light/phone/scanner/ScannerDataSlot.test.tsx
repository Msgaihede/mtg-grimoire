import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { STATUS } from "@grimoire/ui/features/scanner/fixtures";
import type { ScannerStatus } from "@grimoire/ui/lib/ipc";
import { ScannerDataSlot } from "./ScannerDataSlot";

/** The slot over one status. Pure: it asks no host anything, so it needs no world. */
function mount(status: ScannerStatus | null) {
  const view = render(<ScannerDataSlot status={status} />);
  const slot = () => view.container.querySelector("[data-scanner-data-slot]");
  return { slot, view };
}

describe("the slot for the scanner's data", () => {
  it.each([
    ["before the status has answered", null],
    ["where the recogniser loaded", STATUS.present],
    ["where it loaded and the card names did not", STATUS.unlabelled],
    ["where the build has no recogniser and no sentence about it", STATUS.missing],
    ["on a web page, before a Worker has taken the files", STATUS.store],
  ])("draws nothing — no element at all — %s", (_state, status) => {
    const { slot, view } = mount(status);
    expect(slot()).toBeNull();
    expect(view.container).toBeEmptyDOMElement();
  });

  /**
   * The recogniser there and not loaded: the load's own sentence, and nothing to press — there is
   * nothing to download, and no file a reader holding this page could put anywhere.
   */
  it("says the recogniser's own refusal where it did not load, with nothing to press", () => {
    const { slot } = mount(STATUS.corrupt);
    expect(slot()).toHaveTextContent("The card recognizer did not load: gallery: bad magic.");
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("region", { name: "Scanner files" })).toBeNull();
    expect(slot()).not.toHaveTextContent("Restart the app");
  });
});
