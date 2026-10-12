// The four S3 calls the corpus sync makes of R2: list a prefix, and get, put and delete an
// object. `fetch` is handed in, so the suite never opens a socket.

import { amzDate, sha256Hex, sign } from "./sigv4.ts";

export type Fetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: Uint8Array },
) => Promise<{ status: number; arrayBuffer(): Promise<ArrayBuffer>; text(): Promise<string> }>;

export type Entry = { key: string; size: number };
export type S3Config = { accountId: string; accessKeyId: string; secretAccessKey: string };
export type S3 = ReturnType<typeof createS3>;

const NONE = new Uint8Array(0);
const unescape = (text: string) =>
  text.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&apos;", "'").replaceAll("&amp;", "&");
const path = (bucket: string, key: string) => `/${bucket}/${key.split("/").map(encodeURIComponent).join("/")}`;

export function createS3(config: S3Config, fetch: Fetch, now: () => Date = () => new Date()) {
  const origin = `https://${config.accountId}.r2.cloudflarestorage.com`;

  async function call(method: string, url: URL, what: string, body: Uint8Array = NONE) {
    const at = now();
    const payloadHash = sha256Hex(body);
    const headers: Record<string, string> = { "x-amz-date": amzDate(at), "x-amz-content-sha256": payloadHash };
    headers.authorization = sign({ method, url, headers, payloadHash }, config, { region: "auto", service: "s3" }, at);
    const answer = await fetch(url.href, { method, headers, ...(body.length ? { body } : {}) });
    if (answer.status >= 300) {
      const code = /<Code>([^<]*)<\/Code>/.exec(await answer.text())?.[1] ?? "";
      throw new Error(`${method} ${what}: ${answer.status} ${code}`.trim());
    }
    return answer;
  }

  return {
    /** Every object under a prefix, every page. */
    async list(bucket: string, prefix: string): Promise<Entry[]> {
      const entries: Entry[] = [];
      let token: string | null = null;
      do {
        const url = new URL(`${origin}/${bucket}`);
        url.searchParams.set("list-type", "2");
        url.searchParams.set("prefix", prefix);
        if (token) url.searchParams.set("continuation-token", token);
        const what = `${bucket}/${prefix}*`;
        const xml = await (await call("GET", url, what)).text();
        if (!xml.includes("<ListBucketResult")) throw new Error(`GET ${what}: not a bucket listing`);
        for (const [, key, size] of xml.matchAll(/<Contents>.*?<Key>([^<]*)<\/Key>.*?<Size>(\d+)<\/Size>.*?<\/Contents>/gs)) {
          entries.push({ key: unescape(key), size: Number(size) });
        }
        token = /<NextContinuationToken>([^<]*)<\/NextContinuationToken>/.exec(xml)?.[1] ?? null;
        if (token) token = unescape(token);
        else if (xml.includes("<IsTruncated>true</IsTruncated>")) {
          throw new Error(`GET ${what}: a truncated listing with no continuation token`);
        }
      } while (token);
      return entries;
    },
    async get(bucket: string, key: string): Promise<Uint8Array> {
      const answer = await call("GET", new URL(origin + path(bucket, key)), `${bucket}/${key}`);
      return new Uint8Array(await answer.arrayBuffer());
    },
    async put(bucket: string, key: string, body: Uint8Array): Promise<void> {
      await call("PUT", new URL(origin + path(bucket, key)), `${bucket}/${key}`, body);
    },
    async remove(bucket: string, key: string): Promise<void> {
      await call("DELETE", new URL(origin + path(bucket, key)), `${bucket}/${key}`);
    },
  };
}
