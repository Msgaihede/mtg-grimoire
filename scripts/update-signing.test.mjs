// The update signer against the files the Rust verifier is proven against.
//
// **One committed artifact, two languages.** `src-tauri/tests/fixtures/update-signing/` holds a
// zip, a setup, their signatures and three hostile ones, all made by `update-signing.mjs`; the
// Rust suite (`update::tests`) verifies every one of them and refuses the hostile three. This file
// re-signs the same bytes with the same secret and asserts **byte equality** — Ed25519 is
// deterministic, so any change to what this script writes, however small, goes red here before a
// release signs anything with it. Change the format on purpose and both suites must move together.
//
// ⚠️ **`throwaway-test-key.secret` is a THROWAWAY TEST KEY and nothing trusts it.** It is committed
// so the fence above can exist. No build compiles its public half in — `update.rs`'s
// `SIGNING_PUBLIC_KEY` is the only key a build trusts, and its secret is a repository secret.
//
// Under the suite's `jsdom` environment like every other file here: vitest's per-file pragma for
// the `node` environment fails in `src/test-setup.ts`, which reads `document` — and a pragma is
// found anywhere in a comment, so this one does not spell it. That costs nothing, because every
// byte below is a Node `Buffer` and never a realm-crossing `Uint8Array`.
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  SECRET_ENV,
  encodeSecret,
  generateSecret,
  keyIdHex,
  parseSecret,
  publicKey,
  publicKeyFile,
  run,
  sign,
} from "./update-signing.mjs";

// From the string rather than through `new URL`, which under `jsdom` is jsdom's class and not one
// `fileURLToPath` accepts.
const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  "../src-tauri/tests/fixtures/update-signing",
);
const fixture = (name) => readFileSync(join(FIXTURES, name));
const SECRET_TEXT = fixture("throwaway-test-key.secret").toString("utf8");
const SECRET = parseSecret(SECRET_TEXT);

const ZIP = "mtg-grimoire-9.9.9-windows-x64-portable.zip";
const SETUP = "MTG.Grimoire_9.9.9_x64-setup.exe";

/** Output captured the way `run` hands it out. */
function capture() {
  const out = [];
  const err = [];
  return { out, err, io: { out: (l) => out.push(l), err: (l) => err.push(l) } };
}

const temps = [];
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "update-signing-"));
  temps.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the fixtures the Rust verifier is proven against", () => {
  it("names the test key's public half exactly as the committed .pub file does", () => {
    expect(publicKeyFile(SECRET)).toBe(fixture("throwaway-test-key.pub").toString("utf8"));
  });

  // [signature file, the file it signs, its trusted comment, legacy form]
  it.each([
    [`${ZIP}.minisig`, ZIP, "mtg-grimoire 9.9.9 portable", false],
    [`${SETUP}.minisig`, SETUP, "mtg-grimoire 9.9.9 nsis", false],
    // The downgrade: our key, our bytes, an older release named.
    ["portable-signed-for-9.9.8.minisig", ZIP, "mtg-grimoire 9.9.8 portable", false],
    // The installer's comment over the zip.
    ["portable-signed-as-nsis.minisig", ZIP, "mtg-grimoire 9.9.9 nsis", false],
    // minisign's un-prehashed form, which the verifier refuses however valid.
    ["portable-legacy.minisig", ZIP, "mtg-grimoire 9.9.9 portable", true],
  ])("re-signs %s byte for byte", (sigName, signed, comment, legacy) => {
    expect(sign(fixture(signed), SECRET, comment, { legacy })).toBe(
      fixture(sigName).toString("utf8"),
    );
  });

  it("is what the command line writes, beside the file it signs", () => {
    const dir = tempDir();
    writeFileSync(join(dir, ZIP), fixture(ZIP));
    const { io, out } = capture();
    const code = run(
      ["sign", join(dir, ZIP), "--trusted-comment", "mtg-grimoire 9.9.9 portable"],
      { [SECRET_ENV]: SECRET_TEXT },
      io,
    );
    expect(code).toBe(0);
    expect(readFileSync(join(dir, `${ZIP}.minisig`), "utf8")).toBe(
      fixture(`${ZIP}.minisig`).toString("utf8"),
    );
    expect(out.join("\n")).toContain(keyIdHex(SECRET.keyId));
  });
});

