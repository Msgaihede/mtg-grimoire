import { describe, expect, it } from "vitest";
import { normaliseName } from "../src/projection";
import {
  fromBase64url,
  importKek,
  newDataKey,
  openRow,
  rewrap,
  rowKey,
  sealRow,
  toBase64url,
  unwrapDataKey,
  wrapDataKey,
} from "../src/seal";
import { KEK, NEXT_KEK } from "./fake";

/**
 * The envelope (`src/seal.ts`): a data key wrapped under the KEK for one group, a key per table
 * generation drawn from it, and each row sealed to its table and uid. Every refusal below is the
 * GCM tag's — the one check there is — so each is asserted as a throw, not as a value.
 */

const ROW = { uid: "u-1", name: "Lightning Bolt", notes: "from my first prerelease" };

describe("a data key", () => {
  it("opens under the KEK and the group it was wrapped for, and under nothing else", async () => {
    const kek = await importKek(KEK, "INTEGRATIONS_KEK");
    const key = newDataKey();
    const wrapped = await wrapDataKey(kek, key, "g1");
    expect(await unwrapDataKey(kek, wrapped, "g1")).toEqual(key);
    // Another group's object: the associated data is the group id.
    await expect(unwrapDataKey(kek, wrapped, "g2")).rejects.toThrow();
    // Another KEK.
    const other = await importKek(NEXT_KEK, "INTEGRATIONS_KEK");
    await expect(unwrapDataKey(other, wrapped, "g1")).rejects.toThrow();
  });

  it("rewraps under a new KEK, after which the old one no longer opens it", async () => {
    const old = await importKek(KEK, "INTEGRATIONS_KEK");
    const next = await importKek(NEXT_KEK, "INTEGRATIONS_KEK");
    const key = newDataKey();
    const moved = await rewrap(await wrapDataKey(old, key, "g1"), "g1", old, next);
    expect(await unwrapDataKey(next, moved, "g1")).toEqual(key);
    await expect(unwrapDataKey(old, moved, "g1")).rejects.toThrow();
    // And a rewrap asked with the wrong old key writes nothing: it throws.
    await expect(rewrap(moved, "g1", old, next)).rejects.toThrow();
  });

  it("is never made under a missing or short KEK, and the refusal names the binding", async () => {
    await expect(importKek(undefined, "INTEGRATIONS_KEK")).rejects.toThrow(
      "the integrations Worker is missing its INTEGRATIONS_KEK binding",
    );
    await expect(importKek("", "INTEGRATIONS_KEK")).rejects.toThrow(/missing its INTEGRATIONS_KEK/);
    await expect(importKek(toBase64url(new Uint8Array(16)), "INTEGRATIONS_KEK")).rejects.toThrow(
      "the integrations Worker's INTEGRATIONS_KEK binding is not 32 bytes of base64url",
    );
    await expect(importKek("not base64url!", "INTEGRATIONS_KEK")).rejects.toThrow(/32 bytes/);
  });
});

describe("a sealed row", () => {
  it("round-trips under its table generation's key", async () => {
    const key = await rowKey(newDataKey(), "collection_entries", 1);
    const blob = await sealRow(key, "collection_entries", ROW);
    expect(await openRow(key, "collection_entries", "u-1", blob)).toEqual(ROW);
  });

  it("does not hold its text in the clear", async () => {
    const key = await rowKey(newDataKey(), "collection_entries", 1);
    const blob = await sealRow(key, "collection_entries", ROW);
    const asText = new TextDecoder("latin1").decode(blob);
    expect(asText).not.toContain("prerelease");
    expect(asText).not.toContain("Lightning");
    // A fresh nonce each time: the same row sealed twice is two different blobs.
    expect(await sealRow(key, "collection_entries", ROW)).not.toEqual(blob);
  });

  it("opens only as the row, the table and the generation it was sealed as", async () => {
    const dataKey = newDataKey();
    const key = await rowKey(dataKey, "collection_entries", 1);
    const blob = await sealRow(key, "collection_entries", ROW);
    // Moved to another row's uid, or another table: the associated data refuses it.
    await expect(openRow(key, "collection_entries", "u-2", blob)).rejects.toThrow();
    await expect(openRow(key, "wishlist_entries", "u-1", blob)).rejects.toThrow();
    // Another generation's key, or another table's, from the same data key.
    const later = await rowKey(dataKey, "collection_entries", 2);
    await expect(openRow(later, "collection_entries", "u-1", blob)).rejects.toThrow();
    const wishlist = await rowKey(dataKey, "wishlist_entries", 1);
    await expect(openRow(wishlist, "collection_entries", "u-1", blob)).rejects.toThrow();
  });
});

describe("base64url", () => {
  it("round-trips, padded or not, and refuses what is not it", () => {
    const bytes = new Uint8Array([0, 251, 255, 1, 2]);
    expect(fromBase64url(toBase64url(bytes))).toEqual(bytes);
    expect(toBase64url(bytes)).not.toMatch(/[+/=]/);
    expect(fromBase64url(`${toBase64url(bytes)}=`)).toEqual(bytes);
    expect(fromBase64url("a")).toBeNull();
    expect(fromBase64url("no spaces")).toBeNull();
  });
});

describe("a name, as the clear column keeps it", () => {
  it("is lower case, without its marks, with its whitespace collapsed", () => {
    expect(normaliseName("Lim-Dûl's Vault")).toBe("lim-dul's vault");
    expect(normaliseName("  LIM-DUL'S \t VAULT ")).toBe("lim-dul's vault");
    expect(normaliseName("Æther Vial")).toBe("æther vial");
    expect(normaliseName("Jötun Grunt")).toBe("jotun grunt");
    // NFKD: a compatibility form is its plain letters.
    expect(normaliseName("ﬁre // ice")).toBe("fire // ice");
  });
});
