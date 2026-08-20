import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import type { ArtWeightFloor } from "@/lib/ipc";
import { HIDE_BACKGROUND_LABEL, TagChips } from "./TagChips";
import {
  EMPTY_SELECTION,
  removeChip,
  toggleChipMode,
  type TagChip,
  type TagSelection,
} from "./tagFilters";

/**
 * The row is controlled, so a story has to own the selection it controls.
 *
 * Rendered against a fixed `selection` a chip would report its press and then visibly not move —
 * a story of a control that does not work. `FilterChips.stories.tsx`' shape, for its reason: the
 * args *seed* this wrapper rather than driving it.
 *
 * **It deliberately does not apply the page's `settleFloor`.** `TagsPage` passes every write
 * through that guard, so the floor drops itself to `any` the moment the last art include leaves;
 * copying it here would make {@link FloorOnWithNothingToNarrow} unreachable, and that state is
 * exactly what `HIDE_BACKGROUND_LATENT` was written for. The page owns whether the state can
 * arise; the row owns being honest about the one it is handed.
 */
function Chips({
  chips,
  floor,
  floorControl,
}: {
  chips: readonly TagChip[];
  floor: ArtWeightFloor;
  /** Whether the page hands the row an `onFloorChange` at all — see {@link NoFloorControl}. */
  floorControl: boolean;
}) {
  const [selection, setSelection] = useState<TagSelection>(() => ({
    ...EMPTY_SELECTION,
    chips,
    floor,
  }));
  return (
    <TagChips
      selection={selection}
      onRemove={(slug, ns) => setSelection((s) => removeChip(s, slug, ns))}
      onToggleMode={(slug, ns) => setSelection((s) => toggleChipMode(s, slug, ns))}
      onFloorChange={
        floorControl ? (next) => setSelection((s) => ({ ...s, floor: next })) : undefined
      }
    />
  );
}

/**
 * The chips below name motifs the Storybook fake really carries, and the labels are the ones
 * `db.ts`'s `tagLabel` derives — so a story never puts a tag on screen that the rail beside it
 * could not offer.
 *
 * **They are still hand-written, and that is honest rather than a shortcut.** A `TagChip` never
 * comes off the wire whole: `addChip` builds one from a `TagHit`, and the `label` rides along
 * precisely so the chip keeps naming the tag after a refresh has renamed or removed it. So there
 * is no backend row to derive these from — a chip is page state, and this is what page state
 * looks like.
 */
const FOREST: TagChip = { slug: "forest", label: "Forest", namespace: "art", mode: "include" };
const ANGEL: TagChip = { slug: "angel", label: "Angel", namespace: "art", mode: "exclude" };
const RAMP: TagChip = { slug: "ramp", label: "Ramp", namespace: "oracle", mode: "include" };

