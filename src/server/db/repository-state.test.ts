import { afterEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./test-harness";

let testDatabase: TestDatabase | undefined;

afterEach(() => {
  testDatabase?.close();
  testDatabase = undefined;
});

describe("仓库状态写入守卫", () => {
  it("拒绝 report、item、claim 的跳跃状态且不推进版本或审计", () => {
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
    const claimReport = repository.createLostReport({
      demoInstanceId: instance.demoInstanceId,
      ownerActorId: "claimant-demo",
      category: "earbuds",
      timeWindow: { from: "2026-08-25T17:00:00.000Z", to: "2026-08-25T19:00:00.000Z" },
      area: "library",
      color: "black",
      publicTags: ["wireless"],
      publicDescription: "Published report for claim state checks.",
    });
    repository.publishLostReport({
      demoInstanceId: instance.demoInstanceId,
      reportId: claimReport.reportId,
      expectedVersion: claimReport.version,
      actorId: "claimant-demo",
    });
    const item = repository.listServerInternalFoundItems(instance.demoInstanceId)[0]!;
    const claim = repository.createClaim({
      demoInstanceId: instance.demoInstanceId,
      reportId: claimReport.reportId,
      inventoryItemId: item.inventoryItemId,
      claimantActorId: "claimant-demo",
    });
    const otherInstance = repository.createDemoInstance();
    const auditCount = repository.listAuditEvents(instance.demoInstanceId).length;

    expect(() => repository.updateLostReport({
      demoInstanceId: instance.demoInstanceId,
      reportId: report.reportId,
      expectedVersion: report.version,
      actorId: "claimant-demo",
      patch: { status: "RESOLVED" },
    } as never)).toThrow(expect.objectContaining({ code: "INVALID_STATE_TRANSITION" }));
    expect(() => repository.updateFoundItem({
      demoInstanceId: instance.demoInstanceId,
      inventoryItemId: item.inventoryItemId,
      expectedVersion: item.version,
      actorId: "staff-demo",
      patch: { status: "RETURNED" },
    } as never)).toThrow(expect.objectContaining({ code: "INVALID_STATE_TRANSITION" }));
    expect(() => repository.updateClaim({
      demoInstanceId: instance.demoInstanceId,
      claimId: claim.claimId,
      expectedVersion: claim.version,
      actorId: "staff-demo",
      patch: { status: "APPROVED" },
    })).toThrow(expect.objectContaining({ code: "INVALID_STATE_TRANSITION" }));
    expect(() => repository.updateLostReport({
      demoInstanceId: otherInstance.demoInstanceId,
      reportId: report.reportId,
      expectedVersion: report.version,
      actorId: "claimant-demo",
      patch: { color: "navy" },
    })).toThrow(expect.objectContaining({ code: "STATE_CHANGED" }));
    expect(() => repository.updateClaim({
      demoInstanceId: otherInstance.demoInstanceId,
      claimId: claim.claimId,
      expectedVersion: claim.version,
      actorId: "staff-demo",
      patch: { attempts: 1 },
    })).toThrow(expect.objectContaining({ code: "STATE_CHANGED" }));

    expect(repository.getLostReport(instance.demoInstanceId, report.reportId).version).toBe(1);
    expect(repository.getDemoInstance(instance.demoInstanceId).catalogVersion).toBe(1);
    expect(repository.listAuditEvents(instance.demoInstanceId)).toHaveLength(auditCount);
  });
});
