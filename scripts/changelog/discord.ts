// A published release, announced on Discord: its version, its address and its notes
// (`.github/workflows/release.yml`, `announce`).
//
//   DISCORD_WEBHOOK_URL=… VERSION=0.44.0 TAG=v0.44.0 REPO=owner/name \
//     node scripts/changelog/discord.ts notes.md
//
// **`DISCORD_WEBHOOK_URL` holds one webhook or several** (2026-10-14), separated by `;` — one
// secret, so adding a channel changes no workflow. Every
// address is checked before anything is sent, and the announcement goes to each in turn; a
// webhook that fails does not keep the ones after it from being posted to, and the run still
// fails, naming which (by position — the address is the credential).
//
// **The notes are the release's body as published**, read by the step before this one — so the
// generated `changelog/<version>.md` when `publish` set it, and release-please's notes when it
// did not. Nothing is read from the repository but this file.
//
// **Discord takes 2000 characters a message**, so the text is cut into as many messages as it
// needs, posted in order: between paragraphs where it can, then between lines, then between
// words, and through a word only when one is longer than a message. A heading is kept with what
// follows it. Every message waits for Discord's answer (`?wait=true`), so they arrive in order and
// a refusal is an error here; a 429 is waited out as Discord asks.
//
// **Nothing in the notes can ping anyone** (`allowed_mentions` parses nothing — a pull request
// titled `@everyone` stays text), and no link unfolds into a preview (`SUPPRESS_EMBEDS`):
// release-please's notes carry a link per commit.
//
// **Not idempotent.** A re-run posts the announcement again, to every webhook, and a failure part-way leaves the
// messages already posted; the log says how many.
//
// The cutting and the payloads are pure and `discord.test.ts` holds them; `fetch` and `sleep`
// are passed in, so the test reaches nothing.
import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** Discord's limit on a message's `content`, in characters. */
export const LIMIT = 2000;
/** `MessageFlags.SUPPRESS_EMBEDS`: no link previews. */
export const SUPPRESS_EMBEDS = 1 << 2;
/** How many times one message is sent before a 429 stands as the answer. */
const ATTEMPTS = 5;
/** The longest a 429 is waited out, whatever Discord asks. */
const MAX_WAIT_MS = 60_000;
/** Discord's own hosts for a webhook; anything else is refused before a byte is sent. */
const HOSTS = new Set(["discord.com", "discordapp.com", "ptb.discord.com", "canary.discord.com"]);

export class DiscordError extends Error {
  declare status: number | null;

  constructor(message: string, { status = null }: { status?: number | null } = {}) {
    super(message);
    this.name = "DiscordError";
    this.status = status;
  }
}

/** The release's address on GitHub. */
export const releaseUrl = (repo: string, tag: string) =>
  `https://github.com/${repo}/releases/tag/${tag}`;

interface ReleaseHeader {
  version: string;
  url: string;
}

export interface DiscordPayload {
  content: string;
  allowed_mentions: { parse: never[] };
  flags: number;
}

export interface DiscordResponse {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
  headers: { get: (name: string) => string | null };
}

export type DiscordFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<DiscordResponse>;

interface DiscordIo {
  fetch?: DiscordFetch;
  sleep?: (ms: number) => Promise<void>;
}

/** The first lines of the first message: that there is a release, which, and where. */
export const headerFor = ({ version, url }: ReleaseHeader) =>
  `## MTG Grimoire ${version} is released\n${url}`;

/** The order `split` tries: paragraphs, lines, words. */
const SEPARATORS = ["\n\n", "\n", " "];

/** Cut through a word, never through a surrogate pair. */
function hardSplit(text: string, limit: number): string[] {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const high = rest.charCodeAt(limit - 1);
    const at = high >= 0xd800 && high <= 0xdbff ? limit - 1 : limit;
    chunks.push(rest.slice(0, at));
    rest = rest.slice(at);
  }
  return [...chunks, rest];
}

/**
 * `text` as pieces of at most `limit` characters each, cut at the widest separator that makes
 * them fit, and packed so that each piece holds as much as it can.
 */
export function split(text: string, limit = LIMIT, level = 0): string[] {
  if (text.length <= limit) return [text];
  const sep = SEPARATORS[level];
  if (sep === undefined) return hardSplit(text, limit);
  const chunks: string[] = [];
  let current: string | null = null;
  for (const part of text.split(sep)) {
    const joined: string = current === null ? part : current + sep + part;
    if (joined.length <= limit) {
      current = joined;
      continue;
    }
    if (current !== null) chunks.push(current);
    if (part.length <= limit) {
      current = part;
      continue;
    }
    const inner = split(part, limit, level + 1);
    chunks.push(...inner.slice(0, -1));
    current = inner.at(-1)!;
  }
  if (current !== null) chunks.push(current);
  return chunks;
}

/**
 * Every message's `content`, in order: the header, then the notes, cut to fit. A heading is
 * joined to the paragraph under it first, so no message ends on a heading whose list is in the
 * next. Blank pieces are dropped: Discord refuses an empty message.
 */
