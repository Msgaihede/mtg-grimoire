import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FolderRule, SetSummary } from "@/lib/ipc";

const getMarketplace = vi.hoisted(() => vi.fn());
const marketplaceFeedStatus = vi.hoisted(() => vi.fn());
const listSets = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (original) => ({
  ...(await original<typeof import("@/lib/ipc")>()),
  ipc: { getMarketplace, marketplaceFeedStatus, listSets },
}));

import { TooltipProvider } from "@/components/tooltip/TooltipProvider";
import { RULE_REFUSAL } from "@/lib/folderRules";
import { FolderRulesDialog, type FolderRulesDialogProps } from "./FolderRulesDialog";

const SETS: SetSummary[] = [
  {
    code: "lea",
    name: "Limited Edition Alpha",
    setType: "core",
    releasedAt: "1993-08-05",
    cardCount: 295,
  },
  {
    code: "arn",
    name: "Arabian Nights",
    setType: "expansion",
    releasedAt: "1993-12-17",
    cardCount: 92,
  },
];

beforeEach(() => {
  getMarketplace.mockReset().mockResolvedValue("tcgplayer");
  marketplaceFeedStatus.mockReset().mockResolvedValue([]);
  listSets.mockReset().mockResolvedValue(SETS);
});

function wrap(ui: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>{ui}</TooltipProvider>
    </QueryClientProvider>,
  );
}

function open(over: Partial<FolderRulesDialogProps> = {}) {
  const onSave = vi.fn();
  const onClose = vi.fn();
  const view = wrap(
    <FolderRulesDialog
      open
      scope="collection"
      folderName="Trade binder"
      rules={[]}
      inherited={[]}
      onSave={onSave}
      onClose={onClose}
      {...over}
    />,
  );
  return { ...view, onSave, onClose };
}

async function addRule(user: ReturnType<typeof userEvent.setup>, label: string | RegExp) {
  await user.click(screen.getByRole("button", { name: "Add rule" }));
  await user.click(screen.getByRole("option", { name: label }));
}

const save = () => screen.getByRole("button", { name: "Save rules" });

