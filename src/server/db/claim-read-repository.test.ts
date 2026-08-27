import { afterEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./test-harness";

let testDatabase: TestDatabase | undefined;

afterEach(() => {
  testDatabase?.close();
  testDatabase = undefined;
});

describe("bounded redacted claim reads", () => {
  it("returns a Staff queue/review/timeline without internal or evidence fields", () => {
    testDatabase = createTestDatabase();
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
      publicTags: ["wireless"],
      publicDescription: "safe report summary",
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
    repository.recordEvidenceOutcome({
      demoInstanceId: instance.demoInstanceId,
      claimId: claim.claimId,
      claimantActorId: "claimant-demo",
      expectedClaimVersion: claim.version,
      outcome: "ELIGIBLE_FOR_REVIEW",
    });
    const reads = repository;
    const queue = reads.listStaffReviewQueue(instance.demoInstanceId, 50);
    const review = reads.getStaffClaimReview(instance.demoInstanceId, claim.claimId);
    const timeline = reads.listClaimTimeline(instance.demoInstanceId, claim.claimId, 50);
    expect(queue).toEqual([
      expect.objectContaining({
        claimId: claim.claimId,
        failedAttempts: 0,
        waitingDurationMs: 0,
        conflict: false,
        conflictCount: 0,
        item: expect.objectContaining({ category: "earbuds", area: "library", color: "black" }),
      }),
    ]);
    expect(review).toMatchObject({
      claim: {
        claimId: claim.claimId,
        status: "UNDER_REVIEW",
        version: 2,
        failedAttempts: 0,
        evidenceEligible: true,
        unlockCount: 0,
        rejectionReason: null,
      },
      item: expect.objectContaining({ category: "earbuds", itemVersion: 1 }),
      report: expect.objectContaining({ category: "earbuds", status: "PUBLISHED" }),
      conflict: { conflict: false, conflictCount: 0 },
    });
    expect(timeline).toEqual([
      expect.objectContaining({ action: "CLAIM_CREATED", actor: "claimant", result: "CREATED" }),
      expect.objectContaining({ action: "EVIDENCE_ELIGIBLE", actor: "claimant", result: "ELIGIBLE" }),
    ]);
    const serialized = JSON.stringify({ queue, review, timeline });
    for (const forbidden of [
      item.inventoryItemId, "inventoryItemId", "found_item_id", "ownerActorId",
      "slot", "salt", "digest", "raw", "answer",
    ]) expect(serialized).not.toContain(forbidden);
  });
});
