import { ADD, CARD_SEARCH } from "./commands";
import { json, refusal, type Env } from "./env";
import { cardEmbed, choice, escapeMarkdown } from "./format";
import { botOf, linkOf } from "./link";
import { autocomplete, fuzzy, printings } from "./scryfall";
import { verified, type Signed } from "./verify";

/**
 * `POST /interactions`: everything Discord sends — a ping, a command, a keystroke in an option
 * that autocompletes, a press on a component — verified first (`verify.ts`), then answered in the
 * one response Discord waits three seconds for (the design, §13.1 and §13.7).
 *
 * **Three kinds of answer, and only one of them reads anybody's data**:
 *
 * - **`/card-search` and its autocomplete are answered here**, from Scryfall: the command reads
 *   no reader's data, so it needs no link and no Durable Object. So are **the `card` and `set`
 *   completions of `/collection add` and `/wishlist add`** (the design, §14.4): a card's name and
 *   its printings are Scryfall's, whoever is typing. The add's `folder` is the reader's, and goes
 *   to their Durable Object like everything else.
 * - **A reader with no link** is told, privately, where to switch the integration on.
 * - **Everything else is the link's Durable Object's** — a command, an autocomplete, a press on an
 *   add's Confirm or Cancel button: the interaction is handed to it exactly as Discord signed it —
 *   the body's text and the two signature headers — and its answer is returned verbatim. It verifies the signature again itself, holds the reader's data, and
 *   decides every word of the reply. This Worker never sees a collection.
 *
 * **Who is asking is Discord's word, and only Discord's**: the user id comes from the signed body
 * (`user` in a DM, `member.user` in a server), and it is what the link is found by.
 */

// Discord's numbers, the ones this Worker reads or sends.
const PING = 1;
const APPLICATION_COMMAND = 2;
const AUTOCOMPLETE = 4;

const PONG = 1;
const CHANNEL_MESSAGE = 4;
const AUTOCOMPLETE_RESULT = 8;

const EPHEMERAL = 64;
const NO_MENTIONS = { parse: [] as string[] };

interface Option {
  name: string;
  type: number;
  value?: unknown;
  options?: Option[];
  focused?: boolean;
}

interface Interaction {
  type: number;
  data?: { name?: unknown; options?: Option[] };
  user?: { id?: unknown };
  member?: { user?: { id?: unknown } };
}

function reply(data: Record<string, unknown>, ephemeral: boolean): Response {
  return json({
    type: CHANNEL_MESSAGE,
    data: { ...data, allowed_mentions: NO_MENTIONS, ...(ephemeral ? { flags: EPHEMERAL } : {}) },
  });
}

/** A sentence for the reader alone. */
export function privately(content: string): Response {
  return reply({ content }, true);
}

function choices(list: { name: string; value: string }[]): Response {
  return json({ type: AUTOCOMPLETE_RESULT, data: { choices: list.slice(0, 25) } });
}

/** What a reader with no link is told: where the switch is (the design, §13.7). */
export const NOT_LINKED =
  "Your Discord account is not linked to MTG Grimoire. Switch on Discord in MTG Grimoire → Settings → Integrations.";

/** What a reader is told when their bot's Durable Object did not answer. */
export const BOT_DOWN =
  "MTG Grimoire's Discord bot could not answer just now. Try again in a moment.";

const SCRYFALL_DOWN = "Scryfall could not be reached just now. Try again in a moment.";

/** The Discord user an interaction came from: `user` in a DM, `member.user` in a server. */
function userOf(interaction: Interaction): string | null {
  const id = interaction.user?.id ?? interaction.member?.user?.id;
  return typeof id === "string" && id !== "" ? id : null;
}

/** The option a command was given by `name`, as a string. */
function stringOption(options: Option[] | undefined, name: string): string | null {
  const value = (options ?? []).find((option) => option.name === name)?.value;
  return typeof value === "string" ? value : null;
}

// ---------------------------------------------------------------------------------------
// `/card-search`, from Scryfall
// ---------------------------------------------------------------------------------------

async function cardSearch(interaction: Interaction): Promise<Response> {
  const query = (stringOption(interaction.data?.options, "card") ?? "").trim();
  if (query === "") return privately("Name a card to look up.");
  const found = await fuzzy(query);
  if ("failed" in found) return privately(SCRYFALL_DOWN);
  if ("missing" in found) {
    return privately(`Scryfall knows no card called **${escapeMarkdown(query)}**.`);
  }
  // Public: showing a card in a channel is the point of the command.
  return reply({ embeds: [cardEmbed(found.card)] }, false);
}

