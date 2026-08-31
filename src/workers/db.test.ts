import { describe, expect, it, vi } from "vitest";
import { once, runFeed } from "./db";
import { feedRefreshFor, type ToWorker } from "./protocol";

/**
 * `once` is what stops the Worker instantiating the wasm module twice, which is what killed
 * roughly two first runs in three until 2026-08-28. The failure it prevents is specifically
 * *concurrent* re-entry — two `postMessage`s landing before the first `await` resolves — so
 * the concurrent case is the one worth asserting. A test that only calls it twice in
 * sequence passes against the broken `if (!glue)` guard as well, and did.
 */
describe("once", () => {
  it("runs the work once for callers that overlap, and hands them all the same promise", async () => {
    let calls = 0;
    let release: (value: string) => void = () => {};
    const guarded = once(() => {
      calls += 1;
      return new Promise<string>((resolve) => {
        release = resolve;
      });
    });

    // Both callers arrive while the work is still in flight — the shape a Worker message
    // loop produces, and the shape the old guard could not see.
    const first = guarded();
    const second = guarded();
    expect(calls).toBe(1);

    release("ready");
    await expect(first).resolves.toBe("ready");
    await expect(second).resolves.toBe("ready");
    expect(await guarded()).toBe("ready");
    expect(calls).toBe(1);
  });

  it("does not run the work again after it failed", async () => {
    let calls = 0;
    const guarded = once(() => {
      calls += 1;
      return Promise.reject(new Error("no wasm here"));
    });

    // A retry would be a second instantiate of a module that may already be half-built,
    // which is the thing being prevented. The page's answer to a failed open is a reload.
    await expect(guarded()).rejects.toThrow("no wasm here");
    await expect(guarded()).rejects.toThrow("no wasm here");
    expect(calls).toBe(1);
  });
});

/**
 * The four refresh commands are downloads rather than queries, so they are
 * `#[wasm_bindgen]` exports and not entries in `web::route::COMMANDS`. What that leaves is a
 * mapping, and a mapping is exactly the kind of code where a mistake is a silent
 * `undefined` rather than a compile error: a `force` dropped on the way through is a Refresh
 * button that does nothing for six days out of seven, which nothing about looks like a bug.
 */
