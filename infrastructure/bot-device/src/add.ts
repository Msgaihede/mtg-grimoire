/**
 * **`/collection add` and `/wishlist add`** (the Discord spec, §14.4): a command answers a
 * proposal, and only a press on its Confirm writes anything.
 *
 * ```text
 *  command ──checks (no network)──▶ deferred reply (type 5, ephemeral) ──┐
 *                                                                        ▼  after the answer
 *                         Scryfall: the printing ──▶ proposal kept ──▶ the reply edited: the add,
 *                                                                       Confirm and Cancel
 *  Confirm ──proposal taken──▶ the engine's emit ──▶ the message updated (type 7) ──▶ alarm in 1 s:
 *                                                                              push, then pull
 *  Cancel  ──proposal taken──▶ the message updated: *Cancelled.*
 * ```
 *
 * **The three-second rule.** Discord waits three seconds for an interaction's answer, and the
 * printing is Scryfall's — one request from an object that may have just been woken, behind the
 * front's own hop. So a command that passes the checks this object can make on its own (paired,
 * a quantity and a finish that are words it knows, the folder, the day's quota) is answered at once
 * with a *deferred* ephemeral reply, and the rest runs after it (`Host.defer`, `ctx.waitUntil` in
 * workerd): Scryfall, the proposal, and an edit of the reply through the interaction's webhook
 * (`discord.ts`). PR 3's reads answer synchronously from what is held, and still do.
 *
 * **A press never reaches the network**: the proposal is in this object's storage
 * (`proposals.ts`), the emit is the engine's and local, and the push is the alarm's.
 */
import { editOriginal, webhookable } from "./discord";
import type { Proposal, Proposals } from "./proposals";
import { PROPOSAL_ID, PROPOSAL_TTL_MS, proposalId } from "./proposals";
import { clip, CONTENT_CHARS, escapeMarkdown, privately, refused, type Reply } from "./render";
import { lookup, oracleOf, parseSet, type Found, type Printing } from "./scryfall";
import type { Answer, Engine, Target } from "./types";

/** The most copies one add carries — `integration::add::MAX_QUANTITY`. */
export const MAX_QUANTITY = 99;
export const FINISHES = ["nonfoil", "foil", "etched"] as const;

// Discord's numbers.
const DEFERRED_CHANNEL_MESSAGE = 5;
const UPDATE_MESSAGE = 7;
const EPHEMERAL = 64;
const ACTION_ROW = 1;
const BUTTON = 2;
const SUCCESS = 3;
const SECONDARY = 2;

/** What a press on a proposal that is gone is told. */
export const EXPIRED = "That request has expired. Run the command again.";
export const CANCELLED = "Cancelled.";
/** A press by somebody other than the reader who asked. Ephemeral messages make this all but
 *  impossible, and the proposal stands. */
export const NOT_YOURS = "Only the person who asked can confirm or cancel this.";
export const SCRYFALL_DOWN = "Scryfall could not be reached just now. Try again in a moment.";
/** What any failure inside the engine's emit is, to a reader. */
export const ADD_FAILED = "MTG Grimoire's bot could not add that just now. Try again in a moment.";

export interface Option {
  name: string;
  type: number;
  value?: unknown;
  options?: Option[];
  focused?: boolean;
}

export interface Interaction {
  type: number;
  application_id?: unknown;
  token?: unknown;
  data?: { name?: unknown; options?: Option[]; custom_id?: unknown };
  user?: { id?: unknown };
  member?: { user?: { id?: unknown } };
}

/** Where an add's work goes on after its answer, and what it reaches. */
export interface AddHost {
  engine: Engine;
  proposals: Proposals;
  now(): number;
  /** Keep the object alive for `work` after the answer has gone (`ctx.waitUntil`). */
  defer(work: Promise<unknown>): void;
  fetch: typeof fetch;
  scryfallUrl: string;
  discordApi: string;
  /** Ask for an alarm by `at` — the push after a confirm. */
  alarmBy(at: number): Promise<void>;
}

/** The Discord user an interaction came from: `user` in a DM, `member.user` in a server. */
export function userOf(interaction: Interaction): string | null {
  const id = interaction.user?.id ?? interaction.member?.user?.id;
  return typeof id === "string" && id !== "" ? id : null;
}

function json(value: unknown): Reply {
  return { status: 200, contentType: "application/json", body: JSON.stringify(value) };
}

/** The message a press is on, rewritten: `content`, and no buttons. */
export function update(content: string): Reply {
  return json({
    type: UPDATE_MESSAGE,
    data: {
      content: clip(content, CONTENT_CHARS),
      components: [],
      allowed_mentions: { parse: [] },
    },
  });
}

