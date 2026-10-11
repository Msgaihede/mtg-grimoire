import { MAX_LABEL_CHARS, MAX_RUN_BYTES, MAX_RUN_FRAMES, MIN_RUN_FRAMES } from "./env";

/**
 * The label: what a reader said a scan shows, what the scanner had said about it, and where each
 * frame of the run is in the bytes beside it.
 *
 * **It is the whole value of a submission.** A run of pictures of a card nobody has named is so
 * many photographs; a run with the exact printing and finish beside it is a test the scanner can
 * be run against. So the label is checked field by field and a submission without a whole one is
 * refused rather than stored — there is no partial credit, and nothing arrives here that the app
 * did not have in hand when the reader pressed Send.
 *
 * **A scan is a run of frames, and one picture is not a scan.** `run` has an entry a frame and
 * fewer than `MIN_RUN_FRAMES` of them is refused like any other label that is not whole — there
 * is no field here a single still could be sent in.
 *
 * **What is stored is rebuilt from what was checked, never the object that was sent.** A key this
 * file does not name is dropped, so a sidecar cannot be made to carry a string nobody validated.
 *
 * **And nothing in it says who sent it** — no device, no group, no address. That is a property of
 * this shape and has to stay one: `apps/light/public/privacy.html` promises it.
 *
 * ⚠️ **The engine builds this in `crates/grimoire-core/src/scanner_submit.rs` (`Label`)**, and a
 * field added there without one here is a field this Worker drops in silence. `label.test.ts`
 * reads the Rust structs' field names and holds the two together.
 */
export interface Label {
  /** The shape's version. A second shape is a second number, and a Worker deployed for it. */
  v: 1;
  /**
   * The printing the reader chose — Scryfall's id for it, and enough to read it by eye. It is
   * the card in the **last** frame: the one under the camera at the press.
   */
  card: {
    id: string;
    set: string;
    number: string;
    lang: string;
    name: string;
  };
  /** The finish of the cardboard in the pictures, which no hash can tell and a person can. */
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
    /**
     * What the reader had narrowed it to: it decides which printings it could have answered
     * with, so a run replayed without it is another scan. No sets and two `null`s is no filter.
     */
    filters: {
      sets: string[];
      from: string | null;
      to: string | null;
    };
  };
  app: {
    version: string;
    platform: string;
  };
  /**
   * The run, oldest first, an entry a frame — **and the index of the body**: the frames are
   * stored end to end with nothing between them, and each entry's `bytes` is where the next one
   * starts.
   */
  run: Frame[];
}

/** One frame of a run: where it is, how big it is, and what the scanner answered for it. */
export interface Frame {
  /** Milliseconds before the press it was taken: zero or negative, by the app's own clock. */
  ms: number;
  /** Its length in the body. */
  bytes: number;
  width: number;
  height: number;
  /** Whether the scanner found a card in it at all. */
  ok: boolean;
  /** The lock's phase on it — `idle`, `acquiring`, `locked` — or `null` with no lock. */
  lock: string | null;
  confidence: number | null;
  distance: number | null;
  /** The printing the scanner had decided on by this frame, or `null`. */
  decided: string | null;
  /** A larger picture went to the scanner with this frame. It is not in the run. */
  detail: boolean;
}

export const FINISHES = ["nonfoil", "foil", "etched"] as const;
export type Finish = (typeof FINISHES)[number];

/**
 * How many set codes a label's filters carry — the engine's `MAX_FILTER_SETS`, which
 * `label.test.ts` reads the Rust to hold this to.
 */
export const MAX_FILTER_SETS = 64;

/** A Scryfall id as the engine spells one: lower-case, hyphenated. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A set code. Scryfall's run from three characters to six; the bounds here are looser. */
const SET = /^[a-z0-9]{2,8}$/;
/** A language code as Scryfall writes them: `en`, `ja`, `zhs`, `grc`. */
const LANG = /^[a-z]{2,3}$/;
/** A scan mode's name, a platform's, a lock's phase: a short lower-case word, whatever the list is today. */
const WORD = /^[a-z0-9_-]{1,16}$/;
/** `0.41.0`, `1.2.3-beta.1+build` — the characters a version is written in. */
const VERSION = /^[0-9A-Za-z.+-]{1,32}$/;
/** A release date as the scanner's filters spell one. */
const DATE = /^\d{4}-\d{2}-\d{2}$/;

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

