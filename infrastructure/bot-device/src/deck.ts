/**
 * **`/deck`** — a deck list written by the app's own export writer
 * (`packages/ui/features/transfer/export/format.ts`, the golden-fenced one), so a list posted to
 * Discord is the same text the desktop's Export dialog writes for that format and its default
 * fields. The engine answers the cards already in `TransferCard`'s shape (`queries::deck_cards`).
 *
 * A list that fits a message is a code block; one that does not ({@link CONTENT_CHARS}) is a
 * text file attached to the message, as a `multipart/form-data` answer
 * (Discord's *Uploading Files*), so a hundred-card list is never cut.
 */
import { formatExport, omittedCount } from "@grimoire/ui/features/transfer/export/format";
import { isInArena } from "@grimoire/ui/features/transfer/export/arena";
import { defaultFields } from "@grimoire/ui/features/transfer/fields";
import type { TransferCard } from "@grimoire/ui/features/transfer/TransferCard";
import { CONTENT_CHARS, clip, escapeMarkdown, message, privately, type Reply } from "./render";
import type { DeckSummary } from "./types";

/** The four formats `/deck` offers — the front's `DECK_FORMATS`. `plain` when none is chosen. */
export const DECK_FORMATS = ["plain", "arena", "mtgo", "moxfield"] as const;
export type DeckFormat = (typeof DECK_FORMATS)[number];

const LABEL: Record<DeckFormat, string> = {
  plain: "Plain text",
  arena: "Arena",
  mtgo: "MTGO",
  moxfield: "Moxfield",
};

export function deckFormat(value: string | null): DeckFormat {
  return (DECK_FORMATS as readonly string[]).includes(value ?? "")
    ? (value as DeckFormat)
    : "plain";
}

/** A deck's list as the export writer writes it, and what it left out and why. */
export interface Written {
  text: string;
  /** Copies in switched-off piles that the format has nowhere to put (Arena, MTGO). */
  inactive: number;
  /** Copies not on Arena, for the Arena format — the Export dialog's own filter. */
  notInArena: number;
}

export function writeDeck(cards: readonly TransferCard[], format: DeckFormat): Written {
  const kept = format === "arena" ? cards.filter(isInArena) : cards;
  const notInArena = cards.length === kept.length ? 0 : count(cards) - count(kept);
  return {
    text: formatExport(kept, format, defaultFields(format, "deck")),
    inactive: omittedCount(kept, format),
    notInArena,
  };
}

function count(cards: readonly TransferCard[]): number {
  return cards.reduce((n, c) => n + c.quantity, 0);
}

/** A file name a deck can be posted under. */
export function fileName(deck: string): string {
  const slug = deck
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 60);
  return `${slug === "" ? "deck" : slug}.txt`;
}

function heading(deck: DeckSummary, format: DeckFormat, written: Written): string {
  const notes: string[] = [];
  if (written.inactive > 0) notes.push(`${written.inactive} in switched-off piles left out`);
  if (written.notInArena > 0) notes.push(`${written.notInArena} not on Arena left out`);
  const tail = notes.length === 0 ? "" : ` (${notes.join("; ")})`;
  return clip(`**${escapeMarkdown(deck.name)}** · ${LABEL[format]}${tail}`, 400);
}

/**
 * The answer to `/deck`: a code block, or — past {@link CONTENT_CHARS} — the list as a file.
 * `boundary` is the multipart boundary (random in production, fixed in a test).
 */
export function deckReply(
  deck: DeckSummary,
  cards: readonly TransferCard[],
  format: DeckFormat,
  boundary: string,
): Reply {
  const written = writeDeck(cards, format);
  if (written.text === "") {
    return privately(`**${escapeMarkdown(deck.name)}** has nothing to write as ${LABEL[format]}.`);
  }
  const head = heading(deck, format, written);
  const block = `${head}\n\`\`\`\n${written.text}\`\`\``;
  if (block.length <= CONTENT_CHARS) return message({ content: block }, false);
  return attachment(head, fileName(deck.name), written.text, boundary);
}

/** A message with one text file, as Discord takes an interaction response with an upload. */
export function attachment(content: string, file: string, text: string, boundary: string): Reply {
  const payload = JSON.stringify({
    type: 4,
    data: {
      content,
      allowed_mentions: { parse: [] },
      attachments: [{ id: 0, filename: file }],
    },
  });
  const crlf = "\r\n";
  const body =
    `--${boundary}${crlf}` +
    `Content-Disposition: form-data; name="payload_json"${crlf}` +
    `Content-Type: application/json${crlf}${crlf}` +
    `${payload}${crlf}` +
    `--${boundary}${crlf}` +
    `Content-Disposition: form-data; name="files[0]"; filename="${file}"${crlf}` +
    `Content-Type: text/plain; charset=utf-8${crlf}${crlf}` +
    `${text}${crlf}` +
    `--${boundary}--${crlf}`;
  return { status: 200, contentType: `multipart/form-data; boundary=${boundary}`, body };
}
