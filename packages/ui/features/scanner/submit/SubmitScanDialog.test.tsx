import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CardSummary, ScannerSubmitted, SearchRequest, SearchResponse } from "@/lib/ipc";

vi.mock("@/lib/ipc", async (orig) => {
  const real = await orig<typeof import("@/lib/ipc")>();
  return {
    ...real,
    ipc: {
      ...real.ipc,
      // Both typed by what they answer: a bare `vi.fn()` would take any shape a test handed it,
      // and the page would be drawing a row the real command cannot send.
      searchCards: vi.fn(
        async (): Promise<SearchResponse> => ({ items: [], total: 0, totalIsCapped: false }),
      ),
      scannerSubmit: vi.fn(async (): Promise<ScannerSubmitted> => ({ id: "unset" })),
    },
  };
});

import { ipc } from "@/lib/ipc";
import { STATUS, VERDICTS } from "../fixtures";
import type { ScanFilters, ScannerSubmissionFrame } from "../types";
import { runClock, runFrameOf, type RunFrame, type ScanRun } from "./run";
import { SubmitScanDialog } from "./SubmitScanDialog";
import {
  CHOOSE_ITS_FINISH,
  CHOOSE_THE_CARD,
  disclosure,
  FINISH_NEEDS_CARD,
  KEEP_THE_REFERENCE,
  ONE_FINISH,
  SEARCH_PROMPT,
  SET_HINT,
  WHICH_CARD,
} from "./submitText";
import { useScanSubmit } from "./useScanSubmit";

/** One printing as the search answers it — the columns a tile and the finish group read. */
function printing(
  over: Partial<CardSummary> & Pick<CardSummary, "id" | "setCode" | "collectorNumber">,
): CardSummary {
  return {
    name: "Lightning Bolt",
    setName: null,
    rarity: "common",
    typeLine: "Instant",
    manaCost: "{R}",
    price: null,
    layout: "normal",
    oracleId: "bolt",
    finishes: '["nonfoil"]',
    promoTypes: null,
    gameChanger: false,
    ownedQuantity: 0,
    wishlisted: false,
    printings: 1,
    priceLow: null,
    priceHigh: null,
    ...over,
  };
}

/** Sold one way, two ways, three ways, in foil alone, and in nobody-knows — every shape the
 *  finish group takes. */
const LEA = printing({ id: "bolt-lea", setCode: "lea", collectorNumber: "161" });
const DBL = printing({
  id: "bolt-2x2",
  setCode: "2x2",
  collectorNumber: "117",
  finishes: '["nonfoil","foil"]',
});
const STA = printing({
  id: "bolt-sta",
  setCode: "sta",
  collectorNumber: "105",
  setName: "Strixhaven Mystical Archive",
  finishes: '["nonfoil","foil","etched"]',
});
const JGP = printing({ id: "bolt-jgp", setCode: "jgp", collectorNumber: "1", finishes: '["foil"]' });
const UNKNOWN = printing({ id: "bolt-plst", setCode: "plst", collectorNumber: "A25-141", finishes: null });
const BOLTS = [LEA, DBL, STA, JGP, UNKNOWN];
const SARUMAN = printing({
  id: "saruman-ltr",
  name: "Storm of Saruman",
  setCode: "ltr",
  collectorNumber: "72",
  finishes: '["nonfoil","foil"]',
});

const page = (items: CardSummary[], total = items.length, totalIsCapped = false): SearchResponse => ({
  items,
  total,
  totalIsCapped,
});

const NO_FILTERS: ScanFilters = { sets: [], released_from: null, released_to: null };

/**
 * A run of six frames, each a byte's worth of text a test can tell from the others — the
 * scanner found no card in the first, weighed one through the middle, and had decided on the
 * wrong Bolt by the last two.
 */
const FRAMES: ScannerSubmissionFrame[] = ["AQ==", "Ag==", "Aw==", "BA==", "BQ==", "Bg=="].map(
  (jpeg, index, all) => ({
    jpeg,
    ms: -8 - (all.length - 1 - index) * 110,
    ok: index > 0,
    lock: index > 1 ? "locked" : "acquiring",
    confidence: index === 0 ? null : 0.82,
    distance: index === 0 ? null : 36,
    decided: index >= 4 ? "bolt-2x2" : null,
    detail: index === 3,
  }),
);
const LAST_PICTURE = `data:image/jpeg;base64,${FRAMES[FRAMES.length - 1].jpeg}`;

