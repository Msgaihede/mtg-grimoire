import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { DeckCategory, DeckFolder } from "@/lib/ipc";
import { openDropdown, pickOption } from "@/test-dropdown";
import { AUTO_CATEGORY } from "./autoCategory";
import type { DeckCoverPickerProps } from "./DeckCoverPicker";
// The contract the group is drawn from. Imported rather than respelled, so a test that
// passed against a label this file had invented could not exist.
import { DECK_KIND_HINT, DECK_KIND_LABEL } from "./deckKind";
import {
  DeckSettingsForm,
  folderPaths,
  type DeckSettingsFormProps,
  type DeckSettingsValue,
} from "./DeckSettingsForm";

/**
 * The cover picker, stubbed.
 *
 * It is a component with a backend of its own — a card search and an image cache — and none of
 * that is what this file is about. What *is* about this file is that the props arrive unread and
 * unaltered, which is what the stub echoes back into the DOM. The picker's own behaviour is
 * `DeckCoverPicker.test.tsx`'s.
 *
 * The stub echoed a third attribute, `data-uploading`, until the custom cover was deleted: the
 * picker had a file picker of its own and a re-encode to be pending on, and neither exists now.
 */
vi.mock("./DeckCoverPicker", () => ({
  DeckCoverPicker: (props: DeckCoverPickerProps) => (
    <div
      data-testid="cover"
      data-cover-card={props.coverCardId ?? ""}
      data-prefix={props.idPrefix}
    />
  ),
}));

const VALUE: DeckSettingsValue = {
  gameKey: "any",
  name: "Burn",
  formatKey: "modern",
  description: "Twenty damage, quickly.",
  // Both false, which `deckKind` reads as `regular` — the kind every deck is born as, and
  // the state every deck that predates `decks.virtual_only` (schema v40) is in.
  theoryEnabled: false,
  virtualOnly: false,
  // All three marks on, which is what `decks.theory_mark_exact`/`_name`/`_unplanned` default to
  // — so a deck that has never been asked about them is the fixture, and switching one off is
  // what a test does deliberately rather than what it starts from.
  theoryMarkExact: true,
  theoryMarkName: true,
  theoryMarkUnplanned: true,
  folderId: null,
  defaultCategoryId: AUTO_CATEGORY,
};

/**
 * The deck's piles, **in `sortOrder` and not alphabetically** — the order the reader dragged
 * them into, which is what this select has to offer.
 *
 * `Maybeboard` is seeded `isActive: false` in the app and is written that way here on purpose:
 * an inactive pile is offered like any other, because `isActive` decides what a pile *counts*
 * toward and never whether cards may be filed into it.
 */
const CATEGORIES: DeckCategory[] = [
  { id: 11, name: "Main deck", isActive: true },
  { id: 12, name: "Sideboard", isActive: true },
  { id: 13, name: "Maybeboard", isActive: false },
].map((c, i) => ({
  deckId: 4,
  kind: "main" as const,
  origin: "user" as const,
  sortOrder: i,
  cardCount: 0,
  totalPrice: null,
  cardCountAllVariants: 0,
  ...c,
}));

/** Already alphabetical, because the host sorts: `pickerFormats` is where that rule is applied. */
const FORMATS = [
  { key: "casual", name: "Casual" },
  { key: "commander", name: "Commander" },
  { key: "modern", name: "Modern" },
];

/** Already `folderPaths`' answer, for the same reason. */
const PATHS = [
  { id: 1, path: "Commander" },
  { id: 2, path: "Commander › Legends" },
];

const COVER: DeckCoverPickerProps = {
  coverCardId: "c-Lightning Bolt",
  coverArtist: "Christopher Rush",
  deckCards: [],
  onPickCard: vi.fn(),
  idPrefix: "cover",
};

/**
 * The form with a host holding its value, which is what both real hosts are.
 *
 * Rendering it against a frozen `value` would make every text field reject its own keystrokes —
 * a controlled input whose prop never moves resets to the prop on the next render — so the
 * "typing fires `onChange`" claim would be true of one character and of nothing else.
 */
