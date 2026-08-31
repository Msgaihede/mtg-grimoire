import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  bytesFromBase64,
  downloadFile,
  fileSize,
  suggestedArchiveName,
  ZIP_MIME,
} from "./backupArchive";

describe("bytesFromBase64", () => {
  /** **The one that would silently corrupt every archive.** `atob` answers code units, and a
   *  `Blob` built from that *string* would UTF-8 every byte above 0x7F into two — which is
   *  invisible to a test that only checks the file name and fatal to a zip. A zip's own magic
   *  number is ASCII; the bytes after it are not, so the fixture has to carry both. */
  it("keeps a byte above 0x7f as one byte", () => {
    // `PK\x03\x04` — a zip local file header — followed by two high bytes.
    const bytes = bytesFromBase64("UEsDBP+A");
    expect([...bytes]).toEqual([0x50, 0x4b, 0x03, 0x04, 0xff, 0x80]);
  });

  it("answers an empty array for an empty string", () => {
    expect(bytesFromBase64("").length).toBe(0);
  });

  /** The buffer is allocated rather than inferred, so the view is `Uint8Array<ArrayBuffer>` and
   *  `Blob` accepts it. A plain `new Uint8Array(n)` widens to `ArrayBufferLike` and is a `tsc`
   *  error naming `SharedArrayBuffer` — a type this code could not produce if it tried. */
  it("hands back a view over a plain ArrayBuffer", () => {
    expect(bytesFromBase64("QUJD").buffer).toBeInstanceOf(ArrayBuffer);
  });
});

describe("downloadFile", () => {
  const created: string[] = [];
  const revoked: string[] = [];
  let clicked = 0;

  beforeEach(() => {
    created.length = 0;
    revoked.length = 0;
    clicked = 0;
    vi.useFakeTimers();
    // jsdom implements neither, and its anchor `click` would try to navigate.
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn((blob: Blob) => {
        created.push(blob.type);
        return "blob:stub";
      }),
      revokeObjectURL: vi.fn((url: string) => void revoked.push(url)),
    });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {
      clicked += 1;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("clicks an anchor named after the file and takes it back out of the document", () => {
    downloadFile(bytesFromBase64("QUJD"), "mtg-grimoire-backup-2026-08-31.zip", ZIP_MIME);
    expect(clicked).toBe(1);
    expect(created).toEqual([ZIP_MIME]);
    // Nothing is left behind: an anchor still in the tree would be a tab stop pointing at a URL
    // that is about to be revoked.
    expect(document.querySelector("a[download]")).toBeNull();
  });

  /** **The trap this function exists for.** Revoking in the same task as the click races the
   *  download it started — some browsers have not read the blob yet, and the reader gets a
   *  zero-byte file. The revoke has to be there, and it has to be later. */
  it("revokes the url in a later task, not in the one that clicked", () => {
    downloadFile(bytesFromBase64("QUJD"), "backup.zip", ZIP_MIME);
    expect(revoked).toEqual([]);
    vi.runAllTimers();
    expect(revoked).toEqual(["blob:stub"]);
  });
});

describe("suggestedArchiveName", () => {
  /** Sorts in a file manager, which `31/08/2026` does not — the same reason Rust's
   *  `archive_name` writes it this way round. */
  it("dates the file the way a folder sorts", () => {
    expect(suggestedArchiveName(new Date("2026-08-31T22:15:00Z"))).toBe(
      "mtg-grimoire-backup-2026-08-31.zip",
    );
  });
});

describe("fileSize", () => {
  it("writes small numbers plainly, because an archive that small is one that went wrong", () => {
    expect(fileSize(0)).toBe("0 bytes");
    expect(fileSize(999)).toBe("999 bytes");
  });

  /** Decimal units, because the reader is comparing this against Windows Explorer and that is
   *  where they will actually look. */
  it("climbs in thousands and keeps one decimal below ten", () => {
    expect(fileSize(1_000)).toBe("1.0 kB");
    expect(fileSize(340_000)).toBe("340 kB");
    expect(fileSize(1_437_000)).toBe("1.4 MB");
    expect(fileSize(12_000_000)).toBe("12 MB");
    expect(fileSize(3_200_000_000)).toBe("3.2 GB");
  });

  /** A number the backend could not have produced still has to draw something, and an em dash
   *  says "not known" where `NaN bytes` says the panel is broken. */
  it("answers a dash rather than NaN", () => {
    expect(fileSize(Number.NaN)).toBe("—");
    expect(fileSize(-1)).toBe("—");
  });
});