/** The run, and a scanner that had led with the wrong Bolt under one set's filter. */
const RUN: ScanRun = {
  frames: FRAMES,
  said: {
    reported: "bolt-2x2",
    mode: "exact",
    confidence: 0.82,
    distance: 36,
    bundle: 117630,
    filters: { sets: ["2x2"], released_from: null, released_to: null },
  },
  leadName: "Lightning Bolt",
};

const REFERENCE = "20261011T101500Z-0123456789abcdef";
const INBOX_FULL = "The scan inbox is full for now. Thank you — try again in a few days.";

function open(run: ScanRun | null = RUN) {
  const onDismiss = vi.fn();
  const onClose = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <SubmitScanDialog run={run} onDismiss={onDismiss} onClose={onClose} />
    </QueryClientProvider>,
  );
  return { onDismiss, onClose, ...view };
}

const dialog = () => screen.getByRole("dialog", { name: "Send this scan" });
/**
 * The one picture of the run that is showing — the rest are mounted and `hidden`. By its name,
 * because every printing's tile is a picture too.
 */
const picture = () => within(dialog()).getByRole("img", { name: /^Picture \d+ of \d+ that will be sent$/ });
const slider = () => within(dialog()).getByRole("slider", { name: "Picture" });
const printings = () => screen.findByRole("radiogroup", { name: "Printings" });
const finishes = () => screen.getByRole("radiogroup", { name: "Finish" });
const send = () => screen.getByRole("button", { name: /^(Send scan|Sending…)$/ });
const tile = async (name: string) => within(await printings()).findByRole("radio", { name });
const finish = (name: string) => within(finishes()).getByRole("radio", { name });
const checked = (group: HTMLElement) => within(group).queryAllByRole("radio", { checked: true });

/** Choose a printing and, where one is named, a finish. */
async function answer(printingName: string, finishName?: string) {
  await userEvent.click(await tile(printingName));
  if (finishName !== undefined) await userEvent.click(finish(finishName));
}

beforeEach(() => {
  vi.mocked(ipc.searchCards).mockImplementation(async (req: SearchRequest) =>
    (req.text ?? "").toLowerCase().includes("bolt") ? page(BOLTS) : page([SARUMAN]),
  );
  vi.mocked(ipc.scannerSubmit).mockResolvedValue({ id: REFERENCE });
});
afterEach(() => {
  vi.mocked(ipc.searchCards).mockReset();
  vi.mocked(ipc.scannerSubmit).mockReset();
});

