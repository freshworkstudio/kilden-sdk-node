import { describe, expect, it } from "vitest";
import { gunzipSync } from "node:zlib";
import { Batcher } from "../src/batcher.js";
import { Client } from "../src/client.js";
import { FlagClient } from "../src/flags.js";
import { silentLogger } from "../src/log.js";
import { formatTimestamp, normalizeTimestamp } from "../src/timestamp.js";
import type { Transport, TransportResponse } from "../src/transport.js";
import type { WireEvent } from "../src/types.js";
import { isCanonicalUuid, uuidv7 } from "../src/uuid.js";

const WIRE_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

class StubTransport implements Transport {
  requests: Array<{ url: string; body: Uint8Array; headers: Record<string, string> }> = [];
  responses: TransportResponse[] = [];

  async send(url: string, body: Uint8Array, headers: Record<string, string>): Promise<TransportResponse> {
    this.requests.push({ url, body, headers });
    return this.responses.shift() ?? { status: 200, headers: {}, body: '{"status":"ok"}' };
  }

  decodedBodies(): Array<{ write_key: string; sent_at: string; batch: WireEvent[] }> {
    return this.requests.map((request) => {
      const raw = request.headers["Content-Encoding"] === "gzip" ? gunzipSync(request.body) : Buffer.from(request.body);
      return JSON.parse(raw.toString("utf8"));
    });
  }
}

function event(overrides: Partial<WireEvent> = {}): WireEvent {
  return {
    uuid: uuidv7(),
    event: "e",
    distinct_id: "u1",
    properties: {},
    timestamp: "2026-07-14T12:00:00.000Z",
    ...overrides,
  };
}

describe("uuid v7", () => {
  it("produces canonical lowercase v7", () => {
    for (let i = 0; i < 200; i++) expect(uuidv7()).toMatch(UUID_V7);
  });
  it("encodes the timestamp in the first 48 bits", () => {
    const now = Date.now();
    const hex = uuidv7(now).replaceAll("-", "").slice(0, 12);
    expect(Number.parseInt(hex, 16)).toBe(now);
  });
  it("validates canonical form only", () => {
    expect(isCanonicalUuid("0197fa10-7a2b-7c3d-8e4f-5a6b7c8d9e0f")).toBe(true);
    expect(isCanonicalUuid("not-a-uuid")).toBe(false);
    expect(isCanonicalUuid("0197fa107a2b7c3d8e4f5a6b7c8d9e0f")).toBe(false);
  });
});

describe("timestamps", () => {
  it("formats the frozen wire form", () => {
    expect(formatTimestamp(new Date(1_752_494_096_789))).toMatch(WIRE_TS);
  });
  it("normalizes offsets to UTC", () => {
    expect(normalizeTimestamp("2026-01-02T03:04:05.678+03:00")).toBe("2026-01-02T00:04:05.678Z");
  });
  it("rejects garbage", () => {
    expect(normalizeTimestamp("not a time")).toBeNull();
    expect(normalizeTimestamp(42)).toBeNull();
  });
});

describe("constructor (contract 2: fail fast)", () => {
  it("rejects a missing key", () => {
    expect(() => new Client("")).toThrow(/write key/);
  });
  it("rejects a public key, teaching the trust model", () => {
    expect(() => new Client("wk_something")).toThrow(/secret key/);
  });
  it("enabled: false makes everything a no-op without transport checks", async () => {
    const client = new Client("", { enabled: false });
    client.track("u1", "e");
    await client.flush();
    await client.close();
    expect(client.dropped).toBe(0);
  });
});

describe("client validation (contracts 1, 3, 4, 5)", () => {
  function build() {
    const transport = new StubTransport();
    const client = new Client("sk_test_secret", { transport, flushAt: 1000, flushInterval: 3600 });
    return { transport, client };
  }

  it("drops empty distinct_id / event and counts them", async () => {
    const { transport, client } = build();
    client.track("", "e");
    client.track("u1", "");
    client.identify("");
    client.alias("", "new");
    client.alias("old", "");
    await client.flush();
    expect(transport.requests).toHaveLength(0);
    expect(client.dropped).toBe(5);
    await client.close();
  });

  it("drops oversize fields client-side", async () => {
    const { transport, client } = build();
    client.track("u1", "x".repeat(201));
    client.track("x".repeat(513), "e");
    await client.flush();
    expect(transport.requests).toHaveLength(0);
    expect(client.dropped).toBe(2);
    await client.close();
  });

  it("sends events verbatim — no trimming, no coercion", async () => {
    const { transport, client } = build();
    client.track(" user 42 ", "Búsqueda Realizada", { " padded key ": " padded value " });
    await client.flush();
    const [body] = transport.decodedBodies();
    expect(body?.batch[0]?.distinct_id).toBe(" user 42 ");
    expect(body?.batch[0]?.event).toBe("Búsqueda Realizada");
    expect(body?.batch[0]?.properties).toEqual({ " padded key ": " padded value " });
    await client.close();
  });

  it("snapshots properties at call time", async () => {
    const { transport, client } = build();
    const props = { n: 1 };
    client.track("u1", "e", props);
    props.n = 999;
    await client.flush();
    expect(transport.decodedBodies()[0]?.batch[0]?.properties).toEqual({ n: 1 });
    await client.close();
  });

  it("keeps $-prefixed events and properties (sent anyway)", async () => {
    const { transport, client } = build();
    client.track("u1", "$looks_reserved", { $prop: 1 });
    await client.flush();
    expect(transport.decodedBodies()[0]?.batch[0]?.event).toBe("$looks_reserved");
    await client.close();
  });

  it("drops invalid caller timestamps and uuids", async () => {
    const { transport, client } = build();
    client.track("u1", "e", {}, { timestamp: "yesterday-ish" });
    client.track("u1", "e", {}, { uuid: "nope" });
    await client.flush();
    expect(transport.requests).toHaveLength(0);
    expect(client.dropped).toBe(2);
    await client.close();
  });
});

