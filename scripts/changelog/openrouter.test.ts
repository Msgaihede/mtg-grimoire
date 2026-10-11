import type { CompletionFetch } from "./openrouter.ts";
import { describe, expect, it } from "vitest";
import {
  EFFORT,
  ENDPOINT,
  MAX_TOKENS,
  MODEL,
  OpenRouterError,
  WAITS_MS,
  complete,
  requestBody,
} from "./openrouter.ts";

const KEY = "sk-or-v1-not-a-real-key";
const MESSAGES = [{ role: "user", content: "hello" }];
const SCHEMA = { type: "object" };

const answer = (status: number, body: unknown) => ({
  status,
  ok: status >= 200 && status < 300,
  text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
});
const completion = (content: string, finish = "stop") => ({
  choices: [{ message: { content }, finish_reason: finish }],
  usage: { prompt_tokens: 10, completion_tokens: 5 },
});

/** A `fetch` that answers from a list, in order, and a `sleep` that only records. */
function scripted(...answers: (Awaited<ReturnType<CompletionFetch>> | Error)[]) {
  const calls: { url: string; init: Parameters<CompletionFetch>[1] }[] = [];
  const waits: number[] = [];
  return {
    calls,
    waits,
    fetch: async (url: string, init: Parameters<CompletionFetch>[1]) => {
      calls.push({ url, init });
      const next = answers.shift();
      if (next instanceof Error) throw next;
      if (next === undefined) throw new Error("No scripted HTTP answer remains");
      return next;
    },
    sleep: async (ms: number) => {
      waits.push(ms);
    },
  };
}
const ask = (io: ReturnType<typeof scripted>) =>
  complete({ key: KEY, messages: MESSAGES, schema: SCHEMA, fetch: io.fetch, sleep: io.sleep });

describe("requestBody", () => {
  it("asks Haiku 5.5 at medium effort for JSON in the schema, from a provider that honours both", () => {
    expect(MODEL).toBe("anthropic/claude-haiku-5.5");
    expect(EFFORT).toBe("medium");
    expect(requestBody(MESSAGES, SCHEMA)).toEqual({
      model: MODEL,
      messages: MESSAGES,
      max_tokens: MAX_TOKENS,
      reasoning: { effort: "medium", exclude: true },
      response_format: {
        type: "json_schema",
        json_schema: { name: "release_notes", strict: true, schema: SCHEMA },
      },
      provider: { require_parameters: true },
    });
  });
});

describe("complete", () => {
  it("posts once and answers the text and the usage", async () => {
    const io = scripted(answer(200, completion('{"a":1}')));
    expect(await ask(io)).toEqual({
      text: '{"a":1}',
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
    expect(io.calls).toHaveLength(1);
    expect(io.calls[0].url).toBe(ENDPOINT);
    expect(io.calls[0].init.method).toBe("POST");
    expect(io.calls[0].init.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(io.calls[0].init.body).model).toBe(MODEL);
  });

  it("waits and asks again after a 429", async () => {
    const io = scripted(
      answer(429, { error: { message: "slow down", code: 429 } }),
      answer(200, completion("{}")),
    );
    expect((await ask(io)).text).toBe("{}");
    expect(io.waits).toEqual([WAITS_MS[0]]);
  });

  it("asks again when the request never completes", async () => {
    const io = scripted(new Error("socket hang up"), answer(200, completion("{}")));
    expect((await ask(io)).text).toBe("{}");
    expect(io.calls).toHaveLength(2);
  });

  // The wait is in the body: the headers can arrive long before the completion does, so a
  // deadline or a dropped socket lands on `text()` and not on `fetch()`.
  it("asks again when the body never arrives", async () => {
    const stalled = {
      status: 200,
      ok: true,
      text: async () => {
        throw new Error("The operation was aborted due to timeout");
      },
    };
    const io = scripted(stalled, answer(200, completion("{}")));
    expect((await ask(io)).text).toBe("{}");
    expect(io.waits).toEqual([WAITS_MS[0]]);
  });

  it("gives up after its retries, with what the service said", async () => {
    const io = scripted(...Array.from({ length: 4 }, () => answer(503, "upstream unavailable")));
    await expect(ask(io)).rejects.toThrow("OpenRouter answered 503: upstream unavailable");
    expect(io.calls).toHaveLength(4);
    expect(io.waits).toEqual(WAITS_MS);
  });

  it("does not ask twice for an answer that will not change", async () => {
    const io = scripted(
      answer(401, { error: { message: "No auth credentials found", code: 401 } }),
    );
    const error = await ask(io).catch((e) => e);
    expect(error).toBeInstanceOf(OpenRouterError);
    expect(error.status).toBe(401);
    expect(error.message).toBe("OpenRouter answered 401: No auth credentials found");
    expect(io.calls).toHaveLength(1);
  });

  // Review Focus 4: three answers that are a 200 and are not an answer.
  it("reads an error inside a 200 as an error, and retries the kind that passes", async () => {
    const io = scripted(
      answer(200, { error: { message: "provider returned error", code: 502 } }),
      answer(200, completion("{}")),
    );
    expect((await ask(io)).text).toBe("{}");
    expect(io.waits).toEqual([WAITS_MS[0]]);
  });

  // The retry above passes with the body's `error` ignored, too: an ignored error is an answer
  // with no text, and that is asked again. This is the case only reading the error gets right.
  it("says what an error inside a 200 said, and does not ask again for one that will not change", async () => {
    const io = scripted(answer(200, { error: { message: "Insufficient credits", code: 402 } }));
    const error = await ask(io).catch((e) => e);
    expect(error).toBeInstanceOf(OpenRouterError);
    expect(error.status).toBe(402);
    expect(error.message).toBe("OpenRouter answered 402: Insufficient credits");
    expect(io.calls).toHaveLength(1);
  });

  it("refuses an answer that was cut off, without asking again", async () => {
    const io = scripted(answer(200, completion('{"highlights":[', "length")));
    await expect(ask(io)).rejects.toThrow(`the answer was cut off at ${MAX_TOKENS} tokens`);
    expect(io.calls).toHaveLength(1);
  });

  it("asks again for an answer with no text", async () => {
    const io = scripted(answer(200, completion("")), answer(200, completion("{}")));
    expect((await ask(io)).text).toBe("{}");
  });

  it("never puts the key in an error", async () => {
    const io = scripted(...Array.from({ length: 4 }, () => new Error("connect ETIMEDOUT")));
    const error = await ask(io).catch((e) => e);
    expect(error.message).toBe("the request did not complete: connect ETIMEDOUT");
    expect(error.message).not.toContain(KEY);
  });
});
