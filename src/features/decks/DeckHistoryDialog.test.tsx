import { createElement, type ReactNode } from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DeckAuditEntry } from "@/lib/ipc";

const deckAuditList = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: { deckAuditList },
}));

import { DeckHistoryDialog, auditBand } from "./DeckHistoryDialog";

/** Unix **seconds**, like every stamp in this schema. Built from "now" so the day labels the
 *  dialog prints are stable whenever the suite runs. */
const NOW = Math.floor(Date.now() / 1000);
const DAY = 86_400;

let nextId = 1;
function entry(over: Partial<DeckAuditEntry> = {}): DeckAuditEntry {
  return {
    id: nextId++,
    deckId: 4,
    at: NOW,
    variant: "live",
    kind: "add",
    cardId: "p1",
    cardName: "Lightning Bolt",
    payload: '{"category":"Main deck","quantity":2}',
    delta: 2,
    ...over,
  };
}

let client: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client }, children);
}

function draw(props: Partial<Parameters<typeof DeckHistoryDialog>[0]> = {}) {
  const onDismiss = vi.fn();
  const onClose = vi.fn();
  const view = render(
    <DeckHistoryDialog deckId={4} open onDismiss={onDismiss} onClose={onClose} {...props} />,
    { wrapper },
  );
  return { ...view, onDismiss, onClose };
}

/** The dialog, once its first read has landed. `find`, not `get`: a `motion` element's first
 *  painted frame under jsdom carries its `initial`, so everything inside a freshly opened
 *  overlay has to be waited for. */
async function drawn(props: Partial<Parameters<typeof DeckHistoryDialog>[0]> = {}) {
  const view = draw(props);
  const panel = await screen.findByRole("dialog", { name: "History" });
  return { ...view, panel };
}

beforeEach(() => {
  nextId = 1;
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  deckAuditList.mockReset().mockResolvedValue([entry()]);
});

describe("auditBand", () => {
  /**
   * Nine kinds onto five chips, and `quantity` is the join that makes the mapping worth
   * having: a copy count going down is a removal to everyone except the schema.
   */
  it("routes a copy-count change by its own delta", () => {
    expect(auditBand(entry({ kind: "quantity", delta: -1 }))).toBe("removals");
    expect(auditBand(entry({ kind: "quantity", delta: 3 }))).toBe("adds");
    expect(auditBand(entry({ kind: "quantity", delta: 0 }))).toBe("adds");
  });

  /** The deck's shape rather than its contents — four kinds, one chip. */
  it("puts the four deck-shape kinds under one band", () => {
    for (const kind of ["label", "category", "folder", "deck"] as const) {
      expect(auditBand(entry({ kind }))).toBe("structure");
    }
  });

  /**
   * **The arm that matters.** `DeckAuditKind` is closed to the compiler and open on disk: a
   * newer build writes kinds this one has never seen, and a row that fell through would be a
   * hole in a log. Cast, because the whole point is a value the type says cannot exist.
   */
  it("gives a kind it has never heard of a band of its own", () => {
    expect(auditBand(entry({ kind: "teleported" as DeckAuditEntry["kind"] }))).toBe("other");
  });
});

