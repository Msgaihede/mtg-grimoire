import type { MockInstance } from "vitest";
// What the two Worker probes share (`relay-deploy-probe.ts`, `share-deploy-probe.ts`): how a
// probe becomes a request, how an answer is compared, and how many times the host is asked.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { answerOf, askAll, askUntil, problemsOf, report, requestOf } from "./deploy-probe.ts";

describe("requestOf", () => {
  it("builds a GET with the probe's headers, following no redirect", () => {
    const request = requestOf("https://h.example", {
      name: "n",
      path: "/g/abc/keys?device=d",
      headers: { authorization: "Bearer x" },
      status: 401,
    });
    expect(request.method).toBe("GET");
    expect(request.url).toBe("https://h.example/g/abc/keys?device=d");
    expect(request.headers.get("authorization")).toBe("Bearer x");
    expect(request.headers.get("cache-control")).toBe("no-cache");
    expect(request.redirect).toBe("manual");
  });

  it("sends a body as JSON", async () => {
    const request = requestOf("https://h.example", {
      name: "n",
      method: "POST",
      path: "/token",
      body: "{}",
      status: 400,
    });
    expect(request.method).toBe("POST");
    expect(request.headers.get("content-type")).toBe("application/json");
    expect(await request.text()).toBe("{}");
  });
});

describe("problemsOf", () => {
  const probe = { name: "the door", path: "/x", status: 401, says: "unauthorized" };
  const good = {
    status: 401,
    type: "application/json",
    body: '{"error":"unauthorized"}',
    allowOrigin: null,
  };

  it("finds none in the answer it expects", () => {
    expect(problemsOf(probe, good)).toEqual([]);
  });

  it("names the probe and the status of another answer", () => {
    expect(problemsOf(probe, { ...good, status: 429 })).toEqual([
      "the door: answered 429, not 401",
    ]);
  });

  it("says what a status is known to mean", () => {
    const meant = { ...probe, means: { 500: "the table is missing" } };
    expect(problemsOf(meant, { ...good, status: 500 })).toEqual([
      "the door: answered 500, not 401 — the table is missing",
    ]);
  });

  it("names a right status with the wrong words", () => {
    expect(problemsOf(probe, { ...good, body: "{}" })).toEqual([
      'the door: answered 401 without "unauthorized"',
    ]);
  });

  it("holds the content type when the probe names one", () => {
    const page = { name: "the page", path: "/s/x", status: 404, type: "text/html" };
    expect(problemsOf(page, { ...good, status: 404, type: "text/html; charset=utf-8" })).toEqual(
      [],
    );
    expect(problemsOf(page, { ...good, status: 404, type: "text/plain" })).toEqual([
      "the page: answered as text/plain, not text/html",
    ]);
  });

  it("holds the allowed origin only when the probe names one, absent included", () => {
    const from = { ...probe, allowOrigin: "https://app.example" };
    expect(problemsOf(from, { ...good, allowOrigin: "https://app.example" })).toEqual([]);
    expect(problemsOf(from, good)).toEqual([
      "the door: access-control-allow-origin is absent, not https://app.example",
    ]);
    const foreign = { ...probe, allowOrigin: null };
    expect(problemsOf(foreign, { ...good, allowOrigin: "https://evil.example" })).toEqual([
      "the door: access-control-allow-origin is https://evil.example, not absent",
    ]);
  });
});

describe("answerOf and askAll", () => {
  it("reads the status, the type, the body and the allowed origin", async () => {
    const response = new Response("hello", {
      status: 404,
      headers: { "content-type": "text/html", "access-control-allow-origin": "https://a.example" },
    });
    expect(await answerOf(response)).toEqual({
      status: 404,
      type: "text/html",
      body: "hello",
      allowOrigin: "https://a.example",
    });
  });

  it("asks every probe, in order, and gathers what is wrong", async () => {
    const seen: string[] = [];
    const send = (request: Request) => {
      seen.push(new URL(request.url).pathname);
      return Promise.resolve(new Response("", { status: 200 }));
    };
    const wrong = await askAll(
      "https://h.example",
      [
        { name: "a", path: "/a", status: 200 },
        { name: "b", path: "/b", status: 404 },
      ],
      send,
    );
    expect(seen).toEqual(["/a", "/b"]);
    expect(wrong).toEqual(["b: answered 200, not 404"]);
  });
});

