import { gzipSync } from "node:zlib";
import type { Logger } from "./log.js";
import type { Transport } from "./transport.js";
import type { WireEvent } from "./types.js";
import { formatTimestamp } from "./timestamp.js";
import { VERSION } from "./version.js";

const MAX_EVENTS_PER_REQUEST = 1000;
const MAX_BODY_BYTES = 5 * 1024 * 1024;
const GZIP_THRESHOLD = 1024;
const MAX_RETRIES = 3;

export interface BatcherDeps {
  /** Injectable for tests; defaults to real timers / Math.random. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => Date;
}

/**
 * Owns delivery: chunking, gzip, the frozen retry policy (SPEC.md §4.3).
 * Failed batches are never re-queued — the retry loop owns them until
 * success or exhaustion.
 */
export class Batcher {
  private readonly url: string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly now: () => Date;

  /** Events dropped by delivery (exhausted retries, non-retryable, oversize). */
  dropped = 0;

  constructor(
    host: string,
    private readonly writeKey: string,
    private readonly timeoutMs: number,
    private readonly transport: Transport,
    private readonly log: Logger,
    deps: BatcherDeps = {},
  ) {
    this.url = `${host.replace(/\/$/, "")}/capture`;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.random = deps.random ?? Math.random;
    this.now = deps.now ?? (() => new Date());
  }

  async send(events: WireEvent[]): Promise<void> {
    for (let i = 0; i < events.length; i += MAX_EVENTS_PER_REQUEST) {
      await this.sendChunk(events.slice(i, i + MAX_EVENTS_PER_REQUEST));
    }
  }

  private async sendChunk(events: WireEvent[]): Promise<void> {
    if (events.length === 0) return;

    const payload = JSON.stringify({
      write_key: this.writeKey,
      sent_at: formatTimestamp(this.now()),
      batch: events,
    });
    let body: Uint8Array = Buffer.from(payload, "utf8");
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": `kilden-node/${VERSION}`,
    };
    if (body.byteLength > GZIP_THRESHOLD) {
      body = gzipSync(body);
      headers["Content-Encoding"] = "gzip";
    }

    // The 5 MiB limit applies to the bytes on the wire. Split rather than
    // let the server reject the whole request; a single event that big is
    // undeliverable and gets dropped.
    if (body.byteLength > MAX_BODY_BYTES) {
      if (events.length === 1) {
        this.dropped += 1;
        this.log.warn("dropping event: serialized size exceeds the 5 MiB request limit");
        return;
      }
      const half = Math.ceil(events.length / 2);
      await this.sendChunk(events.slice(0, half));
      await this.sendChunk(events.slice(half));
      return;
    }

    for (let attempt = 1; ; attempt++) {
      const response = await this.transport.send(this.url, body, headers, this.timeoutMs);

      if (response.status >= 200 && response.status < 300) {
        this.log.debug(`flushed ${events.length} event(s)`);
        return;
      }

      const retryable = response.status === 429 || response.status >= 500 || response.status === 0;
      if (!retryable) {
        this.dropped += events.length;
        this.log.warn(`dropping ${events.length} event(s): capture returned ${response.status}`);
        return;
      }
      if (attempt > MAX_RETRIES) {
        this.dropped += events.length;
        this.log.warn(`dropping ${events.length} event(s): retries exhausted (last status ${response.status})`);
        return;
      }

      const retryAfter = response.status === 429 ? Number(response.headers["retry-after"]) : Number.NaN;
      const waitMs = Number.isFinite(retryAfter) && retryAfter >= 0
        ? retryAfter * 1000
        : Math.min(500 * 2 ** (attempt - 1), 30_000) * (0.5 + this.random());
      this.log.debug(`retrying in ${Math.round(waitMs)}ms (attempt ${attempt}, status ${response.status})`);
      await this.sleep(waitMs);
    }
  }
}