describe("queue bound (contract 7)", () => {
  it("drops the NEWEST event at the cap", async () => {
    const transport = new StubTransport();
    const client = new Client("sk_test_secret", { transport, flushAt: 10_000, flushInterval: 3600, maxQueueSize: 3 });
    for (let i = 0; i < 5; i++) client.track("u1", `event_${i}`);
    expect(client.dropped).toBe(2);
    await client.flush();
    const names = transport.decodedBodies()[0]?.batch.map((entry) => entry.event);
    expect(names).toEqual(["event_0", "event_1", "event_2"]);
    await client.close();
  });
});

describe("wire shape (contracts 6, 11 + §4.1)", () => {
  it("builds the exact envelope", async () => {
    const transport = new StubTransport();
    const client = new Client("sk_test_secret", { transport, flushAt: 1000, flushInterval: 3600 });
    client.identify("user_42", { plan: "pro" });
    client.alias("anon_x", "user_42");
    await client.flush();
    const [body] = transport.decodedBodies();
    expect(Object.keys(body as object).sort()).toEqual(["batch", "sent_at", "write_key"]);
    expect(body?.write_key).toBe("sk_test_secret");
    expect(body?.sent_at).toMatch(WIRE_TS);

    const [identify, alias] = body?.batch ?? [];
    expect(identify).toMatchObject({ event: "$identify", distinct_id: "user_42", properties: { $set: { plan: "pro" } } });
    expect(identify?.uuid).toMatch(UUID_V7);
    expect(alias).toMatchObject({ event: "$alias", distinct_id: "anon_x", properties: { $alias: "user_42" } });
    await client.close();
  });

  it("gzips bodies over 1 KiB", async () => {
    const transport = new StubTransport();
    const client = new Client("sk_test_secret", { transport, flushAt: 1000, flushInterval: 3600 });
    client.track("u1", "small");
    await client.flush();
    client.track("u1", "big", { blob: "x".repeat(4000) });
    await client.flush();
    expect(transport.requests[0]?.headers["Content-Encoding"]).toBeUndefined();
    expect(transport.requests[1]?.headers["Content-Encoding"]).toBe("gzip");
    expect(transport.decodedBodies()[1]?.batch[0]?.event).toBe("big");
    await client.close();
  });

  it("identifies itself in the user agent", async () => {
    const transport = new StubTransport();
    const client = new Client("sk_test_secret", { transport, flushAt: 1000, flushInterval: 3600 });
    client.track("u1", "e");
    await client.flush();
    expect(transport.requests[0]?.headers["User-Agent"]).toMatch(/^kilden-node\/\d+\.\d+\.\d+/);
    await client.close();
  });
});

