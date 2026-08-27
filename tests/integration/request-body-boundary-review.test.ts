import { Buffer } from "node:buffer";
import { afterEach, describe, expect, it } from "vitest";
import { createSwitchRoleRouteHandler } from "@/app/api/demo/switch-role/route";
import { createCsrfService } from "@/features/auth/csrf";
import { createDemoSessionSigner, DEMO_SESSION_COOKIE } from "@/features/auth/demo-session";
import { createTestDatabase, type TestDatabase } from "@/server/db/test-harness";
import { parseAppOrigin } from "@/server/http/origin";
import { createPersistentRateLimiter } from "@/server/security/rate-limit";

const NOW = Date.UTC(2026, 7, 26, 12);
const APP_ORIGIN = parseAppOrigin("https://example.test");
let testDatabase: TestDatabase | undefined;

afterEach(() => {
  testDatabase?.close();
  testDatabase = undefined;
});

function setup() {
  testDatabase = createTestDatabase(NOW);
  const instance = testDatabase.repository.createDemoInstance();
  const sessionSigner = createDemoSessionSigner({
    key: Buffer.alloc(32, 91).toString("base64"),
    now: () => NOW,
  });
  const csrf = createCsrfService({ key: Buffer.alloc(32, 92).toString("base64"), now: () => NOW });
  const signed = sessionSigner.mint({
    demoInstanceId: instance.demoInstanceId,
    role: "CLAIMANT",
    expiresAt: instance.expiresAtMs,
  });
  return {
    csrf,
    signed,
    switchRole: createSwitchRoleRouteHandler({
      appOrigin: APP_ORIGIN,
      repository: testDatabase.repository,
      limiter: createPersistentRateLimiter({ database: testDatabase.database, now: () => NOW }),
      sessionSigner,
      csrf,
      now: () => NOW,
    }),
  };
}

