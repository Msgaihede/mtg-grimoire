#!/usr/bin/env node
/**
 * Signs what the in-app updater downloads, and makes the key that does it.
 *
 *   node scripts/update-signing.mjs keygen <secret-out-path>
 *   UPDATE_SIGNING_KEY=… node scripts/update-signing.mjs sign <file> --trusted-comment "<text>"
 *
 * **The signatures are real minisign, prehashed** — the format `minisign -Vm` and the
 * `minisign-verify` crate in `src-tauri` both read — produced with `node:crypto` and `node:fs`
 * and nothing else. Dependency-free for `ci-route.mjs`'s reason and a sharper one: the release
 * workflow's `sign` job runs this with **no `npm ci`**, because that job holds the signing secret
 * and an install script is somebody else's code. See `.github/workflows/release.yml`.
 *
 * **Why the updater needs it at all.** `update.rs` used to check only GitHub's upload `digest`,
 * which says the bytes arrived as they were uploaded and nothing about who uploaded them — a
 * hijacked action or a leaked token re-uploads a trojaned zip and GitHub computes it a valid
 * digest. A signature from a key that never leaves the repository's secrets is what says who.
 *
 * ## Formats
 *
 * **The secret** is one base64 line encoding `keyid(8) || seed(32)` — 40 bytes, 56 characters —
 * and is this script's own format, not minisign's (minisign's secret key file is scrypt-wrapped
 * and carries a checksum this has no use for). The seed is an Ed25519 private key as RFC 8032
 * defines it; the key id is eight random bytes minisign uses to tell keys apart. It is what
 * `keygen` writes, mode 0600, and what the `UPDATE_SIGNING_KEY` repository secret holds.
 *
 * **The public key** is minisign's: `base64("Ed" || keyid || pk32)`, 56 characters, preceded in a
 * `.pub` file by `untrusted comment: minisign public key <KEYID>`. The key id in that comment is
 * the eight bytes read as a **little-endian** integer and printed as upper-case hex, which is what
 * minisign itself prints — so the bytes are reversed, and `update-signing.test.mjs` pins that
 * against the key `minisign-verify` documents.
 *
 * **A signature** is minisign's prehashed form, four lines:
 *
 *   untrusted comment: <anything — nothing checks it>
 *   base64("ED" || keyid || Ed25519(BLAKE2b-512(file)))
 *   trusted comment: <text>
 *   base64(Ed25519(signature64 || text))          ← the "global" signature
 *
 * The global signature is what makes the trusted comment trusted: it signs the file's signature
 * together with the comment, so neither can be swapped for another's. **`update.rs` requires the
 * comment to be exactly `mtg-grimoire <version> <kind>`** — `kind` is `portable` or `nsis` — which
 * is what stops someone who can upload assets but cannot sign from replaying an older release's
 * validly signed build under a newer version, or the installer's signature over the zip.
 *
 * Ed25519 is deterministic, so one key, one file and one comment always give byte-identical
 * output — which is what lets a committed fixture be a fence between this signer and the Rust
 * verifier. `sign`'s `legacy` option exists only so that fence can prove the verifier refuses
 * minisign's older un-prehashed `Ed` form; the command line never asks for it.
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign as ed25519,
} from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** The environment variable `sign` reads the secret from — the repository secret's name too. */
export const SECRET_ENV = "UPDATE_SIGNING_KEY";

const KEY_ID_BYTES = 8;
const SEED_BYTES = 32;

/**
 * DER wrappers for a bare Ed25519 key. `node:crypto` takes a private key only as PKCS#8 or JWK,
 * and PKCS#8 for Ed25519 is this fixed 16-byte header in front of the 32-byte seed (RFC 8410);
 * an SPKI public key is a fixed 12-byte header in front of the 32 raw bytes.
 */
const PKCS8_ED25519 = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_ED25519 = Buffer.from("302a300506032b6570032100", "hex");

/** A failure this script can put in one sentence. */
class Refusal extends Error {}

/** A fresh secret: eight random bytes of key id and a random 32-byte Ed25519 seed. */
export function generateSecret() {
  return { keyId: randomBytes(KEY_ID_BYTES), seed: randomBytes(SEED_BYTES) };
}

/** `{ keyId, seed }` → the one base64 line `keygen` writes and `UPDATE_SIGNING_KEY` holds. */
export function encodeSecret({ keyId, seed }) {
  return Buffer.concat([keyId, seed]).toString("base64");
}

/**
 * The line back into `{ keyId, seed }`. **Re-encoded and compared**, because Node's base64
 * decoder skips characters it does not know rather than refusing them, so a secret pasted with a
 * stray character would otherwise decode to a *different* key and sign with it.
 */
export function parseSecret(text) {
  const line = String(text).trim();
  const raw = Buffer.from(line, "base64");
  if (raw.length !== KEY_ID_BYTES + SEED_BYTES || raw.toString("base64") !== line) {
    throw new Refusal(
      `${SECRET_ENV} is not a secret this script made: expected one base64 line of ` +
        `${KEY_ID_BYTES + SEED_BYTES} bytes (the output of \`keygen\`).`,
    );
  }
  return { keyId: raw.subarray(0, KEY_ID_BYTES), seed: raw.subarray(KEY_ID_BYTES) };
}

