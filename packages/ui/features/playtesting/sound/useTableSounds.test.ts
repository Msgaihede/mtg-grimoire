import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlaytestAction, PlaytestHappened } from "@/lib/ipc";
import { useTableSoundsMuted } from "./muted";
import type { TableSynth } from "./synth";
import { useTableSounds } from "./useTableSounds";
import { useTableSoundsVolume } from "./volume";

const drew: PlaytestHappened = { type: "drew", seat: "you", name: "Island" };
const tapped: PlaytestHappened = {
  type: "tapped",
  seat: "you",
  name: "Forest",
  count: 1,
  tapped: true,
};

function setup(initial: readonly PlaytestHappened[] = []) {
  const play = vi.fn<TableSynth["play"]>();
  const synth = {
    play,
    unlock: vi.fn<TableSynth["unlock"]>(),
    setVolume: vi.fn<TableSynth["setVolume"]>(),
  };
  const onAct = vi.fn<(a: PlaytestAction) => void>();
  const hook = renderHook(({ happened }) => useTableSounds(happened, onAct, synth), {
    initialProps: { happened: initial },
  });
  const heard = () => play.mock.calls.map((c) => c[0]);
  return { ...hook, synth, onAct, heard };
}

afterEach(() => {
  act(() => useTableSoundsMuted.getState().setMuted(false));
  act(() => useTableSoundsVolume.getState().setVolume(100));
});

describe("useTableSounds", () => {
  it("hears each new beat once, and nothing for an empty one", () => {
    const { rerender, heard } = setup();
    expect(heard()).toEqual([]);
    const beat = [drew];
    rerender({ happened: beat });
    rerender({ happened: beat });
    expect(heard()).toEqual(["draw"]);
    rerender({ happened: [] });
    rerender({ happened: [drew] });
    expect(heard()).toEqual(["draw", "draw"]);
  });

  it("passes every action on, sounding the press where it has one", () => {
    const { result, onAct, heard } = setup();
    act(() => result.current({ type: "undo" }));
    act(() => result.current({ type: "draw", count: 1 }));
    expect(onAct.mock.calls.map((c) => c[0].type)).toEqual(["undo", "draw"]);
    expect(heard()).toEqual(["undo"]);
  });

  it("hears the next beat with the action that led to it, and only that beat", () => {
    const { result, rerender, heard } = setup();
    act(() => result.current({ type: "tapForMana", id: 3 }));
    rerender({ happened: [tapped] });
    rerender({ happened: [tapped] });
    expect(heard()).toEqual(["mana", "tap"]);
  });

  it("makes no sound at all while muted, press or beat", () => {
    const { result, rerender, heard, synth } = setup();
    act(() => useTableSoundsMuted.getState().setMuted(true));
    act(() => result.current({ type: "pass" }));
    rerender({ happened: [drew] });
    window.dispatchEvent(new Event("pointerdown"));
    expect(heard()).toEqual([]);
    expect(synth.unlock).not.toHaveBeenCalled();
  });

  it("wakes the audio from a press on the page", () => {
    const { synth } = setup();
    window.dispatchEvent(new Event("pointerdown"));
    expect(synth.unlock).toHaveBeenCalledTimes(1);
  });

  it("plays at the reader's volume, and follows the slider", () => {
    const { synth } = setup();
    expect(synth.setVolume).toHaveBeenLastCalledWith(1);
    act(() => useTableSoundsVolume.getState().setVolume(50));
    expect(synth.setVolume).toHaveBeenLastCalledWith(0.25);
    act(() => useTableSoundsVolume.getState().setVolume(0));
    expect(synth.setVolume).toHaveBeenLastCalledWith(0);
  });
});
