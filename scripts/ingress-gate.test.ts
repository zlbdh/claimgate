import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { execFile } from "node:child_process";
import { request } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore Production is a dependency-free JavaScript module.
import { createIngressGateServer } from "./ingress-gate-http.mjs";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore Production is a dependency-free JavaScript module.
import { assertWindowWritePostcondition, createIngressGateStore, INGRESS_GATE_BUSY_TIMEOUT_MS, INGRESS_GATE_LIMIT, INGRESS_GATE_WINDOW_MS, normalizeIngressSource } from "./ingress-gate-store.mjs";
const TEST_KEY = Buffer.alloc(32, 23).toString("base64");
const SOURCE = "192.0.2.44";
const directories: string[] = [];
const execFileAsync = promisify(execFile);
function databasePath(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "claimgate-ingress-gate-"));
  directories.push(directory);
  return path.join(directory, "gate.db");
}
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true });
});
describe("persistent ingress source limiter", () => {
  it("directly rejects write-count and persisted-row postcondition mismatches", () => {
    const persisted = { eventTimesJson: "[50]", lastEventAtMs: 50 };
    expect(() => assertWindowWritePostcondition(0, persisted, "[50]", 50)).toThrow();
    expect(() => assertWindowWritePostcondition(1, persisted, "[51]", 50)).toThrow();
    expect(() => assertWindowWritePostcondition(1, persisted, "[50]", 51)).toThrow();
    expect(() => assertWindowWritePostcondition(1, persisted, "[50]", 50)).not.toThrow();
  });
  it("normalizes IPv4-mapped IPv6 to the same source", () => {
    expect(normalizeIngressSource("::ffff:192.0.2.44")).toBe(normalizeIngressSource("192.0.2.44"));
    expect(normalizeIngressSource("::ffff:c000:022c")).toBe(normalizeIngressSource("192.0.2.44"));
  });
  it("fails ten concurrent HTTP requests before the proxy deadline without late consumption", async () => {
    const file = databasePath();
    const store = createIngressGateStore({ databasePath: file, key: TEST_KEY, now: () => 50 });
    const blocker = new Database(file);
    blocker.exec("BEGIN IMMEDIATE");
    expect(INGRESS_GATE_BUSY_TIMEOUT_MS).toBe(0);
    await withServer(store.consume, async (port) => {
      const started = Date.now();
      const responses = await Promise.all(Array.from({ length: 10 }, () => gateRequest(port)));
      expect(responses.every(({ status }) => status === 500)).toBe(true);
      expect(Date.now() - started).toBeLessThan(1_000);
    });
    blocker.exec("ROLLBACK");
    expect(blocker.prepare("SELECT count(*) AS count FROM ingress_source_windows").get()).toEqual({ count: 0 });
    await withServer(store.consume, async (port) => {
      for (let index = 0; index < 5; index += 1) expect((await gateRequest(port)).status).toBe(204);
      expect((await gateRequest(port)).status).toBe(403);
    });
    blocker.close();
    store.close();
  });
  it("rejects the sixth request anywhere inside a rolling ten-minute window", () => {
    let now = 0;
    const store = createIngressGateStore({ databasePath: databasePath(), key: TEST_KEY, now: () => now });
    try {
      expect(INGRESS_GATE_LIMIT).toBe(5);
      expect(INGRESS_GATE_WINDOW_MS).toBe(600_000);
      for (const time of [0, 120_000, 240_000, 360_000, 480_000]) {
        now = time;
        expect(store.consume(SOURCE)).toEqual({ allowed: true, retryAfterMs: 0 });
      }

      now = 599_999;
      expect(store.consume(SOURCE)).toEqual({ allowed: false, retryAfterMs: 1 });
      now = 600_000;
      expect(store.consume(SOURCE)).toEqual({ allowed: true, retryAfterMs: 0 });
    } finally {
      store.close();
    }
  });

  it("survives reopen and fails closed on key mismatch or clock rollback", () => {
    const file = databasePath();
    let now = 100_000;
    let store = createIngressGateStore({ databasePath: file, key: TEST_KEY, now: () => now });
    for (let index = 0; index < 5; index += 1) expect(store.consume(SOURCE).allowed).toBe(true);
    store.close();

    now -= 50_000;
    store = createIngressGateStore({ databasePath: file, key: TEST_KEY, now: () => now });
    expect(store.consume(SOURCE).allowed).toBe(false);
    store.close();

    const wrongKey = Buffer.alloc(32, 24).toString("base64");
    expect(() => createIngressGateStore({ databasePath: file, key: wrongKey, now: () => now }))
      .toThrow();
  });

  it("stores only a fixed-size HMAC pseudonym and never raw source text", () => {
    const file = databasePath();
    const store = createIngressGateStore({ databasePath: file, key: TEST_KEY, now: () => 10 });
    store.consume(SOURCE);
    store.close();

    expect(readFileSync(file).includes(Buffer.from(SOURCE, "utf8"))).toBe(false);
    const database = new Database(file, { readonly: true });
    try {
      expect(database.prepare(`
        SELECT typeof(source_digest) AS type, length(source_digest) AS length,
          event_times_json AS eventTimes
        FROM ingress_source_windows
      `).get()).toEqual({ type: "blob", length: 32, eventTimes: "[10]" });
      expect(database.prepare("PRAGMA table_info(ingress_source_windows)").all()
        .map((column) => (column as { name: string }).name)).not.toContain("ip");
    } finally {
      database.close();
    }
  });

  it("fails closed when a trigger suppresses or erases a committed window write", () => {
    const file = databasePath();
    const store = createIngressGateStore({ databasePath: file, key: TEST_KEY, now: () => 50 });
    const sabotage = new Database(file);
    try {
      sabotage.exec(`
        CREATE TRIGGER suppress_window_insert BEFORE INSERT ON ingress_source_windows
        BEGIN SELECT RAISE(IGNORE); END;
      `);
      expect(() => store.consume(SOURCE)).toThrow();
      sabotage.exec("DROP TRIGGER suppress_window_insert");
      sabotage.exec(`
        CREATE TRIGGER erase_window_insert AFTER INSERT ON ingress_source_windows
        BEGIN DELETE FROM ingress_source_windows WHERE source_digest = NEW.source_digest; END;
      `);
      expect(() => store.consume(SOURCE)).toThrow();
    } finally {
      sabotage.close();
      store.close();
    }
    expect(() => createIngressGateStore({ databasePath: file, key: TEST_KEY, now: () => 50 }))
      .toThrow();
  });

  it("allows exactly five writers under real multi-process contention", async () => {
    const file = databasePath();
    createIngressGateStore({ databasePath: file, key: TEST_KEY, now: () => 50 }).close();
    const moduleUrl = pathToFileURL(path.resolve("scripts/ingress-gate-store.mjs")).href;
    const worker = `
      import { createIngressGateStore } from ${JSON.stringify(moduleUrl)};
      const [databasePath, key, source, nowText] = process.argv.slice(1);
      let store, result;
      try {
        store = createIngressGateStore({ databasePath, key, now: () => Number(nowText) });
        result = store.consume(source);
      } catch { result = { busy: true }; }
      store?.close();
      process.stdout.write(JSON.stringify(result));
    `;
    const calls = Array.from({ length: 20 }, () => execFileAsync(
      process.execPath,
      ["--input-type=module", "-e", worker, file, TEST_KEY, SOURCE, "50"],
      { cwd: process.cwd(), timeout: 20_000, windowsHide: true },
    ));
    const results = await Promise.all(calls);
    expect(results.every(({ stderr }) => stderr === "")).toBe(true);
    const parsed = results.map(({ stdout }) => JSON.parse(stdout) as { allowed?: boolean; busy?: boolean });
    const concurrentAllowed = parsed.filter(({ allowed }) => allowed).length;
    expect(concurrentAllowed).toBeLessThanOrEqual(5);
    const store = createIngressGateStore({ databasePath: file, key: TEST_KEY, now: () => 50 });
    let sequentialAllowed = 0;
    while (store.consume(SOURCE).allowed) sequentialAllowed += 1;
    store.close();
    expect(concurrentAllowed + sequentialAllowed).toBe(5);
  });
});

