import { describe, expect, it } from "vitest";
import { IdentitySigner } from "../src/signer.js";
import { canonicalJson } from "../src/canonical-json.js";
import { readVectors } from "./helpers.js";

interface IdentityVector {
  name: string;
  secret: string;
  kid: string;
  sub: string;
  iat: number;
  exp: number;
  traits?: Record<string, unknown>;
  token: string;
}

describe("identity vectors (byte-exact against the platform)", () => {
  const doc = readVectors<{ vectors: IdentityVector[] }>("identity.json");

  it("has the full frozen set", () => {
    expect(doc.vectors.length).toBeGreaterThanOrEqual(10);
  });

  for (const vector of doc.vectors) {
    it(vector.name, () => {
      const signer = new IdentitySigner(vector.secret, { kid: vector.kid });
      const token = signer.sign(vector.sub, {
        now: vector.iat,
        ttl: vector.exp - vector.iat,
        ...(vector.traits ? { traits: vector.traits } : {}),
      });
      expect(token).toBe(vector.token);
    });
  }
});

describe("IdentitySigner argument validation", () => {
  it("requires a secret and a kid", () => {
    expect(() => new IdentitySigner("", { kid: "k1" })).toThrow(/identity secret/);
    // @ts-expect-error missing kid on purpose
    expect(() => new IdentitySigner("secret", {})).toThrow(/kid/);
  });

  it("requires an authenticated sub", () => {
    const signer = new IdentitySigner("secret", { kid: "k1" });
    expect(() => signer.sign("")).toThrow(/sub/);
  });

  it("bounds the ttl to (0, 7 days]", () => {
    const signer = new IdentitySigner("secret", { kid: "k1" });
    expect(() => signer.sign("user_1", { ttl: 0 })).toThrow(RangeError);
    expect(() => signer.sign("user_1", { ttl: -5 })).toThrow(RangeError);
    expect(() => signer.sign("user_1", { ttl: 604_801 })).toThrow(RangeError);
    expect(() => signer.sign("user_1", { ttl: 604_800 })).not.toThrow();
  });

  it("omits empty traits", () => {
    const signer = new IdentitySigner("secret", { kid: "k1" });
    const token = signer.sign("user_1", { now: 1_730_000_000, traits: {} });
    const payload = Buffer.from(token.split(".")[1] as string, "base64url").toString("utf8");
    expect(payload).not.toContain("traits");
  });
});

describe("canonicalJson", () => {
  it("sorts keys recursively and keeps compact separators", () => {
    expect(canonicalJson({ b: 1, a: { z: true, m: null } })).toBe('{"a":{"m":null,"z":true},"b":1}');
  });

  it("escapes exactly what Go escapes", () => {
    expect(canonicalJson({ s: "a&b<c>d" })).toBe('{"s":"a\\u0026b\\u003cc\\u003ed"}');
    expect(canonicalJson({ s: "ñ日本🦄" })).toBe('{"s":"ñ日本🦄"}');
    expect(canonicalJson({ s: "  " })).toBe('{"s":"\\u2028\\u2029"}');
  });
});
