import { afterEach, describe, expect, it } from "vitest";
import { DomainError } from "@/shared/domain-error";
import { createTestDatabase, type TestDatabase } from "./test-harness";

let testDatabase: TestDatabase | undefined;

afterEach(() => {
  testDatabase?.close();
  testDatabase = undefined;
});

describe("外部与审计 DTO 不泄漏内部库存身份", () => {
  it("公开清单、资源结果、错误、审计和幂等结果都不出现内部 inventory ID", () => {
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
    repository.updateFoundItem({
      demoInstanceId: instance.demoInstanceId,
      inventoryItemId: item.inventoryItemId,
      expectedVersion: item.version,
      patch: { color: "navy" },
      actorId: "staff-demo",
    });
    expect(() => repository.runIdempotent({
      demoInstanceId: instance.demoInstanceId,
      actorId: "staff-demo",
      action: "draft_create",
      idempotencyKey: "opaque-key",
      requestFingerprint: "bounded-request",
    }, () => ({ inventoryItemId: item.inventoryItemId }) as never)).toThrow(
      expect.objectContaining({ code: "VALIDATION_FAILED" }),
    );

    const outwardValues: unknown[] = [
      repository.listPublicInventory(instance.demoInstanceId),
      report,
      repository.listAuditEvents(instance.demoInstanceId),
    ];
    try {
      repository.getLostReport(instance.demoInstanceId, "missing-report");
    } catch (error) {
      outwardValues.push(error instanceof DomainError ? error.toJSON() : error);
    }
    const serialized = JSON.stringify(outwardValues);
    expect(serialized).not.toContain(item.inventoryItemId);
    expect(serialized).not.toContain("inventoryItemId");
    expect(serialized).not.toMatch(/evidence|pickup|cookie|session/i);
  });
});
