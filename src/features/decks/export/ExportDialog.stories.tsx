import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import { ExportDialog } from "./ExportDialog";
import type { ExportCard } from "./format";
import { printing } from "../../../../.storybook/fake/fixtures";

/** How long a `waitFor` will wait for `DeckDialog`'s first frame — the shell's panel carries its
 *  `initial`, so nothing inside it is visible yet. `Decks/Dialog shell` has the whole reason and
 *  why the number is seconds; each file keeps its own copy because CSF would index an exported
 *  one as a story. */
const FRAME_WAIT = 5_000;

/**
 * The preview, read off the DOM rather than by role.
 *
 * It is a `<pre>` of generated text and has no role to be found by — and `getByText` is the wrong
 * tool for the same reason a regex matcher is: normalized text is matched against **every**
 * element, so a partial pattern finds the panel and the page as well as the block. `toHaveTextContent`
 * against this element is a substring test scoped to the one box that is supposed to hold it.
 */
function preview(canvasElement: HTMLElement): HTMLElement {
  const el = canvasElement.querySelector("pre");
  if (el === null) throw new Error("the export dialog drew no preview");
  return el;
}

/**
 * The pile being exported: printings out of the generated corpus rather than names typed here.
 *
 * Two in the pile, and with different set codes, because that is the smallest list that tells the
 * six formats apart — Arena, Moxfield and Archidekt name a printing where plain text and MTGO name
 * only a card, and CSV needs more than one row under its header to look like a file. The third is
 * the deck-scope story's cut pile ({@link SwitchedOffPile}): a category the reader has switched
 * off, which is the one card fact two of the six formats have nowhere to put.
 */
const BOLT = printing("2x2", "117");
const SOL_RING = printing("c21", "263");
const FOREST = printing("unf", "239");

/**
 * **The fixtures come from the corpus and the expected strings below are typed out, so the two
 * have to be pinned together.** This file's plays assert whole rendered lines — `1 Sol Ring (C21)
 * 263` — because the *shape* of a line is the thing under test, and a string derived from the same
 * row the writer derives it from would assert nothing about the format. The cost is that a wrong
 * `printing()` lookup shows up only as a spread of confusing play failures: `lea 288` looks like
 * Sol Ring and is **Island**, which is how this arrived. (No count here — every play below asserts
 * a line, so the number is a fact about this file's story list and would rot with the next one.)
 * So the pairing is checked here instead, at module
 * load, where the message says what happened — the same discipline `printing()` itself applies
 * when the corpus has no such row at all.
 */
if (BOLT.name !== "Lightning Bolt" || SOL_RING.name !== "Sol Ring" || FOREST.name !== "Forest") {
  throw new Error(
    `ExportDialog.stories: the fixture printings are ${BOLT.name}, ${SOL_RING.name} and ` +
      `${FOREST.name}; the expected export lines in this file are written for Lightning Bolt, ` +
      `Sol Ring and Forest.`,
  );
}

/**
 * One pile, which is the scope this dialog is opened in from a category heading's right-click.
 *
 * Every row carries the same three category fields because a pile has one name, one kind and one
 * switch — so the grouped formats write it as a single section, `Deck` in Arena's and Moxfield's
 * fixed vocabulary and `Ramp` in Archidekt's, which is the reader's own word for it.
 */
const CARDS: ExportCard[] = [
  {
    name: BOLT.name,
    quantity: 2,
    setCode: BOLT.setCode,
    collectorNumber: BOLT.collectorNumber,
    categoryName: "Ramp",
    categoryKind: "main",
    categoryActive: true,
  },
  {
    name: SOL_RING.name,
    quantity: 1,
    setCode: SOL_RING.setCode,
    collectorNumber: SOL_RING.collectorNumber,
    categoryName: "Ramp",
    categoryKind: "main",
    categoryActive: true,
  },
];

/**
 * The same pile plus a **switched-off** one, which is the deck-level scope: a whole deck holds
 * piles the reader has turned off, and `is_active = 0` is the whole of what a maybeboard is.
 *
 * Six copies on one row rather than six rows, deliberately — {@link SwitchedOffPile} is what says
 * the omission line counts *cards* and not rows.
 */
const DECK_CARDS: ExportCard[] = [
  ...CARDS,
  {
    name: FOREST.name,
    quantity: 6,
    setCode: FOREST.setCode,
    collectorNumber: FOREST.collectorNumber,
    categoryName: "Cuts",
    categoryKind: "main",
    categoryActive: false,
  },
];

