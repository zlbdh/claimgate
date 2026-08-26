import { Buffer } from "node:buffer";
import { afterEach, describe, expect, it } from "vitest";
import { createCsrfService } from "@/features/auth/csrf";
import { createDemoSessionSigner, DEMO_SESSION_COOKIE } from "@/features/auth/demo-session";
import { createStartRouteHandler } from "@/app/api/demo/start/route";
import { createSwitchRoleRouteHandler } from "@/app/api/demo/switch-role/route";
import { createTestDatabase, type TestDatabase } from "@/server/db/test-harness";
import { createPersistentGlobalRateLimiter } from "@/server/security/global-rate-limit";
import { createPersistentRateLimiter } from "@/server/security/rate-limit";
import { parseAppOrigin } from "@/server/http/origin";

const SESSION_KEY = Buffer.alloc(32, 41).toString("base64");
const CSRF_KEY = Buffer.alloc(32, 42).toString("base64");
const NOW = Date.UTC(2026, 7, 26, 12, 0, 30);
const APP_ORIGIN = parseAppOrigin("http://127.0.0.1:3100");
let testDatabase: TestDatabase | undefined;

afterEach(() => {
  testDatabase?.close();
  testDatabase = undefined;
});

function setup() {
  testDatabase = createTestDatabase(NOW);
  const sessionSigner = createDemoSessionSigner({ key: SESSION_KEY, now: () => NOW });
  const csrf = createCsrfService({ key: CSRF_KEY, now: () => NOW });
  const globalLimiter = createPersistentGlobalRateLimiter({
    database: testDatabase.database,
    now: () => NOW,
  });
  const limiter = createPersistentRateLimiter({
    database: testDatabase.database,
    now: () => NOW,
  });
  return {
    sessionSigner,
    csrf,
    globalLimiter,
    limiter,
    start: createStartRouteHandler({
      appOrigin: APP_ORIGIN,
      repository: testDatabase.repository,
      globalLimiter,
      sessionSigner,
      now: () => NOW,
    }),
    switchRole: createSwitchRoleRouteHandler({
      appOrigin: APP_ORIGIN,
      repository: testDatabase.repository,
      limiter,
      sessionSigner,
      csrf,
      now: () => NOW,
    }),
  };
}

function startRequest(overrides: Record<string, string> = {}) {
  return new Request("http://127.0.0.1:3100/api/demo/start", {
    method: "POST",
    headers: {
      host: "127.0.0.1:3100",
      origin: "http://127.0.0.1:3100",
      "sec-fetch-site": "same-origin",
      "content-type": "application/x-www-form-urlencoded",
      ...overrides,
    },
    body: "",
  });
}

function cookieValue(setCookie: string): string {
  const match = new RegExp(`^${DEMO_SESSION_COOKIE}=([^;]+)`).exec(setCookie);
  if (!match) throw new Error("missing session cookie");
  return match[1];
}

