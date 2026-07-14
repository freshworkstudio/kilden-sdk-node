import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { specDir } from "./helpers.js";

const PORT = process.env["KILDEN_MOCK_PORT"] ?? "18092";

let mock: ChildProcess | undefined;

/** Boot the spec repo's mock capture server once for the whole suite. */
export async function setup(): Promise<void> {
  const cwd = resolve(specDir(), "mockserver");
  mock = spawn("go", ["run", ".", "-addr", `:${PORT}`], { cwd, stdio: "ignore" });

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/healthz`);
      if (response.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("mock capture server did not come up (is Go installed?)");
}

export async function teardown(): Promise<void> {
  mock?.kill("SIGKILL");
}
