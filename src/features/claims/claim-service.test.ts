import { Buffer } from "node:buffer";
import { afterEach, describe, expect, it } from "vitest";
import { createReportService } from "@/features/reports/report-service";
import { createKeyring } from "@/server/security/keyring";
import { createTestDatabase, type TestDatabase } from "@/server/db/test-harness";
import { createClaimService } from "./claim-service";

const START = Date.UTC(2026, 7, 26, 12);
let testDatabase: TestDatabase | undefined;

afterEach(() => {
  testDatabase?.close();
  testDatabase = undefined;
});

const draftInput = (key: string) => ({
  category: "earbuds",
  timeWindow: { from: "2026-08-25T17:00:00.000Z", to: "2026-08-25T19:00:00.000Z" },
  area: "library",
  color: "black",
  publicTags: ["wireless", "charging-case"],
  publicDescription: "Black wireless earbud case.",
  idempotencyKey: key,
});

function setup() {
  let now = START;
  testDatabase = createTestDatabase(START);
  const instance = testDatabase.repository.createDemoInstance();
  const keyring = createKeyring(Buffer.alloc(32, 7).toString("base64"));
  const context = {
    demoInstanceId: instance.demoInstanceId,
    actorId: "claimant-demo" as const,
    sessionExpiresAt: instance.expiresAtMs,
  };
  const reports = createReportService({ repository: testDatabase.repository, keyring, now: () => now });
  const claims = createClaimService({ repository: testDatabase.repository, keyring, now: () => now });
  const draft = reports.createDraft(context, draftInput("claim-test-create-0001"));
  const published = reports.publish(context, draft.reportId, draft.version);
  const match = reports.findCandidates(context, draft.reportId, 1);
  return {
    context, reports, claims, reportId: draft.reportId,
    reportVersion: published.version,
    handle: match.candidates[0]!.candidateHandle,
    setNow(value: number) { now = value; testDatabase!.setNow(value); },
  };
}

function stageInput(value: ReturnType<typeof setup>, overrides: Record<string, unknown> = {}) {
  return {
    reportId: value.reportId,
    candidateHandle: value.handle,
    expectedVersion: value.reportVersion,
    idempotencyKey: "claim-stage-00000001",
    ...overrides,
  };
}

