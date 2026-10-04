import { describe, expect, it, vi } from "vitest";
import {
  answerAsk,
  ASK_SOURCE,
  askPage,
  askPages,
  CLAIM,
  INSTALL_FAILED,
  installFailure,
  isClaim,
  reasonOf,
  isSkipWaiting,
  readReply,
  SKIP_WAITING,
  type Postable,
} from "./bridge";

const URI = { kind: "uri", uri: "https://cards.scryfall.io/large/front/a/b/abc.webp?1" } as const;

/** A page that answers each ask with `reply` — or, handed nothing, hears it and says nothing. */
function page(reply?: unknown) {
  const asked: unknown[] = [];
  const client: Postable = {
    postMessage(message, transfer) {
      asked.push(message);
      if (reply !== undefined) transfer[0].postMessage(reply);
      else transfer[0].close();
    },
  };
  return { client, asked };
}

describe("the strings on the wire", () => {
  it("are pinned: a renamed kind is silence on the far side, not a type error", () => {
    expect(ASK_SOURCE).toBe("grimoire:picture-source");
    expect(SKIP_WAITING).toBe("grimoire:skip-waiting");
  });

  it("knows a page asking to be taken from the reader's press — the press must be nothing else", () => {
    expect(CLAIM).toBe("grimoire:claim");
    expect(isClaim({ kind: CLAIM })).toBe(true);
    expect(isClaim({ kind: SKIP_WAITING })).toBe(false);
    expect(isSkipWaiting({ kind: CLAIM })).toBe(false);
  });

  it("carries a failed install's reason, and reads no other message as one", () => {
    expect(INSTALL_FAILED).toBe("grimoire:install-failed");
    expect(installFailure({ kind: INSTALL_FAILED, reason: "UnknownError: Unexpected internal error" }))
      .toBe("UnknownError: Unexpected internal error");
    // A failure with no reason it could put into words is still a failure.
    expect(installFailure({ kind: INSTALL_FAILED })).toBe("");
    for (const data of [null, "grimoire:install-failed", {}, { kind: SKIP_WAITING }, { kind: ASK_SOURCE, path: "/display/a/0" }]) {
      expect(installFailure(data)).toBeNull();
    }
    expect(reasonOf(new TypeError("Failed to fetch"))).toBe("TypeError: Failed to fetch");
    expect(reasonOf("/assets/x.js answered 404")).toBe("/assets/x.js answered 404");
  });

  it("knows the reader's press from every other message", () => {
    expect(isSkipWaiting({ kind: SKIP_WAITING })).toBe(true);
    for (const data of [null, undefined, "grimoire:skip-waiting", {}, { kind: "skipWaiting" },
      { type: "SKIP_WAITING" }]) {
      expect(isSkipWaiting(data)).toBe(false);
    }
  });
});

