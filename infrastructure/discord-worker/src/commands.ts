/**
 * The slash commands, as Discord's API takes them — what `pnpm discord:register` puts on the
 * application (`scripts/discord-register.ts`, one `PUT` of this whole list), and the names
 * `interactions.ts` and the bot's Durable Object dispatch on.
 *
 * ⚠️ **This module is loaded by Node as well as bundled into the Worker**: the register script
 * imports it straight from the source, under Node's type stripping. So it is plain data with
 * nothing but erasable type syntax — no `enum`, no import.
 *
 * **PR 4's set** (the design, §14.4): PR 3's reads, and `/collection add` and `/wishlist add`
 * now that the bot is paired with the `add` capability. An add is never made by the command
 * itself: the bot answers a proposal, privately, with a Confirm and a Cancel button, and only a
 * press on Confirm by the reader who asked writes anything.
 *
 * **A user-installed app**: `integration_types: [1]` (`USER_INSTALL`) and `contexts: [0, 1, 2]`
 * (a server, the bot's DM, any other DM or group DM), so the commands follow the reader into any
 * channel they can type in, with no bot invited anywhere.
 *
 * **Discord forbids a command that is both invocable and a parent of subcommands**, so the
 * issue's `/collection <card>` is spelled `/collection search`, and `add` is its sibling (the same
 * for `/wishlist`).
 */

/** `APPLICATION_COMMAND_OPTION_TYPE`s used here. */
const SUB_COMMAND = 1;
const STRING = 3;
const INTEGER = 4;

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

/** The most copies one add may carry — `integration::add::MAX_QUANTITY`, which every receiver's
 *  allow-list holds an add to (§14.2). */
export const MAX_QUANTITY = 99;

/** The three finishes a printing is made in, as the engine spells them. */
export const FINISHES = ["nonfoil", "foil", "etched"];

/**
 * The options an add takes after its card. **`set` and `card` are completed by this Worker from
 * Scryfall** (`interactions.ts`); `folder` by the reader's own Durable Object, from their folders.
 * A set's value is `<set>/<collector number>`, one printing, since a set can hold several of one
 * card; a folder's is its `sync_uid`.
 */
function addOptions(what: "collection" | "wishlist") {
  return [
    cardOption("The card's name"),
    {
      type: STRING,
      name: "set",
      description:
        what === "collection"
          ? "The printing (Scryfall's default printing when left out)"
          : "The printing (any printing when left out)",
      required: false,
      autocomplete: true,
    },
    {
      type: INTEGER,
      name: "quantity",
      description: "How many copies (1 when left out)",
      required: false,
      min_value: 1,
      max_value: MAX_QUANTITY,
    },
    {
      type: STRING,
      name: "finish",
      description:
        what === "collection"
          ? "Nonfoil, foil or etched (the printing's first when left out)"
          : "The finish you want (none when left out)",
      required: false,
      choices: [
        { name: "Nonfoil", value: "nonfoil" },
        { name: "Foil", value: "foil" },
        { name: "Etched", value: "etched" },
      ],
    },
    ...(what === "collection"
      ? [
          {
            type: STRING,
            name: "folder",
            description: "One of your folders (Added from Discord when left out)",
            required: false,
            autocomplete: true,
          },
        ]
      : []),
  ];
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
      {
        type: SUB_COMMAND,
        name: "add",
        description: "Add a card to your collection, once you confirm",
        options: addOptions("collection"),
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
      {
        type: SUB_COMMAND,
        name: "add",
        description: "Add a card to your wishlist, once you confirm",
        options: addOptions("wishlist"),
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

/** The subcommand that adds, under `/collection` and `/wishlist`. */
export const ADD = "add";
