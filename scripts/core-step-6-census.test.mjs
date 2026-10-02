// No sync operation holds the write connection across a network request.
//
// The compiler holds this for every entry point that is checked as `Send` — a `MutexGuard` is
// not — and this holds the rest of it: a function in the sync client, the entitlement or
// pairing that takes `conn: &Connection` and awaits with it is one a caller can only run by
// blocking a thread on it with the connection in hand, which is the shape the light app's step
// 6 removed. A browser has no thread to block.
import { describe, expect, it } from "vitest";
import { census, FILES } from "./core-step-6-census.mjs";

describe("the sync client, the entitlement and pairing", () => {
  const files = census(".");

  it("reads every file it is about", () => {
    expect(files.map((f) => f.name)).toEqual(FILES);
    // Anti-vacuity: the files are there, and they are the async ones.
    expect(files.reduce((n, f) => n + f.fns.filter((x) => x.isAsync).length, 0)).toBeGreaterThan(40);
  });

  it("hold no connection across an await", () => {
    const held = files.flatMap((f) => f.held.map((x) => `${f.name}: ${x.name}`));
    expect(held).toEqual([]);
  });

  it("block no thread on a future", () => {
    const blocking = files.flatMap((f) => f.blocking.map((x) => `${f.name}: ${x.name}`));
    expect(blocking).toEqual([]);
  });
});
