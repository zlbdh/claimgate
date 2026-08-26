import { Buffer } from "node:buffer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDemoSessionSigner, DEMO_SESSION_COOKIE } from "@/features/auth/demo-session";
import { createTestDatabase, type TestDatabase } from "@/server/db/test-harness";
import { createPersistentRateLimiter } from "@/server/security/rate-limit";
import { parseAppOrigin } from "./origin";
import { createAuthenticatedReadContext, executeAuthorizedRead } from "./request-context";

const NOW = Date.UTC(2026, 7, 26, 12);
const SESSION_KEY = Buffer.alloc(32, 91).toString("base64");
const APP_ORIGIN = parseAppOrigin("https://example.test");
let testDatabase: TestDatabase | undefined;

afterEach(() => {
  testDatabase?.close();
  testDatabase = undefined;
});

function setup(path = "/api/reports/r1/matches?limit=2") {
  testDatabase = createTestDatabase(NOW);
  const instance = testDatabase.repository.createDemoInstance();
  const sessionSigner = createDemoSessionSigner({ key: SESSION_KEY, now: () => NOW });
  const signed = sessionSigner.mint({
    demoInstanceId: instance.demoInstanceId,
    role: "CLAIMANT",
    expiresAt: instance.expiresAtMs,
  });
  const request = new Request(`https://example.test${path}`, {
    headers: {
      host: "example.test",
      "sec-fetch-site": "same-origin",
      cookie: `${DEMO_SESSION_COOKIE}=${signed.token}`,
    },
  });
  return { instance, sessionSigner, request };
}

describe("authenticated read context", () => {
  it("derives owner identity, concrete report path, and strict query without CSRF", () => {
    const value = setup();
    const context = createAuthenticatedReadContext({
      ...value,
      appOrigin: APP_ORIGIN,
      repository: testDatabase!.repository,
      routeKey: "api.reports.matches",
    });
    expect(context).toMatchObject({
      demoInstanceId: value.instance.demoInstanceId,
      userId: "claimant-demo",
      role: "CLAIMANT",
      action: "match_find",
      params: { reportId: "r1" },
      query: { limit: 2 },
    });
    expect(Object.isFrozen(context)).toBe(true);
  });

  it("rejects present cross-site Fetch Metadata and an unconfigured Host", () => {
    const value = setup();
    for (const headers of [
      { host: "example.test", "sec-fetch-site": "cross-site" },
      { host: "evil.test", "sec-fetch-site": "same-origin" },
    ]) {
      const request = new Request(value.request, { headers: {
        ...headers,
        cookie: value.request.headers.get("cookie")!,
      } });
      expect(() => createAuthenticatedReadContext({
        ...value,
        request,
        appOrigin: APP_ORIGIN,
        repository: testDatabase!.repository,
        routeKey: "api.reports.matches",
      })).toThrow(expect.objectContaining({ code: "FORBIDDEN" }));
    }
  });

  it("commits fixed match quota before inventory/snapshot work, including failed reads", () => {
    const value = setup();
    const context = createAuthenticatedReadContext({
      ...value,
      appOrigin: APP_ORIGIN,
      repository: testDatabase!.repository,
      routeKey: "api.reports.matches",
    });
    const read = vi.fn(() => { throw new Error("snapshot failed"); });
    expect(() => executeAuthorizedRead({
      context,
      limiter: createPersistentRateLimiter({ database: testDatabase!.database, now: () => NOW }),
      read,
    })).toThrow("snapshot failed");
    expect(read).toHaveBeenCalledOnce();
    expect(testDatabase!.database.prepare(`
      SELECT request_count AS requestCount FROM rate_limit_buckets WHERE action = 'match_find'
    `).get()).toEqual({ requestCount: 1 });
  });

  it("list reads require no quota bucket", () => {
    const value = setup("/api/reports");
    const context = createAuthenticatedReadContext({
      ...value,
      appOrigin: APP_ORIGIN,
      repository: testDatabase!.repository,
      routeKey: "api.reports.list",
    });
    expect(executeAuthorizedRead({
      context,
      limiter: createPersistentRateLimiter({ database: testDatabase!.database, now: () => NOW }),
      read: () => "listed",
    })).toBe("listed");
    expect(testDatabase!.database.prepare("SELECT COUNT(*) AS count FROM rate_limit_buckets").get())
      .toEqual({ count: 0 });
  });
});
