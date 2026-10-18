/**
 * **What a reader sees**: the engine's rows (`types.ts`) as Discord interaction responses.
 *
 * TypeScript draws the conclusions; the engine supplies the facts. Every limit Discord sets is
 * kept here, and each one is a constant a test holds:
 *
 * | Limit | Discord's | Here |
 * | --- | --- | --- |
 * | An embed's description | 4 096 characters | {@link DESCRIPTION_CHARS}, with *and N more* inside it |
 * | An embed's title | 256 characters | {@link TITLE_CHARS} |
 * | A message's content | 2 000 characters | {@link CONTENT_CHARS}; a longer deck is a file |
 * | Autocomplete choices | 25, each name and value ≤ 100 characters | {@link MAX_CHOICES}, {@link CHOICE_CHARS} |
 */
import type { Choice, Holding, Line } from "./types";

/** An answer the front returns verbatim (`rpc.ts`'s `InteractionAnswer`). */
export interface Reply {
  status: number;
  contentType: string;
  body: string;
}

export const DESCRIPTION_CHARS = 4096;
export const TITLE_CHARS = 256;
export const CONTENT_CHARS = 2000;
export const MAX_CHOICES = 25;
export const CHOICE_CHARS = 100;

const PONG = 1;
const CHANNEL_MESSAGE = 4;
const AUTOCOMPLETE_RESULT = 8;
const EPHEMERAL = 64;
/** Nobody is pinged by anything the bot writes: a card or a folder can be called `@everyone`. */
const NO_MENTIONS = { parse: [] as string[] };
/** The embed's edge — the app's accent. */
const COLOR = 0x8a63d2;

function json(value: unknown, status = 200): Reply {
  return { status, contentType: "application/json", body: JSON.stringify(value) };
}

export function pong(): Reply {
  return json({ type: PONG });
}

/** A message in the channel, or — `ephemeral` — for the reader alone. */
export function message(data: Record<string, unknown>, ephemeral: boolean): Reply {
  return json({
    type: CHANNEL_MESSAGE,
    data: { ...data, allowed_mentions: NO_MENTIONS, ...(ephemeral ? { flags: EPHEMERAL } : {}) },
  });
}

/** A sentence for the reader alone. */
export function privately(content: string): Reply {
  return message({ content: clip(content, CONTENT_CHARS) }, true);
}

/** A refusal of the request itself (a bad signature, a body that is not an interaction). */
export function refused(status: number, error: string): Reply {
  return json({ error }, status);
}

/** Cut `text` to `max` characters (code points), never through one. */
export function clip(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : chars.slice(0, max).join("");
}

/** An autocomplete's answer: at most 25 choices, each name and value at most 100 characters,
 *  and none with an empty name (Discord refuses the whole answer for one). */
export function choices(list: readonly Choice[]): Reply {
  const kept = list
    .map((c) => ({ name: clip(c.name, CHOICE_CHARS), value: clip(c.value, CHOICE_CHARS) }))
    .filter((c) => c.name !== "" && c.value !== "")
    .slice(0, MAX_CHOICES);
  return json({ type: AUTOCOMPLETE_RESULT, data: { choices: kept } });
}

/** Markdown's inline characters, escaped — a folder called `*foil*` is a folder, not emphasis.
 *  A line never starts with what a reader typed, so `#` and `-` (block syntax) are left alone. */
export function escapeMarkdown(text: string): string {
  return text.replace(/([\\*_~`|>[\]])/g, "\\$1");
}

const FINISH: Record<string, string> = { foil: "Foil", etched: "Etched" };

/**
 * One line: `2× Commander 2021 (C21) #263 · Foil · Binder/Artifacts`. The regular finish says
 * nothing (it is what a card is); a wish for any printing says so; the root folder says nothing.
 */
export function lineText(line: Line): string {
  const parts: string[] = [];
  if (line.setCode === null) {
    parts.push("Any printing");
  } else {
    const set = line.setName ?? line.setCode.toUpperCase();
    const number = line.collectorNumber === null ? "" : ` #${line.collectorNumber}`;
    parts.push(
      `${escapeMarkdown(set)} (${escapeMarkdown(line.setCode.toUpperCase())})${escapeMarkdown(number)}`,
    );
  }
  const finish = line.finish === null ? undefined : FINISH[line.finish];
  if (finish !== undefined) parts.push(finish);
  if (line.folder !== null && line.folder !== "") parts.push(escapeMarkdown(line.folder));
  return `${line.quantity}× ${parts.join(" · ")}`;
}

/** `and N more`, for the lines a description had no room for. */
export function moreText(n: number): string {
  return `…and ${n} more`;
}

/**
 * The lines as a description inside {@link DESCRIPTION_CHARS}: as many as fit whole, then
 * *and N more* for every line left out — here, and by the engine's own bound (`holding.more`).
 */
export function description(lines: readonly string[], beyond: number): string {
  const kept: string[] = [];
  let used = 0;
  // Room for the tail line, whatever its number comes to.
  const reserve = moreText(lines.length + beyond).length + 1;
  for (const [at, line] of lines.entries()) {
    const cost = line.length + (kept.length === 0 ? 0 : 1);
    const last = at === lines.length - 1 && beyond === 0;
    if (used + cost + (last ? 0 : reserve) > DESCRIPTION_CHARS) break;
    kept.push(line);
    used += cost;
  }
  const left = lines.length - kept.length + beyond;
  if (left > 0) kept.push(moreText(left));
  return kept.join("\n");
}

/** Where a holding was found, for the footer. */
export type Place = "collection" | "wishlist";

/** The public embed for one card: its picture, every line held, and how many copies. */
export function holdingEmbed(place: Place, holding: Holding): Record<string, unknown> {
  const copies = holding.total === 1 ? "copy" : "copies";
  const where = place === "collection" ? "in the collection" : "on the wishlist";
  return {
    title: clip(holding.name, TITLE_CHARS),
    color: COLOR,
    description: description(holding.lines.map(lineText), holding.more),
    ...(holding.image === null ? {} : { thumbnail: { url: holding.image } }),
    footer: {
      text: `${holding.total} ${copies} ${where}${holding.typeLine === null ? "" : ` · ${holding.typeLine}`}`,
    },
  };
}

/** `/collection search` or `/wishlist search`, answered. */
export function holdingReply(place: Place, typed: string, holding: Holding | null): Reply {
  if (holding === null) {
    const list = place === "collection" ? "your collection" : "your wishlist";
    return privately(`**${escapeMarkdown(typed.trim())}** is not in ${list}.`);
  }
  return message({ embeds: [holdingEmbed(place, holding)] }, false);
}
