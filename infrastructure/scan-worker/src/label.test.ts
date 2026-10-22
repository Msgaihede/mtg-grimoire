import { describe, expect, it } from "vitest";
import goldenNoCard from "../../../crates/grimoire-core/src/__golden__/scan-label-no-card.txt?raw";
import goldenLabel from "../../../crates/grimoire-core/src/__golden__/scan-label.txt?raw";
import scannerSubmitRs from "../../../crates/grimoire-core/src/scanner_submit.rs?raw";
import { MAX_LABEL_CHARS, MAX_RUN_BYTES, MAX_RUN_FRAMES, MIN_RUN_FRAMES } from "./env";
import { frame, label, labelOver, type NamedLabel } from "./fake";
import { FINISHES, MAX_FILTER_SETS, readLabel, type Label } from "./label";

/**
 * The label's checks, and the fence between this file's shape and the engine's.
 *
 * **Nothing compiles the two together.** The engine builds a `Label` in Rust and this Worker
 * reads one in TypeScript, in two deploys, and what `readLabel` stores is rebuilt from the keys it
 * names — so a field the engine starts sending is dropped here in silence, and one this side
 * starts requiring refuses every submission from every installed app. The last block reads the
 * Rust as text, as `packages/ui/lib/ipc.test.ts` reads the structs it mirrors.
 */

const read = (value: unknown): Label | string => readLabel(JSON.stringify(value));

/** `label()` with one path replaced — `withField("card.id", 7)`, `withField("run.0.ms", 1)`. */
function withField(path: string, value: unknown): unknown {
  const whole = JSON.parse(JSON.stringify(label())) as Record<string, unknown>;
  const keys = path.split(".");
  let at = whole;
  for (const key of keys.slice(0, -1)) at = at[key] as Record<string, unknown>;
  at[keys[keys.length - 1]] = value;
  return whole;
}

/** `label()` with one path deleted. */
function without(path: string): unknown {
  const whole = JSON.parse(JSON.stringify(label())) as Record<string, unknown>;
  const keys = path.split(".");
  let at = whole;
  for (const key of keys.slice(0, -1)) at = at[key] as Record<string, unknown>;
  delete at[keys[keys.length - 1]];
  return whole;
}

