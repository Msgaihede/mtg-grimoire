import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CardDetail, Printing, PrintingsResponse } from "@/lib/ipc";
import { MARKETPLACES, type MarketplaceId } from "@/lib/marketplace";
import { isWebTarget } from "@/pwa/target";

/** Which build a card frame thinks it is in. `isWebTarget()` reads `__CORE__`, a build-time
 *  constant vitest fixes at `"tauri"`, so the web answer cannot be arranged any other way — see
 *  `src/pwa/target.ts`. Desktop unless a case says otherwise. */
vi.mock("@/pwa/target", () => ({ isWebTarget: vi.fn(() => false) }));

const detail: CardDetail = {
  promoTypes: null,
  id: "p1",
  oracleId: "o1",
  name: "Lightning Bolt",
  setCode: "lea",
  setName: "Limited Edition Alpha",
  collectorNumber: "161",
  rarity: "common",
  layout: "normal",
  lang: "en",
  manaCost: "{R}",
  cmc: 1,
  typeLine: "Instant",
  oracleText: "Lightning Bolt deals 3 damage to any target.",
  illustrationId: "art-a",
  artist: "Christopher Rush",
  releasedAt: "1993-08-05",
  legalities: '{"modern":"legal"}',
  finishPrices: { nonfoil: 400.5, foil: null, etched: null },
  finishes: '["nonfoil"]',
  imageStatus: "highres_scan",
  faces: [],
};

const printing = (over: Partial<Printing> = {}): Printing => ({
  promoTypes: null,
  id: "p1",
  setCode: "lea",
  setName: "Limited Edition Alpha",
  collectorNumber: "161",
  releasedAt: "1993-08-05",
  rarity: "common",
  illustrationId: "art-a",
  artist: "Christopher Rush",
  lang: "en",
  finishes: '["nonfoil"]',
  finishPrices: { nonfoil: 400.5, foil: null, etched: null },
  promo: false,
  fullArt: false,
  frameEffects: null,
  borderColor: "black",
  layout: "normal",
  ...over,
});

/** Three printings of one card: the pane's own, and two to dwell on. */
const PRINTINGS: PrintingsResponse = {
  items: [
    printing(),
    printing({ id: "p2", setCode: "m10", collectorNumber: "146", releasedAt: "2009-07-17" }),
    printing({ id: "p3", setCode: "sta", collectorNumber: "42", releasedAt: "2021-04-23" }),
  ],
  total: 3,
};

const cardDetail = vi.fn();
const cardPrintings = vi.fn();
vi.mock("@/lib/ipc", async (original) => ({
  ...(await original<typeof import("@/lib/ipc")>()),
  ipc: {
    cardDetail: (id: string, marketplace: MarketplaceId) => cardDetail(id, marketplace),
    cardPrintings: (o: string, marketplace: MarketplaceId) => cardPrintings(o, marketplace),
  },
}));
import { CardModalPrintings } from "./CardModalPrintings";
import type { CardModalScope } from "./cardModalScope";
import { previewBox, PREVIEW_DWELL_MS } from "./PrintingPreview";
import { useAppStore } from "@/lib/store";

/**
 * The preview is the one image in the pane with no `alt` — it is redundant art over a row that
 * already says which printing it is, so a screen reader is told nothing twice. Which makes
 * "empty alt" both the contract and the way to find it, with no test-only mark in the DOM.
 */
const previews = () => Array.from(document.querySelectorAll<HTMLImageElement>('img[alt=""]'));
const preview = () => previews()[0] ?? null;

/**
 * The floating **frame**, whether or not there is a picture in it.
 *
 * Needed only by the web cases below, and needed there for a reason worth stating: a preview
 * with no `<img>` and a dwell that never opened look identical through {@link preview}, so
 * "the picture is missing" cannot be told from "nothing happened" without this. The three
 * classes are the frame's own and none of them is shared by anything else in the pane.
 */
const previewFrame = () =>
  document.querySelector<HTMLElement>("div.pointer-events-none.absolute.rounded-xl");

