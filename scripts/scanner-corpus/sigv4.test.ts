import { describe, expect, it } from "vitest";
import { amzDate, sign } from "./sigv4.ts";

const EMPTY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

describe("sigv4", () => {
  // AWS's own published vector, `get-vanilla` of the Signature Version 4 test suite.
  it("signs AWS's get-vanilla vector", () => {
    const now = new Date(Date.UTC(2015, 7, 30, 12, 36, 0));
    expect(amzDate(now)).toBe("20150830T123600Z");
    const header = sign(
      {
        method: "GET",
        url: new URL("https://example.amazonaws.com/"),
        headers: { "x-amz-date": amzDate(now) },
        payloadHash: EMPTY,
      },
      { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" },
      { region: "us-east-1", service: "service" },
      now,
    );
    expect(header).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, " +
        "SignedHeaders=host;x-amz-date, " +
        "Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
    );
  });

  it("sorts the query and the headers it signs", () => {
    const now = new Date(Date.UTC(2015, 7, 30, 12, 36, 0));
    const base = { method: "GET", payloadHash: EMPTY };
    const creds = { accessKeyId: "A", secretAccessKey: "S" };
    const scope = { region: "auto", service: "s3" };
    const one = sign(
      { ...base, url: new URL("https://h/b?prefix=runs%2F&list-type=2"), headers: { "x-amz-date": "d", "x-amz-content-sha256": EMPTY } },
      creds, scope, now,
    );
    const two = sign(
      { ...base, url: new URL("https://h/b?list-type=2&prefix=runs%2F"), headers: { "x-amz-content-sha256": EMPTY, "x-amz-date": "d" } },
      creds, scope, now,
    );
    expect(one).toBe(two);
    expect(one).toContain("SignedHeaders=host;x-amz-content-sha256;x-amz-date");
  });
});
