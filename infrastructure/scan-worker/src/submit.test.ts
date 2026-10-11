import { afterEach, describe, expect, it, vi } from "vitest";
import { LABEL_HEADER } from "./cors";
import { MAX_FRAME_BYTES, MAX_LABEL_CHARS, MAX_PENDING } from "./env";
import { ADDRESS, inbox, jpeg, label, scan, untouchable } from "./fake";
import worker, { LIMIT } from "./index";
import { FULL_FOR_MS, type Sidecar } from "./submit";

/**
 * `POST /scan`, driven through the router.
 *
 * **Through `worker.fetch`, for `infrastructure/relay/src/ratelimit.test.ts`'s reason**: what is
 * fenced is *where* each check stands — the method ahead of the limiter, the limiter ahead of the
 * bucket, the headers ahead of the body — and a suite that called `handleSubmit` would pass with
 * the router calling it for every path and every method.
 *
 * **Every refusal is asserted with what it must not have cost beside it**: nothing stored, and
 * where the order says so, a bucket that would throw if it were touched at all.
 */

const ID = /^\d{8}T\d{6}Z-[0-9a-f]{16}$/;

async function refusal(response: Response): Promise<{ error: string; code?: string }> {
  return (await response.json()) as { error: string; code?: string };
}

describe("a scan the inbox takes", () => {
  it("stores the picture byte for byte and the label beside it, and answers the id", async () => {
    const box = inbox();
    const picture = jpeg(300);
    picture[299] = 0xd9;
    const before = Date.now();
    const response = await worker.fetch(scan({ body: picture }), box.env);
    const after = Date.now();

    expect(response.status).toBe(201);
    const { id } = (await response.json()) as { id: string };
    expect(id).toMatch(ID);

    expect([...box.objects.keys()].sort()).toEqual([`frames/${id}.jpg`, `labels/${id}.json`]);
    const frame = box.objects.get(`frames/${id}.jpg`);
    expect(frame?.bytes).toEqual(picture);
    expect(frame?.contentType).toBe("image/jpeg");

    const stored = box.objects.get(`labels/${id}.json`);
    expect(stored?.contentType).toBe("application/json");
    const sidecar = JSON.parse(new TextDecoder().decode(stored?.bytes)) as Sidecar;
    // The label as it was sent, and the three things only this side knows.
    expect(sidecar).toEqual({
      ...label(),
      id,
      received_at: sidecar.received_at,
      bytes: 300,
    });
    const received = Date.parse(sidecar.received_at);
    expect(received).toBeGreaterThanOrEqual(before);
    expect(received).toBeLessThanOrEqual(after);
    // The id leads with the same second, so a listing is in the order things arrived.
    expect(id.slice(0, 16)).toBe(
      sidecar.received_at.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z"),
    );
  });

  it("stores nothing that says who sent it", async () => {
    const box = inbox();
    const response = await worker.fetch(
      scan({ headers: { "user-agent": "MTGGrimoire/0.43.0", cookie: "session=abc" } }),
      box.env,
    );
    expect(response.status).toBe(201);
    const everything = [...box.objects.values()]
      .map((stored) => new TextDecoder().decode(stored.bytes))
      .join("\n");
    expect(everything).not.toContain(ADDRESS);
    expect(everything).not.toContain("MTGGrimoire/");
    expect(everything).not.toContain("session");
  });

  it("drops a key the label's shape does not have", async () => {
    // What is stored is rebuilt from what was checked: a sidecar cannot be made to carry a
    // string nobody validated.
    const box = inbox();
    const sent = { ...label(), note: "<script>", card: { ...label().card, owner: "someone" } };
    const response = await worker.fetch(scan({ label: sent }), box.env);
    const { id } = (await response.json()) as { id: string };
    const stored = new TextDecoder().decode(box.objects.get(`labels/${id}.json`)?.bytes);
    expect(stored).not.toContain("note");
    expect(stored).not.toContain("owner");
    expect(stored).not.toContain("script");
  });

  it("mints a new id for every submission, even of the same picture", async () => {
    const box = inbox();
    const ids = new Set<string>();
    for (let n = 0; n < 5; n += 1) {
      const response = await worker.fetch(scan(), box.env);
      ids.add(((await response.json()) as { id: string }).id);
    }
    expect(ids.size).toBe(5);
    expect(box.objects.size).toBe(10);
  });

  it("takes a content type with parameters after it", async () => {
    const box = inbox();
    const response = await worker.fetch(scan({ type: "Image/JPEG; charset=binary" }), box.env);
    expect(response.status).toBe(201);
  });
});

