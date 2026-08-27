import { afterEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./test-harness";

let testDatabase: TestDatabase | undefined;

afterEach(() => {
  testDatabase?.close();
  testDatabase = undefined;
});

function setupClaim() {
  testDatabase = createTestDatabase();
  const instance = testDatabase.repository.createDemoInstance();
  const item = testDatabase.repository.listServerInternalFoundItems(instance.demoInstanceId)[0]!;
  const report = testDatabase.repository.createLostReport({
    demoInstanceId: instance.demoInstanceId,
    ownerActorId: "claimant-demo",
    category: "earbuds",
    timeWindow: { from: "2026-08-25T17:00:00Z", to: "2026-08-25T19:00:00Z" },
    area: "library",
    color: "black",
    publicTags: ["wireless"],
    publicDescription: "Claim review test report.",
  });
  testDatabase.repository.publishLostReport({
    demoInstanceId: instance.demoInstanceId,
    reportId: report.reportId,
    expectedVersion: report.version,
    actorId: "claimant-demo",
  });
  const claim = testDatabase.repository.createClaim({
    demoInstanceId: instance.demoInstanceId,
    reportId: report.reportId,
    inventoryItemId: item.inventoryItemId,
    claimantActorId: "claimant-demo",
  });
  return { instance, item, report, claim, repository: testDatabase.repository };
}

describe("purpose-specific claim review repository", () => {
  it("applies one aggregate evidence outcome and appends one redacted event", () => {
    const value = setupClaim();
    const context = value.repository.getServerInternalClaimEvidenceContext(
      value.instance.demoInstanceId,
      value.claim.claimId,
    );
    expect(context).toMatchObject({ itemId: value.item.inventoryItemId, claim: { version: 1 } });
    expect(context.slots).toHaveLength(3);
    const updated = value.repository.recordEvidenceOutcome({
      demoInstanceId: value.instance.demoInstanceId,
      claimId: value.claim.claimId,
      claimantActorId: "claimant-demo",
      expectedClaimVersion: value.claim.version,
      outcome: "INSUFFICIENT_EVIDENCE",
    });
    expect(updated).toMatchObject({ status: "EVIDENCE_REQUIRED", failedAttempts: 1, version: 2 });
    expect(testDatabase!.database.prepare(`
      SELECT event_type AS eventType, actor_id AS actorId, result
      FROM claim_events WHERE demo_instance_id = ? AND claim_id = ?
    `).all(value.instance.demoInstanceId, value.claim.claimId)).toEqual([
      { eventType: "EVIDENCE_INSUFFICIENT", actorId: "claimant-demo", result: "INSUFFICIENT" },
    ]);
  });

  it("approves one winner, rejects every active loser, and increments item/catalog once", () => {
    const value = setupClaim();
    const claims = [value.claim];
    for (let index = 0; index < 3; index += 1) {
      const report = testDatabase!.repository.createLostReport({
        demoInstanceId: value.instance.demoInstanceId,
        ownerActorId: "claimant-demo",
        category: "earbuds",
        timeWindow: { from: `from-${index}`, to: `to-${index}` },
        area: "library",
        color: "black",
        publicTags: [],
        publicDescription: `competing report ${index}`,
      });
      testDatabase!.repository.publishLostReport({
        demoInstanceId: value.instance.demoInstanceId,
        reportId: report.reportId,
        expectedVersion: report.version,
        actorId: "claimant-demo",
      });
      claims.push(testDatabase!.repository.createClaim({
        demoInstanceId: value.instance.demoInstanceId,
        reportId: report.reportId,
        inventoryItemId: value.item.inventoryItemId,
        claimantActorId: "claimant-demo",
      }));
    }
    testDatabase!.database.prepare(`
      UPDATE claims SET status = 'UNDER_REVIEW', evidence_eligible = 1, version = version + 1
      WHERE demo_instance_id = ? AND id = ?
    `).run(value.instance.demoInstanceId, claims[0]!.claimId);
    testDatabase!.database.prepare(`
      UPDATE claims SET status = 'UNDER_REVIEW', evidence_eligible = 1, version = version + 1
      WHERE demo_instance_id = ? AND id = ?
    `).run(value.instance.demoInstanceId, claims[2]!.claimId);
    testDatabase!.database.prepare(`
      UPDATE claims SET attempts = 1, version = version + 1
      WHERE demo_instance_id = ? AND id = ?
    `).run(value.instance.demoInstanceId, claims[3]!.claimId);
    testDatabase!.database.prepare(`
      UPDATE claims SET attempts = 2, version = version + 1
      WHERE demo_instance_id = ? AND id = ?
    `).run(value.instance.demoInstanceId, claims[3]!.claimId);
    testDatabase!.database.prepare(`
      UPDATE claims SET status = 'LOCKED', attempts = 3, version = version + 1
      WHERE demo_instance_id = ? AND id = ?
    `).run(value.instance.demoInstanceId, claims[3]!.claimId);

    const approved = value.repository.approveClaim({
      demoInstanceId: value.instance.demoInstanceId,
      claimId: claims[0]!.claimId,
      staffActorId: "staff-demo",
      expectedClaimVersion: 2,
      expectedItemVersion: value.item.version,
    }) as { status: string; version: number };

    expect(approved).toMatchObject({ status: "APPROVED", version: 3 });
    const rows = testDatabase!.database.prepare(`
      SELECT id, status, reviewer_actor_id AS reviewer, rejection_reason AS reason
      FROM claims WHERE demo_instance_id = ? ORDER BY id
    `).all(value.instance.demoInstanceId) as Array<Record<string, unknown>>;
    expect(rows.filter((row) => row.status === "APPROVED")).toHaveLength(1);
    expect(rows.filter((row) => row.status === "REJECTED")).toHaveLength(3);
    expect(rows.filter((row) => row.reason === "ITEM_HELD_BY_ANOTHER_CLAIM")).toHaveLength(3);
    expect(testDatabase!.database.prepare(`
      SELECT status, version FROM found_items WHERE demo_instance_id = ? AND id = ?
    `).get(value.instance.demoInstanceId, value.item.inventoryItemId)).toEqual({ status: "HELD", version: 2 });
    expect(testDatabase!.database.prepare(`
      SELECT catalog_version AS catalogVersion FROM demo_instances WHERE id = ?
    `).get(value.instance.demoInstanceId)).toEqual({ catalogVersion: 2 });
    expect(testDatabase!.database.prepare(`
      SELECT COUNT(*) AS count FROM claim_events WHERE demo_instance_id = ?
    `).get(value.instance.demoInstanceId)).toEqual({ count: 4 });
    expect(testDatabase!.database.prepare(`
      SELECT COUNT(*) AS count FROM lost_reports WHERE demo_instance_id = ? AND status = 'PUBLISHED'
    `).get(value.instance.demoInstanceId)).toEqual({ count: 4 });
  });

  it("rejects UNDER_REVIEW manually and permits only one LOCKED unlock", () => {
    const value = setupClaim();
    testDatabase!.database.prepare(`
      UPDATE claims SET status = 'UNDER_REVIEW', evidence_eligible = 1, version = version + 1
      WHERE demo_instance_id = ? AND id = ?
    `).run(value.instance.demoInstanceId, value.claim.claimId);
    expect(value.repository.rejectClaim({
      demoInstanceId: value.instance.demoInstanceId,
      claimId: value.claim.claimId,
      staffActorId: "staff-demo",
      expectedClaimVersion: 2,
    })).toMatchObject({ status: "REJECTED", rejectionReason: "STAFF_REJECTED" });

    testDatabase!.close();
    testDatabase = undefined;
    const second = setupClaim();
    testDatabase!.database.prepare(`
      UPDATE claims SET attempts = 1, version = version + 1
      WHERE demo_instance_id = ? AND id = ?
    `).run(second.instance.demoInstanceId, second.claim.claimId);
    testDatabase!.database.prepare(`
      UPDATE claims SET attempts = 2, version = version + 1
      WHERE demo_instance_id = ? AND id = ?
    `).run(second.instance.demoInstanceId, second.claim.claimId);
    testDatabase!.database.prepare(`
      UPDATE claims SET status = 'LOCKED', attempts = 3, version = version + 1
      WHERE demo_instance_id = ? AND id = ?
    `).run(second.instance.demoInstanceId, second.claim.claimId);
    expect(second.repository.unlockClaim({
      demoInstanceId: second.instance.demoInstanceId,
      claimId: second.claim.claimId,
      staffActorId: "staff-demo",
      expectedClaimVersion: 4,
    })).toMatchObject({ status: "EVIDENCE_REQUIRED", failedAttempts: 0, unlockCount: 1 });
    testDatabase!.database.prepare(`
      UPDATE claims SET attempts = 1, version = version + 1
      WHERE demo_instance_id = ? AND id = ?
    `).run(second.instance.demoInstanceId, second.claim.claimId);
    testDatabase!.database.prepare(`
      UPDATE claims SET attempts = 2, version = version + 1
      WHERE demo_instance_id = ? AND id = ?
    `).run(second.instance.demoInstanceId, second.claim.claimId);
    testDatabase!.database.prepare(`
      UPDATE claims SET status = 'LOCKED', attempts = 3, version = version + 1
      WHERE demo_instance_id = ? AND id = ?
    `).run(second.instance.demoInstanceId, second.claim.claimId);
    expect(() => second.repository.unlockClaim({
      demoInstanceId: second.instance.demoInstanceId,
      claimId: second.claim.claimId,
      staffActorId: "staff-demo",
      expectedClaimVersion: 8,
    })).toThrow(expect.objectContaining({ code: "INVALID_STATE_TRANSITION" }));
  });
});
