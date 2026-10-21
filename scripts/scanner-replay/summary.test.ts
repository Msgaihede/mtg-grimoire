import { describe, expect, it } from "vitest";
import { pass, results, run } from "./fixture.ts";
import { parseResults } from "./results.ts";
import { breakdowns, compare, percent, summaryMarkdown, tally } from "./summary.ts";

const four = [
  run({ id: "a", scores: ["printing", "printing", "printing"] }),
  run({ id: "b", scores: ["card", "wrong", "printing"], finish: "foil" }),
  run({ id: "c", scores: ["wrong", "undecided", "undecided"], finish: "foil", platform: "android" }),
  run({ id: "d", scores: ["error", "error", "error"] }),
];

describe("the replay's summary", () => {
  it("counts a pass, with the right card holding the right printing", () => {
    expect(tally(four, "As scanned")).toMatchObject({ n: 4, printing: 1, card: 2, wrong: 1, undecided: 0, error: 1 });
    expect(tally(four, "Fast")).toMatchObject({ printing: 1, card: 1, wrong: 1, undecided: 1 });
  });

  it("counts and tables a Neural pass beside the other three", () => {
    const runs = [
      run({ id: "n1", passes: [pass("As scanned", "undecided"), pass("Neural", "printing")] }),
      run({ id: "n2", passes: [pass("As scanned", "wrong"), pass("Neural", "card")] }),
    ];
    expect(tally(runs, "Neural")).toMatchObject({ n: 2, printing: 1, card: 2, wrong: 0 });
    expect(summaryMarkdown(results(runs), null)).toMatch(/^\| Neural \|/m);
  });

  it("takes the median of the frames a decision took, over the runs that decided", () => {
    const runs = [5, 9, 12].map((n, i) =>
      run({ id: String(i), passes: [pass("As scanned", "printing", { first_decision_frame: n })] }),
    );
    expect(tally(runs, "As scanned").medianFrames).toBe(9);
    expect(tally([run({ scores: ["undecided", "undecided", "undecided"] })], "Fast").medianFrames).toBeNull();
  });

  it("breaks the runs down by finish, platform, mode and detail", () => {
    const parts = breakdowns(four);
    const sizes = Object.fromEntries(parts.map((p) => [`${p.by}=${p.value}`, p.runs.length]));
    expect(sizes).toMatchObject({ "finish=foil": 2, "finish=nonfoil": 2, "platform=android": 1, "detail=no": 4 });
  });

  it("names every run that flipped against a baseline, by pass", () => {
    const base = results(four);
    const now = results([
      run({ id: "a", scores: ["wrong", "printing", "printing"] }),
      run({ id: "b", scores: ["printing", "wrong", "printing"], finish: "foil" }),
      run({ id: "c", scores: ["wrong", "card", "undecided"], finish: "foil" }),
      run({ id: "e" }),
    ]);
    const delta = compare(now, base);
    expect(delta.broken).toEqual([{ id: "a", name: "Lightning Bolt", pass: "As scanned", from: "printing", to: "wrong" }]);
    expect(delta.fixed).toEqual([{ id: "b", name: "Lightning Bolt", pass: "As scanned", from: "card", to: "printing" }]);
    expect(delta.moved).toEqual([{ id: "c", name: "Lightning Bolt", pass: "Fast", from: "undecided", to: "card" }]);
    expect(delta.added).toEqual(["e"]);
    expect(delta.removed).toEqual(["d"]);
  });

  it("ranks printing, card, undecided, wrong: a fall from printing or card to wrong is broken, other moves are moved", () => {
    const base = results([
      run({ id: "a", scores: ["card", "printing", "printing"] }),
      run({ id: "b", scores: ["undecided", "printing", "printing"] }),
      run({ id: "c", scores: ["undecided", "card", "printing"] }),
      run({ id: "d", scores: ["wrong", "printing", "printing"] }),
    ]);
    const now = results([
      run({ id: "a", scores: ["wrong", "printing", "printing"] }),
      run({ id: "b", scores: ["wrong", "printing", "printing"] }),
      run({ id: "c", scores: ["card", "card", "printing"] }),
      run({ id: "d", scores: ["printing", "printing", "printing"] }),
    ]);
    const delta = compare(now, base);
    expect(delta.broken.map((f) => `${f.id}:${f.from}>${f.to}`)).toEqual(["a:card>wrong"]);
    expect(delta.fixed.map((f) => `${f.id}:${f.from}>${f.to}`)).toEqual(["d:wrong>printing"]);
    expect(delta.moved.map((f) => `${f.id}:${f.from}>${f.to}`)).toEqual(["b:undecided>wrong", "c:undecided>card"]);
  });

  it("writes a table whose percentages leave the errors out", () => {
    const text = summaryMarkdown(results(four, { skipped: [{ id: "z", why: "run: not found" }] }), null);
    expect(text).toContain("4 scans, 1 skipped");
    expect(text).toContain("| As scanned | 4 | 33.3 | 66.7 | 1 | 0.0 | 1 |");
    expect(text).toContain("commit `abc1234`");
    expect(text).not.toContain("Against");
  });

  it("says when a baseline ran against another bundle or another commit", () => {
    const base = results(four, { commit: "old0000", bundle_printings: 100 });
    const text = summaryMarkdown(results(four), base);
    expect(text).toContain("Against `old0000`");
    expect(text).toContain("another bundle (100 printings then, 113494 now)");
    expect(text).toContain("No scan changed.");
  });

  it("refuses results of another version", () => {
    expect(() => parseResults('{"v":2}')).toThrow("results version 2 is not 1");
  });

  it("counts only the runs that have the pass, and keeps a share from reading as a percent of nothing", () => {
    const runs = [run({ id: "x", passes: [pass("As scanned", "printing")] }), run({ id: "y", scores: ["error", "error", "error"] })];
    expect(tally(runs, "Fast").n).toBe(1);
    expect(tally([runs[0]], "Fast").n).toBe(0);
    expect(percent(0, tally([runs[1]], "As scanned"))).toBe("—");
  });

  it("puts any change to or from an error among the moved, never the fixed or broken", () => {
    const base = results([run({ id: "a", scores: ["error", "printing", "printing"] }), run({ id: "b" })]);
    const now = results([run({ id: "a" }), run({ id: "b", scores: ["error", "printing", "printing"] })]);
    const delta = compare(now, base);
    expect(delta.fixed).toEqual([]);
    expect(delta.broken).toEqual([]);
    expect(delta.moved.map((f) => `${f.id}:${f.from}>${f.to}`)).toEqual(["a:error>printing", "b:printing>error"]);
  });

  it("keeps a value from the file from breaking a table row or a list line", () => {
    const hostile = run({
      id: "p|q",
      card: { id: "c", set: "s", number: "1", lang: "en", name: "Evil | Name\nsecond line" },
      finish: "foil|x",
      platform: "a\r\nb",
    });
    const text = summaryMarkdown(results([hostile], { skipped: [{ id: "z\nz", why: "no | way\nat all" }] }), results([run({ id: "p|q", scores: ["wrong", "printing", "printing"] })]));
    expect(text).toContain("finish: foil\\|x |");
    expect(text).toContain("platform: a b |");
    expect(text).toContain("- `z z` — no \\| way at all");
    expect(text).toContain("Evil \\| Name second line");
    for (const line of text.split("\n")) expect(line).not.toMatch(/^second line/);
  });

  it("splits the undecided into those that never got to try", () => {
    const runs = [
      run({ id: "a", passes: [pass("Exact", "undecided", { resolve_ran: false })] }),
      run({ id: "b", passes: [pass("Exact", "undecided", { resolve_ran: true })] }),
      run({ id: "c", passes: [pass("Exact", "printing", { resolve_ran: false })] }),
    ];
    expect(tally(runs, "Exact")).toMatchObject({ undecided: 2, unresolved: 1 });
    const text = summaryMarkdown(results(runs), null);
    expect(text).toContain("never resolved");
    expect(text).toMatch(/\| Exact \| 3 \| 33\.3 \| 33\.3 \| 0 \| 66\.7 \| 0 \| 1 \| 0 \| 0 \| — \| — \| 9 \| 1 \|/);
  });

  it("counts what the floor and the bar are read on: resolved right, resolved wrong printing, and the ambiguous ones' choices", () => {
    const runs = [
      run({ id: "a", passes: [pass("Neural", "printing", { settled: "right_printing" })] }),
      run({ id: "b", passes: [pass("Neural", "card", { settled: "wrong_printing" })] }),
      run({ id: "c", passes: [pass("Neural", "printing", { ambiguous: true, settled: "ambiguous", choices: 3 })] }),
      run({ id: "d", passes: [pass("Neural", "card", { ambiguous: true, settled: "ambiguous", choices: 3 })] }),
      run({ id: "e", passes: [pass("Neural", "wrong", { ambiguous: true, settled: "ambiguous", choices: 28 })] }),
    ];
    const t = tally(runs, "Neural");
    expect(t).toMatchObject({ resolvedRight: 1, resolvedWrongPrinting: 1, ambiguous: 3, medianChoices: 3 });
    expect(t.meanChoices).toBeCloseTo(11.33, 2);
    const text = summaryMarkdown(results(runs), null);
    expect(text).toContain("resolved right | resolved wrong printing | ambiguous | median choices | mean choices");
    expect(text).toMatch(/\| Neural \| 5 \|.* \| 1 \| 1 \| 3 \| 3 \| 11\.3 \|/);
    expect(tally([run({ passes: [pass("Neural", "printing", { settled: "right_printing" })] })], "Neural")).toMatchObject({
      medianChoices: null,
      meanChoices: null,
    });
  });

  it("counts a replay that could not be compared apart from one that differed", () => {
    const text = summaryMarkdown(results([run({ decided_differs: null }), run({ id: "b", decided_differs: 1 })]), null);
    expect(text).toContain("1 replayed with a different decision");
    expect(text).toContain("1 not comparable frame by frame");
  });

  it("counts a decision made then lost apart from one that never was, both inside undecided", () => {
    const runs = [
      run({ id: "a", passes: [pass("Fast", "undecided", { decision_frame: 6, first_decision_frame: 6 })] }),
      run({ id: "b", passes: [pass("Fast", "undecided", { resolve_ran: false, decision_frame: null })] }),
      run({ id: "c", passes: [pass("Fast", "undecided")] }),
    ];
    expect(tally(runs, "Fast")).toMatchObject({ undecided: 3, lost: 1, unresolved: 1 });
    expect(summaryMarkdown(results(runs), null)).toContain("decided then lost");
  });
});