describe("the formats", () => {
  // `minisign-verify` documents this key with this comment. The id is the eight bytes read as a
  // little-endian integer, so a byte order that looked right and was not would show here first.
  it("prints a key id the way minisign does", () => {
    const key = Buffer.from("RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3", "base64");
    expect(keyIdHex(key.subarray(2, 10))).toBe("E7620F1842B4E81F");
  });

  // RFC 8032 §7.1, test 1: the seed, its public key, and its signature of the empty message. The
  // legacy form signs the message itself, so its signature is the RFC's byte for byte — which pins
  // the PKCS#8 wrapping of a raw seed as well as the arithmetic.
  it("is plain Ed25519 from a raw seed", () => {
    const secret = {
      keyId: Buffer.alloc(8),
      seed: Buffer.from("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60", "hex"),
    };
    const pk = Buffer.from(publicKey(secret), "base64");
    expect(pk.subarray(0, 2).toString()).toBe("Ed");
    expect(pk.subarray(10).toString("hex")).toBe(
      "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
    );
    const line = sign(Buffer.alloc(0), secret, "x", { legacy: true }).split("\n")[1];
    expect(Buffer.from(line, "base64").subarray(10).toString("hex")).toBe(
      "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b",
    );
  });

  it("round-trips a secret and refuses one with a character it would silently skip", () => {
    const secret = generateSecret();
    const text = encodeSecret(secret);
    expect(text).toHaveLength(56);
    expect(parseSecret(`${text}\n`)).toEqual(secret);
    expect(() => parseSecret(`${text.slice(0, 20)}*${text.slice(20)}`)).toThrow(/not a secret/);
    expect(() => parseSecret(text.slice(4))).toThrow(/not a secret/);
  });

  it("signs deterministically, in the prehashed form, and never across a line break", () => {
    const bytes = fixture(ZIP);
    const once = sign(bytes, SECRET, "mtg-grimoire 9.9.9 portable");
    expect(sign(bytes, SECRET, "mtg-grimoire 9.9.9 portable")).toBe(once);
    expect(Buffer.from(once.split("\n")[1], "base64").subarray(0, 2).toString()).toBe("ED");
    expect(() => sign(bytes, SECRET, "mtg-grimoire 9.9.9\nportable")).toThrow(/one non-empty line/);
    expect(() => sign(bytes, SECRET, "")).toThrow(/one non-empty line/);
  });
});

describe("the command line", () => {
  // The release workflow's fail-safe: a run with no secret fails the `sign` job, and `publish`
  // needs it, so the draft never goes public unsigned.
  it.each([[{}], [{ [SECRET_ENV]: "" }], [{ [SECRET_ENV]: "  \n" }]])(
    "refuses to sign when the secret is unset (%j), and writes nothing",
    (env) => {
      const dir = tempDir();
      writeFileSync(join(dir, ZIP), fixture(ZIP));
      const { io, err } = capture();
      expect(run(["sign", join(dir, ZIP), "--trusted-comment", "x"], env, io)).toBe(1);
      expect(err.join("\n")).toContain(`${SECRET_ENV} is empty`);
      expect(() => statSync(join(dir, `${ZIP}.minisig`))).toThrow();
    },
  );

  it("refuses a sign with no trusted comment, or a secret it did not make", () => {
    const dir = tempDir();
    writeFileSync(join(dir, ZIP), fixture(ZIP));
    const env = { [SECRET_ENV]: SECRET_TEXT };
    expect(run(["sign", join(dir, ZIP)], env, capture().io)).toBe(1);
    expect(run(["sign", join(dir, ZIP), "--trusted-comment"], env, capture().io)).toBe(1);
    const { io, err } = capture();
    const bad = { [SECRET_ENV]: "not a key" };
    expect(run(["sign", join(dir, ZIP), "--trusted-comment", "x"], bad, io)).toBe(1);
    expect(err.join("\n")).toContain("not a secret this script made");
  });

  it("writes a key it never prints, and never over an existing one", () => {
    const path = join(tempDir(), "update.secret");
    const { io, out, err } = capture();
    expect(run(["keygen", path], {}, io)).toBe(0);

    const written = readFileSync(path, "utf8");
    const secret = parseSecret(written);
    // stdout is exactly a `.pub` file, so `> key.pub` makes one.
    expect(`${out.join("\n")}\n`).toBe(publicKeyFile(secret));
    const said = [...out, ...err].join("\n");
    expect(said).not.toContain(written.trim());
    expect(said).not.toContain(secret.seed.toString("base64"));
    // Mode bits are a POSIX fact; Windows has none to read back.
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);

    const again = capture();
    expect(run(["keygen", path], {}, again.io)).toBe(1);
    expect(again.err.join("\n")).toContain("refusing to overwrite");
    expect(readFileSync(path, "utf8")).toBe(written);
  });
});