/**
 * The row a printing is drawn in, found by the one control that names the printing.
 *
 * **`Show M10 · 146`, not `(M10 146)`.** The docked pane's rows put the set and number in
 * parentheses after an add control's verb; `CardModalPrintings` names the whole row for what
 * pressing it does, and on a wall with no deck row behind it that is "Show". One helper, so the
 * sixteen cases below say which *printing* they mean and nothing about how a row is worded.
 */
const rowButton = (setAndNumber: string) => {
  const [set, number] = setAndNumber.split(" ");
  // A predicate rather than a `RegExp`: the row names the year too when the printing carries
  // a release date, which every fixture here does, and the separator between the three parts
  // is a `·` that a hand-built pattern has to spell. Matching the parts is what this means.
  return screen.getByRole("button", {
    name: (n: string) => n.startsWith(`Show ${set} `) && n.includes(` ${number}`),
  });
};

const rowOf = (setAndNumber: string) => rowButton(setAndNumber).closest("li") as HTMLElement;

const onClose = vi.fn();

/**
 * The pane, open, with its printings list on screen — and the clock frozen from that point on.
 *
 * **Mounted directly rather than through a host, which is what this file gained when the docked
 * pane became a modal.** The dwell and its picture live in `CardModalPrintings`, and that
 * component takes its rows as a prop — so a `QueryClientProvider` and two `ipc` mocks are no
 * longer between this suite and the thing it is about. `CardImage` still wants the provider, so
 * that stays.
 *
 * The fake clock is installed *after* the render, so nothing the mount does has to be ticked;
 * everything the dwell itself does is `fireEvent` plus an explicit tick.
 */
const searchScope: CardModalScope = {
  surface: "search",
  deck: null,
  quantity: null,
  deckControls: false,
};

async function openPane(printings: PrintingsResponse = PRINTINGS) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={qc}>
      <CardModalPrintings
        card={detail}
        scope={searchScope}
        items={printings.items}
        total={printings.total}
        loading={false}
        error={null}
        marketplace={MARKETPLACES.tcgplayer}
        onPick={vi.fn()}
        onViewAll={onClose}
      />
    </QueryClientProvider>,
  );
  await screen.findByText(/3 printings/);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  return { ...view, qc };
}

/** Move the frozen clock, and let React commit what that woke up. */
const tick = (ms: number) => act(() => void vi.advanceTimersByTime(ms));

beforeEach(() => {
  // Desktop unless a case says otherwise — a leaked `true` would blank every preview here.
  vi.mocked(isWebTarget).mockReturnValue(false);
  cardDetail.mockReset();
  cardPrintings.mockReset();
  onClose.mockReset();
  useAppStore.setState(useAppStore.getInitialState());
});

afterEach(() => {
  vi.useRealTimers();
});

/**
 * Where the picture goes — the half of this feature jsdom cannot see, since every rectangle in
 * it is zero.
 *
 * The fixtures are rectangles **measured in the running window** on 2026-08-06 (Lightning Bolt,
 * 62 printings, the pane docked at the right of a 1280 × 800 and then a 1024 × 768 window), so
 * a regression here is a regression against something that was true on screen.
 */