describe("FolderRulesDialog", () => {
  it("names the folder and says an empty folder has no rules of its own", () => {
    open();
    expect(screen.getByRole("dialog", { name: "Rules for “Trade binder”" })).toBeInTheDocument();
    expect(screen.getByText(/No rules of its own/)).toBeInTheDocument();
  });

  it("saves an emptied list, which clears the rules", async () => {
    const user = userEvent.setup();
    const { onSave } = open({ rules: [{ kind: "colors", values: ["U"] }] });

    await user.click(screen.getByRole("button", { name: "Remove rule 1 (Colour)" }));
    await user.click(save());

    expect(onSave).toHaveBeenCalledWith([]);
  });

  it("adds a price rule, labels its ends with the currency, and saves the numbers", async () => {
    const user = userEvent.setup();
    const { onSave } = open();

    await addRule(user, "Price");
    const rule = screen.getByRole("group", { name: "Rule 1: Price" });
    expect(within(rule).getByText("Max (USD)")).toBeInTheDocument();
    await user.type(within(rule).getByRole("textbox", { name: "Maximum price in USD" }), "1,5");
    await user.click(save());

    expect(onSave).toHaveBeenCalledWith([{ kind: "price", min: null, max: 1.5 }]);
  });

  it("adds a mana value range", async () => {
    const user = userEvent.setup();
    const { onSave } = open();

    await addRule(user, "Mana value");
    await user.type(screen.getByRole("textbox", { name: "Minimum mana value" }), "2");
    await user.type(screen.getByRole("textbox", { name: "Maximum mana value" }), "4");
    await user.click(save());

    expect(onSave).toHaveBeenCalledWith([{ kind: "manaValue", min: 2, max: 4 }]);
  });

  it("adds chip rules — colour, card type, rarity, finish, condition and border", async () => {
    const user = userEvent.setup();
    const { onSave } = open();

    await addRule(user, "Colour");
    await user.click(screen.getByRole("button", { name: "Blue" }));
    await user.click(screen.getByRole("button", { name: "Red" }));
    await addRule(user, "Card type");
    await user.click(screen.getByRole("button", { name: "Creature" }));
    await addRule(user, "Rarity");
    await user.click(screen.getByRole("button", { name: "Mythic" }));
    await addRule(user, "Finish");
    await user.click(screen.getByRole("button", { name: "Etched" }));
    await addRule(user, "Condition");
    await user.click(screen.getByRole("button", { name: "Near mint" }));
    await addRule(user, "Border");
    await user.click(screen.getByRole("button", { name: "Full art" }));
    // A second press takes a value off again.
    await user.click(screen.getByRole("button", { name: "Red" }));
    await user.click(save());

    expect(onSave).toHaveBeenCalledWith([
      { kind: "colors", values: ["U"] },
      { kind: "types", values: ["Creature"] },
      { kind: "rarities", values: ["mythic"] },
      { kind: "finishes", values: ["etched"] },
      { kind: "conditions", values: ["NM"] },
      { kind: "borders", values: ["fullart"] },
    ]);
  });

  it("picks sets from the search's set picker and takes one off by its chip", async () => {
    const user = userEvent.setup();
    const { onSave } = open();

    await addRule(user, "Set");
    await user.click(screen.getByRole("button", { name: "Set" }));
    await user.click(await screen.findByRole("option", { name: /Alpha/ }));
    await user.click(await screen.findByRole("option", { name: /Arabian/ }));
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Remove set LEA" }));
    await user.click(save());

    expect(onSave).toHaveBeenCalledWith([{ kind: "sets", values: ["arn"] }]);
  });

  it("adds a release date range from text", async () => {
    const user = userEvent.setup();
    const { onSave } = open();

    await addRule(user, "Release date");
    expect(screen.getByRole("textbox", { name: "Released from" })).toHaveAttribute(
      "placeholder",
      "Any",
    );
    await user.type(screen.getByRole("textbox", { name: "Released from" }), "2001");
    await user.type(screen.getByRole("textbox", { name: "Released to" }), "2005-06");
    await user.click(save());

    expect(onSave).toHaveBeenCalledWith([{ kind: "released", from: "2001", to: "2005-06" }]);
  });

  it("edits a rule it was opened with, keeping the others", async () => {
    const user = userEvent.setup();
    const rules: FolderRule[] = [
      { kind: "price", min: null, max: 1 },
      { kind: "borders", values: ["borderless"] },
    ];
    const { onSave } = open({ rules });

    const max = screen.getByRole("textbox", { name: "Maximum price in USD" });
    expect(max).toHaveValue("1");
    await user.clear(max);
    await user.type(max, "2");
    await user.click(save());

    expect(onSave).toHaveBeenCalledWith([
      { kind: "price", min: null, max: 2 },
      { kind: "borders", values: ["borderless"] },
    ]);
  });

  it("greys Save with the first reason while a rule is incomplete", async () => {
    const user = userEvent.setup();
    const { onSave } = open();

    await addRule(user, "Colour");
    expect(save()).toHaveAttribute("aria-disabled", "true");
    expect(save()).toHaveAccessibleDescription(RULE_REFUSAL.noValues);
    await user.click(save());
    expect(onSave).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Green" }));
    expect(save()).not.toHaveAttribute("aria-disabled");
  });

  it("refuses a range written backwards, a bad date and a box that is not a number", async () => {
    const user = userEvent.setup();
    open();

    await addRule(user, "Release date");
    await user.type(screen.getByRole("textbox", { name: "Released from" }), "01/2000");
    expect(screen.getByText(RULE_REFUSAL.date)).toBeInTheDocument();
    await user.clear(screen.getByRole("textbox", { name: "Released from" }));
    await user.type(screen.getByRole("textbox", { name: "Released from" }), "2005");
    await user.type(screen.getByRole("textbox", { name: "Released to" }), "2001");
    expect(screen.getByText(RULE_REFUSAL.range)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Remove rule 1 (Release date)" }));
    await addRule(user, "Mana value");
    await user.type(screen.getByRole("textbox", { name: "Minimum mana value" }), "two");
    expect(screen.getByText("Write each end of a range as a number.")).toBeInTheDocument();
  });

  it("offers no condition rule on a wishlist folder", async () => {
    const user = userEvent.setup();
    open({ scope: "wishlist" });

    await user.click(screen.getByRole("button", { name: "Add rule" }));
    expect(screen.getByRole("option", { name: "Border" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Condition" })).not.toBeInTheDocument();
  });

  it("lists inherited rules read-only under the folder they come from", async () => {
    open({
      inherited: [
        { folderId: 1, folderName: "Binder", rules: [{ kind: "price", min: null, max: 1 }] },
      ],
    });

    const from = screen.getByRole("region", { name: "From “Binder”" });
    expect(within(from).getByText("Price up to $1.00")).toBeInTheDocument();
    expect(within(from).queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("draws the backend's refusal and holds Save while a write is in flight", () => {
    open({
      rules: [{ kind: "colors", values: ["U"] }],
      error: "That folder belongs to the app.",
      pending: true,
    });

    expect(screen.getByRole("alert")).toHaveTextContent("That folder belongs to the app.");
    expect(save()).toBeDisabled();
  });

  it("closes from Cancel", async () => {
    const user = userEvent.setup();
    const { onClose } = open();

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("starts each opening on the rules it is handed, dropping an unsaved draft", async () => {
    const user = userEvent.setup();
    const props: FolderRulesDialogProps = {
      open: true,
      scope: "collection",
      folderName: "Binder",
      rules: [{ kind: "colors", values: ["U"] }],
      inherited: [],
      onSave: vi.fn(),
      onClose: vi.fn(),
    };
    const qc = new QueryClient();
    const tree = (p: FolderRulesDialogProps) => (
      <QueryClientProvider client={qc}>
        <FolderRulesDialog {...p} />
      </QueryClientProvider>
    );
    const { rerender } = render(tree(props));

    await user.click(screen.getByRole("button", { name: "Remove rule 1 (Colour)" }));
    expect(screen.queryByRole("group", { name: "Rule 1: Colour" })).not.toBeInTheDocument();
    rerender(tree({ ...props, open: false }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    rerender(tree(props));

    expect(await screen.findByRole("group", { name: "Rule 1: Colour" })).toBeInTheDocument();
  });

  /**
   * **AND and OR through groups** (issue #1053). The issue's own example, built the way a reader
   * would: "rare or full art and land" is an `any of` holding `Rarity` and an `all of`.
   */
  it("builds “rare or (full art and land)” out of groups and saves the tree", async () => {
    const user = userEvent.setup();
    const { onSave } = open();

    await addRule(user, /^Group: any of/);
    expect(screen.getByRole("group", { name: "Group 1: any of" })).toBeInTheDocument();
    const addTo = async (group: string, label: string | RegExp) => {
      await user.click(screen.getByRole("button", { name: `Add rule to group ${group}` }));
      await user.click(screen.getByRole("option", { name: label }));
    };
    await addTo("1", "Rarity");
    await user.click(
      within(screen.getByRole("group", { name: "Rule 1.1: Rarity" })).getByRole("button", {
        name: "Rare",
      }),
    );
    await addTo("1", /^Group: all of/);
    await addTo("1.2", "Border");
    await user.click(screen.getByRole("button", { name: "Full art" }));
    await addTo("1.2", "Card type");
    await user.click(
      within(screen.getByRole("group", { name: "Rule 1.2.2: Card type" })).getByRole("button", {
        name: "Land",
      }),
    );
    await user.click(save());

    expect(onSave).toHaveBeenCalledWith([
      {
        kind: "group",
        op: "or",
        rules: [
          { kind: "rarities", values: ["rare"] },
          {
            kind: "group",
            op: "and",
            rules: [
              { kind: "borders", values: ["fullart"] },
              { kind: "types", values: ["Land"] },
            ],
          },
        ],
      },
    ]);
  });

  it("flips a group's join, greys Save on an empty group, and removes a group whole", async () => {
    const user = userEvent.setup();
    const { onSave } = open({
      rules: [{ kind: "group", op: "and", rules: [{ kind: "colors", values: ["U"] }] }],
    });

    await user.click(screen.getByRole("button", { name: "Join of group 1" }));
    await user.click(screen.getByRole("option", { name: /^Any of these/ }));
    expect(screen.getByRole("group", { name: "Group 1: any of" })).toBeInTheDocument();

    await addRule(user, /^Group: all of/);
    expect(screen.getByText(RULE_REFUSAL.emptyGroup)).toBeInTheDocument();
    await user.click(save());
    expect(onSave).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Remove group 2 (all of)" }));
    await user.click(save());
    expect(onSave).toHaveBeenCalledWith([
      { kind: "group", op: "or", rules: [{ kind: "colors", values: ["U"] }] },
    ]);
  });

  it("offers no group inside the deepest one", async () => {
    const user = userEvent.setup();
    const blue: FolderRule = { kind: "colors", values: ["U"] };
    open({
      rules: [
        {
          kind: "group",
          op: "or",
          rules: [
            blue,
            { kind: "group", op: "and", rules: [{ kind: "group", op: "or", rules: [blue] }] },
          ],
        },
      ],
    });

    await user.click(screen.getByRole("button", { name: "Add rule to group 1.2" }));
    expect(screen.getByRole("option", { name: /^Group: any of/ })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Add rule to group 1.2.1" }));
    expect(screen.getByRole("option", { name: "Colour" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /^Group:/ })).not.toBeInTheDocument();
  });
});
