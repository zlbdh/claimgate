import { afterEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./test-harness";

let testDatabase: TestDatabase | undefined;

afterEach(() => {
  testDatabase?.close();
  testDatabase = undefined;
});

function reportInput(demoInstanceId: string) {
  return {
    demoInstanceId,
    ownerActorId: "claimant-demo",
    category: "earbuds",
    timeWindow: { from: "2026-08-25T17:00:00.000Z", to: "2026-08-25T19:00:00.000Z" },
    area: "library",
    color: "black",
    publicTags: ["wireless"],
    publicDescription: "Black earbud case.",
  };
}

describe("审计复合关系与闭合形状", () => {
  it("数据库拒绝跨实例 report/claim 关系和不一致 resource/action 组合", () => {
    testDatabase = createTestDatabase();
    const { repository, database } = testDatabase;
    const first = repository.createDemoInstance();
    const second = repository.createDemoInstance();
    const report = repository.createLostReport(reportInput(first.demoInstanceId));
    const item = repository.listServerInternalFoundItems(first.demoInstanceId)[0]!;
    const claim = repository.createClaim({
      demoInstanceId: first.demoInstanceId,
      reportId: report.reportId,
      inventoryItemId: item.inventoryItemId,
      claimantActorId: "claimant-demo",
    });
    const insert = database.prepare(`
      INSERT INTO audit_events (
        demo_instance_id, id, resource_type, report_id, claim_id,
        action, actor_id, result, occurred_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'SUCCEEDED', ?)
    `);

    const invalidRows = [
      [second.demoInstanceId, "cross-report", "REPORT", report.reportId, null, "REPORT_UPDATED", "staff-demo"],
      [second.demoInstanceId, "cross-claim", "CLAIM", null, claim.claimId, "CLAIM_UPDATED", "staff-demo"],
      [first.demoInstanceId, "instance-with-report", "INSTANCE", report.reportId, null, "DEMO_CREATED", "system"],
      [first.demoInstanceId, "report-with-claim", "REPORT", null, claim.claimId, "REPORT_UPDATED", "staff-demo"],
      [first.demoInstanceId, "wrong-action", "REPORT", report.reportId, null, "CLAIM_UPDATED", "staff-demo"],
      [first.demoInstanceId, "missing-resource", "CLAIM", null, null, "CLAIM_UPDATED", "staff-demo"],
    ] as const;
    for (const row of invalidRows) {
      expect(() => insert.run(...row, Date.now())).toThrow();
    }
  });

  it("数据库拒绝 malformed actor 及把本实例 inventory ID 当 actor/resource", () => {
    testDatabase = createTestDatabase();
    const { repository, database } = testDatabase;
    const instance = repository.createDemoInstance();
    const report = repository.createLostReport(reportInput(instance.demoInstanceId));
    const internalId = repository.listServerInternalFoundItems(instance.demoInstanceId)[0]!.inventoryItemId;
    const insert = database.prepare(`
      INSERT INTO audit_events (
        demo_instance_id, id, resource_type, report_id, claim_id,
        action, actor_id, result, occurred_at_ms
      ) VALUES (?, ?, 'REPORT', ?, NULL, 'REPORT_UPDATED', ?, 'SUCCEEDED', ?)
    `);

    for (const actor of [internalId, "cookie=session-secret", "Claimant-Demo", "", "x".repeat(100)]) {
      expect(() => insert.run(instance.demoInstanceId, `bad-${actor.length}`, report.reportId, actor, Date.now()))
        .toThrow();
    }
    expect(() => database.prepare(`
      INSERT INTO audit_events (
        demo_instance_id, id, resource_type, report_id, claim_id,
        action, actor_id, result, occurred_at_ms
      ) VALUES (?, 'internal-resource', 'REPORT', ?, NULL, 'REPORT_UPDATED', 'staff-demo', 'SUCCEEDED', ?)
    `).run(instance.demoInstanceId, internalId, Date.now())).toThrow();
    const events = repository.listAuditEvents(instance.demoInstanceId);
    expect(events.find((event) => event.action === "DEMO_CREATED")?.resourcePublicId)
      .toBe(instance.demoInstanceId);
    expect(JSON.stringify(events)).not.toContain(internalId);
  });
});