function deferred(): Reply {
  return json({ type: DEFERRED_CHANNEL_MESSAGE, data: { flags: EPHEMERAL } });
}

function read<T>(text: string): { ok: T } | { refused: string } {
  const parsed = JSON.parse(text) as Answer<T> | { refused: string };
  if ("err" in parsed) throw new Error(parsed.err);
  return parsed;
}

/** `Double Masters 2022 (2X2) #117`. */
export function printingText(card: Pick<Printing, "set" | "set_name" | "collector_number">) {
  return `${card.set_name} (${card.set.toUpperCase()}) #${card.collector_number}`;
}

/** Whether `printing` is the card the reader named: the same name, or its front face. */
function isCard(printing: Printing, name: string): boolean {
  const want = name.trim().toLowerCase();
  const have = printing.name.toLowerCase();
  return have === want || have.startsWith(`${want} // `);
}

/** What one add's options say, read and checked. */
interface Asked {
  list: "collection" | "wishlist";
  card: string;
  set: { set: string; number: string | null } | null;
  quantity: number;
  finish: string | null;
}

function optionsOf(interaction: Interaction): Option[] {
  return (interaction.data?.options ?? []).find((o) => o.type === 1)?.options ?? [];
}

/** The options, or the sentence that refuses them. */
function asked(list: Asked["list"], options: Option[]): Asked | string {
  const value = (name: string) => options.find((o) => o.name === name)?.value;
  const card = typeof value("card") === "string" ? (value("card") as string).trim() : "";
  if (card === "") return "Name a card to add.";
  const setText = typeof value("set") === "string" ? (value("set") as string).trim() : "";
  const set = setText === "" ? null : parseSet(setText);
  if (setText !== "" && set === null) return "Pick a set from the list, or leave it out.";
  const quantity = value("quantity") ?? 1;
  if (typeof quantity !== "number" || !Number.isInteger(quantity)) {
    return `Add between 1 and ${MAX_QUANTITY} copies.`;
  }
  if (quantity < 1 || quantity > MAX_QUANTITY) return `Add between 1 and ${MAX_QUANTITY} copies.`;
  const finishValue = value("finish");
  const finish = typeof finishValue === "string" && finishValue !== "" ? finishValue : null;
  if (finish !== null && !(FINISHES as readonly string[]).includes(finish)) {
    return "The finish is nonfoil, foil or etched.";
  }
  return { list, card, set, quantity, finish };
}

/**
 * **A command, answered**: a refusal at once, or a deferred reply and the rest after it. The
 * caller has checked the signature and that the bot is paired and has pulled.
 */
export function startAdd(host: AddHost, interaction: Interaction): Reply {
  const list = interaction.data?.name === "wishlist" ? "wishlist" : "collection";
  const user = userOf(interaction);
  if (user === null) return refused(400, "the interaction names no user");
  if (!webhookable(interaction.application_id, interaction.token)) {
    return refused(400, "the interaction has no token to answer it by");
  }
  const options = optionsOf(interaction);
  const wanted = asked(list, options);
  if (typeof wanted === "string") return privately(wanted);
  const folderValue = options.find((o) => o.name === "folder")?.value;
  const folder = list === "collection" && typeof folderValue === "string" ? folderValue : "";
  // The folder and the day's quota are the engine's to judge, and need no network.
  const target = read<Target>(host.engine.target(list, folder));
  if ("refused" in target) return privately(target.refused);
  const applicationId = interaction.application_id as string;
  const token = interaction.token as string;
  // Started on a later turn than this answer's, and awaited by nobody but `defer`.
  host.defer(
    Promise.resolve()
      .then(() => propose(host, user, wanted, target.ok))
      .catch(() => ({ content: ADD_FAILED }))
      .then((data) => editOriginal(host.fetch, host.discordApi, applicationId, token, data)),
  );
  return deferred();
}

