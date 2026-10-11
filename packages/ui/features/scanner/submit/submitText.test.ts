import { describe, expect, it } from "vitest";
import { parseQuery } from "@/features/search/queryLanguage";
import * as text from "./submitText";

/** Every sentence the module can say: its constants, and each function at arguments that show it. */
const SAID: string[] = [
  ...Object.values(text).filter((value): value is string => typeof value === "string"),
  text.noPrintingFound("storm of saruman"),
  text.searchFailed("the card database is busy"),
  text.printingsFound(1, 1, false),
  text.printingsFound(24, 132, false),
  text.printingsFound(24, 5000, true),
  text.printingWords({ setCode: "sta", collectorNumber: "105" }),
  text.printingLabel({ name: "Lightning Bolt", setCode: "sta", collectorNumber: "105" }),
  text.chosenLine({ name: "Lightning Bolt", setCode: "sta", collectorNumber: "105" }),
];

describe("what Send scan says", () => {
  /**
   * The reader is sending *a picture* of *a card*. The words below are the scanner's own for
   * what it measured and what it holds, and a reader who meets one is being shown the machine
   * instead of being asked a question.
   */
  it("says none of the scanner's own words to a reader", () => {
    expect(SAID.length).toBeGreaterThan(20);
    const offenders = SAID.filter((sentence) =>
      /\b(verdict|votes?|distance|bundle|frames?|hash(es)?|evidence)\b/i.test(sentence),
    );
    expect(offenders).toEqual([]);
  });

  it("names the press, the dialog and the picture", () => {
    expect(text.SEND_SCAN).toBe("Send scan…");
    expect(text.SEND_TITLE).toBe("Send this scan");
    expect(text.PICTURE_ALT).toBe("The picture that will be sent");
  });

  /**
   * To the letter, because it is a promise about what leaves the device — and it has to stay a
   * true one: the privacy policy's *Sending a scan* lists the same things at length.
   */
  it("says what is sent, to whom, and what is not", () => {
    expect(text.DISCLOSURE).toBe(
      "This picture and the card you choose are sent to MTG Grimoire's maker, with what the scanner read, the app's version and which app it is, and kept to improve the scanner. Nothing from your collection is sent, and nothing is kept that says who you are. Check that the picture shows only what you mean to send.",
    );
    // Never "nothing else": the scanner's reading and the app's version go too. And never that
    // nothing is *sent* that says who they are — a request has an address; what is true, and
    // what the policy says, is that none is kept.
    expect(text.DISCLOSURE).not.toMatch(/nothing else/i);
    expect(text.DISCLOSURE).not.toMatch(/is sent, and nothing that says/i);
  });

  it("gives Send a reason for each answer it is still waiting on", () => {
    expect(text.CHOOSE_THE_CARD).toBe("Choose the card in the picture.");
    expect(text.CHOOSE_ITS_FINISH).toBe("Choose its finish.");
  });

  it("thanks the reader and tells them what the reference is for", () => {
    expect(text.SENT).toBe("Sent — thank you.");
    expect(text.KEEP_THE_REFERENCE).toBe(
      "Keep the reference if you ever want this picture deleted.",
    );
  });

  it("counts printings in words that agree with the count", () => {
    expect(text.printingsFound(1, 1, false)).toBe("1 printing");
    expect(text.printingsFound(4, 4, false)).toBe("4 printings");
    expect(text.printingsFound(24, 132, false)).toBe("Showing 24 of 132 printings");
    // The backend stopped counting: a floor, said as one, and never in the singular.
    expect(text.printingsFound(24, 5000, true)).toBe("Showing 24 of 5,000+ printings");
    expect(text.printingsFound(1, 1, true)).toBe("Showing 1 of 1+ printings");
  });

  it("spells a printing as the tray does: the set upper-cased, then the number", () => {
    const bolt = { name: "Lightning Bolt", setCode: "sta", collectorNumber: "105" };
    expect(text.printingWords(bolt)).toBe("STA 105");
    expect(text.printingLabel(bolt)).toBe("Lightning Bolt — STA 105");
    expect(text.chosenLine(bolt)).toBe("Chosen: Lightning Bolt · STA 105");
    // A row with no printing to name says the card and stops, rather than trailing a separator.
    const bare = { name: "Lightning Bolt", setCode: "", collectorNumber: "" };
    expect(text.printingLabel(bare)).toBe("Lightning Bolt");
    expect(text.chosenLine(bare)).toBe("Chosen: Lightning Bolt");
  });

  /**
   * **The hint teaches the box's real syntax.** Read through the search's own parser: a term
   * that parsed as plain words would be a hint sending the reader after a card called `s:ltr`.
   */
  it("hints at a set term the search box really reads as one", () => {
    expect(text.SET_HINT).toContain(text.SET_HINT_EXAMPLE);
    const parsed = parseQuery(`lightning bolt ${text.SET_HINT_EXAMPLE}`);
    expect(parsed.text).toBe("lightning bolt");
    expect(parsed.predicates).toHaveLength(1);
    expect(parsed.predicates[0]).toMatchObject({ field: "setCode", value: "ltr", negated: false });
  });
});
