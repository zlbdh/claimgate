import { Buffer } from "node:buffer";
import { afterEach, describe, expect, it } from "vitest";
import { createKeyring } from "@/server/security/keyring";
import { createTestDatabase, type TestDatabase } from "@/server/db/test-harness";
import { createClaimService } from "./claim-service";
import { createPrivateEvidenceRecording } from "@/test/record-private-evidence";

const NOW = Date.UTC(2026, 7, 26, 12);
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
    timeWindow: { from: "2026-08-25T17:00:00Z", to: "2026-08-25T19:00:00Z" },
    area: "library",
    color: "black",
    publicTags: ["wireless"],
    publicDescription: "Evidence service test report.",
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
  const service = createClaimService({ repository, keyring, now: () => NOW });
  return {
    service,
    instance,
    item,
    claim,
    correct: recording.answersFor(item.inventoryItemId),
    claimant: {
      demoInstanceId: instance.demoInstanceId,
      actorId: "claimant-demo" as const,
      sessionExpiresAt: instance.expiresAtMs,
    },
    staff: {
      demoInstanceId: instance.demoInstanceId,
      actorId: "staff-demo" as const,
      sessionExpiresAt: instance.expiresAtMs,
    },
  };
}

function evidence(version: number, key: string, answers: Record<string, string> = {}) {
  return { expectedVersion: version, idempotencyKey: key, answers };
}

describe("ClaimService manual evidence and staff decisions", () => {
  it("commits insufficient evidence, returns only aggregate state, and replays exactly once", () => {
    const value = setup();
    const input = evidence(1, "evidence-submit-000001", { unique_mark: "wrong" });
    const first = value.service.submitEvidence(value.claimant, value.claim.claimId, input);
    const replay = value.service.submitEvidence(value.claimant, value.claim.claimId, input);
    expect(first).toEqual({
      claimId: value.claim.claimId,
      status: "EVIDENCE_REQUIRED",
      version: 2,
      failedAttempts: 1,
      remainingAttempts: 2,
      evidenceEligible: false,
      unlockCount: 0,
      nextPath: `/claimant/claims/${value.claim.claimId}`,
    });
    expect(replay).toEqual(first);
    expect(testDatabase!.database.prepare("SELECT COUNT(*) AS count FROM claim_events").get())
      .toEqual({ count: 1 });
    expect(JSON.stringify(first)).not.toMatch(/answer|slot|salt|digest|item/i);
    expect(() => value.service.submitEvidence(value.claimant, value.claim.claimId, {
      ...input,
      answers: { unique_mark: "changed" },
    })).toThrow(expect.objectContaining({ code: "CONFLICT" }));
  });

  it("moves two correct aggregate answers to UNDER_REVIEW without persisting raw answers", () => {
    const value = setup();
    const result = value.service.submitEvidence(
      value.claimant,
      value.claim.claimId,
      evidence(1, "evidence-submit-eligible", value.correct),
    );
    expect(result).toMatchObject({
      status: "UNDER_REVIEW",
      failedAttempts: 0,
      remainingAttempts: 3,
      evidenceEligible: true,
    });
    const allText = (testDatabase!.database.prepare(`
      SELECT group_concat(CAST(value AS TEXT), '|') AS text FROM (
        SELECT result_json AS value FROM idempotency_records
        UNION ALL SELECT event_type || ':' || result FROM claim_events
      )
    `).get() as { text: string }).text;
    for (const raw of Object.values(value.correct)) expect(allText).not.toContain(raw);
  });

  it("locks on the third failed submission, unlocks once, and denies a second unlock", () => {
    const value = setup();
    let version = 1;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const result = value.service.submitEvidence(
        value.claimant,
        value.claim.claimId,
        evidence(version, `evidence-failure-0000${attempt}`, {}),
      );
      version = result.version;
      expect(result.status).toBe(attempt === 3 ? "LOCKED" : "EVIDENCE_REQUIRED");
      expect(result.failedAttempts).toBe(attempt);
    }
    const unlocked = value.service.unlock(value.staff, value.claim.claimId, {
      expectedClaimVersion: version,
      idempotencyKey: "claim-unlock-000001",
    });
    expect(unlocked).toMatchObject({ status: "EVIDENCE_REQUIRED", failedAttempts: 0, unlockCount: 1 });
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const result = value.service.submitEvidence(value.claimant, value.claim.claimId, evidence(
        unlocked.version + attempt - 1,
        `evidence-second-lock-${attempt}`,
        {},
      ));
      if (attempt === 3) {
        expect(result).toMatchObject({ status: "LOCKED", failedAttempts: 3, unlockCount: 1 });
        expect(() => value.service.unlock(value.staff, value.claim.claimId, {
          expectedClaimVersion: result.version,
          idempotencyKey: "claim-unlock-000002",
        })).toThrow(expect.objectContaining({ code: "INVALID_STATE_TRANSITION" }));
      }
    }
  });

  it("approves and rejects only as Staff with canonical idempotent acknowledgements", () => {
    const approved = setup();
    const review = approved.service.submitEvidence(
      approved.claimant,
      approved.claim.claimId,
      evidence(1, "evidence-for-approval", approved.correct),
    );
    const result = approved.service.approve(approved.staff, approved.claim.claimId, {
      expectedClaimVersion: review.version,
      expectedItemVersion: approved.item.version,
      idempotencyKey: "claim-approve-000001",
    });
    expect(result).toMatchObject({ status: "APPROVED", version: 3, nextPath: expect.stringContaining("/staff/claims/") });
    expect(() => approved.service.approve(approved.claimant, approved.claim.claimId, {
      expectedClaimVersion: 3,
      expectedItemVersion: 2,
      idempotencyKey: "claim-approve-forbidden",
    })).toThrow(expect.objectContaining({ code: "FORBIDDEN" }));

    testDatabase!.close();
    testDatabase = undefined;
    const rejected = setup();
    const rejectedReview = rejected.service.submitEvidence(
      rejected.claimant,
      rejected.claim.claimId,
      evidence(1, "evidence-for-rejection", rejected.correct),
    );
    expect(rejected.service.reject(rejected.staff, rejected.claim.claimId, {
      expectedClaimVersion: rejectedReview.version,
      idempotencyKey: "claim-reject-0000001",
    })).toMatchObject({ status: "REJECTED", rejectionReason: "STAFF_REJECTED" });
  });
});
