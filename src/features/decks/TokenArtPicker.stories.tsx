import type { Meta, StoryObj } from "@storybook/react-vite";
import { useQueryClient } from "@tanstack/react-query";
import { useState, type JSX } from "react";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import type { TokenPrinting } from "@/lib/ipc";
import { useAppStore } from "@/lib/store";
import { TokenArtPicker, type TokenPickerMode } from "./TokenArtPicker";
import { useDeckTokens } from "./useDeckTokens";

type Job = "swap" | "add";

interface PickerHostProps {
  /** Which of the picker's two jobs — the band's tile press, or its Add printing. */
  job: Job;
  deckId: number;
  onPick: (to: { cardId: string; finish: string }) => void;
}

/**
 * The picker as `DeckEditor` opens it: `swap` on the deck's first token entry, `add` over every
 * token the deck has — **the fake's own answer** through `useDeckTokens`, so the tiles, their
 * prices and the grouping are the fake's rather than a story's. The pick is logged, not written:
 * what a pick does to the deck is the band's stories' subject.
 */
function PickerHost({ job, deckId, onPick }: PickerHostProps): JSX.Element {
  const tokens = useDeckTokens(deckId, "live");
  const zoom = useAppStore((s) => s.cardZoom.deck);
  const first = tokens.tokens[0];
  const mode: TokenPickerMode | null =
    first === undefined
      ? null
      : job === "swap"
        ? { kind: "swap", entry: first }
        : { kind: "add", tokens: tokens.tokens };
  return (
    <TokenArtPicker mode={mode} zoom={zoom} onPick={onPick} onDismiss={() => {}} onClose={() => {}} />
  );
}

/**
 * **The picker behind the Tokens & Emblems band and the views' token pile** — one dialog, two
 * jobs. `swap` repictures one entry; `add` offers the printings of every token the deck has, and
 * since managed tokens (2026-09-27, spec §3.6) its **All tokens** toggle offers every token in the
 * game instead — grouped by token under its name and subtitle, the search box narrowing by name
 * or set code, and a pick of one the deck does not make adding it by hand.
 */
const meta = {
  title: "Decks/TokenArtPicker",
  component: PickerHost,
  subcomponents: { TokenArtPicker },
  tags: ["autodocs"],
  args: { job: "add", deckId: 1, onPick: fn() },
  argTypes: { job: { control: "inline-radio", options: ["swap", "add"] } },
  parameters: {
    layout: "fullscreen",
    // A dialog is `fixed`, so each story needs a frame of its own on the docs page.
    docs: { story: { inline: false, height: "720px" } },
  },
} satisfies Meta<typeof PickerHost>;

export default meta;
type Story = StoryObj<typeof meta>;

/** `swap`: one token's printings, the entry's own tile pressed — and no `All tokens`, since a swap
 *  is about the one token. */
export const Swap: Story = {
  args: { job: "swap" },
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    const dialog = await body.findByRole("dialog", { name: /^Art for / });
    await within(dialog).findAllByRole("button", { name: / — / });
    await expect(within(dialog).queryByRole("button", { name: "All tokens" })).toBeNull();
  },
};

