import { Buffer } from "node:buffer";
import { afterEach, describe, expect, it } from "vitest";
import { createCsrfService } from "@/features/auth/csrf";
import { createDemoSessionSigner, DEMO_SESSION_COOKIE } from "@/features/auth/demo-session";
import { resolveAuthenticatedRoute, type AuthenticatedRouteKey } from "@/server/http/authenticated-route-registry";
import { createKeyring } from "@/server/security/keyring";
import { createPersistentRateLimiter } from "@/server/security/rate-limit";
import { createTestDatabase, TEST_MASTER_KEY, type TestDatabase } from "@/server/db/test-harness";
import { parseAppOrigin } from "@/server/http/origin";
import { createReportsRouteHandlers } from "@/app/api/reports/route";
import { createUpdateReportRouteHandler } from "@/app/api/reports/[reportId]/route";
import { createPublishReportRouteHandler } from "@/app/api/reports/[reportId]/publish/route";
import { createArchiveReportRouteHandler } from "@/app/api/reports/[reportId]/archive/route";
import { createMatchesRouteHandler } from "@/app/api/reports/[reportId]/matches/route";
const NOW = Date.UTC(2026, 7, 26, 12);
const SESSION_KEY = Buffer.alloc(32, 101).toString("base64");
const CSRF_KEY = Buffer.alloc(32, 102).toString("base64");
const ORIGIN = "https://example.test";
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
  const dependencies = {
    appOrigin: parseAppOrigin(ORIGIN),
    repository: testDatabase.repository,
    limiter: createPersistentRateLimiter({ database: testDatabase.database, now: () => NOW }),
    sessionSigner,
    csrf,
    keyring: createKeyring(TEST_MASTER_KEY),
    now: () => NOW,
  };
  const cookie = `${DEMO_SESSION_COOKIE}=${signed.token}`;
  return { instance, signed, csrf, dependencies, cookie };
}
function mintCsrf(input: {
  setup: ReturnType<typeof setup>;
  routeKey: AuthenticatedRouteKey;
  path: string;
  oneTime: boolean;
}) {
  const route = resolveAuthenticatedRoute(new Request(`${ORIGIN}${input.path}`, { method: "POST" }), input.routeKey);
  const action = {
    "api.reports.create": "draft_create",
    "api.reports.update": "draft_update",
    "api.reports.publish": "report_publish",
    "api.reports.archive": "report_archive",
  }[input.routeKey as "api.reports.create"];
  return input.setup.csrf.mint({
    sessionId: input.setup.signed.claims.sessionId,
    method: "POST",
    routeId: route.csrfRouteId,
    action,
    oneTime: input.oneTime,
    expiresAt: NOW + 60_000,
  });
}
function writeRequest(path: string, cookie: string, body: URLSearchParams, csrfToken?: string) {
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: {
      host: "example.test",
      origin: ORIGIN,
      "sec-fetch-site": "same-origin",
      cookie,
      ...(csrfToken ? { "x-csrf-token": csrfToken } : {}),
    },
    body,
  });
}
function readRequest(path: string, cookie: string, fetchSite = "same-origin") {
  return new Request(`${ORIGIN}${path}`, {
    headers: { host: "example.test", "sec-fetch-site": fetchSite, cookie },
  });
}
function createBody(overrides: Record<string, string> = {}) {
  return new URLSearchParams({
    category: "earbuds",
    timeFrom: "2026-08-25T17:00:00.000Z",
    timeTo: "2026-08-25T19:00:00.000Z",
    area: "library",
    color: "black",
    publicTags: '["wireless","charging-case"]',
    publicDescription: "Black wireless earbud case.",
    idempotencyKey: "idem-create-00000001",
    ...overrides,
  });
}
async function createDraft(value: ReturnType<typeof setup>, body = createBody()) {
  const token = mintCsrf({ setup: value, routeKey: "api.reports.create", path: "/api/reports", oneTime: false });
  const response = await createReportsRouteHandlers(value.dependencies).POST(
    writeRequest("/api/reports", value.cookie, body, token),
  );
  return { response, json: await response.json() as { reportId: string; version: number; nextPath: string } };
}
describe("report Route Handlers", () => {
  it("creates, owner-lists, updates, publishes, matches, and archives via real boundaries", async () => {
    const value = setup();
    const created = await createDraft(value);
    expect(created.response.status).toBe(201);
    expect(created.response.headers.get("cache-control")).toBe("private, no-store");
    expect(created.json.nextPath).toBe(`/claimant/reports/${created.json.reportId}`);
    const listed = await createReportsRouteHandlers(value.dependencies).GET(
      readRequest("/api/reports", value.cookie),
    );
    expect(listed.status).toBe(200);
    expect((await listed.json()).reports).toHaveLength(1);
    const updatePath = `/api/reports/${created.json.reportId}`;
    const updateToken = mintCsrf({ setup: value, routeKey: "api.reports.update", path: updatePath, oneTime: false });
    const updated = await createUpdateReportRouteHandler(value.dependencies)(writeRequest(
      updatePath,
      value.cookie,
      new URLSearchParams({
        expectedVersion: "1", area: "student-center",
        idempotencyKey: "idem-update-00000001",
      }),
      updateToken,
    ));
    expect(updated.status).toBe(200);
    expect((await updated.json()).version).toBe(2);
    const publishPath = `${updatePath}/publish`;
    const publishToken = mintCsrf({ setup: value, routeKey: "api.reports.publish", path: publishPath, oneTime: true });
    const published = await createPublishReportRouteHandler(value.dependencies)(writeRequest(
      publishPath, value.cookie,
      new URLSearchParams({ csrfToken: publishToken, expectedVersion: "2" }),
    ));
    expect(published.status).toBe(303);
    expect(published.headers.get("location")).toBe(`/claimant/reports/${created.json.reportId}`);
    const matched = await createMatchesRouteHandler(value.dependencies)(readRequest(
      `${updatePath}/matches?limit=2`, value.cookie,
    ));
    expect(matched.status).toBe(200);
    const matchJson = await matched.json();
    expect(matchJson.candidates.length).toBeLessThanOrEqual(2);
    expect(matchJson.candidates[0]?.candidateHandle).toMatch(/^cgch1\./);

    const archivePath = `${updatePath}/archive`;
    const archiveToken = mintCsrf({ setup: value, routeKey: "api.reports.archive", path: archivePath, oneTime: true });
    const archived = await createArchiveReportRouteHandler(value.dependencies)(writeRequest(
      archivePath, value.cookie,
      new URLSearchParams({ csrfToken: archiveToken, expectedVersion: "3" }),
    ));
    expect(archived.status).toBe(303);
  });

  it("rejects strict body duplicates/extras and Staff before business mutation", async () => {
    const claimant = setup();
    const duplicate = createBody();
    duplicate.append("area", "park");
    expect((await createDraft(claimant, duplicate)).response.status).toBe(400);
    expect(testDatabase!.repository.listLostReports(claimant.instance.demoInstanceId)).toHaveLength(0);
    testDatabase!.close();
    testDatabase = undefined;

    const staff = setup("STAFF");
    const response = await createDraft(staff);
    expect(response.response.status).toBe(403);
    expect(testDatabase!.repository.listLostReports(staff.instance.demoInstanceId)).toHaveLength(0);
  });

  it("concurrent same-key create writes once; replay consumes a successful fixed allowance", async () => {
    const value = setup();
    const token = mintCsrf({ setup: value, routeKey: "api.reports.create", path: "/api/reports", oneTime: false });
    const handler = createReportsRouteHandlers(value.dependencies).POST;
    const requests = Array.from({ length: 2 }, () => writeRequest(
      "/api/reports", value.cookie, createBody(), token,
    ));
    const responses = await Promise.all(requests.map((request) => handler(request)));
    expect(responses.map((response) => response.status)).toEqual([201, 201]);
    expect(testDatabase!.repository.listLostReports(value.instance.demoInstanceId)).toHaveLength(1);
    expect(testDatabase!.repository.listAuditEvents(value.instance.demoInstanceId)
      .filter((event) => event.action === "REPORT_CREATED")).toHaveLength(1);
    expect(testDatabase!.database.prepare(`
      SELECT request_count AS requestCount FROM rate_limit_buckets WHERE action = 'draft_create'
    `).get()).toEqual({ requestCount: 2 });
  });

  it("transaction failure leaves no report, audit, idempotency, or quota residue", async () => {
    const value = setup();
    testDatabase!.database.exec(`
      CREATE TRIGGER reject_report_audit
      BEFORE INSERT ON audit_events WHEN NEW.action = 'REPORT_CREATED'
      BEGIN SELECT RAISE(ABORT, 'injected report failure'); END;
    `);
    const failed = await createDraft(value);
    expect(failed.response.status).toBe(500);
    expect(testDatabase!.repository.listLostReports(value.instance.demoInstanceId)).toHaveLength(0);
    expect(testDatabase!.database.prepare("SELECT COUNT(*) AS count FROM idempotency_records").get())
      .toEqual({ count: 0 });
    expect(testDatabase!.database.prepare("SELECT COUNT(*) AS count FROM rate_limit_buckets").get())
      .toEqual({ count: 0 });
    testDatabase!.database.exec("DROP TRIGGER reject_report_audit");
    expect((await createDraft(value)).response.status).toBe(201);
  });

  it("binds one-time CSRF to the concrete report and action", async () => {
    const value = setup();
    const first = await createDraft(value);
    const second = await createDraft(value, createBody({ idempotencyKey: "idem-create-00000002" }));
    const firstPath = `/api/reports/${first.json.reportId}/publish`;
    const token = mintCsrf({ setup: value, routeKey: "api.reports.publish", path: firstPath, oneTime: true });
    const wrongResource = await createPublishReportRouteHandler(value.dependencies)(writeRequest(
      `/api/reports/${second.json.reportId}/publish`, value.cookie,
      new URLSearchParams({ csrfToken: token, expectedVersion: "1" }),
    ));
    expect(wrongResource.status).toBe(403);
    const wrongAction = await createArchiveReportRouteHandler(value.dependencies)(writeRequest(
      `/api/reports/${first.json.reportId}/archive`, value.cookie,
      new URLSearchParams({ csrfToken: token, expectedVersion: "1" }),
    ));
    expect(wrongAction.status).toBe(403);
  });

  it("rejects cross-site GET and keeps every private error/response no-store", async () => {
    const value = setup();
    const response = await createReportsRouteHandlers(value.dependencies).GET(
      readRequest("/api/reports", value.cookie, "cross-site"),
    );
    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("completes auth/path preflight before touching an unauthorized request body", async () => {
    const value = setup();
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls === 1) controller.enqueue(new TextEncoder().encode("category=earbuds"));
        else controller.close();
      },
    });
    const request = new Request(`${ORIGIN}/api/reports`, {
      method: "POST",
      headers: {
        host: "evil.test",
        origin: ORIGIN,
        "sec-fetch-site": "same-origin",
        cookie: value.cookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    await Promise.resolve();
    const pullsBeforeHandler = pulls;
    const response = await createReportsRouteHandlers(value.dependencies).POST(request);
    expect(response.status).toBe(403);
    expect(pulls).toBe(pullsBeforeHandler);
  });

  it("commits the fixed match quota and rejects request N+1", async () => {
    const value = setup();
    const created = await createDraft(value);
    const path = `/api/reports/${created.json.reportId}/publish`;
    const token = mintCsrf({ setup: value, routeKey: "api.reports.publish", path, oneTime: true });
    await createPublishReportRouteHandler(value.dependencies)(writeRequest(
      path, value.cookie, new URLSearchParams({ csrfToken: token, expectedVersion: "1" }),
    ));
    const handler = createMatchesRouteHandler(value.dependencies);
    for (let index = 0; index < 15; index += 1) {
      expect((await handler(readRequest(`/api/reports/${created.json.reportId}/matches`, value.cookie))).status)
        .toBe(200);
    }
    const limited = await handler(readRequest(`/api/reports/${created.json.reportId}/matches`, value.cookie));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeTruthy();
  });

  it("never serializes seeded internal IDs or forbidden match fields", async () => {
    const value = setup();
    const created = await createDraft(value);
    const publishPath = `/api/reports/${created.json.reportId}/publish`;
    const token = mintCsrf({ setup: value, routeKey: "api.reports.publish", path: publishPath, oneTime: true });
    await createPublishReportRouteHandler(value.dependencies)(writeRequest(
      publishPath, value.cookie, new URLSearchParams({ csrfToken: token, expectedVersion: "1" }),
    ));
    const response = await createMatchesRouteHandler(value.dependencies)(readRequest(
      `/api/reports/${created.json.reportId}/matches`, value.cookie,
    ));
    const serialized = await response.text();
    const internalIds = testDatabase!.repository.listServerInternalFoundItems(value.instance.demoInstanceId)
      .map((item) => item.inventoryItemId);
    for (const forbidden of [...internalIds, "inventoryItemId", "candidateId", "foundAt", "score", "publicTags", "publicDescription", "catalogVersion", "reportVersion"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});
