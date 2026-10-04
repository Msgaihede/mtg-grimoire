import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLAIM, SKIP_WAITING, type Heard } from "./sw/bridge";
import {
  RECHECK_MS,
  watchUpdates,
  WORKER_URL,
  type Registration,
  type WaitingWorker,
  type WorkerContainer,
} from "./update";

/** A service worker the test moves through its states. */
class FakeWorker implements WaitingWorker {
  posted: unknown[] = [];
  private heard: (() => void)[] = [];
  constructor(public state: string) {}
  postMessage(message: unknown): void {
    this.posted.push(message);
  }
  addEventListener(_type: "statechange", listener: () => void): void {
    this.heard.push(listener);
  }
  become(state: string): void {
    this.state = state;
    for (const listener of [...this.heard]) listener();
  }
}

class FakeRegistration implements Registration {
  active: FakeWorker | null = null;
  waiting: FakeWorker | null = null;
  installing: FakeWorker | null = null;
  update = vi.fn(async () => undefined);
  private found: (() => void)[] = [];
  addEventListener(_type: "updatefound", listener: () => void): void {
    this.found.push(listener);
  }
  /** A newer build begins to install, as the browser reports one. */
  find(worker: FakeWorker): void {
    this.installing = worker;
    for (const listener of this.found) listener();
  }
}

class FakeContainer implements WorkerContainer {
  registered: { url: string; options: unknown }[] = [];
  registration = new FakeRegistration();
  refuse: Error | undefined;
  private changed: (() => void)[] = [];
  constructor(public controller: unknown) {}
  register(url: string, options: { updateViaCache: "none" }): Promise<Registration> {
    this.registered.push({ url, options });
    return this.refuse ? Promise.reject(this.refuse) : Promise.resolve(this.registration);
  }
  addEventListener(type: "controllerchange", listener: () => void): void;
  addEventListener(type: "message", listener: (event: Heard) => void): void;
  addEventListener(type: string, listener: unknown): void {
    if (type === "controllerchange") this.changed.push(listener as () => void);
  }
  startMessages(): void {}
  /** A worker takes this page over. */
  takeOver(): void {
    this.controller = {};
    for (const listener of this.changed) listener();
  }
}

function harness(controller: unknown, mayReload = true) {
  const container = new FakeContainer(controller);
  const onChange = vi.fn();
  const reload = vi.fn();
  let visible: (() => void) | undefined;
  let now = 0;
  const start = () =>
    watchUpdates(container, {
      onChange,
      mayReload: () => mayReload,
      reload,
      onVisible: (heard) => (visible = heard),
      now: () => now,
    });
  return {
    container,
    onChange,
    reload,
    start,
    seen: () => visible?.(),
    tick: (ms: number) => void (now += ms),
  };
}

/** Let the registration's promise land. */
const registered = () => new Promise<void>((done) => setTimeout(done, 0));

let warned: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => warned.mockRestore());

describe("registering the service worker", () => {
  it("registers the worker at the origin's root, past the HTTP cache", async () => {
    const { container, start } = harness(null);
    start();
    expect(WORKER_URL).toBe("/sw.js");
    expect(container.registered).toEqual([{ url: "/sw.js", options: { updateViaCache: "none" } }]);
  });

  it("is still an app when the worker will not register: said once, and nothing waits", async () => {
    const { container, start } = harness(null);
    container.refuse = new Error("SecurityError");
    const watch = start();
    await registered();
    expect(warned).toHaveBeenCalledTimes(1);
    expect(watch.waiting()).toBe(false);
    expect(watch.apply()).toBe(false);
  });
});

