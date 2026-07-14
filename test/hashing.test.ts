import { describe, expect, it } from "vitest";
import { bucket, hashUint64, variantFor, type VariantWeight } from "../src/hashing.js";
import { readVectors } from "./helpers.js";

interface RolloutVector {
  flag_key: string;
  distinct_id: string;
  hash_input: string;
  uint64: string;
  bucket: string;
  bucket_floor: number;
}

interface VariantVector {
  flag_key: string;
  distinct_id: string;
  variants: VariantWeight[];
  expected: string | boolean;
}

describe("flag-hashing vectors (frozen against the platform)", () => {
  const doc = readVectors<{ rollout: RolloutVector[]; variants: VariantVector[] }>("flag-hashing.json");

  it("has the full frozen set", () => {
    expect(doc.rollout.length).toBeGreaterThanOrEqual(200);
    expect(doc.variants.length).toBeGreaterThanOrEqual(12);
  });

  it("reproduces every rollout bucket", () => {
    for (const vector of doc.rollout) {
      // The uint64 exceeds 2^53: compare as BigInt, never as a JSON number.
      expect(hashUint64(vector.hash_input).toString()).toBe(vector.uint64);
      const b = bucket(vector.flag_key, vector.distinct_id);
      expect(Math.floor(b)).toBe(vector.bucket_floor);
      expect(b).toBe(Number(vector.bucket));
    }
  });

  it("reproduces every variant pick", () => {
    for (const vector of doc.variants) {
      expect(variantFor(vector.flag_key, vector.distinct_id, vector.variants)).toBe(vector.expected);
    }
  });
});
