import { describe, expect, it } from "vitest";
import {
  DiscordError,
  LIMIT,
  SUPPRESS_EMBEDS,
  announce,
  headerFor,
  messagesFor,
  payloadFor,
  post,
  releaseUrl,
  split,
  webhookUrl,
  webhookUrls,
} from "./discord.ts";
import type { DiscordFetch, DiscordPayload, DiscordResponse } from "./discord.ts";

const FILES = import.meta.glob<string>("/changelog/*.md", {
  query: "?raw",
  import: "default",
  eager: true,
});
const RELEASE = releaseUrl("Msgaihede/mtg-grimoire", "v0.44.0");
const HOOK = "https://discord.com/api/webhooks/123/not-a-real-token";

const answer = (
  status: number,
  body: string | Record<string, unknown> = "",
  headers: Record<string, string> = {},
): DiscordResponse => ({
  status,
  ok: status >= 200 && status < 300,
  text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  headers: { get: (name) => headers[name.toLowerCase()] ?? null },
});

/** A `fetch` that answers from a list, in order, and a `sleep` that only records. */
function scripted(...answers: DiscordResponse[]) {
  const calls: { url: string; body: DiscordPayload }[] = [];
  const waits: number[] = [];
  return {
    calls,
    waits,
    fetch: (async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) as DiscordPayload });
      return answers.shift() ?? answer(204);
    }) satisfies DiscordFetch,
    sleep: async (ms: number) => {
      waits.push(ms);
    },
  };
}

