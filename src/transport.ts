/**
 * Transport abstraction (SPEC.md §2.1 `transport` option). The contract is
 * the PHP one, translated: send() NEVER throws — network failures come back
 * as status 0 so the retry policy can classify them.
 */
export interface TransportResponse {
  /** HTTP status, or 0 for timeouts / network errors / corrupt transport. */
  status: number;
  headers: Record<string, string>;
  body: string;
  /** Present when status is 0 — for logs only. */
  error?: string;
}

export interface Transport {
  send(url: string, body: Uint8Array, headers: Record<string, string>, timeoutMs: number): Promise<TransportResponse>;
}

/** Default transport: global fetch (Node >= 18), with a hard timeout. */
export class FetchTransport implements Transport {
  async send(
    url: string,
    body: Uint8Array,
    headers: Record<string, string>,
    timeoutMs: number,
  ): Promise<TransportResponse> {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: body as BodyInit,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await response.text();
      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key.toLowerCase()] = value;
      });
      return { status: response.status, headers: responseHeaders, body: text };
    } catch (error) {
      return {
        status: 0,
        headers: {},
        body: "",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
