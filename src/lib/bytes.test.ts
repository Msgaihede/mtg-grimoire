import { describe, expect, it } from "vitest";
import { bytesToBase64 } from "./bytes";

describe("bytesToBase64", () => {
  it("encodes with the standard alphabet and padding, the one Rust's STANDARD engine decodes", () => {
    expect(bytesToBase64(new Uint8Array([1, 2, 3]))).toBe("AQID");
    expect(bytesToBase64(new Uint8Array([255, 254]))).toBe("//4=");
    expect(bytesToBase64(new Uint8Array([]))).toBe("");
  });

  it("survives a payload larger than one call stack of arguments", () => {
    // `String.fromCharCode(...bytes)` on 200 KB throws a RangeError; a frame is 140 KB.
    const big = new Uint8Array(300_000).fill(65);
    expect(bytesToBase64(big).length).toBe(400_000);
  });
});