/**
 * A pile of cards as text: a format, a live preview, Copy, and Save as….
 *
 * **This app had no export of any kind before this dialog.** It is opened from a deck category's
 * right-click, so `cards` arrives as a **prop** rather than as something this dialog fetches —
 * which is deliberately what lets a later deck-level export reuse it whole, over the deck's full
 * list instead of one pile's. Nothing on this page reaches the deck at all.
 *
 * **Built on `DeckDialog`**, the deck surface's shared modal shell, rather than carrying its own
 * copy of the chrome; the body lives one floor down, so `open={false}` mounts nothing at all —
 * no format state, no memoized preview text. See {@link Closed}.
 *
 * ## What a story can drive here, and what it cannot
 *
 * The **file picker's own half is unverifiable in a browser** — `dialog:allow-save` opens a native
 * window CDP cannot reach — so what the workbench stands in for is the *answer*: the fake's
 * command table carries `plugin:dialog|save`, which hands back a path under `D:\Storybook\` built
 * from the dialog's own `defaultPath`. That is not the same decision as the importer's picker,
 * which throws: there the invented thing would be the **decklist**, and here it is a file name
 * over text the reader is already looking at. So {@link SaveRefused} really does travel
 * press → path → `export_write_file` → the refusal drawn in the app's own words.
 *
 * The one arm still out of reach is **Cancel**, which resolves `null` — writing *that* string to
 * disk is the trap this dialog's guard exists for, and `ExportDialog.test.tsx` pins it by mocking
 * `save` directly. A `null` from the fake would make every save story a story about Cancel.
 *
 * **Its own frame per docs story**, like every dialog here: the shell's scrim is `fixed inset-0`,
 * so rendered inline it would cover the whole docs page rather than its own block. The iframe
 * buys a second thing this page needs — one fake world per story, so the world
 * {@link SaveRefused} refuses in cannot be the world another story's press is answered from.
 */
const meta = {
  title: "Decks/Export dialog",
  component: ExportDialog,
  tags: ["autodocs"],
  args: {
    open: true,
    subject: "Ramp",
    cards: CARDS,
    suggestedFileName: "Ramp",
    onDismiss: fn(),
    onClose: fn(),
  },
  parameters: {
    layout: "fullscreen",
    docs: { story: { inline: false, height: "600px" } },
  },
} satisfies Meta<typeof ExportDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * **Plain text**, which is what the dialog opens on — `quantity name`, and nothing about the
 * printing.
 *
 * The six formats are drawn in `EXPORT_FORMATS`' own order and deliberately **not** through
 * `sortOptions`: plain first is the one most readers want, the same kind of deliberate order the
 * app's option-list rule exempts a grade scale for. They are a `radiogroup`, because picking one
 * is picking *instead of* the others and the preview under them is a single answer. The row
 * **maps that array** rather than listing them, so this play counts the writers `format.ts` has.
 */
export const PlainText: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const dialog = await canvas.findByRole("dialog", { name: 'Export "Ramp"' });

    // The panel's arrival, waited out once — everything under it lands in the same tick. See
    // {@link FRAME_WAIT}.
    await waitFor(async () => await expect(dialog).toBeVisible(), { timeout: FRAME_WAIT });

    const group = canvas.getByRole("radiogroup", { name: "Export format" });
    const formats = within(group).getAllByRole("radio");
    await expect(formats.map((r) => r.textContent)).toEqual([
      "Plain text",
      "MTGO",
      "Arena",
      "Moxfield",
      "Archidekt",
      "CSV",
    ]);
    await expect(formats[0]).toHaveAttribute("aria-checked", "true");

    await expect(preview(canvasElement)).toHaveTextContent("2 Lightning Bolt 1 Sol Ring");
  },
};

/**
 * **MTGO**, which for a main-deck pile writes exactly what plain text does — and that is the
 * format's own answer rather than a gap here.
 *
 * MTGO's export omits the printing entirely: it resolves a name against whatever copies a player
 * owns rather than pinning one, so naming a set would be a promise this format was never in a
 * position to keep. Both arms share `plainLine`, and what MTGO adds is a per-line `SB:` prefix on
 * a sideboard or a companion — a one-line override rather than a heading, which is exactly how
 * this app's own importer reads it back. A one-pile export has none, so the two agree here.
 */
