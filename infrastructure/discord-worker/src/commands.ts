/**
 * The slash commands, as Discord's API takes them — what `pnpm discord:register` puts on the
 * application (`scripts/discord-register.ts`, one `PUT` of this whole list), and the names
 * `interactions.ts` and the bot's Durable Object dispatch on.
 *
 * ⚠️ **This module is loaded by Node as well as bundled into the Worker**: the register script
 * imports it straight from the source, under Node's type stripping. So it is plain data with
 * nothing but erasable type syntax — no `enum`, no import.
 *
 * **PR 3's set, and nothing else** (the design, §11 and §13.7): the bot is read-only, so
 * `/collection add` and `/wishlist add` are **not registered** until PR 4 gives it the `add`
 * capability. A command that is registered is one a reader can type; registering one the bot
 * cannot honour would be a button that only ever says no.
 *
 * **A user-installed app**: `integration_types: [1]` (`USER_INSTALL`) and `contexts: [0, 1, 2]`
 * (a server, the bot's DM, any other DM or group DM), so the commands follow the reader into any
 * channel they can type in, with no bot invited anywhere.
 *
 * **Discord forbids a command that is both invocable and a parent of subcommands**, so the
 * issue's `/collection <card>` is spelled `/collection search` — with one subcommand today, so
 * that PR 4's `add` joins it rather than renaming it (the same for `/wishlist`).
 */

/** `APPLICATION_COMMAND_OPTION_TYPE`s used here. */
const SUB_COMMAND = 1;
const STRING = 3;

/** `CHAT_INPUT`: a slash command. */
const CHAT_INPUT = 1;
/** `USER_INSTALL` alone. */
const INTEGRATION_TYPES = [1];
/** `GUILD`, `BOT_DM` and `PRIVATE_CHANNEL`: everywhere a user-installed command can run. */
const CONTEXTS = [0, 1, 2];

/** A card's name. Every command that names a card completes it. */
function cardOption(description: string) {
  return { type: STRING, name: "card", description, required: true, autocomplete: true };
}

/** The four list formats `/deck` writes, as the TypeScript export writer names them. */
export const DECK_FORMATS = ["plain", "arena", "mtgo", "moxfield"];

export const COMMANDS = [
  {
    name: "collection",
    description: "Your MTG Grimoire collection",
    type: CHAT_INPUT,
    integration_types: INTEGRATION_TYPES,
    contexts: CONTEXTS,
    options: [
      {
        type: SUB_COMMAND,
        name: "search",
        description: "Show a card from your collection: its printings, finishes and folders",
        options: [cardOption("The card's name")],
      },
    ],
  },
  {
    name: "wishlist",
    description: "Your MTG Grimoire wishlist",
    type: CHAT_INPUT,
    integration_types: INTEGRATION_TYPES,
    contexts: CONTEXTS,
    options: [
      {
        type: SUB_COMMAND,
        name: "search",
        description: "Show a card from your wishlist",
        options: [cardOption("The card's name")],
      },
    ],
  },
  {
    name: "card-search",
    description: "Any card from Scryfall, with its image, rules text and price",
    type: CHAT_INPUT,
    integration_types: INTEGRATION_TYPES,
    contexts: CONTEXTS,
    options: [cardOption("The card's name")],
  },
  {
    name: "deck",
    description: "Post one of your MTG Grimoire decks as a list",
    type: CHAT_INPUT,
    integration_types: INTEGRATION_TYPES,
    contexts: CONTEXTS,
    options: [
      {
        type: STRING,
        name: "deck",
        description: "The deck's name",
        required: true,
        autocomplete: true,
      },
      {
        type: STRING,
        name: "format",
        description: "Plain text with the finish (when left out), Arena, MTGO or Moxfield",
        required: false,
        choices: [
          { name: "Plain text", value: "plain" },
          { name: "Arena", value: "arena" },
          { name: "MTGO", value: "mtgo" },
          { name: "Moxfield", value: "moxfield" },
        ],
      },
    ],
  },
];

/**
 * The one command this Worker answers itself, without a Durable Object: it reads Scryfall and
 * nobody's data, so it works for a reader who has linked nothing.
 */
export const CARD_SEARCH = "card-search";