describe("split", () => {
  it("leaves a text that fits alone", () => {
    expect(split("short", 10)).toEqual(["short"]);
  });

  it("cuts between paragraphs first, and packs as many as fit", () => {
    expect(split("aaa\n\nbbb\n\nccc", 8)).toEqual(["aaa\n\nbbb", "ccc"]);
  });

  it("cuts a paragraph too long for one message between its lines", () => {
    expect(split("x\n\nl1 aa\nl2 bb\nl3 cc", 12)).toEqual(["x", "l1 aa\nl2 bb", "l3 cc"]);
  });

  it("cuts a line between words, and a word only when it is longer than a message", () => {
    expect(split("one two three", 7)).toEqual(["one two", "three"]);
    expect(split("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
  });

  it("never cuts through a surrogate pair", () => {
    const chunks = split("abc😀def", 4);
    expect(chunks.join("")).toBe("abc😀def");
    expect(chunks[0]).toBe("abc");
  });

  it("keeps every character, and every piece within the limit", () => {
    const text = Array.from(
      { length: 400 },
      (_, i) => `- item ${i} ${"word ".repeat(i % 13)}`,
    ).join("\n");
    const chunks = split(text, 300);
    expect(chunks.every((c) => c.length <= 300)).toBe(true);
    expect(chunks.join("\n")).toBe(text);
  });
});

describe("messagesFor", () => {
  it("opens with the version and the release's address", () => {
    const [first] = messagesFor({ version: "0.44.0", url: RELEASE, notes: "### New\n\n- a thing" });
    expect(first).toBe(
      "## MTG Grimoire 0.44.0 is released\nhttps://github.com/Msgaihede/mtg-grimoire/releases/tag/v0.44.0\n\n### New\n- a thing",
    );
  });

  it("is the header alone when the notes are empty", () => {
    expect(messagesFor({ version: "1.0.0", url: RELEASE, notes: " \n" })).toEqual([
      headerFor({ version: "1.0.0", url: RELEASE }),
    ]);
  });

  it("keeps a heading with the list under it when the notes run past one message", () => {
    const list = (n: number) => Array.from({ length: n }, (_, i) => `- change ${i}`).join("\n");
    const notes = `### New\n\n${list(5)}\n\n### Fixed\n\n${list(5)}`;
    const messages = messagesFor({ version: "0.1.0", url: RELEASE, notes, limit: 160 });
    expect(messages.length).toBeGreaterThan(1);
    for (const message of messages) {
      expect(message.length).toBeLessThanOrEqual(160);
      expect(message).not.toMatch(/#{3} \w+$/);
    }
    expect(messages.some((m) => m.startsWith("### Fixed\n- change 0"))).toBe(true);
  });

  it("fits every release's notes in messages Discord takes, and loses none of the text", () => {
    expect(Object.keys(FILES).length).toBeGreaterThanOrEqual(48);
    for (const [path, notes] of Object.entries(FILES)) {
      const name = path.slice("/changelog/".length);
      const messages = messagesFor({ version: name.replace(/\.md$/, ""), url: RELEASE, notes });
      expect(
        messages.every((m) => m.length > 0 && m.length <= LIMIT),
        name,
      ).toBe(true);
      // Only whitespace moves: the words, in order, are the header's and then the notes'.
      const words = (text: string) => text.split(/\s+/).filter(Boolean).join(" ");
      const header = headerFor({ version: name.replace(/\.md$/, ""), url: RELEASE });
      expect(words(messages.join("\n")), name).toBe(words(`${header}\n${notes}`));
    }
  });
});

describe("payloadFor", () => {
  it("pings nobody and unfolds no link", () => {
    expect(payloadFor("@everyone hi")).toEqual({
      content: "@everyone hi",
      allowed_mentions: { parse: [] },
      flags: SUPPRESS_EMBEDS,
    });
    expect(SUPPRESS_EMBEDS).toBe(4);
  });
});

describe("webhookUrl", () => {
  it("asks Discord to answer each message, and keeps a thread the address names", () => {
    expect(webhookUrl(HOOK)).toBe(`${HOOK}?wait=true`);
    expect(webhookUrl(`${HOOK}?thread_id=9`)).toBe(`${HOOK}?thread_id=9&wait=true`);
  });

  it("refuses anything that is not a Discord webhook, without repeating it", () => {
    for (const raw of [
      "nope",
      "http://discord.com/api/webhooks/1/x",
      "https://example.com/api/webhooks/1/secret",
      "https://discord.com/channels/1",
    ]) {
      expect(() => webhookUrl(raw)).toThrow(DiscordError);
      try {
        webhookUrl(raw);
      } catch (error) {
        expect(error).toBeInstanceOf(DiscordError);
        if (error instanceof Error) expect(error.message).not.toContain("secret");
      }
    }
  });
});

describe("webhookUrls", () => {
  const OTHER = "https://discord.com/api/webhooks/2/other";

  it("reads one address or several, separated by semicolons, whitespace around each dropped", () => {
    expect(webhookUrls(`${HOOK}\n`)).toEqual([`${HOOK}?wait=true`]);
    for (const raw of [`${HOOK};${OTHER}`, ` ${HOOK} ;\n${OTHER};`]) {
      expect(webhookUrls(raw), raw).toEqual([`${HOOK}?wait=true`, `${OTHER}?wait=true`]);
    }
  });

  it("splits on nothing but a semicolon", () => {
    for (const raw of [`${HOOK} ${OTHER}`, `${HOOK},${OTHER}`, `${HOOK}\n${OTHER}`]) {
      expect(() => webhookUrls(raw), raw).toThrow(/separate webhooks with `;`/);
    }
  });

  it("posts to a webhook named twice once", () => {
    expect(webhookUrls(`${HOOK};${HOOK}`)).toEqual([`${HOOK}?wait=true`]);
  });

  it("refuses an empty list, and names a bad address by position without repeating it", () => {
    expect(() => webhookUrls(" ; ;")).toThrow(DiscordError);
    expect(() => webhookUrls(`${HOOK};https://example.com/api/webhooks/1/secret`)).toThrow(
      /^Address 2 of 2: DISCORD_WEBHOOK_URL is not a Discord webhook/,
    );
    try {
      webhookUrls(`${HOOK};https://example.com/api/webhooks/1/secret`);
    } catch (error) {
      if (error instanceof Error) expect(error.message).not.toContain("secret");
    }
  });
});

describe("post", () => {
  it("sends one message", async () => {
    const io = scripted(answer(200, { id: "1" }));
    await post(HOOK, "hello", io);
    expect(io.calls).toEqual([{ url: HOOK, body: payloadFor("hello") }]);
    expect(io.waits).toEqual([]);
  });

  it("waits out a 429 as Discord asks, then sends again", async () => {
    const io = scripted(
      answer(429, { retry_after: 1.5 }),
      answer(429, "", { "retry-after": "2" }),
      answer(200),
    );
    await post(HOOK, "hello", io);
    expect(io.calls).toHaveLength(3);
    expect(io.waits).toEqual([1500, 2000]);
  });

  it("gives up on a 429 after five tries, and on any other refusal at once", async () => {
    const limited = scripted(...Array.from({ length: 5 }, () => answer(429, { retry_after: 0 })));
    await expect(post(HOOK, "hello", limited)).rejects.toMatchObject({ status: 429 });
    expect(limited.calls).toHaveLength(5);

    const refused = scripted(answer(400, { message: "Cannot send an empty message" }));
    await expect(post(HOOK, "", refused)).rejects.toThrow(/Discord answered 400: .*empty message/);
    expect(refused.calls).toHaveLength(1);
  });
});

describe("announce", () => {
  it("posts every message in order", async () => {
    const io = scripted();
    const lines: string[] = [];
    expect(await announce(HOOK, ["a", "b", "c"], { ...io, log: (l) => lines.push(l) })).toBe(3);
    expect(io.calls.map((c) => c.body.content)).toEqual(["a", "b", "c"]);
    expect(lines).toHaveLength(3);
  });

  it("stops at the first refusal and says how many were already posted", async () => {
    const io = scripted(answer(204), answer(500, "down"));
    await expect(announce(HOOK, ["a", "b", "c"], io)).rejects.toThrow(
      "Discord answered 500: down (message 2 of 3; 1 already posted)",
    );
    expect(io.calls).toHaveLength(2);
  });
});
