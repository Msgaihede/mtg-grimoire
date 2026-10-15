import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getMarketplace = vi.hoisted(() => vi.fn());
const marketplaceFeedStatus = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (original) => ({
  ...(await original<typeof import("@/lib/ipc")>()),
  ipc: { getMarketplace, marketplaceFeedStatus },
}));

import { TOOLTIP_PANEL_ID, TooltipProvider } from "@/components/tooltip/TooltipProvider";
import type { EffectiveRules } from "@/lib/folderRules";
import { FolderRulesBadge } from "./FolderRulesBadge";

beforeEach(() => {
  getMarketplace.mockReset().mockResolvedValue("tcgplayer");
  marketplaceFeedStatus.mockReset().mockResolvedValue([]);
});

function wrap(ui: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>{ui}</TooltipProvider>
    </QueryClientProvider>,
  );
}

const BOTH: EffectiveRules = {
  own: [{ kind: "price", min: null, max: 1 }],
  inherited: [{ folderId: 1, folderName: "Binder", rules: [{ kind: "colors", values: ["U"] }] }],
};

describe("FolderRulesBadge", () => {
  it("draws nothing for a folder with no rules, own or inherited", () => {
    const { container } = wrap(
      <FolderRulesBadge effective={{ own: [], inherited: [] }} conflicts={3} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("says the rules and the conflicts in one sentence, with the count beside the glyph", () => {
    wrap(<FolderRulesBadge effective={BOTH} conflicts={3} />);

    const badge = screen.getByRole("img", {
      name:
        "This folder's rules: Price up to $1.00. From “Binder”: Colour: Blue. " +
        "3 cards don't match this folder's rules.",
    });
    expect(badge).toHaveTextContent("3");
    expect(badge.querySelector(".text-destructive")).toHaveTextContent("3");
    expect(badge.querySelector("svg")).not.toBeNull();
  });

  it("draws no count when nothing conflicts, and names only what it has", () => {
    wrap(<FolderRulesBadge effective={{ own: [], inherited: BOTH.inherited }} conflicts={0} />);

    const badge = screen.getByRole("img", { name: "From “Binder”: Colour: Blue." });
    expect(badge).toHaveTextContent("");
  });

  /**
   * On hover, after the provider's open delay (real timers; `waitFor`'s second is longer than
   * `TOOLTIP_OPEN_MS`). Not on focus: after `tooltip.test.tsx`'s own Tab keydown, jsdom's
   * `:focus-visible` still answered `false` for this focused `span` (measured 2026-10-14), where
   * it answers `true` for that suite's button — so a focus case here would be testing jsdom.
   */
  it("lists the rules in its tooltip on hover", async () => {
    wrap(<FolderRulesBadge effective={BOTH} conflicts={1} />);

    fireEvent.pointerEnter(screen.getByRole("img"));
    await waitFor(() => expect(document.getElementById(TOOLTIP_PANEL_ID)).not.toBeNull());
    const panel = document.getElementById(TOOLTIP_PANEL_ID)!;
    expect(panel).toHaveTextContent("This folder's rules:");
    expect(panel).toHaveTextContent("Price up to $1.00");
    expect(panel).toHaveTextContent("From “Binder”:");
    expect(panel).toHaveTextContent("Colour: Blue");
    expect(panel).toHaveTextContent("1 card doesn't match this folder's rules");
  });

  it("is a button that shows the breakers when given `onShow` and a count", async () => {
    const onShow = vi.fn();
    wrap(<FolderRulesBadge effective={BOTH} conflicts={2} onShow={onShow} />);
    const badge = screen.getByRole("button", {
      name:
        "This folder's rules: Price up to $1.00. From “Binder”: Colour: Blue. " +
        "2 cards don't match this folder's rules. Press to show them.",
    });
    expect(screen.queryByRole("img")).toBeNull();
    await userEvent.setup().click(badge);
    expect(onShow).toHaveBeenCalledTimes(1);
  });

  it("stays an image with `onShow` when nothing breaks the rules, or inside a control", () => {
    const onShow = vi.fn();
    const { rerender } = wrap(<FolderRulesBadge effective={BOTH} conflicts={0} onShow={onShow} />);
    expect(screen.getByRole("img")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <TooltipProvider>
          <FolderRulesBadge effective={BOTH} conflicts={2} onShow={onShow} focusable={false} />
        </TooltipProvider>
      </QueryClientProvider>,
    );
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("takes no tab stop when told it sits inside a control", () => {
    wrap(<FolderRulesBadge effective={BOTH} conflicts={0} focusable={false} />);
    expect(screen.getByRole("img")).not.toHaveAttribute("tabindex");
  });
});
