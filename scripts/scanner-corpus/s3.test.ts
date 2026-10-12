import { describe, expect, it } from "vitest";
import { createS3, type Fetch } from "./s3.ts";

const config = { accountId: "acct", accessKeyId: "A", secretAccessKey: "S" };
const page = (keys: [string, number][], next?: string) =>
  `<?xml version="1.0"?><ListBucketResult>` +
  keys.map(([k, s]) => `<Contents><Key>${k}</Key><Size>${s}</Size></Contents>`).join("") +
  (next ? `<IsTruncated>true</IsTruncated><NextContinuationToken>${next}</NextContinuationToken>` : `<IsTruncated>false</IsTruncated>`) +
  `</ListBucketResult>`;

function recorded(answers: (url: string) => { status: number; body: string | Uint8Array }) {
  const calls: { url: string; method: string; headers: Record<string, string>; body?: Uint8Array }[] = [];
  const fetch: Fetch = async (url, init) => {
    calls.push({ url, ...init });
    const { status, body } = answers(url);
    const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
    return {
      status,
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      text: async () => new TextDecoder().decode(bytes),
    };
  };
  return { calls, fetch };
}

describe("s3", () => {
  it("reads every page of a listing", async () => {
    const { calls, fetch } = recorded((url) =>
      url.includes("continuation-token=t2")
        ? { status: 200, body: page([["runs/c.bin", 3]]) }
        : { status: 200, body: page([["runs/a.bin", 1], ["runs/b&amp;.bin", 2]], "t2") },
    );
    const entries = await createS3(config, fetch).list("bucket", "runs/");
    expect(entries).toEqual([
      { key: "runs/a.bin", size: 1 },
      { key: "runs/b&.bin", size: 2 },
      { key: "runs/c.bin", size: 3 },
    ]);
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe("https://acct.r2.cloudflarestorage.com/bucket?list-type=2&prefix=runs%2F");
    expect(calls[0].headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=A\/\d{8}\/auto\/s3\/aws4_request/);
  });

  it("gets, puts and removes an object by its key", async () => {
    const { calls, fetch } = recorded(() => ({ status: 200, body: new Uint8Array([1, 2, 3]) }));
    const s3 = createS3(config, fetch);
    expect(await s3.get("b", "runs/a.bin")).toEqual(new Uint8Array([1, 2, 3]));
    await s3.put("b", "labels/a.json", new Uint8Array([9]));
    await s3.remove("b", "runs/a.bin");
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      "GET /b/runs/a.bin",
      "PUT /b/labels/a.json",
      "DELETE /b/runs/a.bin",
    ]);
    expect(calls[1].body).toEqual(new Uint8Array([9]));
  });

  it("refuses a truncated page that names no continuation token", async () => {
    const { fetch } = recorded(() => ({
      status: 200,
      body: `<ListBucketResult><Contents><Key>runs/a.bin</Key><Size>1</Size></Contents><IsTruncated>true</IsTruncated></ListBucketResult>`,
    }));
    await expect(createS3(config, fetch).list("b", "runs/")).rejects.toThrow(
      "GET b/runs/*: a truncated listing with no continuation token",
    );
  });

  it("refuses a 200 that is not a bucket listing", async () => {
    const { fetch } = recorded(() => ({ status: 200, body: "<html>captive portal</html>" }));
    await expect(createS3(config, fetch).list("bucket", "runs/")).rejects.toThrow(
      "GET bucket/runs/*: not a bucket listing",
    );
  });

  it("names the bucket, the key and the status of a refusal", async () => {
    const { fetch } = recorded(() => ({ status: 403, body: "<Error><Code>AccessDenied</Code></Error>" }));
    await expect(createS3(config, fetch).get("b", "runs/a.bin")).rejects.toThrow("GET b/runs/a.bin: 403 AccessDenied");
  });
});