type GateResponse = { status: number; headers: Record<string, string | string[] | undefined>; body: string };

async function withServer(
  consume: (source: string) => { allowed: boolean; retryAfterMs: number },
  run: (port: number) => Promise<void>,
): Promise<void> {
  const server = createIngressGateServer({ consume });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    await run((server.address() as AddressInfo).port);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error?: Error) => (
      error ? reject(error) : resolve()
    )));
  }
}

function gateRequest(port: number, overrides: Record<string, unknown> = {}): Promise<GateResponse> {
  return new Promise((resolve, reject) => {
    const outgoing = request({
      host: "127.0.0.1",
      port,
      method: "GET",
      path: "/check",
      headers: {
        Host: "claimgate-ingress-gate",
        "X-ClaimGate-Source": SOURCE,
        "X-ClaimGate-Origin-Policy": "1",
        "X-ClaimGate-Fetch-Policy": "1",
      },
      ...overrides,
    }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolve({
        status: response.statusCode ?? 0,
        headers: response.headers,
        body,
      }));
    });
    outgoing.once("error", reject);
    outgoing.end();
  });
}

describe("ingress gate HTTP boundary", () => {
  it("uses bounded header, request, keepalive, and timeout-check intervals", () => {
    const server = createIngressGateServer({
      consume: () => ({ allowed: true, retryAfterMs: 0 }),
    });
    expect(server.maxHeadersCount).toBe(32);
    expect(server.requestTimeout).toBe(2_000);
    expect(server.headersTimeout).toBe(2_000);
    expect(server.keepAliveTimeout).toBe(1_000);
    expect(server.connectionsCheckingInterval).toBe(500);
  });

  it("returns bodyless 2xx for allow and bodyless 403 with bounded retry for deny", async () => {
    await withServer(() => ({ allowed: true, retryAfterMs: 0 }), async (port) => {
      expect(await gateRequest(port)).toMatchObject({
        status: 204,
        headers: { "cache-control": "private, no-store", "content-length": "0" },
        body: "",
      });
    });
    await withServer(() => ({ allowed: false, retryAfterMs: 60_001 }), async (port) => {
      expect(await gateRequest(port)).toMatchObject({
        status: 403,
        headers: { "retry-after": "61", "content-length": "0" },
        body: "",
      });
    });
  });

  it("returns 500 for malformed internal subrequests before consuming", async () => {
    const consume = vi.fn(() => ({ allowed: true, retryAfterMs: 0 }));
    await withServer(consume, async (port) => {
      for (const overrides of [
        { method: "POST" },
        { path: "/check?source=private" },
        { headers: { Host: "wrong", "X-ClaimGate-Source": SOURCE,
          "X-ClaimGate-Origin-Policy": "1", "X-ClaimGate-Fetch-Policy": "1" } },
        { headers: { Host: "claimgate-ingress-gate", "X-ClaimGate-Origin-Policy": "1",
          "X-ClaimGate-Fetch-Policy": "1" } },
        { headers: { Host: "claimgate-ingress-gate", "X-ClaimGate-Source": "not-an-ip",
          "X-ClaimGate-Origin-Policy": "1", "X-ClaimGate-Fetch-Policy": "1" } },
        { headers: { Host: "claimgate-ingress-gate", "X-ClaimGate-Source": SOURCE,
          "X-ClaimGate-Origin-Policy": "1", "X-ClaimGate-Fetch-Policy": "1", "Content-Length": "1" } },
      ]) expect((await gateRequest(port, overrides)).status).toBe(500);
    });
    expect(consume).not.toHaveBeenCalled();
  });

  it("returns 401 for Origin or Fetch policy failures without consuming", async () => {
    const consume = vi.fn(() => ({ allowed: true, retryAfterMs: 0 }));
    await withServer(consume, async (port) => {
      for (const overrides of [
        { headers: { Host: "claimgate-ingress-gate", "X-ClaimGate-Source": SOURCE,
          "X-ClaimGate-Fetch-Policy": "1" } },
        { headers: { Host: "claimgate-ingress-gate", "X-ClaimGate-Source": SOURCE,
          "X-ClaimGate-Origin-Policy": "0", "X-ClaimGate-Fetch-Policy": "1" } },
        { headers: { Host: "claimgate-ingress-gate", "X-ClaimGate-Source": SOURCE,
          "X-ClaimGate-Origin-Policy": ["1", "1"], "X-ClaimGate-Fetch-Policy": "1" } },
        { headers: { Host: "claimgate-ingress-gate", "X-ClaimGate-Source": SOURCE,
          "X-ClaimGate-Origin-Policy": "1", "X-ClaimGate-Fetch-Policy": "0" } },
      ]) expect((await gateRequest(port, overrides)).status).toBe(401);
    });
    expect(consume).not.toHaveBeenCalled();
  });

  it("fails closed with no exception or source detail in the response", async () => {
    await withServer(() => { throw new Error(`private-${SOURCE}`); }, async (port) => {
      const response = await gateRequest(port);
      expect(response).toMatchObject({ status: 500, body: "" });
      expect(JSON.stringify(response)).not.toContain(SOURCE);
      expect(JSON.stringify(response)).not.toContain(`private-${SOURCE}`);
    });
  });
});
