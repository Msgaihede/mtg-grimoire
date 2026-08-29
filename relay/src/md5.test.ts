import { describe, expect, it } from "vitest";
import { hex, hmacMd5, md5, timingSafeEqualHex } from "./md5";

const utf8 = (s: string) => new TextEncoder().encode(s);
const repeat = (byte: number, n: number) => new Uint8Array(n).fill(byte);

describe("md5", () => {
  // RFC 1321 appendix A.5, verbatim. These are the whole point of writing MD5 by hand:
  // the implementation is pinned to a published answer rather than to its own output.
  it.each([
    ["", "d41d8cd98f00b204e9800998ecf8427e"],
    ["a", "0cc175b9c0f1b6a831c399e269772661"],
    ["abc", "900150983cd24fb0d6963f7d28e17f72"],
    ["message digest", "f96b697d7cb7938d525a2f31aaf161d0"],
    ["abcdefghijklmnopqrstuvwxyz", "c3fcd3d76192e4007dfb496cca67e13b"],
    [
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
      "d174ab98d277d9f5a5611c2c9f419d9f",
    ],
  ])("hashes %j", (input, expected) => {
    expect(hex(md5(utf8(input)))).toBe(expected);
  });

  it("crosses the 56-byte padding boundary correctly", () => {
    // 56 bytes is where MD5 needs a whole extra block for the length field. An
    // implementation that pads in one block is right for 55 bytes and wrong here.
    expect(hex(md5(utf8("a".repeat(55))))).toBe("ef1772b6dff9a122358552954ad0df65");
    expect(hex(md5(utf8("a".repeat(56))))).toBe("3b0c8ac703f828b04c6c197006d17218");
  });
});

describe("hmacMd5", () => {
  // RFC 2202 section 2. Case 6 is the one that matters most: an 80-byte key exercises the
  // "hash the key first" branch, which is silently skippable and wrong forever if skipped.
  it("matches RFC 2202 case 1", () => {
    expect(hex(hmacMd5(repeat(0x0b, 16), utf8("Hi There")))).toBe(
      "9294727a3638bb1c13f48ef8158bfc9d",
    );
  });

  it("matches RFC 2202 case 2", () => {
    expect(hex(hmacMd5(utf8("Jefe"), utf8("what do ya want for nothing?")))).toBe(
      "750c783e6ab0b503eaa86e310a5db738",
    );
  });

  it("matches RFC 2202 case 3", () => {
    expect(hex(hmacMd5(repeat(0xaa, 16), repeat(0xdd, 50)))).toBe(
      "56be34521d144c88dbb8c733f0e8b3f6",
    );
  });

  it("matches RFC 2202 case 6, whose key is longer than the block", () => {
    expect(
      hex(hmacMd5(repeat(0xaa, 80), utf8("Test Using Larger Than Block-Size Key - Hash Key First"))),
    ).toBe("6b1ab7fe4bd7bf8f0b62e6ce61b9d0cd");
  });
});

describe("timingSafeEqualHex", () => {
  it("accepts an exact match and rejects everything else", () => {
    expect(timingSafeEqualHex("abcd", "abcd")).toBe(true);
    expect(timingSafeEqualHex("abcd", "abce")).toBe(false);
    expect(timingSafeEqualHex("abcd", "abc")).toBe(false);
    expect(timingSafeEqualHex("", "")).toBe(true);
  });

  it("is case-insensitive, because a hex digest is", () => {
    expect(timingSafeEqualHex("ABCD", "abcd")).toBe(true);
  });
});
