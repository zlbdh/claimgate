import { Buffer } from "node:buffer";
import { afterEach, describe, expect, it } from "vitest";
import { createCsrfService } from "@/features/auth/csrf";
import { createDemoSessionSigner, DEMO_SESSION_COOKIE } from "@/features/auth/demo-session";
import { createTestDatabase, type TestDatabase } from "@/server/db/test-harness";
import { createPersistentRateLimiter } from "@/server/security/rate-limit";
import { INSTANCE_RATE_LIMIT_POLICIES } from "@/server/security/rate-limit-policy";
import { parseAppOrigin } from "./origin";
import {
  createAuthenticatedRequestContext,
  executeAuthorizedMutation,
} from "./request-context";

const SESSION_KEY = Buffer.alloc(32, 31).toString("base64");
const CSRF_KEY = Buffer.alloc(32, 32).toString("base64");
const NOW = Date.UTC(2026, 7, 26, 12);
const APP_ORIGIN = parseAppOrigin("https://example.test");
let testDatabase: TestDatabase | undefined;

afterEach(() => {
  testDatabase?.close();
  testDatabase = undefined;
});

function setup(role: "CLAIMANT" | "STAFF" = "CLAIMANT") {
  testDatabase = createTestDatabase(NOW);
  const instance = testDatabase.repository.createDemoInstance();
  const sessionSigner = createDemoSessionSigner({ key: SESSION_KEY, now: () => NOW });
  const csrf = createCsrfService({ key: CSRF_KEY, now: () => NOW });
  const signed = sessionSigner.mint({
    demoInstanceId: instance.demoInstanceId,
    role,
    expiresAt: instance.expiresAtMs,
  });
  const csrfToken = csrf.mint({
    sessionId: signed.claims.sessionId,
    method: "POST",
    routeId: "api.demo.switch-role",
    action: "role_switch",
    expiresAt: NOW + 60_000,
    oneTime: true,
  });
  const request = new Request("https://example.test/api/demo/switch-role", {
    method: "POST",
    headers: {
      host: "example.test",
      origin: "https://example.test",
      "sec-fetch-site": "same-origin",
      cookie: `${DEMO_SESSION_COOKIE}=${signed.token}`,
    },
  });
  return { instance, sessionSigner, csrf, signed, csrfToken, request };
}

describe("固定顺序 request context", () => {
  it("从签名 cookie 派生冻结 identity/instance/role，不读取 body/query 注入", () => {
    const setupResult = setup();
    const context = createAuthenticatedRequestContext({
      request: setupResult.request,
      appOrigin: APP_ORIGIN,
      sessionSigner: setupResult.sessionSigner,
      csrf: setupResult.csrf,
      csrfToken: setupResult.csrfToken,
      repository: testDatabase!.repository,
      declaration: {
        method: "POST",
        routeId: "api.demo.switch-role",
        action: "role_switch",
      },
    });

    expect(context).toEqual({
      sessionId: setupResult.signed.claims.sessionId,
      demoInstanceId: setupResult.instance.demoInstanceId,
      userId: "claimant-demo",
      role: "CLAIMANT",
      expiresAt: setupResult.instance.expiresAtMs,
      action: "role_switch",
      csrf: expect.objectContaining({ oneTime: true, nonceDigest: expect.any(Buffer) }),
    });
    expect(Object.isFrozen(context)).toBe(true);
  });

  it("role 与实例过期边界由服务端复核", () => {
    const setupResult = setup("CLAIMANT");
    expect(() => createAuthenticatedRequestContext({
      request: setupResult.request,
      appOrigin: APP_ORIGIN,
      sessionSigner: setupResult.sessionSigner,
      csrf: setupResult.csrf,
      csrfToken: setupResult.csrfToken,
      repository: testDatabase!.repository,
      requiredRole: "STAFF",
      declaration: { method: "POST", routeId: "api.demo.switch-role", action: "role_switch" },
    })).toThrow(expect.objectContaining({ code: "FORBIDDEN" }));

    testDatabase!.database.prepare("UPDATE demo_instances SET expires_at_ms = ? WHERE id = ?")
      .run(NOW + 1_000, setupResult.instance.demoInstanceId);
    expect(() => createAuthenticatedRequestContext({
      request: setupResult.request,
      appOrigin: APP_ORIGIN,
      sessionSigner: setupResult.sessionSigner,
      csrf: setupResult.csrf,
      csrfToken: setupResult.csrfToken,
      repository: testDatabase!.repository,
      declaration: { method: "POST", routeId: "api.demo.switch-role", action: "role_switch" },
    })).toThrow(expect.objectContaining({ code: "AUTH_REQUIRED" }));
  });

  it("nonce、instance quota 与 mutation 在同一 outer transaction 回滚", () => {
    const setupResult = setup();
    const limiter = createPersistentRateLimiter({ database: testDatabase!.database, now: () => NOW });
    const context = createAuthenticatedRequestContext({
      request: setupResult.request,
      appOrigin: APP_ORIGIN,
      sessionSigner: setupResult.sessionSigner,
      csrf: setupResult.csrf,
      csrfToken: setupResult.csrfToken,
      repository: testDatabase!.repository,
      declaration: { method: "POST", routeId: "api.demo.switch-role", action: "role_switch" },
    });

    expect(() => executeAuthorizedMutation({
      context,
      repository: testDatabase!.repository,
      limiter,
      policy: INSTANCE_RATE_LIMIT_POLICIES.role_switch,
      mutation: () => { throw new Error("business rollback"); },
    })).toThrow("business rollback");
    expect(testDatabase!.database.prepare("SELECT COUNT(*) AS count FROM consumed_action_nonces").get())
      .toEqual({ count: 0 });
    expect(testDatabase!.database.prepare("SELECT COUNT(*) AS count FROM rate_limit_buckets").get())
      .toEqual({ count: 0 });

    expect(executeAuthorizedMutation({
      context,
      repository: testDatabase!.repository,
      limiter,
      policy: INSTANCE_RATE_LIMIT_POLICIES.role_switch,
      mutation: () => "committed",
    })).toBe("committed");
    expect(() => executeAuthorizedMutation({
      context,
      repository: testDatabase!.repository,
      limiter,
      policy: INSTANCE_RATE_LIMIT_POLICIES.role_switch,
      mutation: () => "replay",
    })).toThrow(expect.objectContaining({ code: "FORBIDDEN" }));
  });
});