describe("a newer build", () => {
  it("is reported once it has installed, on a page a worker already answers", async () => {
    const { container, onChange, start } = harness({});
    const watch = start();
    await registered();
    expect(watch.waiting()).toBe(false);

    const next = new FakeWorker("installing");
    container.registration.find(next);
    expect(watch.waiting()).toBe(false);
    next.become("installed");
    expect(watch.waiting()).toBe(true);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("is reported when it was already waiting as the page arrived", async () => {
    const { container, onChange, start } = harness({});
    container.registration.waiting = new FakeWorker("installed");
    const watch = start();
    await registered();
    expect(watch.waiting()).toBe(true);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("is not reported on a first visit: an install with no old build is not an update", async () => {
    const { container, onChange, reload, start } = harness(null);
    const watch = start();
    await registered();
    const first = new FakeWorker("installing");
    container.registration.find(first);
    first.become("installed");
    first.become("activating");
    container.takeOver();
    first.become("activated");

    expect(watch.waiting()).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
    // And being claimed is not a reason to reload: that would be a loop on every first visit.
    expect(reload).not.toHaveBeenCalled();
  });

  it("stays waiting whatever the page does — nothing but the press tells it to take over", async () => {
    const { container, reload, seen, tick, start } = harness({});
    const watch = start();
    await registered();
    const next = new FakeWorker("installing");
    container.registration.find(next);
    next.become("installed");

    tick(RECHECK_MS);
    seen();
    expect(next.posted).toEqual([]);
    expect(reload).not.toHaveBeenCalled();
    expect(watch.waiting()).toBe(true);
  });

  it("is told to take over by the press, and the page reloads once when it has", async () => {
    const { container, onChange, reload, start } = harness({});
    const watch = start();
    await registered();
    const next = new FakeWorker("installing");
    container.registration.find(next);
    next.become("installed");

    expect(watch.apply()).toBe(true);
    expect(next.posted).toEqual([{ kind: SKIP_WAITING }]);
    expect(reload).not.toHaveBeenCalled();

    next.become("activating");
    expect(watch.waiting()).toBe(false);
    expect(onChange).toHaveBeenCalledTimes(2);
    container.takeOver();
    container.takeOver();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("reloads a page first claimed and later updated: a first visit left open across a deploy", async () => {
    const { container, reload, start } = harness(null);
    const watch = start();
    await registered();
    // The first worker claims the page: no reload.
    container.takeOver();
    expect(reload).not.toHaveBeenCalled();

    const next = new FakeWorker("installing");
    container.registration.find(next);
    next.become("installed");
    expect(watch.waiting()).toBe(true);
    watch.apply();
    container.takeOver();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("does not reload a page that may not — a second tab, which is a boot screen with a link", async () => {
    const { container, reload, start } = harness({}, false);
    start();
    await registered();
    container.takeOver();
    expect(reload).not.toHaveBeenCalled();
  });

  it("stops being reported when a still newer build replaces it, which is then reported itself", async () => {
    const { container, onChange, start } = harness({});
    const watch = start();
    await registered();
    const second = new FakeWorker("installing");
    container.registration.find(second);
    second.become("installed");

    const third = new FakeWorker("installing");
    container.registration.find(third);
    second.become("redundant");
    expect(watch.waiting()).toBe(false);
    third.become("installed");
    expect(watch.waiting()).toBe(true);
    expect(onChange).toHaveBeenCalledTimes(3);

    // The press goes to the one that is waiting now.
    watch.apply();
    expect(second.posted).toEqual([]);
    expect(third.posted).toEqual([{ kind: SKIP_WAITING }]);
  });

  it("has nothing to apply when nothing waits", async () => {
    const { start } = harness({});
    const watch = start();
    await registered();
    expect(watch.apply()).toBe(false);
  });
});

describe("a page no worker controls", () => {
  it("asks the active worker to take it — a hard reload goes round the worker otherwise", async () => {
    const { container, reload, start } = harness(null);
    const active = new FakeWorker("activated");
    container.registration.active = active;
    start();
    await registered();
    expect(active.posted).toEqual([{ kind: CLAIM }]);

    // Taken: the page is controlled from here, and being claimed is still not a reload.
    container.takeOver();
    expect(reload).not.toHaveBeenCalled();
  });

  it("asks nothing of a worker that is still on its way in, which claims by itself", async () => {
    const { container, start } = harness(null);
    const arriving = new FakeWorker("activating");
    container.registration.active = arriving;
    start();
    await registered();
    expect(arriving.posted).toEqual([]);
  });

  it("asks nothing when the page is already a worker's", async () => {
    const { container, start } = harness({});
    const active = new FakeWorker("activated");
    container.registration.active = active;
    start();
    await registered();
    expect(active.posted).toEqual([]);
  });

  it("reports a build that was already waiting once the page has been taken", async () => {
    const { container, onChange, start } = harness(null);
    container.registration.active = new FakeWorker("activated");
    container.registration.waiting = new FakeWorker("installed");
    const watch = start();
    await registered();
    // Not yet: with no worker answering this page, nothing says there is an old build here.
    expect(watch.waiting()).toBe(false);

    container.takeOver();
    expect(watch.waiting()).toBe(true);
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});

describe("looking for a newer build", () => {
  it("asks again when the page is looked at, at most once an hour", async () => {
    const { container, seen, tick, start } = harness({});
    start();
    await registered();
    const { update } = container.registration;

    seen();
    expect(update).not.toHaveBeenCalled();
    tick(RECHECK_MS - 1);
    seen();
    expect(update).not.toHaveBeenCalled();
    tick(1);
    seen();
    seen();
    expect(update).toHaveBeenCalledTimes(1);
    tick(RECHECK_MS);
    seen();
    expect(update).toHaveBeenCalledTimes(2);
  });

  it("is not thrown off by a check that fails — offline is the ordinary case", async () => {
    const { container, seen, tick, start } = harness({});
    container.registration.update.mockRejectedValue(new TypeError("Failed to fetch"));
    start();
    await registered();
    tick(RECHECK_MS);
    expect(() => seen()).not.toThrow();
    await registered();
  });
});
