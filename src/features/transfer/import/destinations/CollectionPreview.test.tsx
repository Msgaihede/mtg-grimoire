/**
 * The collection destination's preview, mounted directly — what is under test is what the step
 * **says** about a file before the reader commits, not the dialog's step machine.
 *
 * Facts that live here and nowhere else: a `Purchase price` cell the file filled and the parser
 * refused is **listed**, because the copy lands with no price and this list is the only place the
 * reader learns the cell was not empty; a `set` file's headline is the **dry run's** count and
 * never "N cards will be added" (issue #555); and a landed import leaves an undo offer behind for
 * the collection page to draw. `planCollectionImport`'s own test proves the plan carries each
 * line; this proves the line reaches the screen.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetBulkUndo, useBulkUndo } from "@/lib/bulkUndo";
import type { ImportCommitOutcome, ImportResolveRow } from "@/lib/ipc";
import { parseDecklist } from "../parse";

const collectionImportPreview = vi.hoisted(() => vi.fn());
const collectionImportCommit = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ipc")>();
  return { ...actual, ipc: { ...actual.ipc, collectionImportPreview, collectionImportCommit } };
});

import { CollectionPreview } from "./CollectionPreview";

/**
 * A resolved row, with everything this preview does not read left out. **The card id is the
 * name's**, so two lines naming one card resolve to one printing and fold — which a per-index id
 * would never let happen — and every printing is English, which is what the corpus holds for a
 * line whose file named another language.
 */
const hit = (index: number, name: string): ImportResolveRow =>
  ({
    index,
    hintMissed: false,
    matched: {
      cardId: `c-${name}`,
      oracleId: `o-${name}`,
      name,
      setCode: "ltc",
      collectorNumber: "1",
      lang: "en",
    },
  }) as unknown as ImportResolveRow;

const outcome = (over: Partial<ImportCommitOutcome> = {}): ImportCommitOutcome => ({
  added: 0,
  updated: 0,
  removed: 0,
  copies: 0,
  leftInFolders: 0,
  undoId: null,
  ...over,
});

function mount(csv: string) {
  const list = parseDecklist(csv);
  const onDone = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <CollectionPreview
        list={list}
        resolved={list.lines.map((line, i) => hit(i, line.name))}
        tags={[]}
        onDone={onDone}
        onBack={vi.fn()}
      />
    </QueryClientProvider>,
  );
  return { onDone };
}

/** The radio's name is its whole label, hint included — `ModeRadios` wraps both in one `<label>`
 *  — so it is found by its opening words. */
const setRadio = () => screen.getByRole("radio", { name: /^Set these quantities/ });

const CAPTION =
  "1 line had a purchase price this app could not read, and will be added without one";

beforeEach(() => {
  collectionImportPreview.mockReset().mockResolvedValue(outcome());
  collectionImportCommit.mockReset().mockResolvedValue(outcome({ added: 1 }));
  resetBulkUndo();
});

describe("CollectionPreview", () => {
  /** An older build's `1.125` — refused as ambiguous — is named with its line and its words. */
  it("lists a purchase price it could not read, by line", () => {
    mount("Quantity,Name,Purchase price\n1,Sol Ring,4.25\n1,Lightning Bolt,1.125\n");

    expect(screen.getByText(CAPTION)).toBeInTheDocument();
    expect(screen.getByText(`line 3 · Lightning Bolt — "1.125"`)).toBeInTheDocument();
    expect(screen.getByText(/2 cards will be added/)).toBeInTheDocument();
  });

  /** The control: every cell reads, so there is nothing to list — the caption is the list's. */
  it("says nothing when every price reads", () => {
    mount("Quantity,Name,Purchase price\n1,Sol Ring,4.25\n1,Lightning Bolt,1.1250\n");

    expect(screen.queryByText(CAPTION)).toBeNull();
    expect(screen.queryByText(/could not read/)).toBeNull();
  });

  /** `add` needs no count — its sentence is the file's own total — so the dry run is never
   *  asked, which is also what keeps every other suite mounting this preview free of a mock. */
  it("asks for no dry run under add", () => {
    mount("1 Sol Ring\n");

    expect(screen.getByText("1 card will be added to your collection.")).toBeInTheDocument();
    expect(collectionImportPreview).not.toHaveBeenCalled();
  });
});

