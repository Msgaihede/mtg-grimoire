import { describe, expect, it } from "vitest";
import { parseQuery } from "@/features/search/queryLanguage";
import * as text from "./submitText";

/** Everything the module exports, widened: constants are literal types, and the rest functions. */
const EXPORTED: unknown[] = Object.values(text);

/** Every sentence the module can say: its constants, and each function at arguments that show it. */
const SAID: string[] = [
  ...EXPORTED.filter((value): value is string => typeof value === "string"),
  text.noPrintingFound("storm of saruman"),
  text.searchFailed("the card database is busy"),
  text.printingsFound(1, 1, false),
  text.printingsFound(24, 132, false),
  text.printingsFound(24, 5000, true),
  text.printingWords({ setCode: "sta", collectorNumber: "105" }),
  text.printingLabel({ name: "Lightning Bolt", setCode: "sta", collectorNumber: "105" }),
  text.chosenLine({ name: "Lightning Bolt", setCode: "sta", collectorNumber: "105" }),
  text.pictureOf(7, 18),
  text.pictureAlt(7, 18),
  text.pictureLine(7, 18, -1210),
  text.pictureLine(18, 18, -8),
  text.disclosure(18),
];

describe("what Send scan says", () => {
  /**
   * The reader is sending *pictures* of *a card*. The words below are the scanner's own for
   * what it measured and what it holds — and a scan's pictures are *frames* to it and never to a
   * reader — so a reader who meets one is being shown the machine instead of being asked a
   * question.
   */
  it("says none of the scanner's own words to a reader", () => {
    expect(SAID.length).toBeGreaterThan(25);
    const offenders = SAID.filter((sentence) =>
      /\b(verdict|votes?|distance|bundle|frames?|hash(es)?|evidence)\b/i.test(sentence),
    );
    expect(offenders).toEqual([]);
  });

  it("names the press and the dialog", () => {
    expect(text.SEND_SCAN).toBe("Send scan…");
    expect(text.SEND_TITLE).toBe("Send this scan");
  });

  /** Which picture, and what it is for — what it shows is whatever was in front of the lens. */
  it("names a picture by its place in the scan", () => {
    expect(text.PICTURE).toBe("Picture");
    expect(text.pictureOf(7, 18)).toBe("Picture 7 of 18");
    expect(text.pictureAlt(7, 18)).toBe("Picture 7 of 18 that will be sent");
    expect(text.pictureAlt(18, 18)).toBe("Picture 18 of 18 that will be sent");
  });

  /**
   * Under the picture: which one, and when. The last is named for what it is to the reader —
   * the moment they pressed — whatever its own clock says, because it is the picture their
   * answer is about.
   */
  it("says when each picture was taken, counted back from the press", () => {
    expect(text.pictureLine(7, 18, -1210)).toBe("Picture 7 of 18 · 1.2 s before you pressed");
    expect(text.pictureLine(1, 18, -2000)).toBe("Picture 1 of 18 · 2.0 s before you pressed");
    expect(text.pictureLine(17, 18, -118)).toBe("Picture 17 of 18 · 0.1 s before you pressed");
    expect(text.pictureLine(18, 18, -8)).toBe("Picture 18 of 18 · the moment you pressed");
    expect(text.pictureLine(18, 18, -400)).toBe("Picture 18 of 18 · the moment you pressed");
    // Never `0.0 s before`, which would say two pictures were taken at once.
    expect(text.pictureLine(17, 18, -20)).toBe("Picture 17 of 18 · 0.1 s before you pressed");
    expect(text.pictureLine(17, 18, 0)).toBe("Picture 17 of 18 · 0.1 s before you pressed");
  });

  it("names the two things the pictures' press says", () => {
    expect(text.PLAY).toBe("Play");
    expect(text.STOP_PLAYING).toBe("Stop");
  });

  /**
   * To the letter, because it is a promise about what leaves the device — and it has to stay a
   * true one: the privacy policy's *Sending a scan* lists the same things at length. **It counts
   * the pictures**: a press sends the last couple of seconds the scanner saw, not the one picture
   * on screen, and that is the thing a reader could not have guessed.
   */
  it("says how many pictures are sent, to whom, and what is not", () => {
    expect(text.disclosure(18)).toBe(
      "These 18 pictures — the last couple of seconds the scanner saw — and the card you choose are sent to MTG Grimoire's maker, with what the scanner read and how it was set, the app's version and which app it is, and kept to improve the scanner. Nothing from your collection is sent, and nothing is kept that says who you are. Look through them and check they show only what you mean to send.",
    );
    expect(text.disclosure(5)).toMatch(/^These 5 pictures — /);
    // Never "nothing else": the scanner's reading and the app's version go too. And never that
    // nothing is *sent* that says who they are — a request has an address; what is true, and
    // what the policy says, is that none is kept.
    for (const count of [5, 18, 20]) {
      expect(text.disclosure(count)).not.toMatch(/nothing else/i);
      expect(text.disclosure(count)).not.toMatch(/is sent, and nothing that says/i);
      expect(text.disclosure(count)).toMatch(/nothing is kept that says who you are/);
    }
  });

  /** A press too soon: what is missing, and the one thing there is to do about it. */
  it("says what to do when there is not enough of a scan to send", () => {
    expect(text.SCAN_TOO_SHORT).toBe(
      "Not enough of the scan yet. Hold the card under the camera a moment and press again.",
    );
  });

  /** *The last picture*: a run can begin on one card and end on another. */
  it("asks about the card in the last picture, in the question and in the reason", () => {
    expect(text.WHICH_CARD).toBe("Which card is in the last picture?");
    expect(text.CHOOSE_THE_CARD).toBe("Choose the card in the last picture.");
    expect(text.CHOOSE_ITS_FINISH).toBe("Choose its finish.");
  });

  it("thanks the reader and tells them what the reference is for", () => {
    expect(text.SENT).toBe("Sent — thank you.");
    expect(text.KEEP_THE_REFERENCE).toBe(
      "Keep the reference if you ever want these pictures deleted.",
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
