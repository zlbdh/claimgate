import { Buffer } from "node:buffer";
import { afterEach, describe, expect, it } from "vitest";
import { createClaimsRouteHandler } from "@/app/api/claims/route";
import { createCsrfService } from "@/features/auth/csrf";
import { createDemoSessionSigner, DEMO_SESSION_COOKIE } from "@/features/auth/demo-session";
import { createReportService } from "@/features/reports/report-service";
import { createTestDatabase, TEST_MASTER_KEY, type TestDatabase } from "@/server/db/test-harness";
import { createKeyring } from "@/server/security/keyring";
import { createPersistentRateLimiter } from "@/server/security/rate-limit";
import { parseAppOrigin } from "@/server/http/origin";

const NOW = Date.UTC(2026, 7, 26, 12);
const ORIGIN = "https://example.test";
const SESSION_KEY = Buffer.alloc(32, 81).toString("base64");
const CSRF_KEY = Buffer.alloc(32, 82).toString("base64");
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
  const keyring = createKeyring(TEST_MASTER_KEY);
  const signed = sessionSigner.mint({ demoInstanceId: instance.demoInstanceId, role, expiresAt: instance.expiresAtMs });
  const dependencies = {
    appOrigin: parseAppOrigin(ORIGIN), repository: testDatabase.repository,
    limiter: createPersistentRateLimiter({ database: testDatabase.database, now: () => NOW }),
    sessionSigner, csrf, keyring, now: () => NOW,
  };
  const actor = { demoInstanceId: instance.demoInstanceId, actorId: "claimant-demo" as const, sessionExpiresAt: instance.expiresAtMs };
  const reports = createReportService({ repository: testDatabase.repository, keyring, now: () => NOW });
  const draft = reports.createDraft(actor, {
    category: "earbuds", timeWindow: { from: "2026-08-25T17:00:00.000Z", to: "2026-08-25T19:00:00.000Z" },
    area: "library", color: "black", publicTags: ["wireless"], publicDescription: "Black earbud case.",
    idempotencyKey: "route-create-00000001",
  });
  const published = reports.publish(actor, draft.reportId, draft.version);
  const handle = reports.findCandidates(actor, draft.reportId, 1).candidates[0]!.candidateHandle;
  const token = csrf.mint({
    sessionId: signed.claims.sessionId, method: "POST", routeId: `claims/${draft.reportId}`,
    action: "claim_stage", oneTime: false, expiresAt: NOW + 60_000,
  });
  return {
    instance, dependencies, cookie: `${DEMO_SESSION_COOKIE}=${signed.token}`,
    reportId: draft.reportId, reportVersion: published.version, handle, token,
  };
}

function body(value: ReturnType<typeof setup>, overrides: Record<string, unknown> = {}) {
  return {
    reportId: value.reportId, candidateHandle: value.handle,
    expectedVersion: value.reportVersion, idempotencyKey: "route-stage-00000001", ...overrides,
  };
}

function request(value: ReturnType<typeof setup>, payload: unknown, token = value.token) {
  return new Request(`${ORIGIN}/api/claims`, {
    method: "POST",
    headers: {
      host: "example.test", origin: ORIGIN, "sec-fetch-site": "same-origin",
      cookie: value.cookie, "content-type": "application/json", "x-csrf-token": token,
    },
    body: JSON.stringify(payload),
  });
}

describe("POST /api/claims", () => {
  it("stages through auth, report-bound reusable CSRF, quota, service, and SQLite", async () => {
    const value = setup();
    const response = await createClaimsRouteHandler(value.dependencies)(request(value, body(value)));
    const result = await response.json();
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(result).toMatchObject({ status: "EVIDENCE_REQUIRED", remainingAttempts: 3, version: 1 });
    expect(result.nextPath).toBe(`/claimant/claims/${result.claimId}`);
    expect(testDatabase!.database.prepare("SELECT request_count AS count FROM rate_limit_buckets WHERE action = 'claim_stage'").get())
      .toEqual({ count: 1 });
  });

  it("rejects malformed/extra JSON and a CSRF token bound to another report", async () => {
    const value = setup();
    expect((await createClaimsRouteHandler(value.dependencies)(request(value, { ...body(value), extra: true }))).status)
      .toBe(400);
    const wrong = value.dependencies.csrf.mint({
      sessionId: value.dependencies.sessionSigner.verify(value.cookie.split("=")[1]!).sessionId,
      method: "POST", routeId: "claims/other-report", action: "claim_stage",
      oneTime: false, expiresAt: NOW + 60_000,
    });
    expect((await createClaimsRouteHandler(value.dependencies)(request(value, body(value, {
      idempotencyKey: "route-stage-wrong-001",
    }), wrong))).status).toBe(403);
    expect(testDatabase!.database.prepare("SELECT COUNT(*) AS count FROM claims").get()).toEqual({ count: 0 });
  });

  it("rejects Staff/path/origin before reading the body stream", async () => {
    const value = setup("STAFF");
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new TextEncoder().encode("{}"));
        controller.close();
      },
    });
    const unauthorized = new Request(`${ORIGIN}/api/claims`, {
      method: "POST",
      headers: { host: "example.test", origin: ORIGIN, "sec-fetch-site": "same-origin", cookie: value.cookie, "content-type": "application/json" },
      body: stream, duplex: "half",
    } as RequestInit & { duplex: "half" });
    await Promise.resolve();
    const before = pulls;
    expect((await createClaimsRouteHandler(value.dependencies)(unauthorized)).status).toBe(403);
    expect(pulls).toBe(before);
  });

  it("concurrent same-key calls create one claim/audit but charge both fixed attempts", async () => {
    const value = setup();
    const handler = createClaimsRouteHandler(value.dependencies);
    const responses = await Promise.all([
      handler(request(value, body(value))), handler(request(value, body(value))),
    ]);
    expect(responses.map((response) => response.status)).toEqual([201, 201]);
    expect(testDatabase!.database.prepare("SELECT COUNT(*) AS count FROM claims").get()).toEqual({ count: 1 });
    expect(testDatabase!.repository.listAuditEvents(value.instance.demoInstanceId)
      .filter((event) => event.action === "CLAIM_CREATED")).toHaveLength(1);
    expect(testDatabase!.database.prepare("SELECT request_count AS count FROM rate_limit_buckets WHERE action = 'claim_stage'").get())
      .toEqual({ count: 2 });
  });

  it("rolls quota, claim, idempotency, and audit back together on final failure", async () => {
    const value = setup();
    testDatabase!.database.exec(`
      CREATE TRIGGER reject_claim_audit BEFORE INSERT ON audit_events
      WHEN NEW.action = 'CLAIM_CREATED'
      BEGIN SELECT RAISE(ABORT, 'private failure'); END;
    `);
    const response = await createClaimsRouteHandler(value.dependencies)(request(value, body(value)));
    expect(response.status).toBe(500);
    expect(testDatabase!.database.prepare("SELECT COUNT(*) AS count FROM claims").get()).toEqual({ count: 0 });
    expect(testDatabase!.database.prepare("SELECT COUNT(*) AS count FROM idempotency_records WHERE action = 'claim_stage'").get())
      .toEqual({ count: 0 });
    expect(testDatabase!.database.prepare("SELECT COUNT(*) AS count FROM rate_limit_buckets WHERE action = 'claim_stage'").get())
      .toEqual({ count: 0 });
    expect(await response.text()).not.toContain("private failure");
  });
});