async function cardSearchChoices(interaction: Interaction): Promise<Response> {
  const focused = (interaction.data?.options ?? []).find((option) => option.focused === true);
  if (focused?.name !== "card" || typeof focused.value !== "string") return choices([]);
  return choices((await autocomplete(focused.value)).map((name) => choice(name, name)));
}

// ---------------------------------------------------------------------------------------
// An add's `card` and `set`, from Scryfall
// ---------------------------------------------------------------------------------------

/** The subcommand an interaction names, and its options. */
function subcommandOf(interaction: Interaction): { name: string; options: Option[] } | null {
  const sub = (interaction.data?.options ?? []).find((option) => option.type === 1);
  return sub === undefined ? null : { name: sub.name, options: sub.options ?? [] };
}

/** `Double Masters 2022 (2X2) #117`, the way the bot's answers spell a printing. */
export function printingName(printing: {
  setName: string;
  set: string;
  collectorNumber: string;
}): string {
  return `${printing.setName} (${printing.set.toUpperCase()}) #${printing.collectorNumber}`;
}

/**
 * The choices for an add's focused `card` or `set`, or `null` when the focused option is neither
 * (then it is the Durable Object's: the `folder`). A set's choices are the printings of the card
 * the `card` option holds right now — Discord sends every option's current value with a
 * keystroke — kept to those whose name or code holds what was typed.
 */
async function addChoices(options: Option[]): Promise<Response | null> {
  const focused = options.find((option) => option.focused === true);
  const typed = typeof focused?.value === "string" ? focused.value : "";
  if (focused?.name === "card") {
    return choices((await autocomplete(typed)).map((name) => choice(name, name)));
  }
  if (focused?.name !== "set") return null;
  const card = stringOption(options, "card") ?? "";
  const wanted = typed.trim().toLowerCase();
  const found = (await printings(card))
    .map((printing) =>
      choice(printingName(printing), `${printing.set}/${printing.collectorNumber}`),
    )
    .filter((entry) => wanted === "" || entry.name.toLowerCase().includes(wanted));
  return choices(found);
}

// ---------------------------------------------------------------------------------------
// Everything else: the link's Durable Object
// ---------------------------------------------------------------------------------------

/**
 * The reader's own Durable Object's answer, verbatim — or, when it throws, a sentence (or no
 * choices, which is the only thing an autocomplete can be answered with).
 */
async function forwarded(
  env: Env,
  interaction: Interaction,
  user: string,
  signed: Signed,
): Promise<Response> {
  const asking = interaction.type === AUTOCOMPLETE;
  const link = await linkOf(env, user);
  if (link === null) return asking ? choices([]) : privately(NOT_LINKED);
  let answer: Awaited<ReturnType<ReturnType<typeof botOf>["interaction"]>>;
  try {
    answer = await botOf(env, link).interaction({
      body: signed.body,
      signature: signed.signature,
      timestamp: signed.timestamp,
    });
  } catch {
    return asking ? choices([]) : privately(BOT_DOWN);
  }
  return new Response(answer.body, {
    status: answer.status,
    headers: { "content-type": answer.contentType },
  });
}

// ---------------------------------------------------------------------------------------
// The route
// ---------------------------------------------------------------------------------------

export async function handleInteraction(request: Request, env: Env): Promise<Response> {
  const signed = await verified(request, env.DISCORD_PUBLIC_KEY);
  if (signed === null) return refusal(401, "bad_signature", "invalid request signature");

  let interaction: Interaction;
  try {
    const parsed: unknown = JSON.parse(signed.body);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    interaction = parsed as Interaction;
  } catch {
    return refusal(400, "bad_request", "the interaction is not JSON");
  }

  if (interaction.type === PING) return json({ type: PONG });

  const name = interaction.data?.name;
  if (name === CARD_SEARCH && interaction.type === APPLICATION_COMMAND) {
    return cardSearch(interaction);
  }
  if (name === CARD_SEARCH && interaction.type === AUTOCOMPLETE) {
    return cardSearchChoices(interaction);
  }

  const sub = subcommandOf(interaction);
  if (
    interaction.type === AUTOCOMPLETE &&
    (name === "collection" || name === "wishlist") &&
    sub?.name === ADD
  ) {
    const answered = await addChoices(sub.options);
    if (answered !== null) return answered;
  }

  const user = userOf(interaction);
  if (user === null) return refusal(400, "bad_request", "the interaction names no user");
  return forwarded(env, interaction, user, signed);
}
