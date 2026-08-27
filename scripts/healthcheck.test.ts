import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error The production CLI intentionally remains a dependency-free JavaScript module.
import { runHealthcheckCli } from "./healthcheck.mjs";

const SUCCESS_BODY = '{"status":"healthy"}';
const RESPONSE_HEADERS = {
  "Cache-Control": "private, no-store",
  "Content-Type": "application/json",
};
const INVALID_ORIGIN_CASES: Array<{ args: string[] }> = [
  { args: [] },
  { args: ["https://one.example", "https://two.example"] },
  { args: ["ftp://claimgate.example"] },
  { args: ["https://user:password@claimgate.example"] },
  { args: ["https://claimgate.example/private"] },
  { args: ["https://claimgate.example?secret=value"] },
];

afterEach(() => {
  vi.useRealTimers();
});

function response(body = SUCCESS_BODY, status = 200, headers = RESPONSE_HEADERS): Response {
  return new Response(body, { status, headers });
}

async function run(
  args: string[],
  fetcher: typeof fetch,
): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const code = await runHealthcheckCli(args, {
    fetch: fetcher,
    writeOut: (value: string) => { stdout += value; },
    writeError: (value: string) => { stderr += value; },
  });
  return { code, stdout, stderr };
}

describe("scripts/healthcheck.mjs", () => {
  it("probes the fixed health path and accepts only the exact healthy contract", async () => {
    const fetcher = vi.fn(async () => response()) as unknown as typeof fetch;

    const result = await run(["https://claimgate.example"], fetcher);

    expect(result).toEqual({
      code: 0,
      stdout: "ClaimGate health check passed.\n",
      stderr: "",
    });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledWith(
      "https://claimgate.example/api/health",
      expect.objectContaining({
        method: "GET",
        cache: "no-store",
        redirect: "error",
        headers: { Accept: "application/json" },
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it.each(INVALID_ORIGIN_CASES)("rejects a non-origin argument without making a request: $args", async ({ args }) => {
    const fetcher = vi.fn() as unknown as typeof fetch;

    expect(await run(args, fetcher)).toEqual({
      code: 2,
      stdout: "",
      stderr: "Usage: node scripts/healthcheck.mjs <origin>\n",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    [response(SUCCESS_BODY, 503), "non-200 status"],
    [response('{"status":"healthy","version":"secret"}'), "extra JSON field"],
    [response('{"status":"unavailable"}'), "wrong status value"],
    [response(SUCCESS_BODY, 200, { ...RESPONSE_HEADERS, "Content-Type": "text/plain" }), "wrong media type"],
    [response(SUCCESS_BODY, 200, { ...RESPONSE_HEADERS, "Cache-Control": "public, max-age=60" }), "cacheable response"],
  ])("returns a fixed failure for %s (%s)", async (healthResponse) => {
    const fetcher = vi.fn(async () => healthResponse) as unknown as typeof fetch;

    expect(await run(["http://127.0.0.1:3410/"], fetcher)).toEqual({
      code: 3,
      stdout: "",
      stderr: "ClaimGate health check failed.\n",
    });
  });

  it("rejects an oversized streamed response without printing its contents", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("private-canary-".repeat(90)));
        controller.close();
      },
    });
    const fetcher = vi.fn(async () => new Response(body, {
      status: 200,
      headers: RESPONSE_HEADERS,
    })) as unknown as typeof fetch;

    const result = await run(["http://127.0.0.1:3410"], fetcher);

    expect(result).toEqual({
      code: 3,
      stdout: "",
      stderr: "ClaimGate health check failed.\n",
    });
    expect(`${result.stdout}${result.stderr}`).not.toContain("private-canary");
  });

  it("aborts a stalled request after the fixed timeout and prints no error detail", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>(
      (_resolve, reject) => init?.signal?.addEventListener("abort", () => {
        reject(new Error("private timeout detail"));
      }, { once: true }),
    )) as unknown as typeof fetch;

    const pending = run(["https://claimgate.example"], fetcher);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(await pending).toEqual({
      code: 3,
      stdout: "",
      stderr: "ClaimGate health check failed.\n",
    });
  });

  it("wires invalid CLI usage to exit code 2 with bounded output", () => {
    const result = spawnSync(process.execPath, ["scripts/healthcheck.mjs"], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 5_000,
      windowsHide: true,
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("Usage: node scripts/healthcheck.mjs <origin>\n");
  });
});