describe("ClaimService staging boundary", () => {
  it("creates one owner EVIDENCE_REQUIRED claim and exposes only the safe checkpoint DTO", () => {
    const value = setup();
    const result = value.claims.stage(value.context, stageInput(value));
    expect(result).toEqual({
      claimId: expect.any(String),
      status: "EVIDENCE_REQUIRED",
      version: 1,
      remainingAttempts: 3,
      nextPath: expect.stringMatching(/^\/claimant\/claims\//),
    });
    expect(value.claims.getOwned(value.context, result.claimId)).toEqual({
      claimId: result.claimId,
      reportId: value.reportId,
      status: "EVIDENCE_REQUIRED",
      attempts: 0,
      remainingAttempts: 3,
      version: 1,
      nextStep: "Private evidence is a later manual step. No evidence is requested on this checkpoint.",
    });
    const serialized = JSON.stringify(result);
    const internalIds = testDatabase!.repository.listServerInternalFoundItems(value.context.demoInstanceId)
      .map((item) => item.inventoryItemId);
    for (const forbidden of [...internalIds, "inventoryItemId", "foundAt", "score", "catalogVersion"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("replays the original acknowledgement after handle expiry without duplicate claim or audit", () => {
    const value = setup();
    const first = value.claims.stage(value.context, stageInput(value));
    value.setNow(START + 16 * 60_000);
    expect(value.claims.stage(value.context, stageInput(value))).toEqual(first);
    expect(testDatabase!.database.prepare("SELECT COUNT(*) AS count FROM claims").get()).toEqual({ count: 1 });
    expect(testDatabase!.repository.listAuditEvents(value.context.demoInstanceId)
      .filter((event) => event.action === "CLAIM_CREATED")).toHaveLength(1);
  });

  it("binds canonical idempotency to path/report/handle/version and conflicts on changed input", () => {
    const value = setup();
    value.claims.stage(value.context, stageInput(value));
    expect(() => value.claims.stage(value.context, stageInput(value, { expectedVersion: 3 })))
      .toThrow(expect.objectContaining({ code: "CONFLICT" }));
    expect(() => value.claims.stage(value.context, stageInput(value, {
      candidateHandle: value.handle.replace(/.$/, value.handle.endsWith("A") ? "B" : "A"),
    }))).toThrow(expect.objectContaining({ code: "CONFLICT" }));
  });

  it("rejects malformed/tampered/expired/cross-report/stale handles and versions", () => {
    const value = setup();
    expect(() => value.claims.stage(value.context, stageInput(value, { candidateHandle: "bad" })))
      .toThrow(expect.objectContaining({ code: "VALIDATION_FAILED" }));
    const tampered = value.handle.replace(/.$/, value.handle.endsWith("A") ? "B" : "A");
    expect(() => value.claims.stage(value.context, stageInput(value, {
      candidateHandle: tampered, idempotencyKey: "claim-stage-tamper-001",
    }))).toThrow(expect.objectContaining({ code: "STATE_CHANGED" }));
    expect(() => value.claims.stage(value.context, stageInput(value, {
      expectedVersion: value.reportVersion + 1, idempotencyKey: "claim-stage-version-01",
    }))).toThrow(expect.objectContaining({ code: "STATE_CHANGED" }));

    const other = value.reports.createDraft(value.context, draftInput("claim-test-create-0002"));
    value.reports.publish(value.context, other.reportId, other.version);
    expect(() => value.claims.stage(value.context, stageInput(value, {
      reportId: other.reportId, idempotencyKey: "claim-stage-cross-0001",
    }))).toThrow(expect.objectContaining({ code: "STATE_CHANGED" }));

    value.setNow(START + 16 * 60_000);
    expect(() => value.claims.stage(value.context, stageInput(value, {
      idempotencyKey: "claim-stage-expired-01",
    }))).toThrow(expect.objectContaining({ code: "STATE_CHANGED" }));
  });

  it("rejects a handle minted for another instance or a tighter session ceiling", () => {
    const value = setup();
    const otherInstance = testDatabase!.repository.createDemoInstance();
    const otherContext = {
      demoInstanceId: otherInstance.demoInstanceId,
      actorId: "claimant-demo" as const,
      sessionExpiresAt: otherInstance.expiresAtMs,
    };
    const otherDraft = value.reports.createDraft(otherContext, draftInput("claim-test-other-instance"));
    const otherPublished = value.reports.publish(otherContext, otherDraft.reportId, otherDraft.version);
    expect(() => value.claims.stage(otherContext, {
      reportId: otherDraft.reportId,
      candidateHandle: value.handle,
      expectedVersion: otherPublished.version,
      idempotencyKey: "claim-stage-other-instance",
    })).toThrow(expect.objectContaining({ code: "STATE_CHANGED" }));
    expect(() => value.claims.stage({ ...value.context, sessionExpiresAt: START + 60_000 }, {
      ...stageInput(value), idempotencyKey: "claim-stage-short-session",
    })).toThrow(expect.objectContaining({ code: "STATE_CHANGED" }));
  });

  it("preserves ITEM_UNAVAILABLE when availability fails after a valid handle resolution", () => {
    const value = setup();
    const inventoryItemId = value.reports.resolveCandidate(value.context, value.reportId, value.handle);
    testDatabase!.database.prepare("UPDATE found_items SET status = 'HELD' WHERE demo_instance_id = ? AND id = ?")
      .run(value.context.demoInstanceId, inventoryItemId);
    expect(() => testDatabase!.repository.createClaim({
      demoInstanceId: value.context.demoInstanceId,
      reportId: value.reportId,
      inventoryItemId,
      claimantActorId: value.context.actorId,
    })).toThrow(expect.objectContaining({ code: "ITEM_UNAVAILABLE" }));
  });

  it("rejects Staff and a non-owner or non-PUBLISHED report without side effects", () => {
    const value = setup();
    const before = testDatabase!.repository.listAuditEvents(value.context.demoInstanceId).length;
    expect(() => value.claims.stage({ ...value.context, actorId: "staff-demo" }, stageInput(value)))
      .toThrow(expect.objectContaining({ code: "FORBIDDEN" }));
    value.reports.archive(value.context, value.reportId, value.reportVersion);
    expect(() => value.claims.stage(value.context, stageInput(value, {
      idempotencyKey: "claim-stage-archive-01",
    }))).toThrow(expect.objectContaining({ code: "STATE_CHANGED" }));
    expect(testDatabase!.database.prepare("SELECT COUNT(*) AS count FROM claims").get()).toEqual({ count: 0 });
    expect(testDatabase!.repository.listAuditEvents(value.context.demoInstanceId)).toHaveLength(before + 1);
  });

  it("rolls back claim, audit, and idempotency together on final audit failure", () => {
    const value = setup();
    testDatabase!.database.exec(`
      CREATE TRIGGER reject_claim_audit BEFORE INSERT ON audit_events
      WHEN NEW.action = 'CLAIM_CREATED'
      BEGIN SELECT RAISE(ABORT, 'private injected claim failure'); END;
    `);
    expect(() => value.claims.stage(value.context, stageInput(value))).toThrow();
    expect(testDatabase!.database.prepare("SELECT COUNT(*) AS count FROM claims").get()).toEqual({ count: 0 });
    expect(testDatabase!.database.prepare("SELECT COUNT(*) AS count FROM idempotency_records WHERE action = 'claim_stage'").get())
      .toEqual({ count: 0 });
  });
});
