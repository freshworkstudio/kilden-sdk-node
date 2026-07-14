/**
 * Canonical JSON for identity tokens (SPEC.md §6.1). The platform's verifier
 * compares signatures, and the frozen vectors compare whole token strings —
 * so serialization is pinned: keys sorted by UTF-8 byte order at every
 * nesting level, compact separators, UTF-8 preserved, and the three
 * HTML-unsafe ASCII characters escaped the way Go's encoding/json does.
 */
export function canonicalJson(value: unknown): string {
  return escapeLikeGo(serialize(value));
}

function serialize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(serialize).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8")))
    .map(([key, val]) => `${JSON.stringify(key)}:${serialize(val)}`);
  return `{${entries.join(",")}}`;
}

/**
 * Go's encoding/json escapes &, <, > (HTML safety) and U+2028/U+2029.
 * JSON.stringify escapes none of them. These characters only ever appear
 * inside string tokens, so a global replace on the serialized form is safe.
 */
function escapeLikeGo(json: string): string {
  return json
    .replaceAll("&", "\\u0026")
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}