function Harness({
  onChange,
  onCommit,
  value: initial = VALUE,
  ...rest
}: Partial<Omit<DeckSettingsFormProps, "onChange">> & {
  onChange?: (patch: Partial<DeckSettingsValue>) => void;
}) {
  const [value, setValue] = useState<DeckSettingsValue>(initial);
  return (
    <DeckSettingsForm
      value={value}
      onChange={(patch) => {
        onChange?.(patch);
        setValue((v) => ({ ...v, ...patch }));
      }}
      onCommit={onCommit}
      // Passed through rather than spied by default: whether a host supplies it is the whole
      // of what changes Enter's meaning, so a harness that always supplied one could not test
      // the settings dialog's half at all.
      onSubmit={rest.onSubmit}
      formats={rest.formats ?? FORMATS}
      folders={rest.folders ?? { paths: PATHS, unread: null, loading: false, pending: false }}
      // `"categories" in rest` rather than `??`, because **absent is a state with its own
      // meaning here** — the create host, which has no deck yet and therefore draws no
      // "Add cards to" row at all. A default would make that case untestable.
      categories={"categories" in rest ? rest.categories : CATEGORIES}
      // Defaulted to the **edit** host's answer, like `categories` above and for the same reason:
      // absent is the create dialog, which is one case rather than the ordinary one. A test that
      // wants that case passes `false` and says so.
      canSetTheoryMarks={rest.canSetTheoryMarks ?? true}
      cover={rest.cover ?? COVER}
      idPrefix={rest.idPrefix ?? "s"}
    />
  );
}

/** The two callbacks, spied, plus the rendered form. */
function form(props: Parameters<typeof Harness>[0] = {}) {
  const onChange = vi.fn();
  const onCommit = vi.fn();
  const view = render(<Harness onChange={onChange} onCommit={onCommit} {...props} />);
  return { onChange, onCommit, ...view };
}

/**
 * Every kind button that is pressed, by its visible word.
 *
 * A **list**, so "exactly one" is a claim a test can make: a helper answering the first pressed
 * button would pass just as happily against a group that had lit two.
 *
 * Addressed through `aria-pressed` rather than through the `bg-accent` class the pressed half
 * wears — a class assertion is vacuous here twice over, since jsdom loads no stylesheet and the
 * unpressed half's `hover:text-text` would satisfy a substring match on the same attribute.
 */
function pressedKinds(): string[] {
  return screen
    .queryAllByRole("button", { pressed: true })
    .map((b) => b.textContent ?? "")
    .filter((word) => (Object.values(DECK_KIND_LABEL) as string[]).includes(word));
}

/** The one pressed kind, for the cases where "exactly one" is not what is being asserted. */
function pressedKind(): string | undefined {
  return pressedKinds()[0];
}

