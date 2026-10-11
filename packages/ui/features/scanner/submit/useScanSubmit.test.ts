import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { STATUS, VERDICTS } from "../fixtures";
import type { ScanMode, ScannerStatus, ScannerVerdict } from "../types";
import { SUBMIT_LONG_EDGE, SUBMIT_QUALITY } from "./still";
import { PICTURE_NOT_TAKEN } from "./submitText";
import { useScanSubmit } from "./useScanSubmit";

type Grab = (longEdge: number, quality: number) => Promise<Uint8Array | null>;

interface Page {
  grab: Grab;
  verdict: ScannerVerdict | null;
  mode: ScanMode;
  status: ScannerStatus | null;
}

/** A grab that answers three bytes — `AQID` as the text a still carries. */
const takes = () => vi.fn<Grab>(async () => new Uint8Array([1, 2, 3]));

/** A grab the test answers when it chooses to. */
function held() {
  let answer: (bytes: Uint8Array | null) => void = () => {};
  let refuse: (reason: unknown) => void = () => {};
  const grab = vi.fn<Grab>(
    () =>
      new Promise((resolve, reject) => {
        answer = resolve;
        refuse = reject;
      }),
  );
  return { grab, answer: (bytes: Uint8Array | null) => answer(bytes), refuse: (e: unknown) => refuse(e) };
}

function page(over: Partial<Page> = {}): Page {
  return { grab: takes(), verdict: VERDICTS.decided, mode: "fast", status: STATUS.present, ...over };
}