const meta = {
  title: "Tags/Chips",
  component: Chips,
  tags: ["autodocs"],
  args: { chips: [FOREST, ANGEL], floor: "any" as ArtWeightFloor, floorControl: true },
  // Keyed on everything the wrapper seeds from, so changing a control in the Controls panel
  // remounts and the lazy initializer runs again rather than being ignored.
  render: (args) => <Chips key={JSON.stringify(args)} {...args} />,
  parameters: {
    docs: {
      description: {
        component:
          "What the reader has picked on the Tags page, and the one control that modifies " +
          "it.\n\n" +
          "**A chip says its taxonomy, always.** The two tag files have separate id spaces and " +
          "share plenty of slugs, so a row holding two chips both reading `Forest` would be two " +
          "controls a reader cannot tell apart — the same fact `chipKey` exists for one floor " +
          "down. The rail only marks the namespace in `Both` mode, because there a column of " +
          "identical marks is noise; a chip is a lasting statement about a query and outlives " +
          "whatever the box was set to.\n\n" +
          "**Include and exclude are told apart by the word `not` and by a dashed edge, never " +
          "by hue.** Gold already means *on* everywhere in this app, and a red chip would read " +
          "as an error — which an exclusion is not. `not Angel` is legible to a reader who " +
          "cannot tell the two borders apart at all.\n\n" +
          "**The weight control must never say “strong matches only”.** The spec and the plan " +
          "both called it that and both were wrong: the predicate behind it is " +
          "`ati.weight <> 'weak'`, which admits `median` — Scryfall's word for a normal tagging " +
          "with no special weight applied, and 462,008 of the 475,163 art taggings (measured " +
          "2026-08-20, `docs/superpowers/research/2026-08-20-scryfall-art-tags.md`). It does " +
          "not narrow to strong matches; it drops what Scryfall defines as `weak`, *“the " +
          "subject is a minor detail or background element”*. The wire field stays " +
          "`artWeightFloor: \"any\" | \"strong\"`, which is honest about being a floor — only " +
          "the visible words changed.\n\n" +
          "**Nothing here is a card query.** These stories are the row on its own; " +
          "`Tags/Page` is where a chip actually narrows a wall.",
      },
    },
  },
} satisfies Meta<typeof Chips>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * One include and one exclude, which is the pair the row exists to keep apart.
 *
 * `Forest` is included and `Angel` is excluded, and the exclusion is drawn as **`not Angel`** —
 * the word, not a colour. Each half of a chip is its own button: the label toggles the mode and
 * the ✕ removes it, so a reader who picked the wrong direction fixes it without losing the tag.
 */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // The state is in the accessible name as well as in the border, because the border is the
    // half a reader who cannot see it never gets.
    await expect(
      canvas.getByRole("button", { name: "Forest, art tag, included. Press to exclude." }),
    ).toBeInTheDocument();
    const exclusion = canvas.getByRole("button", {
      name: "not Angel, art tag, excluded. Press to include.",
    });
    // The visible word, read off the span that holds it rather than off the button — the button
    // also contains the taxonomy mark, so its whole text is `Artnot Angel`.
    await expect(within(exclusion).getByText("not Angel")).toBeInTheDocument();

    await userEvent.click(exclusion);

    // Flipped **in place**: a chip that jumped to the end of the row when it was flipped would
    // make the row unreadable exactly while the reader is editing it.
    const row = canvas.getByRole("group", { name: "Picked tags" });
    await waitFor(async () => {
      await expect(
        within(row).getByRole("button", { name: "Angel, art tag, included. Press to exclude." }),
      ).toBeInTheDocument();
    });
    // Order read off the removal buttons, whose names are the one clean statement of which chip
    // is which — the toggle halves carry the mode sentence as well.
    await expect(
      within(row)
        .getAllByRole("button", { name: /^Remove / })
        .map((b) => b.getAttribute("aria-label")),
    ).toEqual(["Remove Forest, art tag", "Remove Angel, art tag"]);
  },
};

/**
 * Nothing picked yet — an invitation rather than a blank.
 *
 * The page's whole gesture is picking a motif and nothing else on screen says where from, so the
 * empty row carries the sentence. The weight control is drawn beside it and **greyed**, because
 * there is no art include for it to narrow: an option that vanishes reads as a control that
 * broke, where a greyed one reads as a fact about what is in front of you.
 */
export const Empty: Story = {
  args: { chips: [] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByText("No tags picked yet. Pick one from the list to narrow the cards."),
    ).toBeInTheDocument();
    const floor = canvas.getByRole("button", { name: new RegExp(`^${HIDE_BACKGROUND_LABEL}`) });
    // `aria-disabled` and not `disabled`: the chip keeps its tab stop, so a reader sweeping the
    // row still hears the option and the reason it cannot be pressed.
    await expect(floor).toHaveAttribute("aria-disabled", "true");
    await expect(floor).toHaveAccessibleName(
      `${HIDE_BACKGROUND_LABEL} — nothing to hide until an art tag is picked`,
    );
  },
};

/**
 * A chip from each taxonomy, which is what the page opens on offering.
 *
 * `Forest` is a picture and `Ramp` is a rules effect, and the marks are the only thing on the row
 * that says so. Both are the fake's own motifs — `forest` sits under two parents in the art
 * graph, `ramp` reaches six oracle cards — so the rail beside this row could really have offered
 * each of them.
 */
export const BothTaxonomies: Story = {
  args: { chips: [{ ...FOREST, mode: "include" }, RAMP] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("button", { name: "Forest, art tag, included. Press to exclude." }),
    ).toBeInTheDocument();
    await expect(
      canvas.getByRole("button", { name: "Ramp, oracle tag, included. Press to exclude." }),
    ).toBeInTheDocument();
    // The removal buttons carry the taxonomy too: two chips sharing a slug would otherwise be
    // two buttons with one name.
    await expect(
      canvas.getByRole("button", { name: "Remove Ramp, oracle tag" }),
    ).toBeInTheDocument();
  },
};

