import type { Transport } from "./transport.js";

export type Properties = Record<string, unknown>;

export interface ClientOptions {
  /** Base URL; POST {host}/capture and {host}/decide. */
  host?: string;
  /** Queue length that triggers a flush. Default 20. */
  flushAt?: number;
  /** Seconds between periodic flushes. Default 10. */
  flushInterval?: number;
  /** Hard cap on queued events; the newest event is dropped beyond it. Default 10000. */
  maxQueueSize?: number;
  /** Seconds per HTTP request. Default 3. */
  timeout?: number;
  /** Transport instance; null/undefined = the built-in fetch transport. */
  transport?: Transport | null;
  /** Verbose logging plus $-prefix warnings. Default false. */
  debug?: boolean;
  /** false = full no-op, for tests and local dev. Default true. */
  enabled?: boolean;
}

export interface EventOptions {
  /** Event time, ISO 8601 or Date. Default: now. */
  timestamp?: string | Date;
  /** Event UUID for retry idempotency. Default: a fresh UUID v7. */
  uuid?: string;
}

export type FlagValue = boolean | string;

export interface FlagOptions {
  /**
   * Sent to /decide; overrides stored person traits for this evaluation
   * only. Calls with personProperties bypass the flag cache.
   */
  personProperties?: Record<string, unknown>;
  /** Returned when Kilden cannot answer (timeout, error, unknown flag). Default false. */
  default?: FlagValue;
}

/** One event in wire form, ready for the batch payload. */
export interface WireEvent {
  uuid: string;
  event: string;
  distinct_id: string;
  properties: Properties;
  timestamp: string;
}