describe("a label that is whole", () => {
  it("is read back as it was sent", () => {
    expect(read(label())).toEqual(label());
  });

  it("may say the scanner read nothing, at the press and in every frame", () => {
    const silent: Label = {
      ...label(),
      scanner: {
        reported: null,
        mode: "exact",
        confidence: null,
        distance: null,
        bundle: null,
        filters: { sets: [], from: null, to: null },
      },
      run: [-440, -330, -220, -110, 0].map((ms) => frame(ms, 64)),
    };
    expect(read(silent)).toEqual(silent);
  });

  it("may say there is no card in the last frame, with no finish beside it", () => {
    const empty: Label = { ...label(), card: null, finish: null };
    expect(read(empty)).toEqual(empty);
  });

  it.each(FINISHES)("takes the finish %s", (finish) => {
    expect(read(withField("finish", finish))).toMatchObject({ finish });
  });

  it("takes a name and a collector number that are not ASCII, escaped", () => {
    // `JSON.stringify` leaves these as they are spelled; the engine escapes them, and so does
    // this — the header is ASCII and the strings it decodes to are not.
    const named = withField("card.name", "Lim-Dûl’s Vault") as NamedLabel;
    named.card.number = "107★";
    const header = JSON.stringify(named).replace(
      /[\u0080-￿]/g,
      (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
    );
    expect(readLabel(header)).toEqual(named);
  });

  it("takes every frame's times as they are, in the order they were sent", () => {
    // Oldest first is the app's order and is stored as it came: this side sorts nothing.
    const sent = labelOver([64, 64, 64, 64, 64, 64]);
    const taken = read(sent) as Label;
    expect(taken.run.map((entry) => entry.ms)).toEqual([-550, -440, -330, -220, -110, 0]);
  });

  it("takes as many filtered sets as the engine sends, and no more", () => {
    const sets = Array.from({ length: MAX_FILTER_SETS }, (_, n) => `s${n}`);
    expect(read(withField("scanner.filters.sets", sets))).toMatchObject({
      scanner: { filters: { sets } },
    });
    expect(typeof read(withField("scanner.filters.sets", [...sets, "one"]))).toBe("string");
  });
});

/**
 * **The rule the whole feature is built on: all of the frames or nothing, and never a single
 * screenshot.** The scanner decides over a run, so one picture cannot say what it did. There is
 * no key in this shape a lone still can be sent in, and a run too short to be one is refused
 * like any other label that is not whole.
 */
describe("a scan is a run of frames, never one picture", () => {
  const SHORT = `a scan is a run of at least ${MIN_RUN_FRAMES} frames, never one picture`;

  it("refuses one picture, and every run shorter than a run", () => {
    for (let frames = 0; frames < MIN_RUN_FRAMES; frames += 1) {
      const lengths = Array.from({ length: frames }, () => 64);
      expect(read(labelOver(lengths)), String(frames)).toBe(SHORT);
    }
    expect(MIN_RUN_FRAMES).toBeGreaterThan(1);
  });

  it("takes the shortest run and the longest, and refuses one frame more", () => {
    const of = (frames: number): unknown => labelOver(Array.from({ length: frames }, () => 64));
    expect((read(of(MIN_RUN_FRAMES)) as Label).run).toHaveLength(MIN_RUN_FRAMES);
    expect((read(of(MAX_RUN_FRAMES)) as Label).run).toHaveLength(MAX_RUN_FRAMES);
    expect(read(of(MAX_RUN_FRAMES + 1))).toBe(
      `a scan is a run of at most ${MAX_RUN_FRAMES} frames`,
    );
  });

  it("refuses the shape that carried one still, which has no run in it", () => {
    // What this inbox was first written to take: one picture's size, and nothing else of it.
    const still = { ...(without("run") as object), frame: { width: 1920, height: 1080 } };
    expect(read(still)).toBe("that label lists no frames");
    for (const run of [null, {}, "five", 5]) {
      expect(read(withField("run", run)), JSON.stringify(run)).toBe("that label lists no frames");
    }
  });

  it("drops a still's size sent beside a run rather than storing it", () => {
    const both = { ...label(), frame: { width: 1920, height: 1080 } };
    expect(read(both)).toEqual(label());
    expect(read(both)).not.toHaveProperty("frame");
  });

  it("fits the longest run the engine sends inside the header's cap", () => {
    // Twenty frames with every figure present, under the longest name this side takes.
    const full = labelOver(Array.from({ length: MAX_RUN_FRAMES }, () => MAX_RUN_BYTES));
    full.card.name = "x".repeat(200);
    full.run = full.run.map((entry) => ({
      ...entry,
      ms: -59_999,
      lock: "acquiring",
      confidence: 0.123,
      distance: 256,
      decided: "f29ba16f-c8fb-42fe-aabf-87089cb214a7",
    }));
    const header = JSON.stringify(full);
    expect(header.length).toBeLessThan(MAX_LABEL_CHARS);
    expect(typeof readLabel(header)).toBe("object");
  });
});

describe("a label that is refused", () => {
  it("refuses none, an empty one and one that is too long", () => {
    expect(readLabel(null)).toBe("that request carried no label");
    expect(readLabel("")).toBe("that request carried no label");
    expect(readLabel(" ".repeat(MAX_LABEL_CHARS + 1))).toBe("that label is too long");
  });

  it("refuses a header that is not ASCII rather than storing what it decodes to", () => {
    // A header's bytes arrive as Latin-1: raw UTF-8 would parse without complaint, as mojibake.
    const raw = JSON.stringify(withField("card.name", "Lim-Dûl"));
    expect(readLabel(raw)).toBe("a label is ASCII JSON, with every other character escaped");
    expect(readLabel(`${JSON.stringify(label())}\u0007`)).toBe(
      "a label is ASCII JSON, with every other character escaped",
    );
  });

  it("refuses what is not a JSON object, and another version's", () => {
    expect(readLabel("{")).toBe("that label is not JSON");
    expect(readLabel("[1]")).toBe("that label is not an object");
    expect(readLabel("null")).toBe("that label is not an object");
    expect(read(withField("v", 2))).toBe("this inbox takes version 1 labels");
    expect(read(withField("v", "1"))).toBe("this inbox takes version 1 labels");
  });

  // Each row is one field made wrong in one way; every other field is whole. A row that came
  // back as a label would be a check `readLabel` does not make.
  it.each<[string, unknown]>([
    // `null` beside a finish: no card is no finish too, and half an answer is not one.
    ["card", null],
    ["card", []],
    ["card.id", "not-a-uuid"],
    ["card.id", "CE711943-C1A1-43A0-8B89-8D169CFB8E06"],
    ["card.id", 7],
    ["card.set", ""],
    ["card.set", "2X2"],
    ["card.set", "../runs"],
    ["card.number", ""],
    ["card.number", "x".repeat(33)],
    ["card.number", "1\n2"],
    ["card.lang", "english"],
    ["card.lang", "EN"],
    ["card.name", ""],
    ["card.name", "x".repeat(201)],
    ["card.name", null],
    ["finish", "shiny"],
    ["finish", null],
    ["finish", ["foil"]],
    ["scanner", null],
    ["scanner.reported", "Lightning Bolt"],
    ["scanner.reported", 0],
    ["scanner.mode", ""],
    ["scanner.mode", "Fast Mode"],
    ["scanner.confidence", -0.1],
    ["scanner.confidence", 1.1],
    ["scanner.confidence", "0.5"],
    ["scanner.distance", -1],
    ["scanner.distance", 257],
    ["scanner.distance", 1.5],
    ["scanner.bundle", -1],
    ["scanner.bundle", "98000"],
    ["scanner.filters", null],
    ["scanner.filters", []],
    ["scanner.filters.sets", null],
    ["scanner.filters.sets", "2x2"],
    ["scanner.filters.sets", ["2X2"]],
    ["scanner.filters.sets", ["2x2", 7]],
    ["scanner.filters.sets", ["../labels"]],
    ["scanner.filters.from", ""],
    ["scanner.filters.from", "8 July 2022"],
    ["scanner.filters.to", "2022-7-8"],
    ["scanner.filters.to", 20220708],
    ["app", null],
    ["app.version", ""],
    ["app.version", "0.43.0 (beta)"],
    ["app.platform", "Desktop"],
    ["app.platform", ""],
    ["run.0", null],
    ["run.0", []],
    ["run.0", "a frame"],
    ["run.4.ms", 1],
    ["run.0.ms", -60_001],
    ["run.0.ms", -110.5],
    ["run.0.ms", "-110"],
    ["run.0.bytes", 0],
    ["run.0.bytes", 2],
    ["run.0.bytes", MAX_RUN_BYTES + 1],
    ["run.0.bytes", 64.5],
    ["run.2.width", 0],
    ["run.2.width", 8193],
    ["run.2.height", 540.5],
    ["run.2.height", "540"],
    ["run.1.ok", "true"],
    ["run.1.ok", null],
    ["run.1.lock", "Locked On"],
    ["run.1.lock", ""],
    ["run.1.lock", 2],
    ["run.3.confidence", -0.1],
    ["run.3.confidence", 1.1],
    ["run.3.confidence", "0.4"],
    ["run.3.distance", 257],
    ["run.3.distance", 1.5],
    ["run.4.decided", "Lightning Bolt"],
    ["run.4.decided", 0],
    ["run.4.detail", 0],
    ["run.4.detail", null],
  ])("refuses %s = %j", (path, value) => {
    expect(typeof read(withField(path, value))).toBe("string");
  });

  it("names the frame a refusal is about", () => {
    expect(read(withField("run.3.distance", 257))).toBe(
      "that label's frame 3 has a distance that is not a count of bits",
    );
  });

  it("refuses a figure that is left out rather than null", () => {
    // The engine sends `null` for a figure the scanner did not have. A key that is missing is
    // a build that does not send it, and this side must not read the two as one.
    for (const path of [
      "scanner.reported",
      "scanner.confidence",
      "scanner.distance",
      "scanner.bundle",
      "scanner.filters",
      "scanner.filters.sets",
      "scanner.filters.from",
      "scanner.filters.to",
      "run.0.ms",
      "run.0.bytes",
      "run.0.width",
      "run.0.height",
      "run.0.ok",
      "run.0.lock",
      "run.0.confidence",
      "run.0.distance",
      "run.0.decided",
      "run.0.detail",
    ]) {
      expect(typeof read(without(path)), path).toBe("string");
    }
  });
});

describe("the engine's label, read as text", () => {
  /** A Rust struct's public field names, in order — `ipc.test.ts`'s `rustFields`, in small. */
  function fields(name: string): string[] {
    const body = new RegExp(`pub struct ${name} \\{([\\s\\S]*?)\\n\\}`).exec(scannerSubmitRs)?.[1];
    if (body === undefined) throw new Error(`scanner_submit.rs no longer declares ${name}`);
    return [...body.matchAll(/^\s*pub (\w+):/gm)].map((m) => m[1]);
  }

  it("has the keys this side reads, struct for struct, and no other", () => {
    const whole = label();
    expect(fields("Label")).toEqual(Object.keys(whole));
    expect(fields("LabelCard")).toEqual(Object.keys(whole.card));
    expect(fields("LabelScanner")).toEqual(Object.keys(whole.scanner));
    expect(fields("LabelFilters")).toEqual(Object.keys(whole.scanner.filters));
    expect(fields("LabelApp")).toEqual(Object.keys(whole.app));
    expect(fields("LabelFrame")).toEqual(Object.keys(whole.run[0]));
    // And the shape has nowhere to put one picture: the run is the only pictures there are.
    expect(fields("Label")).not.toContain("frame");
  });

  it("is sent with no rename, no default and no field left out", () => {
    // Any serde attribute on these six structs or on a field of them changes the wire with
    // every field name unmoved — a rename, a skip, a `skip_serializing_if` that leaves a `null`
    // out. So none at all: from the comment above `Label`, so an attribute on `Label` itself is
    // inside the cut, to the first thing after `LabelFrame`.
    const from = scannerSubmitRs.indexOf("/// What the inbox stores beside a run");
    const to = scannerSubmitRs.indexOf("/// The inbox this install asks");
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    const structs = scannerSubmitRs.slice(from, to);
    expect(structs.match(/pub struct \w+ \{/g)).toHaveLength(6);
    expect(structs).not.toMatch(/#\[serde\(/);
  });

  /**
   * **One label, exactly as the engine writes it, read by both suites.** The field names above
   * hold the shape; this holds the *text* — how a number, a `null` and an escaped character are
   * spelled — which is where two sides that each test against a label of their own making can
   * part with both green. The engine's suite asserts it writes these bytes
   * (`the_label_on_the_wire_is_the_one_the_inbox_is_tested_against`).
   */
  it("takes the engine's golden label whole", () => {
    const header = goldenLabel.trimEnd();
    // ASCII as it crosses, and inside the header's cap.
    expect(header).toMatch(/^[\x20-\x7e]+$/);
    expect(header.length).toBeLessThan(MAX_LABEL_CHARS);
    const acquiring = { ok: true, lock: "acquiring", distance: 44 };
    const decided = "f29ba16f-c8fb-42fe-aabf-87089cb214a7";
    expect(readLabel(header)).toEqual({
      v: 1,
      card: {
        id: "ce711943-c1a1-43a0-8b89-8d169cfb8e06",
        set: "2x2",
        number: "117★",
        lang: "en",
        name: "Lim-Dûl’s Vault",
      },
      finish: "foil",
      scanner: {
        reported: decided,
        mode: "exact",
        confidence: 0.82,
        distance: 31,
        bundle: null,
        filters: { sets: ["2x2", "lea"], from: null, to: "2022-07-08" },
      },
      app: { version: "0.43.0", platform: "android" },
      run: [
        frame(-440, 48_211),
        frame(-330, 51_877, acquiring),
        frame(-220, 52_340, acquiring),
        frame(-110, 52_102, {
          ok: true,
          lock: "locked",
          confidence: 0.413,
          distance: 31,
          detail: true,
        }),
        frame(0, 51_990, { ok: true, lock: "locked", confidence: 0.82, distance: 31, decided }),
      ],
    });
  });

  it("takes the engine's golden label with no card in it whole", () => {
    const header = goldenNoCard.trimEnd();
    expect(header).toMatch(/^[\x20-\x7e]+$/);
    const read = readLabel(header);
    expect(read).toMatchObject({ card: null, finish: null });
    // The same label as the card's golden in every other field.
    expect(read).toEqual({
      ...(readLabel(goldenLabel.trimEnd()) as Label),
      card: null,
      finish: null,
    });
  });

  it("is the version this side takes", () => {
    expect(scannerSubmitRs).toMatch(/pub const LABEL_VERSION: u8 = 1;/);
    expect(label().v).toBe(1);
  });

  it("names the finishes this side takes, in the engine's words", () => {
    const listed = /const FINISHES: \[&str; 3\] = \[([^\]]+)\];/.exec(scannerSubmitRs)?.[1];
    expect(listed, "no FINISHES in scanner_submit.rs").toBeDefined();
    expect([...(listed ?? "").matchAll(/"(\w+)"/g)].map((m) => m[1])).toEqual([...FINISHES]);
  });

  it("takes as many filtered sets as the engine keeps", () => {
    const kept = /const MAX_FILTER_SETS: usize = (\d+);/.exec(scannerSubmitRs)?.[1];
    expect(kept, "no MAX_FILTER_SETS in scanner_submit.rs").toBeDefined();
    expect(Number(kept)).toBe(MAX_FILTER_SETS);
  });
});