/**
 * **Issue #555: "N cards will be added" over a `set` was wrong about what the button does.** A
 * `set` lowers some quantities and deletes others, and before the backend counted filed copies it
 * doubled them — so the headline is the backend's own count of the same write, run dry.
 */
describe("CollectionPreview under set", () => {
  it("draws the dry run's count, not the file's total", async () => {
    const user = userEvent.setup();
    collectionImportPreview.mockResolvedValue(
      outcome({ added: 5, updated: 20, removed: 2, copies: 12 }),
    );
    mount("Quantity,Name\n4,Sol Ring\n2,Lightning Bolt\n");

    await user.click(setRadio());

    expect(
      await screen.findByText(
        "Sets how many you hold of 2 cards: 5 new, 20 changed, 2 removed — 12 more copies than now.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/will be added/)).toBeNull();
    expect(collectionImportPreview).toHaveBeenCalledWith(
      [
        expect.objectContaining({ cardId: "c-Sol Ring", quantity: 4 }),
        expect.objectContaining({ cardId: "c-Lightning Bolt", quantity: 2 }),
      ],
      "set",
    );
  });

  /** A lower number is `fewer`, never `-3 more`; the copies a folder keeps are said beside it. */
  it("says fewer copies, and what folders keep", async () => {
    const user = userEvent.setup();
    collectionImportPreview.mockResolvedValue(
      outcome({ updated: 1, copies: -3, leftInFolders: 7 }),
    );
    mount("1 Sol Ring\n");

    await user.click(setRadio());

    expect(
      await screen.findByText("Sets how many you hold of 1 card: 1 changed — 3 fewer copies than now."),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "7 copies filed in folders are more than the file lists; they stay where they are.",
      ),
    ).toBeInTheDocument();
  });

  it("says in words when every number already matches", async () => {
    const user = userEvent.setup();
    mount("1 Sol Ring\n");

    await user.click(setRadio());

    expect(
      await screen.findByText(
        "Sets how many you hold of 1 card: every number already matches, so nothing changes.",
      ),
    ).toBeInTheDocument();
    // Nothing is filed beyond the file's number, so there is nothing to say about folders.
    expect(screen.queryByText(/more than the file lists/)).toBeNull();
  });

  it("draws a neutral sentence while the dry run is counting", async () => {
    const user = userEvent.setup();
    collectionImportPreview.mockReturnValue(new Promise(() => {}));
    mount("1 Sol Ring\n");

    await user.click(setRadio());

    expect(screen.getByText("Counting what setting 1 card would change…")).toBeInTheDocument();
  });

  /** A refused count is a courtesy failing, not the import failing: the reader still presses
   *  Import, and the write carries its own refusal if it has one. */
  it("says a refused count and still lets the reader import", async () => {
    const user = userEvent.setup();
    collectionImportPreview.mockRejectedValue("The card database is busy finishing a sync.");
    const { onDone } = mount("1 Sol Ring\n");

    await user.click(setRadio());

    expect(
      await screen.findByText(
        "What that would change could not be counted — The card database is busy finishing a sync.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Sets how many you hold of 1 card.")).toBeInTheDocument();

    const importButton = screen.getByRole("button", { name: "Import" });
    expect(importButton).toBeEnabled();
    await user.click(importButton);
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(collectionImportCommit).toHaveBeenCalledWith(expect.any(Array), "set");
  });

  /** By its text rather than through the radio's accessible name: `ModeRadios` runs the label
   *  and the hint together (`…quantitiesThe file's…`), which is that component's to fix. */
  it("says the file's number is the total, folders included", () => {
    mount("1 Sol Ring\n");

    expect(
      screen.getByText(
        "The file's number becomes how many you hold, copies filed in folders included.",
      ),
    ).toBeInTheDocument();
  });
});

describe("CollectionPreview's own warnings", () => {
  it("lists a language the corpus had no printing in, and one it could not read", () => {
    mount("Quantity,Name,Language\n1,Lightning Bolt,Japanese\n1,Sol Ring,Klingon\n");

    expect(
      screen.getByText(
        "1 line named a language this app's card data has no printing of, and will be added in the language it has",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText("line 2 · Lightning Bolt — the file says Japanese; added as English"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "1 line named a language this app does not recognise, and was matched without it",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(`line 3 · Sol Ring — "Klingon"`)).toBeInTheDocument();
  });

  it("lists every line it merged into an earlier one", () => {
    mount("Quantity,Name\n1,Lightning Bolt\n1,Sol Ring\n2,Lightning Bolt\n");

    expect(
      screen.getByText(
        "1 line named a copy an earlier line already named, and was merged into it",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("line 4 → line 2 · Lightning Bolt")).toBeInTheDocument();
    // The merge is a count the reader can check against the file: three lines, four copies.
    expect(screen.getByText("4 cards will be added to your collection.")).toBeInTheDocument();
  });

  it("lists a merged price in another currency, and a tradelist that is not a whole number", () => {
    mount(
      "Quantity,Name,Purchase price,Purchase currency,Tradelist quantity\n" +
        "1,Lightning Bolt,4,USD,1\n1,Lightning Bolt,3,EUR,\n1,Sol Ring,,,2.5\n",
    );

    expect(
      screen.getByText(
        "1 merged line had a purchase price in a different currency from the copy it joined, and that price was left out",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(`line 3 → line 2 · Lightning Bolt — "3" in EUR, kept in USD`),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "1 line had a tradelist quantity that is not a whole number, and will be added without one",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(`line 4 · Sol Ring — "2.5"`)).toBeInTheDocument();
  });
});

/**
 * **A landed import can be taken back, and this preview is where the ticket is handed over** —
 * `offerUndo` publishes it and the collection page draws it. The label is already pluralised and
 * names the act, because `add` and `set` are two different things to undo.
 */
describe("CollectionPreview's undo offer", () => {
  it("offers to undo an add, in words that say what it imported", async () => {
    const user = userEvent.setup();
    collectionImportCommit.mockResolvedValue(outcome({ added: 2, copies: 3, undoId: 41 }));
    const { onDone } = mount("Quantity,Name\n2,Sol Ring\n1,Lightning Bolt\n");

    await user.click(screen.getByRole("button", { name: "Import" }));

    await waitFor(() => expect(onDone).toHaveBeenCalledWith("2 added, 0 updated."));
    expect(useBulkUndo.getState().offers.collection).toEqual({
      id: 41,
      scope: "collection",
      label: "Imported 3 cards into your collection.",
    });
  });

  it("offers to undo a set, and says a set removed what it removed", async () => {
    const user = userEvent.setup();
    collectionImportCommit.mockResolvedValue(
      outcome({ updated: 1, removed: 1, copies: -2, undoId: 42 }),
    );
    const { onDone } = mount("Quantity,Name\n2,Sol Ring\n1,Lightning Bolt\n");

    await user.click(setRadio());
    await user.click(screen.getByRole("button", { name: "Import" }));

    await waitFor(() => expect(onDone).toHaveBeenCalledWith("0 added, 1 updated, 1 removed."));
    expect(useBulkUndo.getState().offers.collection).toEqual({
      id: 42,
      scope: "collection",
      label: "Set quantities from a file of 2 cards.",
    });
  });

  /** `null` is what an outcome answers when nothing changed; there is nothing to take back. */
  it("offers nothing when the write changed nothing", async () => {
    const user = userEvent.setup();
    const { onDone } = mount("1 Sol Ring\n");

    await user.click(screen.getByRole("button", { name: "Import" }));

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(useBulkUndo.getState().offers.collection).toBeNull();
  });
});
