/**
 * The wire timestamp format is frozen by the spec (§4.4): UTC, exactly three
 * fractional digits, Z suffix. Date#toISOString already produces it.
 */
export function formatTimestamp(date: Date): string {
  return date.toISOString();
}

/**
 * Normalize a caller-supplied timestamp (Date or ISO 8601 string) to the
 * wire form. Returns null when the value cannot be interpreted as a time —
 * the caller drops the event with a warning instead of throwing.
 */
export function normalizeTimestamp(value: unknown): string | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : formatTimestamp(value);
  }
  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : formatTimestamp(parsed);
  }
  return null;
}
