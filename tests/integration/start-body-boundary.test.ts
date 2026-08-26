import { Buffer } from "node:buffer";
import { afterEach, describe, expect, it } from "vitest";
import { createStartRouteHandler } from "@/app/api/demo/start/route";
import { createDemoSessionSigner } from "@/features/auth/demo-session";
import { createTestDatabase, type TestDatabase } from "@/server/db/test-harness";
import { parseAppOrigin } from "@/server/http/origin";
import { createPersistentGlobalRateLimiter } from "@/server/security/global-rate-limit";

const NOW = Date.UTC(2026, 7, 26, 12);
const APP_ORIGIN = parseAppOrigin("https://example.test");
let testDatabase: TestDatabase | undefined;

afterEach(() => {
  testDatabase?.close();
  testDatabase = undefined;
});

function setupStart() {
  testDatabase = createTestDatabase(NOW);
  return createStartRouteHandler({
    appOrigin: APP_ORIGIN,
    repository: testDatabase.repository,
    globalLimiter: createPersistentGlobalRateLimiter({ database: testDatabase.database, now: () => NOW }),
    sessionSigner: createDemoSessionSigner({
      key: Buffer.alloc(32, 93).toString("base64"),
      now: () => NOW,
    }),
    now: () => NOW,
  });
}

function startHeaders(contentType?: string, origin = "https://example.test") {
  const headers: Record<string, string> = {
    host: "example.test",
    origin,
    "sec-fetch-site": "same-origin",
  };
  if (contentType) headers["content-type"] = contentType;
  return headers;
}

describe("strict empty start form", () => {
  it("接受浏览器的严格空 urlencoded form", async () => {
    const start = setupStart();
    const response = await start(new Request("https://example.test/api/demo/start", {
      method: "POST",
      headers: startHeaders("application/x-www-form-urlencoded"),
      body: "",
    }));
    expect(response.status).toBe(303);
    expect(testDatabase!.database.prepare("SELECT COUNT(*) AS count FROM demo_instances").get())
      .toEqual({ count: 1 });
    expect(testDatabase!.database.prepare("SELECT request_count AS count FROM application_rate_limit_buckets").get())
      .toEqual({ count: 1 });
  });

  it.each([
    { type: "application/x-www-form-urlencoded", body: "x=1" },
    { type: "application/json", body: "{}" },
    { type: "multipart/form-data; boundary=x", body: "--x--" },
    { type: "text/plain", body: "" },
    { type: undefined, body: "" },
  ])("拒绝非空/非 urlencoded form：$type/$body", async ({ type, body }) => {
    const start = setupStart();
    const response = await start(new Request("https://example.test/api/demo/start", {
      method: "POST",
      headers: startHeaders(type),
      body,
    }));
    expect(response.status).toBe(400);
    expect(testDatabase!.database.prepare("SELECT COUNT(*) AS count FROM demo_instances").get())
      .toEqual({ count: 0 });
    expect(testDatabase!.database.prepare("SELECT COUNT(*) AS count FROM application_rate_limit_buckets").get())
      .toEqual({ count: 0 });
  });

  it("cross-origin preflight 不读取 body", async () => {
    const start = setupStart();
    const request = new Request("https://example.test/api/demo/start", {
      method: "POST",
      headers: startHeaders("application/x-www-form-urlencoded", "https://evil.test"),
      body: "x=1",
    });
    expect((await start(request)).status).toBe(403);
    expect(request.bodyUsed).toBe(false);
  });
});
