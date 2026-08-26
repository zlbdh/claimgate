import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./test-harness";

let testDatabase: TestDatabase | undefined;

afterEach(() => {
  testDatabase?.close();
  testDatabase = undefined;
});

function reportInput(demoInstanceId: string, publicDescription = "Black earbud case.") {
  return {
    demoInstanceId,
    ownerActorId: "claimant-demo",
    category: "earbuds",
    timeWindow: { from: "2026-08-25T17:00:00.000Z", to: "2026-08-25T19:00:00.000Z" },
    area: "library",
    color: "black",
    publicTags: ["wireless"],
    publicDescription,
  };
}

function digest(domain: string, value: string): Buffer {
  return createHash("sha256").update(domain).update("\0").update(value).digest();
}

describe("全库内部库存身份公共边界", () => {
  it("实例 B 的公共 tags、description 和报告写入拒绝实例 A 内部 ID", () => {
    testDatabase = createTestDatabase();
    const { repository } = testDatabase;
    const first = repository.createDemoInstance();
    const second = repository.createDemoInstance();
    const internalId = repository.listServerInternalFoundItems(first.demoInstanceId)[0]!.inventoryItemId;
    const secondItem = repository.listServerInternalFoundItems(second.demoInstanceId)[0]!;
    const auditCount = repository.listAuditEvents(second.demoInstanceId).length;

    for (const patch of [
      { publicTags: [`embedded-${internalId}`] },
      { publicDescription: `embedded-${internalId}` },
    ]) {
      expect(() => repository.updateFoundItem({
        demoInstanceId: second.demoInstanceId,
        inventoryItemId: secondItem.inventoryItemId,
        expectedVersion: secondItem.version,
        actorId: "staff-demo",
        patch,
      })).toThrow(expect.objectContaining({ code: "VALIDATION_FAILED" }));
    }
    expect(() => repository.createLostReport(
      reportInput(second.demoInstanceId, `embedded-${internalId}`),
    )).toThrow(expect.objectContaining({ code: "VALIDATION_FAILED" }));
    expect(repository.getDemoInstance(second.demoInstanceId).catalogVersion).toBe(1);
    expect(repository.listAuditEvents(second.demoInstanceId)).toHaveLength(auditCount);

    expect(() => repository.createLostReport(
      reportInput(second.demoInstanceId, `ordinary reference ${internalId.slice(0, -1)}`),
    )).not.toThrow();
  });

  it("实例 B 的报告和 Claim 公共 DTO 读取拒绝实例 A 内部 ID", () => {
    testDatabase = createTestDatabase();
    const { repository, database } = testDatabase;
    const first = repository.createDemoInstance();
    const second = repository.createDemoInstance();
    const internalId = repository.listServerInternalFoundItems(first.demoInstanceId)[0]!.inventoryItemId;
    const secondItem = repository.listServerInternalFoundItems(second.demoInstanceId)[0]!;
    const report = repository.createLostReport(reportInput(second.demoInstanceId));
    const claim = repository.createClaim({
      demoInstanceId: second.demoInstanceId,
      reportId: report.reportId,
      inventoryItemId: secondItem.inventoryItemId,
      claimantActorId: "claimant-demo",
    });

    database.prepare(`
      UPDATE lost_reports SET public_description = ? WHERE demo_instance_id = ? AND id = ?
    `).run(`unsafe-${internalId}`, second.demoInstanceId, report.reportId);
    expect(() => repository.getLostReport(second.demoInstanceId, report.reportId)).toThrow(
      expect.objectContaining({ code: "CONFIGURATION_ERROR" }),
    );

    database.prepare(`
      UPDATE lost_reports SET public_description = 'safe', owner_actor_id = ?
      WHERE demo_instance_id = ? AND id = ?
    `).run(internalId, second.demoInstanceId, report.reportId);
    expect(() => repository.getLostReport(second.demoInstanceId, report.reportId)).toThrow(
      expect.objectContaining({ code: "CONFIGURATION_ERROR" }),
    );

    database.prepare(`
      UPDATE lost_reports SET owner_actor_id = 'claimant-demo' WHERE demo_instance_id = ? AND id = ?
    `).run(second.demoInstanceId, report.reportId);
    database.prepare(`
      UPDATE claims SET claimant_actor_id = ? WHERE demo_instance_id = ? AND id = ?
    `).run(internalId, second.demoInstanceId, claim.claimId);
    expect(() => repository.updateClaim({
      demoInstanceId: second.demoInstanceId,
      claimId: claim.claimId,
      expectedVersion: claim.version,
      actorId: "claimant-demo",
      patch: { attempts: 1 },
    })).toThrow(expect.objectContaining({ code: "CONFIGURATION_ERROR" }));
  });

  it("实例 B 的首次与 replay 幂等 ack 拒绝实例 A 内部 ID 及嵌入值", () => {
    testDatabase = createTestDatabase();
    const { repository, database } = testDatabase;
    const first = repository.createDemoInstance();
    const second = repository.createDemoInstance();
    const internalId = repository.listServerInternalFoundItems(first.demoInstanceId)[0]!.inventoryItemId;
    const request = {
      demoInstanceId: second.demoInstanceId,
      actorId: "claimant-demo",
      action: "draft_create",
      idempotencyKey: "global-boundary-first",
      requestFingerprint: "global-boundary-first",
    } as const;
    expect(() => repository.runIdempotent(request, () => ({
      kind: "report_ack", reportId: `embedded-${internalId}`, status: "DRAFT", version: 1,
    }))).toThrow(expect.objectContaining({ code: "VALIDATION_FAILED" }));

    const replayRequest = {
      ...request,
      idempotencyKey: "global-boundary-replay",
      requestFingerprint: "global-boundary-replay",
    };
    database.prepare(`
      INSERT INTO idempotency_records (
        demo_instance_id, actor_id, action, key_digest,
        request_fingerprint_digest, result_json, created_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      second.demoInstanceId,
      replayRequest.actorId,
      replayRequest.action,
      digest("ClaimGate/idempotency-key/v1", replayRequest.idempotencyKey),
      digest("ClaimGate/request-fingerprint/v1", replayRequest.requestFingerprint),
      JSON.stringify({ kind: "report_ack", reportId: internalId, status: "DRAFT", version: 1 }),
      Date.now(),
    );
    expect(() => repository.runIdempotent(replayRequest, () => ({
      kind: "report_ack", reportId: "not-run", status: "DRAFT", version: 1,
    }))).toThrow(expect.objectContaining({ code: "CONFIGURATION_ERROR" }));
  });
});
