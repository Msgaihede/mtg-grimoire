import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { nextRadio, radioKeys } from "./radioGroup";

const OPTIONS = ["plain", "arena", "moxfield"] as const;
type Option = (typeof OPTIONS)[number];

function Group({ initial, onChoose }: { initial: Option | null; onChoose?: (o: Option) => void }) {
  const [value, setValue] = useState<Option | null>(initial);
  const choose = (next: Option) => {
    setValue(next);
    onChoose?.(next);
  };
  return (
    <>
      <button type="button">before</button>
      <div role="radiogroup" aria-label="Format">
        {OPTIONS.map((o, i) => (
          <button
            key={o}
            type="button"
            role="radio"
            aria-checked={value === o}
            onClick={() => choose(o)}
            {...radioKeys<Option | null>(OPTIONS, value, (n) => choose(n as Option), i)}
          >
            {o}
          </button>
        ))}
      </div>
      <button type="button">after</button>
    </>
  );
}

describe("radioKeys", () => {
  it("makes the checked radio the group's only Tab stop", async () => {
    render(<Group initial="arena" />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "before" }));
    await user.tab();
    expect(screen.getByRole("radio", { name: "arena" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "after" })).toHaveFocus();
  });

  it("gives the stop to the first radio when none is checked", () => {
    render(<Group initial={null} />);
    expect(screen.getByRole("radio", { name: "plain" })).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("radio", { name: "arena" })).toHaveAttribute("tabindex", "-1");
  });

  it("moves and chooses on the arrows, wrapping at both ends", async () => {
    const onChoose = vi.fn();
    render(<Group initial="plain" onChoose={onChoose} />);
    const user = userEvent.setup();
    screen.getByRole("radio", { name: "plain" }).focus();

    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("radio", { name: "arena" })).toHaveFocus();
    expect(screen.getByRole("radio", { name: "arena" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "arena" })).toHaveAttribute("tabindex", "0");

    await user.keyboard("{ArrowLeft}{ArrowLeft}");
    expect(screen.getByRole("radio", { name: "moxfield" })).toHaveFocus();
    expect(onChoose).toHaveBeenLastCalledWith("moxfield");

    await user.keyboard("{Home}");
    expect(screen.getByRole("radio", { name: "plain" })).toHaveFocus();
    await user.keyboard("{End}");
    expect(screen.getByRole("radio", { name: "moxfield" })).toHaveFocus();
  });

  it("leaves a modified arrow alone", async () => {
    const onChoose = vi.fn();
    render(<Group initial="plain" onChoose={onChoose} />);
    const user = userEvent.setup();
    screen.getByRole("radio", { name: "plain" }).focus();
    await user.keyboard("{Control>}{ArrowRight}{/Control}");
    expect(onChoose).not.toHaveBeenCalled();
    expect(screen.getByRole("radio", { name: "plain" })).toHaveFocus();
  });
});

describe("nextRadio", () => {
  it("answers null for a key that is not the group's", () => {
    expect(nextRadio("Enter", 0, 3)).toBeNull();
    expect(nextRadio("ArrowDown", 0, 0)).toBeNull();
  });
});
