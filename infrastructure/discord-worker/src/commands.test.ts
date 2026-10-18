import { describe, expect, it } from "vitest";
import { CARD_SEARCH, COMMANDS, DECK_FORMATS } from "./commands";

/**
 * The commands `pnpm discord:register` puts on the application. Discord validates a `PUT` of the
 * whole list and refuses all of it for one bad entry, so what it would refuse is refused here
 * first — and **what PR 3 must not register** (an `add`) is held absent.
 */

type Command = (typeof COMMANDS)[number];
interface Opt {
  type: number;
  name: string;
  description: string;
  required?: boolean;
  autocomplete?: boolean;
  choices?: { name: string; value: string }[];
  options?: Opt[];
}

/** Every option of a command, subcommands' options included. */
const leaves = (command: Command): Opt[] =>
  (command.options as Opt[]).flatMap((option) =>
    option.type === 1 ? (option.options ?? []) : [option],
  );

describe("the commands", () => {
  it("are PR 3's read-only set and nothing else", () => {
    const spelled = COMMANDS.flatMap((command) =>
      (command.options as Opt[]).some((option) => option.type === 1)
        ? (command.options as Opt[]).map((sub) => `/${command.name} ${sub.name}`)
        : [`/${command.name}`],
    );
    expect(spelled).toEqual(["/collection search", "/wishlist search", "/card-search", "/deck"]);
    // No add until the bot holds the `add` capability (PR 4).
    expect(JSON.stringify(COMMANDS)).not.toMatch(/"name":"add"|"name":"folder"|"name":"quantity"/);
    expect(COMMANDS.map((command) => command.name)).toContain(CARD_SEARCH);
  });

  it("are a user install's, everywhere a user-installed command can run", () => {
    for (const command of COMMANDS) {
      expect(command.type, command.name).toBe(1);
      expect(command.integration_types, command.name).toEqual([1]);
      expect(command.contexts, command.name).toEqual([0, 1, 2]);
    }
  });

  it("complete every card and every deck", () => {
    for (const command of COMMANDS) {
      const named = leaves(command).filter(
        (option) => option.name === "card" || option.name === "deck",
      );
      expect(named.length, command.name).toBe(1);
      for (const option of named) {
        expect(option, command.name).toMatchObject({ type: 3, required: true, autocomplete: true });
      }
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