function streamedRequest(input: {
  url: string;
  method: string;
  headers: Record<string, string>;
  chunks: Uint8Array[];
}) {
  let bytesRead = 0;
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = input.chunks[index++];
      if (!chunk) return controller.close();
      bytesRead += chunk.byteLength;
      controller.enqueue(chunk);
    },
  });
  const request = new Request(input.url, {
    method: input.method,
    headers: input.headers,
    body,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  return { request, bytesRead: () => bytesRead };
}

function switchHeaders(token: string, origin = "https://example.test") {
  return {
    host: "example.test",
    origin,
    "sec-fetch-site": "same-origin",
    cookie: `${DEMO_SESSION_COOKIE}=${token}`,
    "content-type": "application/x-www-form-urlencoded",
  };
}

describe("reviewer reproductions: body-free preflight and bounded forms", () => {
  it("cross-origin switch preflight fails without pulling the body stream", async () => {
    const runtime = setup();
    const counted = streamedRequest({
      url: "https://example.test/api/demo/switch-role",
      method: "POST",
      headers: switchHeaders(runtime.signed.token, "https://evil.test"),
      chunks: [new TextEncoder().encode("csrfToken=secret&targetRole=STAFF")],
    });
    expect((await runtime.switchRole(counted.request)).status).toBe(403);
    expect(counted.request.bodyUsed).toBe(false);
  });

  it("actual chunked overflow stops at the 4 KiB application boundary", async () => {
    const runtime = setup();
    const csrfToken = runtime.csrf.mint({
      sessionId: runtime.signed.claims.sessionId,
      method: "POST",
      routeId: "api.demo.switch-role",
      action: "role_switch",
      expiresAt: NOW + 60_000,
      oneTime: true,
    });
    const prefix = new TextEncoder().encode(`csrfToken=${csrfToken}&targetRole=STAFF&pad=`);
    const counted = streamedRequest({
      url: "https://example.test/api/demo/switch-role",
      method: "POST",
      headers: { ...switchHeaders(runtime.signed.token), "content-length": "1" },
      chunks: [prefix, new Uint8Array(4_096), new Uint8Array(4_096)],
    });
    expect((await runtime.switchRole(counted.request)).status).toBe(400);
    expect(counted.bytesRead()).toBeLessThanOrEqual(4_096 + prefix.byteLength);
  });

  it("declared overflow 在读取 body 前拒绝", async () => {
    const runtime = setup();
    const counted = streamedRequest({
      url: "https://example.test/api/demo/switch-role",
      method: "POST",
      headers: { ...switchHeaders(runtime.signed.token), "content-length": "4097" },
      chunks: [new TextEncoder().encode("csrfToken=x&targetRole=STAFF")],
    });
    expect((await runtime.switchRole(counted.request)).status).toBe(400);
    expect(counted.request.bodyUsed).toBe(false);
  });

  it.each([
    { name: "wrong method", method: "PUT", suffix: "", origin: "https://example.test", cookie: true, status: 403 },
    { name: "wrong path", method: "POST", suffix: "/other", origin: "https://example.test", cookie: true, status: 403 },
    { name: "query", method: "POST", suffix: "?role=STAFF", origin: "https://example.test", cookie: true, status: 403 },
    { name: "cross origin", method: "POST", suffix: "", origin: "https://evil.test", cookie: true, status: 403 },
    { name: "bad session", method: "POST", suffix: "", origin: "https://example.test", cookie: false, status: 401 },
  ])("$name preflight 不消费 body", async ({ method, suffix, origin, cookie, status }) => {
    const runtime = setup();
    const headers = switchHeaders(cookie ? runtime.signed.token : "invalid", origin);
    const counted = streamedRequest({
      url: `https://example.test/api/demo/switch-role${suffix}`,
      method,
      headers,
      chunks: [new TextEncoder().encode("csrfToken=secret&targetRole=STAFF")],
    });
    expect((await runtime.switchRole(counted.request)).status).toBe(status);
    expect(counted.request.bodyUsed).toBe(false);
  });

  it.each([
    { type: "application/json", body: "{}" },
    { type: "multipart/form-data; boundary=x", body: "--x--" },
    { type: "text/plain", body: "csrfToken=x&targetRole=STAFF" },
  ])("switch 拒绝 $type 且不调用 formData", async ({ type, body }) => {
    const runtime = setup();
    const request = new Request("https://example.test/api/demo/switch-role", {
      method: "POST",
      headers: { ...switchHeaders(runtime.signed.token), "content-type": type },
      body,
    });
    Object.defineProperty(request, "formData", {
      value() { throw new Error("formData must not run"); },
    });
    expect((await runtime.switchRole(request)).status).toBe(400);
    expect(request.bodyUsed).toBe(false);
  });

  it("switch 缺失 Content-Type 时不读取 body", async () => {
    const runtime = setup();
    const headers = switchHeaders(runtime.signed.token);
    delete (headers as Partial<typeof headers>)["content-type"];
    const request = new Request("https://example.test/api/demo/switch-role", {
      method: "POST",
      headers,
      body: "csrfToken=x&targetRole=STAFF",
    });
    expect((await runtime.switchRole(request)).status).toBe(400);
    expect(request.bodyUsed).toBe(false);
  });

  it("fatal UTF-8 与 malformed percent encoding 都在 transaction 前拒绝", async () => {
    for (const chunks of [
      [Uint8Array.from([0xc3, 0x28])],
      [new TextEncoder().encode("csrfToken=%C3%28&targetRole=STAFF")],
      [new TextEncoder().encode("csrfToken=%ZZ&targetRole=STAFF")],
    ]) {
      const runtime = setup();
      const counted = streamedRequest({
        url: "https://example.test/api/demo/switch-role",
        method: "POST",
        headers: switchHeaders(runtime.signed.token),
        chunks,
      });
      expect((await runtime.switchRole(counted.request)).status).toBe(400);
      expect(testDatabase!.database.prepare("SELECT COUNT(*) AS count FROM rate_limit_buckets").get())
        .toEqual({ count: 0 });
      testDatabase!.close();
      testDatabase = undefined;
    }
  });

  it("switch 接受字段逆序，不调用 Request.formData", async () => {
    const runtime = setup();
    const csrfToken = runtime.csrf.mint({
      sessionId: runtime.signed.claims.sessionId,
      method: "POST",
      routeId: "api.demo.switch-role",
      action: "role_switch",
      expiresAt: NOW + 60_000,
      oneTime: true,
    });
    const request = new Request("https://example.test/api/demo/switch-role", {
      method: "POST",
      headers: switchHeaders(runtime.signed.token),
      body: `targetRole=STAFF&csrfToken=${encodeURIComponent(csrfToken)}`,
    });
    Object.defineProperty(request, "formData", {
      value() { throw new Error("formData must not run"); },
    });
    expect((await runtime.switchRole(request)).status).toBe(303);
  });

  it.each([
    "csrfToken=x&csrfToken=y&targetRole=STAFF",
    "csrfToken=x&targetRole=STAFF&userId=attacker",
    "csrfToken=x&targetRole=STAFF&resumeClaimId=a&resumeClaimId=b",
    "csrfToken=x&targetRole=STAFF&resumeClaimId=a&returnTo=https%3A%2F%2Fevil.test",
    "csrfToken=x&targetRole=CLAIMANT",
    "csrfToken=x&targetRole=STAFF&targetRole=CLAIMANT",
    "csrfToken=x",
  ])("switch 拒绝 duplicate/extra/no-op/missing form：%s", async (body) => {
    const runtime = setup();
    const response = await runtime.switchRole(new Request("https://example.test/api/demo/switch-role", {
      method: "POST",
      headers: switchHeaders(runtime.signed.token),
      body,
    }));
    expect(response.status).toBe(400);
    expect(testDatabase!.database.prepare("SELECT COUNT(*) AS count FROM rate_limit_buckets").get())
      .toEqual({ count: 0 });
    expect(testDatabase!.database.prepare("SELECT COUNT(*) AS count FROM consumed_action_nonces").get())
      .toEqual({ count: 0 });
  });

});