describe("SubmitScanDialog", () => {
  it("mounts nothing while there is no run", () => {
    open(null);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(ipc.searchCards).not.toHaveBeenCalled();
  });

  /**
   * What the reader looks through and what is sent are the same strings, each drawn behind a
   * `data:` scheme. The dialog rests on the last of them: the card the reader's answer names.
   */
  it("rests on the last picture of the run, out of the text that will be sent", () => {
    open();
    expect(picture()).toHaveAttribute("src", LAST_PICTURE);
    expect(picture()).toHaveAttribute("alt", "Picture 6 of 6 that will be sent");
    expect(within(dialog()).getByText("Picture 6 of 6 · the moment you pressed")).toBeInTheDocument();
    // Never an object URL: the shipped policy allows no `blob:` picture on any host.
    expect(picture().getAttribute("src")).not.toMatch(/^blob:/);
  });

  /**
   * The reader is asked to check every picture, so every one is a place the slider stops — and
   * nothing about looking through them touches the two answers.
   */
  it("walks every picture of the run on the slider, and leaves the answers alone", async () => {
    open();
    await answer("Lightning Bolt — STA 105", "Foil");
    expect(slider()).toHaveAttribute("max", String(FRAMES.length));
    expect(slider()).toHaveValue(String(FRAMES.length));

    for (let n = 1; n <= FRAMES.length; n++) {
      fireEvent.change(slider(), { target: { value: String(n) } });
      expect(picture()).toHaveAttribute("src", `data:image/jpeg;base64,${FRAMES[n - 1].jpeg}`);
      expect(slider()).toHaveAttribute("aria-valuetext", `Picture ${n} of 6`);
    }
    fireEvent.change(slider(), { target: { value: "2" } });
    expect(within(dialog()).getByText("Picture 2 of 6 · 0.4 s before you pressed")).toBeInTheDocument();

    expect(await tile("Lightning Bolt — STA 105")).toHaveAttribute("aria-checked", "true");
    expect(finish("Foil")).toHaveAttribute("aria-checked", "true");
    // Whichever picture is showing, what is sent is the whole run — the next test's call.
    expect(send()).not.toHaveAttribute("aria-disabled");
  });

  /** Nothing moves until the reader asks: a dialog that opened playing would not be showing the
   *  picture it asks about. */
  it("offers Play, and plays nothing by itself", async () => {
    open();
    expect(within(dialog()).getByRole("button", { name: "Play" })).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(picture()).toHaveAttribute("src", LAST_PICTURE);
  });

  it("opens the search on the scanner's card and draws every printing it finds", async () => {
    open();
    expect(screen.getByRole("searchbox", { name: WHICH_CARD })).toHaveValue("Lightning Bolt");
    const group = await printings();
    expect(within(group).getAllByRole("radio").map((radio) => radio.getAttribute("aria-label"))).toEqual([
      "Lightning Bolt — LEA 161",
      "Lightning Bolt — 2X2 117",
      "Lightning Bolt — STA 105",
      "Lightning Bolt — JGP 1",
      "Lightning Bolt — PLST A25-141",
    ]);
    // Each is captioned with its set and number in type, since a set symbol this small is a smudge.
    expect(within(await tile("Lightning Bolt — STA 105")).getByText("STA 105")).toBeInTheDocument();
    expect(screen.getByText("5 printings")).toBeInTheDocument();
    // Asked at once — the prefill is not a keystroke to wait out — uncollapsed, with the
    // unplayable printings left in.
    expect(ipc.searchCards).toHaveBeenCalledTimes(1);
    expect(ipc.searchCards).toHaveBeenCalledWith({
      text: "Lightning Bolt",
      collapse: false,
      playableOnly: false,
      limit: 24,
      offset: 0,
    });
  });

  /**
   * The owner's rule (issue #776): the reader says which card and which finish. The scanner's
   * guess opens the search and selects nothing — a tile already ringed is a label nobody gave.
   */
  it("has nothing chosen, and will not send until the reader has answered", async () => {
    open();
    const group = await printings();
    expect(checked(group)).toHaveLength(0);
    // The scanner's own answer is among the tiles, and is not chosen for the reader.
    expect(await tile("Lightning Bolt — 2X2 117")).toHaveAttribute("aria-checked", "false");

    expect(send()).toHaveAttribute("aria-disabled", "true");
    expect(send()).toHaveAccessibleDescription(CHOOSE_THE_CARD);
    expect(screen.getByText(CHOOSE_THE_CARD)).toBeVisible();

    // The finishes wait on the card: all three drawn, none within reach, and a sentence why.
    const waiting = within(finishes()).getAllByRole("radio");
    expect(waiting.map((radio) => radio.textContent)).toEqual(["Nonfoil", "Foil", "Etched"]);
    for (const radio of waiting) expect(radio).toHaveAttribute("aria-disabled", "true");
    expect(finishes()).toHaveAccessibleDescription(FINISH_NEEDS_CARD);
    await userEvent.click(finish("Foil"));
    expect(checked(finishes())).toHaveLength(0);

    await userEvent.click(send());
    expect(ipc.scannerSubmit).not.toHaveBeenCalled();
  });

  /**
   * **The second question is brought into view when there is one to answer** — on a phone the
   * finishes sit under the scroller's fold, and a reader told "Choose its finish." could not see
   * a finish to choose (seen in a real window at 375×812, 2026-10-11). jsdom has no scrolling,
   * so the method is put there to be watched, as `AnchoredPopup.test.tsx` does.
   */
  it("brings the finishes into view when the chosen printing leaves a choice, and only then", async () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      writable: true,
      value: scrollIntoView,
    });
    try {
      open();
      await printings();
      // Nothing chosen yet: nothing to bring anywhere.
      expect(scrollIntoView).not.toHaveBeenCalled();

      // A printing sold one way settles its own finish — there is nothing to go and look at.
      await answer("Lightning Bolt — LEA 161");
      expect(checked(finishes())).toHaveLength(1);
      expect(scrollIntoView).not.toHaveBeenCalled();

      // A printing sold three ways leaves the question open: the group it is asked in is shown.
      await answer("Lightning Bolt — STA 105");
      expect(checked(finishes())).toHaveLength(0);
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
      expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
      expect(scrollIntoView.mock.contexts[0]).toContainElement(finishes());

      // Answered, it is not asked for again.
      await userEvent.click(finish("Foil"));
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
    } finally {
      delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });

  it("asks for the finish of a printing sold more than one way", async () => {
    open();
    await answer("Lightning Bolt — STA 105");
    expect(await tile("Lightning Bolt — STA 105")).toHaveAttribute("aria-checked", "true");

    const offered = within(finishes()).getAllByRole("radio");
    expect(offered.map((radio) => radio.textContent)).toEqual(["Nonfoil", "Foil", "Etched"]);
    for (const radio of offered) expect(radio).not.toHaveAttribute("aria-disabled");
    expect(checked(finishes())).toHaveLength(0);

    expect(send()).toHaveAttribute("aria-disabled", "true");
    expect(send()).toHaveAccessibleDescription(CHOOSE_ITS_FINISH);
    await userEvent.click(send());
    expect(ipc.scannerSubmit).not.toHaveBeenCalled();

    await userEvent.click(finish("Etched"));
    expect(finish("Etched")).toHaveAttribute("aria-checked", "true");
    expect(send()).not.toHaveAttribute("aria-disabled");
    expect(send()).not.toHaveAttribute("aria-describedby");
  });

  it("offers only the finishes the printing comes in", async () => {
    open();
    await answer("Lightning Bolt — 2X2 117");
    expect(within(finishes()).getAllByRole("radio").map((radio) => radio.textContent)).toEqual([
      "Nonfoil",
      "Foil",
    ]);
  });

  /** The one thing chosen for the reader: a finish the cardboard leaves no choice about. */
  it.each([
    ["Lightning Bolt — LEA 161", "Nonfoil"],
    ["Lightning Bolt — JGP 1", "Foil"],
  ])("selects the only finish of %s for the reader", async (name, only) => {
    open();
    await answer(name);
    const offered = within(finishes()).getAllByRole("radio");
    expect(offered.map((radio) => radio.textContent)).toEqual([only]);
    expect(offered[0]).toHaveAttribute("aria-checked", "true");
    expect(finishes()).toHaveAccessibleDescription(ONE_FINISH);
    expect(send()).not.toHaveAttribute("aria-disabled");
  });

  /** An empty `finishes` column is "unknown", never "none": all three, and none of them chosen. */
  it("offers all three finishes for a printing that does not say, and selects none", async () => {
    open();
    await answer("Lightning Bolt — PLST A25-141");
    expect(within(finishes()).getAllByRole("radio").map((radio) => radio.textContent)).toEqual([
      "Nonfoil",
      "Foil",
      "Etched",
    ]);
    expect(checked(finishes())).toHaveLength(0);
    expect(send()).toHaveAccessibleDescription(CHOOSE_ITS_FINISH);
  });

  it("drops a finish the newly chosen printing does not come in", async () => {
    open();
    await answer("Lightning Bolt — STA 105", "Etched");
    expect(send()).not.toHaveAttribute("aria-disabled");

    await answer("Lightning Bolt — 2X2 117");
    expect(checked(finishes())).toHaveLength(0);
    expect(send()).toHaveAttribute("aria-disabled", "true");
    expect(send()).toHaveAccessibleDescription(CHOOSE_ITS_FINISH);
  });

  it("keeps a finish the reader chose where the newly chosen printing comes in it too", async () => {
    open();
    await answer("Lightning Bolt — STA 105", "Foil");
    await answer("Lightning Bolt — 2X2 117");
    expect(finish("Foil")).toHaveAttribute("aria-checked", "true");
    expect(send()).not.toHaveAttribute("aria-disabled");
  });

  /**
   * Alpha's Bolt is nonfoil because nothing else exists; that is not the reader saying the
   * Mystical Archive one in the picture is nonfoil. A finish the printing supplied goes with it.
   */
  it("does not carry a finish the printing chose over to a printing that has a choice", async () => {
    open();
    await answer("Lightning Bolt — LEA 161");
    expect(finish("Nonfoil")).toHaveAttribute("aria-checked", "true");

    await answer("Lightning Bolt — STA 105");
    expect(checked(finishes())).toHaveLength(0);
    expect(send()).toHaveAttribute("aria-disabled", "true");
  });

  /**
   * **One argument, and the whole run in it.** The reader's two answers, what the scanner had
   * said, the filters it was under, and every frame as it stood at the press — oldest first,
   * each with what the scanner answered for it. Whichever picture the dialog happens to be
   * showing, none is left out and none is sent alone.
   */
  it("sends the whole run under the reader's two answers, beside what the scanner had said", async () => {
    open();
    await answer("Lightning Bolt — STA 105", "Foil");
    // Looking at an earlier picture changes nothing about what is sent.
    fireEvent.change(slider(), { target: { value: "2" } });
    await userEvent.click(send());

    await waitFor(() => expect(ipc.scannerSubmit).toHaveBeenCalledTimes(1));
    const call = vi.mocked(ipc.scannerSubmit).mock.calls[0];
    expect(call).toHaveLength(1);
    expect(call[0]).toEqual({
      cardId: "bolt-sta",
      finish: "foil",
      reported: "bolt-2x2",
      mode: "exact",
      confidence: 0.82,
      distance: 36,
      bundle: 117630,
      filters: { sets: ["2x2"], released_from: null, released_to: null },
      run: FRAMES,
    });
    expect(call[0].run).toHaveLength(6);
    expect(call[0].run.map((one) => one.jpeg)).toEqual(["AQ==", "Ag==", "Aw==", "BA==", "BQ==", "Bg=="]);
    expect(call[0].run[3]).toEqual({
      jpeg: "BA==",
      ms: -228,
      ok: true,
      lock: "locked",
      confidence: 0.82,
      distance: 36,
      decided: null,
      detail: true,
    });
  });

  it("sends nulls where the scanner had said nothing", async () => {
    open({
      frames: FRAMES,
      said: {
        reported: null,
        mode: "fast",
        confidence: null,
        distance: null,
        bundle: null,
        filters: NO_FILTERS,
      },
      leadName: "Lightning Bolt",
    });
    await answer("Lightning Bolt — LEA 161");
    await userEvent.click(send());
    await waitFor(() => expect(ipc.scannerSubmit).toHaveBeenCalledTimes(1));
    expect(ipc.scannerSubmit).toHaveBeenCalledWith({
      cardId: "bolt-lea",
      finish: "nonfoil",
      reported: null,
      mode: "fast",
      confidence: null,
      distance: null,
      bundle: null,
      filters: NO_FILTERS,
      run: FRAMES,
    });
  });

  /**
   * The reference arrives in this dialog and nowhere else. A dialog closed mid-send is a scan
   * sent and a reference lost, so every way out waits for the answer.
   */
  it("says it is sending, takes no second press, and holds its ways out until the answer", async () => {
    let land!: (taken: ScannerSubmitted) => void;
    vi.mocked(ipc.scannerSubmit).mockImplementationOnce(
      () => new Promise((resolve) => (land = resolve)),
    );
    const { onDismiss, onClose } = open();
    await answer("Lightning Bolt — STA 105", "Foil");
    await userEvent.click(send());

    expect(send()).toHaveTextContent("Sending…");
    expect(send()).toHaveAttribute("aria-disabled", "true");
    // Still a tab stop, and still holding the caret it was pressed with.
    expect(send()).toBeEnabled();
    expect(send()).toHaveFocus();

    await userEvent.click(send());
    await userEvent.click(send());
    expect(ipc.scannerSubmit).toHaveBeenCalledTimes(1);

    const cancel = screen.getByRole("button", { name: "Cancel" });
    expect(cancel).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(cancel);
    await userEvent.keyboard("{Escape}");
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    const scrim = dialog().parentElement as HTMLElement;
    fireEvent.mouseDown(scrim);
    expect(onDismiss).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(dialog()).toBeInTheDocument();

    land({ id: REFERENCE });
    expect(await screen.findByText("Sent — thank you.")).toBeInTheDocument();
    // …and now the way out is open again.
    await userEvent.keyboard("{Escape}");
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("draws a refusal in place, keeps both answers, and sends again on the next press", async () => {
    vi.mocked(ipc.scannerSubmit).mockRejectedValueOnce(INBOX_FULL);
    const { onDismiss, onClose } = open();
    await answer("Lightning Bolt — STA 105", "Foil");
    await userEvent.click(send());

    expect(await within(dialog()).findByRole("alert")).toHaveTextContent(INBOX_FULL);
    // The dialog stays, and nothing the reader said is taken back.
    expect(onDismiss).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(await tile("Lightning Bolt — STA 105")).toHaveAttribute("aria-checked", "true");
    expect(finish("Foil")).toHaveAttribute("aria-checked", "true");
    expect(send()).toHaveTextContent("Send scan");
    expect(send()).not.toHaveAttribute("aria-disabled");

    await userEvent.click(send());
    await waitFor(() => expect(ipc.scannerSubmit).toHaveBeenCalledTimes(2));
    expect(vi.mocked(ipc.scannerSubmit).mock.calls[1]).toEqual(
      vi.mocked(ipc.scannerSubmit).mock.calls[0],
    );
    expect(await screen.findByText("Sent — thank you.")).toBeInTheDocument();
    // The refusal went with the press that answered it.
    expect(within(dialog()).queryByRole("alert")).toBeNull();
  });

  it("thanks the reader with the reference, in a region that was there before it was filled", async () => {
    const { onDismiss } = open();
    // Mounted with the dialog, empty: a region that arrives with its words inside says nothing.
    const regions = within(dialog()).getAllByRole("status");
    const thanks = regions[regions.length - 1];
    expect(thanks).toBeEmptyDOMElement();

    await answer("Lightning Bolt — STA 105", "Foil");
    await userEvent.click(send());

    await waitFor(() => expect(thanks).toHaveTextContent("Sent — thank you."));
    expect(thanks).toHaveTextContent(`Reference: ${REFERENCE}`);
    expect(thanks).toHaveTextContent(KEEP_THE_REFERENCE);
    // The reference is text a reader can select whole, not a control.
    expect(within(thanks).getByText(REFERENCE).classList.contains("select-all")).toBe(true);
    expect(KEEP_THE_REFERENCE).toBe("Keep the reference if you ever want these pictures deleted.");
    // The form is gone — there is nothing more to answer or to look through — and Done has
    // the caret.
    expect(screen.queryByRole("searchbox")).toBeNull();
    expect(screen.queryByRole("slider")).toBeNull();
    expect(screen.queryByRole("button", { name: "Send scan" })).toBeNull();
    const done = screen.getByRole("button", { name: "Done" });
    await waitFor(() => expect(done).toHaveFocus());

    await userEvent.click(done);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("says how many pictures are sent and where, above the press, with the way to the policy", async () => {
    open();
    // The count is the run's own: six frames, six pictures.
    const said = within(dialog()).getByText(disclosure(FRAMES.length));
    expect(said).toBeVisible();
    expect(said).toHaveTextContent(/^These 6 pictures — the last couple of seconds the scanner saw — /);
    expect(within(dialog()).getByRole("link", { name: "Privacy policy" })).toHaveAttribute(
      "href",
      "https://mtg-grimoire.app/privacy",
    );
    // Not inside the body's scroller: it is on screen however far the printings are scrolled.
    const scroller = (await printings()).closest(".overflow-y-auto:not([role='radiogroup'])");
    expect(scroller).not.toBeNull();
    expect(scroller?.contains(said)).toBe(false);
    expect(scroller?.contains(send())).toBe(false);
    // The pictures are in it, with the two questions: they are what is scrolled through.
    expect(scroller?.contains(picture())).toBe(true);
    expect(scroller?.contains(slider())).toBe(true);
  });

  it("counts the pictures of whatever run it was opened on", () => {
    open({ ...RUN, frames: FRAMES.slice(1) });
    expect(within(dialog()).getByText(disclosure(5))).toBeInTheDocument();
    expect(picture()).toHaveAttribute("alt", "Picture 5 of 5 that will be sent");
  });

  it("hands Cancel to the dismissal that gives the caret back", async () => {
    const { onDismiss, onClose } = open();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("the printings a reader chooses between", () => {
  it("asks nothing for an empty box, and says what typing will do", async () => {
    open({ ...RUN, leadName: "" });
    expect(screen.getByText(SEARCH_PROMPT)).toBeInTheDocument();
    expect(screen.queryByRole("radiogroup", { name: "Printings" })).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(ipc.searchCards).not.toHaveBeenCalled();
  });

  it("says so in a sentence when no printing matches", async () => {
    vi.mocked(ipc.searchCards).mockResolvedValue(page([]));
    open();
    expect(await screen.findByText("No printing found for “Lightning Bolt”.")).toBeInTheDocument();
    expect(screen.queryByRole("radiogroup", { name: "Printings" })).toBeNull();
  });

  it("says a search that could not run is not a card nothing matches", async () => {
    vi.mocked(ipc.searchCards).mockRejectedValue("the card database is busy");
    open();
    expect(await within(dialog()).findByRole("alert")).toHaveTextContent(
      "Couldn't search the cards — the card database is busy",
    );
    expect(screen.queryByText(/No printing found/)).toBeNull();
  });

  it("says it is searching until the first answer", async () => {
    let land!: (answer: SearchResponse) => void;
    vi.mocked(ipc.searchCards).mockImplementation(() => new Promise((resolve) => (land = resolve)));
    open();
    expect(await screen.findByText("Searching…")).toBeInTheDocument();
    land(page(BOLTS));
    expect(await screen.findByText("5 printings")).toBeInTheDocument();
  });

  /**
   * A basic land has hundreds of printings and the one in the picture can be any of them, so the
   * answer can be made longer as well as narrower.
   */
  it("offers more where more matched than are drawn, and hints at a set term", async () => {
    const many = Array.from({ length: 24 }, (_, n) =>
      printing({ id: `bolt-${n}`, setCode: "sld", collectorNumber: String(n + 1) }),
    );
    vi.mocked(ipc.searchCards).mockResolvedValue(page(many, 60));
    open();
    expect(await screen.findByText("Showing 24 of 60 printings")).toBeInTheDocument();
    expect(screen.getByText(SET_HINT)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Show more" }));
    await waitFor(() =>
      expect(ipc.searchCards).toHaveBeenLastCalledWith(
        expect.objectContaining({ text: "Lightning Bolt", limit: 48, offset: 0 }),
      ),
    );
  });

  it("draws neither the press nor the hint when every match is on screen", async () => {
    open();
    await printings();
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
    expect(screen.queryByText(SET_HINT)).toBeNull();
  });

  /** The hint's own syntax, typed: the term leaves as a predicate and not as two more words. */
  it("sends a typed set term as the search's own predicate", async () => {
    open();
    await printings();
    await userEvent.type(screen.getByRole("searchbox", { name: WHICH_CARD }), " s:sta");
    await waitFor(
      () =>
        expect(ipc.searchCards).toHaveBeenLastCalledWith(
          expect.objectContaining({
            text: "Lightning Bolt",
            predicates: [expect.objectContaining({ field: "setCode", value: "sta" })],
          }),
        ),
      { timeout: 3000 },
    );
  });

  /**
   * A choice outlives the search that found it. The tile is gone from the grid, so the choice is
   * said in words — and it is still what Send sends.
   */
  it("keeps the chosen printing in words when the search moves on, and still sends it", async () => {
    open();
    await answer("Lightning Bolt — STA 105", "Foil");
    expect(screen.getByText("Chosen: Lightning Bolt · STA 105")).toBeInTheDocument();

    const box = screen.getByRole("searchbox", { name: WHICH_CARD });
    await userEvent.clear(box);
    await userEvent.type(box, "storm");
    // Asked of the screen rather than of the group found a moment ago: the debounce is a real
    // timer, and nothing here should depend on the grid's element outliving it.
    expect(
      await screen.findByRole("radio", { name: "Storm of Saruman — LTR 72" }, { timeout: 3000 }),
    ).toHaveAttribute("aria-checked", "false");
    expect(screen.queryByRole("radio", { name: "Lightning Bolt — STA 105" })).toBeNull();

    // Not silently kept, and not silently dropped: on screen, in words.
    expect(screen.getByText("Chosen: Lightning Bolt · STA 105")).toBeInTheDocument();
    expect(finish("Foil")).toHaveAttribute("aria-checked", "true");
    await userEvent.click(send());
    await waitFor(() => expect(ipc.scannerSubmit).toHaveBeenCalledTimes(1));
    expect(vi.mocked(ipc.scannerSubmit).mock.calls[0]?.[0]).toMatchObject({
      cardId: "bolt-sta",
      finish: "foil",
    });
  });

  it("keeps the choice through an emptied box too", async () => {
    open();
    await answer("Lightning Bolt — LEA 161");
    await userEvent.clear(screen.getByRole("searchbox", { name: WHICH_CARD }));
    expect(await screen.findByText(SEARCH_PROMPT, {}, { timeout: 3000 })).toBeInTheDocument();
    expect(screen.queryByRole("radiogroup", { name: "Printings" })).toBeNull();
    expect(screen.getByText("Chosen: Lightning Bolt · LEA 161")).toBeInTheDocument();
    expect(send()).not.toHaveAttribute("aria-disabled");
  });

  /** One Tab stop for the grid, and the arrows choose — `radioGroup.ts`, as every group here. */
  it("is one tab stop whose arrows walk the printings", async () => {
    open();
    const radios = within(await printings()).getAllByRole("radio");
    expect(radios.map((radio) => radio.tabIndex)).toEqual([0, -1, -1, -1, -1]);

    radios[0].focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(radios[1]).toHaveFocus();
    expect(radios[1]).toHaveAttribute("aria-checked", "true");
    expect(within(await printings()).getAllByRole("radio").map((radio) => radio.tabIndex)).toEqual([
      -1, 0, -1, -1, -1,
    ]);
  });

  it("marks the chosen tile with more than a colour", async () => {
    open();
    await answer("Lightning Bolt — STA 105");
    const chosen = await tile("Lightning Bolt — STA 105");
    const other = await tile("Lightning Bolt — LEA 161");
    // A tick laid on the card, drawn for the chosen one alone.
    expect(chosen.querySelector("[data-chosen-mark] svg")).not.toBeNull();
    expect(other.querySelector("[data-chosen-mark]")).toBeNull();
  });
});

/**
 * The dialog over the hook that opens it — the pair each Scanner page mounts. What is asked here
 * is the caret: where it goes on each way out is the hook's half, and which way out each control
 * takes is the dialog's.
 */
describe("the dialog, opened by the press", () => {
  /**
   * What the pump is holding at a press: six frames it sent and had answered, a byte each, a
   * hundred and ten milliseconds apart, the newest grabbed as the press lands. **Stamped off the
   * run's own clock (`runClock`), in the call the press makes** — the same clock the press reads
   * a line later — so how old the frames are is the arithmetic below and never how long the
   * machine took: a run reaches only a few seconds back from the press (`RUN_MAX_AGE_MS`), and
   * frames stamped once for the file would be older than that by the time a test got to them.
   */
  const ring = (): RunFrame[] => {
    const newest = runClock.now();
    return [1, 2, 3, 4, 5, 6].map((n) =>
      runFrameOf(new Uint8Array([n]), newest - (6 - n) * 110, VERDICTS.exactAmbiguous, false),
    );
  };

  function Page() {
    const submit = useScanSubmit({
      recent: ring,
      verdict: VERDICTS.exactAmbiguous,
      mode: "exact",
      status: STATUS.present,
      filters: NO_FILTERS,
      ready: true,
    });
    return (
      <>
        <button type="button" onClick={(e) => submit.open(e.currentTarget)}>
          Send scan…
        </button>
        <SubmitScanDialog run={submit.run} onDismiss={submit.onDismiss} onClose={submit.onClose} />
      </>
    );
  }

  async function press() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <Page />
      </QueryClientProvider>,
    );
    const opener = screen.getByRole("button", { name: "Send scan…" });
    await userEvent.click(opener);
    await screen.findByRole("dialog", { name: "Send this scan" });
    return opener;
  }

  const gone = () => waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

  it("opens on the last frame of the run the press froze, searching for the card the scanner named", async () => {
    await press();
    // The pump's sixth byte, as text: the newest frame it had sent.
    expect(picture()).toHaveAttribute("src", "data:image/jpeg;base64,Bg==");
    expect(picture()).toHaveAttribute("alt", "Picture 6 of 6 that will be sent");
    expect(screen.getByRole("searchbox", { name: WHICH_CARD })).toHaveValue("Lightning Bolt");
  });

  it("sends the run the press froze, each frame counted back from it", async () => {
    await press();
    await answer("Lightning Bolt — LEA 161");
    await userEvent.click(send());
    await waitFor(() => expect(ipc.scannerSubmit).toHaveBeenCalledTimes(1));
    const [sent] = vi.mocked(ipc.scannerSubmit).mock.calls[0];
    expect(sent.run.map((one) => one.jpeg)).toEqual(["AQ==", "Ag==", "Aw==", "BA==", "BQ==", "Bg=="]);
    // Oldest first, a hundred and ten milliseconds apart, and none after the press.
    const ms = sent.run.map((one) => one.ms);
    expect([...ms].sort((a, b) => a - b)).toEqual(ms);
    expect(ms.every((one) => one <= 0)).toBe(true);
    expect(ms[5] - ms[0]).toBe(550);
    expect(sent.filters).toEqual(NO_FILTERS);
    expect(sent.reported).toBe(VERDICTS.exactAmbiguous.decision?.printing);
  });

  it("hands the caret back to the press on Escape", async () => {
    const opener = await press();
    await userEvent.keyboard("{Escape}");
    await gone();
    expect(opener).toHaveFocus();
  });

  it("hands the caret back to the press on the ✕", async () => {
    const opener = await press();
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    await gone();
    expect(opener).toHaveFocus();
  });

  it("hands the caret back to the press on Cancel", async () => {
    const opener = await press();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await gone();
    expect(opener).toHaveFocus();
  });

  it("closes on a press outside without moving the caret to the opener", async () => {
    const opener = await press();
    fireEvent.mouseDown(dialog().parentElement as HTMLElement);
    await gone();
    expect(opener).not.toHaveFocus();
  });

  it("hands the caret back from Done, after the thanks", async () => {
    const opener = await press();
    await answer("Lightning Bolt — LEA 161");
    await userEvent.click(send());
    await userEvent.click(await screen.findByRole("button", { name: "Done" }));
    await gone();
    expect(opener).toHaveFocus();
  });

  /** Closed is nothing mounted, so nothing a reader chose last time is waiting in the next one. */
  it("starts clean on every open", async () => {
    const opener = await press();
    await answer("Lightning Bolt — STA 105", "Foil");
    expect(send()).not.toHaveAttribute("aria-disabled");
    await userEvent.keyboard("{Escape}");
    await gone();

    await userEvent.click(opener);
    await screen.findByRole("dialog", { name: "Send this scan" });
    expect(checked(await printings())).toHaveLength(0);
    expect(checked(finishes())).toHaveLength(0);
    expect(screen.queryByText(/^Chosen:/)).toBeNull();
    expect(send()).toHaveAccessibleDescription(CHOOSE_THE_CARD);
  });
});
