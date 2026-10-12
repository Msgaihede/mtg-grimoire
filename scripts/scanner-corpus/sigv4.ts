// AWS Signature Version 4, the header form — what R2's S3 API takes. Small enough to hold
// here rather than bring a dependency for four kinds of request; `sigv4.test.ts` holds it to
// AWS's own published vector.

import { createHash, createHmac } from "node:crypto";

export type SignedRequest = {
  method: string;
  url: URL;
  /** Every header to sign bar `host`, which is read from the URL. Must hold `x-amz-date`. */
  headers: Record<string, string>;
  /** SHA-256 of the body, in hex. */
  payloadHash: string;
};

const hex = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
const hmac = (key: string | Uint8Array, data: string) => createHmac("sha256", key).update(data).digest();

/** RFC 3986, as SigV4 wants it: everything but unreserved characters, `/` kept in a path. */
function encode(text: string, keepSlash: boolean): string {
  const out = encodeURIComponent(text).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return keepSlash ? out.replaceAll("%2F", "/") : out;
}

/** `20150830T123600Z`. */
export function amzDate(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

export function sha256Hex(body: Uint8Array): string {
  return hex(body);
}

/** The `Authorization` header's value. */
export function sign(
  request: SignedRequest,
  creds: { accessKeyId: string; secretAccessKey: string },
  scope: { region: string; service: string },
  now: Date,
): string {
  const stamp = amzDate(now);
  const day = stamp.slice(0, 8);
  const headers: [string, string][] = Object.entries({ ...request.headers, host: request.url.host })
    .map(([name, value]): [string, string] => [name.toLowerCase(), value.trim()])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const signed = headers.map(([name]) => name).join(";");
  const query = [...request.url.searchParams]
    .map(([k, v]) => `${encode(k, false)}=${encode(v, false)}`)
    .sort()
    .join("&");
  const canonical = [
    request.method,
    encode(decodeURIComponent(request.url.pathname), true),
    query,
    ...headers.map(([name, value]) => `${name}:${value}`),
    "",
    signed,
    request.payloadHash,
  ].join("\n");
  const credential = `${day}/${scope.region}/${scope.service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", request.headers["x-amz-date"] ?? stamp, credential, hex(canonical)].join("\n");
  const key = [scope.region, scope.service, "aws4_request"].reduce<Uint8Array>(
    (k, part) => hmac(k, part),
    hmac(`AWS4${creds.secretAccessKey}`, day),
  );
  const signature = createHmac("sha256", key).update(toSign).digest("hex");
  return `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${credential}, SignedHeaders=${signed}, Signature=${signature}`;
}