export function messagesFor({
  version,
  url,
  notes,
  limit = LIMIT,
}: ReleaseHeader & { notes: string; limit?: number }): string[] {
  const body = notes
    .replace(/\r\n/g, "\n")
    .replace(/^(#{1,6} [^\n]*)\n{2,}/gm, "$1\n")
    .trim();
  const text =
    body === "" ? headerFor({ version, url }) : `${headerFor({ version, url })}\n\n${body}`;
  return split(text, limit)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk !== "");
}

/** The JSON body of one message. */
export const payloadFor = (content: string): DiscordPayload => ({
  content,
  allowed_mentions: { parse: [] },
  flags: SUPPRESS_EMBEDS,
});

/**
 * The webhook's address with `wait=true`, or a `DiscordError` that does not repeat it: the
 * address is the credential.
 */
export function webhookUrl(raw: string): string {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new DiscordError("DISCORD_WEBHOOK_URL is not a URL.");
  }
  if (
    url.protocol !== "https:" ||
    !HOSTS.has(url.hostname) ||
    !url.pathname.startsWith("/api/webhooks/")
  ) {
    throw new DiscordError(
      "DISCORD_WEBHOOK_URL is not a Discord webhook (https://discord.com/api/webhooks/…).",
    );
  }
  url.searchParams.set("wait", "true");
  return url.href;
}

/** What separates one webhook from the next in `DISCORD_WEBHOOK_URL`. */
const DELIMITER = ";";

/**
 * Every webhook `raw` names, `;` between them, each through `webhookUrl`, in order, once each.
 * Whitespace around an address is dropped. A bad address is named by its position, never
 * repeated.
 */
export function webhookUrls(raw: string): string[] {
  const parts = raw
    .split(DELIMITER)
    .map((part) => part.trim())
    .filter((part) => part !== "");
  if (parts.length === 0) throw new DiscordError("DISCORD_WEBHOOK_URL holds no address.");
  const urls = parts.map((part, i) => {
    try {
      // A space or a comma is never in a webhook's address, only in a list using the wrong
      // separator — and `new URL` would take it, encoded, as one address.
      if (/[\s,]/.test(part)) {
        throw new DiscordError(
          "DISCORD_WEBHOOK_URL holds a space or a comma; separate webhooks with `;`.",
        );
      }
      return webhookUrl(part);
    } catch (error) {
      if (error instanceof Error && parts.length > 1) {
        error.message = `Address ${i + 1} of ${parts.length}: ${error.message}`;
      }
      throw error;
    }
  });
  return [...new Set(urls)];
}

/** How long a 429 asks to be waited, in milliseconds: the body's `retry_after`, else the header's. */
function waitOf(text: string, headers: DiscordResponse["headers"]): number {
  let seconds = Number.NaN;
  try {
    const body: unknown = JSON.parse(text);
    seconds = Number(
      typeof body === "object" && body !== null && "retry_after" in body
        ? body.retry_after
        : undefined,
    );
  } catch {
    // Not JSON; the header may still say.
  }
  if (!Number.isFinite(seconds)) seconds = Number(headers?.get?.("retry-after"));
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 1;
  return Math.min(Math.ceil(seconds * 1000), MAX_WAIT_MS);
}

/** Posts one message, waiting out a 429 up to `ATTEMPTS` times. Anything else not 2xx throws. */
export async function post(
  url: string,
  content: string,
  { fetch = globalThis.fetch, sleep }: DiscordIo = {},
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    const answer = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payloadFor(content)),
    });
    if (answer.ok) return;
    const text = await answer.text();
    if (answer.status === 429 && attempt < ATTEMPTS) {
      await sleep!(waitOf(text, answer.headers));
      continue;
    }
    throw new DiscordError(`Discord answered ${answer.status}: ${text.slice(0, 500)}`, {
      status: answer.status,
    });
  }
}

/** Posts every message in order. Returns how many were posted; a failure names how many were. */
export async function announce(
  url: string,
  messages: string[],
  { fetch, sleep, log = () => {} }: DiscordIo & { log?: (line: string) => void } = {},
): Promise<number> {
  for (const [i, content] of messages.entries()) {
    try {
      await post(url, content, { fetch, sleep });
    } catch (error) {
      if (error instanceof Error) {
        error.message += ` (message ${i + 1} of ${messages.length}; ${i} already posted)`;
      }
      throw error;
    }
    log(`posted message ${i + 1} of ${messages.length} (${content.length} characters)`);
  }
  return messages.length;
}

async function main() {
  const [file] = process.argv.slice(2);
  const { DISCORD_WEBHOOK_URL, VERSION, TAG, REPO, GITHUB_STEP_SUMMARY } = process.env;
  if (!file || !DISCORD_WEBHOOK_URL || !VERSION || !TAG || !REPO) {
    throw new Error(
      "usage: DISCORD_WEBHOOK_URL=… VERSION=… TAG=… REPO=… node scripts/changelog/discord.ts <notes.md>",
    );
  }
  const urls = webhookUrls(DISCORD_WEBHOOK_URL);
  const messages = messagesFor({
    version: VERSION,
    url: releaseUrl(REPO, TAG),
    notes: readFileSync(file, "utf8"),
  });
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  const noun = messages.length === 1 ? "message" : "messages";
  const failed: number[] = [];
  for (const [i, url] of urls.entries()) {
    const which = `webhook ${i + 1} of ${urls.length}`;
    try {
      await announce(url, messages, { sleep, log: (line) => console.log(`${which}: ${line}`) });
    } catch (error) {
      console.error(`${which}: ${error instanceof Error ? error.message : String(error)}`);
      failed.push(i + 1);
    }
  }
  if (GITHUB_STEP_SUMMARY) {
    const done = urls.length - failed.length;
    const hooks = urls.length === 1 ? "webhook" : "webhooks";
    let line = `Announced ${TAG} on Discord in ${messages.length} ${noun}, to ${done} of ${urls.length} ${hooks}.`;
    if (failed.length > 0) line += ` Failed: ${failed.map((n) => `webhook ${n}`).join(", ")}.`;
    appendFileSync(GITHUB_STEP_SUMMARY, `${line}\n`);
  }
  if (failed.length > 0) {
    throw new DiscordError(
      `Not announced to ${failed.length} of ${urls.length} webhooks (${failed.join(", ")}).`,
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