describe("DeckSettingsForm", () => {
  /**
   * **The rule the whole component exists for**: no `useDeck`, no `useDeckFolders`, no
   * `useFormatSpecs`, no mutation. Rendered here with no `QueryClientProvider` at all, which is
   * a thing any one of those would throw on — and it is exactly the situation the create dialog
   * puts it in, where there is no deck to read.
   */
  it("renders every field with no query client and no backend at all", () => {
    form();

    expect(screen.getByLabelText("Name")).toHaveValue("Burn");
    expect(screen.getByRole("button", { name: "Format" })).toHaveTextContent("Modern");
    expect(screen.getByLabelText("Description")).toHaveValue("Twenty damage, quickly.");
    // The kind is a group of three now rather than one switch, and the fixture's own kind is
    // the pressed one. Addressed by `aria-pressed` and never by a class: a `hover:` variant
    // makes a class assertion vacuous, and jsdom loads no stylesheet to resolve one anyway.
    expect(screen.getByRole("group", { name: "Deck kind" })).toBeInTheDocument();
    expect(pressedKind()).toBe("Regular");
    expect(screen.getByRole("button", { name: "Folder" })).toHaveTextContent("Top level");
  });

  /** The picker is handed its props whole; this form reads none of them and changes none. */
  it("passes the cover props straight through", () => {
    form();

    const cover = screen.getByTestId("cover");
    expect(cover).toHaveAttribute("data-cover-card", "c-Lightning Bolt");
    // Its own prefix, not the form's: the picker's ids are the host's to keep in one namespace.
    expect(cover).toHaveAttribute("data-prefix", "cover");
  });

  /**
   * A text field says every keystroke and then says it is finished, and the two are different
   * events on purpose: the create dialog wants the first and cannot use the second.
   */
  it("fires onChange for every keystroke in the name and onCommit on blur", async () => {
    const { onChange, onCommit } = form();

    await userEvent.type(screen.getByLabelText("Name"), "!!");

    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenLastCalledWith({ name: "Burn!!" });
    expect(onCommit).not.toHaveBeenCalled();

    await userEvent.tab();

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith({ name: "Burn!!" });
  });

  /**
   * Enter finishes the name field, and it finishes it **through the blur** rather than by
   * committing on its own — one definition of "the reader is done with this", so a host whose
   * commit is not idempotent cannot be handed the same edit twice.
   */
  it("commits the name once on Enter", async () => {
    const { onCommit } = form();

    await userEvent.type(screen.getByLabelText("Name"), "!{Enter}");

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith({ name: "Burn!" });
  });

  /**
   * **The create host's Enter, which is the whole reason the prop exists.**
   *
   * `CreateDeckDialog` used to be a `<form>`, so Enter in the name was implicit submission; it
   * is not one now, and without this the app's primary creating act would need the pointer. So
   * a host that supplies `onSubmit` takes the key: no blur, and therefore no `onCommit` either
   * — one press is one event, and a host whose commit and submit are both writes must not get
   * both.
   *
   * The Enter comes from `user.keyboard` rather than from `user.type`, because the claim is
   * partly about **focus**: `user.type` focuses whatever it is handed, so a field asserted to
   * have kept the caret after a `type("{Enter}")` would pass having lost it.
   */
  it("calls onSubmit for Enter in the name, and keeps the caret there", async () => {
    const onSubmit = vi.fn();
    const { onCommit } = form({ onSubmit });

    await userEvent.type(screen.getByLabelText("Name"), "!");
    await userEvent.keyboard("{Enter}");

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Name")).toHaveFocus();
  });

  /**
   * **Enter submits from the name and from nowhere else**, which is a split rather than an
   * inconsistency: a paragraph is what the long field is for, and a form that made the deck on
   * the reader's first line break would be unusable for the only field it has three rows of.
   * (The third case — the cover picker's search box — is its own component's, and
   * `DeckCoverPicker.test.tsx` pins it there.)
   */
  it("leaves Enter alone in the description", async () => {
    const onSubmit = vi.fn();
    form({ onSubmit });

    await userEvent.type(screen.getByLabelText("Description"), "{Enter}Fast.");

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Description")).toHaveValue("Twenty damage, quickly.\nFast.");
  });

  /** The description names itself in both callbacks, so a form that wrote it into some other
   *  field would be invisible until the gallery tile changed. */
  it("fires onChange and onCommit for the description, as the description", async () => {
    const { onChange, onCommit } = form();

    await userEvent.type(screen.getByLabelText("Description"), " Fast.");
    await userEvent.tab();

    expect(onChange).toHaveBeenLastCalledWith({ description: "Twenty damage, quickly. Fast." });
    expect(onCommit).toHaveBeenCalledWith({ description: "Twenty damage, quickly. Fast." });
  });

  /** The create dialog passes no `onCommit`, because it has nothing to write yet. Blurring a
   *  field is then an ordinary thing to do rather than a crash. */
  it("survives a host that passes no onCommit", async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);

    await userEvent.type(screen.getByLabelText("Description"), "x");
    await userEvent.tab();

    expect(onChange).toHaveBeenLastCalledWith({
      description: "Twenty damage, quickly.x",
    });
  });

  /** A dropdown settles in one act, so there is nothing a second callback could add — and it
   *  sends the key rather than the display name. */
  it("fires only onChange for the format, by key", async () => {
    const { onChange, onCommit } = form();

    await pickOption(userEvent.setup(), "Format", "Commander");

    expect(onChange).toHaveBeenCalledWith({ formatKey: "commander" });
    expect(onCommit).not.toHaveBeenCalled();
  });

  /**
   * The game, which settles in one act like the format beside it — so `onChange` and never
   * `onCommit`.
   *
   * **And it carries `gameKey` alone.** The narrowing is the *host's*: it calls `pickerFormats`
   * and hands the result back as `formats`, which is what lets a Modern deck say Arena and keep
   * showing Modern. A form that shipped a `formatKey` along with this patch would be
   * re-formatting a deck from inside a filter.
   */
  it("fires only onChange for the game, and moves no format with it", async () => {
    const { onChange, onCommit } = form();

    await pickOption(userEvent.setup(), "Game", "Arena");

    expect(onChange).toHaveBeenCalledWith({ gameKey: "arena" });
    expect(onCommit).not.toHaveBeenCalled();
  });

  /** Four fixed rows, `Any` first — a ladder rather than an alphabet, and the one option list
   *  in this form that is not the host's to order. */
  it("offers the four games, Any first", async () => {
    form();

    const trigger = await openDropdown(userEvent.setup(), "Game");
    expect(trigger).toHaveTextContent("Any");
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Any",
      "Paper",
      "Arena",
      "MTGO",
    ]);
  });

  /** The list is drawn in the order it arrives — `pickerFormats` is the host's call, and this
   *  form re-sorting it would be a second answer to a question already settled. */
  it("offers the formats in the order it was given", async () => {
    form();

    await openDropdown(userEvent.setup(), "Format");
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Casual",
      "Commander",
      "Modern",
    ]);
  });

  /**
   * The one launch where the seeded table has not answered.
   *
   * The trigger still has to *say* something, and all this form has been given is the key —
   * {@link DeckSettingsValue} carries no display name. Both hosts avoid the case by handing
   * over a one-row list (the deck's own format, or Casual), so this is the floor rather than
   * the intended state. **Disabled, so there is no panel to open** and this asserts only what
   * the closed trigger says.
   */
  it("still shows the current format when the list is empty", () => {
    form({ formats: [] });

    const format = screen.getByRole("button", { name: "Format" });
    expect(format).toBeDisabled();
    expect(format).toHaveTextContent("modern");
  });

  /**
   * **Three buttons, and the deck's own kind is the pressed one** — asserted for each of the
   * three stored combinations rather than for the fixture alone, because the group's whole job
   * is folding two booleans into one word and a reader of one row cannot see the fold go wrong.
   *
   * The three rows are written out here rather than derived from `deckKindPatch`, which is
   * `an assertion must not read its own constant`: a patch function that answered the same
   * wrong pair on both sides would satisfy a derived expectation exactly.
   */
  it("presses the button for the kind the two columns spell, all three of them", () => {
    type Case = {
      flags: Pick<DeckSettingsValue, "theoryEnabled" | "virtualOnly">;
      label: string;
    };
    const cases: Case[] = [
      { flags: { theoryEnabled: false, virtualOnly: false }, label: "Regular" },
      { flags: { theoryEnabled: true, virtualOnly: false }, label: "Theory + Actual" },
      { flags: { theoryEnabled: false, virtualOnly: true }, label: "Virtual" },
    ];

    for (const { flags, label } of cases) {
      const view = form({ value: { ...VALUE, ...flags } });
      // Exactly one pressed, which is what makes the group readable as a choice rather than
      // as three independent toggles that happen to agree today.
      expect(pressedKinds()).toEqual([label]);
      view.unmount();
    }
  });

  /**
   * **Every press names both columns**, which is the one rule this control cannot get wrong
   * quietly: naming only the column that changed would leave the other standing, and a `theory`
   * deck patched with `{ virtualOnly: true }` alone is the `true, true` row `deckKind.ts`
   * exists to keep out of the database.
   *
   * Driven from a `theory` deck so that every one of the three presses has *both* columns to
   * move or hold: from `regular` the two that matter most would each be writing one `false`
   * that was already `false`, and a patch missing that key would pass.
   */
  it("writes theoryEnabled and virtualOnly together, whichever kind is pressed", async () => {
    const { onChange, onCommit } = form({ value: { ...VALUE, theoryEnabled: true } });

    await userEvent.click(screen.getByRole("button", { name: "Virtual" }));
    expect(onChange).toHaveBeenLastCalledWith({ theoryEnabled: false, virtualOnly: true });

    await userEvent.click(screen.getByRole("button", { name: "Regular" }));
    expect(onChange).toHaveBeenLastCalledWith({ theoryEnabled: false, virtualOnly: false });

    await userEvent.click(screen.getByRole("button", { name: "Theory + Actual" }));
    expect(onChange).toHaveBeenLastCalledWith({ theoryEnabled: true, virtualOnly: false });

    // A press settles in one act, like the three dropdowns and the mark switches — so there is
    // nothing for the second callback to add.
    expect(onCommit).not.toHaveBeenCalled();
  });

  /**
   * The caption is the **selected** kind's line and swaps with the press.
   *
   * Three sentences on screen at once would be a paragraph about a choice rather than the
   * meaning of the one that has been made — so the two that are not the answer are asserted
   * absent, which is the half a test of the pressed line alone would pass without.
   */
  it("draws only the pressed kind's caption", async () => {
    form();

    expect(screen.getByText(DECK_KIND_HINT.regular)).toBeInTheDocument();
    expect(screen.queryByText(DECK_KIND_HINT.theory)).toBeNull();
    expect(screen.queryByText(DECK_KIND_HINT.virtual)).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Virtual" }));

    expect(screen.getByText(DECK_KIND_HINT.virtual)).toBeInTheDocument();
    expect(screen.queryByText(DECK_KIND_HINT.regular)).toBeNull();
  });

  /**
   * The three marks are drawn **under the kind group** and only while it reads
   * `Theory + Actual`. A deck with no plan has nothing for any of them to compare against, so a
   * control for them there would be a switch that changes nothing — and the reader would have
   * no way to find that out.
   *
   * Driven through the group above rather than through two renders, because the transition is
   * the case: a reader presses `Theory + Actual` and the three rows have to arrive under it.
   */
  it("offers every mark switch only when the theory list is on", async () => {
    form();

    expect(screen.queryByRole("switch", { name: /matching printing/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: /different printing/i })).not.toBeInTheDocument();
    // The red tier is gated on the same switch as the other two and for the same reason: *not in
    // the theory list* is still a statement about a list, so with no plan every row would wear
    // it. Asserted by the heading rather than by the caption, because the heading is what names
    // the control and what a reader would look for.
    expect(screen.queryByText("Not in the theory list")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Theory + Actual" }));

    expect(screen.getByRole("switch", { name: /matching printing/i })).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: /different printing/i })).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: /not in the theory list/i })).toBeInTheDocument();
    expect(screen.getByText("Not in the theory list")).toBeInTheDocument();
    expect(
      screen.getByText("A green mark on a card that is the exact printing your plan names."),
    ).toBeInTheDocument();
    // The half a reader cannot see coming: switching the strict mark off does not leave the card
    // unmarked, it draws the loose one instead. Unsaid, a reader who turns green off and still
    // sees marks reads the control as broken.
    expect(
      screen.getByText(
        "A blue mark on a card your plan asks for in a different printing. Turning the green one off draws this one instead.",
      ),
    ).toBeInTheDocument();
    // And the red one's own half: it is not a third answer to *which printing*, so the caption
    // says outright that it makes no claim about one.
    expect(
      screen.getByText(
        "A red mark on a card your plan does not ask for at all — a stand-in, a spare or an experiment. It says nothing about the printing; the two marks above do.",
      ),
    ).toBeInTheDocument();
  });

  /**
   * **The second gate, and it is a different question from the first.**
   *
   * `theoryEnabled` asks whether there is a plan to compare against; this asks whether the host
   * can write the answer down. `CreateDeckDialog` cannot — `DeckInput` carries none of the three
   * columns and the schema's `DEFAULT 1` owns a new deck's answer — so a reader who switched the
   * plan on inside "New deck" would otherwise get a set of switches whose presses reach nothing.
   * `defaultCategoryId`'s row is absent from that host for the same shape of reason.
   */
  it("draws no mark switch for a host that cannot write them, plan or no plan", () => {
    form({ value: { ...VALUE, theoryEnabled: true }, canSetTheoryMarks: false });

    // The kind is still asked and still reads `Theory + Actual` — this gate takes the marks
    // away and never the choice that would make them mean something.
    expect(pressedKind()).toBe("Theory + Actual");
    expect(screen.queryByRole("switch", { name: /matching printing/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: /different printing/i })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("switch", { name: /not in the theory list/i }),
    ).not.toBeInTheDocument();
  });

  /**
   * Three switches, three columns — `theory_mark_exact`, `theory_mark_name` and
   * `theory_mark_unplanned` — and the whole reason there are three of them is that blue without
   * green is a real answer and so is red alone. A row that reported a neighbour's field would
   * collapse them into one ordered control that cannot spell either.
   */
  it("reports each switch on its own", async () => {
    const { onChange, onCommit } = form({ value: { ...VALUE, theoryEnabled: true } });

    await userEvent.click(screen.getByRole("switch", { name: /different printing/i }));

    expect(onChange).toHaveBeenCalledWith({ theoryMarkName: false });
    expect(onChange).not.toHaveBeenCalledWith(
      expect.objectContaining({ theoryMarkExact: expect.anything() }),
    );
    // A switch settles in one act, like the theory switch above it and the three dropdowns.
    expect(onCommit).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("switch", { name: /matching printing/i }));

    expect(onChange).toHaveBeenLastCalledWith({ theoryMarkExact: false });

    // The red tier, the one a reader may want *without* either of the two above it.
    await userEvent.click(screen.getByRole("switch", { name: /not in the theory list/i }));

    expect(onChange).toHaveBeenLastCalledWith({ theoryMarkUnplanned: false });
    expect(onCommit).not.toHaveBeenCalled();
  });

  /**
   * The swatch carries the distinction the words *green*, *blue* and *red* only name — and it is
   * the reader's **own** colour, because `useMarkColors` writes these three custom properties at
   * the app root when they have chosen in Settings.
   *
   * The custom-property *name* is what is asserted: jsdom resolves no stylesheet, so a computed
   * colour here would be the empty string whatever the mark is drawn in.
   */
  it("draws each mark's swatch in that mark's own colour", () => {
    form({ value: { ...VALUE, theoryEnabled: true } });

    // Addressed through the heading each switch is named by, which is load-bearing markup
    // rather than a hook a test asked for: the swatch is that heading's first child.
    const swatch = (id: string) => document.getElementById(id)?.firstElementChild as HTMLElement;
    expect(swatch("s-theory-mark-exact").style.backgroundColor).toBe("var(--color-theory-exact)");
    expect(swatch("s-theory-mark-name").style.backgroundColor).toBe("var(--color-theory-name)");
    expect(swatch("s-theory-mark-unplanned").style.backgroundColor).toBe(
      "var(--color-theory-unplanned)",
    );
  });

  /** Filing, and the `""` that is a real answer rather than a placeholder. */
  it("fires only onChange for the folder, and reads the empty option as the top level", async () => {
    const { onChange, onCommit } = form({ value: { ...VALUE, folderId: 2 } });

    // The caption beside the label, which is the deck's own filing — the trigger carries the
    // same words as an option, and only one of the two is a statement about this deck.
    expect(screen.getByText("Commander › Legends", { selector: "p" })).toBeInTheDocument();

    await pickOption(userEvent.setup(), "Folder", "Commander");
    expect(onChange).toHaveBeenLastCalledWith({ folderId: 1 });

    await pickOption(userEvent.setup(), "Folder", "Top level");
    expect(onChange).toHaveBeenLastCalledWith({ folderId: null });
    expect(onCommit).not.toHaveBeenCalled();
  });

  /**
   * `Top level` stays first, because it is not a folder at all: it is the answer meaning
   * `folder_id IS NULL`. Alphabetising it among the folders would file it under T.
   */
  it("keeps Top level pinned above the folders", async () => {
    form();

    await openDropdown(userEvent.setup(), "Folder");
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Top level",
      "Commander",
      "Commander › Legends",
    ]);
  });

  /** A folder list that could not be read leaves a dropdown that can only mislead, so it says
   *  what happened and stops offering the move. */
  it("reports a folder list it could not read, and disables the move", () => {
    form({ folders: { paths: [], unread: "Database is busy.", loading: false, pending: false } });

    expect(screen.getByText("Could not read the folders — Database is busy.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Folder" })).toBeDisabled();
  });

  /** A move already in flight is not a second move to offer. */
  it("disables the folder dropdown while a move is pending", () => {
    form({ folders: { paths: PATHS, unread: null, loading: false, pending: true } });

    expect(screen.getByRole("button", { name: "Folder" })).toBeDisabled();
  });

  /** A deck filed in a folder the list does not carry — the read raced a delete elsewhere —
   *  says so rather than silently reading as the top level. */
  it("says when the deck is in a folder the list does not carry", () => {
    form({ value: { ...VALUE, folderId: 99 } });

    expect(screen.getByText("In a folder this list does not carry")).toBeInTheDocument();
  });

  /**
   * The deck editor's old "Add to" select, asked here — `Auto` pinned above the deck's own piles
   * in the deck's own order, and **every pile, switched off ones included**.
   *
   * The order is the assertion worth having: `sortOptions` is the app-wide rule and this list is
   * one of the exemptions it names, because the reader arranged it themselves. Alphabetising it
   * would put `Main deck` under `Maybeboard` here and nowhere else in the app.
   */
  it("offers Auto and then every pile of the deck, in the deck's order", async () => {
    form();

    const trigger = await openDropdown(userEvent.setup(), "Add cards to");
    expect(trigger).toHaveTextContent("Auto (by what it does)");
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Auto (by what it does)",
      "Main deck",
      "Sideboard",
      "Maybeboard (off)",
    ]);
  });

  /** A dropdown, so it settles in one act: `onChange` and never `onCommit`, like the format,
   *  the theory switch and the folder. **`0` is a value**, which is what the round trip back to
   *  Auto is here to pin — a host reading it as an absence would report success and write
   *  nothing. */
  it("fires only onChange for the default category, by id, Auto included", async () => {
    const { onChange, onCommit } = form();

    await pickOption(userEvent.setup(), "Add cards to", "Sideboard");
    expect(onChange).toHaveBeenLastCalledWith({ defaultCategoryId: 12 });

    await pickOption(userEvent.setup(), "Add cards to", "Auto (by what it does)");
    expect(onChange).toHaveBeenLastCalledWith({ defaultCategoryId: AUTO_CATEGORY });
    expect(onCommit).not.toHaveBeenCalled();
  });

  /** The caption is what the row is for: a select reading `Sideboard` says where, and the line
   *  under it says what that means — including the one fact most likely to surprise, which is a
   *  pile that has since been switched off. */
  it("says in words where an add will land, and flags a pile that is switched off", () => {
    const auto = form();
    expect(
      screen.getByText("Removal, Ramp, Draw — decided per card from what it does."),
    ).toBeInTheDocument();
    auto.unmount();

    const picked = form({ value: { ...VALUE, defaultCategoryId: 12 } });
    expect(screen.getByText("Every add lands in Sideboard.")).toBeInTheDocument();
    picked.unmount();

    form({ value: { ...VALUE, defaultCategoryId: 13 } });
    expect(
      screen.getByText(
        "Every add lands in Maybeboard, which is switched off and counts toward nothing.",
      ),
    ).toBeInTheDocument();
  });

  /**
   * The create host, which renders this same form before `deck_create` has seeded a single
   * category — so there is no pile to offer and no id to write, and the row is not drawn at all.
   *
   * That is the one field of `DeckSettingsValue` the two hosts do not both ask about, and it is
   * asserted rather than assumed because the failure is an empty select offering only `Auto`
   * over a deck that does not exist: a question that reads answerable and is not.
   */
  it("draws no default-category row for a host with no deck yet", () => {
    form({ categories: undefined });

    expect(screen.queryByRole("button", { name: "Add cards to" })).toBeNull();
    // And the rest of the form is untouched by its absence.
    expect(screen.getByRole("button", { name: "Folder" })).toBeInTheDocument();
  });

  /**
   * **The mark rows vanish for `Regular` *and* for `Virtual`, through the one condition that was
   * already there.**
   *
   * `deckKindPatch` writes both columns on every press and only `theory` sets `theoryEnabled`, so
   * the form's `value.theoryEnabled &&` gate covers both of the other two kinds with no arm of
   * its own — and a second `deckKind(value) === "theory"` beside it would be one fact spelled
   * twice. This is what says so out loud: it fails the moment a kind stops clearing the column,
   * which is the failure nothing else in this file could see.
   */
  it("hides the mark rows for both of the other two kinds", async () => {
    form({ value: { ...VALUE, theoryEnabled: true } });

    expect(screen.getByRole("switch", { name: /matching printing/i })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Virtual" }));

    expect(pressedKind()).toBe("Virtual");
    expect(screen.queryByRole("switch", { name: /matching printing/i })).toBeNull();
    expect(screen.queryByRole("switch", { name: /different printing/i })).toBeNull();
    expect(screen.queryByRole("switch", { name: /not in the theory list/i })).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Theory + Actual" }));
    expect(screen.getByRole("switch", { name: /matching printing/i })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Regular" }));

    expect(pressedKind()).toBe("Regular");
    expect(screen.queryByRole("switch", { name: /matching printing/i })).toBeNull();
  });
});

