import { describe, expect, it } from "vitest";
import { isAndroid } from "./platform";

/**
 * **Read off the device, not invented.** Taken from `/json/version` on the OnePlus 12
 * (CPH2581, Android 16, SDK 36) on 2026-08-28, over `adb forward` to a WebView's DevTools
 * socket — so the `Build/...` segment and the `; wv` marker are the real ones. The system
 * WebView there is Chrome 150.0.7871.183.
 */
const ANDROID_WEBVIEW =
  "Mozilla/5.0 (Linux; Android 16; CPH2581 Build/BP2A.250605.015; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/150.0.7871.183 Mobile Safari/537.36";
/** WebView2 on this workstation. */
const WINDOWS_WEBVIEW2 =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36 Edg/151.0.0.0";

describe("isAndroid", () => {
  it("is true in the app's Android WebView", () => {
    expect(isAndroid(ANDROID_WEBVIEW)).toBe(true);
  });

  it("is false in WebView2 on Windows", () => {
    expect(isAndroid(WINDOWS_WEBVIEW2)).toBe(false);
  });

  /**
   * jsdom's default user agent names neither, and every component test and every story runs
   * under it. If an absent match ever became `true`, the whole suite would silently start
   * testing the phone layout — which is the failure this case exists to make loud.
   */
  it("is false for an unknown agent, so tests and stories get the desktop shape", () => {
    expect(isAndroid("Mozilla/5.0 (unknown) jsdom/30")).toBe(false);
    expect(isAndroid("")).toBe(false);
  });

  /**
   * A desktop Chrome pretending to be a phone in device-emulation mode. It IS Android as far as
   * the page is concerned and must read as one — this is the mode a live pass uses to look at
   * the phone shape without a phone, and a test that excluded it would make that impossible.
   */
  it("is true under device emulation, because the page cannot tell the difference", () => {
    expect(
      isAndroid("Mozilla/5.0 (Linux; Android 16; Pixel 9) Chrome/151 Mobile Safari/537.36"),
    ).toBe(true);
  });

  /**
   * The one string that would fool a looser test. A Linux desktop is not Android, and the two
   * share every token but this one — so a check on "Linux" or on "Mobile" would answer wrong
   * here and take the caption off a window that has no other way to close.
   */
  it("is false on a Linux desktop, which shares every other token", () => {
    expect(
      isAndroid(
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
      ),
    ).toBe(false);
  });

  /** It reads `navigator.userAgent` when told nothing, which is how both call sites use it. */
  it("falls back to the document's own agent", () => {
    expect(isAndroid()).toBe(isAndroid(navigator.userAgent));
    expect(isAndroid()).toBe(false);
  });
});
