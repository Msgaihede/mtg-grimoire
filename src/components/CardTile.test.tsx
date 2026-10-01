import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CardTile } from "@/components/CardTile";
import { TooltipProvider } from "@/components/tooltip/TooltipProvider";

const draw = (ui: React.ReactElement) => render(<TooltipProvider>{ui}</TooltipProvider>);

const BOLT = {
  cardId: "00000000-0000-0000-0000-000000000001",
  name: "Lightning Bolt",
  rarity: "common",
  chin: { setCode: "lea", collectorNumber: "161" },
} as const;

describe("CardTile", () => {
  it("draws the picture and the printing line under it", () => {
    draw(<CardTile {...BOLT} />);
    expect(screen.getByRole("img", { name: "Lightning Bolt" })).toBeInTheDocument();
    expect(screen.getByText(/lea/i)).toBeInTheDocument();
    expect(screen.getByText(/161/)).toBeInTheDocument();
  });

  it("is not a control unless it is given a press", () => {
    draw(<CardTile {...BOLT} />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("makes the art a button named for the card, and keeps the chin outside it", async () => {
    const onPress = vi.fn();
    draw(<CardTile {...BOLT} onPress={onPress} pressLabel="Lightning Bolt, LEA 161" />);

    const button = screen.getByRole("button", { name: "Lightning Bolt, LEA 161" });
    await userEvent.click(button);
    expect(onPress).toHaveBeenCalledTimes(1);
    // The chin is a sibling of the card's button, never a child — its text is a fact a screen
    // reader should reach, and a button's label would swallow it.
    expect(button).not.toContainElement(screen.getByText(/161/));
  });

  it("draws a caller's own printing line where there is no set to name", () => {
    draw(
      <CardTile
        cardId={null}
        name="Sol Ring"
        rarity={null}
        chin={{ printing: "Any printing", printingTitle: null }}
      />,
    );
    expect(screen.getByText("Any printing")).toBeInTheDocument();
  });

  it("draws what it is handed over the art", () => {
    draw(<CardTile {...BOLT} overlay={<span>four</span>} />);
    expect(screen.getByText("four")).toBeInTheDocument();
  });

  it("hands a present null picture through, which is not the same as none given", () => {
    // `remoteSrc` absent asks the image cache; a present `null` says there is no picture.
    // A tile that collapsed the two would ask a browser for `mtgimg://`.
    draw(<CardTile {...BOLT} cardId={null} remoteSrc={null} />);
    expect(screen.queryByRole("img")).toBeNull();
  });
});