/** The message a resolved add is: its sentence and its two buttons — or one sentence. */
export async function propose(
  host: AddHost,
  user: string,
  wanted: Asked,
  target: Target,
): Promise<Record<string, unknown>> {
  const found: Found = await lookup(host.fetch, host.scryfallUrl, {
    name: wanted.card,
    set: wanted.set?.set ?? null,
    number: wanted.set?.number ?? null,
  });
  if ("failed" in found) return { content: SCRYFALL_DOWN };
  const named = escapeMarkdown(wanted.card);
  if ("missing" in found) {
    return {
      content:
        wanted.set === null
          ? `Scryfall knows no card called **${named}**.`
          : `Scryfall knows no printing of **${named}** in that set.`,
    };
  }
  const card = found.card;
  if (wanted.set !== null && !isCard(card, wanted.card)) {
    return { content: `That printing is not **${named}**. Pick the set again.` };
  }
  const printing = escapeMarkdown(printingText(card));
  const name = escapeMarkdown(card.name);
  // A wish for any printing has no printing to check a finish against; every other add does.
  const anyPrinting = wanted.list === "wishlist" && wanted.set === null;
  const finish =
    wanted.finish ?? (wanted.list === "collection" ? (card.finishes[0] ?? null) : null);
  if (!anyPrinting && finish !== null && !card.finishes.includes(finish)) {
    return { content: `${printing} is not made in ${finish}.` };
  }
  let add: unknown;
  let summary: string;
  if (wanted.list === "collection") {
    if (finish === null || target.uid === null) return { content: ADD_FAILED };
    add = {
      table: "collection",
      cardId: card.id,
      setCode: card.set,
      collectorNumber: card.collector_number,
      lang: card.lang,
      finish,
      quantity: wanted.quantity,
      folderUid: target.uid,
    };
    summary = `${wanted.quantity}× ${name} — ${printing}, ${finish} — to ${escapeMarkdown(target.path ?? "")}`;
  } else {
    const oracle = oracleOf(card);
    if (oracle === null) return { content: ADD_FAILED };
    add = {
      table: "wishlist",
      oracleId: oracle,
      name: card.name,
      printing: anyPrinting
        ? null
        : {
            cardId: card.id,
            setCode: card.set,
            collectorNumber: card.collector_number,
            lang: card.lang,
          },
      preferredFinish: finish,
      quantity: wanted.quantity,
      folderUid: null,
    };
    const which = anyPrinting ? "any printing" : printing;
    summary = `${wanted.quantity}× ${name} — ${which}${finish === null ? "" : `, ${finish}`} — to your wishlist`;
  }
  const proposal: Proposal = {
    id: proposalId(),
    discordUserId: user,
    add,
    summary,
    expiresAt: host.now() + PROPOSAL_TTL_MS,
  };
  host.proposals.purge(host.now());
  await host.proposals.put(proposal);
  return {
    content: clip(`Add ${summary}?`, CONTENT_CHARS),
    components: [
      {
        type: ACTION_ROW,
        components: [
          {
            type: BUTTON,
            style: SUCCESS,
            label: "Confirm",
            custom_id: `add:confirm:${proposal.id}`,
          },
          {
            type: BUTTON,
            style: SECONDARY,
            label: "Cancel",
            custom_id: `add:cancel:${proposal.id}`,
          },
        ],
      },
    ],
  };
}

/** A button's `custom_id`, read: `add:confirm:<id>` or `add:cancel:<id>`. */
export function pressed(customId: unknown): { confirm: boolean; id: string } | null {
  if (typeof customId !== "string") return null;
  const match = /^add:(confirm|cancel):(.+)$/.exec(customId);
  if (match === null || !PROPOSAL_ID.test(match[2])) return null;
  return { confirm: match[1] === "confirm", id: match[2] };
}

/**
 * **A press on Confirm or Cancel** — no network: the proposal from storage, the engine's emit,
 * the message rewritten. `paired` is the device's own word; the caller has checked the
 * signature.
 */
export async function press(
  host: AddHost,
  interaction: Interaction,
  paired: boolean,
  notPaired: string,
): Promise<Reply> {
  const button = pressed(interaction.data?.custom_id);
  if (button === null) return privately("That button is not one MTG Grimoire's bot answers.");
  const user = userOf(interaction);
  if (user === null) return refused(400, "the interaction names no user");
  const now = host.now();
  const proposal = await host.proposals.get(button.id, now);
  if (proposal === null) return update(EXPIRED);
  if (proposal.discordUserId !== user) return privately(NOT_YOURS);
  host.proposals.delete(proposal.id);
  if (!button.confirm) return update(CANCELLED);
  if (!paired) return update(notPaired);
  // The engine re-checks the folder and the quota, then emits — or says why not.
  let added: { ok: string } | { refused: string };
  try {
    added = read<string>(host.engine.add(JSON.stringify(proposal.add)));
  } catch {
    return update(ADD_FAILED);
  }
  if ("refused" in added) return update(added.refused);
  // The push is the alarm's: a second from now, so this answer is not waiting on it.
  await host.alarmBy(now + 1000);
  return update(`Added ${proposal.summary}. It reaches your devices on their next sync.`);
}