export const Mtgo: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(
      async () => await expect(canvas.getByRole("radio", { name: "MTGO" })).toBeVisible(),
      { timeout: FRAME_WAIT },
    );

    await userEvent.click(canvas.getByRole("radio", { name: "MTGO" }));
    await expect(canvas.getByRole("radio", { name: "MTGO" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await expect(preview(canvasElement)).toHaveTextContent("2 Lightning Bolt 1 Sol Ring");
    // No set code anywhere in it — the whole of what makes this format different from Moxfield's.
    await expect(preview(canvasElement).textContent).not.toMatch(/2X2|C21/);
  },
};

/**
 * **Moxfield** — `quantity name (SET) collectorNumber` under a **section heading**, and one of
 * three formats here that name a printing rather than just a card.
 *
 * The set code is uppercased for the reason the importer uppercases the one it reads: `(2x2)` and
 * `(2X2)` are the same set, and a decklist this app writes should pick one spelling rather than
 * echo whatever case the row happened to store.
 *
 * **The heading is written even for a single section**, which is what makes this format different
 * from the plain paste above it: the vocabulary is fixed — `Commander`, `Companion`, `Deck`,
 * `Sideboard`, `Maybeboard`, in that ladder — so `Deck` is a fact about where these cards are
 * rather than a separator a one-pile file could do without. **Arena writes the identical text**;
 * the two differ only in what reaches the writer, which is {@link SwitchedOffPile}'s subject.
 */
export const Moxfield: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(
      async () => await expect(canvas.getByRole("radio", { name: "Moxfield" })).toBeVisible(),
      { timeout: FRAME_WAIT },
    );

    await userEvent.click(canvas.getByRole("radio", { name: "Moxfield" }));
    await expect(preview(canvasElement)).toHaveTextContent(
      "Deck 2 Lightning Bolt (2X2) 117 1 Sol Ring (C21) 263",
    );
  },
};

/**
 * **Archidekt** — `1x`, a **lowercase** set code, and the pile's own name in brackets.
 *
 * Lowercase against every other writer here on purpose: it is what Archidekt itself emits, and the
 * point of a format named for a site is that the site reads it back. Our own parser uppercases
 * what it reads, so the round trip is unaffected either way.
 *
 * It is the one format whose headings are the **reader's** words rather than a fixed vocabulary —
 * grouped by `categoryName` in the caller's own array order, so a deck comes out filed the way the
 * reader filed it and nothing here re-files it on the way out. It is also the only one that can
 * say `{noDeck}`, which is what makes an export and a re-import keep a maybeboard; see
 * {@link SwitchedOffPile}.
 */
export const Archidekt: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(
      async () => await expect(canvas.getByRole("radio", { name: "Archidekt" })).toBeVisible(),
      { timeout: FRAME_WAIT },
    );

    await userEvent.click(canvas.getByRole("radio", { name: "Archidekt" }));
    await expect(preview(canvasElement)).toHaveTextContent(
      "Ramp 2x Lightning Bolt (2x2) 117 [Ramp] 1x Sol Ring (c21) 263 [Ramp]",
    );
  },
};

/**
 * **CSV**, with the header row a spreadsheet needs.
 *
 * A field is quoted only when it carries a comma, a quote or a newline — never otherwise, so
 * `Lightning Bolt` stays `Lightning Bolt` rather than becoming `"Lightning Bolt"` on every row.
 * The extension changes with it (`.csv`), which is what the save dialog is seeded with. The last
 * column is the pile's own name, which is how a spreadsheet keeps the filing the five text
 * formats say with a heading.
 *
 * **It is write-only and stays so**: nothing in `parse.ts` reads a comma-separated decklist, and
 * teaching it one would be a second grammar rather than a rule inside the one there is.
 *
 * **An empty pile is an empty string in every format, this one included**: a header over no rows
 * is a file that claims to be a decklist and is not one. See {@link EmptyPile}.
 */
export const Csv: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(
      async () => await expect(canvas.getByRole("radio", { name: "CSV" })).toBeVisible(),
      { timeout: FRAME_WAIT },
    );

    await userEvent.click(canvas.getByRole("radio", { name: "CSV" }));
    await expect(preview(canvasElement)).toHaveTextContent(
      "Quantity,Name,Set,Collector number,Category",
    );
    await expect(preview(canvasElement)).toHaveTextContent("2,Lightning Bolt,2x2,117,Ramp");
    // The set code is **not** uppercased here, unlike Moxfield's: a CSV column is data for
    // something else to read, and the row's own spelling is what it stores.
    await expect(preview(canvasElement)).toHaveTextContent("1,Sol Ring,c21,263,Ramp");
  },
};

