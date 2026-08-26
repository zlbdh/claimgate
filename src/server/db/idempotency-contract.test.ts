import { afterEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./test-harness";

let testDatabase: TestDatabase | undefined;

afterEach(() => {
  testDatabase?.close();
  testDatabase = undefined;
});

describe("闭合幂等结果与公共输出边界", () => {
  it("首调与 replay 返回同一 canonical acknowledgement，并绑定 action/result variant", () => {
    testDatabase = createTestDatabase();
    const { repository } = testDatabase;
    const instance = repository.createDemoInstance();
    const request = {
      demoInstanceId: instance.demoInstanceId,
      actorId: "claimant-demo",
      action: "draft_create",
      idempotencyKey: "closed-result-key",
      requestFingerprint: "bounded-draft-v1",
    } as const;
    const result = {
      kind: "report_ack",
      reportId: "report-public-id",
      status: "DRAFT",
      version: 1,
    } as const;

    const first = repository.runIdempotent(request, () => result);
    const replay = repository.runIdempotent(request, () => {
      throw new Error("must not replay");
    });
    expect(first).toEqual(result);
    expect(replay).toEqual(first);
    expect(Object.getPrototypeOf(first)).toBe(Object.prototype);
    expect(() => repository.runIdempotent(
      { ...request, idempotencyKey: "wrong-variant" },
      () => ({ kind: "claim_ack", claimId: "claim-public", status: "EVIDENCE_REQUIRED", version: 1 }),
    )).toThrow(expect.objectContaining({ code: "VALIDATION_FAILED" }));
    expect(() => repository.runIdempotent(
      { ...request, action: "unknown_action", idempotencyKey: "unknown-action" } as never,
      () => result,
    )).toThrow(expect.objectContaining({ code: "VALIDATION_FAILED" }));
  });

  it("拒绝别名、嵌套、数组、嵌入字符串、JSON 字符串和 custom serialization 中的内部 ID", () => {
    testDatabase = createTestDatabase();
    const { repository } = testDatabase;
    const instance = repository.createDemoInstance();
    const internalId = repository.listServerInternalFoundItems(instance.demoInstanceId)[0]!.inventoryItemId;
    const nonEnumerable = { kind: "report_ack", reportId: "safe", status: "DRAFT", version: 1 };
    Object.defineProperty(nonEnumerable, "candidate", { value: internalId, enumerable: false });
    const malicious: unknown[] = [
      { kind: "report_ack", reportId: internalId, status: "DRAFT", version: 1 },
      { kind: "report_ack", reportId: "safe", status: "DRAFT", version: 1, candidate: internalId },
      { kind: "report_ack", reportId: "safe", status: "DRAFT", version: 1, nested: { value: internalId } },
      { kind: "report_ack", reportId: "safe", status: "DRAFT", version: 1, values: [internalId] },
      { kind: "report_ack", reportId: `prefix-${internalId}-suffix`, status: "DRAFT", version: 1 },
      { kind: "report_ack", reportId: JSON.stringify({ value: internalId }), status: "DRAFT", version: 1 },
      nonEnumerable,
      { toJSON: () => ({ kind: "report_ack", reportId: internalId, status: "DRAFT", version: 1 }) },
    ];

    for (const [index, result] of malicious.entries()) {
      expect(() => repository.runIdempotent({
        demoInstanceId: instance.demoInstanceId,
        actorId: "claimant-demo",
        action: "draft_create",
        idempotencyKey: `malicious-${index}`,
        requestFingerprint: `malicious-${index}`,
      }, () => result as never)).toThrow(expect.objectContaining({ code: "VALIDATION_FAILED" }));
    }
    expect(testDatabase.database.prepare("SELECT COUNT(*) AS count FROM idempotency_records").get())
      .toEqual({ count: 0 });
    expect(() => repository.runIdempotent({
      demoInstanceId: instance.demoInstanceId,
      actorId: "claimant-demo",
      action: "draft_create",
      idempotencyKey: "safe-key",
      requestFingerprint: `fingerprint-${internalId}`,
    }, () => ({ kind: "report_ack", reportId: "safe", status: "DRAFT", version: 1 })))
      .toThrow(expect.objectContaining({ code: "VALIDATION_FAILED" }));
  });

  it("公共字段写入和读取都拒绝当前实例内部 ID，tags 严格解析", () => {
    testDatabase = createTestDatabase();
    const { repository, database } = testDatabase;
    const instance = repository.createDemoInstance();
    const item = repository.listServerInternalFoundItems(instance.demoInstanceId)[0]!;

    expect(() => repository.updateFoundItem({
      demoInstanceId: instance.demoInstanceId,
      inventoryItemId: item.inventoryItemId,
      expectedVersion: item.version,
      actorId: "staff-demo",
      patch: { publicTags: [`note-${item.inventoryItemId}`] },
    })).toThrow(expect.objectContaining({ code: "VALIDATION_FAILED" }));
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
    database.prepare("UPDATE lost_reports SET public_description = ? WHERE demo_instance_id = ?")
      .run(`unsafe-${item.inventoryItemId}`, instance.demoInstanceId);
    expect(() => repository.getLostReport(instance.demoInstanceId, report.reportId)).toThrow(
      expect.objectContaining({ code: "CONFIGURATION_ERROR" }),
    );
    database.prepare("UPDATE found_items SET public_tags_json = '[1]' WHERE demo_instance_id = ?")
      .run(instance.demoInstanceId);
    expect(() => repository.listPublicInventory(instance.demoInstanceId)).toThrow(
      expect.objectContaining({ code: "CONFIGURATION_ERROR" }),
    );
    expect(() => repository.listServerInternalFoundItems(instance.demoInstanceId)).toThrow(
      expect.objectContaining({ code: "CONFIGURATION_ERROR" }),
    );
  });
});
