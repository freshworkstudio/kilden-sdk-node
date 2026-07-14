import type { Logger } from "./log.js";
import type { Transport } from "./transport.js";
import type { FlagOptions, FlagValue } from "./types.js";
import { VERSION } from "./version.js";

const CACHE_TTL_MS = 30_000;
const CACHE_MAX_IDS = 1000;

interface CacheEntry {
  expiresAt: number;
  flags: Record<string, FlagValue>;
}

/**
 * Remote flag evaluation with a short cache (SPEC.md §8). One attempt per
 * lookup, never retried: a flag answer that arrives after a retry budget is
 * useless to the caller. Failures return the caller's default.
 */
export class FlagClient {
  private readonly url: string;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly now: () => number;

  constructor(
    host: string,
    private readonly writeKey: string,
    private readonly timeoutMs: number,
    private readonly transport: Transport,
    private readonly log: Logger,
    now: () => number = Date.now,
  ) {
    this.url = `${host.replace(/\/$/, "")}/decide`;
    this.now = now;
  }

  async get(flagKey: string, distinctId: string, options: FlagOptions = {}): Promise<FlagValue> {
    const fallback = options.default ?? false;
    if (typeof flagKey !== "string" || flagKey === "" || typeof distinctId !== "string" || distinctId === "") {
      this.log.warn("feature flag lookup needs a non-empty flag key and distinct_id");
      return fallback;
    }

    // person_properties overrides make the evaluation non-reusable: bypass
    // the cache in both directions.
    const bypassCache = options.personProperties !== undefined;
    if (!bypassCache) {
      const cached = this.cache.get(distinctId);
      if (cached && cached.expiresAt > this.now()) {
        this.cache.delete(distinctId);
        this.cache.set(distinctId, cached); // refresh LRU recency
        return cached.flags[flagKey] ?? fallback;
      }
    }

    const flags = await this.fetchFlags(distinctId, options.personProperties);
    if (flags === null) return fallback;

    if (!bypassCache) {
      this.cache.set(distinctId, { expiresAt: this.now() + CACHE_TTL_MS, flags });
      if (this.cache.size > CACHE_MAX_IDS) {
        const oldest = this.cache.keys().next().value;
        if (oldest !== undefined) this.cache.delete(oldest);
      }
    }
    return flags[flagKey] ?? fallback;
  }

  private async fetchFlags(
    distinctId: string,
    personProperties?: Record<string, unknown>,
  ): Promise<Record<string, FlagValue> | null> {
    const request: Record<string, unknown> = { write_key: this.writeKey, distinct_id: distinctId };
    if (personProperties !== undefined) request["person_properties"] = personProperties;

    let body: Uint8Array;
    try {
      body = Buffer.from(JSON.stringify(request), "utf8");
    } catch {
      this.log.warn("person_properties are not JSON-serializable; returning default");
      return null;
    }

    const response = await this.transport.send(
      this.url,
      body,
      { "Content-Type": "application/json", "User-Agent": `kilden-node/${VERSION}` },
      this.timeoutMs,
    );
    if (response.status !== 200) {
      this.log.warn(`decide returned ${response.status || `network error (${response.error ?? "unknown"})`}; returning default`);
      return null;
    }
    try {
      const parsed: unknown = JSON.parse(response.body);
      const flags = (parsed as { flags?: unknown }).flags;
      if (flags === null || typeof flags !== "object" || Array.isArray(flags)) throw new Error("no flags map");
      return flags as Record<string, FlagValue>;
    } catch {
      this.log.warn("decide returned a malformed body; returning default");
      return null;
    }
  }
}