describe("DeckHistoryDialog", () => {
  /** Closed is closed: no markup, and no read either — the editor keeps this mounted, and a
   *  dialog that asked anyway would spend a query on every deck the reader opens. */
  it("draws nothing and asks nothing while it is closed", () => {
    const { container } = draw({ open: false });

    expect(container).toBeEmptyDOMElement();
    expect(deckAuditList).not.toHaveBeenCalled();
  });

  it("reads one deck's history when it opens", async () => {
    await drawn();

    expect(deckAuditList).toHaveBeenCalledWith(4, 500);
  });

  /**
   * The count is the **whole** history and the date is its oldest row, so the line says how far
   * back the dialog can see. It rides beside the filter chips rather than beside the title,
   * because `Dialog`'s header takes a title and nothing else — and it is a caption for the
   * filter anyway. Both figures are read off the rows rather than told to the dialog, because a
   * count the backend sent separately is a count that can disagree with the list under it.
   */
  it("says how many changes there are and how far back they go", async () => {
    deckAuditList.mockResolvedValue([entry(), entry({ at: NOW - DAY * 4 }), entry()]);
    await drawn();

    const since = new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric" }).format(
      new Date((NOW - DAY * 4) * 1000),
    );
    expect(await screen.findByText(`3 changes since ${since}`)).toBeInTheDocument();
  });

  /**
   * Day sections come from `auditDays` and are not re-derived here. What this dialog adds is
   * the roll-up: gains and losses kept **apart** rather than netted, because a day that added
   * seven and cut six is not the quiet day one number would report it as.
   */
  it("groups the history into days and prints each day's copies in and out", async () => {
    deckAuditList.mockResolvedValue([
      entry({ delta: 7 }),
      entry({ kind: "remove", delta: -6 }),
      entry({ at: NOW - DAY, delta: 1 }),
    ]);
    await drawn();

    const today = await screen.findByRole("heading", { name: "Today" });
    expect(screen.getByRole("heading", { name: "Yesterday" })).toBeInTheDocument();

    const section = today.closest("section");
    expect(section).not.toBeNull();
    expect(within(section!).getByText("+7 / −6")).toBeInTheDocument();
    // The drawn figure reads as "plus seven slash minus six"; the spoken one is the sentence.
    // This is the only number in the dialog that no row's own sentence carries.
    expect(within(section!).getByText("7 copies added, 6 copies removed")).toBeInTheDocument();
    expect(within(section!).getByText("2 changes")).toBeInTheDocument();
  });

  /** A day whose rows moved no copies says so rather than showing a bare `+0`. */
  it("says a day changed no copies when none did", async () => {
    deckAuditList.mockResolvedValue([
      entry({ kind: "deck", cardId: null, payload: '{"field":"name","to":"Toolbox"}', delta: 0 }),
    ]);
    await drawn();

    expect(await screen.findByText("no copies")).toBeInTheDocument();
    expect(screen.getByText("no copies changed")).toBeInTheDocument();
  });

  /**
   * The sentence is `auditSentence`'s, **verbatim** — this component writes no wording at all,
   * which is the whole reason the wording lives in one module. Asserting the exact string here
   * is what would fail if a second copy of it ever appeared in the dialog.
   */
  it("draws each entry as the sentence, the detail line and the time", async () => {
    deckAuditList.mockResolvedValue([
      entry({ payload: '{"category":"Ramp","quantity":2}' }),
      entry({
        kind: "swap",
        cardName: "Sol Ring",
        payload: '{"fromSet":"cmm","toSet":"3ed","folded":true}',
        delta: 0,
      }),
    ]);
    const { panel } = await drawn();

    expect(await screen.findByText("Added 2 × Lightning Bolt")).toBeInTheDocument();
    expect(screen.getByText("to Ramp")).toBeInTheDocument();
    expect(screen.getByText("Swapped printing of Sol Ring")).toBeInTheDocument();
    // Set codes are stored lowercase and printed in capitals; the fold is the half that has to
    // be said, because a list that silently loses a line reads like a bug.
    expect(screen.getByText("CMM → 3ED · folded into one row")).toBeInTheDocument();
    // A `<time>` per row, carrying the machine-readable stamp its 24-hour label is short for.
    const times = panel.querySelectorAll("time");
    expect(times).toHaveLength(2);
    expect(times[0]).toHaveAttribute("datetime", new Date(NOW * 1000).toISOString());
  });

  /**
   * **Nothing may take the dialog down.** A payload is a string an older or newer build wrote,
   * so a malformed one degrades to the shortest honest sentence and the rows around it are
   * untouched.
   */
  it("keeps listing when a row's payload cannot be read", async () => {
    deckAuditList.mockResolvedValue([
      entry({ kind: "category", cardId: null, payload: "{oh dear", delta: 0 }),
      entry({ payload: '{"quantity":1}' }),
    ]);
    await drawn();

    expect(await screen.findByText("Changed category a category")).toBeInTheDocument();
    expect(screen.getByText("Added Lightning Bolt")).toBeInTheDocument();
  });

  describe("the kind filter", () => {
    /** Five chips, all on, so the dialog opens showing everything it has. */
    it("offers the five bands, every one pressed", async () => {
      await drawn();

      const group = screen.getByRole("group", { name: "Filter the history by kind" });
      const chips = within(group).getAllByRole("button");
      expect(chips.map((chip) => chip.textContent)).toEqual([
        "Adds",
        "Removals",
        "Moves",
        "Swaps",
        "Structure",
      ]);
      for (const chip of chips) expect(chip).toHaveAttribute("aria-pressed", "true");
    });

    it("hides a band when its chip is switched off, and says how much is left", async () => {
      deckAuditList.mockResolvedValue([
        entry(),
        entry({ kind: "remove", cardName: "Mana Crypt", payload: "{}", delta: -1 }),
      ]);
      await drawn();
      await screen.findByText("Removed Mana Crypt");

      await userEvent.click(screen.getByRole("button", { name: "Removals" }));

      expect(screen.queryByText("Removed Mana Crypt")).toBeNull();
      expect(screen.getByText("Added 2 × Lightning Bolt")).toBeInTheDocument();
      expect(screen.getByText("1 of 2 shown")).toBeInTheDocument();
    });

    /** The routing is visible where it matters: a copy count going down disappears with the
     *  removals, not with the adds. */
    it("hides a shrinking copy count with the removals", async () => {
      deckAuditList.mockResolvedValue([
        entry({ kind: "quantity", payload: '{"from":2,"to":1}', delta: -1 }),
      ]);
      await drawn();
      await screen.findByText("Changed Lightning Bolt from 2 to 1");

      await userEvent.click(screen.getByRole("button", { name: "Removals" }));

      expect(screen.queryByText("Changed Lightning Bolt from 2 to 1")).toBeNull();
    });

    /**
     * A filter that empties the list says which emptiness this is, and offers the way back —
     * "no changes recorded yet" under a filter the reader set would be a lie about their deck.
     */
    it("says a filter emptied the list, and puts it back", async () => {
      await drawn();
      await screen.findByText("Added 2 × Lightning Bolt");

      await userEvent.click(screen.getByRole("button", { name: "Adds" }));
      expect(screen.getByText("Nothing matches these filters.")).toBeInTheDocument();

      await userEvent.click(screen.getByRole("button", { name: "Show everything" }));
      expect(screen.getByText("Added 2 × Lightning Bolt")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Adds" })).toHaveAttribute("aria-pressed", "true");
    });

    /**
     * **The filter is the reader's and outlives a close**, which is why it is held above
     * {@link Dialog} rather than in the body: `children` render only while the dialog is
     * open, so a chip switched off inside it would come back on every time the reader opened
     * the history again. The query is the opposite case and is deliberately inside.
     */
    it("still has the reader's filter when it is closed and opened again", async () => {
      const { rerender } = await drawn();
      await screen.findByText("Added 2 × Lightning Bolt");
      await userEvent.click(screen.getByRole("button", { name: "Adds" }));

      rerender(
        <DeckHistoryDialog deckId={4} open={false} onDismiss={vi.fn()} onClose={vi.fn()} />,
      );
      // The panel outlives the flag by the length of its exit, so wait for it to go rather than
      // opening a second one beside the one still fading.
      await waitFor(() => expect(screen.queryByRole("dialog", { name: "History" })).toBeNull());
      rerender(<DeckHistoryDialog deckId={4} open onDismiss={vi.fn()} onClose={vi.fn()} />);

      await screen.findByRole("dialog", { name: "History" });
      expect(await screen.findByRole("button", { name: "Adds" })).toHaveAttribute(
        "aria-pressed",
        "false",
      );
      expect(screen.getByText("Nothing matches these filters.")).toBeInTheDocument();
    });

    /**
     * **A row in none of the five chips must still be reachable.** The audit contract grows,
     * and a kind this build has never met arrives with a chip of its own the moment one
     * exists — never as a row that quietly is not there.
     */
    it("grows a sixth chip for a kind it cannot name, and lists the row", async () => {
      deckAuditList.mockResolvedValue([
        entry({ kind: "teleported" as DeckAuditEntry["kind"], payload: "{}", delta: 0 }),
      ]);
      await drawn();

      const other = await screen.findByRole("button", {
        name: "Other, changes this version of the app has no name for",
      });
      expect(other).toHaveAttribute("aria-pressed", "true");
      // `auditText` is total over unknown kinds too, so the row still lists with a date and a
      // delta — which is more useful than a hole in the history.
      expect(screen.getByText("Changed the deck")).toBeInTheDocument();

      await userEvent.click(other);
      expect(screen.queryByText("Changed the deck")).toBeNull();
      expect(screen.getByText("Nothing matches these filters.")).toBeInTheDocument();
    });

    /** And it is absent the rest of the time: a filter for a thing that has never happened is
     *  a control that teaches the reader to stop reading the row. */
    it("offers no sixth chip when every row is one it knows", async () => {
      await drawn();

      expect(screen.queryByRole("button", { name: /^Other/ })).toBeNull();
    });
  });

  /**
   * The chrome is {@link Dialog}'s now — the scrim's outside click, the Tab trap, the
   * self-focus and the capture-phase `preventDefault()` are tested once, where they live. What
   * is left to check here is the **wiring**: that this component is on the ladder at all, and
   * that the two callbacks it is handed reach the two controls that mean them.
   */
  describe("the way out", () => {
    it("closes on Escape, and takes the dismiss route rather than the close one", async () => {
      const { onDismiss, onClose } = await drawn();

      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));

      expect(onDismiss).toHaveBeenCalledTimes(1);
      expect(onClose).not.toHaveBeenCalled();
    });

    /**
     * The ✕ is the shell's button wearing this dialog's `closeLabel`, and both halves are worth
     * pinning here: the name is the one `DeckEditor.test.tsx` presses by, and the route is the
     * one that hands the caret back.
     *
     * Named for what this file can actually check. The hand-back itself is the *opener's* — this
     * dialog is handed two callbacks and calling the right one is the whole of its part — so
     * "hands focus back" is asserted where the opener lives, in `DeckEditor.test.tsx`'s
     * `closes it on its own ✕, caret back on the trigger`. What matters here is the pair of
     * conditions that make a hand-back possible at all: `onDismiss` and not `onClose`, and the
     * dialog **still mounted** when it fires, since focusing a detached node lands the caret on
     * `<body>`.
     */
    it("takes the dismiss route on its own close button, while still mounted", async () => {
      const { onDismiss, onClose } = await drawn();
      let mountedAtDismiss = false;
      onDismiss.mockImplementation(() => {
        mountedAtDismiss = screen.queryByRole("dialog", { name: "History" }) !== null;
      });

      await userEvent.click(screen.getByRole("button", { name: "Close history" }));

      expect(onDismiss).toHaveBeenCalledTimes(1);
      expect(onClose).not.toHaveBeenCalled();
      expect(mountedAtDismiss).toBe(true);
    });

    /** The scrim is the outside click, and it moves no focus — the reader is already somewhere
     *  else. The mechanism is the shell's; that this dialog hands it `onClose` is this file's. */
    it("closes without moving focus when the scrim is pressed", async () => {
      const { container, onDismiss, onClose } = await drawn();

      await userEvent.click(container.firstElementChild!);

      expect(onClose).toHaveBeenCalledTimes(1);
      expect(onDismiss).not.toHaveBeenCalled();
    });
  });

  describe("when there is nothing to show", () => {
    /** A deck with no history is invited to make some, not shown a blank column. */
    it("invites the first change", async () => {
      deckAuditList.mockResolvedValue([]);
      await drawn();

      expect(await screen.findByText("No changes recorded yet.")).toBeInTheDocument();
      expect(screen.queryByText(/changes since/)).toBeNull();
    });

    /** A read in flight is not an empty deck, and says which it is. */
    it("says it is still reading", async () => {
      deckAuditList.mockReturnValue(new Promise(() => {}));
      draw();

      expect(await screen.findByText("Reading this deck's history…")).toBeInTheDocument();
    });

    /**
     * **The failure is reported before the emptiness.** A failed read has no rows either, and
     * calling it "no changes recorded yet" would tell the reader their history is gone.
     */
    it("says a failed read failed, in the words the backend used", async () => {
      deckAuditList.mockRejectedValue(new Error("BUSY: the database is being written to"));
      await drawn();

      expect(await screen.findByText("This deck's history could not be read.")).toBeInTheDocument();
      expect(screen.getByText(/BUSY: the database is being written to/)).toBeInTheDocument();
      expect(screen.queryByText("No changes recorded yet.")).toBeNull();
    });
  });
});