function privateKey(seed) {
  return createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519, seed]),
    format: "der",
    type: "pkcs8",
  });
}

/** The key id as minisign prints it: the eight bytes as a little-endian integer, upper-case hex. */
export function keyIdHex(keyId) {
  return Buffer.from(keyId).reverse().toString("hex").toUpperCase();
}

/** The minisign public key line, `base64("Ed" || keyid || pk32)` — what `update.rs` compiles in. */
export function publicKey({ keyId, seed }) {
  const spki = createPublicKey(privateKey(seed)).export({ format: "der", type: "spki" });
  if (!spki.subarray(0, SPKI_ED25519.length).equals(SPKI_ED25519)) {
    throw new Error(
      "node:crypto exported an Ed25519 public key in a shape this script does not know",
    );
  }
  return Buffer.concat([Buffer.from("Ed"), keyId, spki.subarray(SPKI_ED25519.length)]).toString(
    "base64",
  );
}

/** A minisign `.pub` file: the untrusted comment naming the key id, then the key. */
export function publicKeyFile(secret) {
  return `untrusted comment: minisign public key ${keyIdHex(secret.keyId)}\n${publicKey(secret)}\n`;
}

/**
 * The `.minisig` text for `bytes`. Prehashed (`ED`) unless `legacy`, which only the test asks for.
 *
 * A trusted comment is one line of the file, so a line break in it is refused rather than
 * written: it would split the comment into a line the verifier reads as the global signature.
 */
export function sign(bytes, secret, trustedComment, { legacy = false } = {}) {
  if (
    typeof trustedComment !== "string" ||
    trustedComment === "" ||
    /[\r\n]/.test(trustedComment)
  ) {
    throw new Refusal("a trusted comment must be one non-empty line.");
  }
  const key = privateKey(secret.seed);
  const message = legacy ? bytes : createHash("blake2b512").update(bytes).digest();
  const signature = ed25519(null, message, key);
  const global = ed25519(
    null,
    Buffer.concat([signature, Buffer.from(trustedComment, "utf8")]),
    key,
  );
  return [
    `untrusted comment: mtg-grimoire update signature, key ${keyIdHex(secret.keyId)}`,
    Buffer.concat([Buffer.from(legacy ? "Ed" : "ED"), secret.keyId, signature]).toString("base64"),
    `trusted comment: ${trustedComment}`,
    global.toString("base64"),
    "",
  ].join("\n");
}

const USAGE = [
  "usage:",
  "  node scripts/update-signing.mjs keygen <secret-out-path>",
  `  ${SECRET_ENV}=… node scripts/update-signing.mjs sign <file> --trusted-comment "<text>"`,
].join("\n");

/**
 * `keygen`: writes the secret, **never prints it**, and prints the public key as a `.pub` file's
 * two lines on stdout — so `> key.pub` makes one — with what to do next on stderr.
 *
 * `wx`, so an existing file is never overwritten: a key file written over is a key gone, and a
 * key gone is every install built with its public half unable to verify another update.
 */
function keygen(args, io) {
  if (args.length !== 1) throw new Refusal(USAGE);
  const [out] = args;
  const secret = generateSecret();
  try {
    writeFileSync(out, `${encodeSecret(secret)}\n`, { mode: 0o600, flag: "wx" });
  } catch (err) {
    if (err?.code === "EEXIST")
      throw new Refusal(`${out} already exists; refusing to overwrite a key.`);
    throw err;
  }
  io.out(publicKeyFile(secret).trimEnd());
  io.err(
    [
      `Wrote the secret to ${out} (mode 0600). It is not printed, and it must never be committed.`,
      `Next: put the key line above into src-tauri/src/update.rs as SIGNING_PUBLIC_KEY, and the`,
      `secret file's one line into the repository secret ${SECRET_ENV} — in the order`,
      `docs/reference/in-app-updates.md gives, because a build only trusts the key compiled into it.`,
    ].join("\n"),
  );
}

/** `sign`: writes `<file>.minisig`. Refuses outright when the secret is not set. */
function signCommand(args, env, io) {
  const at = args.indexOf("--trusted-comment");
  const comment = at === -1 ? undefined : args[at + 1];
  const files = args.filter((_, i) => at === -1 || (i !== at && i !== at + 1));
  if (files.length !== 1 || comment === undefined) throw new Refusal(USAGE);
  const [file] = files;

  const text = env[SECRET_ENV] ?? "";
  if (text.trim() === "") {
    throw new Refusal(
      `${SECRET_ENV} is empty, so there is no key to sign ${file} with. Set the repository ` +
        `secret (docs/reference/in-app-updates.md); a release is never published unsigned.`,
    );
  }
  const secret = parseSecret(text);
  writeFileSync(`${file}.minisig`, sign(readFileSync(file), secret, comment));
  io.out(`signed ${file} with key ${keyIdHex(secret.keyId)}: trusted comment "${comment}"`);
}

/** The command line, with its environment and its output handed in so a test need not spawn. */
export function run(argv, env, io) {
  const [command, ...args] = argv;
  try {
    if (command === "keygen") keygen(args, io);
    else if (command === "sign") signCommand(args, env, io);
    else throw new Refusal(USAGE);
    return 0;
  } catch (err) {
    if (!(err instanceof Refusal)) throw err;
    io.err(err.message);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = run(process.argv.slice(2), process.env, {
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  });
}