/**
 * A deck with a **switched-off pile** in it, and the one sentence two of the six formats owe the
 * reader because of it.
 *
 * `is_active = 0` is the whole of what a maybeboard is here, and the formats divide on whether
 * they have anywhere to put one. **Arena and MTGO do not** — writing a maybeboard into an Arena
 * deck produces an illegal import at the other end — so they write only the piles that are
 * switched on, and the dialog says how many cards that cost **in copies**: six Forests on one row
 * are six cards missing from the file, and "1 card" would be a true statement about the array and
 * a false one about the deck. **Moxfield has a `Maybeboard` section and Archidekt has `{noDeck}`**,
 * so both write the pile and leave nothing out — and the line goes with the format that needed it.
 *
 * **Not a `role="alert"`, deliberately**: nothing failed. It is a fact about the text underneath
 * it, which is why it sits between the radios and the preview rather than down beside the two
 * failure lines — and why it has to be on screen *before* Copy is pressed rather than after.
 */
export const SwitchedOffPile: Story = {
  args: { subject: "Atraxa", cards: DECK_CARDS, suggestedFileName: "Atraxa" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(
      async () => await expect(canvas.getByRole("radio", { name: "Arena" })).toBeVisible(),
      { timeout: FRAME_WAIT },
    );

    await userEvent.click(canvas.getByRole("radio", { name: "Arena" }));
    await expect(
      canvas.getByText("6 cards in switched-off piles are not written in this format."),
    ).toBeVisible();
    // Said before Copy could be pressed, and true of the text on screen: no Forest in it.
    await expect(preview(canvasElement).textContent).not.toMatch(/Forest/);

    // Moxfield puts the cut pile in its maybeboard, so nothing is left out and the line goes.
    await userEvent.click(canvas.getByRole("radio", { name: "Moxfield" }));
    await expect(preview(canvasElement)).toHaveTextContent("Maybeboard 6 Forest (UNF) 239");
    await expect(canvas.queryByText(/not written in this format/)).toBeNull();

    // Archidekt keeps the reader's own word for the pile and flags it, which is what makes an
    // export and a re-import agree about a maybeboard.
    await userEvent.click(canvas.getByRole("radio", { name: "Archidekt" }));
    await expect(preview(canvasElement)).toHaveTextContent(
      "Cuts 6x Forest (unf) 239 [Cuts{noDeck}]",
    );
    await expect(canvas.queryByText(/not written in this format/)).toBeNull();
  },
};

/**
 * Copy, and the status line that is a **claim about the clipboard's contents**.
 *
 * It is cleared the moment that claim could go stale. Switching format redraws the preview and
 * does nothing at all to the clipboard, which still holds whatever text was on screen at the last
 * Copy — so the radios clear `copied` on every press rather than leaving "Copied." sitting beside
 * text it is no longer true of. (Found in review, 2026-08-14.)
 *
 * The clipboard goes through `tauri-plugin-clipboard-manager` rather than `navigator.clipboard`,
 * so it is a real command that can be refused; the fake answers `write_text` and this story is the
 * accepted half. `ExportDialog.test.tsx` covers the rejection, which reports through the same
 * `role="alert"` a refused save uses.
 */
export const Copied: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(
      async () => await expect(canvas.getByRole("button", { name: "Copy" })).toBeVisible(),
      {
        timeout: FRAME_WAIT,
      },
    );

    await userEvent.click(canvas.getByRole("button", { name: "Copy" }));
    await waitFor(
      async () => await expect(canvas.getByRole("status")).toHaveTextContent("Copied."),
    );

    // The claim goes with the text it was about.
    await userEvent.click(canvas.getByRole("radio", { name: "CSV" }));
    await waitFor(async () => await expect(canvas.queryByRole("status")).toBeNull());
    await expect(canvas.queryByRole("alert")).toBeNull();
  },
};

/**
 * **Save as…**, all the way through: the picker's answer, then Rust writing at it.
 *
 * Rust writes the file because `dialog:allow-save` answers a *path* and nothing more, and writing
 * bytes at that path from the page would need an `fs:` permission this app grants nowhere — the
 * same shape `deck_set_cover_image` established in the other direction.
 *
 * Nothing is drawn on success, deliberately: the file is on disk and the dialog stays where it
 * was. So the whole of the happy path is that **no alert appeared**, which is exactly what a
 * reader sees — and {@link SaveRefused} is the control that makes that assertion able to fail:
 * the same press, one fault apart, really does draw one.
 */
