import { describe, expect, it } from "vitest";
import { handlePair } from "./pair";

const env = { RELAY_BASE: "https://relay.example" } as never;

describe("the /pair landing page", () => {
  it("is HTML", async () => {
    const r = handlePair(env);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/html");
  });

  it("never puts the code in the markup, because the Worker never sees it", async () => {
    const body = await handlePair(env).text();
    expect(body).toContain("location.hash");
    // The page reads the fragment in the browser. Nothing server-side can know it.
    expect(body).not.toContain("#</");
  });
});