/**
 * The floor on, with an art include for it to act on.
 *
 * This is the only state in which the control does anything: the floor rides the art side's
 * *include* half alone — `oracle_tag_cards` carries no `weight` column, and a floor on an
 * exclude would let weak forests back into a result the reader asked to have none in.
 */
export const FloorOn: Story = {
  args: { chips: [{ ...FOREST, mode: "include" }], floor: "strong" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const floor = canvas.getByRole("button", { name: new RegExp(`^${HIDE_BACKGROUND_LABEL}`) });
    await expect(floor).toHaveAttribute("aria-pressed", "true");
    await expect(floor).not.toHaveAttribute("aria-disabled");
    await expect(floor).toHaveAccessibleName(
      `${HIDE_BACKGROUND_LABEL} — drops taggings Scryfall marked as a minor detail or ` +
        "background element",
    );
  },
};

/**
 * On **and** out of reach — the one pair `filterChipState` says never occurs, drawn honestly
 * because the row can really be handed it.
 *
 * Pick an art tag, press the control, then remove that chip: the floor is still `strong` while
 * there is no longer an art include for it to narrow. A chip reading *“nothing to hide until an
 * art tag is picked”* while lit would be telling the reader their setting was off, so there is a
 * third sentence for exactly this state.
 *
 * **The page it ships inside never produces it** — `TagsPage`'s `settleFloor` drops the floor on
 * every write that empties the art includes — and this wrapper leaves that guard out on purpose,
 * which is the only way to stand a story in the state.
 */
export const FloorOnWithNothingToNarrow: Story = {
  args: { chips: [ANGEL, RAMP], floor: "strong" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const floor = canvas.getByRole("button", { name: new RegExp(`^${HIDE_BACKGROUND_LABEL}`) });
    await expect(floor).toHaveAttribute("aria-pressed", "true");
    await expect(floor).toHaveAttribute("aria-disabled", "true");
    await expect(floor).toHaveAccessibleName(
      `${HIDE_BACKGROUND_LABEL} — on, and narrowing nothing until an art tag is picked`,
    );
  },
};

/**
 * A caller that cannot move the floor is shown no control for it.
 *
 * `ManaValueChips`' X chip is wired the same way for the same reason: a control with nothing to
 * report is worse than one a row does not offer, so `onFloorChange` decides both whether the
 * floor can change *and* whether it is drawn. Left off by accident the control would be silently
 * absent rather than dead — which is why the page's own call site carries a comment saying that
 * wiring it is what draws it.
 */
export const NoFloorControl: Story = {
  args: { floorControl: false },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.queryByRole("button", { name: new RegExp(`^${HIDE_BACKGROUND_LABEL}`) }),
    ).toBeNull();
    // The chips themselves are untouched by its absence.
    await expect(canvas.getByRole("group", { name: "Picked tags" })).toHaveTextContent("Forest");
  },
};

/**
 * Where the caret goes when the chip it was standing on has gone.
 *
 * Removing a chip takes the focused button out of the document, and left alone the reader is
 * dropped on `<body>` — their next Tab restarts at the top of the app. The row moves the caret to
 * the chip **after** the one removed, or to the one before it when the last was removed, through
 * an effect that runs after the parent has re-rendered without it: the button to focus does not
 * exist until then.
 */
export const CaretSurvivesARemoval: Story = {
  args: { chips: [{ ...FOREST, mode: "include" }, ANGEL, RAMP] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await userEvent.click(canvas.getByRole("button", { name: "Remove Forest, art tag" }));

    await waitFor(async () => {
      await expect(canvas.getByRole("button", { name: "Remove Angel, art tag" })).toHaveFocus();
    });

    // And the one before it when there is no one after. Ramp is last, so removing it lands on
    // Angel again.
    await userEvent.click(canvas.getByRole("button", { name: "Remove Ramp, oracle tag" }));
    await waitFor(async () => {
      await expect(canvas.getByRole("button", { name: "Remove Angel, art tag" })).toHaveFocus();
    });
  },
};
