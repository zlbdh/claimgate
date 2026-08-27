import { afterEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./test-harness";

let testDatabase: TestDatabase | undefined;

afterEach(() => {
  testDatabase?.close();
  testDatabase = undefined;
});

function reportInput(demoInstanceId: string, suffix = "") {
  return {
    demoInstanceId,
    ownerActorId: "claimant-demo",
    category: "earbuds",
    timeWindow: { from: "2026-08-25T17:00:00.000Z", to: "2026-08-25T19:00:00.000Z" },
    area: "library",
    color: "black",
    publicTags: ["wireless"],
    publicDescription: `Black earbud case ${suffix}`,
  };
}

function forceValidClaimState(
  database: TestDatabase["database"],
  instanceId: string,
  claimId: string,
  status: "EVIDENCE_REQUIRED" | "UNDER_REVIEW" | "LOCKED" | "APPROVED" | "PICKUP_READY" | "REJECTED" | "COLLECTED",
): void {
  if (status === "EVIDENCE_REQUIRED") return;
  if (status === "LOCKED") {
    database.prepare(`UPDATE claims SET status = 'LOCKED', attempts = 3
      WHERE demo_instance_id = ? AND id = ?`).run(instanceId, claimId);
    return;
  }
  database.prepare(`UPDATE claims SET status = 'UNDER_REVIEW', evidence_eligible = 1
    WHERE demo_instance_id = ? AND id = ?`).run(instanceId, claimId);
  if (status === "UNDER_REVIEW") return;
  if (status === "REJECTED") {
    database.prepare(`UPDATE claims SET status = 'REJECTED', reviewer_actor_id = 'staff-demo',
      rejection_reason = 'STAFF_REJECTED' WHERE demo_instance_id = ? AND id = ?`)
      .run(instanceId, claimId);
    return;
  }
  database.prepare(`UPDATE claims SET status = 'APPROVED', reviewer_actor_id = 'staff-demo'
    WHERE demo_instance_id = ? AND id = ?`).run(instanceId, claimId);
  if (status === "APPROVED") return;
  database.prepare(`UPDATE claims SET status = 'PICKUP_READY'
    WHERE demo_instance_id = ? AND id = ?`).run(instanceId, claimId);
  if (status === "PICKUP_READY") return;
  database.prepare(`UPDATE claims SET status = 'COLLECTED'
    WHERE demo_instance_id = ? AND id = ?`).run(instanceId, claimId);
}

describe("报告 owner、active claim 与保留字段后果边界", () => {
  it("非 owner 不能 publish/archive，且版本、状态和 audit 全回滚", () => {
    testDatabase = createTestDatabase();
    const { repository } = testDatabase;
    const instance = repository.createDemoInstance();
    const report = repository.createLostReport(reportInput(instance.demoInstanceId));
    const auditCount = repository.listAuditEvents(instance.demoInstanceId).length;

    for (const operation of [repository.publishLostReport, repository.archiveLostReport]) {
      expect(() => operation({
        demoInstanceId: instance.demoInstanceId,
        reportId: report.reportId,
        expectedVersion: report.version,
        actorId: "staff-demo",
      })).toThrow(expect.objectContaining({ code: "FORBIDDEN" }));
    }
    expect(repository.getLostReport(instance.demoInstanceId, report.reportId)).toMatchObject({
      status: "DRAFT",
      version: 1,
    });
    expect(repository.listAuditEvents(instance.demoInstanceId)).toHaveLength(auditCount);
  });

  it("PUBLISHED 报告存在任一 active Claim 时拒绝归档且无副作用", () => {
    testDatabase = createTestDatabase();
    const { repository, database } = testDatabase;
    const instance = repository.createDemoInstance();
    const items = repository.listServerInternalFoundItems(instance.demoInstanceId);
    const activeStatuses = [
      "EVIDENCE_REQUIRED", "UNDER_REVIEW", "LOCKED", "APPROVED", "PICKUP_READY",
    ] as const;

    for (const [index, status] of activeStatuses.entries()) {
      const draft = repository.createLostReport(reportInput(instance.demoInstanceId, String(index)));
      const published = repository.publishLostReport({
        demoInstanceId: instance.demoInstanceId,
        reportId: draft.reportId,
        expectedVersion: draft.version,
        actorId: "claimant-demo",
      });
      const claim = repository.createClaim({
        demoInstanceId: instance.demoInstanceId,
        reportId: draft.reportId,
        inventoryItemId: items[index]!.inventoryItemId,
        claimantActorId: "claimant-demo",
      });
      forceValidClaimState(database, instance.demoInstanceId, claim.claimId, status);
      const auditCount = repository.listAuditEvents(instance.demoInstanceId).length;

      expect(() => repository.archiveLostReport({
        demoInstanceId: instance.demoInstanceId,
        reportId: draft.reportId,
        expectedVersion: published.version,
        actorId: "claimant-demo",
      })).toThrow(expect.objectContaining({ code: "INVALID_STATE_TRANSITION" }));
      expect(repository.getLostReport(instance.demoInstanceId, draft.reportId)).toMatchObject({
        status: "PUBLISHED", version: published.version,
      });
      expect(repository.listAuditEvents(instance.demoInstanceId)).toHaveLength(auditCount);
    }
  });

  it.each(["REJECTED", "COLLECTED"] as const)(
    "PUBLISHED 报告仅有终态 Claim %s 时允许 owner 归档",
    (terminalStatus) => {
      testDatabase = createTestDatabase();
      const { repository, database } = testDatabase;
      const instance = repository.createDemoInstance();
      const item = repository.listServerInternalFoundItems(instance.demoInstanceId)[0]!;
      const draft = repository.createLostReport(reportInput(instance.demoInstanceId));
      const published = repository.publishLostReport({
        demoInstanceId: instance.demoInstanceId,
        reportId: draft.reportId,
        expectedVersion: draft.version,
        actorId: "claimant-demo",
      });
      const claim = repository.createClaim({
        demoInstanceId: instance.demoInstanceId,
        reportId: draft.reportId,
        inventoryItemId: item.inventoryItemId,
        claimantActorId: "claimant-demo",
      });
      forceValidClaimState(database, instance.demoInstanceId, claim.claimId, terminalStatus);

      expect(repository.archiveLostReport({
        demoInstanceId: instance.demoInstanceId,
        reportId: draft.reportId,
        expectedVersion: published.version,
        actorId: "claimant-demo",
      })).toMatchObject({ status: "ARCHIVED", version: published.version + 1 });
    },
  );

  it("generic Claim update 的 SQL 不触碰 reviewer_actor_id 或 pass_generation", () => {
    testDatabase = createTestDatabase();
    const { repository, database } = testDatabase;
    const instance = repository.createDemoInstance();
    const report = repository.createLostReport(reportInput(instance.demoInstanceId));
    repository.publishLostReport({
      demoInstanceId: instance.demoInstanceId,
      reportId: report.reportId,
      expectedVersion: report.version,
      actorId: "claimant-demo",
    });
    const item = repository.listServerInternalFoundItems(instance.demoInstanceId)[0]!;
    const claim = repository.createClaim({
      demoInstanceId: instance.demoInstanceId,
      reportId: report.reportId,
      inventoryItemId: item.inventoryItemId,
      claimantActorId: "claimant-demo",
    });
    database.exec(`
      CREATE TRIGGER reject_reserved_claim_column_update
      BEFORE UPDATE OF reviewer_actor_id, pass_generation ON claims
      BEGIN
        SELECT RAISE(ABORT, 'reserved columns touched');
      END;
    `);

    expect(repository.updateClaim({
      demoInstanceId: instance.demoInstanceId,
      claimId: claim.claimId,
      expectedVersion: claim.version,
      actorId: "claimant-demo",
      patch: { status: "UNDER_REVIEW", attempts: 1, evidenceEligible: true },
    })).toMatchObject({
      attempts: 1,
      evidenceEligible: true,
      reviewerActorId: null,
      passGeneration: 0,
      version: claim.version + 1,
    });
  });
});
