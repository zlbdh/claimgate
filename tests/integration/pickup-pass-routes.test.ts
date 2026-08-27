import { Buffer } from "node:buffer";
import { afterEach, describe, expect, it } from "vitest";
import { createIssuePickupPassRouteHandler } from "@/app/api/claims/[claimId]/pickup-pass/issue/route";
import { createReissuePickupPassRouteHandler } from "@/app/api/claims/[claimId]/pickup-pass/reissue/route";
import { createPickupHandoffRouteHandler } from "@/app/api/staff/claims/[claimId]/handoff/route";
import { createCsrfService } from "@/features/auth/csrf";
import { createDemoSessionSigner, DEMO_SESSION_COOKIE } from "@/features/auth/demo-session";
import { createKeyring } from "@/server/security/keyring";
import { createPersistentRateLimiter } from "@/server/security/rate-limit";
import { createTestDatabase, type TestDatabase } from "@/server/db/test-harness";
import { parseAppOrigin } from "@/server/http/origin";

const NOW = 100_000;
const ORIGIN = "https://example.test";
let testDatabase: TestDatabase | undefined;

afterEach(() => {
  testDatabase?.close();
  testDatabase = undefined;
});

function setup() {
  const keyring = createKeyring(Buffer.alloc(32, 7).toString("base64"));
  testDatabase = createTestDatabase(NOW);
  const { repository, database } = testDatabase;
  const instance = repository.createDemoInstance();
  const item = repository.listServerInternalFoundItems(instance.demoInstanceId)[0]!;
  database.prepare(`
    INSERT INTO lost_reports (
      demo_instance_id, id, owner_actor_id, category, time_from, time_to,
      area, color, public_tags_json, public_description, status, version
    ) VALUES (?, 'report-route-pickup', 'claimant-demo', 'earbuds', 'a', 'b',
      'library', 'black', '[]', 'route pickup', 'PUBLISHED', 3)
  `).run(instance.demoInstanceId);
  database.prepare(`UPDATE found_items SET status = 'HELD', version = 4
    WHERE demo_instance_id = ? AND id = ?`).run(instance.demoInstanceId, item.inventoryItemId);
  database.prepare(`
    INSERT INTO claims (
      demo_instance_id, id, report_id, found_item_id, claimant_actor_id,
      status, attempts, evidence_eligible, reviewer_actor_id,
      rejection_reason, unlock_count, pass_generation, version
    ) VALUES (?, 'claim-route-pickup', 'report-route-pickup', ?, 'claimant-demo',
      'APPROVED', 1, 1, 'staff-demo', NULL, 0, 0, 5)
  `).run(instance.demoInstanceId, item.inventoryItemId);
  const sessionSigner = createDemoSessionSigner({
    key: Buffer.alloc(32, 81).toString("base64"), now: () => NOW,
  });
  const csrf = createCsrfService({ key: Buffer.alloc(32, 82).toString("base64"), now: () => NOW });
  const dependencies = {
    appOrigin: parseAppOrigin(ORIGIN), repository,
    limiter: createPersistentRateLimiter({ database, now: () => NOW }),
    sessionSigner, csrf, keyring, now: () => NOW,
  };
  return {
    instance, item, csrf,
    issue: createIssuePickupPassRouteHandler(dependencies),
    reissue: createReissuePickupPassRouteHandler(dependencies),
    handoff: createPickupHandoffRouteHandler(dependencies),
    claimant: sessionSigner.mint({
      demoInstanceId: instance.demoInstanceId, role: "CLAIMANT", expiresAt: instance.expiresAtMs,
    }),
    staff: sessionSigner.mint({
      demoInstanceId: instance.demoInstanceId, role: "STAFF", expiresAt: instance.expiresAtMs,
    }),
  };
}

function csrfToken(
  value: ReturnType<typeof setup>,
  role: "claimant" | "staff",
  action: string,
  path: string,
) {
  return value.csrf.mint({
    sessionId: value[role].claims.sessionId, method: "POST", routeId: path.slice(1),
    action, oneTime: true, expiresAt: NOW + 60_000,
  });
}

function request(path: string, session: string, csrf: string, body: URLSearchParams) {
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: {
      host: "example.test", origin: ORIGIN, "sec-fetch-site": "same-origin",
      cookie: `${DEMO_SESSION_COOKIE}=${session}`,
      "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
      "x-csrf-token": csrf,
    },
    body,
  });
}

