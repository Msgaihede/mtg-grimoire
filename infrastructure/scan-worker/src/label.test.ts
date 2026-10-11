import { describe, expect, it } from "vitest";
import goldenLabel from "../../../crates/grimoire-core/src/__golden__/scan-label.txt?raw";
import scannerSubmitRs from "../../../crates/grimoire-core/src/scanner_submit.rs?raw";
import { MAX_LABEL_CHARS } from "./env";
import { label } from "./fake";
import { FINISHES, readLabel, type Label } from "./label";

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

/** `label()` with one path replaced — `with("card.id", 7)`. */
function withField(path: string, value: unknown): unknown {
  const whole = JSON.parse(JSON.stringify(label())) as Record<string, unknown>;
  const keys = path.split(".");
  let at = whole;
  for (const key of keys.slice(0, -1)) at = at[key] as Record<string, unknown>;
  at[keys[keys.length - 1]] = value;
  return whole;
}

describe("a label that is whole", () => {
  it("is read back as it was sent", () => {
    expect(read(label())).toEqual(label());
  });

  it("may say the scanner read nothing", () => {
    const silent = {
      ...label(),
      scanner: { reported: null, mode: "exact", confidence: null, distance: null, bundle: null },
    };
    expect(read(silent)).toEqual(silent);
  });

  it.each(FINISHES)("takes the finish %s", (finish) => {
    expect(read(withField("finish", finish))).toMatchObject({ finish });
  });

  it("takes a name and a collector number that are not ASCII, escaped", () => {
    // `JSON.stringify` leaves these as they are spelled; the engine escapes them, and so does
    // this — the header is ASCII and the strings it decodes to are not.
    const named = withField("card.name", "Lim-Dûl’s Vault") as Label;
    named.card.number = "107★";
    const header = JSON.stringify(named).replace(
      /[\u0080-￿]/g,
      (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
    );
    expect(readLabel(header)).toEqual(named);
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
    ["card", null],
    ["card", []],
    ["card.id", "not-a-uuid"],
    ["card.id", "CE711943-C1A1-43A0-8B89-8D169CFB8E06"],
    ["card.id", 7],
    ["card.set", ""],
    ["card.set", "2X2"],
    ["card.set", "../frames"],
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
    ["app", null],
    ["app.version", ""],
    ["app.version", "0.43.0 (beta)"],
    ["app.platform", "Desktop"],
    ["app.platform", ""],
    ["frame", null],
    ["frame.width", 0],
    ["frame.width", 8193],
    ["frame.height", 1080.5],
    ["frame.height", "1080"],
  ])("refuses %s = %j", (path, value) => {
    expect(typeof read(withField(path, value))).toBe("string");
  });

  it("refuses a figure that is left out rather than null", () => {
    // The engine sends `null` for a figure the scanner did not have. A key that is missing is
    // a build that does not send it, and this side must not read the two as one.
    for (const key of ["reported", "confidence", "distance", "bundle"]) {
      const sent = JSON.parse(JSON.stringify(label())) as { scanner: Record<string, unknown> };
      delete sent.scanner[key];
      expect(typeof read(sent), key).toBe("string");
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
    expect(fields("LabelApp")).toEqual(Object.keys(whole.app));
    expect(fields("LabelFrame")).toEqual(Object.keys(whole.frame));
  });

  it("is sent with no rename, no default and no field left out", () => {
    // Any serde attribute on these five structs or on a field of them changes the wire with
    // every field name unmoved — a rename, a skip, a `skip_serializing_if` that leaves a `null`
    // out. So none at all: from the comment above `Label`, so an attribute on `Label` itself is
    // inside the cut, to the first thing after `LabelFrame`.
    const from = scannerSubmitRs.indexOf("/// What the inbox stores beside a picture");
    const to = scannerSubmitRs.indexOf("/// The inbox this install asks");
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    const structs = scannerSubmitRs.slice(from, to);
    expect(structs.match(/pub struct \w+ \{/g)).toHaveLength(5);
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
        reported: "f29ba16f-c8fb-42fe-aabf-87089cb214a7",
        mode: "exact",
        confidence: 0.82,
        distance: 31,
        bundle: null,
      },
      app: { version: "0.43.0", platform: "android" },
      frame: { width: 1920, height: 1080 },
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
});
