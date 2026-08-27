import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEvidenceRouteHandler } from "@/app/api/claims/[claimId]/evidence/route";
import { createApproveClaimRouteHandler } from "@/app/api/staff/claims/[claimId]/approve/route";
import { createCsrfService } from "@/features/auth/csrf";
import { createDemoSessionSigner, DEMO_SESSION_COOKIE } from "@/features/auth/demo-session";
import { createKeyring } from "@/server/security/keyring";
import { createPersistentRateLimiter } from "@/server/security/rate-limit";
import { createTestDatabase, type TestDatabase } from "@/server/db/test-harness";
import { parseAppOrigin } from "@/server/http/origin";
import { createPrivateEvidenceRecording } from "@/test/record-private-evidence";

const NOW = Date.UTC(2026, 7, 26, 12);
const ORIGIN = "https://example.test";
let testDatabase: TestDatabase | undefined;

afterEach(() => {
  testDatabase?.close();
  testDatabase = undefined;
});

function setup() {
  const keyring = createKeyring(Buffer.alloc(32, 7).toString("base64"));
  const recording = createPrivateEvidenceRecording(keyring);
  testDatabase = createTestDatabase(NOW, { evidenceDigester: recording.digester });
  const repository = testDatabase.repository;
  const instance = repository.createDemoInstance();
  const item = repository.listServerInternalFoundItems(instance.demoInstanceId)[0]!;
  const report = repository.createLostReport({
    demoInstanceId: instance.demoInstanceId,
    ownerActorId: "claimant-demo",
    category: "earbuds",
    timeWindow: { from: "a", to: "b" },
    area: "library",
    color: "black",
    publicTags: [],
    publicDescription: "route test report",
  });
  repository.publishLostReport({
    demoInstanceId: instance.demoInstanceId,
    reportId: report.reportId,
    expectedVersion: report.version,
    actorId: "claimant-demo",
  });
  const claim = repository.createClaim({
    demoInstanceId: instance.demoInstanceId,
    reportId: report.reportId,
    inventoryItemId: item.inventoryItemId,
    claimantActorId: "claimant-demo",
  });
  const sessionSigner = createDemoSessionSigner({
    key: Buffer.alloc(32, 81).toString("base64"), now: () => NOW,
  });
  const csrf = createCsrfService({ key: Buffer.alloc(32, 82).toString("base64"), now: () => NOW });
  const dependencies = {
    appOrigin: parseAppOrigin(ORIGIN),
    repository,
    limiter: createPersistentRateLimiter({ database: testDatabase.database, now: () => NOW }),
    sessionSigner,
    csrf,
    keyring,
    now: () => NOW,
  };
  return {
    claim,
    item,
    correct: recording.answersFor(item.inventoryItemId),
    instance,
    csrf,
    evidence: createEvidenceRouteHandler(dependencies),
    approve: createApproveClaimRouteHandler(dependencies),
    claimant: sessionSigner.mint({
      demoInstanceId: instance.demoInstanceId, role: "CLAIMANT", expiresAt: instance.expiresAtMs,
    }),
    staff: sessionSigner.mint({
      demoInstanceId: instance.demoInstanceId, role: "STAFF", expiresAt: instance.expiresAtMs,
    }),
  };
}

function token(value: ReturnType<typeof setup>, role: "claimant" | "staff", action: string, path: string) {
  return value.csrf.mint({
    sessionId: value[role].claims.sessionId,
    method: "POST",
    routeId: path.slice(1),
    action,
    oneTime: true,
    expiresAt: NOW + 60_000,
  });
}

function request(path: string, session: string, csrfToken: string, body: string, origin = ORIGIN) {
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: {
      host: "example.test",
      origin,
      "sec-fetch-site": "same-origin",
      cookie: `${DEMO_SESSION_COOKIE}=${session}`,
      "content-type": "application/x-www-form-urlencoded",
      "x-csrf-token": csrfToken,
    },
    body,
  });
}

