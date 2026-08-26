import { afterEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./test-harness";

let testDatabase: TestDatabase | undefined;

afterEach(() => {
  testDatabase?.close();
  testDatabase = undefined;
});

describe("泛化仓库不进入高后果状态", () => {
  it("不能用 generic item/report mutation 进入 HELD、RETURNED 或 RESOLVED", () => {
    testDatabase = createTestDatabase();
    const { repository } = testDatabase;
    const instance = repository.createDemoInstance();
    const item = repository.listServerInternalFoundItems(instance.demoInstanceId)[0]!;
    const report = repository.createLostReport({
      demoInstanceId: instance.demoInstanceId,
      ownerActorId: "claimant-demo",
      category: "earbuds",
      timeWindow: { from: "2026-08-25T17:00:00.000Z", to: "2026-08-25T19:00:00.000Z" },
      area: "library",
      color: "black",
      publicTags: ["wireless"],
      publicDescription: "Black earbud case.",
    });
    const beforeAudit = repository.listAuditEvents(instance.demoInstanceId).length;

    expect(() => repository.updateFoundItem({
      demoInstanceId: instance.demoInstanceId,
      inventoryItemId: item.inventoryItemId,
      expectedVersion: item.version,
      actorId: "staff-demo",
      patch: { status: "HELD" },
    } as never)).toThrow(expect.objectContaining({ code: "INVALID_STATE_TRANSITION" }));
    expect(() => repository.updateLostReport({
      demoInstanceId: instance.demoInstanceId,
      reportId: report.reportId,
      expectedVersion: report.version,
      actorId: "staff-demo",
      patch: { status: "RESOLVED" },
    } as never)).toThrow(expect.objectContaining({ code: "INVALID_STATE_TRANSITION" }));

    expect(repository.listServerInternalFoundItems(instance.demoInstanceId)[0]).toMatchObject({
      status: "AVAILABLE",
      version: 1,
    });
    expect(repository.getLostReport(instance.demoInstanceId, report.reportId)).toMatchObject({
      status: "DRAFT",
      version: 1,
    });
    expect(repository.getDemoInstance(instance.demoInstanceId).catalogVersion).toBe(1);
    expect(repository.listAuditEvents(instance.demoInstanceId)).toHaveLength(beforeAudit);
  });

  it("不能用 generic claim mutation 审批、签发或收集", () => {
    testDatabase = createTestDatabase();
    const { repository } = testDatabase;
    const instance = repository.createDemoInstance();
    const report = repository.createLostReport({
      demoInstanceId: instance.demoInstanceId,
      ownerActorId: "claimant-demo",
      category: "earbuds",
      timeWindow: { from: "2026-08-25T17:00:00.000Z", to: "2026-08-25T19:00:00.000Z" },
      area: "library",
      color: "black",
      publicTags: ["wireless"],
      publicDescription: "Black earbud case.",
    });
    const item = repository.listServerInternalFoundItems(instance.demoInstanceId)[0]!;
    const claim = repository.createClaim({
      demoInstanceId: instance.demoInstanceId,
      reportId: report.reportId,
      inventoryItemId: item.inventoryItemId,
      claimantActorId: "claimant-demo",
    });
    const review = repository.updateClaim({
      demoInstanceId: instance.demoInstanceId,
      claimId: claim.claimId,
      expectedVersion: claim.version,
      actorId: "claimant-demo",
      patch: { status: "UNDER_REVIEW", evidenceEligible: true },
    });
    const beforeAudit = repository.listAuditEvents(instance.demoInstanceId).length;

    for (const patch of [
      { status: "APPROVED", reviewerActorId: "staff-demo" },
      { status: "PICKUP_READY", passGeneration: 1 },
      { status: "COLLECTED" },
      { reviewerActorId: "staff-demo" },
      { passGeneration: 1 },
    ]) {
      expect(() => repository.updateClaim({
        demoInstanceId: instance.demoInstanceId,
        claimId: claim.claimId,
        expectedVersion: review.version,
        actorId: "staff-demo",
        patch,
      } as never)).toThrow(expect.objectContaining({ code: "INVALID_STATE_TRANSITION" }));
    }
    expect(repository.listServerInternalFoundItems(instance.demoInstanceId)[0]).toMatchObject({
      status: "AVAILABLE",
      version: 1,
    });
    expect(repository.getDemoInstance(instance.demoInstanceId).catalogVersion).toBe(1);
    expect(repository.listAuditEvents(instance.demoInstanceId)).toHaveLength(beforeAudit);
  });
});