describe("pickup issue, reissue and handoff physical routes", () => {
  it("returns the raw token only once with sensitive response headers", async () => {
    const value = setup();
    const path = "/api/claims/claim-route-pickup/pickup-pass/issue";
    const body = new URLSearchParams({
      expectedClaimVersion: "5", idempotencyKey: "route-pickup-issue-1",
    });
    const first = await value.issue(request(
      path, value.claimant.token, csrfToken(value, "claimant", "pickup_issue", path), body,
    ));
    const firstJson = await first.json() as { token: string };
    const replay = await value.issue(request(
      path, value.claimant.token, csrfToken(value, "claimant", "pickup_issue", path), body,
    ));
    expect(first.status).toBe(200);
    expect(firstJson.token).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(first.headers.get("cache-control")).toBe("private, no-store");
    expect(first.headers.get("referrer-policy")).toBe("no-referrer");
    expect(JSON.stringify([...first.headers])).not.toContain(firstJson.token);
    expect(first.url).not.toContain(firstJson.token);
    expect(await replay.json()).not.toHaveProperty("token");
    expect(JSON.stringify(testDatabase!.database.prepare(
      "SELECT * FROM idempotency_records",
    ).all())).not.toContain(firstJson.token);
  });

  it("uses separate reissue and Staff handoff routes and closes all three records", async () => {
    const value = setup();
    const issuePath = "/api/claims/claim-route-pickup/pickup-pass/issue";
    const issue = await value.issue(request(
      issuePath, value.claimant.token, csrfToken(value, "claimant", "pickup_issue", issuePath),
      new URLSearchParams({ expectedClaimVersion: "5", idempotencyKey: "route-pickup-issue-2" }),
    ));
    const oldToken = ((await issue.json()) as { token: string }).token;
    const reissuePath = "/api/claims/claim-route-pickup/pickup-pass/reissue";
    const reissue = await value.reissue(request(
      reissuePath, value.claimant.token,
      csrfToken(value, "claimant", "pickup_reissue", reissuePath),
      new URLSearchParams({ expectedClaimVersion: "6", idempotencyKey: "route-pickup-reissue-1" }),
    ));
    const freshToken = ((await reissue.json()) as { token: string }).token;
    expect(freshToken).not.toBe(oldToken);
    const handoffPath = "/api/staff/claims/claim-route-pickup/handoff";
    const handoffBody = new URLSearchParams({
      token: freshToken, expectedClaimVersion: "7", expectedItemVersion: "4",
      expectedReportVersion: "3", expectedGeneration: "2",
      idempotencyKey: "route-pickup-handoff-1",
    });
    const handoff = await value.handoff(request(
      handoffPath, value.staff.token, csrfToken(value, "staff", "handoff", handoffPath), handoffBody,
    ));
    expect(handoff.status).toBe(200);
    expect(await handoff.json()).toMatchObject({ completion: "COLLECTED" });
    expect(testDatabase!.database.prepare(
      "SELECT status FROM claims WHERE id = 'claim-route-pickup'",
    ).get()).toEqual({ status: "COLLECTED" });
    expect(testDatabase!.database.prepare(
      "SELECT status FROM found_items WHERE demo_instance_id = ? AND id = ?",
    ).get(value.instance.demoInstanceId, value.item.inventoryItemId)).toEqual({ status: "RETURNED" });
    expect(testDatabase!.database.prepare(
      "SELECT status FROM lost_reports WHERE id = 'report-route-pickup'",
    ).get()).toEqual({ status: "RESOLVED" });
  });

  it("rejects role confusion and extra/body-dispatched fields", async () => {
    const value = setup();
    const path = "/api/claims/claim-route-pickup/pickup-pass/issue";
    const body = new URLSearchParams({
      expectedClaimVersion: "5", idempotencyKey: "route-pickup-invalid-1", action: "reissue",
    });
    expect((await value.issue(request(
      path, value.claimant.token, csrfToken(value, "claimant", "pickup_issue", path), body,
    ))).status).toBe(400);
    expect((await value.issue(request(
      path, value.staff.token, csrfToken(value, "staff", "pickup_issue", path),
      new URLSearchParams({ expectedClaimVersion: "5", idempotencyKey: "route-pickup-invalid-2" }),
    ))).status).toBe(403);
  });

  it("rolls nonce and quota back with pass, event and idempotency on a final failure", async () => {
    const value = setup();
    testDatabase!.database.exec(`
      CREATE TRIGGER fail_route_pickup_idempotency BEFORE INSERT ON idempotency_records
      WHEN NEW.action = 'pickup_issue'
      BEGIN SELECT RAISE(ABORT, 'route pickup idempotency failure'); END;
    `);
    const path = "/api/claims/claim-route-pickup/pickup-pass/issue";
    const response = await value.issue(request(
      path, value.claimant.token, csrfToken(value, "claimant", "pickup_issue", path),
      new URLSearchParams({
        expectedClaimVersion: "5", idempotencyKey: "route-pickup-rollback-1",
      }),
    ));
    expect(response.status).toBe(500);
    expect(testDatabase!.database.prepare(
      "SELECT COUNT(*) AS count FROM consumed_action_nonces",
    ).get()).toEqual({ count: 0 });
    expect(testDatabase!.database.prepare(
      "SELECT COUNT(*) AS count FROM rate_limit_buckets",
    ).get()).toEqual({ count: 0 });
    expect(testDatabase!.database.prepare(`
      SELECT status, version, pass_generation AS generation FROM claims
      WHERE id = 'claim-route-pickup'
    `).get()).toEqual({ status: "APPROVED", version: 5, generation: 0 });
    expect(testDatabase!.database.prepare("SELECT COUNT(*) AS count FROM claim_events").get())
      .toEqual({ count: 0 });
    expect(testDatabase!.database.prepare("SELECT COUNT(*) AS count FROM idempotency_records").get())
      .toEqual({ count: 0 });
  });
});