function switchRequest(token: string, csrfToken: string, extra: Record<string, string> = {}) {
  const body = new URLSearchParams({ csrfToken, targetRole: "STAFF", ...extra });
  return new Request("http://127.0.0.1:3100/api/demo/switch-role", {
    method: "POST",
    headers: {
      host: "127.0.0.1:3100",
      origin: "http://127.0.0.1:3100",
      "sec-fetch-site": "same-origin",
      cookie: `${DEMO_SESSION_COOKIE}=${token}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  });
}

describe("真实 Route Handler 授权集成", () => {
  it("start 先消耗全局额度，再 clone，直发 host-only cookie 并 303 到 /", async () => {
    const runtime = setup();
    const response = await runtime.start(startRequest());
    const body = await response.text();
    const setCookie = response.headers.get("set-cookie") ?? "";
    const claims = runtime.sessionSigner.verify(cookieValue(setCookie));

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).not.toContain("Secure");
    expect(setCookie).not.toContain("Domain=");
    expect(body).toBe("");
    expect(response.headers.get("location")).not.toMatch(/cookie|token|csrf|session/i);
    expect(claims).toMatchObject({ role: "CLAIMANT", userId: "claimant-demo" });
    expect(testDatabase!.repository.getDemoInstance(claims.demoInstanceId).expiresAtMs)
      .toBe(claims.expiresAt);
    expect(testDatabase!.database.prepare(`
      SELECT request_count AS count FROM application_rate_limit_buckets
    `).get()).toEqual({ count: 1 });
  });

  it("全局额度耗尽时不创建实例，并返回 bounded 429/Retry-After", async () => {
    const runtime = setup();
    for (let index = 0; index < 30; index += 1) {
      runtime.globalLimiter.consume();
    }
    const response = await runtime.start(startRequest());

    expect(response.status).toBe(429);
    expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await response.json()).toEqual({
      error: { code: "RATE_LIMITED", message: expect.any(String) },
    });
    expect(testDatabase!.database.prepare("SELECT COUNT(*) AS count FROM demo_instances").get())
      .toEqual({ count: 0 });
  });

  it("session mint 失败时全局 bucket 与 instance 一起回滚，unknown error 仍 bounded", async () => {
    const runtime = setup();
    const start = createStartRouteHandler({
      appOrigin: APP_ORIGIN,
      repository: testDatabase!.repository,
      globalLimiter: runtime.globalLimiter,
      sessionSigner: {
        ...runtime.sessionSigner,
        mint() { throw new Error("private signing detail"); },
      },
      now: () => NOW,
    });
    const response = await start(startRequest());
    const text = await response.text();

    expect(response.status).toBe(500);
    expect(text).toBe('{"error":{"code":"INTERNAL_ERROR","message":"Internal server error."}}');
    expect(text).not.toContain("private signing detail");
    expect(testDatabase!.database.prepare("SELECT COUNT(*) AS count FROM demo_instances").get())
      .toEqual({ count: 0 });
    expect(testDatabase!.database.prepare("SELECT COUNT(*) AS count FROM application_rate_limit_buckets").get())
      .toEqual({ count: 0 });
  });

  it("switch 用 one-time CSRF 同事务消费 nonce/quota，旋转 cookie 且不延寿", async () => {
    const runtime = setup();
    const startResponse = await runtime.start(startRequest());
    const claimantToken = cookieValue(startResponse.headers.get("set-cookie") ?? "");
    const claimant = runtime.sessionSigner.verify(claimantToken);
    const csrfToken = runtime.csrf.mint({
      sessionId: claimant.sessionId,
      method: "POST",
      routeId: "api.demo.switch-role",
      action: "role_switch",
      expiresAt: NOW + 60_000,
      oneTime: true,
    });
    const response = await runtime.switchRole(switchRequest(claimantToken, csrfToken));
    const setCookie = response.headers.get("set-cookie") ?? "";
    const staff = runtime.sessionSigner.verify(cookieValue(setCookie));

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/");
    expect(await response.text()).toBe("");
    expect(staff).toMatchObject({
      demoInstanceId: claimant.demoInstanceId,
      expiresAt: claimant.expiresAt,
      role: "STAFF",
      userId: "staff-demo",
    });
    expect(staff.sessionId).not.toBe(claimant.sessionId);
    expect(testDatabase!.database.prepare("SELECT COUNT(*) AS count FROM consumed_action_nonces").get())
      .toEqual({ count: 1 });
    expect(testDatabase!.database.prepare(`
      SELECT request_count AS count FROM rate_limit_buckets WHERE action = 'role_switch'
    `).get()).toEqual({ count: 1 });
  });

  it("同一 one-time token 并发 replay 仅一成功，失败不额外消费额度", async () => {
    const runtime = setup();
    const startResponse = await runtime.start(startRequest());
    const token = cookieValue(startResponse.headers.get("set-cookie") ?? "");
    const claims = runtime.sessionSigner.verify(token);
    const csrfToken = runtime.csrf.mint({
      sessionId: claims.sessionId,
      method: "POST",
      routeId: "api.demo.switch-role",
      action: "role_switch",
      expiresAt: NOW + 60_000,
      oneTime: true,
    });
    const responses = await Promise.all([
      runtime.switchRole(switchRequest(token, csrfToken)),
      runtime.switchRole(switchRequest(token, csrfToken)),
    ]);

    expect(responses.map(({ status }) => status).sort()).toEqual([303, 403]);
    expect(testDatabase!.database.prepare(`
      SELECT request_count AS count FROM rate_limit_buckets WHERE action = 'role_switch'
    `).get()).toEqual({ count: 1 });
  });

  it("invalid CSRF 和 identity 注入不消耗 victim bucket/nonce", async () => {
    const runtime = setup();
    const startResponse = await runtime.start(startRequest());
    const token = cookieValue(startResponse.headers.get("set-cookie") ?? "");
    const invalid = await runtime.switchRole(switchRequest(token, "invalid"));
    const injected = await runtime.switchRole(switchRequest(token, "invalid", {
      userId: "attacker",
      demoInstanceId: "other",
      role: "STAFF",
    }));

    expect(invalid.status).toBe(403);
    expect(injected.status).toBe(400);
    expect(testDatabase!.database.prepare("SELECT COUNT(*) AS count FROM rate_limit_buckets").get())
      .toEqual({ count: 0 });
    expect(testDatabase!.database.prepare("SELECT COUNT(*) AS count FROM consumed_action_nonces").get())
      .toEqual({ count: 0 });
  });
});

describe("路由导出没有安全副作用方法", () => {
  it("start/switch 只导出 POST factory，不暴露 GET/HEAD/OPTIONS mutation", async () => {
    const [startModule, switchModule] = await Promise.all([
      import("@/app/api/demo/start/route"),
      import("@/app/api/demo/switch-role/route"),
    ]);
    for (const routeExports of [startModule, switchModule]) {
      expect(routeExports).not.toHaveProperty("GET");
      expect(routeExports).not.toHaveProperty("HEAD");
      expect(routeExports).not.toHaveProperty("OPTIONS");
      expect(routeExports).toHaveProperty("POST");
    }
  });
});
