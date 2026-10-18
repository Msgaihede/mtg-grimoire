import { describe, expect, it } from "vitest";
import { signer } from "./fake";
import { MAX_SKEW_SECS, discordSigned, hexToBytes } from "./verify";

/** Discord's signature, checked again in the object — the same scheme the front checks. */
describe("discordSigned", () => {
  const body = JSON.stringify({ type: 2, data: { name: "collection" } });
  const now = 1_760_000_000_000;
  const stamp = String(now / 1000);

  it("takes Discord's signature over the timestamp and the raw body", async () => {
    const key = await signer();
    const sig = await key.sign(stamp, body);
    expect(await discordSigned(key.publicKeyHex, body, sig, stamp, now)).toBe(true);
    expect(
      await discordSigned(key.publicKeyHex.toUpperCase(), body, sig.toUpperCase(), stamp, now),
    ).toBe(true);
  });

  it("refuses a body, a timestamp or a key that is not what was signed", async () => {
    const key = await signer();
    const other = await signer();
    const sig = await key.sign(stamp, body);
    expect(await discordSigned(key.publicKeyHex, `${body} `, sig, stamp, now)).toBe(false);
    expect(await discordSigned(key.publicKeyHex, body, sig, String(Number(stamp) + 1), now)).toBe(
      false,
    );
    expect(await discordSigned(other.publicKeyHex, body, sig, stamp, now)).toBe(false);
  });

  it("refuses an old signature, replayed", async () => {
    const key = await signer();
    const old = String(now / 1000 - MAX_SKEW_SECS - 1);
    const sig = await key.sign(old, body);
    expect(await discordSigned(key.publicKeyHex, body, sig, old, now)).toBe(false);
  });

  it("refuses what is not hex, or not the right length, without throwing", async () => {
    const key = await signer();
    const sig = await key.sign(stamp, body);
    expect(
      await discordSigned("<set when the Discord application exists>", body, sig, stamp, now),
    ).toBe(false);
    expect(await discordSigned(key.publicKeyHex, body, sig.slice(2), stamp, now)).toBe(false);
    expect(await discordSigned(key.publicKeyHex, body, sig, "", now)).toBe(false);
    expect(await discordSigned(key.publicKeyHex, body, sig, "12abc", now)).toBe(false);
    expect(hexToBytes("0g")).toBeNull();
    expect(hexToBytes("abc")).toBeNull();
  });
});