/** The press that opened it — a real button in the document, so the caret can come back to it. */
function opener(): HTMLButtonElement {
  const button = document.createElement("button");
  document.body.append(button);
  return button;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("useScanSubmit", () => {
  it("is closed until the press, and asks the camera for nothing", () => {
    const grab = takes();
    const { result } = renderHook(() => useScanSubmit(page({ grab })));
    expect(result.current.still).toBeNull();
    expect(result.current.error).toBeNull();
    expect(grab).not.toHaveBeenCalled();
  });

  it("grabs the picture at the size it is sent at, and opens on it with what the scanner said", async () => {
    const grab = takes();
    const { result } = renderHook(() => useScanSubmit(page({ grab })));
    act(() => result.current.open(opener()));
    await waitFor(() => expect(result.current.still).not.toBeNull());

    expect(grab).toHaveBeenCalledTimes(1);
    expect(grab).toHaveBeenCalledWith(SUBMIT_LONG_EDGE, SUBMIT_QUALITY);
    expect(result.current.still).toEqual({
      frame: "AQID",
      said: {
        reported: "storm-of-saruman-ltr-72",
        mode: "fast",
        confidence: 1,
        distance: 30,
        bundle: 117630,
      },
      leadName: "Storm of Saruman",
    });
  });

  /**
   * The camera keeps running behind the dialog and the page goes on re-rendering with each
   * verdict. The picture the reader is looking at must stay the picture, and the scanner's half
   * what it was at the press.
   */
  it("keeps the still as it was however the page moves on behind it", async () => {
    const { result, rerender } = renderHook((props: Page) => useScanSubmit(props), {
      initialProps: page(),
    });
    act(() => result.current.open(opener()));
    await waitFor(() => expect(result.current.still).not.toBeNull());
    const frozen = result.current.still;

    rerender(page({ verdict: VERDICTS.voting, mode: "exact", status: STATUS.missing }));
    rerender(page({ verdict: null }));
    expect(result.current.still).toBe(frozen);
  });

  it("reads the scanner at the press, not when the picture has finished encoding", async () => {
    const camera = held();
    const { result, rerender } = renderHook((props: Page) => useScanSubmit(props), {
      initialProps: page({ grab: camera.grab, verdict: VERDICTS.decided }),
    });
    act(() => result.current.open(opener()));
    // The next card is under the lens before the encode lands.
    rerender(page({ grab: camera.grab, verdict: VERDICTS.voting }));
    await act(async () => camera.answer(new Uint8Array([1, 2, 3])));

    expect(result.current.still?.said.reported).toBe("storm-of-saruman-ltr-72");
    expect(result.current.still?.leadName).toBe("Storm of Saruman");
  });

  it("opens nothing on a grab that came back empty, and says so", async () => {
    const grab = vi.fn<Grab>(async () => null);
    const { result } = renderHook(() => useScanSubmit(page({ grab })));
    act(() => result.current.open(opener()));
    await waitFor(() => expect(result.current.error).toBe(PICTURE_NOT_TAKEN));
    expect(result.current.still).toBeNull();
  });

  it("opens nothing on a grab that threw, says so, and clears the sentence on the next press", async () => {
    const camera = held();
    const { result } = renderHook(() => useScanSubmit(page({ grab: camera.grab })));
    act(() => result.current.open(opener()));
    await act(async () => camera.refuse(new DOMException("tainted", "SecurityError")));
    await waitFor(() => expect(result.current.error).toBe(PICTURE_NOT_TAKEN));
    expect(result.current.still).toBeNull();
    // One more turn, for the grab's own tidying-up behind the sentence.
    await act(async () => {});

    // Pressed again: the old sentence goes at once, and this grab's answer decides.
    act(() => result.current.open(opener()));
    expect(result.current.error).toBeNull();
    await act(async () => camera.answer(new Uint8Array([1, 2, 3])));
    expect(result.current.still?.frame).toBe("AQID");
  });

  it("takes one picture for two presses that land together", async () => {
    const camera = held();
    const { result } = renderHook(() => useScanSubmit(page({ grab: camera.grab })));
    act(() => {
      result.current.open(opener());
      result.current.open(opener());
    });
    expect(camera.grab).toHaveBeenCalledTimes(1);
    await act(async () => camera.answer(new Uint8Array([1, 2, 3])));
    expect(result.current.still).not.toBeNull();
  });

  it("does not take a second picture over the one the dialog is open on", async () => {
    const grab = takes();
    const { result } = renderHook(() => useScanSubmit(page({ grab })));
    act(() => result.current.open(opener()));
    await waitFor(() => expect(result.current.still).not.toBeNull());
    const frozen = result.current.still;

    act(() => result.current.open(opener()));
    expect(grab).toHaveBeenCalledTimes(1);
    expect(result.current.still).toBe(frozen);
  });

  it("hands the caret back to the press on a dismissal", async () => {
    const from = opener();
    const { result } = renderHook(() => useScanSubmit(page()));
    act(() => result.current.open(from));
    await waitFor(() => expect(result.current.still).not.toBeNull());
    expect(from).not.toHaveFocus();

    act(() => result.current.onDismiss());
    expect(result.current.still).toBeNull();
    expect(from).toHaveFocus();
  });

  it("closes without moving the caret on a press outside", async () => {
    const from = opener();
    const elsewhere = opener();
    const { result } = renderHook(() => useScanSubmit(page()));
    act(() => result.current.open(from));
    await waitFor(() => expect(result.current.still).not.toBeNull());
    elsewhere.focus();

    act(() => result.current.onClose());
    expect(result.current.still).toBeNull();
    expect(elsewhere).toHaveFocus();
  });

  it("opens again after it has been closed, on a new picture", async () => {
    const grab = takes();
    const { result } = renderHook(() => useScanSubmit(page({ grab })));
    act(() => result.current.open(opener()));
    await waitFor(() => expect(result.current.still).not.toBeNull());
    act(() => result.current.onClose());

    act(() => result.current.open(opener()));
    await waitFor(() => expect(result.current.still).not.toBeNull());
    expect(grab).toHaveBeenCalledTimes(2);
  });

  it("keeps its two ways out stable, so the dialog's body is not redrawn with the page", () => {
    const { result, rerender } = renderHook((props: Page) => useScanSubmit(props), {
      initialProps: page(),
    });
    const { onDismiss, onClose } = result.current;
    rerender(page({ verdict: VERDICTS.voting }));
    expect(result.current.onDismiss).toBe(onDismiss);
    expect(result.current.onClose).toBe(onClose);
  });
});
