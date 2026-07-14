import { Batcher } from "./batcher.js";
import { FlagClient } from "./flags.js";
import { makeLogger, silentLogger, type Logger } from "./log.js";
import { formatTimestamp, normalizeTimestamp } from "./timestamp.js";
import { FetchTransport, type Transport } from "./transport.js";
import type {
  ClientOptions,
  EventOptions,
  FlagOptions,
  FlagValue,
  Properties,
  WireEvent,
} from "./types.js";
import { isCanonicalUuid, uuidv7 } from "./uuid.js";

const MAX_EVENT_BYTES = 200;
const MAX_DISTINCT_ID_BYTES = 512;
const CLOSE_DEADLINE_MS = 10_000;

/**
 * The Kilden server-side client. Construct once per process with the
 * project's SECRET write key and reuse it; call close() on shutdown.
 *
 * After construction the public API never throws (spec contract 1): invalid
 * input is dropped and logged, and `dropped` counts everything discarded.
 */
export class Client {
  private readonly host: string;
  private readonly flushAt: number;
  private readonly maxQueueSize: number;
  private readonly enabled: boolean;
  private readonly log: Logger;
  private readonly debug: boolean;

  private readonly batcher: Batcher | null = null;
  private readonly flagClient: FlagClient | null = null;

  private queue: WireEvent[] = [];
  private queueDropped = 0;
  private sending: Promise<void> = Promise.resolve();
  private interval: NodeJS.Timeout | null = null;
  private closed = false;
  private readonly exitHook = (): void => {
    void this.close();
  };

  constructor(secretWriteKey: string, options: ClientOptions = {}) {
    this.enabled = options.enabled ?? true;
    this.debug = options.debug ?? false;
    this.log = this.enabled ? makeLogger(this.debug) : silentLogger;

    if (this.enabled) {
      if (typeof secretWriteKey !== "string" || secretWriteKey === "") {
        throw new TypeError("kilden: a write key is required");
      }
      if (secretWriteKey.startsWith("wk_")) {
        throw new TypeError(
          "kilden: this is the project's PUBLIC write key. Server-side events need the secret key " +
            "(sk_...) so the platform can trust them as facts — and the secret key must never ship " +
            "in a browser. Get it from the project settings.",
        );
      }
    }

    this.host = options.host ?? "https://ingest.kilden.io";
    this.flushAt = options.flushAt ?? 20;
    this.maxQueueSize = options.maxQueueSize ?? 10_000;
    const flushIntervalMs = (options.flushInterval ?? 10) * 1000;
    const timeoutMs = (options.timeout ?? 3) * 1000;

    if (!this.enabled) return;

    const transport: Transport = options.transport ?? new FetchTransport();
    this.batcher = new Batcher(this.host, secretWriteKey, timeoutMs, transport, this.log);
    this.flagClient = new FlagClient(this.host, secretWriteKey, timeoutMs, transport, this.log);

    this.interval = setInterval(() => {
      this.scheduleFlush();
    }, flushIntervalMs);
    this.interval.unref();
    process.on("beforeExit", this.exitHook);
  }

  /** Events discarded so far (invalid input, full queue, delivery failures). */
  get dropped(): number {
    return this.queueDropped + (this.batcher?.dropped ?? 0);
  }

  track(distinctId: string, event: string, properties: Properties = {}, opts: EventOptions = {}): void {
    this.enqueue(distinctId, event, properties, opts, "track");
  }

  identify(distinctId: string, traits: Properties = {}, opts: EventOptions = {}): void {
    this.enqueue(distinctId, "$identify", { $set: traits ?? {} }, opts, "identify");
  }

  alias(previousId: string, distinctId: string): void {
    if (typeof distinctId !== "string" || distinctId === "") {
      this.warnDrop("alias: distinct_id must be a non-empty string");
      return;
    }
    this.enqueue(previousId, "$alias", { $alias: distinctId }, {}, "alias");
  }

  async isEnabled(flagKey: string, distinctId: string, opts: FlagOptions = {}): Promise<boolean> {
    const value = await this.getFeatureFlag(flagKey, distinctId, opts);
    return value === true || typeof value === "string";
  }

  async getFeatureFlag(flagKey: string, distinctId: string, opts: FlagOptions = {}): Promise<FlagValue> {
    if (!this.enabled || this.flagClient === null) return opts.default ?? false;
    try {
      return await this.flagClient.get(flagKey, distinctId, opts);
    } catch (error) {
      // Contract 1: the hot path never throws.
      this.log.warn(`feature flag lookup failed unexpectedly: ${String(error)}`);
      return opts.default ?? false;
    }
  }

