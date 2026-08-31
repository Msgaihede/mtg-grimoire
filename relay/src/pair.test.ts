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

  /**
   * ⚠️ **No link into the app, of either kind.** This page carried an `intent://` button for part
   * of a day; nothing in the app declares that scheme or reads the `S.code` extra it carried, so
   * it was dead — and the App Link meant to replace it would have been worse than dead, taking
   * `https://…/pair#<code>` away from the browser and handing it to an app that reads no launch
   * intent. Copying the code is what this page is for. Re-adding a link is a change to the app
   * first; this assertion is what makes the shortcut go red.
   */
  it("offers no link into the app, because the app cannot read one", async () => {
    const body = await handlePair(env).text();
    expect(body).not.toContain("intent://");
    expect(body).not.toContain("mtggrimoire");
    expect(body).toContain("Copy the code");
  });
});