describe("previewBox", () => {
  /**
   * The pane at 1280 × 800: 702px of it, below the ribbon.
   *
   * `top` is the only figure here that is not the 2026-08-06 measurement — the shell was
   * enlarged on 2026-08-14 and the ribbon went 48 → 56px, so the pane starts 8px lower
   * (56 + the 2px mana line + `main`'s 20px padding). Nothing this file asserts depends on
   * the value; `top` is a floor two of the tests check the box stays inside.
   */
  const PANE = { top: 78, bottom: 780, left: 876, right: 1260, width: 384 };
  /** A printings row halfway down it, 335px of content between the pane's padding. */
  const ROW = { top: 409, bottom: 441, left: 893, right: 1228, width: 335 };

  it("hangs the full-size picture under the row, right-aligned to it", () => {
    // 240 wide is the cap; 334 is 240 × 936/672, the `display` variant's own shape.
    expect(previewBox(ROW, PANE)).toEqual({ top: 445, left: 988, width: 240, height: 334 });
  });

  it("flips it above a row too near the foot of the pane", () => {
    const low = { ...ROW, top: 700, bottom: 732 };
    const box = previewBox(low, PANE);
    expect(box.height).toBe(334);
    // Ending 4px above the row rather than starting 4px below it, and still inside the pane.
    expect(box.top + box.height).toBe(low.top - 4);
    expect(box.top).toBeGreaterThanOrEqual(PANE.top);
  });

  /**
   * The 15px clip, which only the running window found: at the 1024 × 768 floor a row halfway
   * down the pane has 323px above it and 323px below, so a 334px picture fits **neither** side
   * — `shouldFlipUp` says "open the way it reads" and the pane cuts the bottom off it.
   */
  it("shrinks to the room a short pane leaves rather than being cut off by it", () => {
    const short = { ...PANE, bottom: 748 };
    const row = { ...ROW, top: 393, bottom: 425 };
    const box = previewBox(row, short);

    expect(box.width).toBe(229);
    expect(box.height).toBe(318);
    // The whole of it inside the pane, which is the only claim that matters.
    expect(box.top).toBeGreaterThanOrEqual(short.top);
    expect(box.top + box.height).toBeLessThanOrEqual(short.bottom);
  });

  it("never asks for a negative box when there is no room at all", () => {
    const box = previewBox(ROW, { ...PANE, top: 409, bottom: 441 });
    expect(box.width).toBe(0);
    expect(box.height).toBe(0);
  });
});

/**
 * The printings list, read with the pointer: a quarter of a second on a row and that printing's
 * art appears beside it (spec §3).
 *
 * The delay is a **dwell**, not a transition — nothing fades in, nothing eases, and
 * `prefers-reduced-motion` therefore has nothing to turn off. What it buys is a list that can
 * be scanned: dragging the pointer down forty rows on the way to the scrollbar must not open
 * forty pictures.
 */
