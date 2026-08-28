import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useServiceWorker } from "@/pwa/useServiceWorker";

vi.mock("@/pwa/target", () => ({ isWebTarget: () => true }));

/** A `ServiceWorker` with just the two members the hook reads and writes. */
function fakeWorker(state = "installed") {
  const listeners: (() => void)[] = [];
  return {
    state,
    postMessage: vi.fn(),
    addEventListener: (_: string, fn: () => void) => listeners.push(fn),
    /** Move to `state` and fire `statechange`, the way a browser would. */
    become(next: string) {
      this.state = next;
      for (const fn of listeners) fn();
    },
  };
}

function fakeContainer({ controller = null as unknown, waiting = null as unknown } = {}) {
  const regListeners: Record<string, (() => void)[]> = {};
  const containerListeners: Record<string, (() => void)[]> = {};
  const registration = {
    waiting,
    installing: null as unknown,
    update: vi.fn(() => Promise.resolve()),
    addEventListener: (type: string, fn: () => void) => (regListeners[type] ??= []).push(fn),
    fire: (type: string) => (regListeners[type] ?? []).forEach((fn) => fn()),
  };
  return {
    controller,
    register: vi.fn(() => Promise.resolve(registration)),
    addEventListener: (type: string, fn: () => void) => (containerListeners[type] ??= []).push(fn),
    /**
     * Not in the plan's fake, and the hook cannot be unmounted without it: the effect's
     * cleanup removes the `controllerchange` listener it added, and Testing Library unmounts
     * every rendered hook after each test. Without this the whole file dies in `afterEach`
     * with "container.removeEventListener is not a function".
     */
    removeEventListener: (type: string, fn: () => void) => {
      containerListeners[type] = (containerListeners[type] ?? []).filter((f) => f !== fn);
    },
    fire: (type: string) => (containerListeners[type] ?? []).forEach((fn) => fn()),
    registration,
  };
}

function install(container: unknown) {
  Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: container });
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  // `configurable: true` above is what makes this possible; without the delete the next test
  // file in the same worker inherits a navigator with a fake service worker on it.
  Reflect.deleteProperty(navigator, "serviceWorker");
});

describe("the service worker registration", () => {
  it("says nothing is ready on a first install", async () => {
    const container = fakeContainer({ controller: null });
    install(container);
    const { result } = renderHook(() => useServiceWorker());
    await waitFor(() => expect(container.register).toHaveBeenCalledWith("/sw.js"));
    expect(result.current.updateReady).toBe(false);
  });

  it("finds a worker that was already waiting when the page loaded", async () => {
    const waiting = fakeWorker();
    install(fakeContainer({ controller: {}, waiting }));
    const { result } = renderHook(() => useServiceWorker());
    await waitFor(() => expect(result.current.updateReady).toBe(true));
  });

  it("finds one that finishes installing while the page is open", async () => {
    const container = fakeContainer({ controller: {} });
    install(container);
    const { result } = renderHook(() => useServiceWorker());
    await waitFor(() => expect(container.register).toHaveBeenCalled());

    const installing = fakeWorker("installing");
    container.registration.installing = installing;
    act(() => container.registration.fire("updatefound"));
    expect(result.current.updateReady).toBe(false);
    act(() => installing.become("installed"));
    await waitFor(() => expect(result.current.updateReady).toBe(true));
  });

  /**
   * The first install also finishes with `state === "installed"` — and there is no old build to
   * replace, so calling that "a new version is ready" would put a bar in front of a reader who
   * has been in the app for four seconds. `controller === null` is what tells the two apart.
   */
  it("does not call a first install an update", async () => {
    const container = fakeContainer({ controller: null });
    install(container);
    const { result } = renderHook(() => useServiceWorker());
    await waitFor(() => expect(container.register).toHaveBeenCalled());

    const installing = fakeWorker("installing");
    container.registration.installing = installing;
    act(() => container.registration.fire("updatefound"));
    act(() => installing.become("installed"));
    expect(result.current.updateReady).toBe(false);
  });
});

describe("applying an update", () => {
  it("tells the waiting worker to take over, and reloads when it has", async () => {
    const reload = vi.fn();
    const waiting = fakeWorker();
    const container = fakeContainer({ controller: {}, waiting });
    install(container);
    const { result } = renderHook(() => useServiceWorker({ reload }));
    await waitFor(() => expect(result.current.updateReady).toBe(true));

    act(() => result.current.applyUpdate());
    expect(waiting.postMessage).toHaveBeenCalledWith({ type: "SKIP_WAITING" });
    expect(reload).not.toHaveBeenCalled();

    act(() => container.fire("controllerchange"));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("reloads once, however many times the controller changes", async () => {
    const reload = vi.fn();
    const container = fakeContainer({ controller: {}, waiting: fakeWorker() });
    install(container);
    const { result } = renderHook(() => useServiceWorker({ reload }));
    await waitFor(() => expect(result.current.updateReady).toBe(true));
    act(() => result.current.applyUpdate());
    act(() => container.fire("controllerchange"));
    act(() => container.fire("controllerchange"));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  /**
   * `clients.claim()` runs on **every** activation, first install included, and it fires
   * `controllerchange` on a page that was not controlled. Reloading for that is the classic
   * service-worker reload loop: claim, reload, claim, reload.
   */
  it("does not reload when the first worker claims an uncontrolled page", async () => {
    const reload = vi.fn();
    const container = fakeContainer({ controller: null });
    install(container);
    renderHook(() => useServiceWorker({ reload }));
    await waitFor(() => expect(container.register).toHaveBeenCalled());
    act(() => container.fire("controllerchange"));
    expect(reload).not.toHaveBeenCalled();
  });
});

describe("on a build that is not the web one", () => {
  it("registers nothing at all", async () => {
    vi.resetModules();
    vi.doMock("@/pwa/target", () => ({ isWebTarget: () => false }));
    const { useServiceWorker: desktop } = await import("@/pwa/useServiceWorker");
    const container = fakeContainer();
    install(container);
    renderHook(() => desktop());
    expect(container.register).not.toHaveBeenCalled();
  });
});