  /** Drain everything queued right now; resolves when delivery finished. */
  async flush(): Promise<void> {
    if (!this.enabled || this.batcher === null) return;
    const batch = this.queue;
    this.queue = [];
    const batcher = this.batcher;
    this.sending = this.sending
      .then(() => (batch.length > 0 ? batcher.send(batch) : undefined))
      .catch((error) => {
        this.log.warn(`flush failed unexpectedly: ${String(error)}`);
      });
    await this.sending;
  }

  /**
   * flush() with a 10-second deadline, then stop the worker. Idempotent.
   * Events tracked after close() are dropped with a warning.
   */
  async close(): Promise<void> {
    if (this.closed || !this.enabled) {
      this.closed = true;
      return;
    }
    this.closed = true;
    if (this.interval !== null) clearInterval(this.interval);
    process.removeListener("beforeExit", this.exitHook);

    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<"deadline">((resolve) => {
      timer = setTimeout(() => resolve("deadline"), CLOSE_DEADLINE_MS);
      timer.unref();
    });
    const result = await Promise.race([this.flush().then(() => "done" as const), deadline]);
    if (timer !== undefined) clearTimeout(timer);
    if (result === "deadline") {
      this.queueDropped += this.queue.length;
      this.queue = [];
      this.log.warn("close() deadline reached; undelivered events were dropped");
    }
  }

  // --- internals ---

  private enqueue(
    distinctId: string,
    event: string,
    properties: Properties,
    opts: EventOptions,
    method: string,
  ): void {
    if (!this.enabled) return;
    if (this.closed) {
      this.warnDrop(`${method}: client is closed`);
      return;
    }
    if (typeof distinctId !== "string" || distinctId === "") {
      this.warnDrop(`${method}: distinct_id must be a non-empty string`);
      return;
    }
    if (typeof event !== "string" || event === "") {
      this.warnDrop(`${method}: event must be a non-empty string`);
      return;
    }
    if (Buffer.byteLength(event, "utf8") > MAX_EVENT_BYTES) {
      this.warnDrop(`${method}: event exceeds ${MAX_EVENT_BYTES} bytes`);
      return;
    }
    if (Buffer.byteLength(distinctId, "utf8") > MAX_DISTINCT_ID_BYTES) {
      this.warnDrop(`${method}: distinct_id exceeds ${MAX_DISTINCT_ID_BYTES} bytes`);
      return;
    }

    let snapshot: Properties;
    try {
      // Snapshot at call time: the event freezes its properties, and callers
      // mutating the object afterwards must not alter what ships.
      snapshot = JSON.parse(JSON.stringify(properties ?? {})) as Properties;
    } catch {
      this.warnDrop(`${method}: properties are not JSON-serializable`);
      return;
    }
    if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) {
      this.warnDrop(`${method}: properties must be a plain object`);
      return;
    }

    let timestamp: string;
    if (opts.timestamp !== undefined) {
      const normalized = normalizeTimestamp(opts.timestamp);
      if (normalized === null) {
        this.warnDrop(`${method}: timestamp is not a valid time`);
        return;
      }
      timestamp = normalized;
    } else {
      timestamp = formatTimestamp(new Date());
    }

    let uuid: string;
    if (opts.uuid !== undefined) {
      if (typeof opts.uuid !== "string" || !isCanonicalUuid(opts.uuid)) {
        this.warnDrop(`${method}: uuid must be a canonical RFC 4122 UUID`);
        return;
      }
      uuid = opts.uuid;
    } else {
      uuid = uuidv7();
    }

    if (this.debug) {
      if (event.startsWith("$") && method === "track") {
        this.log.warn(`event "${event}" uses the $ prefix reserved for Kilden system events; sending anyway`);
      }
      for (const key of Object.keys(snapshot)) {
        if (key.startsWith("$") && method === "track") {
          this.log.warn(`property "${key}" uses the $ prefix reserved for Kilden; sending anyway`);
        }
      }
    }

    if (this.queue.length >= this.maxQueueSize) {
      this.queueDropped += 1;
      this.log.warn(`queue is full (${this.maxQueueSize}); dropping the newest event`);
      return;
    }

    this.queue.push({ uuid, event, distinct_id: distinctId, properties: snapshot, timestamp });
    if (this.queue.length >= this.flushAt) this.scheduleFlush();
  }

  private scheduleFlush(): void {
    void this.flush();
  }

  private warnDrop(message: string): void {
    this.queueDropped += 1;
    this.log.warn(`${message}; event dropped`);
  }
}
