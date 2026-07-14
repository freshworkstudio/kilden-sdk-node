import { createHmac } from "node:crypto";
import { canonicalJson } from "./canonical-json.js";

export interface IdentitySignerOptions {
  /**
   * Key id, required. The platform looks the secret up by kid among the
   * project's active identity secrets; an unknown kid fails verification
   * silently (verified=false), so getting this wrong is invisible — set it
   * to the kid shown next to the secret in the Kilden dashboard.
   */
  kid: string;
}

export interface SignOptions {
  /** Token lifetime in seconds. Default 3600 (1h), max 604800 (7 days). */
  ttl?: number;
  /** Signed traits: override unsigned traits of the same event. */
  traits?: Record<string, unknown>;
  /** Issue instant override (unix seconds) — for tests. */
  now?: number;
}

const MAX_TTL = 604_800;

/**
 * Signs Kilden identity tokens (HS256, canonical form frozen in the spec).
 *
 * Deliberately separate from Client: a controller rendering a page wants a
 * token for the logged-in user, not an event queue.
 *
 * Only ever sign a `sub` your backend authenticated. Signing a user id taken
 * from request input lets anyone impersonate anyone — with a "verified"
 * stamp on top.
 */
export class IdentitySigner {
  private readonly secret: string;
  private readonly kid: string;

  constructor(identitySecret: string, options: IdentitySignerOptions) {
    if (typeof identitySecret !== "string" || identitySecret === "") {
      throw new TypeError("kilden: IdentitySigner needs the project's identity secret");
    }
    if (typeof options?.kid !== "string" || options.kid === "") {
      throw new TypeError("kilden: IdentitySigner needs the kid that identifies the secret");
    }
    this.secret = identitySecret;
    this.kid = options.kid;
  }

  sign(sub: string, options: SignOptions = {}): string {
    if (typeof sub !== "string" || sub === "") {
      throw new TypeError("kilden: sign() needs the authenticated distinct_id as sub");
    }
    const ttl = options.ttl ?? 3600;
    if (!Number.isInteger(ttl) || ttl <= 0 || ttl > MAX_TTL) {
      throw new RangeError(`kilden: ttl must be an integer in (0, ${MAX_TTL}] seconds`);
    }

    const iat = options.now ?? Math.floor(Date.now() / 1000);
    const payload: Record<string, unknown> = { exp: iat + ttl, iat, sub };
    if (options.traits && Object.keys(options.traits).length > 0) {
      payload["traits"] = options.traits;
    }

    const header = { alg: "HS256", kid: this.kid, typ: "JWT" };
    const signingInput = `${b64url(canonicalJson(header))}.${b64url(canonicalJson(payload))}`;
    const signature = createHmac("sha256", this.secret).update(signingInput).digest("base64url");
    return `${signingInput}.${signature}`;
  }
}

function b64url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}
