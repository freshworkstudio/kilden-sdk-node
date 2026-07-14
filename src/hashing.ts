import { createHash } from "node:crypto";

/**
 * The frozen rollout hashing (SPEC.md §8.3). v1 evaluates flags remotely and
 * never calls this in production paths — it exists so the algorithm is
 * pinned by tests against the spec vectors today, and local evaluation can
 * ship later without a compatibility break. Deliberately not exported from
 * the package entry point.
 */
export function hashUint64(input: string): bigint {
  const digest = createHash("sha256").update(input, "utf8").digest();
  return digest.readBigUInt64BE(0);
}

export function bucket(flagKey: string, distinctId: string): number {
  return (Number(hashUint64(`${flagKey}:${distinctId}`)) / 2 ** 64) * 100;
}

export interface VariantWeight {
  key: string;
  rollout_percentage: number;
}

export function variantFor(flagKey: string, distinctId: string, variants: VariantWeight[]): string | true {
  const point = (Number(hashUint64(`${flagKey}:${distinctId}:variant`)) / 2 ** 64) * 100;
  let cumulative = 0;
  for (const variant of variants) {
    cumulative += variant.rollout_percentage;
    if (point < cumulative) return variant.key;
  }
  return true;
}