/** `add`, with **All tokens** off: the deck's own tokens, one group each. */
export const AddFromTheDeck: Story = {
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    const dialog = await body.findByRole("dialog", { name: "Add a printing" });
    await within(dialog).findAllByRole("button", { name: / — / });
    await expect(within(dialog).getByRole("button", { name: "All tokens" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    // The two Wurms deck 1 makes are two groups, each under its own rules text.
    await expect(
      within(dialog).getByRole("list", { name: "Wurm, Colorless 3/3 · Deathtouch" }),
    ).toBeInTheDocument();
  },
};

/**
 * **All tokens on** — every token in the workbench's corpus, the one nothing in deck 1 makes
 * included (the double-faced `plst` token), grouped by token; the box narrows by set code; a pick
 * hands the host the printing and the finish, as from the deck's own tokens.
 */
export const AllTokens: Story = {
  play: async ({ canvasElement, args }) => {
    const body = within(canvasElement.ownerDocument.body);
    const dialog = await body.findByRole("dialog", { name: "Add a printing" });
    await within(dialog).findAllByRole("button", { name: / — / });
    await userEvent.click(within(dialog).getByRole("button", { name: "All tokens" }));

    await within(dialog).findByRole("list", { name: /^Start Your Engines! \/\/ Max Speed/ });
    await expect(
      within(dialog).getByRole("list", { name: "Wurm, Colorless 3/3 · Lifelink" }),
    ).toBeInTheDocument();

    await userEvent.type(
      within(dialog).getByRole("searchbox", { name: /find a printing/i }),
      "plst",
    );
    await waitFor(async () => {
      await expect(within(dialog).getAllByRole("button", { name: / — / })).toHaveLength(1);
    });
    await userEvent.click(within(dialog).getByRole("button", { name: / — PLST · TDFT-14/ }));
    await expect(args.onPick).toHaveBeenCalledWith(
      expect.objectContaining({ finish: "nonfoil" }),
    );
  },
};

/**
 * The corpus's size: **3 245 printings over 1 078 tokens**, the debug corpus's count when the
 * token feature landed — synthetic rows written into the story's own cache under the read's key,
 * so the wall draws a list the size of the real one. Their ids resolve to no picture, so every
 * tile is the no-art frame, which is the cheaper frame and the honest one for timing layout.
 *
 * **What this is for is first paint.** Every group is `content-visibility: auto` with an intrinsic
 * size one row tall, so the groups off screen cost no layout and no paint; opening the toggle here
 * is the measurement the managed-tokens spec asks for, and the number is in the change's record
 * rather than in this file.
 */
const SCALE_TOKENS = 1_078;
const SCALE_PRINTINGS = 3_245;

function scalePrintings(): TokenPrinting[] {
  const rows: TokenPrinting[] = [];
  for (let i = 0; i < SCALE_PRINTINGS; i += 1) {
    const token = i % SCALE_TOKENS;
    rows.push({
      id: `scale-${i}`,
      oracleId: `scale-token-${token}`,
      name: `Token ${String(token).padStart(4, "0")}`,
      typeLine: "Token Creature — Construct",
      colors: "",
      power: "1",
      toughness: "1",
      oracleText: `Scale fixture ${token}.`,
      layout: "token",
      setCode: `t${String(i % 97).padStart(3, "0")}`,
      setName: null,
      collectorNumber: String(i),
      releasedAt: "2024-01-01",
      rarity: "common",
      illustrationId: null,
      artist: null,
      lang: "en",
      finishes: '["nonfoil"]',
      finishPrices: { nonfoil: 0.1, foil: null, etched: null },
      promo: false,
      promoTypes: null,
      fullArt: false,
      frameEffects: null,
      borderColor: null,
    });
  }
  // The read's own order — name, then oracle id — so each token's printings arrive together.
  return rows.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

function ScaleHost(props: PickerHostProps): JSX.Element {
  const client = useQueryClient();
  // During render, before the picker mounts, so its read finds the answer already in the cache —
  // and never stale in this story's cache, so a toggle pressed off and on again half a minute
  // later does not refetch the fake's short list over it.
  useState(() => {
    client.setQueryDefaults(["tokenPrintings"], { staleTime: Infinity });
    client.setQueryData(["tokenPrintings", "tcgplayer"], scalePrintings());
  });
  return <PickerHost {...props} />;
}

export const AllTokensAtScale: Story = {
  render: (args) => <ScaleHost {...args} />,
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    const dialog = await body.findByRole("dialog", { name: "Add a printing" });
    await within(dialog).findAllByRole("button", { name: / — / });
    await userEvent.click(within(dialog).getByRole("button", { name: "All tokens" }));
    // Counted by attribute rather than by role: a role query computes an accessible name for
    // each of a thousand lists, which is the slow part of a jsdom run and asserts nothing more.
    await waitFor(async () => {
      await expect(dialog.querySelectorAll('ul[aria-label^="Token "]')).toHaveLength(
        SCALE_TOKENS,
      );
    });
  },
};