describe("the feed refresh mapping", () => {
  /**
   * The three ingests, **typed through `vi.fn<T>` rather than by naming the parameters**.
   *
   * A bare `vi.fn(async () => …)` types `mock.calls` as `[][]`, so every `calls[0][0]`
   * assertion below is a `TS2493` — invisible to vitest, which does not type-check, so the
   * suite goes green and `npm run build` is what finds it. Naming them instead
   * (`_force: boolean`) fixes the types and fails `no-unused-vars`, which does not read the
   * underscore convention here. The signature as a type argument satisfies both.
   */
  type Progress = (json: string) => void;
  const glue = () => ({
    ingest_combos: vi.fn<(force: boolean, onProgress: Progress) => Promise<string>>(async () =>
      JSON.stringify({ kind: "ok", result: { combos: 1 } }),
    ),
    ingest_tags: vi.fn<(dataset: string, force: boolean, onProgress: Progress) => Promise<string>>(
      async () => JSON.stringify({ kind: "ok", result: { tags: 2 } }),
    ),
    ingest_prices: vi.fn<(marketplace: string, onProgress: Progress) => Promise<string>>(async () =>
      JSON.stringify({ kind: "ok", result: { rowCount: 3 } }),
    ),
  });

  /** The full `Glue` is what `runFeed` takes; only the three ingests are ever reached. */
  const asGlue = (g: ReturnType<typeof glue>) => g as unknown as Parameters<typeof runFeed>[0];

  it("names the export and the arguments for each of the four commands", () => {
    expect(feedRefreshFor("combos_refresh", { force: true })).toEqual({
      feed: "combos",
      force: true,
    });
    expect(feedRefreshFor("oracle_tags_refresh", { force: false })).toEqual({
      feed: "tags",
      dataset: "oracle",
      force: false,
    });
    expect(feedRefreshFor("art_tags_refresh", { force: true })).toEqual({
      feed: "tags",
      dataset: "art",
      force: true,
    });
    expect(feedRefreshFor("marketplace_feed_refresh", { marketplace: "cardkingdom" })).toEqual({
      feed: "prices",
      marketplace: "cardkingdom",
    });
  });

  /**
   * Everything else must fall through to `web::route`. A map that claimed a query would send
   * it to an export that does not exist and the page would hang on the promise.
   */
  it("claims nothing but the four", () => {
    for (const command of [
      "combos_status",
      "search_cards",
      "marketplace_feed_status",
      "oracle_tags_status",
      "sync_run",
    ]) {
      expect(feedRefreshFor(command, {})).toBeUndefined();
    }
  });

  /**
   * **`force` is a boolean on the wire and `undefined` is not `true`.** `ipc.combosRefresh`
   * always sends one, but a caller that forgets must not turn a throttled refresh into an
   * unconditional 27.5 MB download on a metered link.
   */
  it("reads an absent or non-boolean force as false", () => {
    expect(feedRefreshFor("combos_refresh")).toEqual({ feed: "combos", force: false });
    expect(feedRefreshFor("combos_refresh", {})).toEqual({ feed: "combos", force: false });
    expect(feedRefreshFor("combos_refresh", { force: "yes" })).toEqual({
      feed: "combos",
      force: false,
    });
  });

  it("drives ingest_combos with the force flag it was given", async () => {
    const g = glue();
    const message: ToWorker = { kind: "feed-refresh", id: 7, feed: "combos", force: true };
    const answer = await runFeed(asGlue(g), message, () => {});

    expect(g.ingest_combos).toHaveBeenCalledOnce();
    expect(g.ingest_combos.mock.calls[0]?.[0]).toBe(true);
    expect(g.ingest_tags).not.toHaveBeenCalled();
    expect(g.ingest_prices).not.toHaveBeenCalled();
    expect(JSON.parse(answer)).toEqual({ kind: "ok", result: { combos: 1 } });
  });

  /**
   * The two taxonomies share one export, so the dataset name is the only thing telling them
   * apart — and getting it wrong replaces the oracle taxonomy with the art one, which is the
   * failure `tags::ingest_gz`'s `Untagged` refusal exists to catch on the Rust side.
   */
  it("passes the dataset name through for each taxonomy", async () => {
    const g = glue();
    await runFeed(
      asGlue(g),
      { kind: "feed-refresh", id: 1, feed: "tags", dataset: "art", force: false },
      () => {},
    );
    expect(g.ingest_tags.mock.calls[0]?.[0]).toBe("art");
    expect(g.ingest_tags.mock.calls[0]?.[1]).toBe(false);

    await runFeed(
      asGlue(g),
      { kind: "feed-refresh", id: 2, feed: "tags", dataset: "oracle", force: true },
      () => {},
    );
    expect(g.ingest_tags.mock.calls[1]?.[0]).toBe("oracle");
    expect(g.ingest_tags.mock.calls[1]?.[1]).toBe(true);
  });

  it("passes the marketplace id through to ingest_prices", async () => {
    const g = glue();
    await runFeed(
      asGlue(g),
      { kind: "feed-refresh", id: 3, feed: "prices", marketplace: "manapool" },
      () => {},
    );
    expect(g.ingest_prices.mock.calls[0]?.[0]).toBe("manapool");
  });

  /**
   * The progress callback is handed straight to the export, which is what lets Rust own the
   * event name. A `runFeed` that swallowed it would leave every progress line dead with the
   * refresh still working perfectly.
   */
  it("hands the progress callback to the export it drove", async () => {
    const seen: string[] = [];
    const g = glue();
    g.ingest_combos = vi.fn(async (_force: boolean, onProgress: Progress) => {
      onProgress(JSON.stringify({ event: "combos:progress", payload: { phase: "done" } }));
      return JSON.stringify({ kind: "ok", result: {} });
    });

    await runFeed(
      asGlue(g),
      { kind: "feed-refresh", id: 4, feed: "combos", force: false },
      (json) => seen.push(json),
    );

    expect(seen).toHaveLength(1);
    expect(JSON.parse(seen[0] ?? "null")).toEqual({
      event: "combos:progress",
      payload: { phase: "done" },
    });
  });
});
