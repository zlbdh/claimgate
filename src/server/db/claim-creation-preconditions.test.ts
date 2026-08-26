import { afterEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./test-harness";

let testDatabase: TestDatabase | undefined;

afterEach(() => {
  testDatabase?.close();
  testDatabase = undefined;
});

function reportInput(demoInstanceId: string, suffix: string) {
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

function snapshot(test: TestDatabase, demoInstanceId: string) {
  const { database, repository } = test;
  return {
    claims: database.prepare("SELECT COUNT(*) AS count FROM claims WHERE demo_instance_id = ?")
      .get(demoInstanceId),
    audit: repository.listAuditEvents(demoInstanceId),
    instance: repository.getDemoInstance(demoInstanceId),
    reports: repository.listLostReports(demoInstanceId),
    items: repository.listServerInternalFoundItems(demoInstanceId),
  };
}

describe("Claim 创建前置约束", () => {
  it.each(["DRAFT", "ARCHIVED", "RESOLVED"] as const)(
    "%s 报告不能创建 Claim，拒绝无副作用",
    (status) => {
      testDatabase = createTestDatabase();
      const { repository, database } = testDatabase;
      const instance = repository.createDemoInstance();
      const item = repository.listServerInternalFoundItems(instance.demoInstanceId)[0]!;
      const draft = repository.createLostReport(reportInput(instance.demoInstanceId, status));
      if (status === "ARCHIVED") {
        repository.archiveLostReport({
          demoInstanceId: instance.demoInstanceId,
          reportId: draft.reportId,
          expectedVersion: draft.version,
          actorId: "claimant-demo",
        });
      } else if (status === "RESOLVED") {
        database.prepare(`
          UPDATE lost_reports SET status = 'RESOLVED'
          WHERE demo_instance_id = ? AND id = ?
        `).run(instance.demoInstanceId, draft.reportId);
      }
      const before = snapshot(testDatabase, instance.demoInstanceId);

      expect(() => repository.createClaim({
        demoInstanceId: instance.demoInstanceId,
        reportId: draft.reportId,
        inventoryItemId: item.inventoryItemId,
        claimantActorId: "claimant-demo",
      })).toThrow(expect.objectContaining({ code: "INVALID_STATE_TRANSITION" }));
      expect(snapshot(testDatabase, instance.demoInstanceId)).toEqual(before);
    },
  );

  it("非报告 owner 不能创建 Claim，拒绝无副作用", () => {
    testDatabase = createTestDatabase();
    const { repository, database } = testDatabase;
    const instance = repository.createDemoInstance();
    const item = repository.listServerInternalFoundItems(instance.demoInstanceId)[0]!;
    const draft = repository.createLostReport(reportInput(instance.demoInstanceId, "owner"));
    const published = repository.publishLostReport({
      demoInstanceId: instance.demoInstanceId,
      reportId: draft.reportId,
      expectedVersion: draft.version,
      actorId: "claimant-demo",
    });
    database.prepare(`
      UPDATE lost_reports SET owner_actor_id = 'staff-demo'
      WHERE demo_instance_id = ? AND id = ?
    `).run(instance.demoInstanceId, published.reportId);
    const before = snapshot(testDatabase, instance.demoInstanceId);

    expect(() => repository.createClaim({
      demoInstanceId: instance.demoInstanceId,
      reportId: published.reportId,
      inventoryItemId: item.inventoryItemId,
      claimantActorId: "claimant-demo",
    })).toThrow(expect.objectContaining({ code: "FORBIDDEN" }));
    expect(snapshot(testDatabase, instance.demoInstanceId)).toEqual(before);
  });

  it.each(["HELD", "RETURNED"] as const)(
    "%s 物品不能创建 Claim，拒绝无副作用",
    (status) => {
      testDatabase = createTestDatabase();
      const { repository, database } = testDatabase;
      const instance = repository.createDemoInstance();
      const item = repository.listServerInternalFoundItems(instance.demoInstanceId)[0]!;
      const draft = repository.createLostReport(reportInput(instance.demoInstanceId, status));
      const published = repository.publishLostReport({
        demoInstanceId: instance.demoInstanceId,
        reportId: draft.reportId,
        expectedVersion: draft.version,
        actorId: "claimant-demo",
      });
      database.prepare(`
        UPDATE found_items SET status = ? WHERE demo_instance_id = ? AND id = ?
      `).run(status, instance.demoInstanceId, item.inventoryItemId);
      const before = snapshot(testDatabase, instance.demoInstanceId);

      expect(() => repository.createClaim({
        demoInstanceId: instance.demoInstanceId,
        reportId: published.reportId,
        inventoryItemId: item.inventoryItemId,
        claimantActorId: "claimant-demo",
      })).toThrow(expect.objectContaining({ code: "ITEM_UNAVAILABLE" }));
      expect(snapshot(testDatabase, instance.demoInstanceId)).toEqual(before);
    },
  );

  it("PUBLISHED + owner + AVAILABLE 创建 Claim", () => {
    testDatabase = createTestDatabase();
    const { repository } = testDatabase;
    const instance = repository.createDemoInstance();
    const item = repository.listServerInternalFoundItems(instance.demoInstanceId)[0]!;
    const draft = repository.createLostReport(reportInput(instance.demoInstanceId, "valid"));
    const published = repository.publishLostReport({
      demoInstanceId: instance.demoInstanceId,
      reportId: draft.reportId,
      expectedVersion: draft.version,
      actorId: "claimant-demo",
    });

    expect(repository.createClaim({
      demoInstanceId: instance.demoInstanceId,
      reportId: published.reportId,
      inventoryItemId: item.inventoryItemId,
      claimantActorId: "claimant-demo",
    })).toMatchObject({
      reportId: published.reportId,
      claimantActorId: "claimant-demo",
      status: "EVIDENCE_REQUIRED",
    });
  });
});