describe("the printings list preview", () => {
  it("draws the row's art once the pointer has rested on it for a quarter second", async () => {
    await openPane();

    fireEvent.mouseEnter(rowOf("M10 146"));

    // One millisecond short is nothing at all: a pointer crossing the row has not asked.
    tick(PREVIEW_DWELL_MS - 1);
    expect(preview()).toBeNull();

    tick(1);
    // The row's own printing, front face, at the size the pane's own art is fetched in.
    expect(preview()).toHaveAttribute("src", expect.stringContaining("/display/p2/0"));
  });

  /**
   * **The preview in a browser, where `mtgimg://` reaches nothing.**
   *
   * It is a Tauri custom protocol and wasm cannot register a URL scheme with a browser, and
   * `card_printings` is in `web/route.rs`'s `COMMANDS` — so this picture was the platform's
   * broken-image glyph on web and on the phone. `cardArtSrc` is the whole of the branch and
   * needs both candidates, only one of which can be built from an id: the dwell hands over an
   * **id**, so the URL is threaded down beside it from `CardDetailPane`, which is the one place
   * holding the `Printing` that id names.
   *
   * Which is also what the first case here proves, and it is the half a prop test could not:
   * three rows are on screen carrying three different URLs, and the picture has to be the one
   * the pointer rested on.
   */
  describe("on the web build", () => {
    const P2 = "https://cards.scryfall.io/display/front/0/0/p2.webp?1706230661";
    const P3 = "https://cards.scryfall.io/display/front/0/0/p3.webp?1706230661";
    /** The same three printings, two of them carrying a picture a browser can reach. */
    const WITH_URLS: PrintingsResponse = {
      ...PRINTINGS,
      items: [
        PRINTINGS.items[0],
        { ...PRINTINGS.items[1], imageUris: { display: P2 } },
        { ...PRINTINGS.items[2], imageUris: { display: P3 } },
      ],
    };

    beforeEach(() => {
      vi.mocked(isWebTarget).mockReturnValue(true);
    });

    it("draws the URL carried by the row the pointer rested on, not another row's", async () => {
      await openPane(WITH_URLS);

      fireEvent.mouseEnter(rowOf("M10 146"));
      tick(PREVIEW_DWELL_MS);

      expect(preview()).toHaveAttribute("src", P2);
      expect(preview()!.getAttribute("src")).not.toBe(P3);
    });

    /**
     * A row carrying no picture opens the frame and leaves it empty. That is
     * `useImageRetry`'s own answer — the frame *is* the placeholder — and it is what this
     * preview already shows for the ~127 ms before the bytes arrive, so a browser sees the
     * state it would have seen anyway rather than a broken-image glyph hanging off a row.
     */
    it("opens an empty frame for a row that carries no URL, rather than a broken image", async () => {
      await openPane();

      fireEvent.mouseEnter(rowOf("M10 146"));
      tick(PREVIEW_DWELL_MS);

      // The dwell fired — the frame is up — and there is simply nothing in it.
      expect(previewFrame()).not.toBeNull();
      expect(preview()).toBeNull();
    });
  });

  /**
   * The other side of the branch: on desktop the local cache already holds the bytes at this
   * exact size, so a row carrying a URL is still drawn from the protocol. A frame that
   * preferred the supplied one would refetch a 672×936 image over the network on every dwell.
   */
  it("keeps drawing the protocol picture on desktop when the row hands it a URL", async () => {
    await openPane({
      ...PRINTINGS,
      items: [
        PRINTINGS.items[0],
        {
          ...PRINTINGS.items[1],
          imageUris: { display: "https://cards.scryfall.io/display/front/0/0/p2.webp?1" },
        },
        PRINTINGS.items[2],
      ],
    });

    fireEvent.mouseEnter(rowOf("M10 146"));
    tick(PREVIEW_DWELL_MS);

    expect(preview()).toHaveAttribute("src", expect.stringContaining("/display/p2/0"));
    expect(preview()!.getAttribute("src")).not.toContain("scryfall.io");
  });

  it("never draws it for a pointer that left before the quarter second was up", async () => {
    await openPane();
    const row = rowOf("M10 146");

    fireEvent.mouseEnter(row);
    tick(200);
    fireEvent.mouseLeave(row);

    // Not "later", ever: a cancelled dwell is a cleared timer, not a deferred one.
    tick(10_000);
    expect(preview()).toBeNull();
  });

  it("takes it down the instant the pointer leaves", async () => {
    await openPane();
    const row = rowOf("M10 146");

    fireEvent.mouseEnter(row);
    tick(PREVIEW_DWELL_MS);
    expect(preview()).not.toBeNull();

    act(() => void fireEvent.mouseLeave(row));

    // No wait on the way out — the reader has moved on, and the picture is over the rows they
    // moved on to.
    expect(preview()).toBeNull();
  });

  /**
   * Keyboard parity, on the same clock. The row is not focusable itself — its controls are — so
   * the caret arriving anywhere inside it is the keyboard's version of the pointer resting on
   * it, and the caret leaving is the keyboard's version of moving away.
   */
  it("draws the same art on the same dwell when the caret arrives in the row", async () => {
    await openPane();
    const add = rowButton("M10 146");

    act(() => add.focus());
    tick(PREVIEW_DWELL_MS - 1);
    expect(preview()).toBeNull();

    tick(1);
    expect(preview()).toHaveAttribute("src", expect.stringContaining("/display/p2/0"));

    act(() => add.blur());
    expect(preview()).toBeNull();
  });

  /**
   * **The drag case left with the docked pane, and it is a deletion rather than a port.**
   *
   * The pane's rows were a drag source: a printing could be carried out of the list and dropped
   * on a pile. `CardModalPrintings` draws no such source, and deliberately — every drop target
   * this app has is behind the modal's own scrim, so the gesture has nowhere to land. A test
   * that fired a synthetic `dragstart` at a row would assert a handler nobody can reach, which
   * is worse than no test: the claim it used to make (a press takes the picture down) is
   * covered by `takes it down on a press inside the row` below, one event earlier and through
   * an interaction a reader really has.
   */

  /**
   * The Escape handshake, one rung further in than it has ever been in this pane: the preview
   * is an `"inner"` layer and consumes the press in the capture phase, so the pane underneath —
   * which returns early on a press something else has taken — stays open. The second press has
   * nothing in front of it and closes the card, which is where it was always going.
   */
  it("closes on Escape, and lets the next press through to the layer behind it", async () => {
    await openPane();

    // What the modal is, from this suite's point of view: something behind the list that the
    // second press is owed. Registered on `window` because that is where `useDismissOnEscape`
    // puts its own listeners, and in the bubble phase because the preview takes the press in
    // the capture phase — which is the whole of the ordering under test.
    const behind = vi.fn();
    window.addEventListener("keydown", behind);

    fireEvent.mouseEnter(rowOf("M10 146"));
    tick(PREVIEW_DWELL_MS);
    expect(preview()).not.toBeNull();

    const first = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    act(() => void window.dispatchEvent(first));

    // Taken, and taken *before* anything behind it could act on it.
    expect(first.defaultPrevented).toBe(true);
    expect(preview()).toBeNull();

    const second = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    act(() => void window.dispatchEvent(second));

    // The second press has nothing in front of it: it reaches the layer behind undefended,
    // which in the app is the modal closing.
    expect(second.defaultPrevented).toBe(false);
    expect(behind).toHaveBeenCalledTimes(2);

    window.removeEventListener("keydown", behind);
  });

  /**
   * What the preview is: decoration. The row beneath it already names the printing, so an
   * `alt` here would read the same card twice, and the wrapper is hidden outright so nothing
   * about a floating picture reaches a reader who cannot see it.
   *
   * And nothing on it animates. The 250 ms is a dwell, not a transition — the whole motion
   * budget is the mana line — so there is no fade to turn off under `prefers-reduced-motion`.
   */
  it("draws the art as decoration, with nothing that animates", async () => {
    await openPane();

    fireEvent.mouseEnter(rowOf("M10 146"));
    tick(PREVIEW_DWELL_MS);

    const art = preview() as HTMLImageElement;
    expect(art).toHaveAttribute("alt", "");
    const frame = art.closest("[aria-hidden='true']");
    expect(frame).not.toBeNull();
    for (const element of [art, frame as HTMLElement]) {
      expect(element.className).not.toMatch(/transition|animate|duration|fade/);
    }
  });

  /**
   * A press is the reader doing something other than reading, and it is how every other layer
   * in this pane is opened — so it takes the picture down before that layer goes up. This is
   * the *first* half of "never the pane's second open layer"; the guard below is the second.
   */
  it("takes it down on a press inside the row", async () => {
    await openPane();
    const row = rowOf("M10 146");

    fireEvent.mouseEnter(row);
    tick(PREVIEW_DWELL_MS);
    expect(preview()).not.toBeNull();

    act(() => void fireEvent.pointerDown(row));

    expect(preview()).toBeNull();
    // And it does not come back on the same still pointer: a press ended the dwell, it did not
    // postpone it.
    tick(10_000);
    expect(preview()).toBeNull();
  });

  /**
   * The keyboard's press. A control inside a row is activated with Enter or Space, and the
   * layer that opens is drawn inside that same row — so the caret never leaves it and no blur
   * arrives. Without this the picture would sit over the popup the press just opened.
   */
  it("takes it down on Enter in the row, where no blur would", async () => {
    await openPane();
    const add = rowButton("M10 146");

    act(() => add.focus());
    tick(PREVIEW_DWELL_MS);
    expect(preview()).not.toBeNull();

    act(() => void fireEvent.keyDown(add, { key: "Enter" }));

    expect(preview()).toBeNull();
  });

  /**
   * The other half of "never the pane's second open layer" — the half a press cannot cover.
   *
   * With the quick-add popup open, hovering a *different* row moves no focus and presses
   * nothing, so without a guard the dwell runs and puts a card image over the finish chips the
   * reader is choosing from. Measured in the running window before the guard existed — and the
   * complaint is that picture, not the Escape ladder: `useDismissOnEscape` orders `"inner"` peers
   * by a stack now, so the pair would dismiss cleanly and still be unreadable.
   */
  it("stays out of the way of a layer the reader already opened", async () => {
    await openPane();

    // **The list's own popup rather than the pane's quick-add dialog.** `Group printings by` is
    // a `Dropdown`, so it writes the pair this guard reads — `aria-haspopup` and
    // `aria-expanded="true"` — which is exactly the signature every popup trigger in this app
    // carries. Opening it is the reader's real way to have a layer over this column.
    const sort = screen.getByRole("button", { name: "Group printings by" });
    act(() => void fireEvent.click(sort));
    expect(sort).toHaveAttribute("aria-expanded", "true");

    fireEvent.mouseEnter(rowOf("STA 42"));
    tick(PREVIEW_DWELL_MS);

    expect(preview()).toBeNull();
    expect(sort).toHaveAttribute("aria-expanded", "true");
  });

  /**
   * …and only for a **layer**. The guard above is a whole-pane query, which makes it a kill
   * switch if it is aimed at the wrong attribute: this app writes a bare `aria-expanded` on
   * plain disclosures that stay open for minutes — a rail, a Maybe pile, an archived list, a
   * "why" — and the day this pane grows one (an expanded Rulings section) every preview in it
   * would stop appearing with nothing on screen or in the suite to say why. So the guard reads
   * the popup's own signature, both attributes, and a disclosure is none of its business.
   */
  it("is not suppressed by a disclosure that is merely open", async () => {
    await openPane();

    // A future section of this column, in the shape the app already writes them: expanded, and
    // not a layer — no `aria-haspopup`. Hung off the section itself, since the guard is a
    // document-wide query and the pane's landmark is gone.
    const rulings = document.createElement("button");
    rulings.setAttribute("aria-expanded", "true");
    rulings.textContent = "Rulings";
    (screen.getByRole("heading", { name: "Printings" }).closest("section") as HTMLElement).append(
      rulings,
    );

    fireEvent.mouseEnter(rowOf("M10 146"));
    tick(PREVIEW_DWELL_MS);

    expect(preview()).toHaveAttribute("src", expect.stringContaining("/display/p2/0"));
  });

  /**
   * A picture measured against a row that has left the document is a 0×0 box at the top of the
   * pane — invisible, and still an `"inner"` layer holding the next Escape press. Nothing tells
   * a hover that its element was unmounted, so the list says so when its rows are replaced.
   */
  it("goes down with the rows it was measured against", async () => {
    const view = await openPane();

    fireEvent.mouseEnter(rowOf("M10 146"));
    tick(PREVIEW_DWELL_MS);
    expect(preview()).not.toBeNull();

    // **What a refetch does, expressed the way this component now sees one: a new `items`.**
    // The pane read the rows out of a query and this takes them as a prop, so the event is a
    // re-render rather than a cache write — the effect that drops the picture keys on `items`
    // either way. `p2` is gone from the new list, so React cannot reuse the row the picture was
    // hung on, which is the case the effect exists for.
    act(() => {
      view.rerender(
        <QueryClientProvider client={view.qc}>
          <CardModalPrintings
            card={detail}
            scope={searchScope}
            items={[printing(), printing({ id: "p4", setCode: "2ed", collectorNumber: "162" })]}
            total={2}
            loading={false}
            error={null}
            marketplace={MARKETPLACES.tcgplayer}
            onPick={vi.fn()}
            onViewAll={onClose}
          />
        </QueryClientProvider>,
      );
    });

    expect(preview()).toBeNull();
  });

  /**
   * One timer for the list, not one per row: the pointer travelling from row to row restarts
   * the same dwell, so a reader who ran down twenty rows sees nothing, and there is never a
   * second picture to close.
   */
  it("moves the one preview between rows rather than opening a second", async () => {
    await openPane();

    fireEvent.mouseEnter(rowOf("M10 146"));
    tick(PREVIEW_DWELL_MS);
    expect(previews()).toHaveLength(1);

    act(() => {
      fireEvent.mouseLeave(rowOf("M10 146"));
      fireEvent.mouseEnter(rowOf("STA 42"));
    });

    // Gone with the row it belonged to, and the new row's dwell starts from zero.
    expect(previews()).toHaveLength(0);
    tick(PREVIEW_DWELL_MS - 1);
    expect(previews()).toHaveLength(0);

    tick(1);
    expect(previews()).toHaveLength(1);
    expect(preview()).toHaveAttribute("src", expect.stringContaining("/display/p3/0"));
  });
});
