export interface Message {
  role: string;
  content: string;
}
export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
}
interface CompletionResponse {
  error?: { code?: unknown; message?: string };
  choices?: { finish_reason?: string; message?: { content?: unknown } }[];
  usage?: Usage;
}
export type CompletionFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{ status: number; ok: boolean; text(): Promise<string> }>;
// One request to OpenRouter, and the answer's text
// (docs/superpowers/specs/2026-10-11-generated-release-notes-design.md, §5 "Write").
//
// **Plain `fetch`, not the `@openrouter/agent` SDK**, on purpose: the job that holds the key
// installs nothing (`.github/workflows/release.yml`, `changelog-write`), and one request with no
// tools and no stream is what the SDK would be wrapping.
//
// **What the request pins**: the model, medium reasoning effort, a strict JSON schema for the
// answer, and `require_parameters` so a provider that would ignore the schema or the effort is
// never chosen. Reasoning tokens count against `max_tokens` — at medium, about half of it.
//
// **Three things are a 200 and are not an answer**: an `error` object in the body, a text that
// was cut off (`finish_reason: "length"`), and no text at all. Each is an error here.
//
// `fetch` and `sleep` are passed in, so `openrouter.test.ts` reaches nothing.

export const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
export const MODEL = "anthropic/claude-haiku-5.5";
export const EFFORT = "medium";
/**
 * For reasoning and the answer together; at medium effort reasoning may take about half. Sized
 * for the first release, 0.2.0: 163 direct commits, every one of which the answer must name.
 */
export const MAX_TOKENS = 32_000;
/** How long one request may take, connection to last byte — most of it waiting for the body. */
const TIMEOUT_MS = 300_000;
/** The wait before each retry; three retries, then the error stands. */
export const WAITS_MS = [2_000, 8_000, 30_000];

export class OpenRouterError extends Error {
  declare status: number | null;
  declare retry: boolean;
  constructor(
    message: string,
    { status = null, retry = false }: { status?: number | null; retry?: boolean } = {},
  ) {
    super(message);
    this.name = "OpenRouterError";
    this.status = status;
    this.retry = retry;
  }
}

/** The request's JSON body for `messages`, with the answer held to `schema`. */
export function requestBody(messages: Message[], schema: object) {
  return {
    model: MODEL,
    messages,
    max_tokens: MAX_TOKENS,
    reasoning: { effort: EFFORT, exclude: true },
    response_format: {
      type: "json_schema",
      json_schema: { name: "release_notes", strict: true, schema },
    },
    provider: { require_parameters: true },
  };
}

async function once({ key, body, fetch }: { key: string; body: object; fetch: CompletionFetch }) {
  let response;
  let text;
  try {
    response = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        "x-title": "MTG Grimoire release notes",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    // **Inside the `try`**: the headers can arrive long before the completion does, so the
    // deadline and a dropped socket land here, on the body, far more often than on `fetch`.
    text = await response.text();
  } catch (error) {
    throw new OpenRouterError(
      `the request did not complete: ${error instanceof Error ? error.message : String(error)}`,
      { retry: true },
    );
  }

  let json: CompletionResponse | null = null;
  try {
    json = JSON.parse(text) as CompletionResponse;
  } catch {
    // Not JSON: an error page. Answered below, by status.
  }
  if (!response.ok || json?.error) {
    const status = response.ok ? Number(json?.error?.code) || null : response.status;
    const said = json?.error?.message ?? text.slice(0, 200);
    throw new OpenRouterError(`OpenRouter answered ${status ?? "an error"}: ${said}`, {
      status,
      retry: status === 408 || status === 429 || (status !== null && status >= 500),
    });
  }

  const choice = json?.choices?.[0];
  if (choice?.finish_reason === "length") {
    throw new OpenRouterError(`the answer was cut off at ${MAX_TOKENS} tokens`);
  }
  const content = choice?.message?.content;
  if (typeof content !== "string" || content.trim() === "") {
    throw new OpenRouterError("OpenRouter answered with no text", { retry: true });
  }
  return { text: content, usage: json?.usage ?? null };
}

/**
 * The model's answer to `messages`: `{ text, usage }`.
 *
 * `fetch` is the global one's shape; `sleep(ms)` waits. A 408, a 429, a 5xx, a request that
 * never completed and an empty answer are each asked again, {@link WAITS_MS} apart.
 */
export async function complete({
  key,
  messages,
  schema,
  fetch,
  sleep,
}: {
  key: string;
  messages: Message[];
  schema: object;
  fetch: CompletionFetch;
  sleep: (ms: number) => Promise<void>;
}) {
  const body = requestBody(messages, schema);
  for (let attempt = 0; ; attempt++) {
    try {
      return await once({ key, body, fetch });
    } catch (error) {
      const again = error instanceof OpenRouterError && error.retry && attempt < WAITS_MS.length;
      if (!again) throw error;
      await sleep(WAITS_MS[attempt]);
    }
  }
}