describe("asking a page where a picture is", () => {
  it("sends the protocol path and hears the engine's answer", async () => {
    const { client, asked } = page({ kind: "source", source: URI });
    await expect(askPage(client, "/display/abc/0", 1_000)).resolves.toEqual({
      kind: "source",
      source: URI,
    });
    expect(asked).toEqual([{ kind: ASK_SOURCE, path: "/display/abc/0" }]);
  });

  it("hears a refusal as one, with the page's sentence", async () => {
    const { client } = page({ kind: "refused", message: "Already open in another tab." });
    await expect(askPage(client, "/display/abc/0", 1_000)).resolves.toEqual({
      kind: "refused",
      message: "Already open in another tab.",
    });
  });

  it("gives up on a page that never answers, after its bound and not before", async () => {
    vi.useFakeTimers();
    try {
      const { client } = page();
      const settled = vi.fn();
      void askPage(client, "/display/abc/0", 20_000).then(settled);
      await vi.advanceTimersByTimeAsync(19_999);
      expect(settled).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toHaveBeenCalledWith({ kind: "silent" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not wait at all for a page that is gone by the time it is asked", async () => {
    const gone: Postable = {
      postMessage() {
        throw new Error("the client is gone");
      },
    };
    await expect(askPage(gone, "/display/abc/0", 60_000)).resolves.toEqual({ kind: "silent" });
  });

  it("reads an answer nobody can read as a refusal, so the ask still settles", () => {
    for (const data of [null, "source", {}, { kind: "source" }, { kind: "source", source: {} },
      { kind: "source", source: { kind: "uri" } }]) {
      expect(readReply(data).kind).toBe("refused");
    }
  });
});

describe("asking the pages in turn", () => {
  it("has nobody to ask when there is no page", async () => {
    await expect(askPages([], "/display/abc/0", 10)).resolves.toEqual({ kind: "nobody" });
  });

  it("goes past a page that refuses — a second tab — to the one that holds the engine", async () => {
    const second = page({ kind: "refused", message: "Already open in another tab." });
    const first = page({ kind: "source", source: URI });
    await expect(askPages([second.client, first.client], "/display/abc/0", 1_000)).resolves.toEqual({
      kind: "source",
      source: URI,
    });
  });

  it("stops at a page that is silent: a second full wait would outlast every frame", async () => {
    const silent = page();
    const next = page({ kind: "source", source: URI });
    await expect(askPages([silent.client, next.client], "/display/abc/0", 5)).resolves.toEqual({
      kind: "silent",
    });
    expect(next.asked).toEqual([]);
  });

  it("answers the last refusal when every page refused", async () => {
    const a = page({ kind: "refused", message: "one" });
    const b = page({ kind: "refused", message: "two" });
    await expect(askPages([a.client, b.client], "/display/abc/0", 1_000)).resolves.toEqual({
      kind: "refused",
      message: "two",
    });
  });
});

describe("the page's half", () => {
  /** One message as the page hears it, and what was posted back on its port. */
  function heard(data: unknown) {
    const replies: unknown[] = [];
    return { event: { data, ports: [{ postMessage: (m: unknown) => void replies.push(m) }] }, replies };
  }

  it("asks its core for the path and posts the answer back on the ask's own port", async () => {
    const { event, replies } = heard({ kind: ASK_SOURCE, path: "/display/abc/0" });
    const lookup = vi.fn(async () => URI);
    expect(answerAsk(event, lookup)).toBe(true);
    await vi.waitFor(() => expect(replies).toEqual([{ kind: "source", source: URI }]));
    expect(lookup).toHaveBeenCalledWith("/display/abc/0");
  });

  it("answers a core that refuses with the refusal — a bare string, as a core rejects with", async () => {
    const { event, replies } = heard({ kind: ASK_SOURCE, path: "/display/abc/0" });
    answerAsk(event, () => Promise.reject("There is no command named card_image_source on this host."));
    await vi.waitFor(() =>
      expect(replies).toEqual([
        { kind: "refused", message: "There is no command named card_image_source on this host." },
      ]),
    );
  });

  it("answers an engine that said something unreadable as a refusal, not as silence", async () => {
    const { event, replies } = heard({ kind: ASK_SOURCE, path: "/display/abc/0" });
    answerAsk(event, async () => ({ uri: "https://cards.scryfall.io/a.webp" }));
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    expect(replies[0]).toMatchObject({ kind: "refused" });
  });

  it("leaves every other message alone", () => {
    const lookup = vi.fn(async () => URI);
    for (const data of [null, "hello", { kind: "something-else" }, { kind: ASK_SOURCE },
      { kind: ASK_SOURCE, path: 7 }]) {
      expect(answerAsk(heard(data).event, lookup)).toBe(false);
    }
    expect(lookup).not.toHaveBeenCalled();
  });

  it("does not throw when the worker has stopped listening", async () => {
    const lookup = vi.fn(async () => URI);
    const event = {
      data: { kind: ASK_SOURCE, path: "/display/abc/0" },
      ports: [
        {
          postMessage() {
            throw new Error("the port is closed");
          },
        },
      ],
    };
    expect(answerAsk(event, lookup)).toBe(true);
    await vi.waitFor(() => expect(lookup).toHaveBeenCalled());
  });
});
