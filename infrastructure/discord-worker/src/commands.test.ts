import { describe, expect, it } from "vitest";
import { ADD, CARD_SEARCH, COMMANDS, DECK_FORMATS, FINISHES, MAX_QUANTITY } from "./commands";

/**
 * The commands `pnpm discord:register` puts on the application. Discord validates a `PUT` of the
 * whole list and refuses all of it for one bad entry, so what it would refuse is refused here
 * first, and the two adds' options are held to the design's §14.4.
 */

type Command = (typeof COMMANDS)[number];
interface Opt {
  type: number;
  name: string;
  description: string;
  required?: boolean;
  autocomplete?: boolean;
  min_value?: number;
  max_value?: number;
  choices?: { name: string; value: string }[];
  options?: Opt[];
}

/** Every option of a command, subcommands' options included. */
const leaves = (command: Command): Opt[] =>
  (command.options as Opt[]).flatMap((option) =>
    option.type === 1 ? (option.options ?? []) : [option],
  );

describe("the commands", () => {
  it("are PR 3's reads and PR 4's two adds", () => {
    const spelled = COMMANDS.flatMap((command) =>
      (command.options as Opt[]).some((option) => option.type === 1)
        ? (command.options as Opt[]).map((sub) => `/${command.name} ${sub.name}`)
        : [`/${command.name}`],
    );
    expect(spelled).toEqual([
      "/collection search",
      "/collection add",
      "/wishlist search",
      "/wishlist add",
      "/card-search",
      "/deck",
    ]);
    expect(COMMANDS.map((command) => command.name)).toContain(CARD_SEARCH);
  });

  it("give an add §14.4's options: card, set, quantity 1–99, a finish, and a folder for the collection", () => {
    const add = (name: string) =>
      (COMMANDS.find((command) => command.name === name)!.options as Opt[]).find(
        (sub) => sub.name === ADD,
      )!.options!;
    const collection = add("collection");
    const wishlist = add("wishlist");
    expect(collection.map((option) => option.name)).toEqual([
      "card",
      "set",
      "quantity",
      "finish",
      "folder",
    ]);
    expect(wishlist.map((option) => option.name)).toEqual(["card", "set", "quantity", "finish"]);
    for (const options of [collection, wishlist]) {
      const by = (name: string) => options.find((option) => option.name === name)!;
      expect(by("card")).toMatchObject({ type: 3, required: true, autocomplete: true });
      expect(by("set")).toMatchObject({ type: 3, required: false, autocomplete: true });
      expect(by("quantity")).toMatchObject({
        type: 4,
        required: false,
        min_value: 1,
        max_value: MAX_QUANTITY,
      });
      expect(MAX_QUANTITY).toBe(99);
      expect(by("finish").choices!.map((entry) => entry.value)).toEqual(FINISHES);
      expect(FINISHES).toEqual(["nonfoil", "foil", "etched"]);
    }
    expect(collection.find((option) => option.name === "folder")).toMatchObject({
      type: 3,
      required: false,
      autocomplete: true,
    });
  });

  it("are a user install's, everywhere a user-installed command can run", () => {
    for (const command of COMMANDS) {
      expect(command.type, command.name).toBe(1);
      expect(command.integration_types, command.name).toEqual([1]);
      expect(command.contexts, command.name).toEqual([0, 1, 2]);
    }
  });

  it("complete every card and every deck", () => {
    // Each subcommand (or a command with none) names exactly one card or deck, completed.
    const units = COMMANDS.flatMap((command) =>
      (command.options as Opt[]).some((option) => option.type === 1)
        ? (command.options as Opt[]).map((sub) => sub.options ?? [])
        : [command.options as Opt[]],
    );
    for (const options of units) {
      const named = options.filter((option) => option.name === "card" || option.name === "deck");
      expect(named.length).toBe(1);
      expect(named[0]).toMatchObject({ type: 3, required: true, autocomplete: true });
    }
  });

  it("offer /deck's four formats, as the export writer names them, and plain by default", () => {
    const deck = COMMANDS.find((command) => command.name === "deck")!;
    const format = leaves(deck).find((option) => option.name === "format")!;
    expect(format.required).toBe(false);
    expect(format.choices!.map((entry) => entry.value)).toEqual(DECK_FORMATS);
    expect(DECK_FORMATS).toEqual(["plain", "arena", "mtgo", "moxfield"]);
    expect(format.description).toMatch(/^Plain text with the finish \(when left out\)/);
  });

  it("keep within what Discord takes: names, descriptions, an option never both chosen and completed", () => {
    const check = (option: { name: string; description: string }) => {
      expect(option.name).toMatch(/^[-_a-z0-9]{1,32}$/);
      expect(option.description.length).toBeGreaterThan(0);
      expect(option.description.length).toBeLessThanOrEqual(100);
    };
    for (const command of COMMANDS) {
      check(command);
      for (const option of command.options as Opt[]) {
        check(option);
        for (const leaf of option.options ?? []) check(leaf);
      }
      for (const option of leaves(command)) {
        expect(option.autocomplete === true && option.choices !== undefined).toBe(false);
      }
      // Required options come first, which Discord insists on.
      const list = leaves(command);
      const firstOptional = list.findIndex((option) => option.required !== true);
      if (firstOptional >= 0) {
        expect(list.slice(firstOptional).every((option) => option.required !== true)).toBe(true);
      }
    }
  });
});
