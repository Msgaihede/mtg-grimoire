import { describe, expect, it } from "vitest";
import { drainable, pairs, plan, refusesPrune, removalPlan, unverified } from "./plan.ts";

const pair = (id: string, run = 100, label = 10) => [
  { key: `runs/${id}.bin`, size: run },
  { key: `labels/${id}.json`, size: label },
];

describe("the sync plan", () => {
  it("pairs a run with its label and leaves a lone object out", () => {
    const found = pairs([...pair("a"), { key: "runs/b.bin", size: 5 }, { key: "labels/c.json", size: 5 }]);
    expect([...found.keys()]).toEqual(["a"]);
    expect(found.get("a")).toEqual({ run: 100, label: 10 });
  });

  it("adopts what the corpus lacks, fetches what the mirror lacks, prunes what the corpus dropped", () => {
    const got = plan({
      inbox: [...pair("new"), ...pair("both"), { key: "runs/orphan.bin", size: 7 }],
      corpus: [...pair("both"), ...pair("old"), { key: "baselines/first.json", size: 3 }],
      local: ["old", "gone"],
    });
    expect(got).toEqual({
      adopt: ["new"],
      fetch: ["both", "new"],
      prune: ["gone"],
      litter: ["orphan"],
      strange: [],
      baselinesDown: ["baselines/first.json"],
    });
  });

  it("takes no pair from a key whose id could leave its folder", () => {
    const inbox = [
      { key: "runs/../../x.bin", size: 1 },
      { key: "labels/../../x.json", size: 1 },
    ];
    expect(pairs(inbox).size).toBe(0);
    const got = plan({ inbox, corpus: [], local: [] });
    expect(got.adopt).toEqual([]);
    expect(got.litter).toEqual([]);
    expect(got.strange).toEqual(["runs/../../x.bin", "labels/../../x.json"]);
  });

  it("refuses to prune a mirror against a corpus that lists as empty", () => {
    expect(refusesPrune(0, 3)).toBe(true);
    expect(refusesPrune(0, 0)).toBe(false);
    expect(refusesPrune(2, 3)).toBe(false);
  });

  it("calls a run with no label litter and never adopts it", () => {
    const got = plan({ inbox: [{ key: "runs/x.bin", size: 1 }], corpus: [], local: [] });
    expect(got.adopt).toEqual([]);
    expect(got.litter).toEqual(["x"]);
  });

  it("drains only a pair whose copy has the inbox's sizes", () => {
    const inbox = [...pair("ok"), ...pair("short"), ...pair("missing")];
    const corpusAfter = [...pair("ok"), ...pair("short", 99), { key: "runs/missing.bin", size: 100 }];
    expect(drainable(["ok", "short", "missing"], inbox, corpusAfter)).toEqual(["ok"]);
  });

  it("drains a pair an earlier pull adopted, not only one adopted now", () => {
    const inbox = [...pair("earlier"), ...pair("differs"), ...pair("now")];
    const corpusAfter = [...pair("earlier"), ...pair("differs", 100, 11), ...pair("now")];
    const everyInboxPair = [...pairs(inbox).keys()];
    expect(drainable(everyInboxPair, inbox, corpusAfter)).toEqual(["earlier", "now"]);
  });

  it("names the adopted ids whose copy is missing or of other sizes", () => {
    const inbox = [...pair("ok"), ...pair("short"), ...pair("missing")];
    const corpusAfter = [...pair("ok"), ...pair("short", 99)];
    expect(unverified(["ok", "short", "missing"], inbox, corpusAfter)).toEqual(["short", "missing"]);
  });
});

describe("the safe id", () => {
  it("is never adopted from a key that would read as a flag: it is strange, not a pair", () => {
    const real = "20261011T101500Z-9f8a0c1d2e3f4a5b";
    const keys = [...pair("--yes"), ...pair("-x"), ...pair(real)];
    const p = plan({ inbox: keys, corpus: [], local: [] });
    expect(p.adopt).toEqual([real]);
    expect(p.strange).toEqual(["runs/--yes.bin", "labels/--yes.json", "runs/-x.bin", "labels/-x.json"]);
    expect(pairs(keys).has("--yes")).toBe(false);
  });
});

describe("removalPlan", () => {
  const e = (key: string) => ({ key, size: 1 });
  const pair = (id: string) => [e(`runs/${id}.bin`), e(`labels/${id}.json`)];

  it("deletes the inbox before the corpus and a label before its run", () => {
    const [r] = removalPlan(["a"], pair("a"), pair("a"), ["a"]);
    expect(r).toMatchObject({ id: "a", inbox: "both", corpus: "both", local: true, notFound: false });
    expect(r.deletions).toEqual([
      { bucket: "inbox", key: "labels/a.json" },
      { bucket: "inbox", key: "runs/a.bin" },
      { bucket: "corpus", key: "labels/a.json" },
      { bucket: "corpus", key: "runs/a.bin" },
    ]);
  });

  it("deletes only what was listed: a half pair in one bucket, a lone run, an unlisted object", () => {
    const [r] = removalPlan(["a"], [e("runs/a.bin")], [e("labels/a.json"), e("labels/a.json.bak")], []);
    expect(r).toMatchObject({ inbox: "run", corpus: "label", local: false, notFound: false });
    expect(r.deletions).toEqual([
      { bucket: "inbox", key: "runs/a.bin" },
      { bucket: "corpus", key: "labels/a.json" },
    ]);
  });

  it("finds an id held only by the mirror, and reports one found nowhere", () => {
    const [here, nowhere] = removalPlan(["a", "b"], pair("c"), pair("c"), ["a"]);
    expect(here).toMatchObject({ local: true, inbox: null, corpus: null, notFound: false, deletions: [] });
    expect(nowhere).toMatchObject({ id: "b", notFound: true, deletions: [] });
  });

  it("keeps the order of the ids and never touches another scan's keys", () => {
    const plans = removalPlan(["b", "a"], [...pair("a"), ...pair("b"), ...pair("ab")], pair("a"), []);
    expect(plans.map((p) => p.id)).toEqual(["b", "a"]);
    expect(plans.flatMap((p) => p.deletions.map((d) => d.key))).not.toContain("runs/ab.bin");
  });
});
