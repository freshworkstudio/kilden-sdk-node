import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Root of the kilden-sdk-spec checkout (vectors + mock server). */
export function specDir(): string {
  const fromEnv = process.env["KILDEN_SPEC_DIR"];
  const dir = fromEnv ?? resolve(import.meta.dirname, "../../kilden-sdk-spec");
  if (!existsSync(dir)) {
    throw new Error(
      `kilden-sdk-spec checkout not found at ${dir}; set KILDEN_SPEC_DIR (the vector runner is a mandatory part of the suite)`,
    );
  }
  return dir;
}

export function readVectors<T>(file: string): T {
  return JSON.parse(readFileSync(resolve(specDir(), "vectors", file), "utf8")) as T;
}

export const MOCK_URL = `http://127.0.0.1:${process.env["KILDEN_MOCK_PORT"] ?? "18092"}`;

export async function mockReset(): Promise<void> {
  await fetch(`${MOCK_URL}/__mock/reset`, { method: "POST", body: "{}" });
}

export async function mockCaptured(): Promise<{
  batches: Array<{ write_key: string; sent_at: string; gzip: boolean; headers: Record<string, string>; batch: unknown[] }>;
  events: Array<{ uuid: string; event: string; distinct_id: string; properties: unknown; timestamp: string }>;
}> {
  const response = await fetch(`${MOCK_URL}/__mock/captured`);
  return (await response.json()) as Awaited<ReturnType<typeof mockCaptured>>;
}

export async function mockControl(path: string, body: unknown): Promise<void> {
  const response = await fetch(`${MOCK_URL}${path}`, { method: "POST", body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`${path} → ${response.status}`);
}
