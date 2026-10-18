import { imageOf, type Card, type CardFace } from "./scryfall";

/**
 * What a `/card-search` answer looks like: Discord's embed limits, markdown escaped, a card
 * drawn from Scryfall. Everything a reader's own data draws is the Durable Object's to write.
 *
 * **Every string a reader or Scryfall wrote is escaped before it is markdown**, so a name is
 * shown as it is spelled and never rendered. Mentions are handled by every message's
 * `allowed_mentions: { parse: [] }` (`interactions.ts`), so a name with `@everyone` in it pings
 * nobody.
 */

/** Discord's embed limits, the ones a message here can reach. */
export const EMBED = { title: 256, description: 4096, footer: 2048 } as const;

/**
 * `text` with every character Discord's markdown reads backslash-escaped, so it is shown as
 * spelled: emphasis, strike, code, spoilers, a masked link's brackets and a mention's `<`
 * anywhere, and a heading's, a list's and a quote's marker at the start of a line.
 */
export function escapeMarkdown(text: string): string {
  return text.replace(/[\\*_~`|[\]<>]/g, "\\$&").replace(/^(\s*)([#>+-])/gm, "$1\\$2");
}

/** `text` cut to `max` characters, with an ellipsis when it was cut. */
export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** One autocomplete choice, held to Discord's hundred characters on both sides. */
export function choice(name: string, value: string): { name: string; value: string } {
  return { name: truncate(name, 100), value: value.slice(0, 100) };
}

function faceText(face: CardFace | Card): string {
  const lines: string[] = [];
  if (face.type_line) lines.push(face.type_line);
  if (face.oracle_text) lines.push(face.oracle_text);
  if (face.power !== undefined && face.toughness !== undefined) {
    lines.push(`${face.power}/${face.toughness}`);
  } else if (face.loyalty !== undefined) {
    lines.push(`Loyalty: ${face.loyalty}`);
  }
  return escapeMarkdown(lines.join("\n"));
}

/** A card's mana cost, a double-faced card's two joined as Scryfall joins their names. */
function manaCost(card: Card): string {
  if (card.mana_cost) return card.mana_cost;
  return (card.card_faces ?? [])
    .map((face) => face.mana_cost ?? "")
    .filter(Boolean)
    .join(" // ");
}

/** The first USD price Scryfall has for the printing: non-foil, then foil, then etched. */
function price(card: Card): string | null {
  const prices = card.prices ?? {};
  const found = prices.usd ?? prices.usd_foil ?? prices.usd_etched ?? null;
  return found ? `$${found}` : null;
}

/**
 * A card from Scryfall: its name and cost, linked to its page; its type line and rules text
 * (each face of a double-faced card in turn, by name); its image; and its set and price.
 */
export function cardEmbed(card: Card): Record<string, unknown> {
  const cost = manaCost(card);
  const title = truncate(cost ? `${card.name} ${cost}` : card.name, EMBED.title);
  const faces = card.card_faces ?? [];
  const body =
    faces.length > 1 && !card.oracle_text
      ? faces
          .map((face) => {
            const head = face.mana_cost ? `${face.name} ${face.mana_cost}` : face.name;
            return `**${escapeMarkdown(head)}**\n${faceText(face)}`;
          })
          .join("\n\n")
      : faceText(card);
  const usd = price(card);
  const footer = `${card.set_name} (${card.set.toUpperCase()}) #${card.collector_number}${
    usd === null ? "" : ` · ${usd}`
  }`;
  const embed: Record<string, unknown> = {
    title,
    url: card.scryfall_uri,
    description: truncate(body, EMBED.description),
    footer: { text: truncate(footer, EMBED.footer) },
  };
  const image = imageOf(card);
  if (image !== null) embed.image = { url: image };
  return embed;
}
