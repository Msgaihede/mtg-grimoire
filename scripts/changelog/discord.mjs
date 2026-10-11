// A published release, announced on Discord: its version, its address and its notes
// (`.github/workflows/release.yml`, `announce`).
//
//   DISCORD_WEBHOOK_URL=… VERSION=0.44.0 TAG=v0.44.0 REPO=owner/name \
//     node scripts/changelog/discord.mjs notes.md
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
// **Not idempotent.** A re-run posts the announcement again, and a failure part-way leaves the
// messages already posted; the log says how many.
//
// The cutting and the payloads are pure and `discord.test.mjs` holds them; `fetch` and `sleep`
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
  constructor(message, { status = null } = {}) {
    super(message);
    this.name = "DiscordError";
    this.status = status;
  }
}

/** The release's address on GitHub. */
export const releaseUrl = (repo, tag) => `https://github.com/${repo}/releases/tag/${tag}`;

/** The first lines of the first message: that there is a release, which, and where. */
export const headerFor = ({ version, url }) => `## MTG Grimoire ${version} is released\n${url}`;

/** The order `split` tries: paragraphs, lines, words. */
const SEPARATORS = ["\n\n", "\n", " "];

/** Cut through a word, never through a surrogate pair. */
function hardSplit(text, limit) {
  const chunks = [];
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
export function split(text, limit = LIMIT, level = 0) {
  if (text.length <= limit) return [text];
  const sep = SEPARATORS[level];
  if (sep === undefined) return hardSplit(text, limit);
  const chunks = [];
  let current = null;
  for (const part of text.split(sep)) {
    const joined = current === null ? part : current + sep + part;
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
    current = inner.at(-1);
  }
  if (current !== null) chunks.push(current);
  return chunks;
}

/**
 * Every message's `content`, in order: the header, then the notes, cut to fit. A heading is
 * joined to the paragraph under it first, so no message ends on a heading whose list is in the
 * next. Blank pieces are dropped: Discord refuses an empty message.
 */
export function messagesFor({ version, url, notes, limit = LIMIT }) {
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
export const payloadFor = (content) => ({
  content,
  allowed_mentions: { parse: [] },
  flags: SUPPRESS_EMBEDS,
});

/**
 * The webhook's address with `wait=true`, or a `DiscordError` that does not repeat it: the
 * address is the credential.
 */
export function webhookUrl(raw) {
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

/** How long a 429 asks to be waited, in milliseconds: the body's `retry_after`, else the header's. */
function waitOf(text, headers) {
  let seconds = Number.NaN;
  try {
    seconds = Number(JSON.parse(text).retry_after);
  } catch {
    // Not JSON; the header may still say.
  }
  if (!Number.isFinite(seconds)) seconds = Number(headers?.get?.("retry-after"));
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 1;
  return Math.min(Math.ceil(seconds * 1000), MAX_WAIT_MS);
}

/** Posts one message, waiting out a 429 up to `ATTEMPTS` times. Anything else not 2xx throws. */
export async function post(url, content, { fetch = globalThis.fetch, sleep } = {}) {
  for (let attempt = 1; ; attempt++) {
    const answer = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payloadFor(content)),
    });
    if (answer.ok) return;
    const text = await answer.text();
    if (answer.status === 429 && attempt < ATTEMPTS) {
      await sleep(waitOf(text, answer.headers));
      continue;
    }
    throw new DiscordError(`Discord answered ${answer.status}: ${text.slice(0, 500)}`, {
      status: answer.status,
    });
  }
}

/** Posts every message in order. Returns how many were posted; a failure names how many were. */
export async function announce(url, messages, { fetch, sleep, log = () => {} } = {}) {
  for (const [i, content] of messages.entries()) {
    try {
      await post(url, content, { fetch, sleep });
    } catch (error) {
      error.message += ` (message ${i + 1} of ${messages.length}; ${i} already posted)`;
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
      "usage: DISCORD_WEBHOOK_URL=… VERSION=… TAG=… REPO=… node scripts/changelog/discord.mjs <notes.md>",
    );
  }
  const url = webhookUrl(DISCORD_WEBHOOK_URL);
  const messages = messagesFor({
    version: VERSION,
    url: releaseUrl(REPO, TAG),
    notes: readFileSync(file, "utf8"),
  });
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const posted = await announce(url, messages, { sleep, log: (line) => console.log(line) });
  if (GITHUB_STEP_SUMMARY) {
    const noun = posted === 1 ? "message" : "messages";
    appendFileSync(GITHUB_STEP_SUMMARY, `Announced ${TAG} on Discord in ${posted} ${noun}.\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