describe("retry policy (contract 8, §4.3)", () => {
  function buildBatcher(responses: TransportResponse[]) {
    const transport = new StubTransport();
    transport.responses = responses;
    const sleeps: number[] = [];
    const batcher = new Batcher("http://mock", "sk_test_secret", 3000, transport, silentLogger, {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      random: () => 0.5, // jitter factor: exactly 1.0
    });
    return { transport, batcher, sleeps };
  }

  const fail = (status: number, headers: Record<string, string> = {}): TransportResponse => ({
    status,
    headers,
    body: "err",
  });

  it("retries 429 honoring Retry-After without jitter", async () => {
    const { transport, batcher, sleeps } = buildBatcher([fail(429, { "retry-after": "2" })]);
    await batcher.send([event()]);
    expect(transport.requests).toHaveLength(2);
    expect(sleeps).toEqual([2000]);
    expect(batcher.dropped).toBe(0);
  });

  it("retries 5xx and network errors with exponential backoff", async () => {
    const { transport, batcher, sleeps } = buildBatcher([fail(500), fail(503), fail(0)]);
    await batcher.send([event()]);
    expect(transport.requests).toHaveLength(4);
    expect(sleeps).toEqual([500, 1000, 2000]);
  });

  it("gives up after 3 retries and counts the drop", async () => {
    const { transport, batcher, sleeps } = buildBatcher([fail(500), fail(500), fail(500), fail(500)]);
    await batcher.send([event(), event()]);
    expect(transport.requests).toHaveLength(4);
    expect(sleeps).toHaveLength(3);
    expect(batcher.dropped).toBe(2);
  });

  it("does not retry other 4xx", async () => {
    for (const status of [400, 401, 403, 413]) {
      const { transport, batcher } = buildBatcher([fail(status)]);
      await batcher.send([event()]);
      expect(transport.requests).toHaveLength(1);
      expect(batcher.dropped).toBe(1);
    }
  });

  it("chunks batches over 1000 events", async () => {
    const { transport, batcher } = buildBatcher([]);
    await batcher.send(Array.from({ length: 1001 }, () => event()));
    expect(transport.requests).toHaveLength(2);
  });
});

describe("flags (§8.2)", () => {
  function buildFlags(responses: TransportResponse[], now: () => number) {
    const transport = new StubTransport();
    transport.responses = responses;
    return { transport, flags: new FlagClient("http://mock", "sk_test_secret", 3000, transport, silentLogger, now) };
  }

  const flagsResponse = (flags: Record<string, unknown>): TransportResponse => ({
    status: 200,
    headers: {},
    body: JSON.stringify({ flags, sessionRecording: { enabled: false, sampleRate: 0 } }),
  });

  it("caches per distinct_id for 30s", async () => {
    let clock = 0;
    const { transport, flags } = buildFlags(
      [flagsResponse({ f: true }), flagsResponse({ f: false })],
      () => clock,
    );
    expect(await flags.get("f", "u1")).toBe(true);
    clock += 29_000;
    expect(await flags.get("f", "u1")).toBe(true); // cached
    expect(transport.requests).toHaveLength(1);
    clock += 2_000;
    expect(await flags.get("f", "u1")).toBe(false); // expired → refetch
    expect(transport.requests).toHaveLength(2);
  });

  it("bypasses the cache with person_properties", async () => {
    const { transport, flags } = buildFlags(
      [flagsResponse({ f: true }), flagsResponse({ f: false }), flagsResponse({ f: true })],
      () => 0,
    );
    expect(await flags.get("f", "u1")).toBe(true);
    expect(await flags.get("f", "u1", { personProperties: { plan: "pro" } })).toBe(false);
    expect(transport.requests).toHaveLength(2);
    expect(await flags.get("f", "u1")).toBe(true); // original cache untouched
    expect(transport.requests).toHaveLength(2);
    const decideBody = JSON.parse(Buffer.from(transport.requests[1]?.body ?? []).toString("utf8"));
    expect(decideBody.person_properties).toEqual({ plan: "pro" });
  });

  it("returns the default on failure and unknown flags, without caching failures", async () => {
    const { transport, flags } = buildFlags(
      [{ status: 500, headers: {}, body: "boom" }, flagsResponse({ known: true })],
      () => 0,
    );
    expect(await flags.get("known", "u1", { default: "fallback" })).toBe("fallback");
    expect(await flags.get("known", "u1")).toBe(true); // second call refetched
    expect(await flags.get("missing", "u1", { default: true })).toBe(true);
    expect(transport.requests).toHaveLength(2);
  });
});

describe("close (contract 10)", () => {
  it("is idempotent and drops events tracked afterwards", async () => {
    const transport = new StubTransport();
    const client = new Client("sk_test_secret", { transport, flushAt: 1000, flushInterval: 3600 });
    client.track("u1", "before");
    await client.close();
    await client.close();
    client.track("u1", "after");
    expect(client.dropped).toBe(1);
    expect(transport.decodedBodies()[0]?.batch[0]?.event).toBe("before");
    expect(transport.requests).toHaveLength(1);
  });

  it("hot path never throws even when the transport explodes", async () => {
    const explosive: Transport = {
      send: () => {
        throw new Error("kaboom");
      },
    };
    const client = new Client("sk_test_secret", { transport: explosive, flushAt: 1, flushInterval: 3600 });
    client.track("u1", "e");
    await expect(client.flush()).resolves.toBeUndefined();
    await expect(client.close()).resolves.toBeUndefined();
  });
});

describe("version", () => {
  it("matches package.json", async () => {
    const { VERSION } = await import("../src/version.js");
    const pkg = JSON.parse(
      (await import("node:fs")).readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    );
    expect(VERSION).toBe(pkg.version);
  });
});
