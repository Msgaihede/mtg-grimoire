/**
 * The effects on a card in words (issue #1327): the engine sends each continuous effect as facts
 * — its kind (CR 613's layer), its source, what it gives and takes — and the table writes them,
 * short on the card's chips and in full under the preview.
 */
import type { CardEffect } from "@/lib/ipc";

/** How many effect chips a card on the table shows before the rest are counted in one more. */
export const EFFECT_CHIPS = 3;

/** A P/T change as the table writes one: `+3`, `-1`, `+0`, and `+X` for one worked out in play. */
function signed(n: number | null): string {
  if (n === null) return "+X";
  return n < 0 ? String(n) : `+${n}`;
}

/** A granted ability in one word or two: a trigger on dying, another trigger, any other. */
function abilityWord(text: string): string {
  if (/^When(ever)? ~ dies\b/i.test(text)) return "Dies trigger";
  if (/^(When|Whenever|At)\b/.test(text)) return "Trigger";
  return "Ability";
}

/** What was given and taken, `+Demon −Artifact`, or `null` when the engine named neither. */
function changes(gained: string[], lost: string[]): string | null {
  const words = [...gained.map((w) => `+${w}`), ...lost.map((w) => `−${w}`)];
  return words.length === 0 ? null : words.join(" ");
}

/**
 * What an effect did, short enough for a chip on the card: `+3/+3`, `+Demon`, `+Trample`,
 * `+Dies trigger`, `Base 0/1`, `Control`. Never empty — an effect the engine names nothing of is
 * still called by its kind.
 */
export function effectLabel(effect: CardEffect): string {
  switch (effect.kind) {
    case "copy":
      return "Copy";
    case "control":
      return "Control";
    case "text":
      return "Text changed";
    case "type":
      return changes(effect.gained, effect.lost) ?? "Type changed";
    case "color":
      return changes(effect.gained, effect.lost) ?? "Color changed";
    case "ability": {
      const granted = [...new Set(effect.abilities.map(abilityWord))].map((w) => `+${w}`);
      const words = [
        ...(effect.losesAbilities ? ["No abilities"] : []),
        ...(changes(effect.gained, effect.lost)?.split(" ") ?? []),
        ...granted,
      ];
      return words.length === 0 ? "Abilities changed" : words.join(" ");
    }
    case "setPt":
      return `Base ${effect.power ?? "X"}/${effect.toughness ?? "X"}`;
    case "modifyPt":
      return `${signed(effect.power)}/${signed(effect.toughness)}`;
    case "switchPt":
      return "P/T switched";
  }
}

/** The chip's whole text: what happened and where from, `+3/+3 · Giant Growth`. */
export function effectChip(effect: CardEffect): string {
  return `${effectLabel(effect)} · ${effect.source}`;
}

/**
 * The granted abilities' text for the card they are on: phase writes `~` for the card itself,
 * so "When ~ dies, draw a card." on a Grizzly Bears reads "When Grizzly Bears dies, draw a card."
 * A face-down card has no name to show, and is "this permanent".
 */
export function grantedText(effect: CardEffect, name: string): string[] {
  const self = name === "" ? "this permanent" : name;
  return effect.abilities.map((text) => text.split("~").join(self));
}

/**
 * One effect in full, for the preview and a screen reader: `+3/+3 from Giant Growth`, and a
 * granted ability's own text after it — `+Dies trigger from Clavileño: “When Vampire dies, …”`.
 */
export function effectLine(effect: CardEffect, name: string): string {
  const text = grantedText(effect, name);
  const line = `${effectLabel(effect)} from ${effect.source}`;
  return text.length === 0 ? line : `${line}: ${text.map((t) => `“${t}”`).join(" ")}`;
}