/** A share of the evidence: `null`, or a number from nothing to all of it. */
function share(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && value >= 0 && value <= 1);
}

/** A count of bits out of 256, or `null`. */
function bits(value: unknown): value is number | null {
  return value === null || integer(value, 0, 256);
}

/** One entry of `run`, rebuilt from what was checked — or the word for what is wrong with it. */
function readFrame(sent: unknown): Frame | string {
  if (!isRecord(sent)) return "is not an object";
  // A minute back and never after the press: the app sends a couple of seconds.
  if (!integer(sent.ms, -60_000, 0)) return "has no time before the press";
  // Three bytes is how a JPEG starts; a frame cannot be shorter and be one.
  if (!integer(sent.bytes, 3, MAX_RUN_BYTES)) return "has no length";
  if (!integer(sent.width, 1, 8192) || !integer(sent.height, 1, 8192)) return "has no size";
  if (typeof sent.ok !== "boolean") return "does not say whether a card was found";
  if (sent.lock !== null && !matches(sent.lock, WORD)) return "has a lock that is not a phase";
  if (!share(sent.confidence)) return "has a confidence that is not between 0 and 1";
  if (!bits(sent.distance)) return "has a distance that is not a count of bits";
  if (sent.decided !== null && !matches(sent.decided, UUID)) {
    return "has a decided card that is not a Scryfall id";
  }
  if (typeof sent.detail !== "boolean") return "does not say whether it had a detail picture";
  return {
    ms: sent.ms,
    bytes: sent.bytes,
    width: sent.width,
    height: sent.height,
    ok: sent.ok,
    lock: sent.lock,
    confidence: sent.confidence,
    distance: sent.distance,
    decided: sent.decided,
    detail: sent.detail,
  };
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

  const { card, finish, scanner, app, run } = sent;

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
  if (!share(scanner.confidence)) return "that label's confidence is not between 0 and 1";
  if (!bits(scanner.distance)) return "that label's distance is not a count of bits";
  if (scanner.bundle !== null && !integer(scanner.bundle, 0, 10_000_000)) {
    return "that label's bundle is not a count of cards";
  }

  const { filters } = scanner;
  if (!isRecord(filters)) return "that label says nothing of the scanner's filters";
  const { sets } = filters;
  if (!Array.isArray(sets) || sets.length > MAX_FILTER_SETS) {
    return "that label's filtered sets are not a list of set codes";
  }
  const codes: string[] = [];
  for (const code of sets as unknown[]) {
    if (!matches(code, SET)) return "that label's filtered sets are not a list of set codes";
    codes.push(code);
  }
  if (filters.from !== null && !matches(filters.from, DATE)) {
    return "that label's earliest release date is not a date";
  }
  if (filters.to !== null && !matches(filters.to, DATE)) {
    return "that label's latest release date is not a date";
  }

  if (!isRecord(app)) return "that label names no app";
  if (!matches(app.version, VERSION)) return "that label's app version is not a version";
  if (!matches(app.platform, WORD)) return "that label's platform is not a platform";

  if (!Array.isArray(run)) return "that label lists no frames";
  // The one rule with no figure in it: one picture is not a scan, and neither are four.
  if (run.length < MIN_RUN_FRAMES) {
    return `a scan is a run of at least ${MIN_RUN_FRAMES} frames, never one picture`;
  }
  if (run.length > MAX_RUN_FRAMES) return `a scan is a run of at most ${MAX_RUN_FRAMES} frames`;
  const frames: Frame[] = [];
  for (const [at, entry] of (run as unknown[]).entries()) {
    const frame = readFrame(entry);
    if (typeof frame === "string") return `that label's frame ${at} ${frame}`;
    frames.push(frame);
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
      filters: { sets: codes, from: filters.from, to: filters.to },
    },
    app: { version: app.version, platform: app.platform },
    run: frames,
  };
}