describe("what the inbox refuses", () => {
  it("answers 404 off the route, and reaches nothing to say so", async () => {
    const box = inbox();
    const env = { ...box.env, SCANS: untouchable };
    for (const path of ["/", "/scans", "/scan/", "/scan/abc", "/frames/x.jpg"]) {
      const response = await worker.fetch(scan({ path }), env);
      expect(response.status, path).toBe(404);
    }
    expect(box.limited).toEqual([]);
  });

  it("answers 405 to every method but POST, ahead of the limiter", async () => {
    // There is no way to read a picture back, list the inbox or delete from it: `env.ts`.
    const box = inbox();
    const env = { ...box.env, SCANS: untouchable };
    for (const method of ["GET", "HEAD", "PUT", "DELETE", "PATCH", "OPTIONS"]) {
      const response = await worker.fetch(scan({ method }), env);
      expect(response.status, method).toBe(405);
      expect(response.headers.get("allow"), method).toBe("POST");
    }
    expect(box.limited).toEqual([]);
  });

  it("refuses an address that has sent too many, before the bucket", async () => {
    const box = inbox({ allow: false });
    const response = await worker.fetch(scan(), { ...box.env, SCANS: untouchable });
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe(String(LIMIT.period));
    expect((await refusal(response)).code).toBe("rate_limited");
    // Keyed on the address, because it is the only identity a sender has.
    expect(box.limited).toEqual([`submit:${ADDRESS}`]);
  });

  it("lets a request through when the limiter is missing or throws", async () => {
    // `ratelimit.ts`'s rule: what bounds the bucket is the cap, which needs no binding.
    const unbound = inbox();
    delete unbound.env.RL_SUBMIT;
    expect((await worker.fetch(scan(), unbound.env)).status).toBe(201);

    const broken = inbox();
    broken.env.RL_SUBMIT = { limit: () => Promise.reject(new Error("the limiter is down")) };
    expect((await worker.fetch(scan(), broken.env)).status).toBe(201);
  });

  it("refuses a body that is not sent as a JPEG, before the bucket", async () => {
    const box = inbox();
    const env = { ...box.env, SCANS: untouchable };
    for (const type of [null, "image/png", "application/octet-stream", "text/plain"]) {
      const response = await worker.fetch(scan({ type }), env);
      expect(response.status, String(type)).toBe(415);
    }
  });

  it("refuses a submission with no label, before the bucket", async () => {
    const box = inbox();
    const env = { ...box.env, SCANS: untouchable };
    for (const labelText of [null, "", "not json", "[]", '"a string"']) {
      const response = await worker.fetch(scan({ labelText }), env);
      expect(response.status, String(labelText)).toBe(400);
    }
    const long = JSON.stringify({ ...label(), pad: "x".repeat(MAX_LABEL_CHARS) });
    expect((await worker.fetch(scan({ labelText: long }), env)).status).toBe(400);
  });

  it("refuses a declared length over the cap without reading the body or the bucket", async () => {
    const box = inbox();
    const request = scan({ headers: { "content-length": String(MAX_FRAME_BYTES + 1) } });
    const response = await worker.fetch(request, { ...box.env, SCANS: untouchable });
    expect(response.status).toBe(413);
    const said = await refusal(response);
    expect(said.code).toBe("frame_limit");
    expect(said.error).toContain(String(MAX_FRAME_BYTES + 1));
    expect(request.bodyUsed).toBe(false);
  });

  it("refuses a body over the cap whatever it declared, and stores none of it", async () => {
    // The lying small `content-length` is caught by the running count.
    const box = inbox();
    const response = await worker.fetch(scan({ body: jpeg(MAX_FRAME_BYTES + 1) }), box.env);
    expect(response.status).toBe(413);
    expect((await refusal(response)).error).toContain(String(MAX_FRAME_BYTES + 1));
    expect(box.objects.size).toBe(0);
  });

  it("takes a picture exactly at the cap", async () => {
    const box = inbox();
    const response = await worker.fetch(scan({ body: jpeg(MAX_FRAME_BYTES) }), box.env);
    expect(response.status).toBe(201);
  });

  it("refuses a body that is not a JPEG, and stores none of it", async () => {
    const box = inbox();
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    for (const body of [png, new Uint8Array(), new Uint8Array([0xff, 0xd8])]) {
      const response = await worker.fetch(scan({ body }), box.env);
      expect(response.status, String(body.byteLength)).toBe(400);
    }
    expect(box.objects.size).toBe(0);
    // And the bucket was not asked: a list is billed, and junk must not buy one.
    expect(box.lists).toEqual([]);
  });

  it("hands both writes to the runtime, so a sender who hangs up cannot split a pair", async () => {
    // A disconnect cancels a request where it stands, and between the two writes is a place to
    // stand. `waitUntil` is what lets the second one finish; the answer still waits for both.
    const box = inbox();
    const kept: Promise<unknown>[] = [];
    const ctx = {
      waitUntil: (work: Promise<unknown>) => void kept.push(work),
      passThroughOnException: () => undefined,
    } as unknown as ExecutionContext;
    const response = await worker.fetch(scan(), box.env, ctx);
    expect(response.status).toBe(201);
    expect(kept).toHaveLength(1);
    await kept[0];
    expect(box.objects.size).toBe(2);
  });

  it("is a 500, with nothing answered as stored, when the bucket cannot be written", async () => {
    // Not caught, on purpose: a 201 for something that was not stored is the worse answer.
    const box = inbox({ down: true });
    await expect(worker.fetch(scan(), box.env)).rejects.toThrow("R2 is unreachable");
    expect(box.objects.size).toBe(0);
  });
});

