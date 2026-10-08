import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const openExternal = vi.hoisted(() => vi.fn());
vi.mock("@/lib/externalLinks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/externalLinks")>()),
  openExternal,
}));

import { PRIVACY_URL } from "@/lib/externalLinks";
import { TOUCH_FLOOR } from "./controls";
import { PrivacyLink } from "./PrivacyLink";

beforeEach(() => {
  openExternal.mockReset().mockResolvedValue(undefined);
});

describe("PrivacyLink", () => {
  it("is a link to the policy's own address", () => {
    render(<PrivacyLink />);
    const link = screen.getByRole("link", { name: "Privacy policy" });
    // A real address on a real anchor: a middle click, a long press and a screen reader all
    // get the destination, on a host where the press below is never needed.
    expect(link).toHaveAttribute("href", PRIVACY_URL);
    expect(PRIVACY_URL).toBe("https://mtg-grimoire.app/privacy");
    expect(link).toHaveAttribute("target", "_blank");
  });

  it("leaves the app through the host, once, on a press", async () => {
    const user = userEvent.setup();
    render(<PrivacyLink />);
    // Recorded in the bubble phase, after React's handler has run: whether the press's own
    // navigation was cancelled. `openExternal` is mocked and jsdom follows nothing, so this is
    // the only place the cancellation can be seen.
    const defaultPrevented: boolean[] = [];
    const record = (event: Event) => defaultPrevented.push(event.defaultPrevented);
    document.addEventListener("click", record);
    try {
      await user.click(screen.getByRole("link", { name: "Privacy policy" }));
    } finally {
      document.removeEventListener("click", record);
    }
    // The host's way out, and not the anchor's own: a desktop webview does not follow
    // `target="_blank"`, and a browser following it as well would open two tabs.
    expect(openExternal).toHaveBeenCalledTimes(1);
    expect(openExternal).toHaveBeenCalledWith(PRIVACY_URL);
    expect(defaultPrevented).toEqual([true]);
  });

  it("is large enough for a finger", () => {
    render(<PrivacyLink />);
    const link = screen.getByRole("link", { name: "Privacy policy" });
    expect(link.classList.contains(TOUCH_FLOOR)).toBe(true);
  });
});
