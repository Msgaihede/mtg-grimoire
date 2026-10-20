import { describe, expect, it, vi } from "vitest";
import { BrowserFault, NETWORK_SERVICE_DIED, attempts, faultIn } from "./fault.ts";

/** A line of Chrome 155.0.8059.39's stderr as the reproduction kept it (issue #1296). */
const DIED =
  "[10941:10941:1020/145120.435823:ERROR:content/browser/network_service_instance_impl.cc:653] " +
  "Network service crashed or was terminated, restarting service.";

describe("faultIn", () => {
  it("reads the browser's sentence off the line that says its network service died", () => {
    expect(faultIn(DIED)).toBe("Network service crashed or was terminated, restarting service.");
    expect(faultIn(DIED)?.startsWith(NETWORK_SERVICE_DIED)).toBe(true);
  });

  it("finds nothing in the noise a headless browser writes on every run", () => {
    for (const line of [
      "[12695:12730:1020/145232.161517:ERROR:net/socket/socket_posix.cc:121] CreatePlatformSocket() failed: Address family not supported by protocol (97)",
      "[13878] [1020/145352.265346:ERROR:third_party/crashpad/crashpad/util/file/file_io_posix.cc:145] open /sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq: No such file or directory (2)",
      "DevTools listening on ws://127.0.0.1:44127/devtools/browser/bfbd86a8",
      "",
    ]) {
      expect(faultIn(line)).toBeNull();
    }
  });
});

describe("attempts", () => {
  const stop = () => vi.fn(async () => undefined);

  it("runs a walk that passes once", async () => {
    const walk = vi.fn(async () => undefined);
    const between = stop();
    await attempts(2, walk, async () => "died", between);
    expect(walk).toHaveBeenCalledTimes(1);
    expect(between).not.toHaveBeenCalled();
  });

  it("runs the walk again after a browser fault, stopping everything in between", async () => {
    const walk = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("the roster holds two devices — never happened"))
      .mockResolvedValueOnce(undefined);
    const between = stop();
    await attempts(2, walk, async () => DIED, between);
    expect(walk).toHaveBeenCalledTimes(2);
    expect(between).toHaveBeenCalledExactlyOnceWith(DIED, 1);
  });

  it("never runs again for a failure that is not the browser's", async () => {
    const failure = new Error("the phone face left its group and logged: rotate");
    const walk = vi.fn(async () => Promise.reject(failure));
    const between = stop();
    await expect(attempts(2, walk, async () => null, between)).rejects.toBe(failure);
    expect(walk).toHaveBeenCalledTimes(1);
    expect(between).not.toHaveBeenCalled();
  });

  it("fails a second fault, saying it was the browser's, with the walk's failure as its cause", async () => {
    const failure = new Error("its socket came up — never happened");
    const walk = vi.fn(async () => Promise.reject(failure));
    const thrown = await attempts(2, walk, async () => DIED, stop()).catch((error) => error);
    expect(walk).toHaveBeenCalledTimes(2);
    expect(thrown).toBeInstanceOf(BrowserFault);
    expect(thrown.message).toContain(DIED);
    expect(thrown.message).toContain("network service died");
    expect(thrown.cause).toBe(failure);
  });

  it("with one attempt, names a fault and does not run again", async () => {
    const walk = vi.fn(async () => Promise.reject(new Error("x")));
    const between = stop();
    await expect(attempts(1, walk, async () => DIED, between)).rejects.toBeInstanceOf(BrowserFault);
    expect(walk).toHaveBeenCalledTimes(1);
    expect(between).not.toHaveBeenCalled();
  });
});