describe("askUntil", () => {
  const quiet = { wait: 5, sleep: () => Promise.resolve(), log: () => {} };

  it("stops at the first attempt that finds nothing wrong", async () => {
    const answers = [["late"], ["late"], []];
    let slept = 0;
    const result = await askUntil(() => Promise.resolve(answers.shift()!), {
      ...quiet,
      attempts: 6,
      sleep: () => {
        slept += 1;
        return Promise.resolve();
      },
    });
    expect(result).toEqual({ wrong: [], asked: 3 });
    expect(slept).toBe(2);
  });

  it("gives up after its attempts, with the last attempt's problems", async () => {
    const result = await askUntil(() => Promise.resolve(["still wrong"]), {
      ...quiet,
      attempts: 3,
    });
    expect(result).toEqual({ wrong: ["still wrong"], asked: 3 });
  });

  it("reports a host that could not be asked, and asks again", async () => {
    let calls = 0;
    const result = await askUntil(
      () => {
        calls += 1;
        return calls === 1 ? Promise.reject(new Error("ECONNRESET")) : Promise.resolve([]);
      },
      { ...quiet, attempts: 2 },
    );
    expect(result).toEqual({ wrong: [], asked: 2 });
    const down = await askUntil(() => Promise.reject(new Error("ECONNRESET")), {
      ...quiet,
      attempts: 1,
    });
    expect(down.wrong).toEqual(["could not be asked: ECONNRESET"]);
  });

  it.each([
    ["zero", 0],
    ["not a number", Number.NaN],
    ["negative", -3],
    ["fractional", 0.5],
  ])("asks at least once when the attempts are %s", async (_, attempts) => {
    let calls = 0;
    const result = await askUntil(
      () => {
        calls += 1;
        return Promise.resolve(["still wrong"]);
      },
      { ...quiet, attempts },
    );
    expect(calls).toBe(1);
    expect(result).toEqual({ wrong: ["still wrong"], asked: 1 });
  });

  it("waits the default when the wait is not a number of milliseconds", async () => {
    const waited: number[] = [];
    await askUntil(() => Promise.resolve(["wrong"]), {
      attempts: 3,
      wait: Number.NaN,
      sleep: (ms) => {
        waited.push(ms);
        return Promise.resolve();
      },
      log: () => {},
    });
    expect(waited).toEqual([10_000, 10_000]);
  });
});

describe("report", () => {
  const heading = { passed: "serves this build", failed: "does not serve this build" };
  let summary: string | undefined;
  let logged: MockInstance<typeof console.log>;

  beforeEach(() => {
    summary = process.env.GITHUB_STEP_SUMMARY;
    delete process.env.GITHUB_STEP_SUMMARY;
    logged = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logged.mockRestore();
    if (summary === undefined) delete process.env.GITHUB_STEP_SUMMARY;
    else process.env.GITHUB_STEP_SUMMARY = summary;
  });

  it("passes with a host that was asked and found nothing wrong", () => {
    expect(report(heading, "all answered.", { wrong: [], asked: 2 })).toBe(0);
    expect(logged.mock.calls[0][0]).toContain("Asked 2 times: all answered.");
  });

  it("fails with what was wrong, in the singular for one attempt", () => {
    expect(
      report(heading, "all answered.", { wrong: ["a: answered 500, not 200"], asked: 1 }),
    ).toBe(1);
    const text = logged.mock.calls[0][0];
    expect(text).toContain("After 1 attempt:");
    expect(text).not.toContain("1 attempts");
    expect(text).toContain("- a: answered 500, not 200");
  });

  it("says attempts in the plural", () => {
    report(heading, "all answered.", { wrong: ["x"], asked: 6 });
    expect(logged.mock.calls[0][0]).toContain("After 6 attempts:");
  });

  it("fails a host that was never asked, whatever it found wrong", () => {
    expect(report(heading, "all answered.", { wrong: [], asked: 0 })).toBe(1);
    const text = logged.mock.calls[0][0];
    expect(text).toContain("### does not serve this build");
    expect(text).toContain("never asked");
  });
});