export const Saved: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(
      async () => await expect(canvas.getByRole("button", { name: "Save as…" })).toBeVisible(),
      { timeout: FRAME_WAIT },
    );

    const button = canvas.getByRole("button", { name: "Save as…" });
    await userEvent.click(button);

    // **Wait for something positive first.** `queryByRole("alert")` is null on the tick after the
    // press — before `save()`'s promise, the write and the `catch` have run — so a `waitFor` on
    // the absence alone is satisfied by the very first poll and would stay green over a save that
    // failed a moment later. `aria-busy` is set synchronously by the press and cleared in the
    // `finally`, so waiting for it to go is waiting for the whole round trip to have finished.
    await waitFor(async () => await expect(button).not.toHaveAttribute("aria-busy"));
    await expect(canvas.queryByRole("alert")).toBeNull();

    // A saved export does not close the dialog either — the reader may want another format.
    await expect(args.onDismiss).not.toHaveBeenCalled();
    await expect(canvas.getByRole("dialog", { name: 'Export "Ramp"' })).toBeVisible();
    await expect(preview(canvasElement)).toHaveTextContent("2 Lightning Bolt");
  },
};

/**
 * The disk refusing the path the reader chose — a read-only stick, a folder that has since gone.
 *
 * **Reported, and not fatal to the dialog.** The reader's text is still on screen and still
 * copyable, so a refused write must not throw either away: the sentence lands in a `role="alert"`
 * beneath the buttons and everything else stays exactly where it was.
 *
 * The words are `export.rs`' own, through `ipcError` — `could not write {path}: {os error}` — and
 * the **path is half of it**, which is why the fake's refusal names the file rather than
 * apologising in general terms. The `exportWriteError` fault is the only way to reach it.
 */
export const SaveRefused: Story = {
  parameters: { fake: { fault: "exportWriteError" } },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(
      async () => await expect(canvas.getByRole("button", { name: "Save as…" })).toBeVisible(),
      { timeout: FRAME_WAIT },
    );

    await userEvent.click(canvas.getByRole("button", { name: "Save as…" }));

    const alert = await canvas.findByRole("alert");
    await expect(alert).toHaveTextContent("Could not save that export");
    // The file the reader named, and the reason — both halves of the sentence.
    await expect(alert).toHaveTextContent("Ramp.txt");
    await expect(alert).toHaveTextContent("Access is denied");

    // Everything the reader could still act on is untouched.
    await expect(args.onDismiss).not.toHaveBeenCalled();
    await expect(preview(canvasElement)).toHaveTextContent("2 Lightning Bolt");
    await expect(canvas.getByRole("button", { name: "Copy" })).toBeVisible();
  },
};

/**
 * A pile with nothing in it — **an empty string in every format, CSV's header included**.
 *
 * A header row over no rows is a file that claims to be a decklist and is not one, so `formatExport`
 * answers `""` before it reaches a writer at all. The dialog still opens: an empty column is a
 * thing a reader can right-click, and a menu row that refused to open would be one they could not
 * tell from a broken one.
 */
export const EmptyPile: Story = {
  args: { subject: "Sideboard", cards: [], suggestedFileName: "Sideboard" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const dialog = await canvas.findByRole("dialog", { name: 'Export "Sideboard"' });
    await waitFor(async () => await expect(dialog).toBeVisible(), { timeout: FRAME_WAIT });

    await expect(preview(canvasElement).textContent).toBe("");
    await userEvent.click(canvas.getByRole("radio", { name: "CSV" }));
    await expect(preview(canvasElement).textContent).toBe("");
  },
};

/**
 * Closed draws **no dialog at all** — not a scrim, not a panel, not an off-screen one.
 *
 * The body is passed to `DeckDialog` as an *element*, and an element React never puts in the tree
 * is a component that never ran — so the chosen format, the memoized preview and the copy status
 * all begin at the open, and every reopen starts on Plain text.
 *
 * **The play can only show the weaker half of that** and says so rather than implying more: a
 * `queryByRole` finding nothing is equally true of a panel that is merely hidden. What pins the
 * real claim is the shell's own first test, which renders a body reporting its mount through a spy.
 */
export const Closed: Story = {
  args: { open: false },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).queryByRole("dialog")).toBeNull();
  },
};