/**
 * The host's helper, exported from the form because the host is what calls it.
 *
 * **The whole block, including the four cases written against `DeckSettingsDialog` before the
 * function moved here** — the cycle fence, a root folder, and the numeric and case rules. They
 * sit with the module that owns the function now, because a test of a pure function next to a
 * component that no longer defines it is a test nobody finds when they change it.
 */
describe("folderPaths", () => {
  /** Each folder as the path a reader would say, alphabetically by the **rendered path**
   *  through the app's one collator — so `Cube 2` sits above `Cube 10`. */
  it("writes and orders the paths the way the select draws them", () => {
    const folders: DeckFolder[] = [
      { id: 1, parentId: null, name: "Cube 10", sortOrder: 0 },
      { id: 2, parentId: 1, name: "Legends", sortOrder: 0 },
      { id: 3, parentId: null, name: "Cube 2", sortOrder: 0 },
    ];

    expect(folderPaths(folders)).toEqual([
      { id: 3, path: "Cube 2" },
      { id: 1, path: "Cube 10" },
      { id: 2, path: "Cube 10 › Legends" },
    ]);
  });

  /** The backend refuses a move that would make a cycle — but a read is a read, and a walk
   *  with no fence is an infinite loop in the one case nobody can reproduce. */
  it("stops walking a cycle instead of hanging", () => {
    const cyclic: DeckFolder[] = [
      { id: 1, parentId: 2, name: "A", sortOrder: 0 },
      { id: 2, parentId: 1, name: "B", sortOrder: 0 },
    ];

    expect(folderPaths(cyclic)).toHaveLength(2);
  });

  /** A folder at the root is its own whole path. */
  it("leaves a root folder alone", () => {
    expect(folderPaths([{ id: 9, parentId: null, name: "Standard", sortOrder: 0 }])).toEqual([
      { id: 9, path: "Standard" },
    ]);
  });

  /**
   * Through the app's one collator, and not a bare `localeCompare`.
   *
   * **Numerals count as numbers**, which is the behaviour this changed: the bare
   * `a.path.localeCompare(b.path)` this used to do puts `Cube 10` above `Cube 2`, because it
   * is ranking the character `1` against the character `2` — and people number their folders.
   * **Case does not split the list** either, so a reader's `brews` sits where a reader would
   * look for it rather than after every capitalised name.
   *
   * And the locale is pinned to `"en"` rather than read off the host, for the reason
   * `sorting.ts` gives: the collation is part of what the app *does*, and a list that reorders
   * itself on a different machine is a list two readers cannot compare. That half cannot be
   * asserted from inside one process, which is why it is written down here.
   */
  it("orders the paths by the app's collator, numerals and case included", () => {
    const numbered: DeckFolder[] = [
      { id: 1, parentId: null, name: "Cube 10", sortOrder: 0 },
      { id: 2, parentId: null, name: "Cube 2", sortOrder: 0 },
      { id: 3, parentId: null, name: "brews", sortOrder: 0 },
      { id: 4, parentId: null, name: "Cube 1", sortOrder: 0 },
    ];

    expect(folderPaths(numbered).map((f) => f.path)).toEqual([
      "brews",
      "Cube 1",
      "Cube 2",
      "Cube 10",
    ]);
  });
});
