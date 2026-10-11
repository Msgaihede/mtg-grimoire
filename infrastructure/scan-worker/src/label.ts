import { MAX_LABEL_CHARS } from "./env";

/**
 * The label: what a reader said a picture shows, and what the scanner had said about it.
 *
 * **It is the whole value of a submission.** A picture of a card nobody has named is one more
 * photograph; a picture with the exact printing and finish beside it is a test the scanner can be
 * run against. So the label is checked field by field and a submission without a whole one is
 * refused rather than stored — there is no partial credit, and nothing arrives here that the app
 * did not have in hand when the reader pressed Send.
 *
 * **What is stored is rebuilt from what was checked, never the object that was sent.** A key this
 * file does not name is dropped, so a sidecar cannot be made to carry a string nobody validated.
 *
 * **And nothing in it says who sent it** — no device, no group, no address. That is a property of
 * this shape and has to stay one: `apps/light/public/privacy.html` promises it.
 *
 * ⚠️ **The engine builds this in `crates/grimoire-core/src/scanner_submit.rs` (`Label`)**, and a
 * field added there without one here is a field this Worker drops in silence. `label.test.ts`
 * reads the Rust struct's field names and holds the two together.
 */
export interface Label {
  /** The shape's version. A second shape is a second number, and a Worker deployed for it. */
  v: 1;
  /** The printing the reader chose — Scryfall's id for it, and enough to read it by eye. */
  card: {
    id: string;
    set: string;
    number: string;
    lang: string;
    name: string;
  };
  /** The finish of the cardboard in the picture, which no hash can tell and a person can. */
  finish: Finish;
  /** What the scanner had to say at the press. Every figure is `null` when it had none. */
  scanner: {
    /**
     * The printing the scanner had decided on, or `null` while it had decided nothing — so it
     * is the same kind of id as `card.id`, and the two being equal is a scan it got right.
     */
    reported: string | null;
    mode: string;
    confidence: number | null;
    distance: number | null;
    /** How many cards the scanner's bundle held — which bundle got this wrong. */
    bundle: number | null;
  };
  app: {
    version: string;
    platform: string;
  };
  frame: {
    width: number;
    height: number;
  };
}

export const FINISHES = ["nonfoil", "foil", "etched"] as const;
export type Finish = (typeof FINISHES)[number];

/** A Scryfall id as the engine spells one: lower-case, hyphenated. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A set code. Scryfall's run from three characters to six; the bounds here are looser. */
const SET = /^[a-z0-9]{2,8}$/;
/** A language code as Scryfall writes them: `en`, `ja`, `zhs`, `grc`. */
const LANG = /^[a-z]{2,3}$/;
/** A scan mode's name, a platform's name: a short lower-case word, whatever the list is today. */
const WORD = /^[a-z0-9_-]{1,16}$/;
/** `0.41.0`, `1.2.3-beta.1+build` — the characters a version is written in. */
const VERSION = /^[0-9A-Za-z.+-]{1,32}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A string of `1..=max` characters with no control character in it. */
function text(value: unknown, max: number): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) return false;
  for (let at = 0; at < value.length; at += 1) {
    const code = value.charCodeAt(at);
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

function matches(value: unknown, pattern: RegExp): value is string {
  return typeof value === "string" && pattern.test(value);
}

function integer(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

/**
 * The label a request carries, or the sentence that refuses it.
 *
 * **A string and not a status**, because every refusal here is a 400 and what differs is which
 * field — and the caller that reads the sentence is a developer with a `curl`, never a reader:
 * the app builds its label from a struct, so a label this refuses is a build that has drifted
 * from this file.
 *
 * **ASCII only, checked before anything is parsed.** A header's bytes reach a Worker as Latin-1,
 * so a name sent as raw UTF-8 would parse without complaint into mojibake and be stored that way.
 * The engine escapes everything past `~` as `\u….`, which is what `asciiJson` does for the
 * scanner's own frames; a header that did not is refused rather than repaired.
 */
export function readLabel(header: string | null): Label | string {
  if (header === null || header === "") return "that request carried no label";
  if (header.length > MAX_LABEL_CHARS) return "that label is too long";
  for (let at = 0; at < header.length; at += 1) {
    const code = header.charCodeAt(at);
    if (code < 0x20 || code > 0x7e) return "a label is ASCII JSON, with every other character escaped";
  }

  let sent: unknown;
  try {
    sent = JSON.parse(header);
  } catch {
    return "that label is not JSON";
  }
  if (!isRecord(sent)) return "that label is not an object";
  if (sent.v !== 1) return "this inbox takes version 1 labels";

  const { card, finish, scanner, app, frame } = sent;

  if (!isRecord(card)) return "that label names no card";
  if (!matches(card.id, UUID)) return "that label's card id is not a Scryfall id";
  if (!matches(card.set, SET)) return "that label's set is not a set code";
  if (!text(card.number, 32)) return "that label's collector number is missing";
  if (!matches(card.lang, LANG)) return "that label's language is not a language code";
  if (!text(card.name, 200)) return "that label's card name is missing";

  if (!FINISHES.some((known) => known === finish)) return "that label's finish is not a finish";

  if (!isRecord(scanner)) return "that label says nothing of the scanner";
  if (scanner.reported !== null && !matches(scanner.reported, UUID)) {
    return "that label's reported card is not a Scryfall id";
  }
  if (!matches(scanner.mode, WORD)) return "that label's scan mode is not a mode";
  if (
    scanner.confidence !== null &&
    !(typeof scanner.confidence === "number" && scanner.confidence >= 0 && scanner.confidence <= 1)
  ) {
    return "that label's confidence is not between 0 and 1";
  }
  if (scanner.distance !== null && !integer(scanner.distance, 0, 256)) {
    return "that label's distance is not a count of bits";
  }
  if (scanner.bundle !== null && !integer(scanner.bundle, 0, 10_000_000)) {
    return "that label's bundle is not a count of cards";
  }

  if (!isRecord(app)) return "that label names no app";
  if (!matches(app.version, VERSION)) return "that label's app version is not a version";
  if (!matches(app.platform, WORD)) return "that label's platform is not a platform";

  if (!isRecord(frame)) return "that label says nothing of the picture";
  if (!integer(frame.width, 1, 8192) || !integer(frame.height, 1, 8192)) {
    return "that label's picture size is not a size";
  }

  return {
    v: 1,
    card: {
      id: card.id,
      set: card.set,
      number: card.number,
      lang: card.lang,
      name: card.name,
    },
    finish: finish as Finish,
    scanner: {
      reported: scanner.reported,
      mode: scanner.mode,
      confidence: scanner.confidence,
      distance: scanner.distance,
      bundle: scanner.bundle,
    },
    app: { version: app.version, platform: app.platform },
    frame: { width: frame.width, height: frame.height },
  };
}
