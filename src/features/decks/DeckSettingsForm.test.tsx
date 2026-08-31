import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { DeckCategory, DeckFolder } from "@/lib/ipc";
import { openDropdown, pickOption } from "@/test-dropdown";
import { AUTO_CATEGORY } from "./autoCategory";
import type { DeckCoverPickerProps } from "./DeckCoverPicker";
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
  notes: "Sideboard plan lives in the Maybeboard.",
  theoryEnabled: false,
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
    expect(screen.getByLabelText("Notes")).toHaveValue("Sideboard plan lives in the Maybeboard.");
    expect(screen.getByRole("switch", { name: "Theory deck Disabled" })).toBeInTheDocument();
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
   * inconsistency: a paragraph is what the two long fields are for, and a form that made the
   * deck on the reader's first line break would be unusable for the only field it has six rows
   * of. (The third case — the cover picker's search box — is its own component's, and
   * `DeckCoverPicker.test.tsx` pins it there.)
   */
  it("leaves Enter alone in the description and the notes", async () => {
    const onSubmit = vi.fn();
    form({ onSubmit });

    await userEvent.type(screen.getByLabelText("Description"), "{Enter}Fast.");
    await userEvent.type(screen.getByLabelText("Notes"), "{Enter}Cut Avacyn.");

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Description")).toHaveValue("Twenty damage, quickly.\nFast.");
    expect(screen.getByLabelText("Notes")).toHaveValue(
      "Sideboard plan lives in the Maybeboard.\nCut Avacyn.",
    );
  });

  /** The description and the notes are two fields, and a form that wrote one into the other
   *  would be invisible until the gallery tile changed. */
  it("fires onChange and onCommit for the description, as the description", async () => {
    const { onChange, onCommit } = form();

    await userEvent.type(screen.getByLabelText("Description"), " Fast.");
    await userEvent.tab();

    expect(onChange).toHaveBeenLastCalledWith({ description: "Twenty damage, quickly. Fast." });
    expect(onCommit).toHaveBeenCalledWith({ description: "Twenty damage, quickly. Fast." });
  });

  it("fires onChange and onCommit for the notes, as the notes", async () => {
    const { onChange, onCommit } = form();

    await userEvent.type(screen.getByLabelText("Notes"), " Cut Avacyn.");
    await userEvent.tab();

    expect(onChange).toHaveBeenLastCalledWith({
      notes: "Sideboard plan lives in the Maybeboard. Cut Avacyn.",
    });
    expect(onCommit).toHaveBeenCalledWith({
      notes: "Sideboard plan lives in the Maybeboard. Cut Avacyn.",
    });
  });

  /** The create dialog passes no `onCommit`, because it has nothing to write yet. Blurring a
   *  field is then an ordinary thing to do rather than a crash. */
  it("survives a host that passes no onCommit", async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);

    await userEvent.type(screen.getByLabelText("Notes"), "x");
    await userEvent.tab();

    expect(onChange).toHaveBeenLastCalledWith({
      notes: "Sideboard plan lives in the Maybeboard.x",
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
   * A press, and the two sentences the switch owes the reader in both directions.
   *
   * **Turning it on moves the deck into the plan and leaves the live list empty.** It used to
   * copy, and this description used to say so; a description still promising a copy would be the
   * app telling a reader their sleeved-up deck is safe as they press the thing that empties it.
   * Turning it *off* is still not a delete. `DeckSettingsDialog.test.tsx` pins the same pair
   * through the host — the sentence lives here now, and both surfaces draw it.
   */
  it("fires only onChange for the theory switch, and says what it does in both directions", async () => {
    const { onChange, onCommit } = form();

    const toggle = screen.getByRole("switch", { name: "Theory deck Disabled" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(
      screen.getByText(/makes the deck you have the plan and starts the live list empty/),
    ).toBeInTheDocument();
    // The sentence it must no longer make: nothing is copied any more.
    expect(screen.queryByText(/copies the live deck/)).not.toBeInTheDocument();
    expect(screen.getByText(/keeps every row/)).toBeInTheDocument();

    await userEvent.click(toggle);

    expect(onChange).toHaveBeenCalledWith({ theoryEnabled: true });
    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.getByRole("switch", { name: "Theory deck Enabled" })).toBeChecked();
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
