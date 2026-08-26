import { Buffer } from "node:buffer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCsrfService } from "@/features/auth/csrf";
import { createDemoSessionSigner, DEMO_SESSION_COOKIE } from "@/features/auth/demo-session";
import { createTestDatabase, type TestDatabase } from "@/server/db/test-harness";
import { createPersistentRateLimiter } from "@/server/security/rate-limit";
import { INSTANCE_RATE_LIMIT_POLICIES } from "@/server/security/rate-limit-policy";
import { parseAppOrigin } from "./origin";
import {
  createAuthenticatedRequestContext,
  executeAuthorizedMutation,
  type AuthenticatedRequestContext,
} from "./request-context";

const NOW = Date.UTC(2026, 7, 26, 12);
const SESSION_KEY = Buffer.alloc(32, 81).toString("base64");
const CSRF_KEY = Buffer.alloc(32, 82).toString("base64");
const APP_ORIGIN = parseAppOrigin("https://example.test");
let testDatabase: TestDatabase | undefined;

afterEach(() => {
  testDatabase?.close();
  testDatabase = undefined;
});

function setup(oneTime = true) {
  testDatabase = createTestDatabase(NOW);
  const instance = testDatabase.repository.createDemoInstance();
  const sessionSigner = createDemoSessionSigner({ key: SESSION_KEY, now: () => NOW });
  const csrf = createCsrfService({ key: CSRF_KEY, now: () => NOW });
  const signed = sessionSigner.mint({
    demoInstanceId: instance.demoInstanceId,
    role: "CLAIMANT",
    expiresAt: instance.expiresAtMs,
  });
  const csrfToken = csrf.mint({
    sessionId: signed.claims.sessionId,
    method: "POST",
    routeId: "api.demo.switch-role",
    action: "role_switch",
    expiresAt: NOW + 60_000,
    oneTime,
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
  return { csrf, csrfToken, request, sessionSigner, signed };
}

function createContext(oneTime = true) {
  const value = setup(oneTime);
  return createAuthenticatedRequestContext({
    ...value,
    appOrigin: APP_ORIGIN,
    repository: testDatabase!.repository,
    routeKey: "api.demo.switch-role",
  });
}

describe("reviewer reproductions: closed authorization capability", () => {
  it("role_switch 在 context 创建时拒绝 reusable CSRF", () => {
    expect(() => createContext(false)).toThrow(expect.objectContaining({ code: "FORBIDDEN" }));
  });

  it("未知 route key 无法构造 action/context", () => {
    const value = setup();
    expect(() => createAuthenticatedRequestContext({
      ...value,
      appOrigin: APP_ORIGIN,
      repository: testDatabase!.repository,
      routeKey: "api.demo.start" as never,
    })).toThrow(expect.objectContaining({ code: "CONFIGURATION_ERROR" }));
  });

  it("adapter 的 draft_update policy 被忽略，role_switch 仍严格 10/min", () => {
    const value = setup();
    const limiter = createPersistentRateLimiter({ database: testDatabase!.database, now: () => NOW });
    for (let index = 0; index < 11; index += 1) {
      const csrfToken = value.csrf.mint({
        sessionId: value.signed.claims.sessionId,
        method: "POST",
        routeId: "api.demo.switch-role",
        action: "role_switch",
        expiresAt: NOW + 60_000,
        oneTime: true,
      });
      const context = createAuthenticatedRequestContext({
        ...value,
        csrfToken,
        appOrigin: APP_ORIGIN,
        repository: testDatabase!.repository,
        routeKey: "api.demo.switch-role",
      });
      const adapterInput = {
        context,
        repository: testDatabase!.repository,
        limiter,
        policy: INSTANCE_RATE_LIMIT_POLICIES.draft_update,
        mutation: () => "ok",
      };
      if (index < 10) expect(() => executeAuthorizedMutation(adapterInput)).not.toThrow();
      else expect(() => executeAuthorizedMutation(adapterInput)).toThrow();
    }
    expect(testDatabase!.database.prepare(`
      SELECT limit_value AS limitValue, window_ms AS windowMs
      FROM rate_limit_high_water WHERE action = 'role_switch'
    `).get()).toEqual({ limitValue: 10, windowMs: 60_000 });
    expect(testDatabase!.database.prepare(`
      SELECT request_count AS requestCount FROM rate_limit_buckets WHERE action = 'role_switch'
    `).get()).toEqual({ requestCount: 10 });
  });

  it("executor 拒绝结构相同但不是授权模块签发的 context", () => {
    const context = createContext();
    const forged = Object.freeze({ ...context }) as AuthenticatedRequestContext;
    const mutation = vi.fn(() => "forged");
    expect(() => executeAuthorizedMutation({
      context: forged,
      repository: testDatabase!.repository,
      limiter: createPersistentRateLimiter({ database: testDatabase!.database, now: () => NOW }),
      mutation,
    })).toThrow(expect.objectContaining({ code: "CONFIGURATION_ERROR" }));
    expect(mutation).not.toHaveBeenCalled();
  });

  it("verified nonce identity cannot be mutated before consumption", () => {
    const context = createContext();
    const originalDigest = context.csrf.nonceDigest;
    expect(typeof originalDigest).toBe("string");
    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context.csrf)).toBe(true);
    expect(() => {
      (context as unknown as { action: string }).action = "draft_update";
    }).toThrow(TypeError);
    expect(() => {
      (context.csrf as unknown as { nonceDigest: string }).nonceDigest = "A".repeat(43);
    }).toThrow(TypeError);
    expect(Array.from({ length: 8 }, () => context.csrf.nonceDigest))
      .toEqual(Array.from({ length: 8 }, () => originalDigest));
    executeAuthorizedMutation({
      context,
      repository: testDatabase!.repository,
      limiter: createPersistentRateLimiter({ database: testDatabase!.database, now: () => NOW }),
      mutation: () => "ok",
    });
    const stored = testDatabase!.database.prepare(`
      SELECT nonce_digest AS nonceDigest FROM consumed_action_nonces
    `).get() as { nonceDigest: Buffer };
    expect(stored.nonceDigest.equals(Buffer.from(originalDigest, "base64url"))).toBe(true);
    expect(() => executeAuthorizedMutation({
      context,
      repository: testDatabase!.repository,
      limiter: createPersistentRateLimiter({ database: testDatabase!.database, now: () => NOW }),
      mutation: () => "replay",
    })).toThrow(expect.objectContaining({ code: "FORBIDDEN" }));
  });
});