describe("the cap on what waits to be read", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("takes the last one under the cap", async () => {
    const box = inbox({ waiting: MAX_PENDING - 1 });
    const response = await worker.fetch(scan(), box.env);
    expect(response.status).toBe(201);
    expect(box.objects.size).toBe(MAX_PENDING * 2);
  });

  it("turns a picture away from a full inbox, and stores none of it", async () => {
    const box = inbox({ waiting: MAX_PENDING });
    const response = await worker.fetch(scan(), box.env);
    expect(response.status).toBe(503);
    expect((await refusal(response)).code).toBe("inbox_full");
    expect(box.objects.size).toBe(MAX_PENDING * 2);
  });

  it("stays shut past the cap, where a burst left more than it allows", async () => {
    const box = inbox({ waiting: MAX_PENDING + 3 });
    expect((await worker.fetch(scan(), box.env)).status).toBe(503);
  });

  /**
   * **The order that makes the cap a bound a sender cannot stretch.** Counted before the body, a
   * request that sent its headers and held its picture back had been let past the cap before it
   * stored a byte — and any number of them could be let past a nearly full inbox at once. So the
   * count is asked only of a request whose whole picture is already here.
   */
  it("counts only once the whole picture has arrived", async () => {
    const box = inbox({ waiting: MAX_PENDING });
    const request = scan();
    const response = await worker.fetch(request, box.env);
    expect(response.status).toBe(503);
    expect(request.bodyUsed).toBe(true);
    expect(box.lists).toHaveLength(1);

    // And a picture that is refused for itself never reaches the count at all.
    const fresh = inbox();
    await worker.fetch(scan({ body: jpeg(MAX_FRAME_BYTES + 1) }), fresh.env);
    await worker.fetch(scan({ body: new Uint8Array([1, 2, 3]) }), fresh.env);
    expect(fresh.lists).toEqual([]);
  });

  it("counts pictures, one page of them, and so counts one whose label never landed", async () => {
    // The picture is the two megabytes. Were it labels that were counted, every picture whose
    // label never landed would be bytes the cap could not see — and a sender can make those.
    const box = inbox({ waiting: MAX_PENDING - 1 });
    box.objects.set("frames/20261001T000000Z-ffffffffffffffff.jpg", {
      bytes: jpeg(),
      contentType: "image/jpeg",
    });
    expect((await worker.fetch(scan(), box.env)).status).toBe(503);
    // One page of a list exactly, so the count costs one list a submission.
    expect(box.lists).toEqual([{ prefix: "frames/", limit: MAX_PENDING }]);
    expect(MAX_PENDING).toBeLessThanOrEqual(1000);
  });

  it("remembers a full inbox for a minute, and asks the bucket nothing meanwhile", async () => {
    // A list is a billed operation, and a flood against a full inbox is made of them.
    const clock = vi.spyOn(Date, "now");
    const start = 1_800_000_000_000;
    clock.mockReturnValue(start);
    const box = inbox({ waiting: MAX_PENDING });
    expect((await worker.fetch(scan(), box.env)).status).toBe(503);
    expect(box.lists).toHaveLength(1);

    // Inside the minute: refused from memory, before the picture is read or the bucket asked.
    clock.mockReturnValue(start + FULL_FOR_MS - 1);
    const again = scan();
    const refused = await worker.fetch(again, { ...box.env });
    expect(refused.status).toBe(503);
    expect((await refusal(refused)).code).toBe("inbox_full");
    expect(again.bodyUsed).toBe(false);
    expect(box.lists).toHaveLength(1);

    // Emptied, and a minute on: it asks again, and takes the picture.
    box.objects.clear();
    clock.mockReturnValue(start + FULL_FOR_MS);
    expect((await worker.fetch(scan(), box.env)).status).toBe(201);
    expect(box.lists).toHaveLength(2);
  });

  it("keeps that memory to the bucket it is about", async () => {
    // The isolate's own, keyed on the binding: one inbox found full says nothing of another.
    const full = inbox({ waiting: MAX_PENDING });
    expect((await worker.fetch(scan(), full.env)).status).toBe(503);
    expect((await worker.fetch(scan(), inbox().env)).status).toBe(201);
  });

  it("bounds the inbox in bytes, well under R2's free ten gigabytes", () => {
    expect(MAX_PENDING * MAX_FRAME_BYTES).toBeLessThanOrEqual(1024 ** 3);
  });
});

describe("the header the label rides in", () => {
  it("is the one name the router and the suite both read", async () => {
    const box = inbox();
    const request = new Request("https://scans.example/scan", {
      method: "POST",
      headers: { "content-type": "image/jpeg", "X-Scan-Label": JSON.stringify(label()) },
      body: jpeg(),
    });
    expect(LABEL_HEADER).toBe("x-scan-label");
    expect((await worker.fetch(request, box.env)).status).toBe(201);
  });
});
