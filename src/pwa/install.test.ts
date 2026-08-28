import { beforeEach, describe, expect, it, vi } from "vitest";
import { captureInstallPrompt, installState, promptInstall } from "@/pwa/install";

vi.mock("@/pwa/target", () => ({ isWebTarget: () => true }));

/** The event Chrome fires. It is in no TypeScript lib, so the app declares its own shape. */
function beforeInstallPrompt() {
  const event = new Event("beforeinstallprompt") as Event & {
    preventDefault: () => void;
    prompt: () => Promise<void>;
    userChoice: Promise<{ outcome: string }>;
  };
  event.preventDefault = vi.fn();
  event.prompt = vi.fn(() => Promise.resolve());
  event.userChoice = Promise.resolve({ outcome: "accepted" });
  return event;
}

beforeEach(() => {
  captureInstallPrompt(window, { reset: true });
});

describe("the install prompt", () => {
  it("is unavailable until the browser offers one", () => {
    expect(installState()).toBe("unavailable");
  });

  it("keeps the browser's own bar off the screen and holds the event", () => {
    const event = beforeInstallPrompt();
    window.dispatchEvent(event);
    // Without `preventDefault` Chrome draws its own install bar over the app and this button
    // becomes a second one saying the same thing.
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(installState()).toBe("offered");
  });

  it("shows the browser's dialog on a press, once", async () => {
    const event = beforeInstallPrompt();
    window.dispatchEvent(event);
    await promptInstall();
    expect(event.prompt).toHaveBeenCalledTimes(1);
    // The event is single-use: a browser refuses a second `prompt()` on the same object.
    expect(installState()).toBe("unavailable");
  });

  it("goes quiet once the app is installed", () => {
    window.dispatchEvent(beforeInstallPrompt());
    window.dispatchEvent(new Event("appinstalled"));
    expect(installState()).toBe("installed");
  });
});