describe("manual evidence and Staff route boundaries", () => {
  it("commits eligible evidence, returns private aggregate JSON, and fresh-token replays once", async () => {
    const value = setup();
    const path = `/api/claims/${value.claim.claimId}/evidence`;
    const raw = Object.values(value.correct).slice(0, 2);
    const body = new URLSearchParams({
      expectedVersion: "1",
      idempotencyKey: "route-evidence-000001",
      unique_mark: raw[0]!,
      contents_or_accessory: raw[1]!,
      identifier_suffix: "",
    }).toString();
    const first = await value.evidence(request(
      path, value.claimant.token, token(value, "claimant", "evidence_submit", path), body,
    ));
    const firstText = await first.text();
    const replay = await value.evidence(request(
      path, value.claimant.token, token(value, "claimant", "evidence_submit", path), body,
    ));
    expect(first.status).toBe(200);
    expect(JSON.parse(firstText)).toMatchObject({ status: "UNDER_REVIEW", failedAttempts: 0 });
    expect(await replay.json()).toEqual(JSON.parse(firstText));
    expect(first.headers.get("cache-control")).toBe("private, no-store");
    for (const answer of raw) expect(firstText).not.toContain(answer);
    expect(testDatabase!.database.prepare("SELECT COUNT(*) AS count FROM claim_events").get())
      .toEqual({ count: 1 });
  });

  it("same-token replay and wrong role fail without extra quota/event writes", async () => {
    const value = setup();
    const path = `/api/claims/${value.claim.claimId}/evidence`;
    const csrfToken = token(value, "claimant", "evidence_submit", path);
    const body = "expectedVersion=1&idempotencyKey=route-evidence-000002";
    expect((await value.evidence(request(path, value.claimant.token, csrfToken, body))).status).toBe(200);
    expect((await value.evidence(request(path, value.claimant.token, csrfToken, body))).status).toBe(403);
    expect((await value.evidence(request(
      path, value.staff.token, token(value, "staff", "evidence_submit", path), body,
    ))).status).toBe(403);
    expect(testDatabase!.database.prepare(`
      SELECT request_count AS count FROM rate_limit_buckets
      WHERE action = 'evidence_submit'
    `).get()).toEqual({ count: 1 });
    expect(testDatabase!.database.prepare("SELECT COUNT(*) AS count FROM claim_events").get())
      .toEqual({ count: 1 });
  });

  it("approves through the separate Staff route and rejects duplicate/extra form fields", async () => {
    const value = setup();
    testDatabase!.database.prepare(`
      UPDATE claims SET status = 'UNDER_REVIEW', evidence_eligible = 1, version = version + 1
      WHERE demo_instance_id = ? AND id = ?
    `).run(value.instance.demoInstanceId, value.claim.claimId);
    const path = `/api/staff/claims/${value.claim.claimId}/approve`;
    const good = new URLSearchParams({
      expectedClaimVersion: "2",
      expectedItemVersion: "1",
      idempotencyKey: "route-approve-0000001",
    }).toString();
    const approved = await value.approve(request(
      path, value.staff.token, token(value, "staff", "claim_approve", path), good,
    ));
    expect(approved.status).toBe(200);
    expect(await approved.json()).toMatchObject({ status: "APPROVED" });
    for (const body of [
      `${good}&expectedItemVersion=1`,
      `${good}&decisionType=approve`,
    ]) {
      const next = setup();
      const nextPath = `/api/staff/claims/${next.claim.claimId}/approve`;
      expect((await next.approve(request(
        nextPath, next.staff.token, token(next, "staff", "claim_approve", nextPath), body,
      ))).status).toBe(400);
      testDatabase!.close();
      testDatabase = undefined;
    }
  });

  it("keeps a raw evidence canary out of every DB table, response, URL, and log", async () => {
    const value = setup();
    const path = `/api/claims/${value.claim.claimId}/evidence`;
    const canary = "route-private-canary-9f82b";
    const body = new URLSearchParams({
      expectedVersion: "1",
      idempotencyKey: "route-canary-0000001",
      unique_mark: canary,
    }).toString();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const sent = request(
      path, value.claimant.token, token(value, "claimant", "evidence_submit", path), body,
    );
    const response = await value.evidence(sent);
    const responseText = await response.text();
    const database = testDatabase!.database;
    const tables = (database.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name
    `).all() as Array<{ name: string }>).map(({ name }) => ({
      name,
      rows: database.prepare(`SELECT * FROM "${name}"`).all(),
    }));
    const inspect = (entry: unknown): boolean => {
      if (typeof entry === "string") return entry.includes(canary);
      if (Buffer.isBuffer(entry)) return entry.includes(Buffer.from(canary));
      if (!entry || typeof entry !== "object") return false;
      return Reflect.ownKeys(entry).some((key) => inspect(key) || inspect(Reflect.get(entry, key)));
    };
    expect(response.status).toBe(200);
    expect(responseText).not.toContain(canary);
    expect(sent.url).not.toContain(canary);
    expect(inspect(tables)).toBe(false);
    expect(inspect([log.mock.calls, error.mock.calls])).toBe(false);
    const fingerprint = database.prepare(`
      SELECT request_fingerprint_digest AS digest FROM idempotency_records
      WHERE action = 'evidence_submit'
    `).get() as { digest: Buffer };
    expect(fingerprint.digest).not.toEqual(createHash("sha256").update(canary).digest());
  });

  it("rejects a cross-origin evidence request before pulling any body byte", async () => {
    const value = setup();
    const path = `/api/claims/${value.claim.claimId}/evidence`;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode("unique_mark=private"));
        controller.close();
      },
    });
    const sent = new Request(`${ORIGIN}${path}`, {
      method: "POST",
      headers: {
        host: "example.test",
        origin: "https://evil.test",
        "sec-fetch-site": "cross-site",
        cookie: `${DEMO_SESSION_COOKIE}=${value.claimant.token}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    expect((await value.evidence(sent)).status).toBe(403);
    expect(sent.bodyUsed).toBe(false);
  });

  it("rolls the physical evidence route nonce and quota back when its event is ignored", async () => {
    const value = setup();
    const database = testDatabase!.database;
    const snapshot = () => ({
      instance: database.prepare("SELECT * FROM demo_instances ORDER BY id").all(),
      item: database.prepare("SELECT * FROM found_items ORDER BY id").all(),
      report: database.prepare("SELECT * FROM lost_reports ORDER BY id").all(),
      claim: database.prepare("SELECT * FROM claims ORDER BY id").all(),
      events: database.prepare("SELECT * FROM claim_events").all(),
      idempotency: database.prepare("SELECT * FROM idempotency_records").all(),
      nonces: database.prepare("SELECT * FROM consumed_action_nonces").all(),
      quota: database.prepare("SELECT * FROM rate_limit_buckets").all(),
    });
    const before = snapshot();
    database.exec(`CREATE TRIGGER ignore_route_evidence_event BEFORE INSERT ON claim_events
      WHEN NEW.event_type = 'EVIDENCE_INSUFFICIENT' BEGIN SELECT RAISE(IGNORE); END`);
    const path = `/api/claims/${value.claim.claimId}/evidence`;
    const response = await value.evidence(request(
      path, value.claimant.token, token(value, "claimant", "evidence_submit", path),
      "expectedVersion=1&idempotencyKey=route-ignore-evidence",
    ));
    expect(response.status).toBe(500);
    expect(snapshot()).toEqual(before);
  });
});
